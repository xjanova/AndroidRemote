/**
 * กวาดหาเครื่องในวง LAN ที่เปิดพอร์ต adb ไว้แบบเก่า
 *
 * ทำไมยังต้องมีทั้งที่มี mDNS แล้ว — เครื่องที่สั่ง `adb tcpip 5555` เอง
 * (แอนดรอยด์ทุกรุ่น รวมรุ่นก่อน 11) **ไม่ประกาศตัวบน mDNS เลย** มันแค่เปิดพอร์ตเงียบๆ
 * ถ้ามีแต่ mDNS จะหาเครื่องกลุ่มนี้ไม่เจอตลอดกาล
 */

import net from 'node:net';
import os from 'node:os';

/** พอร์ตมาตรฐานของ adb over TCP — 5555 เป็นค่าที่ `adb tcpip` ใช้เสมอ */
export const DEFAULT_ADB_PORTS = [5555];

export interface ScanTarget {
  address: string;
  port: number;
}

export interface Subnet {
  /** ที่อยู่ของเครื่องเราเองบนวงนี้ */
  self: string;
  prefix: number;
  /** ที่อยู่ทั้งหมดที่ควรลอง ไม่รวมตัวเราเองกับ network/broadcast */
  hosts: string[];
}

/**
 * หาวงที่ควรกวาด
 *
 * จำกัดที่ /22 ขึ้นไป (ไม่เกิน 1022 โฮสต์) — วงที่ใหญ่กว่านั้นกวาดแล้วช้าเกิน
 * จนผู้ใช้คิดว่าแอปค้าง และแทบไม่มีบ้านไหนใช้วงใหญ่ขนาดนั้น
 */
export function localSubnets(minPrefix = 22): Subnet[] {
  const out: Subnet[] = [];

  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal || !addr.cidr) continue;

      const prefix = parseInt(addr.cidr.split('/')[1] ?? '0', 10);
      if (!Number.isFinite(prefix) || prefix < minPrefix || prefix > 30) continue;

      const selfInt = ipToInt(addr.address);
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      const network = (selfInt & mask) >>> 0;
      const broadcast = (network | (~mask >>> 0)) >>> 0;

      const hosts: string[] = [];
      for (let i = network + 1; i < broadcast; i++) {
        if (i === selfInt) continue;
        hosts.push(intToIp(i));
      }

      out.push({ self: addr.address, prefix, hosts });
    }
  }

  return out;
}

export interface SweepOptions {
  ports?: number[];
  /** เปิดพร้อมกันกี่ซ็อกเก็ต — สูงไปแล้ว Windows จะคืน EADDRINUSE รัวๆ */
  concurrency?: number;
  /** รอต่อหนึ่งเป้าหมายนานเท่าไหร่ */
  timeoutMs?: number;
  onFound?: (target: ScanTarget) => void;
  onProgress?: (done: number, total: number) => void;
  signal?: { aborted: boolean };
}

/**
 * ลองต่อ TCP ไปทุกที่อยู่ในวง
 *
 * "ต่อติด" ไม่ได้แปลว่าเป็น adb แน่ๆ — อาจเป็นบริการอื่นที่บังเอิญใช้พอร์ตเดียวกัน
 * ตัวยืนยันจริงคือ `adb connect` ที่จะตอบกลับมาเองว่าคุยโปรโตคอลรู้เรื่องไหม
 */
export async function sweep(options: SweepOptions = {}): Promise<ScanTarget[]> {
  const ports = options.ports ?? DEFAULT_ADB_PORTS;
  const concurrency = options.concurrency ?? 96;
  const timeoutMs = options.timeoutMs ?? 400;

  const targets: ScanTarget[] = [];
  for (const subnet of localSubnets()) {
    for (const host of subnet.hosts) {
      for (const port of ports) targets.push({ address: host, port });
    }
  }

  const found: ScanTarget[] = [];
  let index = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (options.signal?.aborted) return;
      const i = index++;
      if (i >= targets.length) return;
      const target = targets[i];

      if (await probe(target, timeoutMs)) {
        found.push(target);
        options.onFound?.(target);
      }

      done++;
      // รายงานเป็นช่วง ไม่ใช่ทุกครั้ง — ไม่งั้นยิง IPC เป็นพันครั้งใน 10 วินาที
      if (done % 32 === 0 || done === targets.length) {
        options.onProgress?.(done, targets.length);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  return found;
}

function probe(target: ScanTarget, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(target.port, target.address);
  });
}

// ─────────────────────────── ตัวช่วย ───────────────────────────

function ipToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

function intToIp(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}
