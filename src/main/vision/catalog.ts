/**
 * แค็ตตาล็อกหน้าจอ — "ความจำ" ของตา AI แยกต่อเกม
 *
 *   <userData>/games/<set>/screens.json     หน้าจอที่รู้จัก: dHash หลายตัว + ชื่อ + ปุ่มที่รู้
 *   <userData>/games/<set>/thumbs/<id>.jpg  ภาพย่อให้ผู้ใช้ดูว่าหน้าไหน
 *
 * ทำไมต้องมี: โมเดลภาพช้า (5-20 วิ) แต่หน้าจอในเกมมีไม่กี่สิบหน้า — เห็นครั้งแรกถามโมเดลแล้วจำ
 * ครั้งต่อไปเทียบ dHash (<1 ms) ก็รู้ว่าหน้าอะไร มีปุ่มอะไรตรงไหน ไม่ต้องถามอีก
 *
 * หน้าเดียวกันแต่แอนิเมชัน/ตัวเลขต่างกัน dHash จะต่างกันไม่กี่บิต — เก็บได้หลายแฮชต่อหน้า
 * และรวมหน้าที่โมเดลตั้งชื่อเหมือนกันเป็นหน้าเดียว
 *
 * เป็นไฟล์ธรรมดาเหมือนเทมเพลต: ก็อปข้ามเครื่องได้ แก้มือได้ และชั้น "สมอง/ครู" ในอนาคตเขียนต่อได้
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { dhash, hammingHex, type Frame } from './capture';
import type { VlmClient } from './vlm';
import type { ScreenElement, ScreenEntry } from '../../shared/automation';

const SAFE_NAME = /^[\p{L}\p{N}_\-. ]{1,64}$/u;
/** บิตที่ต่างกันไม่เกินนี้ = หน้าเดียวกัน (64 บิต; ทดลอง: หน้าเดิมเลื่อนแอนิเมชัน 2-8, คนละหน้า 20+) */
export const DEFAULT_MAX_DISTANCE = 12;
const MAX_HASHES = 24;
const MAX_ELEMENTS = 60;

export interface Identified {
  hash: string;
  entry?: ScreenEntry;
  distance?: number;
}

export class ScreenCatalog {
  private cache = new Map<string, ScreenEntry[]>();

  constructor(
    private root: string,
    private maxDistance = DEFAULT_MAX_DISTANCE,
  ) {
    fs.mkdirSync(root, { recursive: true });
  }

  private setDir(set: string): string {
    if (!SAFE_NAME.test(set)) throw new Error('ชื่อเกม/ชุดใช้ได้เฉพาะตัวอักษร ตัวเลข _ - . ช่องว่าง');
    return path.join(this.root, set);
  }

  private load(set: string): ScreenEntry[] {
    const hit = this.cache.get(set);
    if (hit) return hit;
    let list: ScreenEntry[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.setDir(set), 'screens.json'), 'utf8')) as { screens?: ScreenEntry[] };
      list = (raw.screens ?? []).filter((e) => e?.id && Array.isArray(e.hashes));
    } catch {
      // ยังไม่มี
    }
    this.cache.set(set, list);
    return list;
  }

  private save(set: string, list: ScreenEntry[]): void {
    const dir = this.setDir(set);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'screens.json'), JSON.stringify({ screens: list }, null, 2), 'utf8');
    this.cache.set(set, list);
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

  list(set: string): ScreenEntry[] {
    return [...this.load(set)].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  get(set: string, id: string): ScreenEntry | undefined {
    return this.load(set).find((e) => e.id === id);
  }

  /** หน้านี้เคยเห็นไหม — เทียบ dHash กับทุกแฮชของทุกหน้า (<1 ms) */
  async identify(set: string, frame: Frame): Promise<Identified> {
    const hash = await dhash(frame.png);
    let best: { entry: ScreenEntry; distance: number } | null = null;
    for (const entry of this.load(set)) {
      for (const h of entry.hashes) {
        const d = hammingHex(h, hash);
        if (!best || d < best.distance) best = { entry, distance: d };
      }
    }
    if (best && best.distance <= this.maxDistance) return { hash, entry: best.entry, distance: best.distance };
    return { hash };
  }

  /**
   * เห็นหน้านี้อีกครั้ง — นับ และจำแฮชแบบใหม่ถ้าต่างจากเดิมพอสมควร (แอนิเมชันคนละเฟรม)
   * เขียนไฟล์เฉพาะตอนได้แฮชใหม่ — wait_screen เรียกทุก 0.7 วิ ไม่ควรเขียนดิสก์ทุกครั้ง (ตัวนับติดไปกับการบันทึกครั้งถัดไป)
   */
  touch(set: string, entry: ScreenEntry, hash: string, distance = 0): void {
    const list = this.load(set);
    const e = list.find((x) => x.id === entry.id);
    if (!e) return;
    e.seen++;
    e.lastSeenAt = Date.now();
    if (distance >= 4 && !e.hashes.includes(hash)) {
      e.hashes.push(hash);
      if (e.hashes.length > MAX_HASHES) e.hashes.splice(0, e.hashes.length - MAX_HASHES);
      this.save(set, list);
    }
  }

  /** ไม่รู้จัก → ให้โมเดลตั้งชื่อ + บอกปุ่ม แล้วจำ (รวมกับหน้าชื่อเดียวกันถ้ามี) */
  async learn(set: string, frame: Frame, vlm: VlmClient, hashHint?: string): Promise<ScreenEntry> {
    const d = await vlm.describe(frame);
    const hash = hashHint ?? (await dhash(frame.png));
    const list = this.load(set);
    const name = d.screen || 'unnamed screen';
    let entry = list.find((e) => norm(e.name) === norm(name));
    if (entry) {
      if (!entry.hashes.includes(hash)) entry.hashes.push(hash);
      if (entry.hashes.length > MAX_HASHES) entry.hashes.splice(0, entry.hashes.length - MAX_HASHES);
      for (const el of d.elements) if (!entry.elements.some((x) => norm(x.label) === norm(el.label))) entry.elements.push(el);
      entry.elements.splice(MAX_ELEMENTS);
      entry.seen++;
      entry.lastSeenAt = Date.now();
    } else {
      entry = {
        id: crypto.randomUUID().slice(0, 8),
        set,
        name,
        hashes: [hash],
        elements: d.elements.slice(0, MAX_ELEMENTS),
        seen: 1,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        source: 'vlm',
      };
      list.push(entry);
    }
    this.save(set, list);
    await this.saveThumb(set, entry.id, frame).catch(() => {});
    return entry;
  }

  /** จำปุ่มเพิ่มบนหน้าที่รู้จัก (จากที่โมเดลหาเจอตอน vlm_tap) — คำที่ผู้ใช้ใช้เรียกเก็บเป็น alias */
  addElement(set: string, id: string, el: ScreenElement, alias?: string): void {
    const list = this.load(set);
    const e = list.find((x) => x.id === id);
    if (!e) return;
    const a = alias?.trim();
    let hit = e.elements.find((x) => norm(x.label) === norm(el.label));
    if (hit) hit.rect = el.rect;
    else {
      hit = { ...el };
      e.elements.push(hit);
      e.elements.splice(0, Math.max(0, e.elements.length - MAX_ELEMENTS));
    }
    if (a && !(hit.aliases ?? []).some((x) => norm(x) === norm(a))) hit.aliases = [...(hit.aliases ?? []), a];
    this.save(set, list);
  }

  /** หาปุ่มจากคำบรรยาย — alias ตรงเป๊ะก่อน แล้วค่อยเทียบคำ */
  findElement(entry: ScreenEntry, query: string): ScreenElement | null {
    const q = norm(query);
    if (!q) return null;
    const byAlias = entry.elements.find((el) => (el.aliases ?? []).some((a) => norm(a) === q));
    if (byAlias) return byAlias;
    const qTokens = tokens(query);
    if (qTokens.length === 0) return null;
    let best: { el: ScreenElement; score: number } | null = null;
    for (const el of entry.elements) {
      const l = norm(el.label);
      let score = 0;
      if (l === q) score = 1;
      else if (l.includes(q) || q.includes(l)) score = 0.9;
      else {
        const lTokens = tokens(el.label);
        const hit = qTokens.filter((t) => lTokens.some((x) => x === t || x.startsWith(t) || t.startsWith(x))).length;
        score = hit / qTokens.length;
        if (score < 0.99) score *= 0.8; // ต้องครบทุกคำถึงจะเชื่อเต็มที่
      }
      if (score >= 0.6 && (!best || score > best.score)) best = { el, score };
    }
    return best?.el ?? null;
  }

  rename(set: string, id: string, name: string): void {
    const list = this.load(set);
    const e = list.find((x) => x.id === id);
    if (!e || !name.trim()) return;
    e.name = name.trim();
    e.source = 'user';
    this.save(set, list);
  }

  delete(set: string, id: string): void {
    const list = this.load(set);
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    list.splice(i, 1);
    this.save(set, list);
    try {
      fs.unlinkSync(this.thumbPath(set, id));
    } catch {
      // ไม่มีก็ไม่เป็นไร
    }
  }

  private thumbPath(set: string, id: string): string {
    return path.join(this.setDir(set), 'thumbs', `${id.replace(/[^a-z0-9]/gi, '')}.jpg`);
  }

  private async saveThumb(set: string, id: string, frame: Frame): Promise<void> {
    const file = this.thumbPath(set, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, await sharp(frame.png).resize({ width: 180 }).jpeg({ quality: 70 }).toBuffer());
  }

  thumbDataUrl(set: string, id: string): string | null {
    try {
      return `data:image/jpeg;base64,${fs.readFileSync(this.thumbPath(set, id)).toString('base64')}`;
    } catch {
      return null;
    }
  }
}

const STOP = new Set(['the', 'a', 'an', 'button', 'icon', 'btn', 'link', 'tab', 'of', 'on', 'in', 'at', 'to', 'ปุ่ม', 'ไอคอน']);

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tokens(s: string): string[] {
  return norm(s)
    .split(' ')
    .filter((t) => t && !STOP.has(t));
}
