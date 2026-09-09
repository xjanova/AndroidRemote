/**
 * ทดสอบระบบมาโครส่วนที่ไม่ต้องมีมือถือ
 * รันด้วย: npm run smoke:automation
 *
 * สามอย่างที่พังแล้วเงียบ ถ้าไม่มีเทสต์จะรู้ตัวตอนผู้ใช้เล่นมาโครแล้วกดผิดที่:
 *   1. ตัวแกะ uiautomator dump + การหา element ตามลำดับชั้น
 *   2. ตัวบันทึกรวบ touch ดิบเป็น tap/swipe และเก็บเป็นสัดส่วนจอ
 *   3. ตัวตั้งเวลาตัดสิน "ถึงเวลาแล้ว" และปิดรายการ once หลังรัน
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUiDump, locate, selectorFor } from '../src/main/automation/UiDump';
import { MacroRecorder } from '../src/main/automation/Macros';
import { Scheduler } from '../src/main/automation/Scheduler';
import { TOUCH_ACTION, KEY_ACTION } from '../src/main/server/messages';

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(44)} ${extra}`);
}

async function main(): Promise<void> {
  console.log('\n=== 1. uiautomator dump → หา element ===');
  // ตัวอย่างจริงตามรูปแบบที่ uiautomator ปล่อยออกมา รวม escape ใน XML
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2340]">
    <node index="0" text="เข้าสู่ระบบ" resource-id="com.example:id/btn_login" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" bounds="[140,1800][940,1920]" />
    <node index="1" text="" resource-id="" class="android.widget.ImageButton" package="com.example" content-desc="ตะกร้า &amp; รายการ" clickable="true" enabled="true" bounds="[960,80][1060,180]" />
    <node index="2" text="ซ่อนอยู่" resource-id="com.example:id/hidden" class="android.widget.TextView" clickable="true" bounds="[0,0][0,0]" />
  </node>
</hierarchy>
UI hierchary dumped to: /dev/tty`;
  const nodes = parseUiDump(xml);
  check('แกะได้ครบ 4 โหนด', nodes.length === 4, `ได้ ${nodes.length}`);
  check('ถอด &amp; ใน content-desc', nodes[2]?.contentDesc === 'ตะกร้า & รายการ', nodes[2]?.contentDesc);
  const screen = { width: 1080, height: 2340 };

  const byId = locate(nodes, { resourceId: 'com.example:id/btn_login', text: 'อะไรก็ได้' }, screen);
  check('resource-id ชนะ text', byId?.via === 'resourceId' && byId.x === 540 && byId.y === 1860, JSON.stringify(byId));

  const byText = locate(nodes, { text: 'เข้าสู่ระบบ' }, screen);
  check('หาด้วย text', byText?.via === 'text' && byText.x === 540, JSON.stringify(byText));

  const byDesc = locate(nodes, { contentDesc: 'ตะกร้า & รายการ' }, screen);
  check('หาด้วย content-desc', byDesc?.via === 'contentDesc' && byDesc.x === 1010 && byDesc.y === 130, JSON.stringify(byDesc));

  const hiddenSkipped = locate(nodes, { resourceId: 'com.example:id/hidden' }, screen);
  check('ข้ามโหนดกรอบศูนย์ (มองไม่เห็น)', hiddenSkipped === null, String(hiddenSkipped));

  const fallback = locate(nodes, { resourceId: 'ไม่มี', fallback: { fx: 0.5, fy: 0.25 } }, screen);
  check('ถอยไปพิกัดสำรอง', fallback?.via === 'fallback' && fallback.x === 540 && fallback.y === 585, JSON.stringify(fallback));

  const sel = selectorFor(nodes[1], screen);
  check('selectorFor เก็บครบทุกชั้น + fallback', sel.resourceId === 'com.example:id/btn_login' && sel.text === 'เข้าสู่ระบบ'
    && Math.abs((sel.fallback?.fx ?? 0) - 0.5) < 0.001, JSON.stringify(sel));

  console.log('\n=== 2. ตัวบันทึก: touch ดิบ → tap / swipe ===');
  const rec = new MacroRecorder();
  rec.start('SER1', 'ทดสอบ', { width: 1080, height: 2340 });
  const base = { serial: 'SER1', pointerId: 1, screenW: 540, screenH: 1170, pressure: 1 }; // จอที่ PC เห็นย่อครึ่ง
  // แตะเร็ว
  rec.onTouch({ ...base, action: TOUCH_ACTION.DOWN, x: 270, y: 930 });
  rec.onTouch({ ...base, action: TOUCH_ACTION.UP, x: 272, y: 931 });
  // ปัด
  await new Promise((r) => setTimeout(r, 30));
  rec.onTouch({ ...base, action: TOUCH_ACTION.DOWN, x: 270, y: 900 });
  await new Promise((r) => setTimeout(r, 120));
  rec.onTouch({ ...base, action: TOUCH_ACTION.MOVE, x: 270, y: 600 });
  rec.onTouch({ ...base, action: TOUCH_ACTION.UP, x: 270, y: 300 });
  // เครื่องอื่นต้องไม่ถูกบันทึก
  rec.onTouch({ ...base, serial: 'OTHER', action: TOUCH_ACTION.DOWN, x: 1, y: 1 });
  rec.onTouch({ ...base, serial: 'OTHER', action: TOUCH_ACTION.UP, x: 1, y: 1 });
  rec.onKey('SER1', KEY_ACTION.DOWN, 4);
  rec.onKey('SER1', KEY_ACTION.UP, 4);
  const macro = rec.stop();

  check('ได้ 3 ขั้นตอน (tap, swipe, key)', macro?.steps.length === 3, macro?.steps.map((s) => s.t).join(','));
  const tap = macro?.steps[0];
  check('tap เก็บเป็นสัดส่วน 0..1 ไม่ใช่พิกเซล', tap?.t === 'tap' && Math.abs(tap.fx - 0.5) < 0.01 && Math.abs(tap.fy - 0.795) < 0.01,
    tap?.t === 'tap' ? `${tap.fx.toFixed(3)},${tap.fy.toFixed(3)}` : '');
  const swipe = macro?.steps[1];
  check('ปัดไกล → swipe มีระยะเวลา', swipe?.t === 'swipe' && swipe.durationMs >= 100 && swipe.fy2 < swipe.fy1,
    swipe?.t === 'swipe' ? `${swipe.durationMs}ms` : '');
  check('key เก็บครั้งเดียว (เฉพาะ DOWN)', macro?.steps.filter((s) => s.t === 'key').length === 1);
  check('เครื่องอื่นไม่ปนเข้ามา', !macro?.steps.some((s) => s.t === 'tap' && s.fx < 0.01));

  console.log('\n=== 3. ตัวตั้งเวลา ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-sched-'));
  const ran: string[] = [];
  const sched = new Scheduler(tmp, async (e) => { ran.push(e.id); return 'ok'; }, () => {});
  sched.put({ id: 'due-once', name: 'ครั้งเดียว ถึงแล้ว', macroId: 'm', serials: ['a'], mode: 'once', at: Date.now() - 1000, loops: 1, enabled: true });
  sched.put({ id: 'future-once', name: 'ครั้งเดียว ยังไม่ถึง', macroId: 'm', serials: ['a'], mode: 'once', at: Date.now() + 3_600_000, loops: 1, enabled: true });
  sched.put({ id: 'disabled', name: 'ปิดอยู่', macroId: 'm', serials: ['a'], mode: 'interval', at: 0, everyMs: 1, loops: 1, enabled: false });
  sched.put({ id: 'interval-due', name: 'ทุก 1ms ไม่เคยรัน', macroId: 'm', serials: ['a'], mode: 'interval', at: 0, everyMs: 1, loops: 1, enabled: true });
  sched.start();
  await new Promise((r) => setTimeout(r, 300));
  sched.stop();
  const after = Object.fromEntries(sched.list().map((s) => [s.id, s]));
  check('รายการที่ถึงเวลาถูกรัน', ran.includes('due-once') && ran.includes('interval-due'), ran.join(','));
  check('ยังไม่ถึงเวลา / ปิดอยู่ ไม่ถูกรัน', !ran.includes('future-once') && !ran.includes('disabled'));
  check('once รันแล้วปิดตัวเอง', after['due-once']?.enabled === false && after['due-once']?.lastResult === 'ok');
  check('interval ยังเปิดอยู่หลังรัน', after['interval-due']?.enabled === true);
  const reloaded = new Scheduler(tmp, async () => 'x', () => {});
  check('บันทึกลงไฟล์และโหลดกลับได้', reloaded.list().length === 4 && reloaded.list().find((s) => s.id === 'due-once')?.enabled === false);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(failures === 0 ? '\n✅ ผ่านทั้งหมด\n' : `\n❌ ไม่ผ่าน ${failures} ข้อ\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n❌ ล้มเหลว:', err);
  process.exit(1);
});
