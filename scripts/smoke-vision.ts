/**
 * ทดสอบ "ตา AI" กับเครื่องจริง — โมเดลภาพผ่าน Ollama + แค็ตตาล็อกหน้าจอ + ขั้นตอนมาโคร AI
 * รันด้วย: npm run smoke:vlm
 *
 * ต้องมี: Ollama รันอยู่ + โมเดล (ค่าเริ่มต้น qwen3-vl:4b) + เครื่องออนไลน์ 1 เครื่อง
 * ทุกข้อวัดผลกับความจริงที่รู้จากทางอื่น (uiautomator บอกตำแหน่งลิงก์ · แถบ URL เปลี่ยนจริงหลังแตะ)
 * ไม่ใช่แค่ "โมเดลตอบอะไรสักอย่าง"
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdbClient } from '../src/main/adb/AdbClient';
import { ServerSession } from '../src/main/server/ServerSession';
import { MacroPlayer } from '../src/main/automation/Macros';
import { ProfileStore } from '../src/main/automation/Profiles';
import { TemplateStore } from '../src/main/vision/templates';
import { Ocr } from '../src/main/vision/ocr';
import { captureFrame, dhash, hammingHex, type Frame } from '../src/main/vision/capture';
import { VlmClient, bboxToRect, parseJson } from '../src/main/vision/vlm';
import { ScreenCatalog } from '../src/main/vision/catalog';
import { setVolume } from '../src/main/device/volume';
import type { FracRect, Macro } from '../src/shared/automation';

let fail = 0;
const ok = (label: string, pass: boolean, extra = ''): void => {
  if (!pass) fail++;
  console.log(`  ${pass ? '✅' : '❌'} ${label.padEnd(54)} ${extra}`);
};
const soft = (label: string, pass: boolean, extra = ''): void => console.log(`  ${pass ? '✅' : '⚠️'} ${label.padEnd(54)} ${extra}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const GAME_URL = 'https://h5.g123.jp/game/jya?lang=en&platform=g123';
const center = (r: FracRect): { x: number; y: number } => ({ x: r.fx + r.fw / 2, y: r.fy + r.fh / 2 });
const inside = (p: { x: number; y: number }, r: FracRect, tol = 0.02): boolean => p.x >= r.fx - tol && p.x <= r.fx + r.fw + tol && p.y >= r.fy - tol && p.y <= r.fy + r.fh + tol;

async function uiBounds(adb: AdbClient, serial: string, pattern: RegExp): Promise<FracRect | null> {
  const xml = (await adb.exec(serial, 'uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml')).stdout;
  const m = pattern.exec(xml);
  if (!m) return null;
  const [l, t, r, b] = [+m[1], +m[2], +m[3], +m[4]];
  const size = /bounds="\[0,0\]\[(\d+),(\d+)\]"/.exec(xml);
  const W = size ? +size[1] : 1080;
  const H = size ? +size[2] : 2340;
  return { fx: l / W, fy: t / H, fw: (r - l) / W, fh: (b - t) / H };
}
async function urlBarText(adb: AdbClient, serial: string): Promise<string> {
  const xml = (await adb.exec(serial, 'uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml')).stdout;
  return /resource-id="com.android.chrome:id\/url_bar"[^>]*text="([^"]*)"/.exec(xml)?.[1] ?? /text="([^"]*)"[^>]*resource-id="com.android.chrome:id\/url_bar"/.exec(xml)?.[1] ?? '';
}
async function openUrl(adb: AdbClient, serial: string, url: string): Promise<void> {
  await adb.exec(serial, `am start -a android.intent.action.VIEW -d '${url}' --es com.android.browser.application_id com.android.chrome >/dev/null 2>&1`);
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-vlm-'));
  const logv = (l: string, m: string): void => console.log(`  [vlm:${l}] ${m}`);
  const vlm = new VlmClient(path.join(tmp, 'vlm.json'), logv);
  const catalog = new ScreenCatalog(path.join(tmp, 'games'));

  console.log('\n=== 1. ตัวช่วยล้วน (ไม่ต้องมีอะไร) ===');
  ok('parseJson ถอด ```json ครอบ', (parseJson('```json\n{"a":1}\n```') as { a: number })?.a === 1);
  ok('parseJson ข้ามคำอธิบายนำหน้า', (parseJson('Sure! {"found":true} ok') as { found: boolean })?.found === true);
  const r1 = bboxToRect([200, 420, 403, 437], 540, 1170);
  ok('bbox 0-1000 → สัดส่วน', Boolean(r1) && Math.abs(r1!.fx - 0.2) < 1e-6 && Math.abs(r1!.fw - 0.203) < 1e-6);
  const r2 = bboxToRect([100, 1100, 300, 1160], 540, 1170);
  ok('bbox เกิน 1000 = พิกเซลของภาพที่ส่ง', Boolean(r2) && Math.abs(r2!.fy - 1100 / 1170) < 1e-6);
  ok('bbox กลับด้าน/ไม่ครบ → null หรือจัดลำดับใหม่', bboxToRect([1, 2], 540, 1170) === null && (bboxToRect([400, 300, 200, 100], 540, 1170)?.fx ?? 1) === 0.2);
  const fakeEntry = { id: 'x', set: 's', name: 'lobby', hashes: [], elements: [{ label: 'Mail', kind: 'icon', rect: { fx: 0, fy: 0, fw: 0.1, fh: 0.1 } }, { label: 'Close X', kind: 'close', rect: { fx: 0.9, fy: 0, fw: 0.1, fh: 0.1 }, aliases: ['ปุ่มปิด'] }], seen: 1, firstSeenAt: 0, lastSeenAt: 0, source: 'vlm' as const };
  ok('findElement: คำเรียกที่เคยใช้ (alias)', catalog.findElement(fakeEntry, 'ปุ่มปิด')?.label === 'Close X');
  ok('findElement: คำใกล้เคียง "mail icon" → Mail', catalog.findElement(fakeEntry, 'mail icon')?.label === 'Mail');
  ok('findElement: ไม่มี → null', catalog.findElement(fakeEntry, 'shop button') === null);

  console.log('\n=== 2. Ollama + โมเดล ===');
  const st = await vlm.status();
  ok('Ollama ตอบ + มีโมเดล', st.ok, st.message);
  if (!st.ok) {
    console.log('\n❌ ต้องเปิด Ollama และดึงโมเดลก่อน\n');
    process.exit(1);
  }
  console.log(`  โมเดล ${st.settings.model} · thinking=${st.thinking} · มีทั้งหมด ${st.models.length} โมเดล`);

  const adb = new AdbClient({ log: () => {} });
  const serials = (await adb.listDevices()).filter((d) => d.state === 'device').map((d) => d.serial).sort();
  ok('มีเครื่องออนไลน์', serials.length >= 1, serials.join(', '));
  if (serials.length === 0) process.exit(1);
  const A = serials[0];

  console.log('\n=== 3. หาพิกัดเทียบความจริงจาก uiautomator (example.com) ===');
  await openUrl(adb, A, 'https://example.com/');
  await sleep(3500);
  const linkRect = await uiBounds(adb, A, /content-desc="Learn more"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  ok('uiautomator เห็นลิงก์ Learn more', Boolean(linkRect));
  const fWeb = await captureFrame(adb, A);
  const t0 = Date.now();
  const loc = await vlm.locate(fWeb, 'Learn more link');
  ok('AI หา "Learn more link" เจอ', loc.found, `${loc.tookMs}ms · "${loc.label ?? ''}"`);
  ok('จุดกึ่งกลางที่ AI ตอบอยู่ในกรอบจริง', Boolean(loc.rect && linkRect) && inside(center(loc.rect!), linkRect!), loc.rect ? `AI (${(center(loc.rect).x * 100).toFixed(1)}, ${(center(loc.rect).y * 100).toFixed(1)})% จริง (${((linkRect!.fx + linkRect!.fw / 2) * 100).toFixed(1)}, ${((linkRect!.fy + linkRect!.fh / 2) * 100).toFixed(1)})%` : '');
  const notThere = await vlm.locate(fWeb, 'a red shopping cart icon');
  ok('ของที่ไม่มี → ไม่เจอ (ไม่หลอน)', !notThere.found, `${notThere.tookMs}ms`);
  console.log(`  (สองคำถาม ${Date.now() - t0}ms รวม)`);

  console.log('\n=== 4. อ่านทั้งหน้า + แค็ตตาล็อกจำได้ไม่ถามซ้ำ ===');
  const d = await vlm.describe(fWeb);
  ok('ตั้งชื่อหน้าได้', d.screen.length > 0, `"${d.screen}" ${d.tookMs}ms`);
  ok('เห็นปุ่ม/ลิงก์อย่างน้อย 2 ชิ้น', d.elements.length >= 2, d.elements.map((e) => e.label).join(', '));
  const learnEl = d.elements.find((e) => /learn/i.test(e.label));
  ok('ในรายการมี Learn more และตำแหน่งถูก', Boolean(learnEl && linkRect) && inside(center(learnEl!.rect), linkRect!));

  const entry = await catalog.learn('web', fWeb, vlm);
  ok('บันทึกเข้าแค็ตตาล็อก', catalog.list('web').length === 1 && entry.hashes.length === 1, `id ${entry.id}`);
  const t1 = Date.now();
  const idSame = await catalog.identify('web', fWeb);
  ok('เฟรมเดิม → จำได้ทันที ไม่ถามโมเดล', idSame.entry?.id === entry.id && idSame.distance === 0 && Date.now() - t1 < 500, `${Date.now() - t1}ms`);
  const fWeb2 = await captureFrame(adb, A);
  const idAgain = await catalog.identify('web', fWeb2);
  ok('ถ่ายใหม่หน้าเดิม → ยังจำได้', idAgain.entry?.id === entry.id, `ต่าง ${idAgain.distance} บิต`);
  ok('หาปุ่มจากความจำ', Boolean(catalog.findElement(entry, 'learn more link')));
  ok('ไฟล์ screens.json + thumb มีจริง', fs.existsSync(path.join(tmp, 'games', 'web', 'screens.json')) && fs.existsSync(path.join(tmp, 'games', 'web', 'thumbs', `${entry.id}.jpg`)));

  console.log('\n=== 5. ขั้นตอนมาโคร AI บนเครื่องจริง ===');
  const s = new ServerSession(adb, A, { maxSize: 480, maxFps: 10, bitRate: 800_000 });
  const size = await new Promise<{ width: number; height: number }>((res, rej) => {
    s.once('header', (h) => res({ width: h.width, height: h.height }));
    s.once('closed', (r: string) => rej(new Error(r)));
    s.start().catch(rej);
  });
  for (let i = 0; i < 20 && !s.hasControl; i++) await sleep(100);
  ok('เซสชันควบคุม', s.hasControl);

  const frames = new Map<string, Frame>();
  const macros = new Map<string, Macro>();
  const player = new MacroPlayer(
    {
      adb,
      send: (_s, m) => s.send(m),
      screenSize: () => size,
      templates: new TemplateStore(path.join(tmp, 'templates')),
      capture: async (serial) => {
        const hit = frames.get(serial);
        if (hit && Date.now() - hit.takenAt < 300) return hit;
        const f = await captureFrame(adb, serial);
        frames.set(serial, f);
        return f;
      },
      ocr: new Ocr(path.join(process.env.APPDATA ?? tmp, 'AndroidRemote', 'tessdata'), () => {}),
      vlm,
      catalog,
      profiles: new ProfileStore(tmp),
      getMacro: (id) => macros.get(id),
      setVolume: (serial, st2, p) => setVolume(adb, serial, st2, p),
    },
    (l, m) => console.log(`  [${l}] ${m}`),
  );
  const mk = (name: string, steps: Macro['steps'], extra: Partial<Macro> = {}): Macro => {
    const m: Macro = { id: name, name, recordedOn: { serial: A, width: size.width, height: size.height }, steps, createdAt: 0, updatedAt: 0, templateSet: 'web', ...extra };
    macros.set(m.id, m);
    return m;
  };

  // vlm_tap ครั้งแรก: หน้าจำได้แล้ว (จากข้อ 4) ปุ่มอยู่ในความจำ → ต้องไม่ถามโมเดล และแตะแล้ว URL เปลี่ยนจริง
  frames.clear();
  const tapper = mk('tapper', [
    { t: 'vlm_tap', query: 'Learn more link', timeoutMs: 40_000, atMs: 0 },
    { t: 'wait', ms: 3500, atMs: 0 },
  ]);
  const tt = Date.now();
  const rt = await player.play(tapper, [A], 1);
  const viaMemory = player.current().log.some((e) => /จำได้/.test(e.message));
  const urlAfter = await urlBarText(adb, A);
  ok('vlm_tap แตะลิงก์แล้วหน้าเปลี่ยนจริง (iana.org)', rt.ok && /iana/.test(urlAfter), `${rt.message} · URL "${urlAfter}" · ${Date.now() - tt}ms`);
  ok('แตะจากความจำ ไม่ถามโมเดล', viaMemory, viaMemory ? 'log: จำได้' : 'log ไม่มี "จำได้"');

  // หน้าใหม่ (iana) ยังไม่รู้จัก → screen_var ต้องให้โมเดลตั้งชื่อ + จำ → แค็ตตาล็อกมี 2 หน้า
  frames.clear();
  const namer = mk('namer', [{ t: 'screen_var', name: 'scr', atMs: 0 }]);
  const rn = await player.play(namer, [A], 1);
  const scr = player.current().progress[A]?.vars?.scr ?? '';
  ok('screen_var บนหน้าใหม่ → โมเดลตั้งชื่อ', rn.ok && scr.length > 0, `"${scr}"`);
  ok('แค็ตตาล็อกเพิ่มเป็น 2 หน้า', catalog.list('web').length === 2);

  // if_screen / wait_screen ใช้ชื่อที่เพิ่งจำ → ต้องผ่านจากความจำ (เร็ว)
  frames.clear();
  const firstWord = scr.split(/\s+/)[0];
  const brancher = mk('brancher', [
    { t: 'if_screen', screen: firstWord, found: true, goto: 'yes', atMs: 0 },
    { t: 'fail', message: 'if_screen ไม่ตรงทั้งที่ชื่อ "{{scr}}"', atMs: 0 },
    { t: 'label', name: 'yes', atMs: 0 },
    { t: 'wait_screen', screen: `/${firstWord}/i`, timeoutMs: 20_000, atMs: 0 },
    { t: 'if_screen', screen: 'zzz-no-such-screen', found: false, goto: 'done', atMs: 0 },
    { t: 'fail', message: 'if_screen found=false ไม่กระโดด', atMs: 0 },
    { t: 'label', name: 'done', atMs: 0 },
    { t: 'set_var', name: 'ok', value: '1', atMs: 0 },
  ]);
  const tb = Date.now();
  const rb = await player.play(brancher, [A], 1);
  ok('if_screen → wait_screen → if_screen(ไม่ใช่) เดินครบ', rb.ok && player.current().progress[A]?.vars?.ok === '1', `${rb.message} · ${Date.now() - tb}ms`);
  ok('เดินจากความจำ เร็วกว่า 3 วิ (ไม่ถามโมเดล)', Date.now() - tb < 3000);

  // vlm_var: ถามอะไรที่รู้คำตอบ
  await openUrl(adb, A, 'https://example.com/');
  await sleep(3000);
  frames.clear();
  const asker = mk('asker', [{ t: 'vlm_var', question: 'What is the large heading text on this page? Reply with the text only.', name: 'heading', atMs: 0 }]);
  const ra = await player.play(asker, [A], 1);
  const heading = player.current().progress[A]?.vars?.heading ?? '';
  ok('vlm_var อ่านหัวข้อหน้าได้', ra.ok && /example/i.test(heading), `"${heading}"`);

  console.log('\n=== 6. เกมจริง (canvas — ไม่มีโครง UI) ===');
  // จอเกมคือเป้าหมายจริง: ให้ AI ตั้งชื่อหน้า + จำ แล้ว vlm_tap ปุ่มที่บรรยาย — วัดว่าจอเปลี่ยนจริง
  const fx = path.join(__dirname, 'fixtures', 'dropkick-mail.png');
  const templates = new TemplateStore(path.join(tmp, 'templates'));
  fs.mkdirSync(path.join(tmp, 'templates', 'dropkick'), { recursive: true });
  fs.copyFileSync(fx, path.join(tmp, 'templates', 'dropkick', 'mail.png'));
  fs.writeFileSync(path.join(tmp, 'templates', 'dropkick', 'meta.json'), JSON.stringify({ mail: { set: 'dropkick', name: 'mail', width: 108, height: 117, refWidth: 1080, refHeight: 2340, rect: { fx: 0.03, fy: 0.528, fw: 0.1, fh: 0.05 }, createdAt: 0 } }));
  await openUrl(adb, A, GAME_URL);
  frames.clear();
  const loader = mk('loader', [{ t: 'wait_image', template: 'dropkick/mail', appear: true, timeoutMs: 120_000, atMs: 0 }], { templateSet: 'dropkick' });
  console.log('  รอเกมโหลด (ไอคอน Mail)…');
  const rl = await player.play(loader, [A], 1);
  if (!rl.ok || !templates.has('dropkick', 'mail')) {
    soft('เกมโหลดไม่ทัน/ไม่ถึงหน้าหลัก — ข้ามการทดสอบเกม', false, rl.message);
  } else {
    frames.clear();
    const fGame = await captureFrame(adb, A);
    const gEntry = await catalog.learn('dropkick', fGame, vlm);
    ok('AI ตั้งชื่อหน้าเกม + เห็นปุ่ม', gEntry.name.length > 0 && gEntry.elements.length >= 3, `"${gEntry.name}" ${gEntry.elements.length} ปุ่ม: ${gEntry.elements.slice(0, 8).map((e) => e.label).join(', ')}`);
    const mailEl = gEntry.elements.find((e) => /mail|letter|envelope|message|inbox/i.test(e.label));
    soft('ในรายการมีไอคอน Mail ตำแหน่งตรง fixture', Boolean(mailEl) && inside(center(mailEl!.rect), { fx: 0.03, fy: 0.528, fw: 0.1, fh: 0.05 }, 0.04), mailEl ? `"${mailEl.label}" (${(center(mailEl.rect).x * 100).toFixed(0)}, ${(center(mailEl.rect).y * 100).toFixed(0)})%` : 'ไม่มีในรายการ');
    const before = fGame.gray;
    frames.clear();
    const gt = mk('game-tap', [
      { t: 'vlm_tap', query: 'mail envelope icon on the left side', timeoutMs: 60_000, atMs: 0 },
      { t: 'wait', ms: 2500, atMs: 0 },
    ], { templateSet: 'dropkick' });
    const rg = await player.play(gt, [A], 1);
    const after = await captureFrame(adb, A);
    let diff = 0;
    for (let i = 0; i < before.length && i < after.gray.length; i++) diff += Math.abs(before[i] - after.gray[i]);
    diff /= Math.min(before.length, after.gray.length);
    ok('vlm_tap บนจอเกม แตะแล้วจอเปลี่ยนจริง', rg.ok && diff > 8, `${rg.message} · จอต่าง ${diff.toFixed(1)}/255`);
    const h0 = await dhash(fGame.png);
    const h1 = await dhash(after.png);
    console.log(`  dHash หน้าหลัก ${h0} → หลังแตะ ${h1} (ต่าง ${hammingHex(h0, h1)} บิต)`);
    // กลับหน้าหลักด้วยการโหลดเกมใหม่ (ห้าม BACK ในเกมเบราว์เซอร์)
    await openUrl(adb, A, GAME_URL);
  }

  s.stop('จบเทสต์');
  await sleep(500);
  console.log(fail === 0 ? '\n✅ ตา AI ผ่านครบกับเครื่องจริง\n' : `\n❌ ไม่ผ่าน ${fail} ข้อ\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
