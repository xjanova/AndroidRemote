/**
 * ทดสอบเซิร์ฟเวอร์จอย: หน้าเว็บ + WebSocket ที่เขียนเอง
 * รันด้วย: npx tsx scripts/smoke-gamepad.ts
 *
 * ไม่ต้องมีมือถือ — ใช้ WebSocket client ที่ติดมากับ Node เป็นตัวแทน
 * จุดที่ต้องพิสูจน์คือ handshake กับการถอดมาสก์เฟรม ซึ่งพังง่ายและเงียบ
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { GamepadServer } from '../src/main/gamepad/GamepadServer';
import { KeyInjector } from '../src/main/gamepad/KeyInjector';

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(26)} ${String(value)}`);
}

/** เฟรมข้อความฝั่งไคลเอนต์ — สเปกบังคับว่าต้องมาสก์เสมอ */
function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];

  const head: number[] = [0x81];
  if (payload.length < 126) head.push(0x80 | payload.length);
  else head.push(0x80 | 126, payload.length >> 8, payload.length & 0xff);

  return Buffer.concat([Buffer.from(head), mask, masked]);
}

async function main(): Promise<void> {
  let failures = 0;
  const check = (label: string, ok: boolean, extra = ''): void => {
    if (!ok) failures++;
    console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(28)} ${extra}`);
  };

  console.log('\n=== 1. ตัวฉีดคีย์ ===');
  line('รองรับบนเครื่องนี้', KeyInjector.available() ? 'ใช่' : 'ไม่ (ต้อง Windows + build helper)');
  line('พาธ', KeyInjector.helperPath());

  console.log('\n=== 2. เปิดเซิร์ฟเวอร์ ===');
  const server = new GamepadServer((level, message) => console.log(`  [${level}] ${message}`));
  const received: Array<{ button: string; down: boolean }> = [];
  let releaseAllFired = false;
  server.on('button', (e: { button: string; down: boolean }) => received.push(e));
  server.on('release-all', () => {
    releaseAllFired = true;
  });

  const port = await server.start(8770);
  line('พอร์ต', port);
  const state = server.state(false);
  line('ที่อยู่สำหรับมือถือ', state.urls.join(', ') || '(ไม่มีอินเทอร์เฟซ)');

  console.log('\n=== 3. หน้าเว็บ ===');
  const res = await fetch(`http://127.0.0.1:${port}/`);
  const body = await res.text();
  check('ตอบ 200', res.status === 200, `สถานะ ${res.status}`);
  check('เป็น HTML', body.startsWith('<!doctype html>'));
  // นับเฉพาะปุ่มจริงในมาร์กอัป — ห้ามนับ data-b=" ที่โผล่ในโค้ด JS ของหน้าเดียวกัน
  const buttons = new Set([...body.matchAll(/<div class="btn[^"]*" data-b="([A-Z0-9]+)"/g)].map((m) => m[1]));
  check('มีปุ่มครบ 14 ตัว', buttons.size === 14, `เจอ ${buttons.size}`);
  check('ห้ามแคช', res.headers.get('cache-control') === 'no-store');

  const notFound = await fetch(`http://127.0.0.1:${port}/ไม่มีจริง`);
  check('พาธมั่วได้ 404', notFound.status === 404, `สถานะ ${notFound.status}`);

  console.log('\n=== 4. WebSocket (handshake + ถอดมาสก์) ===');
  // ใช้ไคลเอนต์ดิบ ไม่ใช่ WebSocket ที่ติดมากับ Node
  //
  // ⚠ ตัวที่ติดมากับ Node (undici) ปฏิเสธ handshake ของเราที่ processResponse
  //   ทั้งที่เทียบไบต์ต่อไบต์แล้วถูกต้องทุกตัว รวม Sec-WebSocket-Accept
  //   เราจึงคุมโปรโตคอลเองทั้งหมดในเทสต์นี้ จะได้รู้แน่ว่าที่พังคือของเราหรือของเขา
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(port, '127.0.0.1', () => {
    sock.write(
      'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n',
    );
  });

  const handshakeOk = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 4000);
    sock.once('data', (d) => {
      clearTimeout(timer);
      const text = d.toString('binary');
      const expect = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-5AB0DC85B11F')
        .digest('base64');
      resolve(text.startsWith('HTTP/1.1 101') && text.includes(expect));
    });
  });
  check('handshake ผ่าน', handshakeOk);

  if (handshakeOk) {
    // สามเฟรมใน chunk เดียว — จำลองที่ TCP ชอบรวมแพ็กเก็ตให้
    sock.write(
      Buffer.concat([
        maskedTextFrame(JSON.stringify({ t: 'd', b: 'A' })),
        maskedTextFrame(JSON.stringify({ t: 'd', b: 'UP' })),
        maskedTextFrame(JSON.stringify({ t: 'u', b: 'A' })),
      ]),
    );
    // ยาวเกิน 125 ไบต์ = ใช้ความยาวแบบ 16 บิต ซึ่งเป็นโค้ดคนละสาขา
    sock.write(maskedTextFrame(JSON.stringify({ t: 'd', b: 'B', pad: 'x'.repeat(200) })));
    sock.write(maskedTextFrame('ไม่ใช่ JSON เลย'));

    await new Promise((r) => setTimeout(r, 400));

    const seen = received.map((e) => `${e.button}${e.down ? '↓' : '↑'}`).join(' ');
    check('แกะเฟรมได้ครบและเรียงถูก', seen === 'A↓ UP↓ A↑ B↓', `ได้: ${seen || '(ว่าง)'}`);
    check('ข้อความเพี้ยนไม่ทำให้ล่ม', received.length === 4);

    sock.destroy();
    await new Promise((r) => setTimeout(r, 500));
    // ซ็อกเก็ตที่อัปเกรดแล้วอยู่โหมดครึ่งปิด — ได้แค่ 'end' ไม่ได้ 'close'
    // ถ้าดักแต่ 'close' ปุ่มจะค้างตลอดกาล (เคยพลาดมาแล้ว)
    check('สายหลุดแล้วสั่งปล่อยทุกปุ่ม', releaseAllFired);
  }

  server.stop();
  console.log(failures === 0 ? '\n✅ ผ่านทั้งหมด\n' : `\n❌ ไม่ผ่าน ${failures} ข้อ\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n❌ ล้มเหลว:', err);
  process.exit(1);
});
