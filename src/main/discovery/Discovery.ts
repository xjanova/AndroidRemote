/**
 * รวมทุกทางที่หาเครื่องบนวง LAN ได้ ไว้ที่เดียว
 *
 * สามทาง เพราะไม่มีทางไหนเห็นครบเอง:
 *   1. mDNS ของเราเอง        — เห็นเครื่องแอนดรอยด์ 11+ ที่เปิดไร้สาย รวมทั้งที่กำลังจับคู่
 *   2. `adb mdns services`   — สแตกของ adb บางทีเห็นในสิ่งที่เรามองไม่เห็น และกลับกัน
 *   3. กวาดพอร์ต 5555        — ทางเดียวที่เจอเครื่องซึ่งสั่ง `adb tcpip` เอง เพราะพวกนี้เงียบสนิทบน mDNS
 *
 * เจอเครื่องที่เคยจับคู่ไว้แล้ว → ต่อให้ทันทีโดยไม่ถาม
 */

import { EventEmitter } from 'node:events';
import type { AdbClient } from '../adb/AdbClient';
import type { KnownDevices } from '../store/KnownDevices';
import { MdnsBrowser, serialFromInstance, type MdnsService } from './mdns';
import { sweep } from './scan';
import { isAlreadyNativeAvd, scanEmulatorPorts, runningEmulators, specFor } from './emulators';
import type { DiscoveredDevice, DiscoveryKind, DiscoverySource, DiscoveryState } from '../../shared/types';

/** ลืมสิ่งที่ไม่ได้ยินซ้ำนานเกินนี้ — เครื่องถูกปิดหรือออกจากวงไปแล้ว */
const STALE_MS = 90_000;

function kindOfService(service: string): DiscoveryKind | null {
  if (service.includes('_adb-tls-connect')) return 'connect';
  if (service.includes('_adb-tls-pairing')) return 'pairing';
  if (service.includes('_adb.')) return 'legacy';
  return null;
}

export class Discovery extends EventEmitter {
  private browser: MdnsBrowser | null = null;
  private found = new Map<string, DiscoveredDevice>();
  private adbPollTimer: NodeJS.Timeout | null = null;
  private emulatorTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  /** พอร์ตอีมูเลเตอร์ที่สั่ง connect ไปแล้ว — ไม่ยิงซ้ำทุกรอบสแกน */
  private emulatorConnected = new Set<number>();
  /** ยี่ห้อที่เคยเตือนเรื่อง adb แถมแล้ว เตือนครั้งเดียวพอ */
  private warnedBundledAdb = new Set<string>();
  private sweepAbort: { aborted: boolean } | null = null;
  private sweepProgress = { done: 0, total: 0 };
  /** เครื่องที่สั่งต่อไปแล้วในรอบนี้ — กันสั่งซ้ำรัวๆ ทุกครั้งที่ mDNS ได้ยินซ้ำ */
  private autoConnectAttempted = new Set<string>();
  private running = false;

  constructor(
    private adb: AdbClient,
    private known: KnownDevices,
    private log: (level: 'info' | 'warn' | 'error', message: string) => void = () => {},
    /** ให้ตัวเรียกบอกว่าตอนนี้ serial ไหนต่ออยู่แล้วบ้าง */
    private connectedSerials: () => Set<string> = () => new Set(),
  ) {
    super();
  }

  state(): DiscoveryState {
    return {
      running: this.running,
      sweeping: this.sweepAbort !== null,
      sweepDone: this.sweepProgress.done,
      sweepTotal: this.sweepProgress.total,
      devices: this.list(),
    };
  }

  list(): DiscoveredDevice[] {
    const connected = this.connectedSerials();
    return [...this.found.values()]
      .map((d) => ({
        ...d,
        known: d.serial ? this.known.has(d.serial) : false,
        connected: connected.has(`${d.address}:${d.port}`) || (d.serial ? connected.has(d.serial) : false),
      }))
      // ที่กำลังจับคู่ขึ้นก่อนเสมอ เพราะหน้าต่างรหัสบนมือถือมีอายุสั้น
      .sort((a, b) => {
        const rank = (x: DiscoveredDevice): number => (x.kind === 'pairing' ? 0 : x.known ? 1 : 2);
        return rank(a) - rank(b) || a.address.localeCompare(b.address);
      });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.browser = new MdnsBrowser();
    this.browser.on('service', (s: MdnsService) => this.onMdns(s));
    this.browser.on('log', (m: string) => this.log('warn', m));

    try {
      await this.browser.start();
      this.log('info', 'เริ่มค้นหาเครื่องบนวง Wi-Fi แล้ว');
    } catch (err) {
      this.log('warn', `เปิด mDNS ไม่ได้ จะพึ่ง adb กับการกวาดพอร์ตแทน: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ถาม adb เป็นระยะ — สแตกของมันอัปเดตช้ากว่าเรา ไม่ต้องถี่
    const pollAdb = async (): Promise<void> => {
      const services = await this.adb.mdnsServices().catch(() => []);
      for (const s of services) {
        const kind = kindOfService(s.service);
        if (!kind) continue;
        this.upsert({
          kind,
          serial: serialFromInstance(s.instance),
          address: s.address,
          port: s.port,
          source: 'adb-mdns',
        });
      }
    };
    void pollAdb();
    this.adbPollTimer = setInterval(() => void pollAdb(), 5000);

    // อีมูเลเตอร์อยู่บน loopback — สแกนถูกมาก (ไม่กี่สิบพอร์ต ตอบทันที) ทำได้ถี่
    void this.scanEmulators();
    this.emulatorTimer = setInterval(() => void this.scanEmulators(), 8000);

    this.pruneTimer = setInterval(() => this.prune(), 15_000);
    this.emitChange();
  }

  /**
   * หาอีมูเลเตอร์บนเครื่องนี้แล้วต่อให้เอง — ไม่ต้องจับคู่ เพราะเป็นเครื่องเราเอง
   * ข้าม AVD ที่ adb เห็นเองอยู่แล้ว (emulator-5554) ไม่งั้นจะโผล่ซ้ำสองรายการ
   */
  private async scanEmulators(): Promise<void> {
    let open;
    try {
      open = await scanEmulatorPorts();
    } catch {
      return;
    }
    if (open.length === 0) return;

    const known = new Set(this.connectedSerials());
    for (const e of open) {
      const address = '127.0.0.1';
      if (isAlreadyNativeAvd(e.port, known)) continue;

      this.upsert({ kind: 'emulator', serial: null, address, port: e.port, source: 'emulator', name: e.label });

      const hostPort = `${address}:${e.port}`;
      if (known.has(hostPort) || this.emulatorConnected.has(e.port)) continue;
      this.emulatorConnected.add(e.port);

      try {
        const message = await this.adb.connectTcp(hostPort);
        const ok = /connected to/i.test(message);
        this.log(ok ? 'info' : 'warn', `${e.label} ที่ ${hostPort}: ${message}`);
        if (!ok) {
          this.emulatorConnected.delete(e.port); // ให้ลองใหม่รอบหน้า
          this.warnBundledAdb(e.brand);
        }
      } catch (err) {
        this.emulatorConnected.delete(e.port);
        this.log('warn', `ต่อ ${e.label} ที่ ${hostPort} ไม่ได้: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.emitChange();
  }

  /** เตือนเรื่อง adb คนละเวอร์ชันครั้งเดียวต่อยี่ห้อ — เป็นสาเหตุอันดับหนึ่งที่อีมูเลเตอร์ "ต่อแล้วหลุด" */
  private warnBundledAdb(brand: string): void {
    const spec = specFor(brand as never);
    if (!spec?.bundledAdb || this.warnedBundledAdb.has(brand)) return;
    this.warnedBundledAdb.add(brand);
    const isRunning = runningEmulators().some((r) => r.brand === brand);
    if (!isRunning) return;
    this.log(
      'warn',
      `${spec.label} มี ${spec.bundledAdb} ของตัวเอง ถ้าเวอร์ชันไม่ตรงกับ adb ของเรา ` +
        'จะสลับกันฆ่า server ที่ 5037 จนเครื่องหลุดเป็นระยะ — ก็อป platform-tools\\adb.exe ไปทับตัวที่มันแถมมา',
    );
    if (spec.hint) this.log('info', spec.hint);
  }

  private onMdns(s: MdnsService): void {
    if (!s.address) return;
    this.upsert({
      kind: s.kind === 'connect' ? 'connect' : s.kind === 'pairing' ? 'pairing' : 'legacy',
      serial: s.serial,
      address: s.address,
      port: s.port,
      source: 'mdns',
    });
  }

  private upsert(input: {
    kind: DiscoveryKind;
    serial: string | null;
    address: string;
    port: number;
    source: DiscoverySource;
    /** ชื่อที่รู้จากแหล่งค้นหา เช่นยี่ห้ออีมูเลเตอร์ */
    name?: string;
  }): void {
    // รวมด้วย serial ถ้ามี เพราะเครื่องเดียวกันอาจโผล่มาหลายทางคนละพอร์ต
    const key = input.serial ? `${input.kind}:${input.serial}` : `${input.kind}:${input.address}:${input.port}`;
    const existing = this.found.get(key);

    const sources = new Set<DiscoverySource>(existing?.sources ?? []);
    sources.add(input.source);

    const device: DiscoveredDevice = {
      key,
      kind: input.kind,
      serial: input.serial ?? existing?.serial ?? null,
      address: input.address,
      port: input.port,
      name: input.name ?? (input.serial ? this.known.get(input.serial)?.name : existing?.name),
      sources: [...sources],
      known: input.serial ? this.known.has(input.serial) : false,
      connected: false,
      at: Date.now(),
    };

    const isNew = !existing;
    this.found.set(key, device);

    if (isNew) {
      const label = device.name ?? device.serial ?? device.address;
      this.log('info', `เจอ ${label} ที่ ${device.address}:${device.port} (${device.kind})`);
    }

    this.emitChange();
    void this.maybeAutoConnect(device);
  }

  /**
   * เจอเครื่องที่เคยจับคู่ไว้ → ต่อเลย
   *
   * เฉพาะ connect กับ legacy เท่านั้น — pairing ต้องมีรหัสจากผู้ใช้ ต่อเองไม่ได้
   */
  private async maybeAutoConnect(device: DiscoveredDevice): Promise<void> {
    if (device.kind === 'pairing') return;
    if (!device.serial) return;

    const entry = this.known.get(device.serial);
    if (!entry || !entry.autoConnect) return;

    const attemptKey = `${device.serial}@${device.address}:${device.port}`;
    if (this.autoConnectAttempted.has(attemptKey)) return;
    this.autoConnectAttempted.add(attemptKey);

    const hostPort = `${device.address}:${device.port}`;
    this.log('info', `${entry.name ?? device.serial} เป็นเครื่องที่จับคู่ไว้แล้ว — กำลังต่อ ${hostPort}`);

    try {
      const message = await this.adb.connectTcp(hostPort);
      const ok = /connected to/i.test(message);
      this.log(ok ? 'info' : 'warn', message);
      if (ok) {
        this.known.remember({
          serial: device.serial,
          lastAddress: device.address,
          lastPort: device.port,
        });
        this.emit('auto-connected', { serial: device.serial, hostPort });
      } else {
        // ต่อไม่ติดครั้งนี้ ปล่อยให้ลองใหม่ได้ในรอบหน้า
        this.autoConnectAttempted.delete(attemptKey);
      }
    } catch (err) {
      this.autoConnectAttempted.delete(attemptKey);
      this.log('warn', `ต่อ ${hostPort} อัตโนมัติไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.emitChange();
  }

  /**
   * ลองต่อเครื่องที่รู้จักตามที่อยู่ล่าสุด โดยไม่ต้องรอให้ mDNS เห็นก่อน
   * ช่วยตอนเปิดแอปมาแล้วเครื่องยังไม่ประกาศตัว
   */
  async reconnectKnown(): Promise<void> {
    for (const entry of this.known.list()) {
      if (!entry.autoConnect || !entry.lastAddress || !entry.lastPort) continue;
      const hostPort = `${entry.lastAddress}:${entry.lastPort}`;
      const message = await this.adb.connectTcp(hostPort).catch((e) => String(e));
      if (/connected to/i.test(message)) {
        this.log('info', `ต่อ ${entry.name ?? entry.serial} ที่ ${hostPort} ได้จากที่อยู่ล่าสุด`);
        this.known.remember({ serial: entry.serial });
      }
    }
  }

  /** กวาดพอร์ตทั้งวง — หนักกว่า mDNS มาก ผู้ใช้ต้องกดสั่งเอง */
  async sweepNow(): Promise<void> {
    if (this.sweepAbort) return;
    const abort = { aborted: false };
    this.sweepAbort = abort;
    this.sweepProgress = { done: 0, total: 0 };
    this.emitChange();

    try {
      const results = await sweep({
        signal: abort,
        onProgress: (done, total) => {
          this.sweepProgress = { done, total };
          this.emitChange();
        },
        onFound: (target) => {
          this.upsert({
            kind: 'legacy',
            serial: null,
            address: target.address,
            port: target.port,
            source: 'scan',
          });
        },
      });
      this.log('info', `กวาดพอร์ตเสร็จ เจอ ${results.length} ที่อยู่ที่เปิดพอร์ต adb ไว้`);
    } finally {
      this.sweepAbort = null;
      this.emitChange();
    }
  }

  cancelSweep(): void {
    if (this.sweepAbort) this.sweepAbort.aborted = true;
  }

  /**
   * จับคู่กับเครื่องที่กำลังเปิดหน้ารหัสอยู่ แล้วจำไว้
   * จับคู่สำเร็จแล้ว adb จะรู้จักเครื่องนี้ถาวร ไม่ต้องจับคู่อีก
   */
  async pairAndRemember(
    hostPort: string,
    code: string,
  ): Promise<{ ok: boolean; message: string }> {
    const result = await this.adb.pair(hostPort, code);
    if (!result.ok) return result;

    // adb ตอบกลับมาพร้อม guid ของเครื่อง เช่น "Successfully paired to ... [guid=adb-R5CT...-xxx]"
    const guid = /guid=([^\]\s]+)/.exec(result.message)?.[1];
    const serial = guid ? serialFromInstance(guid) : null;

    if (serial) {
      this.known.remember({ serial, pairedAt: Date.now() });
      this.log('info', `จับคู่ ${serial} สำเร็จ และจำไว้แล้ว — ครั้งหน้าจะต่อให้เอง`);
    } else {
      this.log('warn', 'จับคู่สำเร็จ แต่แกะ serial จากคำตอบของ adb ไม่ได้ จึงยังจำไม่ได้');
    }

    return result;
  }

  /** ผู้ใช้กดต่อเอง — ต่อแล้วจำไว้ให้ด้วย */
  async connectAndRemember(hostPort: string, serial: string | null): Promise<{ ok: boolean; message: string }> {
    const message = await this.adb.connectTcp(hostPort);
    const ok = /connected to/i.test(message);
    if (ok && serial) {
      const [address, portText] = splitHostPort(hostPort);
      this.known.remember({ serial, lastAddress: address, lastPort: portText });
    }
    this.emitChange();
    return { ok, message };
  }

  private prune(): void {
    const cutoff = Date.now() - STALE_MS;
    let changed = false;
    for (const [key, device] of this.found) {
      if (device.at < cutoff) {
        this.found.delete(key);
        changed = true;
      }
    }
    if (changed) this.emitChange();
  }

  private emitChange(): void {
    this.emit('changed', this.state());
  }

  stop(): void {
    this.running = false;
    this.cancelSweep();
    if (this.adbPollTimer) clearInterval(this.adbPollTimer);
    if (this.emulatorTimer) clearInterval(this.emulatorTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.adbPollTimer = null;
    this.emulatorTimer = null;
    this.pruneTimer = null;
    this.emulatorConnected.clear();
    this.browser?.stop();
    this.browser = null;
    this.found.clear();
    this.autoConnectAttempted.clear();
    this.removeAllListeners();
  }
}

function splitHostPort(hostPort: string): [string, number] {
  const colon = hostPort.lastIndexOf(':');
  if (colon < 0) return [hostPort, 5555];
  return [hostPort.slice(0, colon), parseInt(hostPort.slice(colon + 1), 10) || 5555];
}
