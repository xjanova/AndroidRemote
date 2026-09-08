/**
 * ชั้นล่างสุด: พูดกับ adb server ด้วยโปรโตคอลของมันตรงๆ ผ่าน TCP 127.0.0.1:5037
 *
 * ทำไมไม่ spawn adb.exe ทุกครั้ง — สองเหตุผล
 *   1. `host:track-devices` เป็นสตรีมแบบ push ตัว adb.exe ไม่เปิดทางให้ ต้องมา poll เอง
 *   2. spawn โพรเซสต่อหนึ่งคำสั่งกินเวลา 20–60 ms บน Windows ซึ่งแพงเกินไป
 *      สำหรับคำสั่งที่ยิงถี่ๆ ตอนคุมเครื่อง
 *
 * รูปแบบคำขอ:  <ความยาว 4 หลักฐานสิบหก><payload>   เช่น  "000Chost:devices"
 * รูปแบบคำตอบ: "OKAY" หรือ "FAIL" + <ความยาว 4 หลัก><ข้อความ error>
 */

import net from 'node:net';

export const ADB_PORT = 5037;
export const ADB_HOST = '127.0.0.1';

export class AdbError extends Error {
  constructor(
    message: string,
    readonly request?: string,
  ) {
    super(message);
    this.name = 'AdbError';
  }
}

/** ต่อ adb server ไม่ติด — โยนตัวนี้เพื่อให้ชั้นบนรู้ว่าควรลอง start-server */
export class AdbServerDownError extends AdbError {
  constructor(cause: string) {
    super(`ต่อ adb server ที่ ${ADB_HOST}:${ADB_PORT} ไม่ได้ (${cause})`);
    this.name = 'AdbServerDownError';
  }
}

/**
 * socket หนึ่งเส้นที่อ่านแบบ async ได้
 *
 * adb ใช้ socket เส้นเดียวต่อหนึ่ง "session": ยิง host command แล้วอาจแปลงร่าง
 * เป็นสตรีมของเครื่องปลายทางต่อ (หลัง host:transport) — คลาสนี้เลยไม่ปิด socket
 * ให้เอง ผู้เรียกเป็นคนตัดสินว่าจบเมื่อไหร่
 */
export class AdbSocket {
  private sock: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;
  private error: Error | null = null;
  /** ผู้รออ่านหนึ่งราย ณ เวลาหนึ่ง — โปรโตคอล adb เป็น request/response เรียงลำดับ */
  private pending: { need: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  /** เมื่อตั้งค่าไว้ ข้อมูลที่เข้ามาจะถูกส่งต่อทันทีแทนการเก็บใส่บัฟเฟอร์ */
  private flowing: ((chunk: Buffer) => void) | null = null;

  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on('data', (chunk: Buffer) => {
      if (this.flowing) {
        this.flowing(chunk);
        return;
      }
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      this.pump();
    });
    sock.on('end', () => {
      this.ended = true;
      this.pump();
    });
    sock.on('close', () => {
      this.ended = true;
      this.pump();
    });
    sock.on('error', (err) => {
      this.error = err;
      this.ended = true;
      this.pump();
    });
  }

  static connect(timeoutMs = 5000): Promise<AdbSocket> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: ADB_HOST, port: ADB_PORT });
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.destroy();
        reject(new AdbServerDownError('หมดเวลารอเชื่อมต่อ'));
      }, timeoutMs);

      sock.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.setNoDelay(true);
        resolve(new AdbSocket(sock));
      });

      sock.once('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new AdbServerDownError(err.code ?? err.message));
      });
    });
  }

  /** ปล่อยข้อมูลที่ค้างในบัฟเฟอร์ให้ผู้รอ ถ้าพอ หรือปิดงานถ้า socket จบแล้ว */
  private pump(): void {
    const p = this.pending;
    if (!p) return;

    if (this.buf.length >= p.need) {
      this.pending = null;
      const out = this.buf.subarray(0, p.need);
      this.buf = this.buf.subarray(p.need);
      p.resolve(out);
      return;
    }

    if (this.ended) {
      this.pending = null;
      if (this.error) {
        p.reject(this.error);
      } else {
        p.reject(new AdbError(`socket ปิดก่อนได้ข้อมูลครบ (ต้องการ ${p.need} ไบต์ ได้ ${this.buf.length})`));
      }
    }
  }

  /** อ่านให้ครบ n ไบต์ */
  read(n: number): Promise<Buffer> {
    if (n === 0) return Promise.resolve(Buffer.alloc(0));
    if (this.pending) return Promise.reject(new AdbError('มีคำสั่งอ่านค้างอยู่แล้ว'));
    return new Promise((resolve, reject) => {
      this.pending = { need: n, resolve, reject };
      this.pump();
    });
  }

  /** อ่านจนกว่า socket จะปิด — ใช้กับคำสั่งที่จบด้วยการปิดสตรีม เช่น exec: */
  readToEnd(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      if (this.buf.length) {
        parts.push(this.buf);
        this.buf = Buffer.alloc(0);
      }
      if (this.ended) {
        if (this.error) reject(this.error);
        else resolve(Buffer.concat(parts));
        return;
      }
      this.flowing = (chunk) => parts.push(chunk);
      this.sock.once('close', () => {
        if (this.error) reject(this.error);
        else resolve(Buffer.concat(parts));
      });
      this.sock.once('error', (err) => reject(err));
    });
  }

  /**
   * เปลี่ยน socket เป็นโหมดสตรีม — ทุก chunk ที่เข้ามาถูกส่งเข้า onChunk ทันที
   * ใช้กับ track-devices และช่องวิดีโอ/ควบคุมของ server ฝั่งมือถือ
   */
  stream(onChunk: (b: Buffer) => void, onClose?: (err?: Error) => void): void {
    if (this.buf.length) {
      const leftover = this.buf;
      this.buf = Buffer.alloc(0);
      onChunk(leftover);
    }
    this.flowing = onChunk;
    if (onClose) {
      this.sock.once('close', () => onClose(this.error ?? undefined));
    }
  }

  write(data: Buffer | string): void {
    this.sock.write(data);
  }

  /** ส่งคำขอในรูปแบบ <ความยาว 4 หลักฐานสิบหก><payload> */
  async send(request: string): Promise<void> {
    const payload = Buffer.from(request, 'utf8');
    const header = Buffer.from(payload.length.toString(16).padStart(4, '0'), 'utf8');
    this.sock.write(Buffer.concat([header, payload]));
  }

  /** อ่านสถานะ OKAY/FAIL — โยน AdbError พร้อมข้อความจริงถ้า FAIL */
  async readStatus(request?: string): Promise<void> {
    const status = (await this.read(4)).toString('utf8');
    if (status === 'OKAY') return;
    if (status === 'FAIL') {
      const message = await this.readMessage();
      throw new AdbError(message, request);
    }
    throw new AdbError(`สถานะที่ไม่รู้จักจาก adb: ${JSON.stringify(status)}`, request);
  }

  /** อ่านข้อความที่นำหน้าด้วยความยาว 4 หลักฐานสิบหก */
  async readMessage(): Promise<string> {
    const lenHex = (await this.read(4)).toString('utf8');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) throw new AdbError(`ความยาวไม่ถูกต้อง: ${JSON.stringify(lenHex)}`);
    if (len === 0) return '';
    return (await this.read(len)).toString('utf8');
  }

  /** ยิงคำขอแล้วรอสถานะ — รวมสองขั้นที่ใช้คู่กันเสมอ */
  async request(req: string): Promise<void> {
    await this.send(req);
    await this.readStatus(req);
  }

  close(): void {
    this.flowing = null;
    this.sock.destroy();
  }

  get socket(): net.Socket {
    return this.sock;
  }
}

/**
 * แยกผลลัพธ์ของ host:devices-l ออกเป็นรายการ
 *
 * รูปแบบหนึ่งบรรทัด:
 *   R5CT80XXXXW  device product:dm3q model:SM_S918B device:dm3q transport_id:3
 *   192.168.1.42:5555  device product:...
 *   emulator-5554  device ...
 * เครื่องที่ยังไม่อนุญาตจะได้แค่ `<serial> unauthorized`
 */
export interface RawDeviceLine {
  serial: string;
  state: string;
  props: Record<string, string>;
}

export function parseDeviceList(text: string): RawDeviceLine[] {
  const out: RawDeviceLine[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // แยกด้วยช่องว่างชุดแรก — serial ห้ามมีช่องว่างอยู่แล้ว
    const firstGap = line.search(/\s/);
    if (firstGap < 0) continue;
    const serial = line.slice(0, firstGap);
    const rest = line.slice(firstGap).trim();
    const parts = rest.split(/\s+/);
    const state = parts[0] ?? 'unknown';
    const props: Record<string, string> = {};
    for (const part of parts.slice(1)) {
      const eq = part.indexOf(':');
      if (eq > 0) props[part.slice(0, eq)] = part.slice(eq + 1);
    }
    // adb เขียนสถานะ "no permissions" เป็นสองคำ ต่อด้วยลิงก์ช่วยเหลือในวงเล็บ
    out.push({
      serial,
      state: rest.startsWith('no permissions') ? 'no permissions' : state,
      props,
    });
  }
  return out;
}
