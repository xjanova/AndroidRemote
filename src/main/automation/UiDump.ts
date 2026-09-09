/**
 * อ่านโครงหน้าจอของเครื่องด้วย `uiautomator dump` แล้วหา element ตาม selector
 *
 * นี่คือสิ่งที่ทำให้มาโคร "ทนต่อการเปลี่ยนตำแหน่ง" ได้แบบ tping โดยไม่ต้องลงแอปบนมือถือ
 * uiautomator มากับทุกเครื่องและใช้ได้จาก uid shell
 *
 * ลำดับการหา (แม่นสุด → หยาบสุด) เหมือน tping:
 *   resource-id → text → content-desc → class ที่กดได้ → พิกัดสำรอง
 */

import type { AdbClient } from '../adb/AdbClient';
import type { UiNodeView, UiSelector } from '../../shared/automation';

/** แกะ `<node .../>` ด้วย regex — XML ของ uiautomator เป็นแบบแบนไม่ซับซ้อน ไม่ต้องใช้ parser เต็ม */
export function parseUiDump(xml: string): UiNodeView[] {
  const out: UiNodeView[] = [];
  const nodeRe = /<node\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const get = (name: string): string => {
      const r = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
      return r ? decodeXml(r[1]) : '';
    };
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(get('bounds'));
    if (!b) continue;
    out.push({
      resourceId: get('resource-id'),
      text: get('text'),
      contentDesc: get('content-desc'),
      className: get('class'),
      bounds: { left: +b[1], top: +b[2], right: +b[3], bottom: +b[4] },
      clickable: get('clickable') === 'true',
    });
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * ดึงโครงหน้าจอปัจจุบัน
 * `/dev/tty` ทำให้ XML ออกทาง stdout เลย ไม่ต้องเขียนไฟล์แล้ว pull
 * บางเครื่องแถมบรรทัด "UI hierchary dumped to: /dev/tty" ต่อท้าย — ตัดทิ้ง
 */
export async function dumpUi(adb: AdbClient, serial: string): Promise<UiNodeView[]> {
  const res = await adb.exec(serial, 'uiautomator dump /dev/tty 2>/dev/null');
  const start = res.stdout.indexOf('<?xml');
  const xml = start >= 0 ? res.stdout.slice(start) : res.stdout;
  if (!xml.includes('<node')) {
    throw new Error(
      'อ่านโครงหน้าจอไม่ได้ — จอล็อกอยู่ หรือแอปที่เปิดกันการอ่าน (เช่นแอปธนาคาร)',
    );
  }
  return parseUiDump(xml);
}

export interface FoundPoint {
  x: number;
  y: number;
  /** ชั้นที่หาเจอ เอาไว้บอกผู้ใช้ว่าแม่นแค่ไหน */
  via: 'resourceId' | 'text' | 'contentDesc' | 'className' | 'fallback';
}

/** หาจุดที่ควรกดตาม selector — คืน null ถ้าหาไม่เจอและไม่มีพิกัดสำรอง */
export function locate(
  nodes: UiNodeView[],
  selector: UiSelector,
  screen: { width: number; height: number },
): FoundPoint | null {
  const center = (n: UiNodeView): { x: number; y: number } => ({
    x: Math.round((n.bounds.left + n.bounds.right) / 2),
    y: Math.round((n.bounds.top + n.bounds.bottom) / 2),
  });
  // กรอบขนาดศูนย์คือโหนดที่มองไม่เห็น อย่าไปกด
  const visible = nodes.filter((n) => n.bounds.right > n.bounds.left && n.bounds.bottom > n.bounds.top);

  if (selector.resourceId) {
    const n = visible.find((x) => x.resourceId === selector.resourceId);
    if (n) return { ...center(n), via: 'resourceId' };
  }
  if (selector.text) {
    const n = visible.find((x) => x.text === selector.text) ?? visible.find((x) => x.text.includes(selector.text!));
    if (n) return { ...center(n), via: 'text' };
  }
  if (selector.contentDesc) {
    const n = visible.find((x) => x.contentDesc === selector.contentDesc);
    if (n) return { ...center(n), via: 'contentDesc' };
  }
  if (selector.className) {
    const n = visible.find((x) => x.className === selector.className && x.clickable);
    if (n) return { ...center(n), via: 'className' };
  }
  if (selector.fallback) {
    return {
      x: Math.round(selector.fallback.fx * screen.width),
      y: Math.round(selector.fallback.fy * screen.height),
      via: 'fallback',
    };
  }
  return null;
}

/** สร้าง selector ที่ดีที่สุดจากโหนดที่ผู้ใช้เลือก — เก็บทุกชั้นที่มี เผื่อชั้นบนหายไปในรุ่นถัดไปของแอป */
export function selectorFor(node: UiNodeView, screen: { width: number; height: number }): UiSelector {
  const cx = (node.bounds.left + node.bounds.right) / 2;
  const cy = (node.bounds.top + node.bounds.bottom) / 2;
  return {
    resourceId: node.resourceId || undefined,
    text: node.text || undefined,
    contentDesc: node.contentDesc || undefined,
    className: node.className || undefined,
    fallback: { fx: cx / screen.width, fy: cy / screen.height },
  };
}
