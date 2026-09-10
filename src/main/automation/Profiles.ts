/**
 * โปรไฟล์ต่อเครื่อง — ตัวแปร (ชื่อบัญชี, เซิร์ฟเวอร์, ฯลฯ) + เสียง
 *
 * มาโครเดียวกันเขียน {{username}} ไว้ แต่ละเครื่องแทนค่าจากโปรไฟล์ของตัวเอง
 * นี่คือสิ่งที่ทำให้ "แต่ละเครื่องทำต่างกัน" โดยไม่ต้องมีมาโครแยกต่อเครื่อง
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DeviceProfile } from '../../shared/automation';

export class ProfileStore {
  private items = new Map<string, DeviceProfile>();
  private file: string;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'device-profiles.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { profiles?: DeviceProfile[] };
      for (const p of raw.profiles ?? []) if (p?.serial) this.items.set(p.serial, { enabled: true, ...p, vars: p.vars ?? {} });
    } catch {
      // ยังไม่มีไฟล์ — เริ่มว่าง
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ profiles: [...this.items.values()] }, null, 2), 'utf8');
    } catch {
      // เขียนไม่ได้ก็ยังใช้ในรอบนี้ได้
    }
  }

  list(): DeviceProfile[] {
    return [...this.items.values()];
  }

  get(serial: string): DeviceProfile | undefined {
    return this.items.get(serial);
  }

  put(p: DeviceProfile): void {
    // ตัดชื่อตัวแปรว่างและช่องว่างหัวท้ายทิ้ง กันพิมพ์พลาดแล้วหาไม่เจอ
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.vars ?? {})) {
      const key = k.trim();
      if (key) vars[key] = String(v ?? '');
    }
    this.items.set(p.serial, { ...p, vars, enabled: p.enabled ?? true });
    this.save();
  }

  delete(serial: string): void {
    if (this.items.delete(serial)) this.save();
  }

  /** ชื่อตัวแปรทั้งหมดที่มีในโปรไฟล์ใดๆ — ให้ UI โชว์เป็นคอลัมน์ตาราง */
  varNames(): string[] {
    const names = new Set<string>();
    for (const p of this.items.values()) for (const k of Object.keys(p.vars)) names.add(k);
    return [...names].sort();
  }
}

/**
 * แทนค่า {{ชื่อ}} และ {{ชื่อ|ค่าสำรอง}} ในข้อความ
 * ไม่รู้จักชื่อและไม่มีค่าสำรอง → คงไว้ตามเดิมให้เห็นว่าลืมตั้ง
 */
export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([^}|]+?)\s*(?:\|([^}]*))?\}\}/g, (whole, name: string, fallback?: string) => {
    const v = vars[name];
    if (v !== undefined) return v;
    if (fallback !== undefined) return fallback;
    return whole;
  });
}
