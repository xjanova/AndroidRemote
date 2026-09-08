/**
 * ทดสอบชั้นค้นหาอุปกรณ์บนวง LAN จริง
 * รันด้วย: npx tsx scripts/smoke-discovery.ts [--sweep]
 *
 * ไม่ต้องมีมือถือก็รันได้ — พิสูจน์ว่าผูกซ็อกเก็ต mDNS ได้ หาวงถูก และกวาดพอร์ตทำงาน
 * ใส่ --sweep ถ้าอยากให้กวาดทั้งวงด้วย (ใช้เวลาสักครู่ และยิง TCP ไปทุกที่อยู่ในวง)
 */

import {
  MdnsBrowser,
  localIPv4Interfaces,
  parseMdnsResponse,
  serialFromInstance,
} from '../src/main/discovery/mdns';
import { localSubnets, sweep } from '../src/main/discovery/scan';
import { AdbClient } from '../src/main/adb/AdbClient';

const wantSweep = process.argv.includes('--sweep');

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(24)} ${String(value)}`);
}

// ─────────────────────────── แพ็กเก็ตสังเคราะห์ ───────────────────────────

function encodeName(name: string): Buffer {
  const chunks: Buffer[] = [];
  for (const part of name.split('.').filter(Boolean)) {
    const b = Buffer.from(part, 'utf8');
    chunks.push(Buffer.from([b.length]), b);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function pointer(offset: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(0xc000 | offset, 0);
  return b;
}

/**
 * สร้างคำตอบ mDNS แบบที่แอนดรอยด์ส่งจริง — สำคัญคือ **ใช้การบีบอัดชื่อ**
 * ทั้ง SRV และ A ชี้กลับไปที่ชื่อที่เขียนไว้ก่อนหน้า ซึ่งเป็นจุดที่ parser พังง่ายที่สุด
 */
function buildSyntheticResponse(): Buffer {
  const SERVICE = '_adb-tls-connect._tcp.local';
  const INSTANCE_LABEL = 'adb-R5CT80TEST-abc123';
  const TARGET = 'Pixel-8.local';
  const PORT = 37123;
  const IP = [192, 168, 1, 77];

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // response + authoritative
  header.writeUInt16BE(3, 6); // ancount

  const parts: Buffer[] = [header];
  let offset = header.length;

  // ── PTR: <service> → <instance>.<service> ──
  const serviceOffset = offset;
  const ptrName = encodeName(SERVICE);
  const instLabel = Buffer.from(INSTANCE_LABEL, 'utf8');
  const ptrRdata = Buffer.concat([Buffer.from([instLabel.length]), instLabel, pointer(serviceOffset)]);
  const ptrHead = Buffer.alloc(10);
  ptrHead.writeUInt16BE(12, 0); // TYPE=PTR
  ptrHead.writeUInt16BE(1, 2); // CLASS=IN
  ptrHead.writeUInt32BE(120, 4);
  ptrHead.writeUInt16BE(ptrRdata.length, 8);
  parts.push(ptrName, ptrHead, ptrRdata);
  const instanceOffset = offset + ptrName.length + ptrHead.length;
  offset = instanceOffset + ptrRdata.length;

  // ── SRV: ชื่อชี้กลับไปที่ instance ──
  const srvName = pointer(instanceOffset);
  const targetName = encodeName(TARGET);
  const srvRdata = Buffer.alloc(6 + targetName.length);
  srvRdata.writeUInt16BE(0, 0); // priority
  srvRdata.writeUInt16BE(0, 2); // weight
  srvRdata.writeUInt16BE(PORT, 4);
  targetName.copy(srvRdata, 6);
  const srvHead = Buffer.alloc(10);
  srvHead.writeUInt16BE(33, 0); // TYPE=SRV
  srvHead.writeUInt16BE(1, 2);
  srvHead.writeUInt32BE(120, 4);
  srvHead.writeUInt16BE(srvRdata.length, 8);
  parts.push(srvName, srvHead, srvRdata);
  const targetOffset = offset + srvName.length + srvHead.length + 6;
  offset += srvName.length + srvHead.length + srvRdata.length;

  // ── A: ชื่อชี้กลับไปที่ target ของ SRV ──
  const aHead = Buffer.alloc(10);
  aHead.writeUInt16BE(1, 0); // TYPE=A
  aHead.writeUInt16BE(1, 2);
  aHead.writeUInt32BE(120, 4);
  aHead.writeUInt16BE(4, 8);
  parts.push(pointer(targetOffset), aHead, Buffer.from(IP));

  return Buffer.concat(parts);
}

function testParser(): boolean {
  const packet = buildSyntheticResponse();
  const records = parseMdnsResponse(packet);

  const instances = records.ptr.get('_adb-tls-connect._tcp.local');
  const instance = instances?.[0];
  const srv = instance ? records.srv.get(instance) : undefined;
  const address = srv ? records.a.get(srv.host) : undefined;
  const serial = instance ? serialFromInstance(instance) : null;

  const checks: Array<[string, unknown, unknown]> = [
    ['ชื่ออินสแตนซ์ (ตามตัวชี้)', instance, 'adb-R5CT80TEST-abc123._adb-tls-connect._tcp.local'],
    ['serial ที่แกะได้', serial, 'R5CT80TEST'],
    ['โฮสต์จาก SRV', srv?.host, 'Pixel-8.local'],
    ['พอร์ตจาก SRV', srv?.port, 37123],
    ['ที่อยู่จาก A', address, '192.168.1.77'],
  ];

  let ok = true;
  for (const [label, got, want] of checks) {
    const pass = got === want;
    if (!pass) ok = false;
    console.log(`  ${pass ? '✅' : '❌'} ${label.padEnd(26)} ${String(got)}${pass ? '' : `  (ควรได้ ${String(want)})`}`);
  }
  return ok;
}

async function main(): Promise<void> {
  console.log('\n=== 0. ตัวแกะแพ็กเก็ต mDNS (แพ็กเก็ตสังเคราะห์ มีการบีบอัดชื่อ) ===');
  const parserOk = testParser();
  if (!parserOk) {
    console.error('\n❌ ตัวแกะแพ็กเก็ตผิด — หยุดก่อน ไม่ต้องไปต่อ\n');
    process.exit(1);
  }

  console.log('\n=== 1. อินเทอร์เฟซและวงในเครื่อง ===');
  const ifaces = localIPv4Interfaces();
  line('IPv4 ที่ใช้ได้', ifaces.join(', ') || '(ไม่มี)');

  const subnets = localSubnets();
  for (const s of subnets) {
    line(`วงของ ${s.self}`, `/${s.prefix} → ${s.hosts.length} ที่อยู่ที่ต้องลอง`);
  }
  if (subnets.length === 0) {
    console.log('  ⚠ ไม่เจอวงที่กวาดได้ (อาจเป็น /16 ซึ่งใหญ่เกินกว่าที่เรายอมกวาด)');
  }

  console.log('\n=== 2. adb เห็นอะไรบน mDNS ===');
  const adb = new AdbClient();
  const adbServices = await adb.mdnsServices();
  if (adbServices.length === 0) {
    line('ผล', '(ว่าง)');
  } else {
    for (const s of adbServices) {
      line(s.instance, `${s.service} → ${s.address}:${s.port}`);
    }
  }

  console.log('\n=== 3. mDNS ของเราเอง (ฟัง 6 วินาที) ===');
  const browser = new MdnsBrowser();
  browser.on('log', (m: string) => console.log(`  [mdns] ${m}`));
  browser.on('service', (s: { kind: string; instance: string; address: string | null; port: number }) => {
    console.log(`  🔎 ${s.kind.padEnd(8)} ${s.address}:${s.port}  serial=${serialFromInstance(s.instance) ?? '?'}`);
  });

  try {
    await browser.start(2000);
    line('สถานะ', 'ผูกซ็อกเก็ตและยิงคำถามแล้ว');
  } catch (err) {
    console.log(`  ❌ เริ่มไม่ได้: ${err instanceof Error ? err.message : String(err)}`);
  }

  await new Promise((r) => setTimeout(r, 6000));
  const found = browser.list();
  line('เจอทั้งหมด', `${found.length} บริการ`);
  browser.stop();

  if (!wantSweep) {
    console.log('\n=== 4. กวาดพอร์ต — ข้าม (ใส่ --sweep ถ้าต้องการ) ===');
  } else {
    console.log('\n=== 4. กวาดพอร์ต 5555 ทั้งวง ===');
    const started = Date.now();
    const hits = await sweep({
      onProgress: (done, total) => {
        if (done % 256 === 0 || done === total) {
          process.stdout.write(`\r  ความคืบหน้า ${done}/${total}   `);
        }
      },
      onFound: (t) => console.log(`\n  🔎 เปิดพอร์ตอยู่: ${t.address}:${t.port}`),
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\n  ใช้เวลา ${seconds} วินาที · เจอ ${hits.length} ที่อยู่`);
  }

  console.log('\n✅ ชั้นค้นหาทำงานได้\n');
}

main().catch((err) => {
  console.error('\n❌ ล้มเหลว:', err);
  process.exit(1);
});
