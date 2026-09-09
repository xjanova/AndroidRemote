/**
 * ทดสอบเซสชันมิเรอร์เต็มวงกับเครื่องจริง (หรืออีมูเลเตอร์) โดยไม่ต้องเปิด Electron
 * รันด้วย: npm run smoke:mirror
 *
 * พิสูจน์: ส่ง jar → reverse → สั่งรัน server → server ต่อกลับ → หัวข้อมูล → SPS/PPS →
 *          คีย์เฟรม → เฟรมไหลต่อเนื่อง → ช่องควบคุมส่ง touch/key ได้ → SHELL_EXEC ตอบกลับ
 * ถ้าอันนี้ผ่าน แอปจะเหลือแค่เรื่องถอดรหัสและวาดภาพ ซึ่งเป็นของ Chromium
 */

import { AdbClient } from '../src/main/adb/AdbClient';
import { ServerSession } from '../src/main/server/ServerSession';
import {
  KEY_ACTION,
  TOUCH_ACTION,
  encodeKeycode,
  encodeShellExec,
  encodeTouch,
} from '../src/main/server/messages';

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(40)} ${extra}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const adb = new AdbClient({ log: (l, m) => console.log(`  [adb ${l}] ${m}`) });
  const devices = (await adb.listDevices()).filter((d) => d.state === 'device');
  if (devices.length === 0) {
    console.log('❌ ไม่มีเครื่องออนไลน์ — เสียบมือถือหรือเปิดอีมูเลเตอร์ก่อน');
    process.exit(1);
  }
  const serial = process.argv[2] ?? devices[0].serial;
  console.log(`\n=== ทดสอบกับ ${serial} ===`);

  const session = new ServerSession(adb, serial, { maxSize: 720, maxFps: 30, bitRate: 2_000_000, codec: 'h264' });

  const serverLog: string[] = [];
  let header: { width: number; height: number; codec: string; deviceName: string; streamId: number } | null = null;
  let packets = 0;
  let bytes = 0;
  let configSeen = false;
  let keyframeSeen = false;
  let closedReason: string | null = null;
  const shellReplies: string[] = [];

  session.on('log', (line: string) => {
    serverLog.push(line);
    if (/\[AR\] [EW]/.test(line)) console.log(`  ${line}`);
  });
  session.on('header', (h) => {
    header = h;
  });
  session.on('packet', (p) => {
    packets++;
    bytes += p.data.length;
    if (p.config) configSeen = true;
    if (p.keyFrame) keyframeSeen = true;
  });
  session.on('shellResult', (r) => shellReplies.push(r.output.trim()));
  session.on('closed', (reason: string) => {
    closedReason = reason;
  });

  console.log('\n--- 1. เริ่มเซสชัน (push → reverse → รัน server → รอต่อกลับ) ---');
  const t0 = Date.now();
  try {
    await session.start();
    check('server ต่อกลับและส่งหัวข้อมูล', true, `${Date.now() - t0} ms`);
  } catch (err) {
    check('server ต่อกลับและส่งหัวข้อมูล', false, err instanceof Error ? err.message : String(err));
    console.log('\n--- log จาก server ---');
    for (const l of serverLog) console.log(`  ${l}`);
    process.exit(1);
  }

  const h = header!;
  check('ขนาดภาพสมเหตุผล', h.width >= 240 && h.height >= 240 && h.width % 8 === 0 && h.height % 8 === 0, `${h.width}x${h.height} ${h.codec}`);
  check('มีช่องควบคุม', session.hasControl);

  console.log('\n--- 2. เฟรมแรก ---');
  await sleep(2500);
  check('ได้ SPS/PPS (แพ็กเก็ตตั้งค่า)', configSeen);
  check('ได้คีย์เฟรม', keyframeSeen);
  check('เซสชันยังไม่ปิดเอง', closedReason === null, closedReason ?? '');
  const wake = await adb.exec(serial, 'dumpsys power | grep -o "mWakefulness=[A-Za-z]*"');
  check('เซสชันปลุกจอให้เอง (mWakefulness=Awake)', /Awake/.test(wake.stdout), wake.stdout.trim());

  console.log('\n--- 3. ช่องควบคุม — วัดจากผลบนเครื่อง ไม่ใช่แค่ส่งได้ ---');
  // จอนิ่ง = ไม่มีเฟรม ซึ่ง**ถูกต้อง** — ต้องทำให้จอขยับก่อนถึงจะวัดว่าเฟรมไหลได้
  // ปัดจากล่างขึ้นบนยาวๆ เป็นการ "เลื่อน" ที่ทำให้พิกเซลเปลี่ยนแน่ๆ ไม่ว่าอยู่หน้าไหน
  const packetsBeforeSwipe = packets;
  const sx = Math.round(h.width / 2);
  for (let i = 0; i <= 10; i++) {
    const y = Math.round(h.height * (0.8 - 0.05 * i));
    const action = i === 0 ? TOUCH_ACTION.DOWN : i === 10 ? TOUCH_ACTION.UP : TOUCH_ACTION.MOVE;
    session.send(encodeTouch({ action, pointerId: 0n, x: sx, y, screenW: h.width, screenH: h.height }));
    await sleep(30);
  }
  await sleep(1500);
  check('ปัดจอแล้วเฟรมไหล (จอเปลี่ยนจริง)', packets - packetsBeforeSwipe >= 3, `+${packets - packetsBeforeSwipe} แพ็กเก็ต`);

  // เปิด Settings ก่อน เพื่อให้ HOME มีอะไรให้ปิดจริงๆ (ไม่งั้นอยู่ launcher อยู่แล้ววัดไม่ได้)
  await adb.exec(serial, 'am start -a android.settings.SETTINGS >/dev/null 2>&1');
  await sleep(1500);
  const keyOk = session.send(encodeKeycode(KEY_ACTION.DOWN, 3)) && session.send(encodeKeycode(KEY_ACTION.UP, 3));
  check('ส่งปุ่ม HOME ได้', keyOk);
  // poll — mCurrentFocus เป็น null ชั่วขณะระหว่าง window transition ไม่ใช่ว่า HOME ไม่ทำงาน
  let focusText = '';
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    focusText = (await adb.exec(serial, 'dumpsys window 2>/dev/null | grep -o "mCurrentFocus=Window{[^}]*}"')).stdout.trim();
    if (/launcher|home/i.test(focusText)) break;
  }
  check('ปุ่ม HOME มีผลจริง (กลับไป launcher จาก Settings)', /launcher|home/i.test(focusText), focusText.slice(0, 90) || '(ว่าง)');

  session.send(encodeShellExec('echo ping-from-pc; id -u'));
  await sleep(1500);
  check('SHELL_EXEC ตอบกลับทางช่องควบคุม', shellReplies.some((r) => r.includes('ping-from-pc')), shellReplies[0]?.replace(/\n/g, ' ') ?? '(ไม่มีคำตอบ)');
  check('server ไม่รายงาน error', !serverLog.some((l) => /\[AR\] E /.test(l)));
  check('เซสชันยังเปิดอยู่', closedReason === null, closedReason ?? '');
  console.log(`      รวม ${packets} แพ็กเก็ต ${(bytes / 1024).toFixed(0)} KB`);

  console.log('\n--- 4. ปิด — server ต้องตายตามทันที แม้จอนิ่ง ---');
  session.stop('จบการทดสอบ');
  await sleep(1200);
  // [c] กัน grep จับตัวเอง — pgrep -f จับ sh -c ของตัวเองด้วย ทำให้ดูเหมือนค้างทั้งที่ไม่ค้าง
  const left = await adb.exec(serial, "ps -eo pid,args | grep '[c]om.androidremote.server.Main' | grep -v pkill || true");
  check('โพรเซส server บนเครื่องจบแล้ว', left.stdout.trim() === '', left.stdout.trim() ? `ยังอยู่: ${left.stdout.trim().split('\n')[0]}` : '');

  console.log(failures === 0 ? '\n✅ มิเรอร์ + ควบคุม ผ่านครบวงกับเครื่องจริง\n' : `\n❌ ไม่ผ่าน ${failures} ข้อ\n`);
  if (failures) {
    console.log('--- log จาก server ---');
    for (const l of serverLog.slice(-30)) console.log(`  ${l}`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n❌ ล้มเหลว:', err);
  process.exit(1);
});
