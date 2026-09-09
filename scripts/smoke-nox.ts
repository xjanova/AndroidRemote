/**
 * ทดสอบตัวจัดการ Nox กับ NoxConsole จริง
 * รันด้วย: npm run smoke:nox
 *
 * สร้างเครื่องทดสอบ → ตรวจว่าอยู่ในลิสต์ → ลบทิ้ง → ตรวจว่าหายจริง
 * ไม่แตะเครื่องอื่นที่มีอยู่ (เทียบ before/after)
 *
 * ⚠ สร้างเครื่อง Nox จริงกินเวลาและพื้นที่ (~1-2GB) — เป็นการทดสอบกับของจริง
 *   ตั้ง systemtype ต่ำสุด (5) เพื่อให้เบาและเร็วที่สุด แล้วลบทันที
 */

import { EmulatorManager } from '../src/main/emulator/EmulatorManager';
import { findAdb } from '../src/main/adb/AdbClient';

let failures = 0;
function check(label: string, ok: boolean, extra = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(40)} ${extra}`);
}

const TEST_NAME = `AR_smoke_${Date.now().toString().slice(-6)}`;

async function main(): Promise<void> {
  const mgr = new EmulatorManager(findAdb(), (l, m) => console.log(`  [${l}] ${m}`));

  console.log('\n=== 1. provider พร้อมไหม ===');
  const state0 = await mgr.state();
  const nox = state0.providers.find((p) => p.brand === 'nox');
  check('เจอ provider Nox', Boolean(nox));
  check('Nox ติดตั้งในเครื่อง', nox?.available === true, nox?.cliPath ?? '');
  if (!nox?.available) {
    console.log('\n⚠ ไม่มี Nox ในเครื่องนี้ — ข้ามการทดสอบสร้าง/ลบ\n');
    process.exit(failures === 0 ? 0 : 1);
  }
  console.log(`  adb ของ Nox: ${nox.bundledAdbVersion ?? '?'} · ตรงกับเรา: ${nox.adbVersionMatches}`);
  check('รายงานรุ่น Android ที่สร้างได้', (nox.androidVersions?.length ?? 0) > 0, nox.androidVersions?.join('/'));

  const before = state0.instances.filter((i) => i.brand === 'nox').map((i) => i.id);
  console.log(`  เครื่อง Nox ที่มีอยู่ก่อน: ${before.length} เครื่อง`);

  console.log(`\n=== 2. สร้างเครื่องทดสอบ "${TEST_NAME}" (โคลนจากเครื่องเดิม — ใช้อิมเมจที่มีแน่นอน) ===`);
  const created = await mgr.create('nox', {
    name: TEST_NAME,
    androidVersion: '7',
    cloneFromId: before[0], // โคลนจากเครื่องแรกที่มีอยู่ ไม่เสี่ยง systemtype ที่ยังไม่โหลด
    width: 540,
    height: 960,
    dpi: 240,
    cpu: 1,
    memoryMb: 1024,
    randomizeIdentity: true,
  });
  check('create รายงานสำเร็จ', created.ok, created.message);

  console.log('\n=== 3. อยู่ในลิสต์จริงไหม ===');
  const state1 = await mgr.state();
  const testInstance = state1.instances.find((i) => i.name === TEST_NAME || i.id.includes('Nox'));
  const noxNow = state1.instances.filter((i) => i.brand === 'nox');
  check('เครื่องเพิ่มขึ้น 1', noxNow.length === before.length + 1, `ก่อน ${before.length} → ตอนนี้ ${noxNow.length}`);
  const target = state1.instances.find((i) => i.name === TEST_NAME);
  check('เจอเครื่องที่สร้างตามชื่อ', Boolean(target), target ? `${target.id} / ${target.name}` : '(ไม่เจอตามชื่อ)');

  console.log('\n=== 4. ลบทิ้ง ===');
  const removeId = target?.id ?? testInstance?.id;
  if (removeId) {
    const removed = await mgr.remove('nox', removeId);
    check('remove รายงานสำเร็จ', removed.ok, removed.message);
  } else {
    check('หา id เพื่อลบ', false, 'ไม่เจอเครื่องที่สร้าง — อาจต้องลบมือ');
  }

  console.log('\n=== 5. ยืนยันหายจริง เหลือเท่าเดิม ===');
  const state2 = await mgr.state();
  const noxAfter = state2.instances.filter((i) => i.brand === 'nox').map((i) => i.id);
  check('กลับมาเท่าก่อนทดสอบ', noxAfter.length === before.length, `ก่อน ${before.length} → หลัง ${noxAfter.length}`);
  check('ไม่มีเครื่องทดสอบหลงเหลือ', !state2.instances.some((i) => i.name === TEST_NAME));

  console.log(failures === 0 ? '\n✅ ตัวจัดการ Nox ผ่านครบวงกับของจริง\n' : `\n❌ ไม่ผ่าน ${failures} ข้อ — ตรวจว่ามีเครื่อง ${TEST_NAME} ค้างไหม\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n❌ ล้มเหลว:', err);
  process.exit(1);
});
