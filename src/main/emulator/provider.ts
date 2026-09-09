/**
 * สัญญากลางของ "ตัวจัดการอีมูเลเตอร์หนึ่งยี่ห้อ"
 *
 * ทุกยี่ห้อมี CLI คนละแบบ (Nox=NoxConsole, LDPlayer=ldconsole, MEmu=memuc)
 * แต่ทำงานแนวเดียวกัน — interface นี้ทำให้ UI กับ Manager ไม่ต้องรู้ว่าเป็นยี่ห้อไหน
 * ตอนนี้มีแค่ Nox แต่เพิ่มยี่ห้ออื่นได้โดยไม่แตะ UI
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import type {
  AndroidVersionChoice,
  CreateEmulatorSpec,
  EmulatorBrandId,
  EmulatorInstanceView,
  EmulatorOpResult,
} from '../../shared/emulator';

export interface EmulatorProvider {
  readonly brand: EmulatorBrandId;
  readonly label: string;
  readonly androidVersions: AndroidVersionChoice[];

  /** ติดตั้งในเครื่องนี้ไหม (เจอ CLI) */
  available(): boolean;
  cliPath(): string | null;
  /** เวอร์ชัน adb ที่ยี่ห้อนี้แถมมา — null ถ้าไม่มี */
  bundledAdbVersion(): string | null;

  list(): Promise<EmulatorInstanceView[]>;
  create(spec: CreateEmulatorSpec): Promise<EmulatorOpResult>;
  launch(id: string): Promise<EmulatorOpResult>;
  quit(id: string): Promise<EmulatorOpResult>;
  reboot(id: string): Promise<EmulatorOpResult>;
  remove(id: string): Promise<EmulatorOpResult>;
}

// ─────────────────────────── ตัวช่วยที่ทุก provider ใช้ ───────────────────────────

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  combined: string;
}

/** รัน CLI ของอีมูเลเตอร์ — timeout ยาวเพราะสร้าง/ลบเครื่องช้า */
export function runCli(exe: string, args: string[], timeoutMs = 120_000): RunResult {
  const res = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  return { code: res.status ?? -1, stdout, stderr, combined: `${stdout}\n${stderr}`.trim() };
}

/** เวอร์ชัน adb ของไฟล์หนึ่ง — "1.0.41" หรือ null */
export function adbVersionOf(exe: string): string | null {
  if (!fs.existsSync(exe)) return null;
  const res = runCli(exe, ['version'], 8000);
  const m = /Android Debug Bridge version ([\d.]+)/.exec(res.combined);
  return m ? m[1] : null;
}

/** หาไฟล์แรกที่มีจริงจากรายการพาธ (รองรับตัวแปร env และหลายไดรฟ์) */
export function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      // พาธเข้าถึงไม่ได้ ข้าม
    }
  }
  return null;
}

/** พาธมาตรฐานของโปรแกรมบน Windows หลายไดรฟ์ */
export function programDirs(...subpaths: string[]): string[] {
  const roots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramW6432'],
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'D:\\Program Files',
    'D:\\Program Files (x86)',
    'C:\\',
    'D:\\',
    os.homedir(),
  ].filter((r): r is string => Boolean(r));

  const out: string[] = [];
  for (const root of roots) for (const sub of subpaths) out.push(path.join(root, sub));
  return out;
}
