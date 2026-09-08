/**
 * ถอดรหัสวิดีโอด้วย WebCodecs แล้ววาดลงแคนวาส
 *
 * ตัวถอดรหัสของ Chromium ใช้ฮาร์ดแวร์ให้อัตโนมัติ เราจึงไม่ต้องต่อ FFmpeg เอง
 * — นี่คือเหตุผลหลักที่เลือก Electron สำหรับโปรเจคนี้
 *
 * MediaCodec ฝั่งมือถือปล่อยออกมาเป็น Annex-B (มี start code 00 00 00 01 คั่น)
 * VideoDecoder รับ Annex-B ได้ตรงๆ **ถ้าไม่ใส่ description** ตอน configure
 * ถ้าใส่ description มันจะสลับไปคาดหวังรูปแบบ AVCC แล้วพังทั้งสตรีม
 */

import type { MirrorPacket } from '../shared/api';

export interface VideoSinkCallbacks {
  onFirstFrame?: () => void;
  onError?: (message: string) => void;
  onStats?: (stats: { fps: number; kbps: number }) => void;
}

export class VideoSink {
  private decoder: VideoDecoder | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;

  /** SPS/PPS ที่ได้มาก่อนคีย์เฟรมแรก ต้องเก็บไว้แปะหน้าเฟรมแรกให้ */
  private pendingConfig: Uint8Array | null = null;
  private configured = false;
  private sawFirstFrame = false;
  private codec: 'h264' | 'h265' = 'h264';

  private framesInWindow = 0;
  private bytesInWindow = 0;
  private windowStart = 0;
  private statsTimer: number | null = null;

  constructor(canvas: HTMLCanvasElement, private cb: VideoSinkCallbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  }

  static get supported(): boolean {
    return typeof globalThis.VideoDecoder !== 'undefined';
  }

  start(width: number, height: number, codec: 'h264' | 'h265'): void {
    this.stop();
    this.codec = codec;
    this.canvas.width = width;
    this.canvas.height = height;
    this.sawFirstFrame = false;
    this.configured = false;
    this.pendingConfig = null;

    this.decoder = new VideoDecoder({
      output: (frame) => this.draw(frame),
      error: (err) => this.cb.onError?.(`ตัวถอดรหัสล้ม: ${err.message}`),
    });

    this.windowStart = performance.now();
    this.statsTimer = window.setInterval(() => this.reportStats(), 1000);
  }

  stop(): void {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.decoder) {
      // close() โยนถ้าตัวถอดรหัสอยู่ในสถานะ closed อยู่แล้ว — ไม่ใช่เรื่องต้องแจ้ง
      try {
        if (this.decoder.state !== 'closed') this.decoder.close();
      } catch {
        // ปล่อยผ่าน
      }
      this.decoder = null;
    }
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  push(packet: MirrorPacket): void {
    const decoder = this.decoder;
    if (!decoder) return;

    if (packet.config) {
      // เก็บไว้ก่อน แล้วแปะหน้าคีย์เฟรมแรก — Annex-B ต่อกันตรงๆ ได้เลย
      this.pendingConfig = packet.data;
      if (!this.configured) this.configure(packet.data);
      return;
    }

    if (!this.configured) return; // ยังไม่มี SPS ป้อนไปก็เสียเปล่า

    let payload = packet.data;
    if (this.pendingConfig && packet.keyFrame) {
      const merged = new Uint8Array(this.pendingConfig.length + payload.length);
      merged.set(this.pendingConfig, 0);
      merged.set(payload, this.pendingConfig.length);
      payload = merged;
      this.pendingConfig = null;
    }

    this.bytesInWindow += payload.length;

    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: packet.keyFrame ? 'key' : 'delta',
          timestamp: packet.ptsUs,
          data: payload,
        }),
      );
    } catch (err) {
      this.cb.onError?.(`ป้อนข้อมูลให้ตัวถอดรหัสไม่ได้: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private configure(configData: Uint8Array): void {
    const codecString = this.codec === 'h265' ? hevcCodecString() : avcCodecString(configData);
    try {
      this.decoder?.configure({
        codec: codecString,
        // ไม่ใส่ description = บอกว่าเป็น Annex-B
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware',
      });
      this.configured = true;
    } catch (err) {
      this.cb.onError?.(
        `ตั้งค่าตัวถอดรหัส ${codecString} ไม่ได้: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private draw(frame: VideoFrame): void {
    try {
      if (this.ctx) {
        // ขนาดเฟรมอาจไม่ตรงแคนวาสถ้าจอมือถือหมุน — ปรับตามเฟรมเสมอ
        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
          this.canvas.width = frame.displayWidth;
          this.canvas.height = frame.displayHeight;
        }
        this.ctx.drawImage(frame, 0, 0);
      }
      this.framesInWindow++;
      if (!this.sawFirstFrame) {
        this.sawFirstFrame = true;
        this.cb.onFirstFrame?.();
      }
    } finally {
      // 🔑 ไม่ปิดเฟรม = หน่วยความจำ GPU รั่วจนแอปตายภายในไม่กี่วินาทีที่ 60fps
      frame.close();
    }
  }

  private reportStats(): void {
    const now = performance.now();
    const elapsed = (now - this.windowStart) / 1000;
    if (elapsed <= 0) return;
    this.cb.onStats?.({
      fps: Math.round(this.framesInWindow / elapsed),
      kbps: Math.round((this.bytesInWindow * 8) / elapsed / 1000),
    });
    this.framesInWindow = 0;
    this.bytesInWindow = 0;
    this.windowStart = now;
  }
}

// ─────────────────────────── สตริงตัวเข้ารหัส ───────────────────────────

/**
 * สร้างสตริง codec ของ H.264 จาก SPS จริง
 *
 * รูปแบบคือ avc1.PPCCLL — profile_idc, constraint flags, level_idc เป็นเลขฐานสิบหก
 * เดาค่าเอาไม่ได้ ถ้าไม่ตรงกับสตรีมจริง Chromium จะปฏิเสธหรือถอดออกมาเป็นภาพเละ
 */
function avcCodecString(annexB: Uint8Array): string {
  const sps = findNal(annexB, 7);
  if (sps && sps.length >= 4) {
    const profile = sps[1];
    const constraints = sps[2];
    const level = sps[3];
    return `avc1.${hex2(profile)}${hex2(constraints)}${hex2(level)}`;
  }
  // ถอย: baseline 4.0 รองรับกว้างสุด ดีกว่าไม่ตั้งค่าเลย
  return 'avc1.42E028';
}

function hevcCodecString(): string {
  // H.265 ต้องแกะ VPS/SPS ลึกกว่านี้มากถึงจะได้สตริงที่ถูกต้อง
  // ตอนนี้ใช้ค่ากลางที่เครื่องส่วนใหญ่รับได้ไปก่อน
  return 'hvc1.1.6.L120.90';
}

/** หา NAL ชนิดที่ต้องการใน Annex-B แล้วคืนเนื้อ NAL (รวมไบต์หัว) */
function findNal(data: Uint8Array, nalType: number): Uint8Array | null {
  let i = 0;
  let start = -1;
  while (i + 3 < data.length) {
    const isStart4 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1;
    const isStart3 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    if (isStart4 || isStart3) {
      const headerLen = isStart4 ? 4 : 3;
      const nalStart = i + headerLen;
      if (nalStart >= data.length) break;

      if (start >= 0) {
        return data.subarray(start, i);
      }
      if ((data[nalStart] & 0x1f) === nalType) {
        start = nalStart;
      }
      i = nalStart;
    } else {
      i++;
    }
  }
  return start >= 0 ? data.subarray(start) : null;
}

function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}
