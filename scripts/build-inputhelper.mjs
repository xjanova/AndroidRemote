/**
 * คอมไพล์ตัวฉีดคีย์บอร์ด: native/InputHelper.cs → resources/inputhelper.exe
 *
 * ใช้ csc.exe ของ .NET Framework ที่ติดมากับ Windows ทุกเครื่องอยู่แล้ว
 * ไม่ต้องลง SDK ไม่ต้องมี dotnet ไม่ต้องคอมไพล์ native module ตอน npm install
 *
 * รันด้วย: npm run helper:build
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'native', 'InputHelper.cs');
const OUT_EXE = path.join(ROOT, 'resources', 'inputhelper.exe');

function die(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

if (process.platform !== 'win32') {
  console.log('ข้าม — ตัวฉีดคีย์นี้ใช้ได้เฉพาะ Windows');
  process.exit(0);
}

const candidates = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];
const csc = candidates.find((p) => fs.existsSync(p));
if (!csc) die(`หา csc.exe ไม่เจอ — ลองที่ ${candidates.join(' และ ')}`);
if (!fs.existsSync(SOURCE)) die(`ไม่พบ ${SOURCE}`);

fs.mkdirSync(path.dirname(OUT_EXE), { recursive: true });

console.log(`csc     ${csc}`);
const res = spawnSync(
  csc,
  [
    '/nologo',
    '/optimize+',
    // exe แบบไม่มีหน้าต่างคอนโซล — ไม่งั้นจะมีหน้าต่างดำเด้งขึ้นทุกครั้งที่เปิดโหมดจอย
    '/target:winexe',
    '/platform:anycpu',
    `/out:${OUT_EXE}`,
    SOURCE,
  ],
  { encoding: 'utf8' },
);

if (res.error) die(`รัน csc ไม่ได้: ${res.error.message}`);
const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
if (res.status !== 0) {
  console.error(output);
  die(`คอมไพล์ล้มเหลว (exit ${res.status})`);
}
if (output) console.log(output);

const size = fs.statSync(OUT_EXE).size;
console.log(`\n✅ ${path.relative(ROOT, OUT_EXE)}  (${(size / 1024).toFixed(1)} KB)\n`);
