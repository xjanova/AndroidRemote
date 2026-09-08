/**
 * ทำให้มือถือกลายเป็นจอยเกมของ PC
 *
 * ทางที่เลือก: PC เปิดเว็บเซิร์ฟเวอร์เล็กๆ แล้วมือถือเปิดหน้านั้นในเบราว์เซอร์
 *
 * ทำไมไม่เขียนเป็นแอปแอนดรอยด์: ต้องสร้าง APK เซ็นชื่อ ให้ผู้ใช้ลง แล้วอัปเดตทุกครั้ง
 * ที่แก้ปุ่ม — ทั้งที่สิ่งที่ต้องการคือ "ปุ่มบนจอที่ส่งค่ากลับมา" ซึ่งหน้าเว็บทำได้ครบ
 * ผลพลอยได้: ใช้กับ iPhone หรือแท็บเล็ตเครื่องไหนก็ได้ และไม่ต้องพึ่ง adb เลย
 *
 * WebSocket เขียนเอง เพราะโปรเจคนี้ไม่มี runtime dependency สักตัว และสิ่งที่ต้องใช้
 * มีแค่ handshake กับการแกะเฟรมข้อความจากฝั่งไคลเอนต์
 */

import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { localIPv4Interfaces } from '../discovery/mdns';
import { GAMEPAD_PAGE } from './page';

/** ค่าคงที่ของโปรโตคอล WebSocket ตาม RFC 6455 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11F';

export interface GamepadState {
  running: boolean;
  port: number;
  /** ที่อยู่ที่มือถือเปิดได้ — มีหลายอันถ้า PC ต่อหลายวง */
  urls: string[];
  connected: number;
  injectorReady: boolean;
}

export class GamepadServer extends EventEmitter {
  private server: http.Server | null = null;
  private clients = new Set<net.Socket>();
  private port = 0;

  constructor(private log: (level: 'info' | 'warn' | 'error', message: string) => void = () => {}) {
    super();
  }

  state(injectorReady: boolean): GamepadState {
    return {
      running: this.server !== null,
      port: this.port,
      urls: this.server ? localIPv4Interfaces().map((ip) => `http://${ip}:${this.port}`) : [],
      connected: this.clients.size,
      injectorReady,
    };
  }

  async start(preferredPort = 8770): Promise<number> {
    if (this.server) return this.port;

    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url?.startsWith('/?')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          // หน้านี้เปลี่ยนทุกครั้งที่แก้แอป อย่าให้เบราว์เซอร์มือถือแคชไว้
          'Cache-Control': 'no-store',
        });
        res.end(GAMEPAD_PAGE);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ไม่มีหน้านี้');
    });

    server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket as net.Socket));

    this.port = await listenWithFallback(server, preferredPort);
    this.server = server;
    this.log('info', `เปิดเซิร์ฟเวอร์จอยที่พอร์ต ${this.port}`);
    this.emit('changed');
    return this.port;
  }

  // ─────────────────────────── WebSocket ───────────────────────────

  private handleUpgrade(req: http.IncomingMessage, socket: net.Socket): void {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // จอยต้องการหน่วงต่ำที่สุด — อย่าให้ Nagle รวมแพ็กเก็ตปุ่มไว้รอกัน
    socket.setNoDelay(true);

    this.clients.add(socket);
    this.log('info', `มือถือต่อเข้ามาแล้ว (${this.clients.size} เครื่อง)`);
    this.emit('changed');

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const frame = readFrame(buf);
        if (!frame) return;
        buf = buf.subarray(frame.consumed);

        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        if (frame.opcode === 0x9) {
          // ตอบ pong ด้วย payload เดิม ไม่งั้นเบราว์เซอร์บางตัวจะตัดสายทิ้ง
          socket.write(buildFrame(0xa, frame.payload));
          continue;
        }
        if (frame.opcode === 0x1) {
          this.onMessage(frame.payload.toString('utf8'));
        }
      }
    });

    const drop = (): void => {
      if (!this.clients.delete(socket)) return;
      this.log('info', `มือถือหลุด (เหลือ ${this.clients.size} เครื่อง)`);
      // 🔑 ปล่อยทุกปุ่มทันที ไม่งั้นตัวละครจะเดินหน้าไม่หยุดเมื่อสายหลุดกลางเกม
      this.emit('release-all');
      this.emit('changed');
      // ปิดฝั่งเราด้วย ไม่งั้นซ็อกเก็ตค้างครึ่งปิดไปเรื่อยๆ
      socket.destroy();
    };

    // 🔑 ต้องดัก 'end' ด้วย ไม่ใช่แค่ 'close'
    //    ซ็อกเก็ตที่อัปเกรดเป็น WebSocket แล้วอยู่ในโหมดครึ่งปิด: พอมือถือตัดสาย
    //    ฝั่งเราได้แค่ 'end' ส่วน 'close' จะไม่มาจนกว่าเราจะปิดเองด้วย
    //    ดักแต่ 'close' = ปุ่มค้างตลอดกาล (เจอมาแล้วตอนทดสอบ)
    socket.on('end', drop);
    socket.on('close', drop);
    socket.on('error', drop);
  }

  private onMessage(text: string): void {
    let msg: { t?: string; b?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return; // ข้อความเพี้ยนก็ทิ้ง ไม่ต้องตัดสาย
    }
    if (typeof msg.b !== 'string') return;
    if (msg.t === 'd') this.emit('button', { button: msg.b, down: true });
    else if (msg.t === 'u') this.emit('button', { button: msg.b, down: false });
  }

  /** ส่งข้อความหาโทรศัพท์ทุกเครื่อง เช่นแจ้งว่าผังปุ่มเปลี่ยน */
  broadcast(payload: unknown): void {
    const frame = buildFrame(0x1, Buffer.from(JSON.stringify(payload), 'utf8'));
    for (const socket of this.clients) {
      if (socket.writable) socket.write(frame);
    }
  }

  stop(): void {
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    this.server?.close();
    this.server = null;
    this.port = 0;
    this.log('info', 'ปิดเซิร์ฟเวอร์จอยแล้ว');
    this.emit('changed');
  }
}

// ─────────────────────────── เฟรม WebSocket ───────────────────────────

interface Frame {
  opcode: number;
  payload: Buffer;
  consumed: number;
}

/**
 * แกะหนึ่งเฟรม — คืน null ถ้าข้อมูลยังมาไม่ครบ
 * เฟรมจากไคลเอนต์ **ต้อง** มาสก์เสมอตามสเปก จึงต้องถอดมาสก์ทุกครั้ง
 */
function readFrame(buf: Buffer): Frame | null {
  if (buf.length < 2) return null;

  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    // ข้อความของจอยยาวไม่กี่สิบไบต์ — อะไรที่ใหญ่กว่านี้คือของปลอม
    if (big > 1_000_000n) return null;
    len = Number(big);
    offset += 8;
  }

  let mask: Buffer | null = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + len) return null;

  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }

  return { opcode, payload, consumed: offset + len };
}

/** ประกอบเฟรมฝั่งเซิร์ฟเวอร์ — ไม่ต้องมาสก์ */
function buildFrame(opcode: number, payload: Buffer): Buffer {
  const head: number[] = [0x80 | opcode];
  if (payload.length < 126) {
    head.push(payload.length);
  } else if (payload.length < 65536) {
    head.push(126, payload.length >> 8, payload.length & 0xff);
  } else {
    head.push(127, 0, 0, 0, 0, (payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff,
      (payload.length >>> 8) & 0xff, payload.length & 0xff);
  }
  return Buffer.concat([Buffer.from(head), payload]);
}

/** ลองพอร์ตที่อยากได้ก่อน ถ้าไม่ว่างค่อยให้ระบบเลือกให้ */
function listenWithFallback(server: http.Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code !== 'EADDRINUSE') {
        reject(err);
        return;
      }
      server.removeListener('error', onError);
      server.listen(0, () => resolve(addressPort(server)));
      server.once('error', reject);
    };
    server.once('error', onError);
    server.listen(preferred, () => {
      server.removeListener('error', onError);
      resolve(addressPort(server));
    });
  });
}

function addressPort(server: http.Server): number {
  const addr = server.address();
  return addr && typeof addr === 'object' ? addr.port : 0;
}
