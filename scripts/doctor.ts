/**
 * ตรวจสุขภาพทั้งระบบในคำสั่งเดียว — สำหรับตอนที่ "มันไม่ทำงาน" แล้วไม่รู้จะเริ่มดูตรงไหน
 *
 * รันด้วย: npm run doctor
 * ผลออกทั้งหน้าจอและไฟล์ doctor-report.txt ให้ก็อปส่งได้เลย
 *
 * ไม่แก้อะไร อ่านอย่างเดียว เสียบมือถือไว้ด้วยจะได้ข้อมูลครบกว่า
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { AdbClient, findAdb } from '../src/main/adb/AdbClient';
import { probeDevice } from '../src/main/device/probe';
import { MdnsBrowser, localIPv4Interfaces } from '../src/main/discovery/mdns';
import { localSubnets, sweep } from '../src/main/discovery/scan';

const lines: string[] = [];
function out(s = ''): void {
  console.log(s);
  lines.push(s);
}
function section(title: string): void {
  out();
  out(`━━━ ${title} ━━━`);
}
function kv(k: string, v: unknown): void {
  out(`  ${k.padEnd(26)} ${String(v)}`);
}

async function main(): Promise<void> {
  section('เครื่อง PC');
  kv('OS', `${os.platform()} ${os.release()}`);
  kv('Node', process.version);
  kv('IPv4', localIPv4Interfaces().join(', ') || '(ไม่มี — ไม่ได้ต่อเน็ต?)');
  for (const s of localSubnets()) kv(`วงของ ${s.self}`, `/${s.prefix} (${s.hosts.length} ที่อยู่)`);

  section('adb');
  const adbPath = findAdb();
  kv('adb.exe', adbPath ?? '❌ หาไม่เจอ');
  if (!adbPath) {
    out('  → ตั้ง ANDROID_HOME หรือลง platform-tools ก่อน ทุกอย่างพึ่ง adb');
    finish();
    return;
  }
  const adb = new AdbClient({ log: (l, m) => out(`  [${l}] ${m}`) });
  try {
    kv('เวอร์ชันโปรโตคอล', await adb.version());
  } catch (e) {
    kv('ต่อ adb server', `❌ ${e instanceof Error ? e.message : e}`);
  }

  section('เครื่องที่ adb เห็น');
  const devices = await adb.listDevices().catch(() => []);
  if (devices.length === 0) {
    out('  (ว่าง) — ไม่มีเครื่องเสียบ USB และไม่มีเครื่องต่อไร้สายอยู่');
    out('  → ถ้าเสียบสายอยู่แล้วยังว่าง: USB debugging ยังไม่เปิด หรือสายเป็นสายชาร์จอย่างเดียว');
  }
  for (const d of devices) {
    out(`  ${d.serial}  ${d.state}  ${JSON.stringify(d.props)}`);
  }

  for (const d of devices.filter((x) => x.state === 'device')) {
    section(`ตรวจเครื่อง ${d.serial}`);
    const info = await probeDevice(adb, d.serial, 'device');
    kv('รุ่น', `${info.brand ?? ''} ${info.model ?? ''}`.trim());
    kv('แอนดรอยด์', `${info.androidRelease ?? '?'} (API ${info.sdk ?? '?'})`);
    kv('ROM', info.romName ?? '(AOSP/ไม่ระบุ)');
    kv('hwSerial (ro.serialno)', info.hwSerial ?? '❌ อ่านไม่ได้ — จำเครื่องข้าม USB/ไร้สายไม่ได้');
    kv('ระดับสิทธิ์', info.tier);
    kv('จอ', `${info.screenWidth}×${info.screenHeight}`);
    for (const b of info.blockers) out(`  ⚠ ${b.title}`);

    // ค่าที่ตัดสินว่าต่อไร้สายได้ไหม — ดึงจากเครื่องตรงๆ
    out('  --- สถานะไร้สายบนเครื่องนี้ ---');
    const props = await adb.exec(
      d.serial,
      'getprop service.adb.tcp.port; getprop persist.adb.tls_server.enable; settings get global adb_wifi_enabled; ip -4 addr show wlan0 2>/dev/null | grep inet',
    );
    const [tcpPort, tls, adbWifi, ...ipLines] = props.stdout.split('\n');
    kv('service.adb.tcp.port', tcpPort?.trim() || '(ว่าง = ไม่ได้เปิด adb tcpip)');
    kv('tls_server.enable', tls?.trim() || '(ว่าง)');
    kv('adb_wifi_enabled', adbWifi?.trim() === '1' ? '1 = เปิด wireless debugging อยู่' : `${adbWifi?.trim() || '(ว่าง)'} = ปิดอยู่`);
    kv('IP ของมือถือ (wlan0)', ipLines.join(' ').trim() || '(ไม่ได้ต่อ Wi-Fi)');
    const pcSubnet = localSubnets()[0]?.self.split('.').slice(0, 3).join('.');
    const phoneIp = /inet (\d+\.\d+\.\d+)\./.exec(ipLines.join(' '))?.[1];
    const isEmulator = /^emulator-|^127\.0\.0\.1:/.test(d.serial);
    if (isEmulator) {
      out('  ℹ อีมูเลเตอร์อยู่หลัง NAT ของตัวเอง (10.0.2.x) — ต่อผ่าน loopback ไม่ใช่วง LAN ข้ามได้');
    } else if (pcSubnet && phoneIp && pcSubnet !== phoneIp) {
      out(`  ❌ มือถืออยู่วง ${phoneIp}.x แต่ PC อยู่วง ${pcSubnet}.x — คนละวง หากันไม่เจอแน่นอน`);
    }

    out('  --- ทดสอบยิงคำสั่ง (พิสูจน์ช่องทางควบคุม) ---');
    const t0 = Date.now();
    const echo = await adb.exec(d.serial, 'echo ok; id -u');
    kv('exec ตอบกลับ', `${echo.stdout.replace(/\n/g, ' ')} (${Date.now() - t0} ms, rc=${echo.exitCode})`);

    out('  --- server ฝั่งมือถือ ---');
    const jar = path.join(process.cwd(), 'resources', 'androidremote-server.jar');
    kv('jar บน PC', fs.existsSync(jar) ? `มี (${(fs.statSync(jar).size / 1024).toFixed(1)} KB)` : '❌ ไม่มี — รัน npm run server:build');
    if (fs.existsSync(jar)) {
      await adb.pushData(d.serial, fs.readFileSync(jar), '/data/local/tmp/androidremote-server.jar', 0o644);
      const list = await adb.exec(
        d.serial,
        'CLASSPATH=/data/local/tmp/androidremote-server.jar app_process / com.androidremote.server.Main mode=camera-list 2>&1',
      );
      const jsonLine = list.stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('{'));
      const ok = Boolean(jsonLine);
      kv('รัน server (โหมด list)', ok ? '✅ รันได้และตอบ JSON' : `❌ rc=${list.exitCode}`);
      if (jsonLine) {
        // JSON ที่มี error ข้างในก็ยัง "ตอบ" — ต้องดูเนื้อในด้วยว่ากล้องใช้ได้จริงไหม
        const parsed = JSON.parse(jsonLine) as { error?: string; cameras?: unknown[] };
        if (parsed.error) out(`  ⚠ กล้อง: ${parsed.error}`);
        else kv('กล้องที่เห็น', `${parsed.cameras?.length ?? 0} ตัว`);
      }
      const arLines = list.stdout.split('\n').filter((l) => /\[AR\] [WE]/.test(l));
      for (const l of arLines) out(`      ${l.trim()}`);
      if (!ok) for (const l of list.stdout.split('\n').slice(0, 15)) out(`      ${l}`);
    }
  }

  section('mDNS ที่ adb เห็น');
  const svc = await adb.mdnsServices();
  if (svc.length === 0) out('  (ว่าง)');
  for (const s of svc) out(`  ${s.instance}  ${s.service}  ${s.address}:${s.port}`);

  section('mDNS ของเราเอง (ฟัง 5 วินาที)');
  const browser = new MdnsBrowser();
  browser.on('service', (s: { kind: string; address: string; port: number; serial: string | null }) =>
    out(`  🔎 ${s.kind.padEnd(8)} ${s.address}:${s.port}  serial=${s.serial ?? '?'}`),
  );
  browser.on('log', (m: string) => out(`  [mdns] ${m}`));
  try {
    await browser.start(1500);
    await new Promise((r) => setTimeout(r, 5000));
    kv('เจอ', `${browser.list().length} บริการ`);
  } catch (e) {
    kv('เริ่มไม่ได้', e instanceof Error ? e.message : e);
  }
  browser.stop();

  section('กวาดพอร์ต 5555 ทั้งวง');
  const hits = await sweep({ onFound: (t) => out(`  🔎 เปิดอยู่: ${t.address}:${t.port}`) });
  kv('เจอ', `${hits.length} ที่อยู่`);

  section('ไฟล์ของแอป');
  const userData = path.join(process.env.APPDATA ?? '', 'androidremote');
  kv('userData', fs.existsSync(userData) ? userData : '(ยังไม่มี)');
  const known = path.join(userData, 'known-devices.json');
  kv('เครื่องที่จำไว้', fs.existsSync(known) ? fs.readFileSync(known, 'utf8').trim() : '(ยังไม่เคยจับคู่/ต่อไร้สายสำเร็จ)');
  const logFile = path.join(userData, 'logs', 'androidremote.log');
  if (fs.existsSync(logFile)) {
    out('  --- 40 บรรทัดท้ายของ log แอป ---');
    const tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-40);
    for (const l of tail) out(`  ${l}`);
  } else {
    kv('log แอป', '(ยังไม่มี — เปิดแอปรุ่นที่มี log แล้วลองใหม่)');
  }

  finish();
}

function finish(): void {
  const report = path.join(process.cwd(), 'doctor-report.txt');
  fs.writeFileSync(report, lines.join('\n') + '\n', 'utf8');
  out();
  out(`📄 บันทึกไว้ที่ ${report} — ก็อปทั้งไฟล์ส่งมาได้เลย`);
  // spawnSync ใช้ที่อื่น import ไว้กันไม่ให้ tsc บ่น
  void spawnSync;
}

main().catch((err) => {
  out(`\n❌ doctor พัง: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  finish();
  process.exit(1);
});
