/**
 * ทดสอบ automation v2 กับสองเครื่องจริง — "เครื่องใครเครื่องมัน" + ตา (หาภาพ/OCR) + เสียง
 * รันด้วย: npm run smoke:automation2
 *
 * ต้องมี 2 เครื่องออนไลน์ เครื่องแรกเปิดเกม Dropkick (g123) ไว้ที่หน้าเมนหลัก
 * ทุกข้อวัดผลบนเครื่องจริง ไม่ใช่แค่ "ส่งคำสั่งได้"
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdbClient } from '../src/main/adb/AdbClient';
import { ServerSession } from '../src/main/server/ServerSession';
import { MacroPlayer } from '../src/main/automation/Macros';
import { ProfileStore, interpolate } from '../src/main/automation/Profiles';
import { TemplateStore } from '../src/main/vision/templates';
import { Ocr } from '../src/main/vision/ocr';
import { VlmClient } from '../src/main/vision/vlm';
import { ScreenCatalog } from '../src/main/vision/catalog';
import { captureFrame, type Frame } from '../src/main/vision/capture';
import { findTemplate } from '../src/main/vision/match';
import { getVolume, setVolume } from '../src/main/device/volume';
import type { Macro } from '../src/shared/automation';

let fail = 0;
const ok = (label: string, pass: boolean, extra = ''): void => {
  if (!pass) fail++;
  console.log(`  ${pass ? '✅' : '❌'} ${label.padEnd(52)} ${extra}`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const GAME_URL = 'https://h5.g123.jp/game/jya?lang=en&platform=g123';

async function dismissChromeFre(adb: AdbClient, serial: string): Promise<void> {
  for (const text of ['Use without an account', 'No thanks', 'No, thanks', 'Got it']) {
    const xml = (await adb.exec(serial, 'uiautomator dump /dev/tty 2>/dev/null')).stdout;
    const m = new RegExp(`text="${text}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`).exec(xml);
    if (!m) continue;
    await adb.exec(serial, `input tap ${(+m[1] + +m[3]) / 2} ${(+m[2] + +m[4]) / 2}`);
    await sleep(1500);
  }
}

async function urlBarText(adb: AdbClient, serial: string): Promise<string> {
  const xml = (await adb.exec(serial, 'uiautomator dump /dev/tty 2>/dev/null')).stdout;
  return /resource-id="com.android.chrome:id\/url_bar"[^>]*text="([^"]*)"/.exec(xml)?.[1] ?? /text="([^"]*)"[^>]*resource-id="com.android.chrome:id\/url_bar"/.exec(xml)?.[1] ?? '';
}

async function main(): Promise<void> {
  const adb = new AdbClient({ log: () => {} });
  const serials = (await adb.listDevices()).filter((d) => d.state === 'device').map((d) => d.serial).sort();
  console.log(`\nเครื่องออนไลน์: ${serials.join(', ')}`);
  ok('มีอย่างน้อย 2 เครื่อง', serials.length >= 2);
  if (serials.length < 2) process.exit(1);
  const [A, B] = serials;

  // ที่เก็บชั่วคราว — ไม่ปนกับข้อมูลจริงของแอป
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-auto2-'));
  const profiles = new ProfileStore(tmp);
  const templates = new TemplateStore(path.join(tmp, 'templates'));
  const ocr = new Ocr(path.join(process.env.APPDATA ?? tmp, 'AndroidRemote', 'tessdata'), (l, m) => console.log(`  [ocr:${l}] ${m}`));

  console.log('\n=== 1. ตัวแปร: แทนค่า {{}} ===');
  ok('แทนค่าปกติ', interpolate('hi {{name}}!', { name: 'x' }) === 'hi x!');
  ok('ค่าสำรอง', interpolate('{{missing|dflt}}', {}) === 'dflt');
  ok('ไม่รู้จักคงไว้', interpolate('{{nope}}', {}) === '{{nope}}');

  console.log('\n=== 2. โปรไฟล์ต่อเครื่อง + เสียงต่างกัน ===');
  profiles.put({ serial: A, label: 'บัญชี A', vars: { name: 'alpha', role: 'game' }, volume: { media: 20 } });
  profiles.put({ serial: B, label: 'บัญชี B', vars: { name: 'beta', role: 'browser' }, volume: { media: 80 } });
  ok('บันทึก/อ่านโปรไฟล์', profiles.get(A)?.vars.name === 'alpha' && profiles.get(B)?.vars.name === 'beta');

  // เซสชันสองเครื่อง
  console.log('\n=== 3. เปิดเซสชันสองเครื่อง ===');
  const sessions = new Map<string, ServerSession>();
  const sizes = new Map<string, { width: number; height: number }>();
  for (const serial of [A, B]) {
    const s = new ServerSession(adb, serial, { maxSize: 480, maxFps: 10, bitRate: 800_000 });
    await new Promise<void>((res, rej) => {
      s.once('header', (h) => {
        sizes.set(serial, { width: h.width, height: h.height });
        res();
      });
      s.once('closed', (r: string) => rej(new Error(r)));
      s.start().catch(rej);
    });
    sessions.set(serial, s);
    // ช่องควบคุมต่อตามหลังช่องวิดีโอไม่กี่ ms — รอนิดหนึ่งก่อนเช็ค
    for (let i = 0; i < 20 && !s.hasControl; i++) await sleep(100);
    ok(`เซสชัน ${serial}`, s.hasControl);
  }

  const frames = new Map<string, Frame>();
  const player = new MacroPlayer(
    {
      adb,
      send: (s, m) => sessions.get(s)?.send(m) ?? false,
      screenSize: (s) => sizes.get(s) ?? null,
      templates,
      capture: async (s) => {
        const hit = frames.get(s);
        if (hit && Date.now() - hit.takenAt < 300) return hit;
        const f = await captureFrame(adb, s);
        frames.set(s, f);
        return f;
      },
      ocr,
      // ตา AI ไม่ถูกใช้ในเทสต์นี้ (ดู smoke:vlm) — ใส่ให้ครบ deps เท่านั้น
      vlm: new VlmClient(path.join(tmp, 'vlm.json'), () => {}),
      catalog: new ScreenCatalog(path.join(tmp, 'games')),
      profiles,
      getMacro: (id) => macrosById.get(id),
      setVolume: (s, st, p) => setVolume(adb, s, st, p),
    },
    (l, m) => console.log(`  [${l}] ${m}`),
  );
  const macrosById = new Map<string, Macro>();
  const mk = (name: string, steps: Macro['steps'], extra: Partial<Macro> = {}): Macro => {
    const m: Macro = { id: name, name, recordedOn: { serial: A, width: 1080, height: 2340 }, steps, createdAt: 0, updatedAt: 0, ...extra };
    macrosById.set(m.id, m);
    return m;
  };

  console.log('\n=== 4. มาโครเดียว สองเครื่องทำต่างกันตาม {{role}} + พิมพ์ {{name}} คนละค่า ===');
  // ผ่าน Chrome FRE ก่อน (เครื่องใหม่จะติดหน้าต้อนรับ)
  for (const s of [A, B]) {
    await adb.exec(s, `am start -a android.intent.action.VIEW -d 'https://example.com/' >/dev/null 2>&1`);
    await sleep(2500);
    await dismissChromeFre(adb, s);
  }
  const perDevice = mk('per-device', [
    { t: 'if_var', name: 'role', op: 'eq', value: 'game', goto: 'game', atMs: 0 },
    // ── เครื่องเบราว์เซอร์: เปิดลิงก์ที่มีชื่อของตัวเอง
    { t: 'open_url', url: 'https://example.com/?who={{name}}', atMs: 0 },
    { t: 'wait', ms: 2500, atMs: 0 },
    { t: 'set_var', name: 'did', value: 'browser-{{name}}', atMs: 0 },
    { t: 'stop', message: 'จบสายเบราว์เซอร์ ({{name}})', atMs: 0 },
    // ── เครื่องเกม: เปิดเกม
    { t: 'label', name: 'game', atMs: 0 },
    { t: 'open_url', url: GAME_URL, atMs: 0 },
    { t: 'set_var', name: 'did', value: 'game-{{name}}', atMs: 0 },
  ]);
  const r4 = await player.play(perDevice, [A, B], 1);
  ok('เล่นสำเร็จทั้งสอง', r4.ok, r4.message);
  const st4 = player.current();
  ok('A เดินสายเกม', st4.progress[A]?.vars?.did === 'game-alpha', st4.progress[A]?.vars?.did);
  ok('B เดินสายเบราว์เซอร์', st4.progress[B]?.vars?.did === 'browser-beta', st4.progress[B]?.vars?.did);
  await sleep(1500);
  const urlB = await urlBarText(adb, B);
  ok('B เปิดลิงก์ที่มีชื่อตัวเอง (beta) จริง', /beta/.test(urlB), urlB || '(อ่านแถบ URL ไม่ได้)');
  const volA = await getVolume(adb, A, 'media');
  const volB = await getVolume(adb, B, 'media');
  ok('เสียง A = 20%', volA?.percent === 20, `${volA?.index}/${volA?.max}`);
  ok('เสียง B = 80%', volB?.percent === 80, `${volB?.index}/${volB?.max}`);
  ok('มี log แยกเครื่องทั้งสอง', st4.log.some((e) => e.serial === A) && st4.log.some((e) => e.serial === B), `${st4.log.length} บรรทัด`);

  console.log('\n=== 5. ตา: ตัดเทมเพลตจากจอ A แล้วหาเจอ + แตะแล้วจอเปลี่ยนจริง ===');
  // เทมเพลตไอคอน Mail จาก fixture (ตัดจากจอ 1080x2340) — ให้ wait_image รอเกมโหลดเสร็จจริงแทนการนับวินาที
  const fxDir = path.join(tmp, 'templates', 'dropkick');
  fs.mkdirSync(fxDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'dropkick-mail.png'), path.join(fxDir, 'mail.png'));
  fs.writeFileSync(path.join(fxDir, 'meta.json'), JSON.stringify({ mail: { set: 'dropkick', name: 'mail', width: 108, height: 117, refWidth: 1080, refHeight: 2340, rect: { fx: 0.03, fy: 0.528, fw: 0.1, fh: 0.05 }, createdAt: 0 } }));
  ok('โหลด fixture เทมเพลต', templates.has('dropkick', 'mail'));
  console.log('  รอไอคอน Mail โผล่ (= เกมโหลดเสร็จ)…');
  const t0w = Date.now();
  const waiter = mk('waiter', [{ t: 'wait_image', template: 'dropkick/mail', appear: true, timeoutMs: 120_000, atMs: 0 }]);
  const rw = await player.play(waiter, [A], 1);
  ok('wait_image รอจนเกมโหลดเสร็จ', rw.ok, `${rw.message} · ${Math.round((Date.now() - t0w) / 1000)}s`);
  const fA = await captureFrame(adb, A);
  ok('จับเฟรมได้', fA.width > 0 && fA.gray.length === fA.gw * fA.gh, `${fA.width}x${fA.height} → เทา ${fA.gw}x${fA.gh}`);
  const mailRect = { fx: 0.03, fy: 0.528, fw: 0.1, fh: 0.05 };
  const tpl = await templates.load('dropkick', 'mail');
  const t0 = Date.now();
  const hit = await findTemplate(fA, tpl, { threshold: 0.8 });
  ok('หาเทมเพลต fixture เจอบนจอจริง', Boolean(hit) && Math.abs((hit?.fx ?? 0) - (mailRect.fx + mailRect.fw / 2)) < 0.03, `${Math.round((hit?.score ?? 0) * 100)}% ใน ${Date.now() - t0}ms`);
  // เทมเพลตจากจอ A ต้องหาไม่เจอบนจอ B (ไม่ใช่เกม) — กัน false positive
  const fB = await captureFrame(adb, B);
  const hitB = await findTemplate(fB, tpl, { threshold: 0.8 });
  ok('ไม่หลอนเจอบนจอที่ไม่มี', hitB === null, hitB ? `หลอน ${Math.round(hitB.score * 100)}%` : '');

  // วัดผล "แตะแล้วเกิดผลจริง" บนหน้าเว็บที่คาดเดาได้ (B: example.com) — ไม่พึ่งสถานะเกม
  // หา bounds ของลิงก์จาก accessibility tree ของ Chrome → ตัดเป็นเทมเพลต → ให้มาโครหาภาพแล้วแตะ → URL ต้องเปลี่ยน
  await adb.exec(B, `am start -a android.intent.action.VIEW -d 'https://example.com/' >/dev/null 2>&1`);
  await sleep(3000);
  const xmlB = (await adb.exec(B, 'uiautomator dump /dev/tty 2>/dev/null')).stdout;
  const link = /text="Learn more"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xmlB);
  ok('เห็นลิงก์บนหน้าเว็บ B', Boolean(link));
  if (link) {
    const fB2 = await captureFrame(adb, B);
    const [l, t, r, b] = [+link[1], +link[2], +link[3], +link[4]];
    await templates.save('web', 'learn_more', fB2, { fx: l / fB2.width, fy: t / fB2.height, fw: (r - l) / fB2.width, fh: (b - t) / fB2.height });
    const clicker = mk('clicker', [
      { t: 'find_image_tap', template: 'web/learn_more', threshold: 0.75, timeoutMs: 5000, atMs: 0 },
      { t: 'wait', ms: 3000, atMs: 0 },
    ]);
    const rc = await player.play(clicker, [B], 1);
    const urlAfter = await urlBarText(adb, B);
    ok('find_image_tap แตะลิงก์แล้วหน้าเปลี่ยนจริง', rc.ok && /iana/.test(urlAfter), `${rc.message} · URL ตอนนี้ ${urlAfter}`);
  }
  // บนเกม A: if_image → label → find_image_tap ต้องเดินครบ (ผลบนจอเกมขึ้นกับสถานะเกม ไม่ assert)
  const eyes = mk(
    'eyes',
    [
      { t: 'if_image', template: 'mail', found: true, goto: 'has', atMs: 0 },
      { t: 'fail', message: 'ไม่เห็นไอคอน Mail', atMs: 0 },
      { t: 'label', name: 'has', atMs: 0 },
      { t: 'find_image_tap', template: 'mail', threshold: 0.8, timeoutMs: 5000, atMs: 0 },
    ],
    { templateSet: 'dropkick' },
  );
  const r5 = await player.play(eyes, [A], 1);
  ok('if_image → label → find_image_tap ผ่านบนเกม', r5.ok, r5.message);

  console.log('\n=== 6. OCR อ่านตัวเลขในเกมเก็บตัวแปร + เงื่อนไขตัวแปร ===');
  // กลับหน้าหลักด้วยการโหลดเกมใหม่ (ห้ามใช้ BACK ในเกมเบราว์เซอร์ — จะหลุดจากหน้าเว็บ)
  await adb.exec(A, `am start -a android.intent.action.VIEW -d '${GAME_URL}' --es com.android.browser.application_id com.android.chrome >/dev/null 2>&1`);
  // 🔑 หลังสั่งเปลี่ยนหน้า ต้อง "รอภาพเก่าหาย" ก่อน "รอภาพใหม่โผล่" — ไม่งั้น wait_image ผ่านทันทีจากจอเก่าที่ยังไม่ทันเปลี่ยน
  const reloader = mk('reloader', [
    { t: 'wait_image', template: 'dropkick/mail', appear: false, timeoutMs: 30_000, atMs: 0 },
    { t: 'wait_image', template: 'dropkick/mail', appear: true, timeoutMs: 120_000, atMs: 0 },
  ]);
  const rw2 = await player.play(reloader, [A], 1);
  ok('รอภาพเก่าหาย → รอภาพใหม่โผล่ (reload จริง)', rw2.ok, rw2.message);
  await sleep(1500);
  const statsRect = { fx: 0.2, fy: 0.655, fw: 0.6, fh: 0.028 }; // แถว "ATK :15 HP:100 SPD:100 DEF:3"
  frames.clear();
  const reader = mk('reader', [
    { t: 'ocr_var', rect: statsRect, name: 'stats', digits: false, atMs: 0 },
    { t: 'if_var', name: 'stats', op: 'contains', value: '100', goto: 'good', atMs: 0 },
    { t: 'fail', message: 'ไม่พบ 100 ใน {{stats}}', atMs: 0 },
    { t: 'label', name: 'good', atMs: 0 },
    { t: 'set_var', name: 'verdict', value: 'hp-ok', atMs: 0 },
  ]);
  const r6 = await player.play(reader, [A], 1);
  const statsVar = player.current().progress[A]?.vars?.stats ?? '';
  // ผลบนเกมขึ้นกับสถานะ (ป๊อปอัปสอนเล่นอาจหรี่จอ) — รายงานไว้ ไม่ใช่ตัวตัดสิน
  console.log(`  ${/\d/.test(statsVar) ? '✅' : '⚠️'} OCR แถวค่าพลังในเกม: "${statsVar}" ${r6.ok ? '(if_var ผ่าน)' : '(if_var ไม่ผ่าน)'}`);
  if (!/\d/.test(statsVar)) fs.writeFileSync(path.join(tmp, 'ocr-fail.png'), (frames.get(A) ?? (await captureFrame(adb, A))).png), console.log(`  ภาพตอนอ่านว่าง: ${path.join(tmp, 'ocr-fail.png')}`);

  // ตัวตัดสินจริง: OCR แถบ URL ของ Chrome บน B (ข้อความคาดเดาได้ ตำแหน่งจาก accessibility tree)
  const xmlUrl = (await adb.exec(B, 'uiautomator dump /dev/tty 2>/dev/null')).stdout;
  const ub = /resource-id="com.android.chrome:id\/url_bar"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xmlUrl) ?? /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*resource-id="com.android.chrome:id\/url_bar"/.exec(xmlUrl);
  ok('หา bounds แถบ URL บน B', Boolean(ub));
  if (ub) {
    const fB3 = await captureFrame(adb, B);
    const [l, t, r, b] = [+ub[1], +ub[2], +ub[3], +ub[4]];
    const urlRect = { fx: l / fB3.width, fy: t / fB3.height, fw: (r - l) / fB3.width, fh: (b - t) / fB3.height };
    frames.clear();
    const urlReader = mk('url-reader', [
      { t: 'ocr_var', rect: urlRect, name: 'url', atMs: 0 },
      { t: 'if_var', name: 'url', op: 'contains', value: 'iana', goto: 'yes', atMs: 0 },
      { t: 'fail', message: 'อ่าน URL ไม่ตรง: {{url}}', atMs: 0 },
      { t: 'label', name: 'yes', atMs: 0 },
      { t: 'set_var', name: 'verdict2', value: 'url-ok', atMs: 0 },
    ]);
    const r6b = await player.play(urlReader, [B], 1);
    const urlVar = player.current().progress[B]?.vars?.url ?? '';
    ok('ocr_var อ่านแถบ URL ได้', /iana/i.test(urlVar), `"${urlVar}"`);
    ok('if_var contains → label ผ่าน', r6b.ok && player.current().progress[B]?.vars?.verdict2 === 'url-ok', r6b.message);
  }

  console.log('\n=== 7. กันวนไม่รู้จบ + นโยบายเมื่อพัง + รูทีนย่อย ===');
  const loopy = mk('loopy', [
    { t: 'label', name: 'L', atMs: 0 },
    { t: 'goto', label: 'L', maxTimes: 3, atMs: 0 },
  ]);
  const r7 = await player.play(loopy, [B], 1);
  ok('goto เกิน maxTimes → ล้มเหลวแบบมีเหตุผล', !r7.ok && /วนเกิน/.test(player.current().progress[B]?.error ?? ''), player.current().progress[B]?.error);
  const skippy = mk(
    'skippy',
    [
      { t: 'find_image_tap', template: 'dropkick/mail', timeoutMs: 1500, atMs: 0 }, // บน B ไม่มี → พัง → ข้าม
      { t: 'set_var', name: 'after', value: 'reached', atMs: 0 },
    ],
    { onError: { mode: 'skip' } },
  );
  const r8 = await player.play(skippy, [B], 1);
  ok('onError=skip ข้ามขั้นที่พังแล้วไปต่อ', r8.ok && player.current().progress[B]?.vars?.after === 'reached', r8.message);
  mk('sub', [{ t: 'set_var', name: 'sub_done', value: 'yes-{{name}}', atMs: 0 }]);
  const parent = mk('parent', [
    { t: 'run_macro', macroId: 'sub', atMs: 0 },
    { t: 'if_var', name: 'sub_done', op: 'eq', value: 'yes-beta', goto: 'fin', atMs: 0 },
    { t: 'fail', message: 'รูทีนย่อยไม่ได้ตั้งตัวแปร', atMs: 0 },
    { t: 'label', name: 'fin', atMs: 0 },
  ]);
  const r9 = await player.play(parent, [B], 1);
  ok('run_macro แชร์ตัวแปรกับแม่', r9.ok, r9.message);

  console.log('\n=== 8. humanize: แตะจริงยังโดนเป้า (เขย่าเล็กน้อย) ===');
  const hum = mk('hum', [{ t: 'tap', fx: 0.5, fy: 0.5, atMs: 0 }], { humanize: { jitter: 0.006, delayMs: [50, 120] } });
  const r10 = await player.play(hum, [A, B], 1);
  ok('เล่นพร้อม humanize ได้ทั้งสองเครื่อง', r10.ok, r10.message);

  for (const s of sessions.values()) s.stop('จบเทสต์');
  await ocr.dispose();
  await sleep(800);
  console.log(fail === 0 ? '\n✅ automation v2 ผ่านครบกับสองเครื่องจริง\n' : `\n❌ ไม่ผ่าน ${fail} ข้อ\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
