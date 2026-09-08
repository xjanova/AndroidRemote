/**
 * สร้าง APK ของแอปคู่หู: .java + res → aapt2 → javac → d8 → zipalign → apksigner
 *
 * ไม่ใช้ Gradle ด้วยเหตุผลเดียวกับ server ฝั่ง Android — เครื่องมือที่ต้องใช้
 * (aapt2, d8, zipalign, apksigner, javac, keytool) มีอยู่ใน SDK กับ JDK อยู่แล้ว
 * ลาก Gradle เข้ามาแปลว่าโหลดของอีกหลายร้อยเมกกับ daemon ที่กิน RAM ค้างไว้
 *
 * ⚠ เรื่องกุญแจเซ็นแอป — สำคัญกว่าที่คิด
 *   1. **ห้ามเอา keystore เข้า repo เด็ดขาด** (repo นี้เป็นสาธารณะ)
 *   2. APK ที่เซ็นคนละกุญแจ **อัปเดตทับกันไม่ได้** ผู้ใช้ต้องถอนแล้วลงใหม่
 *      กุญแจที่ปล่อยจริงจึงต้องเป็นตัวเดิมตลอดไป เก็บใน GitHub Secrets
 *   3. กุญแจที่สคริปต์นี้สร้างให้อัตโนมัติคือ **กุญแจทดสอบ** สำหรับเครื่องนักพัฒนา
 *      เท่านั้น อย่าเอาไปปล่อยจริง
 *
 * รันด้วย: npm run apk:build
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'app');
const BUILD = path.join(ROOT, 'app', 'build');
const OUT_APK = path.join(ROOT, 'release', 'AndroidRemote-companion.apk');

const MIN_API = 24;

/**
 * เวอร์ชันของ APK
 *
 * 🔑 versionCode ต้อง **เพิ่มขึ้นเสมอ** ไม่งั้นแอนดรอยด์ปฏิเสธการติดตั้งทับ
 *    และตัวเช็คอัปเดตต้องเทียบด้วย versionCode ที่เป็นจำนวนเต็ม ไม่ใช่เทียบสตริง
 *    versionName — โน้ต "Flutter auto-update silently misses build-only releases"
 *    คือกรณีที่เทียบด้วยชื่อเวอร์ชันแล้วข้ามรุ่นที่เปลี่ยนแค่เลข build ไปเงียบๆ
 */
function resolveVersion() {
  const name = process.env.APP_VERSION ?? readPackageVersion();
  const parts = name.split('.').map((n) => parseInt(n, 10) || 0);
  const code = (parts[0] ?? 0) * 10000 + (parts[1] ?? 0) * 100 + (parts[2] ?? 0);
  return { name, code: Math.max(1, code) };
}

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.1';
  } catch {
    return '0.0.1';
  }
}

function die(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

function run(label, exe, args, opts = {}) {
  const res = spawnSync(exe, args, { encoding: 'utf8', ...opts });
  if (res.error) die(`${label} รันไม่ได้: ${res.error.message}`);
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  if (res.status !== 0) {
    console.error(output);
    die(`${label} ล้มเหลว (exit ${res.status})`);
  }
  return output;
}

function findSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
    'C:\\Android\\Sdk',
    'D:\\Android\\Sdk',
    path.join(os.homedir(), 'Android', 'Sdk'),
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'platforms'))) return dir;
  }
  die('หา Android SDK ไม่เจอ — ตั้ง ANDROID_HOME ก่อน');
}

/** platform ที่ปล่อยจริงเท่านั้น — ตัวพรีวิวชื่อมีจุดทศนิยม */
function pickPlatform(sdk) {
  const dir = path.join(sdk, 'platforms');
  const stable = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^android-\d+$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => parseInt(b.slice(8), 10) - parseInt(a.slice(8), 10));
  if (stable.length === 0) die('ไม่มี platform ตัวปล่อยจริงใน SDK');
  return stable[0];
}

function newestBuildTools(sdk) {
  const dir = path.join(sdk, 'build-tools');
  const versions = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
  if (versions.length === 0) die('ไม่มี build-tools ใน SDK');
  return versions[0];
}

function collect(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

function tool(sdk, buildTools, name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const p = path.join(sdk, 'build-tools', buildTools, exe);
  if (fs.existsSync(p)) return p;
  const bat = path.join(sdk, 'build-tools', buildTools, `${name}.bat`);
  if (fs.existsSync(bat)) return bat;
  die(`ไม่พบ ${name} ใน build-tools ${buildTools}`);
}

/**
 * หากุญแจเซ็นแอป
 * ถ้า CI ส่ง ANDROID_KEYSTORE* มาให้ใช้ตัวนั้น (กุญแจจริง)
 * ไม่มีก็สร้างกุญแจทดสอบให้เอง — เฉพาะบนเครื่องนักพัฒนาเท่านั้น
 */
function resolveKeystore() {
  const fromEnv = process.env.ANDROID_KEYSTORE_PATH;
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) die(`ANDROID_KEYSTORE_PATH ชี้ไปที่ไฟล์ที่ไม่มีอยู่: ${fromEnv}`);
    const missing = ['ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS'].filter((k) => !process.env[k]);
    if (missing.length) die(`ตั้ง ${missing.join(' และ ')} ด้วย`);
    return {
      path: fromEnv,
      storePass: process.env.ANDROID_KEYSTORE_PASSWORD,
      alias: process.env.ANDROID_KEY_ALIAS,
      keyPass: process.env.ANDROID_KEY_PASSWORD ?? process.env.ANDROID_KEYSTORE_PASSWORD,
      isRelease: true,
    };
  }

  const devKeystore = path.join(ROOT, 'build', 'dev.keystore');
  const devPass = 'androidremote-dev';
  if (!fs.existsSync(devKeystore)) {
    console.log('สร้างกุญแจทดสอบใหม่ (ใช้บนเครื่องนักพัฒนาเท่านั้น ไม่ได้เข้า git)');
    fs.mkdirSync(path.dirname(devKeystore), { recursive: true });
    run('keytool', 'keytool', [
      '-genkeypair', '-v',
      '-keystore', devKeystore,
      '-alias', 'dev',
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
      '-storepass', devPass, '-keypass', devPass,
      '-dname', 'CN=AndroidRemote Dev, OU=Dev, O=AndroidRemote, C=TH',
    ]);
  }
  return { path: devKeystore, storePass: devPass, alias: 'dev', keyPass: devPass, isRelease: false };
}

// ─────────────────────────────── ลงมือ ───────────────────────────────

const sdk = findSdk();
const platform = pickPlatform(sdk);
const buildTools = newestBuildTools(sdk);
const androidJar = path.join(sdk, 'platforms', platform, 'android.jar');

const aapt2 = tool(sdk, buildTools, 'aapt2');
const zipalign = tool(sdk, buildTools, 'zipalign');
// ⚠ apksigner กับ d8 มาเป็นสคริปต์ .bat บน Windows ซึ่ง Node สั่งตรงๆ ไม่ได้
//   (spawn คืน EINVAL ตั้งแต่ Node 20 ที่อุดช่องโหว่การส่งอาร์กิวเมนต์เข้า cmd)
//   ทั้งคู่เป็นโปรแกรม Java อยู่แล้ว เรียกผ่าน jar ตรงๆ จบปัญหาและพกพาได้ด้วย
const libDir = path.join(sdk, 'build-tools', buildTools, 'lib');
const d8Jar = path.join(libDir, 'd8.jar');
const apksignerJar = path.join(libDir, 'apksigner.jar');
if (!fs.existsSync(d8Jar)) die(`ไม่พบ d8.jar ที่ ${d8Jar}`);
if (!fs.existsSync(apksignerJar)) die(`ไม่พบ apksigner.jar ที่ ${apksignerJar}`);

console.log(`SDK           ${sdk}`);
console.log(`platform      ${platform}`);
console.log(`build-tools   ${buildTools}`);

fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(path.join(BUILD, 'gen'), { recursive: true });
fs.mkdirSync(path.join(BUILD, 'classes'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'release'), { recursive: true });

// ── 1. ทรัพยากร ──
console.log('\n[1/6] aapt2 compile');
const resZip = path.join(BUILD, 'res.zip');
// subcommand ต้องมาก่อนตัวเลือกเสมอ ไม่งั้น aapt2 บอกว่าไม่รู้จัก --dir
run('aapt2 compile', aapt2, ['compile', '--dir', path.join(APP_DIR, 'res'), '-o', resZip]);

console.log('[2/6] aapt2 link');
const baseApk = path.join(BUILD, 'base.apk');
const version = resolveVersion();
console.log(`เวอร์ชัน      ${version.name} (versionCode ${version.code})`);
run('aapt2 link', aapt2, [
  'link',
  '-o', baseApk,
  '-I', androidJar,
  '--manifest', path.join(APP_DIR, 'AndroidManifest.xml'),
  '--java', path.join(BUILD, 'gen'),
  '--min-sdk-version', String(MIN_API),
  '--target-sdk-version', '34',
  // ทับค่าที่เขียนไว้ใน manifest — แหล่งความจริงคือเวอร์ชันที่ปล่อย ไม่ใช่ไฟล์
  '--version-code', String(version.code),
  '--version-name', version.name,
  '--auto-add-overlay',
  resZip,
]);

// ── 2. โค้ด ──
console.log('[3/6] javac');
const sources = [...collect(path.join(APP_DIR, 'src'), '.java'), ...collect(path.join(BUILD, 'gen'), '.java')];
if (sources.length === 0) die('ไม่พบไฟล์ .java');
run('javac', 'javac', [
  '--release', '8',
  '-encoding', 'UTF-8',
  '-nowarn',
  '-classpath', androidJar,
  '-d', path.join(BUILD, 'classes'),
  ...sources,
]);
const classes = collect(path.join(BUILD, 'classes'), '.class');
console.log(`      คอมไพล์ได้ ${classes.length} คลาส จาก ${sources.length} ไฟล์`);

console.log('[4/6] d8');
run('d8', 'java', [
  '-cp', d8Jar,
  'com.android.tools.r8.D8',
  '--release',
  '--min-api', String(MIN_API),
  '--lib', androidJar,
  '--output', BUILD,
  ...classes,
]);

// ยัด classes.dex เข้า apk — jar ของ JDK เขียนไฟล์ zip ได้ ไม่ต้องพึ่งไลบรารีเสริม
run('jar', 'jar', ['uf', baseApk, '-C', BUILD, 'classes.dex']);

// ── 3. จัดเรียงแล้วเซ็น ──
console.log('[5/6] zipalign');
const alignedApk = path.join(BUILD, 'aligned.apk');
// ⚠ ต้อง align ก่อนเซ็นเสมอ — apksigner รักษาการจัดเรียงไว้ให้
//   แต่ zipalign หลังเซ็นจะทำให้ลายเซ็นเสีย
run('zipalign', zipalign, ['-f', '-p', '4', baseApk, alignedApk]);

console.log('[6/6] apksigner');
const ks = resolveKeystore();
run('apksigner', 'java', [
  '-jar', apksignerJar,
  'sign',
  '--ks', ks.path,
  '--ks-pass', `pass:${ks.storePass}`,
  '--ks-key-alias', ks.alias,
  '--key-pass', `pass:${ks.keyPass}`,
  // minSdk 24 = Android 7.0 ซึ่งเป็นรุ่นแรกที่รู้จักลายเซ็น v2 อยู่แล้ว
  // จึงไม่ต้องมี v1 (JAR signing) ที่ช้ากว่าและปลอมแปลงง่ายกว่า
  '--min-sdk-version', String(MIN_API),
  '--v2-signing-enabled', 'true',
  '--v3-signing-enabled', 'true',
  '--out', OUT_APK,
  alignedApk,
]);

const verify = run('apksigner verify', 'java', ['-jar', apksignerJar, 'verify', '--verbose', OUT_APK]);
const size = fs.statSync(OUT_APK).size;

console.log(`\n✅ ${path.relative(ROOT, OUT_APK)}  (${(size / 1024).toFixed(1)} KB, min-api ${MIN_API}, v${version.name})`);
console.log(`   เซ็นด้วยกุญแจ${ks.isRelease ? 'จริงจาก CI' : 'ทดสอบ (ห้ามปล่อยจริง)'}`);
for (const line of verify.split('\n')) {
  if (/Verified using/.test(line)) console.log(`   ${line.trim()}`);
}
