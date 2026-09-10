/**
 * หาภาพเทมเพลตบนเฟรม — OpenCV (WASM) matchTemplate แบบ normalized cross-correlation
 *
 * ทำไมไม่เขียน NCC เองใน TS: เฟรม 540x1170 กับเทมเพลต 50x50 = ~1.5 พันล้านคูณ
 * JS ล้วนใช้ 1-3 วิ; OpenCV WASM ใช้ ~20-60 มิลลิวินาที
 *
 * สเกล: เทมเพลตตัดมาจากเครื่อง refWidth พิกเซล; บนเครื่องอื่นปุ่มโตตามความกว้างจอ
 * จึงย่อ/ขยายเทมเพลตเป็น tplW × (frame.width/refWidth) × frame.scale ก่อนค้นเสมอ
 * และลองสเกล ±10% ถ้าคะแนนยังไม่ถึงเกณฑ์ (จอสัดส่วนต่างกันมักเพี้ยนเล็กน้อย)
 */

import sharp from 'sharp';
import cvPromise from '@techstark/opencv-js';
import { toGray, type Frame } from './capture';
import type { FracRect, MatchResult, TemplateInfo } from '../../shared/automation';

export interface LoadedTemplate {
  info: TemplateInfo;
  /** ภาพเทาเต็มความละเอียดของเครื่องอ้างอิง */
  gray: Buffer;
  w: number;
  h: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CvNs = any;
let cvReady: Promise<CvNs> | null = null;

async function cv(): Promise<CvNs> {
  if (!cvReady) {
    // โมดูล WASM เริ่มแบบ async — export เป็น thenable ที่ resolve เมื่อพร้อม
    cvReady = Promise.resolve(cvPromise as unknown as CvNs).then((m) => {
      if (!m?.Mat) throw new Error('OpenCV WASM ไม่พร้อม');
      return m;
    });
  }
  return cvReady;
}

/** อุ่นเครื่องล่วงหน้า (โหลด WASM ~0.5 วิ) จะได้ไม่ช้าตอนขั้นตอนแรก */
export function warmUpMatcher(): void {
  void cv().catch(() => {});
}

export async function loadTemplateGray(png: Buffer, info: TemplateInfo): Promise<LoadedTemplate> {
  const meta = await sharp(png).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new Error('อ่านขนาดเทมเพลตไม่ได้');
  const gray = await toGray(sharp(png), w, h);
  return { info, gray, w, h };
}

export interface MatchOptions {
  threshold?: number;
  /** จำกัดพื้นที่ค้น (สัดส่วนจอ) — เร็วขึ้นและพลาดน้อยลง */
  region?: FracRect;
  /** สเกลเพิ่มเติมที่จะลองถ้าสเกลหลักไม่ถึงเกณฑ์ */
  extraScales?: number[];
}

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_EXTRA_SCALES = [0.9, 1.1, 0.8, 1.2];

/**
 * หาตำแหน่งที่เหมือนเทมเพลตที่สุดบนเฟรม
 * คืน null ถ้าคะแนนสูงสุดไม่ถึง threshold ในทุกสเกล
 */
export async function findTemplate(frame: Frame, tpl: LoadedTemplate, opts: MatchOptions = {}): Promise<MatchResult | null> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const c = await cv();

  // ขนาดเทมเพลตในพิกัดภาพเทาย่อของเฟรมนี้
  const base = (frame.width / tpl.info.refWidth) * frame.scale;
  const scales = [1, ...(opts.extraScales ?? DEFAULT_EXTRA_SCALES)];

  // พื้นที่ค้น
  const rx = opts.region ? Math.max(0, Math.floor(opts.region.fx * frame.gw)) : 0;
  const ry = opts.region ? Math.max(0, Math.floor(opts.region.fy * frame.gh)) : 0;
  const rw = opts.region ? Math.min(frame.gw - rx, Math.ceil(opts.region.fw * frame.gw)) : frame.gw;
  const rh = opts.region ? Math.min(frame.gh - ry, Math.ceil(opts.region.fh * frame.gh)) : frame.gh;

  const src = c.matFromArray(frame.gh, frame.gw, c.CV_8UC1, frame.gray);
  const roi = opts.region ? src.roi(new c.Rect(rx, ry, rw, rh)) : src;

  let best: MatchResult | null = null;
  try {
    for (const s of scales) {
      const tw = Math.max(4, Math.round(tpl.w * base * s));
      const th = Math.max(4, Math.round(tpl.h * base * s));
      if (tw >= rw || th >= rh) continue; // เทมเพลตใหญ่กว่าพื้นที่ค้น ข้าม

      const tgray = await toGray(sharp(tpl.gray, { raw: { width: tpl.w, height: tpl.h, channels: 1 } }).resize(tw, th, { fit: 'fill' }), tw, th);
      const t = c.matFromArray(th, tw, c.CV_8UC1, tgray);
      const result = new c.Mat();
      try {
        c.matchTemplate(roi, t, result, c.TM_CCOEFF_NORMED);
        const mm = c.minMaxLoc(result);
        const score = mm.maxVal as number;
        if (!best || score > best.score) {
          const cx = rx + mm.maxLoc.x + tw / 2;
          const cy = ry + mm.maxLoc.y + th / 2;
          best = {
            name: tpl.info.name,
            score,
            fx: cx / frame.gw,
            fy: cy / frame.gh,
            fw: tw / frame.gw,
            fh: th / frame.gh,
          };
        }
      } finally {
        t.delete();
        result.delete();
      }
      // สเกลหลักผ่านเกณฑ์แล้วไม่ต้องลองต่อ
      if (best && best.score >= threshold && s === 1) break;
    }
  } finally {
    if (roi !== src) roi.delete();
    src.delete();
  }

  return best && best.score >= threshold ? best : null;
}

/** คะแนนที่ดีที่สุดโดยไม่สนเกณฑ์ — ไว้ให้ UI โชว์ว่า "เจอแค่ไหน" ตอนปรับ threshold */
export async function scoreTemplate(frame: Frame, tpl: LoadedTemplate, region?: FracRect): Promise<MatchResult | null> {
  return findTemplate(frame, tpl, { threshold: -1, region });
}
