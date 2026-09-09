/**
 * ตั้งเวลาให้มาโครทำงานเอง
 *
 * ⚠ ทำงานเฉพาะตอนแอปเปิดอยู่ — ไม่มีบริการพื้นหลัง ไม่มี Task Scheduler ของ Windows
 *   ผู้ใช้ต้องรู้เรื่องนี้ชัดๆ ไม่งั้นจะคิดว่าตั้งไว้แล้วปิดคอมได้
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ScheduleView } from '../../shared/automation';

type Runner = (entry: ScheduleView) => Promise<string>;
type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

const TICK_MS = 20_000;

export class Scheduler extends EventEmitter {
  private items = new Map<string, ScheduleView>();
  private file: string;
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(
    userDataDir: string,
    private runner: Runner,
    private log: Log,
  ) {
    super();
    this.file = path.join(userDataDir, 'schedules.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { schedules?: ScheduleView[] };
      for (const s of raw.schedules ?? []) if (s?.id) this.items.set(s.id, s);
    } catch {
      // เริ่มว่าง
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ schedules: [...this.items.values()] }, null, 2), 'utf8');
    } catch {
      // ปล่อย
    }
  }

  list(): ScheduleView[] {
    return [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  put(entry: ScheduleView): void {
    this.items.set(entry.id, entry);
    this.save();
    this.emit('changed');
  }
  delete(id: string): void {
    if (this.items.delete(id)) {
      this.save();
      this.emit('changed');
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // ทำงานทันทีหนึ่งรอบด้วย เผื่อมีรายการที่ถึงเวลาตอนแอปปิดอยู่
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** รายการนี้ถึงเวลาแล้วหรือยัง — ตัดสินจาก lastRunAt ไม่ใช่นาฬิกาล้วน กันยิงซ้ำในนาทีเดียวกัน */
  private isDue(s: ScheduleView, now: Date): boolean {
    if (!s.enabled) return false;
    const last = s.lastRunAt ?? 0;
    switch (s.mode) {
      case 'once':
        return now.getTime() >= s.at && last < s.at;
      case 'interval':
        return now.getTime() - last >= (s.everyMs ?? 3_600_000);
      case 'daily': {
        const minuteOfDay = now.getHours() * 60 + now.getMinutes();
        if (minuteOfDay < s.at) return false;
        const lastDay = new Date(last);
        const ranToday =
          lastDay.getFullYear() === now.getFullYear() &&
          lastDay.getMonth() === now.getMonth() &&
          lastDay.getDate() === now.getDate();
        return !ranToday;
      }
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();
    for (const s of this.items.values()) {
      if (this.running.has(s.id) || !this.isDue(s, now)) continue;
      this.running.add(s.id);
      // ตั้ง lastRunAt ก่อนรัน — ถ้ารันนานเกินหนึ่ง tick จะได้ไม่ถูกยิงซ้ำ
      s.lastRunAt = now.getTime();
      this.save();
      this.log('info', `ถึงเวลา "${s.name}" — เริ่มมาโคร`);
      try {
        s.lastResult = await this.runner(s);
      } catch (err) {
        s.lastResult = `ล้มเหลว: ${err instanceof Error ? err.message : String(err)}`;
        this.log('error', `"${s.name}": ${s.lastResult}`);
      } finally {
        if (s.mode === 'once') s.enabled = false;
        this.running.delete(s.id);
        this.save();
        this.emit('changed');
      }
    }
  }
}
