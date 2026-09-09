/**
 * มาโคร: เก็บ · บันทึก · เล่นซ้ำไปหลายเครื่องพร้อมกัน
 *
 * บันทึกจาก**ฝั่ง PC** — ทุก touch/key ที่ผู้ใช้ทำผ่านแอปไหลผ่านที่นี่อยู่แล้ว
 * จึงไม่ต้องมีอะไรบนมือถือเพิ่ม พิกัดเก็บเป็นสัดส่วนของจอ เล่นซ้ำบนจอต่างขนาดได้
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AdbClient } from '../adb/AdbClient';
import type { TouchInput } from '../../shared/api';
import type { Macro, MacroRunState, MacroStep, UiSelector } from '../../shared/automation';
import { TOUCH_ACTION, KEY_ACTION, encodeKeycode, encodeText, encodeTouch } from '../server/messages';
import { dumpUi, locate } from './UiDump';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

// ─────────────────────────────── ที่เก็บ ───────────────────────────────

export class MacroStore {
  private items = new Map<string, Macro>();
  private file: string;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'macros.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { macros?: Macro[] };
      for (const m of raw.macros ?? []) if (m?.id) this.items.set(m.id, m);
    } catch {
      // ยังไม่มีไฟล์ หรือไฟล์เสีย — เริ่มว่าง
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ macros: [...this.items.values()] }, null, 2), 'utf8');
    } catch {
      // เขียนไม่ได้ก็ยังใช้ในรอบนี้ได้
    }
  }

  list(): Macro[] {
    return [...this.items.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string): Macro | undefined {
    return this.items.get(id);
  }
  put(m: Macro): void {
    m.updatedAt = Date.now();
    this.items.set(m.id, m);
    this.save();
  }
  delete(id: string): void {
    if (this.items.delete(id)) this.save();
  }
}

// ─────────────────────────────── ตัวบันทึก ───────────────────────────────

interface PendingTouch {
  fx: number;
  fy: number;
  at: number;
}

export class MacroRecorder {
  private macro: Macro | null = null;
  private startedAt = 0;
  private pending = new Map<number, PendingTouch>();

  get active(): { serial: string; steps: number } | null {
    return this.macro ? { serial: this.macro.recordedOn.serial, steps: this.macro.steps.length } : null;
  }

  start(serial: string, name: string, screen: { width: number; height: number }): void {
    this.macro = {
      id: crypto.randomUUID(),
      name: name.trim() || `มาโคร ${new Date().toLocaleString('th-TH')}`,
      recordedOn: { serial, width: screen.width, height: screen.height },
      steps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.startedAt = Date.now();
    this.pending.clear();
  }

  private now(): number {
    return Date.now() - this.startedAt;
  }

  /**
   * รับ touch ดิบแล้วรวบเป็น tap หรือ swipe
   * เก็บเฉพาะ down กับ up — move ระหว่างทางไม่จำเป็นสำหรับการเล่นซ้ำ
   */
  onTouch(input: TouchInput): void {
    if (!this.macro || input.serial !== this.macro.recordedOn.serial) return;
    const fx = input.x / input.screenW;
    const fy = input.y / input.screenH;

    if (input.action === TOUCH_ACTION.DOWN) {
      this.pending.set(input.pointerId, { fx, fy, at: this.now() });
      return;
    }
    if (input.action !== TOUCH_ACTION.UP && input.action !== TOUCH_ACTION.CANCEL) return;

    const down = this.pending.get(input.pointerId);
    this.pending.delete(input.pointerId);
    if (!down || input.action === TOUCH_ACTION.CANCEL) return;

    const dist = Math.hypot(fx - down.fx, fy - down.fy);
    const duration = this.now() - down.at;
    // ขยับน้อยกว่า 2% ของจอ = แตะ ไม่ใช่ปัด
    if (dist < 0.02) {
      this.macro.steps.push({
        t: 'tap',
        fx: down.fx,
        fy: down.fy,
        holdMs: duration > 350 ? duration : undefined,
        atMs: down.at,
      });
    } else {
      this.macro.steps.push({
        t: 'swipe',
        fx1: down.fx,
        fy1: down.fy,
        fx2: fx,
        fy2: fy,
        durationMs: Math.max(80, duration),
        atMs: down.at,
      });
    }
  }

  onKey(serial: string, action: number, keycode: number): void {
    if (!this.macro || serial !== this.macro.recordedOn.serial) return;
    if (action !== KEY_ACTION.DOWN) return; // เก็บครั้งเดียวต่อปุ่ม
    this.macro.steps.push({ t: 'key', keycode, atMs: this.now() });
  }

  stop(): Macro | null {
    const m = this.macro;
    this.macro = null;
    this.pending.clear();
    return m;
  }
}

// ─────────────────────────────── ตัวเล่น ───────────────────────────────

export interface PlayerDeps {
  adb: AdbClient;
  /** ส่งข้อความควบคุมไปเครื่อง — false ถ้าเครื่องนั้นไม่มีเซสชัน */
  send: (serial: string, message: Buffer) => boolean;
  screenSize: (serial: string) => { width: number; height: number } | null;
}

/** ช่องว่างระหว่างขั้นตอนที่บันทึกไว้ยาวเกินนี้ให้ตัดเหลือเท่านี้ — ไม่มีใครอยากรอคนบันทึกไปเข้าห้องน้ำ */
const MAX_GAP_MS = 15_000;

export class MacroPlayer extends EventEmitter {
  private cancelled = false;
  private state: MacroRunState = { running: false, serials: [], progress: {}, loopsTotal: 1 };

  constructor(
    private deps: PlayerDeps,
    private log: Log,
  ) {
    super();
  }

  current(): MacroRunState {
    return this.state;
  }

  private emitState(): void {
    this.emit('state', this.state);
  }

  stop(): void {
    this.cancelled = true;
  }

  /** เล่นมาโครเดียวกันไปทุกเครื่องพร้อมกัน แต่ละเครื่องเดินอิสระ ตัวหนึ่งพังไม่ลากตัวอื่น */
  async play(macro: Macro, serials: string[], loops = 1): Promise<{ ok: boolean; message: string }> {
    if (this.state.running) return { ok: false, message: 'มีมาโครกำลังเล่นอยู่' };
    const targets = serials.filter((s) => this.deps.screenSize(s) !== null);
    if (targets.length === 0) return { ok: false, message: 'ไม่มีเครื่องที่เปิดเซสชันอยู่ในรายการที่เลือก' };

    this.cancelled = false;
    this.state = {
      running: true,
      macroId: macro.id,
      macroName: macro.name,
      serials: targets,
      loopsTotal: loops,
      progress: Object.fromEntries(targets.map((s) => [s, { step: 0, total: macro.steps.length, loop: 1 }])),
    };
    this.emitState();
    this.log('info', `เล่น "${macro.name}" บน ${targets.length} เครื่อง ${loops} รอบ`);

    await Promise.all(targets.map((serial) => this.playOn(macro, serial, loops)));

    const failed = Object.entries(this.state.progress).filter(([, p]) => p.error).length;
    this.state = { ...this.state, running: false };
    this.emitState();
    const message = this.cancelled
      ? 'หยุดกลางคัน'
      : failed
        ? `เสร็จ แต่ล้มเหลว ${failed}/${targets.length} เครื่อง`
        : `เสร็จครบ ${targets.length} เครื่อง`;
    this.log(failed ? 'warn' : 'info', message);
    return { ok: !failed && !this.cancelled, message };
  }

  private async playOn(macro: Macro, serial: string, loops: number): Promise<void> {
    try {
      for (let loop = 1; loop <= loops && !this.cancelled; loop++) {
        let prevAt = 0;
        for (let i = 0; i < macro.steps.length && !this.cancelled; i++) {
          const step = macro.steps[i];
          const gap = Math.min(Math.max(0, step.atMs - prevAt), MAX_GAP_MS);
          prevAt = step.atMs;
          if (gap > 0) await sleep(gap);
          await this.runStep(serial, step);
          this.state.progress[serial] = { step: i + 1, total: macro.steps.length, loop };
          this.emitState();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.progress[serial] = { ...this.state.progress[serial], error: message };
      this.log('error', `${serial}: ${message}`);
      this.emitState();
    }
  }

  private async runStep(serial: string, step: MacroStep): Promise<void> {
    const screen = this.deps.screenSize(serial);
    if (!screen) throw new Error('เซสชันของเครื่องนี้ปิดไปแล้ว');

    switch (step.t) {
      case 'tap':
        await this.tap(serial, step.fx * screen.width, step.fy * screen.height, screen, step.holdMs ?? 60);
        return;
      case 'swipe': {
        const from = { x: step.fx1 * screen.width, y: step.fy1 * screen.height };
        const to = { x: step.fx2 * screen.width, y: step.fy2 * screen.height };
        this.touch(serial, TOUCH_ACTION.DOWN, from.x, from.y, screen);
        const frames = Math.max(4, Math.round(step.durationMs / 16));
        for (let f = 1; f <= frames; f++) {
          await sleep(step.durationMs / frames);
          const k = f / frames;
          this.touch(serial, TOUCH_ACTION.MOVE, from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, screen);
        }
        this.touch(serial, TOUCH_ACTION.UP, to.x, to.y, screen);
        return;
      }
      case 'key':
        this.sendOrThrow(serial, encodeKeycode(KEY_ACTION.DOWN, step.keycode));
        await sleep(40);
        this.sendOrThrow(serial, encodeKeycode(KEY_ACTION.UP, step.keycode));
        return;
      case 'text':
        this.sendOrThrow(serial, encodeText(step.value));
        return;
      case 'wait':
        await sleep(step.ms);
        return;
      case 'launch':
        await this.deps.adb.exec(serial, `monkey -p ${step.packageName} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`);
        return;
      case 'find_tap': {
        const deadline = Date.now() + (step.timeoutMs ?? 5000);
        // หาไม่เจอทันทีไม่ใช่ล้มเหลว — หน้าจออาจกำลังโหลด ลองซ้ำจนหมดเวลา
        for (;;) {
          const nodes = await dumpUi(this.deps.adb, serial).catch(() => []);
          const found = locate(nodes, step.selector, screen);
          if (found && (found.via !== 'fallback' || Date.now() >= deadline)) {
            if (found.via === 'fallback') this.log('warn', `${serial}: หา element ไม่เจอ ใช้พิกัดสำรอง`);
            await this.tap(serial, found.x, found.y, screen, 60);
            return;
          }
          if (Date.now() >= deadline) throw new Error(`หา element ไม่เจอ: ${describe(step.selector)}`);
          await sleep(400);
        }
      }
    }
  }

  private async tap(serial: string, x: number, y: number, screen: { width: number; height: number }, holdMs: number): Promise<void> {
    this.touch(serial, TOUCH_ACTION.DOWN, x, y, screen);
    await sleep(holdMs);
    this.touch(serial, TOUCH_ACTION.UP, x, y, screen);
  }

  /** ส่ง screenW/H เท่าจอจริง ฝั่งมือถือจะได้ไม่ต้องสเกล */
  private touch(serial: string, action: number, x: number, y: number, screen: { width: number; height: number }): void {
    this.sendOrThrow(
      serial,
      encodeTouch({ action, pointerId: 0n, x, y, screenW: screen.width, screenH: screen.height, pressure: 1 }),
    );
  }

  private sendOrThrow(serial: string, message: Buffer): void {
    if (!this.deps.send(serial, message)) throw new Error('ช่องควบคุมของเครื่องนี้ปิดอยู่');
  }
}

function describe(s: UiSelector): string {
  return s.resourceId ?? s.text ?? s.contentDesc ?? s.className ?? 'พิกัด';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
