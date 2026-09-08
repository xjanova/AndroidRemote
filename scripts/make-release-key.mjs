/**
 * สร้างกุญแจเซ็น APK ตัวจริง แล้วบอกวิธีเอาเข้า GitHub Secrets
 *
 * 🔴 อ่านให้จบก่อนรัน
 *
 * 1. **กุญแจนี้ต้องเป็นตัวเดิมตลอดอายุแอป** — APK ที่เซ็นคนละกุญแจอัปเดตทับกันไม่ได้
 *    ผู้ใช้จะต้องถอนแล้วลงใหม่ ซึ่งข้อมูลในแอปหายหมด ทำหายแล้วแก้ไม่ได้
 *    สำรองไฟล์ .keystore ไว้ที่ปลอดภัยด้วย อย่าพึ่ง GitHub Secrets อย่างเดียว
 *    (อ่านค่าออกมาไม่ได้ ดูได้อย่างเดียวว่ามีหรือไม่มี)
 *
 * 2. **ห้ามเอาไฟล์นี้เข้า git เด็ดขาด** repo นี้เป็นสาธารณะ
 *    .gitignore กัน *.keystore ไว้แล้ว แต่อย่าไปฝืน
 *
 * รันด้วย: node scripts/make-release-key.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'release.keystore');
const ALIAS = 'androidremote';

if (fs.existsSync(OUT)) {
  console.error(`\n⚠ มี ${path.relative(ROOT, OUT)} อยู่แล้ว`);
  console.error('  ถ้าสร้างทับ กุญแจเดิมจะหายและอัปเดตแอปที่ปล่อยไปแล้วไม่ได้อีกเลย');
  console.error('  ถ้าแน่ใจว่ายังไม่เคยปล่อยจริง ให้ลบไฟล์เดิมทิ้งเองก่อน\n');
  process.exit(1);
}

// รหัสสุ่ม 24 ไบต์ — ยาวพอที่จะไม่ต้องกังวลเรื่องเดา และไม่มีใครต้องพิมพ์เอง
const password = crypto.randomBytes(24).toString('base64url');

fs.mkdirSync(path.dirname(OUT), { recursive: true });

const res = spawnSync(
  'keytool',
  [
    '-genkeypair', '-v',
    '-keystore', OUT,
    '-alias', ALIAS,
    '-keyalg', 'RSA', '-keysize', '4096',
    // 10000 วัน ≈ 27 ปี — Play Store ต้องการอย่างน้อยถึงปี 2033 อยู่แล้ว
    '-validity', '10000',
    '-storepass', password, '-keypass', password,
    '-dname', 'CN=AndroidRemote, OU=xman, O=AndroidRemote, C=TH',
  ],
  { encoding: 'utf8' },
);

if (res.status !== 0) {
  console.error(`${res.stdout ?? ''}${res.stderr ?? ''}`);
  console.error('\n❌ สร้างกุญแจไม่สำเร็จ\n');
  process.exit(1);
}

const base64 = fs.readFileSync(OUT).toString('base64');

console.log(`\n✅ สร้างกุญแจแล้ว: ${path.relative(ROOT, OUT)}`);
console.log('\n🔴 สำรองไฟล์นี้ไว้ที่ปลอดภัยเดี๋ยวนี้ — ทำหายแล้วอัปเดตแอปไม่ได้อีกเลย\n');
console.log('เอาเข้า GitHub Secrets ด้วยสามคำสั่งนี้:\n');
console.log(`  gh secret set ANDROID_KEYSTORE_BASE64 --body "${base64.slice(0, 24)}...(ยาว ${base64.length} ตัวอักษร)"`);
console.log('  → จริงๆ ให้ใช้คำสั่งข้างล่างแทน จะได้ไม่ต้องก็อปสตริงยาว:\n');
console.log(`  node -e "console.log(require('fs').readFileSync('build/release.keystore').toString('base64'))" | gh secret set ANDROID_KEYSTORE_BASE64`);
console.log(`  gh secret set ANDROID_KEYSTORE_PASSWORD --body "${password}"`);
console.log(`  gh secret set ANDROID_KEY_ALIAS --body "${ALIAS}"`);
console.log('\nรหัสผ่าน (เก็บไว้ในที่จัดการรหัสผ่านด้วย):');
console.log(`  ${password}\n`);
