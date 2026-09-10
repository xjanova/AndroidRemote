/**
 * อ่านข้อความ/ตัวเลขจากส่วนหนึ่งของเฟรมด้วย tesseract.js (WASM ทำงานบน CPU)
 *
 * เกมมักใช้ตัวอักษรสว่างบนพื้นเข้ม — Tesseract ถนัดตรงข้าม จึงกลับสีให้อัตโนมัติ
 * ขยาย 2-3 เท่าก่อนอ่านเพราะตัวเลขในเกมเล็ก (~20px) ต่ำกว่าที่โมเดลชอบ (~30px+)
 *
 * ครั้งแรกที่ใช้จะโหลดข้อมูลภาษา eng (~10MB) มาเก็บใน cachePath — ต้องมีเน็ตครั้งเดียว
 */

import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import type { Frame } from './capture';
import { rectToPixels } from './capture';
import type { FracRect } from '../../shared/automation';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface OcrResult {
  text: string;
  /** 0..100 */
  confidence: number;
  /** เวลาที่ใช้ (ms) */
  tookMs: number;
}

export class Ocr {
  private worker: Promise<Worker> | null = null;

  constructor(
    private cacheDir: string,
    private log: Log,
  ) {}

  private getWorker(): Promise<Worker> {
    if (!this.worker) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      this.worker = createWorker('eng', 1, {
        cachePath: this.cacheDir,
        // ไม่ให้ tesseract พ่น progress รกล็อก — เอาแค่ error
        logger: () => {},
        errorHandler: (err: unknown) => this.log('warn', `OCR: ${err instanceof Error ? err.message : String(err)}`),
      }).catch((err) => {
        this.worker = null;
        throw new Error(`เริ่ม OCR ไม่ได้ (ครั้งแรกต้องมีเน็ตเพื่อโหลดข้อมูลภาษา): ${err instanceof Error ? err.message : err}`);
      });
    }
    return this.worker;
  }

  /** อุ่นเครื่องล่วงหน้า */
  warmUp(): void {
    void this.getWorker().catch(() => {});
  }

  async read(frame: Frame, rect: FracRect, opts: { digits?: boolean } = {}): Promise<OcrResult> {
    const started = Date.now();
    const r = rectToPixels(rect, frame.width, frame.height);

    // ขยายให้สูงอย่างน้อย ~64px แล้วทำเทา + ปรับคอนทราสต์
    const factor = Math.min(4, Math.max(2, Math.ceil(64 / r.height)));
    const base = sharp(frame.png)
      .extract(r)
      .resize(r.width * factor, r.height * factor, { kernel: 'lanczos3' })
      .grayscale()
      .normalise();

    // 🔑 ห้ามเดาขั้วสีจากความสว่างเฉลี่ย — เกมที่ป๊อปอัปหรี่จอทำให้ภาพ "มืด" แต่กลับสีแล้ว Tesseract อ่านไม่ออกเลย
    //    (ทดสอบจริง: ไม่กลับสีอ่านได้ 69%, กลับสีได้ "") → ลองทั้งสองขั้วแล้วเอาอันที่ได้ตัวอักษรมากกว่า
    const [plain, negated] = await Promise.all([base.clone().png().toBuffer(), base.clone().negate().png().toBuffer()]);
    const worker = await this.getWorker();
    await worker.setParameters({
      tessedit_char_whitelist: opts.digits ? '0123456789/:.,-+%' : '',
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
    });
    const score = (t: string, c: number): number => (t.replace(/[^\p{L}\p{N}]/gu, '').length + 0.5) * (c + 5);
    let best = { text: '', confidence: 0 };
    for (const img of [plain, negated]) {
      const { data } = await worker.recognize(img);
      const text = (data.text ?? '').replace(/\s+/g, ' ').trim();
      const confidence = Math.round(data.confidence ?? 0);
      if (score(text, confidence) > score(best.text, best.confidence)) best = { text, confidence };
      // อ่านได้ชัดแล้วไม่ต้องเสียเวลาลองอีกขั้ว
      if (best.confidence >= 85 && best.text.length >= 3) break;
    }
    return { ...best, tookMs: Date.now() - started };
  }

  async dispose(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w) await (await w).terminate().catch(() => {});
  }
}

/** โฟลเดอร์แคชข้อมูลภาษาใต้ userData */
export function ocrCacheDir(userDataDir: string): string {
  return path.join(userDataDir, 'tessdata');
}
