/**
 * ตัวค้นหาอุปกรณ์ผ่าน mDNS — ไม่พึ่งไลบรารีภายนอก
 *
 * แอนดรอยด์ 11 ขึ้นไปประกาศตัวเองบนวง LAN สามบริการ:
 *   _adb-tls-connect._tcp   เปิดการแก้จุดบกพร่องไร้สายอยู่ จับคู่แล้ว พร้อมต่อ
 *   _adb-tls-pairing._tcp   กำลังเปิดหน้า "จับคู่อุปกรณ์ด้วยรหัส" อยู่ตอนนี้
 *   _adb._tcp               โหมดเก่า จาก `adb tcpip` (ไม่มีการเข้ารหัส)
 *
 * ทำไมเขียนเอง: โปรเจคนี้ไม่มี runtime dependency สักตัว และ mDNS ที่เราต้องใช้
 * มีแค่ "ยิงคำถาม PTR แล้วแกะคำตอบ" ซึ่งสั้นกว่าการรับภาระไลบรารีเข้ามา
 */

import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;

export const ADB_SERVICES = {
  connect: '_adb-tls-connect._tcp.local',
  pairing: '_adb-tls-pairing._tcp.local',
  legacy: '_adb._tcp.local',
} as const;

export type AdbServiceKind = keyof typeof ADB_SERVICES;

export interface MdnsService {
  kind: AdbServiceKind;
  /** ชื่ออินสแตนซ์เต็ม เช่น adb-R5CT80XXXXW-abc123._adb-tls-connect._tcp.local */
  instance: string;
  /**
   * serial ของเครื่องที่แกะจากชื่ออินสแตนซ์
   * แอนดรอยด์ตั้งชื่อเป็น adb-<serial>-<สุ่ม> — ส่วน serial คงที่ข้ามการรีบูต
   * จึงใช้เป็นกุญแจจำเครื่องได้
   */
  serial: string | null;
  host: string;
  port: number;
  address: string | null;
  at: number;
}

// ─────────────────────────── แกะข้อความ DNS ───────────────────────────

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_SRV = 33;

interface Reader {
  buf: Buffer;
  off: number;
}

/**
 * อ่านชื่อโดเมน รองรับการบีบอัดด้วยตัวชี้ (สองบิตบนเป็น 11 แล้วตามด้วยออฟเซ็ต 14 บิต)
 *
 * ⚠ ต้องกันลูปไม่รู้จบ — แพ็กเก็ตที่เสียหายหรือจงใจกวนสามารถทำตัวชี้วนกลับมาที่เดิมได้
 */
function readName(r: Reader): string {
  const labels: string[] = [];
  let jumped = false;
  let off = r.off;
  let hops = 0;

  for (;;) {
    if (off >= r.buf.length) break;
    const len = r.buf[off];

    if (len === 0) {
      off += 1;
      break;
    }

    if ((len & 0xc0) === 0xc0) {
      if (off + 1 >= r.buf.length) break;
      const pointer = ((len & 0x3f) << 8) | r.buf[off + 1];
      if (!jumped) {
        r.off = off + 2;
        jumped = true;
      }
      if (++hops > 32) break; // ตัวชี้วนเป็นวง — ยอมแพ้
      off = pointer;
      continue;
    }

    off += 1;
    if (off + len > r.buf.length) break;
    labels.push(r.buf.subarray(off, off + len).toString('utf8'));
    off += len;
  }

  if (!jumped) r.off = off;
  return labels.join('.');
}

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean);
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const b = Buffer.from(part, 'utf8');
    chunks.push(Buffer.from([b.length]), b);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function buildQuery(names: string[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // id — mDNS ไม่สนใจ
  header.writeUInt16BE(0, 2); // flags: standard query
  header.writeUInt16BE(names.length, 4);

  const questions = names.map((name) => {
    const qname = encodeName(name);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(TYPE_PTR, 0);
    // บิต 15 ของ QCLASS = ขอให้ตอบกลับแบบ unicast
    // จำเป็นเพราะเราไม่ได้ผูกพอร์ต 5353 (adb มักจองไว้แล้ว)
    tail.writeUInt16BE(0x8001, 2);
    return Buffer.concat([qname, tail]);
  });

  return Buffer.concat([header, ...questions]);
}

export interface ParsedRecords {
  ptr: Map<string, string[]>;
  srv: Map<string, { host: string; port: number }>;
  a: Map<string, string>;
}

/**
 * แกะข้อความตอบกลับ — export ไว้เพื่อให้ทดสอบได้โดยไม่ต้องมีเครื่องจริงบนวง
 * นี่คือส่วนที่พลาดง่ายที่สุดในไฟล์นี้ (การบีบอัดชื่อ + ออฟเซ็ตของ RDATA)
 */
export function parseMdnsResponse(buf: Buffer): ParsedRecords {
  return parseResponse(buf);
}

function parseResponse(buf: Buffer): ParsedRecords {
  const out: ParsedRecords = { ptr: new Map(), srv: new Map(), a: new Map() };
  if (buf.length < 12) return out;

  const counts = {
    qd: buf.readUInt16BE(4),
    an: buf.readUInt16BE(6),
    ns: buf.readUInt16BE(8),
    ar: buf.readUInt16BE(10),
  };

  const r: Reader = { buf, off: 12 };

  // ข้ามส่วนคำถาม
  for (let i = 0; i < counts.qd; i++) {
    readName(r);
    r.off += 4;
  }

  const total = counts.an + counts.ns + counts.ar;
  for (let i = 0; i < total; i++) {
    if (r.off + 10 > buf.length) break;
    const name = readName(r);
    if (r.off + 10 > buf.length) break;
    const type = buf.readUInt16BE(r.off);
    const rdLength = buf.readUInt16BE(r.off + 8);
    r.off += 10;
    const rdStart = r.off;
    if (rdStart + rdLength > buf.length) break;

    if (type === TYPE_PTR) {
      const sub: Reader = { buf, off: rdStart };
      const target = readName(sub);
      const list = out.ptr.get(name) ?? [];
      list.push(target);
      out.ptr.set(name, list);
    } else if (type === TYPE_SRV && rdLength >= 7) {
      const port = buf.readUInt16BE(rdStart + 4);
      const sub: Reader = { buf, off: rdStart + 6 };
      const host = readName(sub);
      out.srv.set(name, { host, port });
    } else if (type === TYPE_A && rdLength === 4) {
      out.a.set(name, `${buf[rdStart]}.${buf[rdStart + 1]}.${buf[rdStart + 2]}.${buf[rdStart + 3]}`);
    }

    r.off = rdStart + rdLength;
  }

  return out;
}

/** ชื่ออินสแตนซ์ของ adb คือ adb-<serial>-<สุ่ม> — เอาส่วนกลางออกมา */
export function serialFromInstance(instance: string): string | null {
  const label = instance.split('.')[0];
  const m = /^adb-(.+)-[^-]+$/.exec(label);
  return m ? m[1] : null;
}

// ─────────────────────────── ตัวค้นหา ───────────────────────────

export class MdnsBrowser extends EventEmitter {
  private sockets: dgram.Socket[] = [];
  private timer: NodeJS.Timeout | null = null;
  private seen = new Map<string, MdnsService>();
  private stopped = false;

  /**
   * เริ่มค้นหา — ยิงคำถามซ้ำเป็นระยะเพราะแพ็กเก็ต UDP หายได้
   * และเครื่องที่เพิ่งเปิดโหมดไร้สายจะยังไม่ได้ยินคำถามรอบแรก
   */
  async start(intervalMs = 3000): Promise<void> {
    const query = buildQuery(Object.values(ADB_SERVICES));

    // ผูกทีละอินเทอร์เฟซ ไม่ใช่ 0.0.0.0 — เครื่องที่มีทั้ง Wi-Fi, LAN, และ
    // อะแดปเตอร์เสมือนของ VM/Docker จะส่งออกผิดใบถ้าปล่อยให้ระบบเลือกเอง
    for (const iface of localIPv4Interfaces()) {
      try {
        const socket = await this.bindSocket(iface);
        this.sockets.push(socket);
      } catch (err) {
        this.emit('log', `ผูกซ็อกเก็ตกับ ${iface} ไม่ได้: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (this.sockets.length === 0) {
      throw new Error('เปิดซ็อกเก็ต mDNS ไม่ได้เลยสักใบ');
    }

    const send = (): void => {
      if (this.stopped) return;
      for (const socket of this.sockets) {
        socket.send(query, MDNS_PORT, MDNS_ADDRESS, (err) => {
          if (err) this.emit('log', `ส่งคำถาม mDNS ไม่สำเร็จ: ${err.message}`);
        });
      }
    };

    send();
    this.timer = setInterval(send, intervalMs);
  }

  private bindSocket(iface: string): Promise<dgram.Socket> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      socket.on('error', (err) => {
        socket.close();
        reject(err);
      });

      socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo.address));

      // พอร์ต 0 = ให้ระบบเลือก แล้วรับคำตอบแบบ unicast (เราตั้งบิต QU ไว้แล้ว)
      // ไม่แย่งพอร์ต 5353 กับ adb หรือ Bonjour ที่อาจทำงานอยู่
      socket.bind(0, iface, () => {
        try {
          socket.setMulticastTTL(255);
          socket.setMulticastInterface(iface);
          // เผื่อผู้ตอบบางรายไม่สนใจบิต QU แล้วตอบมาแบบ multicast
          socket.addMembership(MDNS_ADDRESS, iface);
        } catch {
          // บางอะแดปเตอร์ join กลุ่มไม่ได้ — ยังใช้ทาง unicast ได้อยู่
        }
        resolve(socket);
      });
    });
  }

  private onMessage(msg: Buffer, from: string): void {
    let records: ParsedRecords;
    try {
      records = parseResponse(msg);
    } catch {
      return; // แพ็กเก็ตเสีย ไม่ใช่เรื่องของเรา
    }

    for (const [kind, serviceName] of Object.entries(ADB_SERVICES) as [AdbServiceKind, string][]) {
      const instances = records.ptr.get(serviceName);
      if (!instances) continue;

      for (const instance of instances) {
        const srv = records.srv.get(instance);
        if (!srv) continue;

        // ที่อยู่จาก A record ดีที่สุด ถ้าไม่มีก็ใช้ต้นทางของแพ็กเก็ต
        const address = records.a.get(srv.host) ?? from;

        const service: MdnsService = {
          kind,
          instance,
          serial: serialFromInstance(instance),
          host: srv.host,
          port: srv.port,
          address,
          at: Date.now(),
        };

        const key = `${kind}:${instance}`;
        const previous = this.seen.get(key);
        this.seen.set(key, service);

        // แจ้งเฉพาะของใหม่หรือของที่ย้ายที่อยู่ ไม่ใช่ทุกครั้งที่ได้ยินซ้ำ
        if (!previous || previous.address !== service.address || previous.port !== service.port) {
          this.emit('service', service);
        }
      }
    }
  }

  list(): MdnsService[] {
    return [...this.seen.values()];
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const socket of this.sockets) {
      try {
        socket.close();
      } catch {
        // ปิดไปแล้วก็ไม่เป็นไร
      }
    }
    this.sockets = [];
    this.removeAllListeners();
  }
}

/** ที่อยู่ IPv4 ของอินเทอร์เฟซที่ใช้งานได้จริง (ไม่เอา loopback) */
export function localIPv4Interfaces(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}
