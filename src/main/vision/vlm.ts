/**
 * ตา AI — ให้โมเดลภาพ (VLM) ผ่าน Ollama ดูจอแล้วบอกว่า "นี่หน้าอะไร มีปุ่มอะไร อยู่ตรงไหน"
 *
 * ใช้เมื่อเทมเพลต/OCR ไม่พอ: หน้าใหม่ที่ยังไม่มีเทมเพลต ปุ่มที่บรรยายด้วยคำพูดได้ ("ปุ่มปิด X มุมขวาบน")
 * ช้า (5-20 วิ/คำถามบน GTX 1070 Ti) จึงต้องคู่กับแค็ตตาล็อกหน้าจอ (catalog.ts) ที่จำคำตอบไว้ตาม dHash
 * — หน้าที่เคยเห็นแล้วไม่ถามซ้ำ
 *
 * ทดสอบจริงกับ qwen3-vl:4b (Ollama 0.17.1, 2026-09-10):
 * 🔑 พิกัดที่โมเดลตอบเป็น **0-1000 normalized** ไม่ใช่พิกเซล ไม่ว่าส่งภาพกว้างเท่าไร (เทียบกับ uiautomator แล้วตรง)
 * 🔑 โมเดลเป็นสาย thinking และ `think:false` ของ API **ไม่ทำงาน** (ยังคิด 600-6000 ตัวอักษรจนชน num_predict
 *    แล้วคำตอบว่าง) — วิธีที่ได้ผล: เติมข้อความ assistant `<think>\n\n</think>\n\n` นำหน้า (prefill)
 *    ผลลัพธ์ 105 วิ → 12 วิ และได้ JSON ครบ
 * 🔑 ครั้งแรกหลังเปิด Ollama ต้องโหลดโมเดลเข้า VRAM (~50 วิ) — timeout ต้องเผื่อ และไม่อุ่นเครื่องตอนเปิดแอป
 *    (แย่ง VRAM กับเกม/งานอื่นของผู้ใช้) อุ่นเฉพาะตอนจะใช้จริง
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Frame } from './capture';
import type { FracRect, ScreenElement, VlmSettings, VlmStatus } from '../../shared/automation';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

export const DEFAULT_VLM: VlmSettings = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3-vl:4b',
  imageWidth: 540,
  timeoutMs: 120_000,
};

const KEEP_ALIVE = '30m';
/** ข้อความ assistant ที่เติมนำหน้าเพื่อข้ามช่วงคิดของโมเดลสาย thinking */
const NO_THINK_PREFILL = '<think>\n\n</think>\n\n';

interface ChatResponse {
  message?: { content?: string; thinking?: string };
  eval_count?: number;
  prompt_eval_count?: number;
  error?: string;
}

export interface VlmAnswer {
  text: string;
  tookMs: number;
  outTokens: number;
}

export class VlmClient {
  private cfg: VlmSettings;
  /** คิวคำขอ — GPU เดียว ยิงพร้อมกันหลายเครื่องแล้วโมเดลสลับกันช้ากว่าเข้าคิว */
  private queue: Promise<unknown> = Promise.resolve();
  private thinkingCache = new Map<string, boolean>();

  constructor(
    private file: string,
    private log: Log,
  ) {
    this.cfg = { ...DEFAULT_VLM };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<VlmSettings>;
      this.cfg = { ...DEFAULT_VLM, ...raw };
    } catch {
      // ยังไม่มีไฟล์ — ใช้ค่าเริ่มต้น
    }
  }

  settings(): VlmSettings {
    return { ...this.cfg };
  }

  update(patch: Partial<VlmSettings>): void {
    const next: VlmSettings = { ...this.cfg };
    if (patch.baseUrl?.trim()) next.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '');
    if (patch.model?.trim()) next.model = patch.model.trim();
    if (typeof patch.imageWidth === 'number' && patch.imageWidth >= 240 && patch.imageWidth <= 1600) next.imageWidth = Math.round(patch.imageWidth);
    if (typeof patch.timeoutMs === 'number' && patch.timeoutMs >= 10_000) next.timeoutMs = Math.round(patch.timeoutMs);
    this.cfg = next;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.cfg, null, 2), 'utf8');
    } catch {
      // เขียนไม่ได้ก็ยังใช้ในรอบนี้ได้
    }
  }

  /** Ollama รันอยู่ไหม มีโมเดลที่ตั้งไว้ไหม — คำขอเบาๆ ไม่โหลดโมเดล */
  async status(): Promise<VlmStatus> {
    const base = { settings: this.settings(), models: [] as string[] };
    let tags: { models?: Array<{ name: string }> };
    try {
      const res = await fetch(`${this.cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      tags = (await res.json()) as { models?: Array<{ name: string }> };
    } catch {
      return { ...base, ok: false, message: `ต่อ Ollama ที่ ${this.cfg.baseUrl} ไม่ได้ — เปิด Ollama ก่อน` };
    }
    const models = (tags.models ?? []).map((m) => m.name).sort();
    const have = models.includes(this.cfg.model) || models.includes(`${this.cfg.model}:latest`);
    if (!have) {
      return { ...base, models, ok: false, message: `ยังไม่มีโมเดล ${this.cfg.model} — รัน ollama pull ${this.cfg.model}` };
    }
    const thinking = await this.isThinking(this.cfg.model);
    return { ...base, models, ok: true, thinking, message: `พร้อม: ${this.cfg.model}${thinking ? ' (สาย thinking — ปิดให้แล้ว)' : ''}` };
  }

  /** โมเดลนี้มีความสามารถ thinking ไหม — ถ้ามีต้อง prefill ปิด ไม่งั้นช้าและคำตอบว่าง */
  private async isThinking(model: string): Promise<boolean> {
    const hit = this.thinkingCache.get(model);
    if (hit !== undefined) return hit;
    try {
      const res = await fetch(`${this.cfg.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(5000),
      });
      const j = (await res.json()) as { capabilities?: string[] };
      const t = (j.capabilities ?? []).includes('thinking');
      this.thinkingCache.set(model, t);
      return t;
    } catch {
      return false;
    }
  }

  /** ภาพย่อ JPEG สำหรับส่งให้โมเดล + ขนาดที่ส่งจริง (ไว้แปลงพิกัดถ้าโมเดลตอบเป็นพิกเซล) */
  private async prepare(frame: Frame): Promise<{ image: Buffer; w: number; h: number }> {
    const w = Math.min(this.cfg.imageWidth, frame.width);
    const h = Math.max(1, Math.round((frame.height * w) / frame.width));
    const image = await sharp(frame.png).resize(w, h, { fit: 'fill' }).jpeg({ quality: 85 }).toBuffer();
    return { image, w, h };
  }

  /** ส่งภาพ + คำถาม (เข้าคิว, timeout, ปิด thinking) */
  private chat(image: Buffer, prompt: string, opts: { format?: unknown; maxTokens?: number } = {}): Promise<VlmAnswer> {
    const run = async (): Promise<VlmAnswer> => {
      const started = Date.now();
      const thinking = await this.isThinking(this.cfg.model);
      const messages: Array<{ role: string; content: string; images?: string[] }> = [{ role: 'user', content: prompt, images: [image.toString('base64')] }];
      if (thinking) messages.push({ role: 'assistant', content: NO_THINK_PREFILL });

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
      try {
        const res = await fetch(`${this.cfg.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify({
            model: this.cfg.model,
            stream: false,
            keep_alive: KEEP_ALIVE,
            think: false,
            options: { temperature: 0, num_predict: opts.maxTokens ?? 300 },
            ...(opts.format ? { format: opts.format } : {}),
            messages,
          }),
        });
        const j = (await res.json()) as ChatResponse;
        if (j.error) throw new Error(j.error);
        const text = (j.message?.content ?? '').trim();
        const tookMs = Date.now() - started;
        if (!text && j.message?.thinking) {
          throw new Error(`โมเดลใช้เวลาคิดจนหมดโควตา (${j.eval_count ?? 0} token) ไม่ได้คำตอบ — ลองโมเดลสาย instruct`);
        }
        return { text, tookMs, outTokens: j.eval_count ?? 0 };
      } catch (err) {
        if (ctrl.signal.aborted) throw new Error(`โมเดลภาพไม่ตอบใน ${Math.round(this.cfg.timeoutMs / 1000)} วิ (ครั้งแรกต้องโหลดโมเดลเข้า VRAM ก่อน ลองใหม่)`);
        if (err instanceof TypeError) throw new Error(`ต่อ Ollama ที่ ${this.cfg.baseUrl} ไม่ได้ — เปิด Ollama ก่อน`);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** โหลดโมเดลเข้า VRAM ล่วงหน้า (ไม่บังคับ) — เรียกตอนผู้ใช้กำลังจะใช้ ไม่ใช่ตอนเปิดแอป */
  warmUp(): void {
    void fetch(`${this.cfg.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.cfg.model, keep_alive: KEEP_ALIVE }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    }).catch(() => {});
  }

  /** หาตำแหน่งสิ่งที่บรรยายด้วยคำพูด */
  async locate(frame: Frame, query: string): Promise<{ found: boolean; rect?: FracRect; label?: string; tookMs: number }> {
    const { image, w, h } = await this.prepare(frame);
    const prompt =
      `Find the element described as "${query}" on this Android screenshot. ` +
      'Reply ONLY with JSON: {"found": true, "bbox": [x1, y1, x2, y2], "label": "short name of what you found"} ' +
      'with bbox normalized to 0-1000 (0,0 = top-left, 1000,1000 = bottom-right). ' +
      'If it is not visible on this screen, reply {"found": false}.';
    const r = await this.chat(image, prompt, { format: 'json', maxTokens: 120 });
    const j = parseJson(r.text) as { found?: boolean; bbox?: unknown; label?: string } | null;
    const rect = j?.found ? bboxToRect(j.bbox, w, h) : null;
    if (!j) this.log('warn', `โมเดลตอบไม่เป็น JSON: ${r.text.slice(0, 120)}`);
    return { found: Boolean(rect), rect: rect ?? undefined, label: typeof j?.label === 'string' ? j.label : undefined, tookMs: r.tookMs };
  }

  /** ตั้งชื่อหน้า + รายการปุ่มที่กดได้ */
  async describe(frame: Frame): Promise<{ screen: string; elements: ScreenElement[]; tookMs: number }> {
    const { image, w, h } = await this.prepare(frame);
    const prompt =
      'This is an Android screenshot of a game or app. Name this screen in 2-5 words (field "screen", e.g. "main lobby", "shop popup", "battle result"), ' +
      'then list up to 12 tappable elements (buttons, icons, tabs, close X, links) with a short label, a kind (button|icon|tab|close|input|link|text) ' +
      'and bbox [x1, y1, x2, y2] normalized to 0-1000 (0,0 = top-left, 1000,1000 = bottom-right). ' +
      'Reply ONLY with JSON: {"screen": "...", "elements": [{"label": "...", "kind": "...", "bbox": [x1, y1, x2, y2]}]}';
    const schema = {
      type: 'object',
      properties: {
        screen: { type: 'string' },
        elements: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, kind: { type: 'string' }, bbox: { type: 'array', items: { type: 'number' } } },
            required: ['label', 'kind', 'bbox'],
          },
        },
      },
      required: ['screen', 'elements'],
    };
    let r = await this.chat(image, prompt, { format: schema, maxTokens: 900 });
    let j = parseJson(r.text) as { screen?: string; elements?: unknown } | null;
    if (!j) {
      // schema บังคับไม่สำเร็จ (บางรุ่น) — ลองแบบ JSON ธรรมดาอีกครั้ง
      r = await this.chat(image, prompt, { format: 'json', maxTokens: 900 });
      j = parseJson(r.text) as { screen?: string; elements?: unknown } | null;
    }
    if (!j) throw new Error(`โมเดลตอบไม่เป็น JSON: ${r.text.slice(0, 120)}`);
    const elements: ScreenElement[] = [];
    for (const raw of Array.isArray(j.elements) ? j.elements : []) {
      const e = raw as { label?: unknown; kind?: unknown; bbox?: unknown };
      const rect = bboxToRect(e.bbox, w, h);
      const label = typeof e.label === 'string' ? e.label.trim() : '';
      if (!rect || !label) continue;
      // โมเดล (โดยเฉพาะตอนบังคับ schema) ชอบพ่นรายการเดิมซ้ำสองรอบ — ชื่อเดิมตำแหน่งเดิมเก็บครั้งเดียว
      const dup = elements.some(
        (x) => x.label.toLowerCase() === label.toLowerCase() && Math.abs(x.rect.fx + x.rect.fw / 2 - (rect.fx + rect.fw / 2)) < 0.03 && Math.abs(x.rect.fy + x.rect.fh / 2 - (rect.fy + rect.fh / 2)) < 0.03,
      );
      if (dup) continue;
      elements.push({ label, kind: typeof e.kind === 'string' ? e.kind : 'button', rect });
    }
    return { screen: typeof j.screen === 'string' ? j.screen.trim() : '', elements, tookMs: r.tookMs };
  }

  /** ถามอะไรก็ได้เกี่ยวกับจอ ตอบสั้นๆ */
  async answer(frame: Frame, question: string): Promise<{ text: string; tookMs: number }> {
    const { image } = await this.prepare(frame);
    const prompt = `Look at this Android screenshot and answer the question as briefly as possible (a number, a word, or a short phrase). No explanation.\nQuestion: ${question}`;
    const r = await this.chat(image, prompt, { maxTokens: 80 });
    return { text: r.text.replace(/\s+/g, ' ').trim(), tookMs: r.tookMs };
  }
}

/** ดึง JSON ก้อนแรกออกจากคำตอบ (โมเดลบางทีครอบ ```json หรือพ่นคำอธิบายนำหน้า) */
export function parseJson(text: string): unknown {
  const s = text.replace(/```(?:json)?/gi, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/**
 * แปลง bbox ที่โมเดลตอบเป็นกรอบสัดส่วนจอ
 * ปกติ 0-1000 · ถ้าทุกค่า ≤ 1 ถือว่าเป็นสัดส่วนอยู่แล้ว · ถ้าค่าเกิน 1000 ถือว่าเป็นพิกเซลของภาพที่ส่งไป
 */
export function bboxToRect(b: unknown, sentW: number, sentH: number): FracRect | null {
  if (!Array.isArray(b) || b.length < 4) return null;
  const n = b.slice(0, 4).map((x) => Number(x));
  if (n.some((x) => !Number.isFinite(x))) return null;
  const max = Math.max(...n);
  let sx = 1000;
  let sy = 1000;
  if (max <= 1) sx = sy = 1;
  else if (max > 1000) {
    sx = sentW;
    sy = sentH;
  }
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  const x1 = clamp(Math.min(n[0], n[2]) / sx);
  const y1 = clamp(Math.min(n[1], n[3]) / sy);
  const x2 = clamp(Math.max(n[0], n[2]) / sx);
  const y2 = clamp(Math.max(n[1], n[3]) / sy);
  if (x2 - x1 <= 0 && y2 - y1 <= 0) return null;
  return { fx: x1, fy: y1, fw: Math.max(0.002, x2 - x1), fh: Math.max(0.002, y2 - y1) };
}
