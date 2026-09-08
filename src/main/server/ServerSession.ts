/**
 * หนึ่งเซสชันมิเรอร์ — ตั้งแต่ยิง server เข้าเครื่องจนถึงปิด
 *
 * ลำดับที่สำคัญมาก และผิดลำดับแล้วพังเงียบ:
 *   1. เปิด TCP server บน PC ก่อน
 *   2. adb reverse ชี้ localabstract บนเครื่อง มาที่พอร์ตนั้น
 *   3. ค่อยสั่งรัน server บนเครื่อง
 * ถ้าสลับ 2 กับ 3 เครื่องจะวิ่งมาชนตอนยังไม่มีใครรับ แล้วตายทันทีโดยไม่มี error ที่อ่านออก
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import type { AdbClient } from '../adb/AdbClient';
import {
  CHANNEL,
  PACKET_HEADER_SIZE,
  REPLY,
  VIDEO_HEADER_SIZE,
  parsePacketHeader,
  parseVideoHeader,
  type VideoHeader,
  type VideoPacket,
} from './messages';

const REMOTE_PATH = '/data/local/tmp/androidremote-server.jar';
const SOCKET_NAME = 'androidremote';
const MAIN_CLASS = 'com.androidremote.server.Main';

/** รอ server ต่อกลับมานานสุดเท่านี้ก่อนยอมแพ้ */
const CONNECT_TIMEOUT_MS = 12_000;

export interface SessionOptions {
  maxSize?: number;
  bitRate?: number;
  maxFps?: number;
  codec?: 'h264' | 'h265';
  control?: boolean;
  /** ยิงผ่าน su ให้ server เป็น root — ต้องแน่ใจว่าเครื่องมี root จริงก่อนเรียก */
  useRoot?: boolean;
  screenOffOnStart?: boolean;
  /** screen = มิเรอร์จอ · camera = ใช้กล้องแทนเว็บแคม */
  mode?: 'screen' | 'camera';
  /** ไอดีกล้องที่จะเปิด — หนึ่งสตรีมต่อหนึ่งตัว */
  cameraIds?: string[];
}

/** ข้อมูลกล้องหนึ่งตัวที่อ่านมาจากเครื่อง */
export interface CameraInfo {
  id: string;
  facing: 'front' | 'back' | 'external' | 'unknown';
  maxWidth: number;
  maxHeight: number;
  focalLength: number;
  legacy: boolean;
  error?: string;
}

export interface CameraList {
  cameras: CameraInfo[];
  /** ชุดกล้องที่เครื่องนี้เปิดพร้อมกันได้จริง — ว่างแปลว่าเปิดได้ทีละตัว */
  concurrent: string[][];
  error?: string;
}

/** พาธของ jar ที่ build ไว้ — ต่างกันระหว่างตอน dev กับตอนแพ็กแล้ว */
export function localJarPath(): string {
  const packed = path.join(process.resourcesPath ?? '', 'androidremote-server.jar');
  if (process.resourcesPath && fs.existsSync(packed)) return packed;
  return path.join(process.cwd(), 'resources', 'androidremote-server.jar');
}

/**
 * ถามเครื่องว่ามีกล้องอะไรบ้าง
 *
 * รันในโหมดที่ไม่ต้องต่อซ็อกเก็ตเลย — พิมพ์ JSON บรรทัดเดียวออก stdout แล้วจบ
 * เร็วกว่าและพังยากกว่าการเปิดเซสชันเต็มแค่เพื่อถามรายการ
 */
export async function listCameras(
  adb: AdbClient,
  serial: string,
  useRoot = false,
): Promise<CameraList> {
  const jar = localJarPath();
  if (!fs.existsSync(jar)) {
    return { cameras: [], concurrent: [], error: `ไม่พบ ${jar} — รัน npm run server:build ก่อน` };
  }
  await adb.pushData(serial, await fs.promises.readFile(jar), REMOTE_PATH, 0o644);

  const inner = `CLASSPATH=${REMOTE_PATH} app_process / ${MAIN_CLASS} mode=camera-list`;
  const command = useRoot ? `su -c '${inner.replace(/'/g, `'\\''`)}'` : inner;
  const res = await adb.exec(serial, command);

  // stdout อาจมีบรรทัดล็อกของ ART ปนมา — เอาเฉพาะบรรทัดที่เป็น JSON
  const line = res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'))
    .pop();

  if (!line) {
    return {
      cameras: [],
      concurrent: [],
      error: `เครื่องไม่ตอบรายการกล้องมา: ${res.stdout.trim().slice(0, 400) || '(ว่าง)'}`,
    };
  }

  try {
    const parsed = JSON.parse(line) as CameraList;
    return {
      cameras: Array.isArray(parsed.cameras) ? parsed.cameras : [],
      concurrent: Array.isArray(parsed.concurrent) ? parsed.concurrent : [],
      error: parsed.error,
    };
  } catch (err) {
    return {
      cameras: [],
      concurrent: [],
      error: `อ่าน JSON รายการกล้องไม่ได้: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export class ServerSession extends EventEmitter {
  private tcpServer: net.Server | null = null;
  /** ซ็อกเก็ตวิดีโอต่อหนึ่งสตรีม — โหมดกล้องเปิดได้หลายตัวพร้อมกัน */
  private videoSockets = new Map<number, net.Socket>();
  private controlSocket: net.Socket | null = null;
  private stopServerProcess: (() => void) | null = null;
  private port = 0;
  private closed = false;

  constructor(
    private adb: AdbClient,
    private serial: string,
    private options: SessionOptions = {},
  ) {
    super();
  }

  async start(): Promise<void> {
    const jar = localJarPath();
    if (!fs.existsSync(jar)) {
      throw new Error(`ไม่พบ ${jar} — รัน npm run server:build ก่อน`);
    }

    // 1. เปิดที่รับก่อน
    this.port = await this.listen();
    this.emit('log', `เปิดพอร์ตรับที่ ${this.port}`);

    // 2. ส่ง jar เข้าเครื่อง แล้วชี้ทางกลับ
    await this.adb.pushData(this.serial, await fs.promises.readFile(jar), REMOTE_PATH, 0o644);
    this.emit('log', `ส่ง server เข้า ${REMOTE_PATH} แล้ว`);

    await this.adb.reverseRemove(this.serial, `localabstract:${SOCKET_NAME}`);
    await this.adb.reverse(this.serial, `localabstract:${SOCKET_NAME}`, `tcp:${this.port}`);
    this.emit('log', `ตั้ง reverse localabstract:${SOCKET_NAME} → tcp:${this.port}`);

    // 3. ค่อยสั่งรัน
    const connected = this.waitForSockets();
    await this.launch();

    try {
      await connected;
    } catch (err) {
      this.stop('เชื่อมต่อไม่สำเร็จ');
      throw err;
    }
  }

  private listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      this.tcpServer = server;

      server.on('connection', (socket) => {
        socket.setNoDelay(true);
        // สองไบต์แรกคือ [ช่อง][หมายเลขสตรีม] — ต้องรอให้ครบทั้งคู่ก่อน
        // chunk แรกอาจมาแค่ไบต์เดียวได้ ถ้าเน็ตแบ่งแพ็กเก็ตแปลกๆ
        let intro = Buffer.alloc(0);
        const onIntro = (chunk: Buffer): void => {
          intro = Buffer.concat([intro, chunk]);
          if (intro.length < 2) return;
          socket.removeListener('data', onIntro);

          const channel = intro[0];
          const streamId = intro[1];
          const rest = intro.subarray(2);

          if (channel === CHANNEL.VIDEO) {
            this.videoSockets.set(streamId, socket);
            this.attachVideo(socket, streamId, rest);
          } else if (channel === CHANNEL.CONTROL) {
            this.controlSocket = socket;
            this.attachControl(socket, rest);
          } else {
            this.emit('log', `ช่องที่ไม่รู้จัก: ${channel} — ตัดทิ้ง`);
            socket.destroy();
          }
        };
        socket.on('data', onIntro);
      });

      server.on('error', reject);
      // 0 = ให้ระบบเลือกพอร์ตว่างให้ ไม่ไปชนกับของใครในเครื่อง
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('อ่านพอร์ตที่เปิดไม่ได้'));
      });
    });
  }

  /** รอให้ช่องวิดีโอต่อเข้ามา (ช่องควบคุมเป็นของแถม ขาดได้) */
  private waitForSockets(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `server ไม่ต่อกลับมาภายใน ${CONNECT_TIMEOUT_MS / 1000} วินาที — ` +
              'ดูบรรทัดที่ขึ้นต้นด้วย [AR] E ในบันทึกเหตุการณ์',
          ),
        );
      }, CONNECT_TIMEOUT_MS);

      this.once('header', () => {
        clearTimeout(timer);
        resolve();
      });
      this.once('closed', (reason: string) => {
        clearTimeout(timer);
        reject(new Error(reason));
      });
    });
  }

  private async launch(): Promise<void> {
    const o = this.options;
    const args = [
      `mode=${o.mode ?? 'screen'}`,
      `socket_name=${SOCKET_NAME}`,
      `max_size=${o.maxSize ?? 0}`,
      `bit_rate=${o.bitRate ?? 8_000_000}`,
      `max_fps=${o.maxFps ?? 60}`,
      `codec=${o.codec ?? 'h264'}`,
      `control=${o.control !== false}`,
      `root=${o.useRoot === true}`,
      `screen_power_mode=${o.screenOffOnStart ? 0 : -1}`,
      ...(o.cameraIds?.length ? [`camera_ids=${o.cameraIds.join(',')}`] : []),
    ].join(' ');

    const inner = `CLASSPATH=${REMOTE_PATH} app_process / ${MAIN_CLASS} ${args}`;
    // ยิงผ่าน su เมื่อขอ root — โพรเซสลูกจะเป็น uid 0 ทั้งตัว รวมถึงคำสั่งที่มันรันต่อ
    const command = this.options.useRoot ? `su -c '${inner.replace(/'/g, `'\\''`)}'` : inner;

    this.emit('log', `สั่งรัน: ${command}`);

    this.stopServerProcess = await this.adb.execStream(
      this.serial,
      command,
      (chunk) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          const t = line.trim();
          if (t) this.emit('log', t);
        }
      },
      () => {
        // โพรเซสจบ = เซสชันจบ ไม่ว่าจะด้วยเหตุใด
        this.stop('โพรเซส server บนเครื่องจบแล้ว');
      },
    );
  }

  // ─────────────────────────── ช่องวิดีโอ ───────────────────────────

  private attachVideo(socket: net.Socket, streamId: number, initial: Buffer): void {
    let buf = initial;
    let header: VideoHeader | null = null;

    const consume = (): void => {
      for (;;) {
        if (!header) {
          if (buf.length < VIDEO_HEADER_SIZE) return;
          header = parseVideoHeader(buf.subarray(0, VIDEO_HEADER_SIZE));
          buf = buf.subarray(VIDEO_HEADER_SIZE);
          this.emit('header', { ...header, streamId });
          continue;
        }
        if (buf.length < PACKET_HEADER_SIZE) return;
        const meta = parsePacketHeader(buf.subarray(0, PACKET_HEADER_SIZE));
        if (meta.size < 0 || meta.size > 32 * 1024 * 1024) {
          this.emit('log', `ขนาดแพ็กเก็ตไม่สมเหตุผล (${meta.size}) — ตัดการเชื่อมต่อ`);
          this.stop('สตรีมวิดีโอเพี้ยน');
          return;
        }
        if (buf.length < PACKET_HEADER_SIZE + meta.size) return;

        const data = buf.subarray(PACKET_HEADER_SIZE, PACKET_HEADER_SIZE + meta.size);
        buf = buf.subarray(PACKET_HEADER_SIZE + meta.size);
        this.emit('packet', {
          streamId,
          config: meta.config,
          keyFrame: meta.keyFrame,
          ptsUs: meta.ptsUs,
          // ต้องคัดลอก — subarray แชร์หน่วยความจำกับบัฟเฟอร์ที่กำลังจะถูกเขียนทับ
          data: Buffer.from(data),
        } satisfies VideoPacket & { streamId: number });
      }
    };

    consume();
    socket.on('data', (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      consume();
    });
    socket.on('close', () => {
      this.videoSockets.delete(streamId);
      this.emit('streamClosed', streamId);
      // กล้องตัวหนึ่งหลุดไม่ควรฆ่าตัวที่เหลือ — จบเซสชันเมื่อไม่เหลือสตรีมเลย
      if (this.videoSockets.size === 0) this.stop('ช่องวิดีโอปิดหมดแล้ว');
    });
    socket.on('error', (err) => this.emit('log', `สตรีม ${streamId} ผิดพลาด: ${err.message}`));
  }

  // ─────────────────────────── ช่องควบคุม ───────────────────────────

  private attachControl(socket: net.Socket, initial: Buffer): void {
    let buf = initial;

    const consume = (): void => {
      for (;;) {
        if (buf.length < 1) return;
        const type = buf[0];
        if (type === REPLY.SHELL_RESULT) {
          if (buf.length < 9) return;
          const exitCode = buf.readInt32BE(1);
          const len = buf.readInt32BE(5);
          if (buf.length < 9 + len) return;
          const output = buf.subarray(9, 9 + len).toString('utf8');
          buf = buf.subarray(9 + len);
          this.emit('shellResult', { exitCode, output });
        } else {
          this.emit('log', `คำตอบชนิดที่ไม่รู้จักจากเครื่อง: ${type}`);
          buf = buf.subarray(1);
        }
      }
    };

    consume();
    socket.on('data', (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      consume();
    });
    socket.on('error', (err) => this.emit('log', `ช่องควบคุมผิดพลาด: ${err.message}`));
  }

  /** ส่งคำสั่งไปเครื่อง — เงียบถ้าไม่มีช่องควบคุม แทนที่จะโยน */
  send(message: Buffer): boolean {
    if (!this.controlSocket || this.controlSocket.destroyed) return false;
    return this.controlSocket.write(message);
  }

  get hasControl(): boolean {
    return this.controlSocket !== null && !this.controlSocket.destroyed;
  }

  stop(reason = 'ผู้ใช้สั่งหยุด'): void {
    if (this.closed) return;
    this.closed = true;

    this.stopServerProcess?.();
    for (const socket of this.videoSockets.values()) socket.destroy();
    this.videoSockets.clear();
    this.controlSocket?.destroy();
    this.tcpServer?.close();
    void this.adb.reverseRemove(this.serial, `localabstract:${SOCKET_NAME}`).catch(() => {});

    this.emit('closed', reason);
  }
}
