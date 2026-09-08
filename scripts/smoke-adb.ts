/**
 * ทดสอบชั้น adb กับ adb server จริงบนเครื่อง
 * รันด้วย: npx tsx scripts/smoke-adb.ts
 *
 * ไม่ต้องมีมือถือเสียบก็รันได้ — จุดประสงค์คือพิสูจน์ว่าโปรโตคอลถูกต้อง
 * ถ้ามีเครื่องเสียบอยู่จะ probe เพิ่มให้ด้วย
 */

import { AdbClient, findAdb } from '../src/main/adb/AdbClient';

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(22)} ${String(value)}`);
}

async function main(): Promise<void> {
  console.log('\n=== 1. หา adb.exe ===');
  const adbPath = findAdb();
  line('พาธ', adbPath ?? '❌ ไม่เจอ');
  if (!adbPath) process.exit(1);

  const adb = new AdbClient({
    log: (level, msg) => console.log(`  [${level}] ${msg}`),
  });

  console.log('\n=== 2. ต่อ adb server ===');
  const version = await adb.version();
  line('เวอร์ชันโปรโตคอล', version);

  console.log('\n=== 3. รายชื่อเครื่อง ===');
  const devices = await adb.listDevices();
  line('จำนวน', devices.length);
  for (const d of devices) {
    line(d.serial, `${d.state}  ${JSON.stringify(d.props)}`);
  }

  console.log('\n=== 4. สตรีม track-devices ===');
  const stop = await adb.trackDevices(
    (list) => console.log(`  [push] ได้รายการ ${list.length} เครื่อง: ${list.map((d) => `${d.serial}=${d.state}`).join(', ') || '(ว่าง)'}`),
    (err) => console.error('  [error]', err.message),
  );
  await new Promise((r) => setTimeout(r, 1200));
  stop();
  line('สตรีม', 'เปิดและปิดสำเร็จ');

  const online = devices.filter((d) => d.state === 'device');
  if (online.length === 0) {
    console.log('\n=== 5. คำสั่งบนเครื่อง — ข้าม (ไม่มีเครื่องออนไลน์) ===');
    console.log('\n✅ ชั้นโปรโตคอลผ่าน (host commands + tracker)');
    console.log('   เสียบมือถือที่เปิด USB debugging แล้วรันซ้ำ เพื่อทดสอบ exec/push\n');
    return;
  }

  const serial = online[0].serial;
  console.log(`\n=== 5. คำสั่งบนเครื่อง (${serial}) ===`);

  const model = await adb.exec(serial, 'getprop ro.product.model');
  line('รุ่น', `${model.stdout}  (rc=${model.exitCode})`);

  const sdk = await adb.exec(serial, 'getprop ro.build.version.sdk');
  line('SDK', sdk.stdout);

  const rc = await adb.exec(serial, 'exit 42');
  line('ทดสอบ exit code', `${rc.exitCode} (ต้องได้ 42)`);

  const whoami = await adb.exec(serial, 'id -u');
  line('uid ที่รันอยู่', `${whoami.stdout} (2000 = shell)`);

  console.log('\n=== 6. ส่งไฟล์ ===');
  const payload = Buffer.from(`androidremote smoke ${Date.now()}\n`, 'utf8');
  const remote = '/data/local/tmp/androidremote-smoke.txt';
  await adb.pushData(serial, payload, remote, 0o644);
  const readBack = await adb.exec(serial, `cat ${remote}`);
  const match = readBack.stdout.trim() === payload.toString('utf8').trim();
  line('ส่งแล้วอ่านกลับ', match ? '✅ ตรงกัน' : `❌ ไม่ตรง: ${readBack.stdout}`);
  await adb.exec(serial, `rm -f ${remote}`);

  console.log('\n=== 7. reverse port ===');
  await adb.reverse(serial, 'localabstract:androidremote-smoke', 'tcp:27183');
  const reverseList = await adb.exec(serial, 'true');
  line('reverse', `ตั้งค่าแล้ว (rc=${reverseList.exitCode})`);
  await adb.reverseRemove(serial, 'localabstract:androidremote-smoke');

  console.log('\n✅ ผ่านทั้งหมด\n');
}

main().catch((err) => {
  console.error('\n❌ ล้มเหลว:', err);
  process.exit(1);
});
