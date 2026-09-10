/**
 * มาโคร: เก็บ · บันทึก · เล่นซ้ำไปหลายเครื่องพร้อมกัน
 *
 * บันทึกจาก**ฝั่ง PC** — ทุก touch/key ที่ผู้ใช้ทำผ่านแอปไหลผ่านที่นี่อยู่แล้ว
 * จึงไม่ต้องมีอะไรบนมือถือเพิ่ม พิกัดเก็บเป็นสัดส่วนของจอ เล่นซ้ำบนจอต่างขนาดได้
 *
 * v2: ตัวแปร + โปรไฟล์ต่อเครื่อง · label/goto/if · หาภาพ · OCR · เสียง · humanize · นโยบายเมื่อพัง
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AdbClient } from '../adb/AdbClient';
import type { TouchInput } from '../../shared/api';
import type { Macro, MacroRunLogEntry, MacroRunState, MacroStep, UiSelector, VolumeStream } from '../../shared/automation';
import { TOUCH_ACTION, KEY_ACTION, encodeKeycode, encodeText, encodeTouch } from '../server/messages';
import { dumpUi, locate } from './UiDump';
import type { Frame } from '../vision/capture';
import { findTemplate, scoreTemplate } from '../vision/match';
import type { TemplateStore } from '../vision/templates';
import type { Ocr } from '../vision/ocr';
import { interpolate, type ProfileStore } from './Profiles';

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
  templates: TemplateStore;
  /** จับภาพหน้าจอ (ฝั่งเรียกแคชสั้นๆ ให้ เพื่อให้หลาย step ใช้เฟรมเดียวกันได้) */
  capture: (serial: string) => Promise<Frame>;
  ocr: Ocr;
  profiles: ProfileStore;
  getMacro: (id: string) => Macro | undefined;
  setVolume: (serial: string, stream: VolumeStream, percent: number) => Promise<{ ok: boolean; via: string }>;
}

/** ช่องว่างระหว่างขั้นตอนที่บันทึกไว้ยาวเกินนี้ให้ตัดเหลือเท่านี้ — ไม่มีใครอยากรอคนบันทึกไปเข้าห้องน้ำ */
const MAX_GAP_MS = 15_000;
const MAX_LOG = 300;
const MAX_DEPTH = 5;
const DEFAULT_GOTO_LIMIT = 100;

interface RunCtx {
  serial: string;
  vars: Record<string, string>;
  depth: number;
  /** กันวนไม่รู้จบ — นับต่อ goto แต่ละตัว */
  gotoCount: Map<string, number>;
  templateSet?: string;
  humanize?: Macro['humanize'];
  onError: NonNullable<Macro['onError']>;
}

interface StepOutcome {
  jump?: number;
  stop?: 'ok' | 'fail';
  message?: string;
}

export class MacroPlayer extends EventEmitter {
  private cancelled = false;
  private state: MacroRunState = { running: false, serials: [], progress: {}, loopsTotal: 1, log: [] };

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

  /** บันทึกแยกเครื่อง — ผู้ใช้ดูได้ว่าเครื่องไหนทำอะไรอยู่/พังตรงไหน */
  private note(serial: string, level: MacroRunLogEntry['level'], message: string): void {
    this.state.log.push({ serial, at: Date.now(), level, message });
    if (this.state.log.length > MAX_LOG) this.state.log.splice(0, this.state.log.length - MAX_LOG);
    if (this.state.progress[serial]) this.state.progress[serial].note = message;
    if (level !== 'info') this.log(level, `${serial}: ${message}`);
    this.emitState();
  }

  /** เล่นมาโครเดียวกันไปทุกเครื่องพร้อมกัน แต่ละเครื่องเดินอิสระ ตัวหนึ่งพังไม่ลากตัวอื่น */
  async play(macro: Macro, serials: string[], loops = 1): Promise<{ ok: boolean; message: string }> {
    if (this.state.running) return { ok: false, message: 'มีมาโครกำลังเล่นอยู่' };
    const targets = serials.filter((s) => this.deps.screenSize(s) !== null && this.deps.profiles.get(s)?.enabled !== false);
    if (targets.length === 0) return { ok: false, message: 'ไม่มีเครื่องที่เปิดเซสชันอยู่ (หรือทุกเครื่องถูกปิดในโปรไฟล์)' };

    this.cancelled = false;
    this.state = {
      running: true,
      macroId: macro.id,
      macroName: macro.name,
      serials: targets,
      loopsTotal: loops,
      progress: Object.fromEntries(targets.map((s) => [s, { step: 0, total: macro.steps.length, loop: 1 }])),
      log: [],
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
    const profile = this.deps.profiles.get(serial);
    const ctx: RunCtx = {
      serial,
      // ลำดับทับ: ค่าเริ่มต้นของมาโคร < โปรไฟล์เครื่อง < set_var ระหว่างเล่น
      vars: { serial, ...(macro.vars ?? {}), ...(profile?.vars ?? {}) },
      depth: 0,
      gotoCount: new Map(),
      templateSet: macro.templateSet,
      humanize: macro.humanize,
      onError: macro.onError ?? { mode: 'stop' },
    };
    this.state.progress[serial].vars = ctx.vars;

    try {
      // เสียงตามโปรไฟล์ก่อนเริ่ม — เครื่องไหนอยากเงียบก็เงียบ
      for (const [stream, pct] of Object.entries(profile?.volume ?? {})) {
        if (typeof pct !== 'number') continue;
        const r = await this.deps.setVolume(serial, stream as VolumeStream, pct);
        this.note(serial, r.ok ? 'info' : 'warn', r.ok ? `ตั้งเสียง ${stream} ${pct}% (${r.via})` : `ตั้งเสียง ${stream} ไม่ได้`);
      }

      for (let loop = 1; loop <= loops && !this.cancelled; loop++) {
        ctx.vars.loop = String(loop);
        this.state.progress[serial].loop = loop;
        const outcome = await this.runSteps(macro, ctx, loop);
        if (outcome === 'stopped') break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.progress[serial] = { ...this.state.progress[serial], error: message };
      this.note(serial, 'error', message);
    }
  }

  /** เดินขั้นตอนของมาโครหนึ่งตัว (ใช้ซ้ำสำหรับ run_macro) — คืน 'stopped' เมื่อเจอ step stop */
  private async runSteps(macro: Macro, ctx: RunCtx, loop: number): Promise<'done' | 'stopped'> {
    const labels = new Map<string, number>();
    macro.steps.forEach((s, i) => {
      if (s.t === 'label') labels.set(s.name, i);
    });

    let prevAt = 0;
    for (let i = 0; i < macro.steps.length && !this.cancelled; ) {
      const step = macro.steps[i];
      // จังหวะตามที่บันทึก (ขั้นที่เพิ่มมือมี atMs=0 → ไม่รอ)
      const gap = Math.min(Math.max(0, step.atMs - prevAt), MAX_GAP_MS);
      prevAt = Math.max(prevAt, step.atMs);
      if (gap > 0) await sleep(gap);
      if (ctx.humanize) {
        const [lo, hi] = ctx.humanize.delayMs;
        await sleep(lo + Math.random() * Math.max(0, hi - lo));
      }

      let outcome: StepOutcome = {};
      let attempt = 0;
      for (;;) {
        try {
          outcome = await this.runStep(ctx, step, labels, i, macro.id);
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const policy = ctx.onError;
          if (policy.mode === 'retry' && attempt < (policy.retries ?? 2)) {
            attempt++;
            this.note(ctx.serial, 'warn', `ขั้น ${i + 1} พัง (${message}) ลองใหม่ ${attempt}/${policy.retries ?? 2}`);
            await sleep(600);
            continue;
          }
          if (policy.mode === 'skip') {
            this.note(ctx.serial, 'warn', `ข้ามขั้น ${i + 1}: ${message}`);
            outcome = {};
            break;
          }
          throw new Error(`ขั้น ${i + 1} (${step.t}): ${message}`);
        }
      }

      if (ctx.depth === 0) {
        this.state.progress[ctx.serial] = { ...this.state.progress[ctx.serial], step: i + 1, total: macro.steps.length, loop, vars: ctx.vars };
        this.emitState();
      }
      if (outcome.stop === 'fail') throw new Error(outcome.message ?? 'มาโครสั่งล้มเหลว');
      if (outcome.stop === 'ok') {
        if (outcome.message) this.note(ctx.serial, 'info', outcome.message);
        return 'stopped';
      }
      i = outcome.jump ?? i + 1;
    }
    return 'done';
  }

  private resolveTemplate(ctx: RunCtx, ref: string): { set: string; name: string } {
    const r = interpolate(ref, ctx.vars);
    const slash = r.indexOf('/');
    if (slash > 0) return { set: r.slice(0, slash), name: r.slice(slash + 1) };
    if (!ctx.templateSet) throw new Error(`มาโครนี้ยังไม่ได้ระบุชุดเทมเพลต (ใช้ "ชุด/${r}" หรือตั้งชุดในมาโคร)`);
    return { set: ctx.templateSet, name: r };
  }

  private jumpTo(labels: Map<string, number>, label: string, ctx: RunCtx): number {
    const target = labels.get(interpolate(label, ctx.vars));
    if (target === undefined) throw new Error(`ไม่มี label "${label}"`);
    return target;
  }

  private async runStep(ctx: RunCtx, step: MacroStep, labels: Map<string, number>, index: number, macroId: string): Promise<StepOutcome> {
    const { serial } = ctx;
    const screen = this.deps.screenSize(serial);
    if (!screen) throw new Error('เซสชันของเครื่องนี้ปิดไปแล้ว');
    const v = (s: string): string => interpolate(s, ctx.vars);

    switch (step.t) {
      case 'tap':
        await this.tapFrac(ctx, step.fx, step.fy, screen, step.holdMs ?? 60);
        return {};
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
        return {};
      }
      case 'key':
        this.sendOrThrow(serial, encodeKeycode(KEY_ACTION.DOWN, step.keycode));
        await sleep(40);
        this.sendOrThrow(serial, encodeKeycode(KEY_ACTION.UP, step.keycode));
        return {};
      case 'text':
        this.sendOrThrow(serial, encodeText(v(step.value)));
        return {};
      case 'wait':
        await sleep(step.ms);
        return {};
      case 'launch':
        await this.deps.adb.exec(serial, `monkey -p ${v(step.packageName)} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`);
        return {};
      case 'open_url': {
        // เชลล์บนเครื่องตีความ & ใน URL — ต้องครอบ single quote
        // application_id = ให้ Chrome ใช้แท็บเดิม ไม่เปิดแท็บใหม่ทุกครั้ง (ไม่งั้นวันละหลายสิบแท็บ เครื่องช้าลงเรื่อยๆ)
        const url = v(step.url).replace(/'/g, "'\\''");
        await this.deps.adb.exec(
          serial,
          `am start -a android.intent.action.VIEW -d '${url}' --es com.android.browser.application_id com.android.chrome >/dev/null 2>&1`,
        );
        return {};
      }
      case 'set_var':
        ctx.vars[step.name] = v(step.value);
        return {};
      case 'find_tap': {
        const deadline = Date.now() + (step.timeoutMs ?? 5000);
        // หาไม่เจอทันทีไม่ใช่ล้มเหลว — หน้าจออาจกำลังโหลด ลองซ้ำจนหมดเวลา
        for (;;) {
          const nodes = await dumpUi(this.deps.adb, serial).catch(() => []);
          const found = locate(nodes, step.selector, screen);
          if (found && (found.via !== 'fallback' || Date.now() >= deadline)) {
            if (found.via === 'fallback') this.note(serial, 'warn', `หา element ไม่เจอ ใช้พิกัดสำรอง`);
            await this.tap(serial, found.x, found.y, screen, 60);
            return {};
          }
          if (Date.now() >= deadline) throw new Error(`หา element ไม่เจอ: ${describe(step.selector)}`);
          await sleep(400);
        }
      }
      case 'find_image_tap': {
        const { set, name } = this.resolveTemplate(ctx, step.template);
        const tpl = await this.deps.templates.load(set, name);
        const deadline = Date.now() + (step.timeoutMs ?? 8000);
        for (;;) {
          const frame = await this.deps.capture(serial);
          const hit = await findTemplate(frame, tpl, { threshold: step.threshold });
          if (hit) {
            const fx = hit.fx + (step.offset?.dx ?? 0);
            const fy = hit.fy + (step.offset?.dy ?? 0);
            this.note(serial, 'info', `เจอ "${name}" ${Math.round(hit.score * 100)}% → แตะ`);
            await this.tapFrac(ctx, fx, fy, screen, 60);
            return {};
          }
          if (Date.now() >= deadline) {
            const best = await scoreTemplate(frame, tpl);
            throw new Error(`หาภาพ "${name}" ไม่เจอ (ใกล้สุด ${Math.round((best?.score ?? 0) * 100)}%)`);
          }
          await sleep(500);
        }
      }
      case 'wait_image': {
        const { set, name } = this.resolveTemplate(ctx, step.template);
        const tpl = await this.deps.templates.load(set, name);
        const deadline = Date.now() + step.timeoutMs;
        for (;;) {
          const frame = await this.deps.capture(serial);
          const hit = await findTemplate(frame, tpl, { threshold: step.threshold });
          if (Boolean(hit) === step.appear) return {};
          if (Date.now() >= deadline) throw new Error(`รอภาพ "${name}" ${step.appear ? 'ปรากฏ' : 'หายไป'} ไม่ทันเวลา`);
          await sleep(500);
        }
      }
      case 'if_image': {
        const { set, name } = this.resolveTemplate(ctx, step.template);
        const tpl = await this.deps.templates.load(set, name);
        const frame = await this.deps.capture(serial);
        const hit = await findTemplate(frame, tpl, { threshold: step.threshold });
        if (Boolean(hit) === step.found) {
          this.note(serial, 'info', `${step.found ? 'เจอ' : 'ไม่เจอ'} "${name}" → ไป ${step.goto}`);
          return { jump: this.jumpTo(labels, step.goto, ctx) };
        }
        return {};
      }
      case 'if_text': {
        const frame = await this.deps.capture(serial);
        const r = await this.deps.ocr.read(frame, step.rect, { digits: step.digits });
        const matched = textMatches(r.text, v(step.match));
        this.note(serial, 'info', `อ่านได้ "${r.text}" ${matched ? 'ตรง' : 'ไม่ตรง'} "${step.match}"`);
        if (matched === step.found) return { jump: this.jumpTo(labels, step.goto, ctx) };
        return {};
      }
      case 'if_var': {
        const a = ctx.vars[step.name] ?? '';
        const b = v(step.value ?? '');
        const num = (s: string): number => parseFloat(s.replace(/[^0-9.\-]/g, ''));
        let ok = false;
        switch (step.op) {
          case 'eq':
            ok = a === b;
            break;
          case 'ne':
            ok = a !== b;
            break;
          case 'lt':
            ok = num(a) < num(b);
            break;
          case 'gt':
            ok = num(a) > num(b);
            break;
          case 'empty':
            ok = a.trim() === '';
            break;
          case 'notempty':
            ok = a.trim() !== '';
            break;
          case 'contains':
            ok = a.toLowerCase().includes(b.toLowerCase());
            break;
        }
        if (ok) return { jump: this.jumpTo(labels, step.goto, ctx) };
        return {};
      }
      case 'ocr_var': {
        const frame = await this.deps.capture(serial);
        const r = await this.deps.ocr.read(frame, step.rect, { digits: step.digits });
        ctx.vars[step.name] = step.digits ? r.text.replace(/[^0-9./:,\-+%]/g, '') : r.text;
        this.note(serial, 'info', `${step.name} = "${ctx.vars[step.name]}" (มั่นใจ ${r.confidence}%, ${r.tookMs}ms)`);
        return {};
      }
      case 'label':
        return {};
      case 'goto': {
        const key = `${macroId}:${index}`;
        const n = (ctx.gotoCount.get(key) ?? 0) + 1;
        ctx.gotoCount.set(key, n);
        const limit = step.maxTimes ?? DEFAULT_GOTO_LIMIT;
        if (n > limit) throw new Error(`goto "${step.label}" วนเกิน ${limit} ครั้ง`);
        return { jump: this.jumpTo(labels, step.label, ctx) };
      }
      case 'run_macro': {
        if (ctx.depth >= MAX_DEPTH) throw new Error('เรียกมาโครซ้อนกันลึกเกินไป');
        const sub = this.deps.getMacro(step.macroId);
        if (!sub) throw new Error('ไม่พบมาโครย่อยที่เรียก');
        this.note(serial, 'info', `→ รูทีน "${sub.name}"`);
        // stop ในรูทีนย่อย = จบรูทีนนั้น ไม่จบแม่
        await this.runSteps(
          sub,
          {
            ...ctx,
            depth: ctx.depth + 1,
            templateSet: sub.templateSet ?? ctx.templateSet,
            humanize: sub.humanize ?? ctx.humanize,
            onError: sub.onError ?? ctx.onError,
          },
          1,
        );
        return {};
      }
      case 'volume': {
        const r = await this.deps.setVolume(serial, step.stream, step.percent);
        if (!r.ok) throw new Error(`ตั้งเสียง ${step.stream} ไม่ได้`);
        this.note(serial, 'info', `เสียง ${step.stream} = ${step.percent}% (${r.via})`);
        return {};
      }
      case 'stop':
        return { stop: 'ok', message: step.message ? v(step.message) : undefined };
      case 'fail':
        return { stop: 'fail', message: step.message ? v(step.message) : 'มาโครสั่งล้มเหลว' };
    }
  }

  /** แตะแบบพิกัดสัดส่วน + เขย่าเล็กน้อยถ้าเปิด humanize */
  private async tapFrac(ctx: RunCtx, fx: number, fy: number, screen: { width: number; height: number }, holdMs: number): Promise<void> {
    const j = ctx.humanize?.jitter ?? 0;
    const x = Math.min(1, Math.max(0, fx + (Math.random() * 2 - 1) * j)) * screen.width;
    const y = Math.min(1, Math.max(0, fy + (Math.random() * 2 - 1) * j)) * screen.height;
    await this.tap(ctx.serial, x, y, screen, holdMs + (j ? Math.round(Math.random() * 40) : 0));
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

/** เทียบข้อความจาก OCR: /regex/ หรือ substring ไม่สนตัวพิมพ์ */
export function textMatches(text: string, pattern: string): boolean {
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern.trim());
  if (m) {
    try {
      return new RegExp(m[1], m[2]).test(text);
    } catch {
      return false;
    }
  }
  return text.toLowerCase().includes(pattern.trim().toLowerCase());
}

function describe(s: UiSelector): string {
  return s.resourceId ?? s.text ?? s.contentDesc ?? s.className ?? 'พิกัด';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
