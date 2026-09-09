/**
 * บันทึกลงไฟล์ — ทุกบรรทัดที่ขึ้นในกล่องบันทึกเหตุการณ์ของแอป ลงไฟล์นี้ด้วย
 *
 * ทำไมต้องมี: ตอนผู้ใช้บอกว่า "มันไม่ทำงาน" สิ่งเดียวที่ช่วยวินิจฉัยได้คือ log
 * แต่กล่องในแอปหายทันทีที่ปิดหน้าต่าง และ console ของ main ไม่มีใครเห็น
 * ไฟล์นี้อยู่ที่ <userData>/logs/androidremote.log เปิดจากเมนูได้
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;

export class FileLog {
  private stream: fs.WriteStream | null = null;
  readonly filePath: string;

  constructor(userDataDir: string) {
    const dir = path.join(userDataDir, 'logs');
    this.filePath = path.join(dir, 'androidremote.log');
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.rotateIfLarge();
      this.stream = fs.createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' });
    } catch {
      // เขียนไฟล์ไม่ได้ก็ยังใช้แอปได้ แค่ไม่มี log เก็บ
      this.stream = null;
    }
  }

  /** ไฟล์เดียวโตไม่รู้จบไม่ได้ — เกิน 2MB ให้เก็บตัวเก่าไว้หนึ่งชุดแล้วเริ่มใหม่ */
  private rotateIfLarge(): void {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size > MAX_BYTES) {
        fs.renameSync(this.filePath, `${this.filePath}.1`);
      }
    } catch {
      // ยังไม่มีไฟล์ ปกติ
    }
  }

  write(level: string, scope: string, message: string): void {
    if (!this.stream) return;
    const ts = new Date().toISOString();
    this.stream.write(`${ts} [${level.toUpperCase().padEnd(5)}] [${scope}] ${message}\n`);
  }

  /** หัวไฟล์ตอนเปิดแอป — สิ่งแรกที่ต้องรู้ตอนอ่าน log คือรันเวอร์ชันไหนบนเครื่องแบบไหน */
  banner(info: Record<string, unknown>): void {
    this.write('info', 'app', '━'.repeat(60));
    for (const [k, v] of Object.entries(info)) {
      this.write('info', 'app', `${k}: ${String(v)}`);
    }
  }

  /** อ่านท้ายไฟล์เพื่อโชว์หรือคัดลอกส่งให้คนช่วยดู */
  tail(maxBytes = 64 * 1024): string {
    try {
      const stat = fs.statSync(this.filePath);
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(this.filePath, 'r');
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      return buf.toString('utf8');
    } catch {
      return '';
    }
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
