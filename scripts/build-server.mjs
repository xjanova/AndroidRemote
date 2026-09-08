/**
 * สร้าง server ฝั่ง Android: .java → .class → classes.dex → .jar
 *
 * ไม่ใช้ Gradle โดยตั้งใจ — งานนี้คือคอมไพล์ไฟล์ไม่กี่ไฟล์แล้ว dex
 * เครื่องมือที่ต้องใช้ (javac จาก JDK, d8 จาก build-tools) มีอยู่แล้วทั้งคู่
 * ลาก Gradle เข้ามาแปลว่าต้องโหลดของอีกหลายร้อยเมกกับ daemon ที่กิน RAM ค้างไว้
 *
 * รันด้วย: npm run server:build
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'server', 'src');
const BUILD_DIR = path.join(ROOT, 'server', 'build');
const CLASSES_DIR = path.join(BUILD_DIR, 'classes');
const OUT_JAR = path.join(ROOT, 'resources', 'androidremote-server.jar');

/** ระดับ API ต่ำสุดที่รองรับ — 24 = Android 7.0 ซึ่งเป็นรุ่นแรกที่ MediaCodec นิ่งพอ */
const MIN_API = 24;

function die(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
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

/** เรียงเวอร์ชันแบบตัวเลข ไม่ใช่ตามตัวอักษร (ไม่งั้น 9 จะมาหลัง 35) */
function newestVersionDir(parent, prefix = '') {
  if (!fs.existsSync(parent)) return null;
  const entries = fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => e.name);
  if (entries.length === 0) return null;

  const key = (name) =>
    name
      .slice(prefix.length)
      .split('.')
      .map((p) => parseInt(p, 10) || 0);

  entries.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const diff = (kb[i] ?? 0) - (ka[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  return entries[0];
}

function collectJava(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJava(full));
    else if (entry.name.endsWith('.java')) out.push(full);
  }
  return out;
}

function collectClasses(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectClasses(full));
    else if (entry.name.endsWith('.class')) out.push(full);
  }
  return out;
}

function run(label, exe, args, opts = {}) {
  // ห้ามใช้ shell:true กับ args เป็นอาร์เรย์ — node ต่อสตริงดิบโดยไม่ escape
  // พาธที่มีช่องว่างจะพังทันที เลยเรียก d8 ผ่าน java -cp d8.jar แทนไฟล์ .bat
  const res = spawnSync(exe, args, { encoding: 'utf8', ...opts });
  if (res.error) die(`${label} รันไม่ได้: ${res.error.message}`);
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  if (res.status !== 0) {
    console.error(output);
    die(`${label} ล้มเหลว (exit ${res.status})`);
  }
  return output;
}

// ─────────────────────────────── ลงมือ ───────────────────────────────

const sdk = findSdk();

/**
 * เลือก platform ที่ปล่อยจริงแล้วเท่านั้น — ตัวพรีวิวชื่อลงท้ายด้วยจุดทศนิยม
 * (เช่น android-37.0) หรือเป็นตัวอักษร (android-VanillaIceCream)
 * คอมไพล์กับ android.jar ของพรีวิวเสี่ยงอ้าง API ที่ยังไม่มีบนเครื่องจริง
 */
function pickPlatform() {
  const dir = path.join(sdk, 'platforms');
  const stable = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^android-\d+$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => parseInt(b.slice(8), 10) - parseInt(a.slice(8), 10));
  if (stable.length > 0) return stable[0];

  const any = newestVersionDir(dir, 'android-');
  if (any) console.warn(`⚠ ไม่มี platform ตัวปล่อยจริง จะใช้ ${any} ซึ่งเป็นพรีวิว`);
  return any;
}

const platformName = pickPlatform();
if (!platformName) die('ไม่มี platform ใน SDK เลย');
const androidJar = path.join(sdk, 'platforms', platformName, 'android.jar');
if (!fs.existsSync(androidJar)) die(`ไม่พบ ${androidJar}`);

const buildToolsName = newestVersionDir(path.join(sdk, 'build-tools'));
if (!buildToolsName) die('ไม่มี build-tools ใน SDK');
// เรียก d8 ผ่าน jar ตรงๆ ไม่ผ่าน d8.bat — ตัดปัญหา shell escaping บน Windows
const d8Jar = path.join(sdk, 'build-tools', buildToolsName, 'lib', 'd8.jar');
if (!fs.existsSync(d8Jar)) die(`ไม่พบ d8.jar ที่ ${d8Jar}`);

console.log(`SDK           ${sdk}`);
console.log(`platform      ${platformName}`);
console.log(`build-tools   ${buildToolsName}`);

const sources = collectJava(SRC_DIR);
if (sources.length === 0) die(`ไม่พบไฟล์ .java ใน ${SRC_DIR}`);
console.log(`ไฟล์ต้นทาง    ${sources.length} ไฟล์`);

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(CLASSES_DIR, { recursive: true });
fs.mkdirSync(path.dirname(OUT_JAR), { recursive: true });

// --release 8 ทำให้ javac ยอมรับเฉพาะ API ของ Java 8 สำหรับ java.* — กันเผลอใช้
// เมธอดที่มีแต่ใน JDK ใหม่แล้วไปพังบนเครื่องจริงตอนรัน ส่วน android.* มาจาก -classpath
console.log('\n[1/2] javac');
const javacOut = run('javac', 'javac', [
  '--release', '8',
  '-encoding', 'UTF-8',
  '-nowarn',
  '-classpath', androidJar,
  '-d', CLASSES_DIR,
  ...sources,
]);
if (javacOut) console.log(javacOut);

const classes = collectClasses(CLASSES_DIR);
console.log(`      คอมไพล์ได้ ${classes.length} คลาส`);

console.log('\n[2/2] d8');
const d8Out = run('d8', 'java', [
  '-cp', d8Jar,
  'com.android.tools.r8.D8',
  '--release',
  '--min-api', String(MIN_API),
  '--lib', androidJar,
  '--output', OUT_JAR,
  ...classes,
]);
if (d8Out) console.log(d8Out);

const size = fs.statSync(OUT_JAR).size;
console.log(`\n✅ ${path.relative(ROOT, OUT_JAR)}  (${(size / 1024).toFixed(1)} KB, min-api ${MIN_API})`);
console.log('\nสั่งรันบนเครื่องด้วย:');
console.log('  CLASSPATH=/data/local/tmp/androidremote-server.jar \\');
console.log('  app_process / com.androidremote.server.Main socket_name=androidremote\n');
