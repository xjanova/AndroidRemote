/**
 * รายชื่อเครื่องที่เคยจับคู่หรือเคยต่อสำเร็จ
 *
 * มีไว้เพื่ออย่างเดียว: เจอบนวง LAN เมื่อไหร่ **ต่อให้เลยโดยไม่ต้องถาม**
 * ผู้ใช้จับคู่ครั้งเดียวแล้วไม่ต้องมายุ่งอีก
 *
 * กุญแจคือ serial ของเครื่อง ไม่ใช่ IP — IP เปลี่ยนทุกครั้งที่ DHCP อยาก
 * แต่ serial คงที่ตลอดอายุเครื่อง
 */

import fs from 'node:fs';
import path from 'node:path';

export interface KnownDevice {
  serial: string;
  /** ชื่อที่โชว์ให้ผู้ใช้ — รุ่นเครื่อง ถ้าเคยตรวจได้ */
  name?: string;
  /** ที่อยู่ล่าสุดที่ต่อสำเร็จ ใช้ลองก่อนตอนยังไม่เจอบน mDNS */
  lastAddress?: string;
  lastPort?: number;
  /** false = เจอแล้วให้เฉยไว้ ผู้ใช้จะกดต่อเอง */
  autoConnect: boolean;
  pairedAt?: number;
  lastSeenAt?: number;
}

interface FileShape {
  version: 1;
  devices: KnownDevice[];
}

export class KnownDevices {
  private devices = new Map<string, KnownDevice>();
  private filePath: string;
  /** กันเขียนซ้อนกันเมื่อมีการอัปเดตรัวๆ ตอนสแกนเจอหลายเครื่องพร้อมกัน */
  private writeQueued = false;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'known-devices.json');
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as FileShape;
      if (raw?.version !== 1 || !Array.isArray(raw.devices)) return;
      for (const d of raw.devices) {
        if (typeof d?.serial === 'string' && d.serial) this.devices.set(d.serial, d);
      }
    } catch {
      // ไฟล์เสียก็เริ่มใหม่ ดีกว่าแอปเปิดไม่ขึ้นเพราะ JSON พัง
    }
  }

  private save(): void {
    if (this.writeQueued) return;
    this.writeQueued = true;
    setTimeout(() => {
      this.writeQueued = false;
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const data: FileShape = { version: 1, devices: [...this.devices.values()] };
        fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
      } catch {
        // เขียนไม่ได้ก็ยังใช้งานต่อได้ในรอบนี้ แค่ไม่จำข้ามการเปิดแอป
      }
    }, 250);
  }

  list(): KnownDevice[] {
    return [...this.devices.values()].sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  }

  get(serial: string): KnownDevice | undefined {
    return this.devices.get(serial);
  }

  has(serial: string): boolean {
    return this.devices.has(serial);
  }

  /** บันทึกว่าเครื่องนี้รู้จักแล้ว — เรียกหลังจับคู่หรือต่อสำเร็จครั้งแรก */
  remember(patch: Partial<KnownDevice> & { serial: string }): KnownDevice {
    const existing = this.devices.get(patch.serial);
    const merged: KnownDevice = {
      autoConnect: true,
      ...existing,
      ...patch,
      lastSeenAt: Date.now(),
    };
    this.devices.set(merged.serial, merged);
    this.save();
    return merged;
  }

  setAutoConnect(serial: string, on: boolean): void {
    const d = this.devices.get(serial);
    if (!d) return;
    d.autoConnect = on;
    this.save();
  }

  forget(serial: string): void {
    if (this.devices.delete(serial)) this.save();
  }
}
