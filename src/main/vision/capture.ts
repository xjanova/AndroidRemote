/**
 * จับภาพหน้าจอเครื่องเป็น "เฟรม" ที่พร้อมให้ตัวหาภาพ/OCR/แฮชใช้
 *
 * ใช้ `screencap -p` ผ่าน adb — ช้ากว่าดึงจากสตรีมวิดีโอ (~0.3-0.8 วิ) แต่
 *   1) ไม่ต้องเปิดมิเรอร์ก็ทำงานได้ (บอทวิ่งเงียบๆ 10 เครื่องได้)
 *   2) ได้ภาพความละเอียดจริง ไม่มี artefact จาก H.264
 *   3) ใช้ได้ทั้งอีมูเลเตอร์และมือถือจริงเหมือนกัน
 * ถ้าอนาคตต้องเร็วกว่านี้ ค่อยให้ server ฝั่ง Android ส่ง JPEG มาแทน โดย API นี้ไม่เปลี่ยน
 */

import sharp, { type Sharp } from 'sharp';
import type { AdbClient } from '../adb/AdbClient';
import type { FracRect } from '../../shared/automation';

export interface Frame {
  serial: string;
  takenAt: number;
  /** ขนาดจอจริง */
  width: number;
  height: number;
  /** PNG เต็มความละเอียด */
  png: Buffer;
  /** ภาพเทาย่อ (8 บิต/พิกเซล) สำหรับหาภาพเร็วๆ */
  gray: Buffer;
  gw: number;
  gh: number;
  /** gw / width */
  scale: number;
}

/** ความกว้างของภาพเทาที่ใช้ค้นหา — 540 พอสำหรับปุ่มในเกม และเร็วพอบน CPU */
export const SEARCH_WIDTH = 540;

export async function captureFrame(adb: AdbClient, serial: string, searchWidth = SEARCH_WIDTH): Promise<Frame> {
  const png = await adb.execRaw(serial, 'screencap -p');
  if (png.length < 100 || png[0] !== 0x89 || png[1] !== 0x50) {
    throw new Error(`screencap ไม่ได้ภาพจาก ${serial} (${png.length} ไบต์)`);
  }
  const meta = await sharp(png).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error('อ่านขนาดภาพหน้าจอไม่ได้');

  const scale = Math.min(1, searchWidth / width);
  const gw = Math.max(1, Math.round(width * scale));
  const gh = Math.max(1, Math.round(height * scale));
  const gray = await toGray(sharp(png).resize(gw, gh, { fit: 'fill' }), gw, gh);

  return { serial, takenAt: Date.now(), width, height, png, gray, gw, gh, scale };
}

/**
 * บังคับให้ได้ภาพเทา 1 ช่องสีพอดี
 * 🔑 sharp `.grayscale()` อย่างเดียว**ไม่พอ** — ผลลัพธ์ยังมี alpha (จาก PNG ของ screencap)
 *    และอาจคืน 3 ช่องสีเท่ากัน ทำให้ buffer ยาวกว่า w×h แล้ว OpenCV โยน "offset is out of bounds"
 */
export async function toGray(pipeline: Sharp, w: number, h: number): Promise<Buffer> {
  const { data, info } = await pipeline.removeAlpha().grayscale().toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 1 && data.length === w * h) return data;
  // กันเหนียว: ถ้ายังมีหลายช่อง ดึงช่องแรกออกมาเอง
  const out = Buffer.alloc(w * h);
  const ch = info.channels;
  for (let i = 0, j = 0; i < out.length && j < data.length; i++, j += ch) out[i] = data[j];
  return out;
}

/** แปลงกรอบสัดส่วนเป็นพิกเซลจริง โดยกันไม่ให้ล้นขอบ */
export function rectToPixels(rect: FracRect, width: number, height: number): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.min(width - 1, Math.round(rect.fx * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(rect.fy * height)));
  const w = Math.max(1, Math.min(width - left, Math.round(rect.fw * width)));
  const h = Math.max(1, Math.min(height - top, Math.round(rect.fh * height)));
  return { left, top, width: w, height: h };
}

/** ตัดส่วนของเฟรม (เต็มความละเอียด) ออกมาเป็น PNG */
export async function cropPng(frame: Frame, rect: FracRect): Promise<Buffer> {
  const r = rectToPixels(rect, frame.width, frame.height);
  return sharp(frame.png).extract(r).png().toBuffer();
}

/** ภาพย่อ JPEG สำหรับโชว์ใน UI (ให้ผู้ใช้ลากกรอบ) */
export async function previewJpeg(frame: Frame, maxWidth = 360): Promise<Buffer> {
  return sharp(frame.png).resize({ width: Math.min(maxWidth, frame.width) }).jpeg({ quality: 78 }).toBuffer();
}

/**
 * dHash 64 บิต — ลายเซ็นของ "หน้าจอนี้หน้าตาแบบไหน"
 * ใช้จำว่าเคยเห็นหน้านี้แล้ว จะได้ไม่ต้องถามโมเดลภาพซ้ำ
 */
export async function dhash(png: Buffer): Promise<string> {
  const buf = await sharp(png).resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
  let h = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      h = (h << 1n) | (buf[y * 9 + x] < buf[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return h.toString(16).padStart(16, '0');
}

/** จำนวนบิตที่ต่างกันระหว่างสองแฮช (0 = เหมือนกันเป๊ะ, <10 = หน้าเดียวกันแทบแน่) */
export function hammingHex(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
