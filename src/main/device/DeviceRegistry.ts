/**
 * แหล่งความจริงเดียวของ "ตอนนี้มีเครื่องอะไรอยู่บ้าง และแต่ละเครื่องเป็นยังไง"
 *
 * ฟังสตรีม track-devices ของ adb แล้ว probe เครื่องที่เพิ่งออนไลน์
 * ทุกการเปลี่ยนแปลงจะยิงออกทาง onChange ให้ main ส่งต่อไป renderer
 */

import { EventEmitter } from 'node:events';
import type { AdbClient } from '../adb/AdbClient';
import { normalizeState } from '../adb/AdbClient';
import { probeDevice, transportOf } from './probe';
import type { DeviceInfo } from '../../shared/types';

export class DeviceRegistry extends EventEmitter {
  private devices = new Map<string, DeviceInfo>();
  private stopTracker: (() => void) | null = null;
  /** serial ที่กำลัง probe อยู่ — กัน probe ซ้อนเมื่อ adb ยิงรายการรัวๆ */
  private probing = new Set<string>();
  private restartTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private adb: AdbClient,
    private log: (level: 'info' | 'warn' | 'error', message: string) => void = () => {},
  ) {
    super();
  }

  list(): DeviceInfo[] {
    // เรียงให้เครื่องที่ใช้งานได้ขึ้นก่อน แล้วค่อยเรียงตามชื่อ
    return [...this.devices.values()].sort((a, b) => {
      const rank = (d: DeviceInfo) => (d.state === 'device' ? 0 : d.state === 'unauthorized' ? 1 : 2);
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return (a.model ?? a.serial).localeCompare(b.model ?? b.serial);
    });
  }

  get(serial: string): DeviceInfo | undefined {
    return this.devices.get(serial);
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    try {
      this.stopTracker = await this.adb.trackDevices(
        (lines) => {
          const seen = new Set<string>();
          for (const line of lines) {
            const state = normalizeState(line.state);
            seen.add(line.serial);
            const existing = this.devices.get(line.serial);

            if (!existing) {
              this.devices.set(line.serial, {
                serial: line.serial,
                state,
                transport: transportOf(line.serial),
                // ชื่อรุ่นที่ adb แถมมาใน devices-l ใช้ขัดตาไปก่อนระหว่างรอ probe
                model: line.props.model?.replace(/_/g, ' '),
                tier: 'none',
                capabilities: [],
                blockers: [],
              });
              if (state === 'device') void this.probe(line.serial);
            } else if (existing.state !== state) {
              this.devices.set(line.serial, { ...existing, state });
              // เพิ่ง authorize เสร็จ หรือเพิ่งกลับมาออนไลน์ → probe ใหม่
              if (state === 'device') void this.probe(line.serial);
            }
          }

          // เครื่องที่หายไปจากรายการ = ถูกถอด
          for (const serial of [...this.devices.keys()]) {
            if (!seen.has(serial)) this.devices.delete(serial);
          }

          this.emitChange();
        },
        (err) => {
          this.log('warn', `สตรีม track-devices ขาด: ${err.message}`);
          this.scheduleRestart();
        },
      );
      this.log('info', 'เริ่มเฝ้าดูรายชื่อเครื่องแล้ว');
      this.emitChange();
    } catch (err) {
      this.log('error', `เริ่มเฝ้าดูรายชื่อเครื่องไม่ได้: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleRestart();
    }
  }

  /**
   * ตรวจเครื่องใหม่ตามคำสั่งผู้ใช้ (ปุ่มรีเฟรช) หรือหลังผู้ใช้แก้ blocker แล้ว
   */
  async refresh(serial: string): Promise<DeviceInfo | undefined> {
    await this.probe(serial);
    return this.devices.get(serial);
  }

  private async probe(serial: string): Promise<void> {
    if (this.probing.has(serial) || this.disposed) return;
    this.probing.add(serial);
    try {
      const current = this.devices.get(serial);
      const info = await probeDevice(this.adb, serial, current?.state ?? 'device');
      // เครื่องอาจถูกถอดระหว่าง probe — อย่าเอาผลเก่ามาใส่กลับ
      if (!this.devices.has(serial)) return;
      this.devices.set(serial, info);
      this.emit('device:updated', info);
      this.emitChange();
      this.log(
        'info',
        `ตรวจ ${info.model ?? serial} เสร็จ: สิทธิ์ระดับ ${info.tier}, ทำได้ ${info.capabilities.length} อย่าง` +
          (info.blockers.length ? `, ติด ${info.blockers.length} เรื่อง` : ''),
      );
    } catch (err) {
      this.log('error', `ตรวจ ${serial} ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.probing.delete(serial);
    }
  }

  /**
   * สตรีมขาดเกิดได้ปกติ (adb server ถูก kill, USB สะดุด) — ต่อใหม่แบบถอยจังหวะ
   * ไม่ใช้ backoff แบบทวีคูณเพราะผู้ใช้จะรอนานเกินไปหลังเสียบสายใหม่
   */
  private scheduleRestart(): void {
    if (this.restartTimer || this.disposed) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.disposed) return;
      this.log('info', 'กำลังต่อสตรีมรายชื่อเครื่องใหม่');
      void this.start();
    }, 2000);
  }

  private emitChange(): void {
    this.emit('devices:changed', this.list());
  }

  dispose(): void {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stopTracker?.();
    this.stopTracker = null;
    this.devices.clear();
    this.removeAllListeners();
  }
}
