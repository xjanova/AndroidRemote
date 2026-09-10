/**
 * ตั้ง/อ่านระดับเสียงต่อเครื่อง
 *
 * ทดสอบกับ Android 14 (API 34) แล้ว:
 *   - `cmd media_session volume --stream 3 --set N` จาก shell ธรรมดา **เงียบเฉย ไม่เปลี่ยนค่า**
 *     (พิมพ์ "will set volume" แล้วไม่ทำ) — แต่ผ่าน `su 0` ทำงานทันที
 *   - จึงลอง root ก่อน → shell → สุดท้ายกดปุ่มเสียง (สัมพัทธ์ แม่นน้อยสุด แต่ได้ทุกเครื่อง)
 *   - ตรวจผลจริงจาก `dumpsys audio` ทุกครั้ง ไม่เชื่อว่าคำสั่ง "ไม่ error = สำเร็จ"
 */

import type { AdbClient } from '../adb/AdbClient';
import type { VolumeStream } from '../../shared/automation';

const STREAM_ID: Record<VolumeStream, number> = { media: 3, ring: 2, notification: 5, alarm: 4 };
const STREAM_NAME: Record<VolumeStream, string> = {
  media: 'STREAM_MUSIC',
  ring: 'STREAM_RING',
  notification: 'STREAM_NOTIFICATION',
  alarm: 'STREAM_ALARM',
};

export interface VolumeLevel {
  index: number;
  max: number;
  percent: number;
}

export async function getVolume(adb: AdbClient, serial: string, stream: VolumeStream): Promise<VolumeLevel | null> {
  const out = (await adb.exec(serial, 'dumpsys audio')).stdout;
  const start = out.indexOf(`- ${STREAM_NAME[stream]}:`);
  if (start < 0) return null;
  const block = out.slice(start, start + 900);
  const max = parseInt(/Max:\s*(\d+)/.exec(block)?.[1] ?? '', 10);
  // API 30+ มี streamVolume:N; รุ่นเก่ามีแค่ Current: … (speaker): N
  const idx = parseInt(/streamVolume:\s*(\d+)/.exec(block)?.[1] ?? /Current:[^\n]*?:\s*(\d+)/.exec(block)?.[1] ?? '', 10);
  if (!Number.isFinite(max) || !Number.isFinite(idx) || max <= 0) return null;
  return { index: idx, max, percent: Math.round((idx / max) * 100) };
}

export async function setVolume(
  adb: AdbClient,
  serial: string,
  stream: VolumeStream,
  percent: number,
): Promise<{ ok: boolean; via: 'root' | 'shell' | 'keys' | 'none'; level: VolumeLevel | null }> {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const before = await getVolume(adb, serial, stream);
  const max = before?.max ?? 15;
  const target = Math.round((pct / 100) * max);
  const id = STREAM_ID[stream];

  const attempt = async (cmd: string): Promise<boolean> => {
    await adb.exec(serial, cmd).catch(() => undefined);
    const now = await getVolume(adb, serial, stream);
    return now?.index === target;
  };

  if (await attempt(`su 0 cmd media_session volume --stream ${id} --set ${target}`)) {
    return { ok: true, via: 'root', level: await getVolume(adb, serial, stream) };
  }
  if (await attempt(`cmd media_session volume --stream ${id} --set ${target}`)) {
    return { ok: true, via: 'shell', level: await getVolume(adb, serial, stream) };
  }

  // ทางสุดท้าย: กดลดจนสุดแล้วกดเพิ่มตามจำนวนขั้น — ใช้ได้กับสตรีมที่ปุ่มเสียงคุมอยู่ตอนนั้น
  if (stream === 'media') {
    const downs = Array(max).fill('input keyevent 25').join(' ; ');
    const ups = target > 0 ? ' ; ' + Array(target).fill('input keyevent 24').join(' ; ') : '';
    await adb.exec(serial, `${downs}${ups}`).catch(() => undefined);
    const now = await getVolume(adb, serial, stream);
    if (now?.index === target) return { ok: true, via: 'keys', level: now };
  }

  return { ok: false, via: 'none', level: await getVolume(adb, serial, stream) };
}
