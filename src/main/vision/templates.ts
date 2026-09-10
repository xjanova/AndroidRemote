/**
 * คลังเทมเพลตภาพ — แยกเป็น "ชุด" ต่อเกม (โฟลเดอร์ละชุด)
 *
 *   <userData>/templates/<set>/<name>.png   ภาพชิ้นที่ตัด (เต็มความละเอียดเครื่องอ้างอิง)
 *   <userData>/templates/<set>/meta.json    ข้อมูลประกอบ (ขนาดจออ้างอิง ตำแหน่งที่ตัด)
 *
 * เก็บเป็นไฟล์ธรรมดาเพื่อให้ผู้ใช้ก็อปชุดไปเครื่องอื่น/แชร์ได้ และตัวเรียนรู้ในอนาคต
 * เขียนเพิ่มเองได้โดยไม่ต้องผ่าน UI
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Frame } from './capture';
import { cropPng } from './capture';
import { loadTemplateGray, type LoadedTemplate } from './match';
import type { FracRect, TemplateInfo } from '../../shared/automation';

const SAFE_NAME = /^[\p{L}\p{N}_\-. ]{1,64}$/u;

export class TemplateStore {
  private cache = new Map<string, LoadedTemplate>();

  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  private setDir(set: string): string {
    if (!SAFE_NAME.test(set)) throw new Error('ชื่อชุดเทมเพลตใช้ได้เฉพาะตัวอักษร ตัวเลข _ - . ช่องว่าง');
    return path.join(this.root, set);
  }

  private readMeta(set: string): Record<string, TemplateInfo> {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.setDir(set), 'meta.json'), 'utf8')) as Record<string, TemplateInfo>;
    } catch {
      return {};
    }
  }

  private writeMeta(set: string, meta: Record<string, TemplateInfo>): void {
    const dir = this.setDir(set);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  }

  sets(): string[] {
    try {
      return fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }

  list(set: string): TemplateInfo[] {
    return Object.values(this.readMeta(set)).sort((a, b) => a.name.localeCompare(b.name));
  }

  has(set: string, name: string): boolean {
    return Boolean(this.readMeta(set)[name]);
  }

  pngPath(set: string, name: string): string {
    if (!SAFE_NAME.test(name)) throw new Error('ชื่อเทมเพลตใช้ได้เฉพาะตัวอักษร ตัวเลข _ - . ช่องว่าง');
    return path.join(this.setDir(set), `${name}.png`);
  }

  /** ตัดจากเฟรมแล้วบันทึกเป็นเทมเพลตใหม่ (ทับชื่อเดิมได้) */
  async save(set: string, name: string, frame: Frame, rect: FracRect): Promise<TemplateInfo> {
    const file = this.pngPath(set, name);
    const png = await cropPng(frame, rect);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, png);

    const info: TemplateInfo = {
      set,
      name,
      width: Math.round(rect.fw * frame.width),
      height: Math.round(rect.fh * frame.height),
      refWidth: frame.width,
      refHeight: frame.height,
      rect,
      createdAt: Date.now(),
    };
    const meta = this.readMeta(set);
    meta[name] = info;
    this.writeMeta(set, meta);
    this.cache.delete(`${set}/${name}`);
    return info;
  }

  delete(set: string, name: string): void {
    const meta = this.readMeta(set);
    if (!meta[name]) return;
    delete meta[name];
    this.writeMeta(set, meta);
    try {
      fs.unlinkSync(this.pngPath(set, name));
    } catch {
      // ไม่มีไฟล์ก็ไม่เป็นไร
    }
    this.cache.delete(`${set}/${name}`);
  }

  /** โหลดพร้อมใช้ค้น (แคชในหน่วยความจำ) */
  async load(set: string, name: string): Promise<LoadedTemplate> {
    const key = `${set}/${name}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const info = this.readMeta(set)[name];
    if (!info) throw new Error(`ไม่มีเทมเพลต "${name}" ในชุด "${set}"`);
    const png = fs.readFileSync(this.pngPath(set, name));
    const loaded = await loadTemplateGray(png, info);
    this.cache.set(key, loaded);
    return loaded;
  }

  /** PNG ของเทมเพลตเป็น data URL — ให้ UI โชว์ */
  dataUrl(set: string, name: string): string | null {
    try {
      return `data:image/png;base64,${fs.readFileSync(this.pngPath(set, name)).toString('base64')}`;
    } catch {
      return null;
    }
  }
}
