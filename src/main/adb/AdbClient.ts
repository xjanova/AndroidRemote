/**
 * ชั้นบนของ adb — งานระดับ "ทำอะไรกับเครื่อง" ทั้งหมดอยู่ที่นี่
 *
 * ทุกเมธอดเปิด socket ใหม่ของตัวเอง เพราะ adb server ผูก socket หนึ่งเส้น
 * เข้ากับหนึ่ง transport แล้วใช้ซ้ำไม่ได้ — ยกเว้น trackDevices ที่ถือเส้นยาว
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  AdbSocket,
  AdbError,
  AdbServerDownError,
  parseDeviceList,
  type RawDeviceLine,
} from './protocol';
import type { AdbState, ShellResult } from '../../shared/types';

/** ตัวคั่นที่ใช้ดึง exit code กลับมาจาก exec: ซึ่งโปรโตคอลไม่ส่งให้ */
const RC_MARKER = '__ARC_RC__';

const KNOWN_STATES: AdbState[] = [
  'device', 'unauthorized', 'offline', 'authorizing', 'connecting',
  'bootloader', 'recovery', 'sideload', 'rescue', 'no permissions',
];

export function normalizeState(raw: string): AdbState {
  const s = raw.trim() as AdbState;
  return KNOWN_STATES.includes(s) ? s : 'unknown';
}

export interface AdbClientOptions {
  /** พาธของ adb.exe — ถ้าไม่ระบุจะไปหาเอง */
  adbPath?: string;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class AdbClient {
  private adbPath: string | null;
  private log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private startingServer: Promise<void> | null = null;

  constructor(opts: AdbClientOptions = {}) {
    this.adbPath = opts.adbPath ?? findAdb();
    this.log = opts.log ?? (() => {});
  }

  get executablePath(): string | null {
    return this.adbPath;
  }

  // ─────────────────────────────── ตัว server ───────────────────────────────

  /**
   * เปิด socket ที่พร้อมใช้ — ถ้า adb server ยังไม่ทำงานจะสั่ง start-server ให้ก่อน
   * การ start ถูกล็อกไว้ให้เกิดครั้งเดียวแม้หลายคำสั่งจะชนกันเข้ามาพร้อมกัน
   */
  private async open(): Promise<AdbSocket> {
    try {
      return await AdbSocket.connect();
    } catch (err) {
      if (!(err instanceof AdbServerDownError)) throw err;
      await this.startServer();
      return AdbSocket.connect();
    }
  }

  private startServer(): Promise<void> {
    if (this.startingServer) return this.startingServer;
    this.startingServer = (async () => {
      if (!this.adbPath) {
        throw new AdbError(
          'หา adb.exe ไม่เจอ — ตั้งค่า ANDROID_HOME หรือระบุพาธเองในหน้าตั้งค่า',
        );
      }
      this.log('info', `adb server ไม่ทำงาน กำลังสั่ง start-server จาก ${this.adbPath}`);
      await run(this.adbPath, ['start-server'], 20000);
      // adb เขียน "daemon started successfully" ก่อนพร้อมรับ socket จริงเล็กน้อย
      await delay(150);
    })().finally(() => {
      this.startingServer = null;
    });
    return this.startingServer;
  }

  async version(): Promise<string> {
    const sock = await this.open();
    try {
      await sock.request('host:version');
      const hex = await sock.readMessage();
      return String(parseInt(hex, 16));
    } finally {
      sock.close();
    }
  }

  /** ปิด adb server — ใช้ตอนผู้ใช้กด "รีสตาร์ท adb" เพื่อแก้อาการค้าง */
  async killServer(): Promise<void> {
    const sock = await this.open();
    try {
      await sock.send('host:kill');
      // host:kill ไม่ตอบอะไรกลับ มันปิด socket ทิ้งเลย
    } finally {
      sock.close();
    }
  }

  // ─────────────────────────────── รายชื่อเครื่อง ───────────────────────────────

  async listDevices(): Promise<RawDeviceLine[]> {
    const sock = await this.open();
    try {
      await sock.request('host:devices-l');
      const text = await sock.readMessage();
      return parseDeviceList(text);
    } finally {
      sock.close();
    }
  }

  /**
   * เปิดสตรีมเฝ้าดูการเปลี่ยนแปลงรายชื่อเครื่อง
   * adb จะยิงรายการเต็มมาให้ทุกครั้งที่มีอะไรเปลี่ยน (เสียบ/ถอด/อนุญาต)
   * คืนฟังก์ชันสำหรับปิดสตรีม
   */
  async trackDevices(
    onList: (devices: RawDeviceLine[]) => void,
    onError: (err: Error) => void,
  ): Promise<() => void> {
    const sock = await this.open();
    // host:track-devices-l มีเฉพาะ adb ใหม่ ถ้าไม่รองรับให้ถอยไปตัวธรรมดา
    try {
      await sock.request('host:track-devices-l');
    } catch {
      sock.close();
      const plain = await this.open();
      await plain.request('host:track-devices');
      attachTracker(plain, onList, onError);
      return () => plain.close();
    }
    attachTracker(sock, onList, onError);
    return () => sock.close();
  }

  // ─────────────────────────────── คำสั่งบนเครื่อง ───────────────────────────────

  /** เปิด socket ที่ผูกกับเครื่องหนึ่งเครื่องแล้ว พร้อมยิงคำสั่งระดับ transport */
  private async openTransport(serial: string): Promise<AdbSocket> {
    const sock = await this.open();
    try {
      await sock.request(`host:transport:${serial}`);
      return sock;
    } catch (err) {
      sock.close();
      throw err;
    }
  }

  /**
   * รันคำสั่งแล้วรอผลจนจบ
   *
   * ใช้ `exec:` ไม่ใช่ `shell:` เพราะ shell: เปิด pty ทำให้ \n กลายเป็น \r\n
   * บนหลายเครื่อง แล้วพังทุกอย่างที่ parse ทีหลัง
   */
  async exec(serial: string, command: string): Promise<ShellResult> {
    // ห่อคำสั่งเพื่อดึง exit code กลับมา — exec: ไม่ส่งให้เอง
    // ต้องเป็น subshell ( ) ไม่ใช่ brace group { } — `exit` ข้างใน brace group
    // ฆ่าทั้งเชลล์ก่อนถึงบรรทัด echo ทำให้ marker หายแล้วได้ -1 (เจอกับอีมูเลเตอร์จริง)
    const wrapped = `( ${command} ) 2>&1 ; echo "${RC_MARKER}$?"`;
    const raw = await this.execRaw(serial, wrapped);
    const text = raw.toString('utf8');

    const markerAt = text.lastIndexOf(RC_MARKER);
    if (markerAt < 0) {
      return { stdout: text.trim(), stderr: '', exitCode: -1 };
    }
    const stdout = text.slice(0, markerAt);
    const rc = parseInt(text.slice(markerAt + RC_MARKER.length).trim(), 10);
    return {
      stdout: stripTrailingNewline(stdout),
      stderr: '',
      exitCode: Number.isNaN(rc) ? -1 : rc,
    };
  }

  /** รันคำสั่งแล้วคืนไบต์ดิบ — ใช้กับ screencap, exec-out, tar และอื่นๆ ที่เป็นไบนารี */
  async execRaw(serial: string, command: string): Promise<Buffer> {
    const sock = await this.openTransport(serial);
    try {
      await sock.request(`exec:${command}`);
      return await sock.readToEnd();
    } finally {
      sock.close();
    }
  }

  /**
   * รันคำสั่งแบบสตรีม — ผลลัพธ์ทยอยมาเรื่อยๆ ไม่รอจบ
   * ใช้กับ logcat และตัว server ฝั่งมือถือ
   */
  async execStream(
    serial: string,
    command: string,
    onData: (chunk: Buffer) => void,
    onClose?: (err?: Error) => void,
  ): Promise<() => void> {
    const sock = await this.openTransport(serial);
    await sock.request(`exec:${command}`);
    sock.stream(onData, onClose);
    return () => sock.close();
  }

  /** สถานะปัจจุบันของเครื่องหนึ่งเครื่อง (เร็วกว่าดึงรายการทั้งหมด) */
  async getState(serial: string): Promise<AdbState> {
    const sock = await this.open();
    try {
      await sock.request(`host-serial:${serial}:get-state`);
      return normalizeState(await sock.readMessage());
    } catch {
      return 'offline';
    } finally {
      sock.close();
    }
  }

  // ─────────────────────────────── ส่งไฟล์ (sync protocol) ───────────────────────────────

  /**
   * ส่งไฟล์เข้าเครื่อง
   *
   * ⚠ sync protocol ใช้ **uint32 little-endian** ไม่ใช่ความยาวแบบเลขฐานสิบหก 4 ตัวอักษร
   * แบบที่ host protocol ใช้ — คนละรูปแบบกันคนละที่ในโปรโตคอลเดียวกัน
   */
  async push(
    serial: string,
    localPath: string,
    remotePath: string,
    mode = 0o755,
  ): Promise<void> {
    const data = await fs.promises.readFile(localPath);
    await this.pushData(serial, data, remotePath, mode);
  }

  async pushData(
    serial: string,
    data: Buffer,
    remotePath: string,
    mode = 0o755,
  ): Promise<void> {
    const sock = await this.openTransport(serial);
    try {
      await sock.request('sync:');

      const target = Buffer.from(`${remotePath},${mode}`, 'utf8');
      sock.write(syncHeader('SEND', target.length));
      sock.write(target);

      const CHUNK = 64 * 1024;
      for (let off = 0; off < data.length; off += CHUNK) {
        const slice = data.subarray(off, Math.min(off + CHUNK, data.length));
        sock.write(syncHeader('DATA', slice.length));
        sock.write(slice);
      }

      sock.write(syncHeader('DONE', Math.floor(Date.now() / 1000)));

      const reply = await sock.read(8);
      const tag = reply.subarray(0, 4).toString('utf8');
      if (tag !== 'OKAY') {
        const len = reply.readUInt32LE(4);
        const msg = len > 0 ? (await sock.read(len)).toString('utf8') : 'ไม่ทราบสาเหตุ';
        throw new AdbError(`ส่งไฟล์ไป ${remotePath} ไม่สำเร็จ: ${msg}`);
      }
    } finally {
      sock.close();
    }
  }

  // ─────────────────────────────── พอร์ต ───────────────────────────────

  /**
   * ให้เครื่องต่อกลับมาหา PC (reverse)
   * ใช้แบบนี้แทน forward เพราะไม่ต้องเดาว่า server ฝั่งมือถือเปิดพอร์ตเสร็จหรือยัง
   * — เราเปิดรอไว้ก่อน แล้วเครื่องค่อยวิ่งเข้ามา
   */
  async reverse(serial: string, remote: string, local: string): Promise<void> {
    const sock = await this.openTransport(serial);
    try {
      await sock.request(`reverse:forward:${remote};${local}`);
      // adb ตอบ OKAY สองชั้นสำหรับ forward/reverse — ชั้นแรกรับคำสั่ง ชั้นสองผลลัพธ์
      await sock.readStatus(`reverse:forward:${remote};${local}`).catch(() => {});
    } finally {
      sock.close();
    }
  }

  async reverseRemove(serial: string, remote: string): Promise<void> {
    const sock = await this.openTransport(serial);
    try {
      await sock.request(`reverse:killforward:${remote}`);
      await sock.readStatus().catch(() => {});
    } catch {
      // ไม่มีให้ลบก็ไม่เป็นไร
    } finally {
      sock.close();
    }
  }

  async forward(serial: string, local: string, remote: string): Promise<void> {
    const sock = await this.open();
    try {
      await sock.request(`host-serial:${serial}:forward:${local};${remote}`);
      await sock.readStatus().catch(() => {});
    } finally {
      sock.close();
    }
  }

  // ─────────────────────────────── ไร้สาย ───────────────────────────────

  /**
   * สั่งให้ adbd บนเครื่องเปิดรับ TCP ที่พอร์ตนี้ (เทียบเท่า `adb tcpip 5555`)
   *
   * นี่คือทางที่**ไม่ต้องพึ่ง mDNS ไม่ต้องจับคู่ และใช้ได้ทุกรุ่นแอนดรอยด์**
   * ต้องเสียบสายอยู่ตอนสั่ง adbd จะรีสตาร์ตแล้วเครื่องหลุดจาก USB ชั่วครู่ — ปกติ
   * ⚠ ค่านี้หายเมื่อรีบูตมือถือ (แอปคู่หูบนเครื่อง root คืนให้เองตอนบูต)
   */
  async tcpip(serial: string, port = 5555): Promise<string> {
    const sock = await this.openTransport(serial);
    try {
      await sock.request(`tcpip:${port}`);
      return (await sock.readToEnd()).toString('utf8').trim();
    } finally {
      sock.close();
    }
  }

  /** IPv4 ของมือถือบน Wi-Fi — null ถ้าไม่ได้ต่อ Wi-Fi */
  async wifiAddress(serial: string): Promise<string | null> {
    // ลอง wlan0 ก่อน แล้วค่อยกวาดทุกอินเทอร์เฟซ เพราะบางเครื่องชื่อไม่ใช่ wlan0
    const res = await this.exec(
      serial,
      "ip -4 -o addr show wlan0 2>/dev/null | awk '{print $4}'; ip -4 -o addr show 2>/dev/null | grep -v ' lo ' | awk '{print $4}'",
    );
    for (const line of res.stdout.split('\n')) {
      const m = /^(\d+\.\d+\.\d+\.\d+)/.exec(line.trim());
      if (m && !m[1].startsWith('127.')) return m[1];
    }
    return null;
  }

  /** ต่อเครื่องผ่าน TCP — คืนข้อความที่ adb ตอบกลับมาตามจริง */
  async connectTcp(hostPort: string): Promise<string> {
    const sock = await this.open();
    try {
      await sock.request(`host:connect:${hostPort}`);
      return await sock.readMessage();
    } finally {
      sock.close();
    }
  }

  async disconnectTcp(hostPort: string): Promise<string> {
    const sock = await this.open();
    try {
      await sock.request(`host:disconnect:${hostPort}`);
      return await sock.readMessage();
    } finally {
      sock.close();
    }
  }

  /**
   * จับคู่แบบไร้สาย (Android 11+)
   *
   * ⚠ ตัวนี้เป็นข้อยกเว้นเดียวที่ต้องเรียก adb.exe จริง — การจับคู่ใช้ TLS
   * แบบ SPAKE2 ที่ฝังอยู่ในไบนารี ไม่ได้เปิดผ่านโปรโตคอล socket
   */
  async pair(hostPort: string, code: string): Promise<{ ok: boolean; message: string }> {
    if (!this.adbPath) {
      return { ok: false, message: 'หา adb.exe ไม่เจอ' };
    }
    const res = await run(this.adbPath, ['pair', hostPort, code], 30000).catch((e) => ({
      stdout: '',
      stderr: String(e),
      code: 1,
    }));
    const text = `${res.stdout}\n${res.stderr}`.trim();
    return { ok: /Successfully paired/i.test(text), message: text };
  }

  /**
   * ถาม adb ว่ามันเห็นบริการอะไรบ้างบน mDNS
   *
   * adb มีสแตก mDNS ของตัวเองที่บางทีเห็นเครื่องที่ตัวเราเองมองไม่เห็น
   * (และบางทีก็กลับกัน) — ใช้ทั้งสองทางแล้วรวมผลจะครอบคลุมที่สุด
   *
   * รูปแบบหนึ่งบรรทัด: <ชื่ออินสแตนซ์>\t<ชนิดบริการ>\t<ที่อยู่:พอร์ต>
   */
  async mdnsServices(): Promise<Array<{ instance: string; service: string; address: string; port: number }>> {
    if (!this.adbPath) return [];
    const res = await run(this.adbPath, ['mdns', 'services'], 8000).catch(() => null);
    if (!res) return [];

    const out: Array<{ instance: string; service: string; address: string; port: number }> = [];
    for (const line of res.stdout.split('\n')) {
      const parts = line.trim().split(/\t+/);
      if (parts.length < 3) continue;
      const [instance, service, hostPort] = parts;
      if (!service.startsWith('_adb')) continue;
      const colon = hostPort.lastIndexOf(':');
      if (colon < 0) continue;
      const port = parseInt(hostPort.slice(colon + 1), 10);
      if (Number.isNaN(port)) continue;
      out.push({ instance, service, address: hostPort.slice(0, colon), port });
    }
    return out;
  }

  /**
   * ขอสิทธิ์ root ให้ตัว adbd เอง — ได้เฉพาะ ROM แบบ userdebug/eng
   * เครื่องขายทั่วไปจะตอบ "adbd cannot run as root in production builds"
   * ซึ่งไม่ใช่ข้อผิดพลาด แค่แปลว่าต้องไปทาง su แทน
   */
  async adbRoot(serial: string): Promise<{ ok: boolean; message: string }> {
    const sock = await this.openTransport(serial);
    try {
      await sock.request('root:');
      const text = (await sock.readToEnd()).toString('utf8').trim();
      return { ok: !/cannot run as root|not permitted/i.test(text), message: text };
    } catch (err) {
      return { ok: false, message: String(err) };
    } finally {
      sock.close();
    }
  }
}

// ─────────────────────────────── ตัวช่วยระดับโมดูล ───────────────────────────────

/** ต่อ parser แบบ length-prefixed เข้ากับสตรีม track-devices */
function attachTracker(
  sock: AdbSocket,
  onList: (devices: RawDeviceLine[]) => void,
  onError: (err: Error) => void,
): void {
  // ต้องระบุชนิดเอง — @types/node 22 ทำให้ Buffer เป็น generic แล้ว
  // Buffer.alloc(0) จะได้ Buffer<ArrayBuffer> ซึ่งแคบกว่า chunk ที่ socket ส่งมา
  let buf: Buffer = Buffer.alloc(0);
  sock.stream(
    (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      // หนึ่งเฟรม = ความยาว 4 หลักฐานสิบหก + payload; ในบัฟเฟอร์อาจมีหลายเฟรม
      for (;;) {
        if (buf.length < 4) return;
        const len = parseInt(buf.subarray(0, 4).toString('utf8'), 16);
        if (Number.isNaN(len)) {
          onError(new AdbError('สตรีม track-devices ส่งความยาวที่อ่านไม่ออก'));
          return;
        }
        if (buf.length < 4 + len) return;
        const payload = buf.subarray(4, 4 + len).toString('utf8');
        buf = buf.subarray(4 + len);
        onList(parseDeviceList(payload));
      }
    },
    (err) => {
      if (err) onError(err);
    },
  );
}

function syncHeader(tag: string, value: number): Buffer {
  const b = Buffer.alloc(8);
  b.write(tag, 0, 'ascii');
  b.writeUInt32LE(value, 4);
  return b;
}

function stripTrailingNewline(s: string): string {
  return s.replace(/\r?\n$/, '');
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function run(
  exe: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`คำสั่ง ${path.basename(exe)} ${args.join(' ')} หมดเวลา`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

/**
 * หา adb.exe จากที่ที่มันอยู่จริงบนเครื่อง Windows เรียงตามความน่าเชื่อถือ
 * คืน null ถ้าไม่เจอ — ชั้นบนจะแจ้งผู้ใช้ให้ระบุพาธเอง
 */
export function findAdb(): string | null {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates: string[] = [];

  for (const envVar of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const root = process.env[envVar];
    if (root) candidates.push(path.join(root, 'platform-tools', exe));
  }

  const home = os.homedir();
  candidates.push(
    path.join(home, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', exe),
    path.join('C:', 'Android', 'Sdk', 'platform-tools', exe),
    path.join('D:', 'Android', 'Sdk', 'platform-tools', exe),
    path.join(home, 'Android', 'Sdk', 'platform-tools', exe),
    path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', exe),
    '/usr/local/bin/adb',
    '/usr/bin/adb',
  );

  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      // พาธที่เข้าถึงไม่ได้ก็ข้ามไป
    }
  }

  // ท้ายสุด ลองหาใน PATH
  const pathEnv = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    const c = path.join(dir, exe);
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ข้าม
    }
  }

  return null;
}
