/**
 * ฉีดคีย์บอร์ดเข้า Windows ผ่าน exe ตัวเล็กที่คอมไพล์ไว้ล่วงหน้า
 *
 * เปิดโพรเซสค้างไว้ตัวเดียวแล้วคุยผ่าน stdin — เปิดปิดต่อหนึ่งปุ่มจะหน่วง
 * เป็นร้อยมิลลิวินาที ซึ่งใช้เล่นเกมไม่ได้
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export class KeyInjector {
  private child: ChildProcess | null = null;
  private ready = false;
  /** ปุ่มที่กดค้างอยู่ — ต้องปล่อยให้หมดตอนปิด ไม่งั้นค้างในระบบต่อไป */
  private held = new Set<number>();

  constructor(private log: (level: 'info' | 'warn' | 'error', message: string) => void = () => {}) {}

  static helperPath(): string {
    const packed = path.join(process.resourcesPath ?? '', 'inputhelper.exe');
    if (process.resourcesPath && fs.existsSync(packed)) return packed;
    return path.join(process.cwd(), 'resources', 'inputhelper.exe');
  }

  static available(): boolean {
    return process.platform === 'win32' && fs.existsSync(KeyInjector.helperPath());
  }

  start(): boolean {
    if (this.child) return true;
    if (process.platform !== 'win32') {
      this.log('warn', 'ตัวฉีดคีย์นี้ใช้ได้เฉพาะ Windows');
      return false;
    }
    const exe = KeyInjector.helperPath();
    if (!fs.existsSync(exe)) {
      this.log('error', `ไม่พบ ${exe} — รัน npm run helper:build ก่อน`);
      return false;
    }

    this.child = spawn(exe, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    this.child.stdout?.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (text.includes('READY')) {
        this.ready = true;
        this.log('info', 'ตัวฉีดคีย์พร้อมแล้ว');
      }
    });
    this.child.stderr?.on('data', (d: Buffer) => {
      this.log('warn', `ตัวฉีดคีย์: ${d.toString().trim()}`);
    });
    this.child.on('exit', (code) => {
      this.log(code === 0 ? 'info' : 'warn', `ตัวฉีดคีย์จบแล้ว (exit ${code})`);
      this.child = null;
      this.ready = false;
      this.held.clear();
    });

    return true;
  }

  private write(line: string): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${line}\n`);
  }

  down(vk: number): void {
    if (!this.ready || this.held.has(vk)) return; // ซ้ำไม่ต้องส่ง ระบบทำ auto-repeat ให้เอง
    this.held.add(vk);
    this.write(`D ${vk}`);
  }

  up(vk: number): void {
    if (!this.ready || !this.held.delete(vk)) return;
    this.write(`U ${vk}`);
  }

  /** ปล่อยทุกปุ่ม — เรียกเมื่อโทรศัพท์หลุด ไม่งั้นตัวละครจะเดินหน้าไม่หยุด */
  releaseAll(): void {
    for (const vk of [...this.held]) this.up(vk);
  }

  get isReady(): boolean {
    return this.ready;
  }

  stop(): void {
    if (!this.child) return;
    this.releaseAll();
    this.write('Q');
    // ให้เวลาปล่อยปุ่มก่อนฆ่า — ฆ่าทันทีอาจทิ้งปุ่มค้างไว้ในระบบ
    const child = this.child;
    setTimeout(() => {
      if (!child.killed) child.kill();
    }, 300);
    this.child = null;
    this.ready = false;
  }
}
