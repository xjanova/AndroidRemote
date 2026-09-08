/**
 * รูปแบบข้อมูลบนสาย ระหว่าง PC กับ server ฝั่งมือถือ
 *
 * ⚠ ไฟล์นี้ต้องตรงกับ Controller.java และ DesktopConnection.java เป๊ะทุกไบต์
 *    แก้ที่นี่แล้วต้องไปแก้อีกฝั่งเสมอ — ไม่มีตัวตรวจให้อัตโนมัติ
 *
 * ทุกอย่างเป็น big-endian เพราะ DataOutputStream ของ Java เป็น big-endian
 * และเราไม่อยากให้ฝั่งที่แก้ยากกว่าต้องมาสลับไบต์เอง
 */

// ─────────────────────────── PC → เครื่อง ───────────────────────────

export const CTRL = {
  KEYCODE: 0x00,
  TEXT: 0x01,
  TOUCH: 0x02,
  SCROLL: 0x03,
  BACK_OR_SCREEN_ON: 0x04,
  SCREEN_POWER_MODE: 0x05,
  SHELL_EXEC: 0x06,
} as const;

// ─────────────────────────── เครื่อง → PC ───────────────────────────

export const REPLY = {
  SHELL_RESULT: 0x80,
} as const;

/** ช่องของซ็อกเก็ต — ไบต์แรกที่ server ส่งมาหลังต่อติด */
export const CHANNEL = {
  VIDEO: 0x01,
  CONTROL: 0x03,
} as const;

/** ค่าเดียวกับ MotionEvent ของแอนดรอยด์ ห้ามเปลี่ยน */
export const TOUCH_ACTION = {
  DOWN: 0,
  UP: 1,
  MOVE: 2,
  CANCEL: 3,
} as const;

/** ค่าเดียวกับ KeyEvent ของแอนดรอยด์ */
export const KEY_ACTION = {
  DOWN: 0,
  UP: 1,
} as const;

export const SCREEN_POWER = {
  OFF: 0,
  NORMAL: 2,
} as const;

// ─────────────────────────── ตัวเข้ารหัสคำสั่ง ───────────────────────────

export function encodeKeycode(
  action: number,
  keycode: number,
  repeat = 0,
  metaState = 0,
): Buffer {
  const b = Buffer.alloc(14);
  b.writeUInt8(CTRL.KEYCODE, 0);
  b.writeUInt8(action, 1);
  b.writeInt32BE(keycode, 2);
  b.writeInt32BE(repeat, 6);
  b.writeInt32BE(metaState, 10);
  return b;
}

export function encodeText(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const b = Buffer.alloc(5 + payload.length);
  b.writeUInt8(CTRL.TEXT, 0);
  b.writeInt32BE(payload.length, 1);
  payload.copy(b, 5);
  return b;
}

/**
 * @param x,y        พิกัดในระบบพิกัดของ "ภาพที่ PC เห็น"
 * @param screenW,H  ขนาดภาพที่ PC เห็น — ฝั่งมือถือใช้คู่นี้แปลงกลับเป็นพิกัดจอจริง
 * @param pressure   0..1
 */
export function encodeTouch(args: {
  action: number;
  pointerId: bigint;
  x: number;
  y: number;
  screenW: number;
  screenH: number;
  pressure?: number;
  buttons?: number;
}): Buffer {
  // 1+1+8+4+4+2+2+2+4 = 28 ไบต์ ตรงกับที่ Controller.java อ่าน
  const b = Buffer.alloc(28);
  b.writeUInt8(CTRL.TOUCH, 0);
  b.writeUInt8(args.action, 1);
  b.writeBigInt64BE(args.pointerId, 2);
  b.writeInt32BE(Math.round(args.x), 10);
  b.writeInt32BE(Math.round(args.y), 14);
  b.writeUInt16BE(clampU16(args.screenW), 18);
  b.writeUInt16BE(clampU16(args.screenH), 20);
  b.writeUInt16BE(Math.round(clamp01(args.pressure ?? 1) * 65535), 22);
  b.writeInt32BE(args.buttons ?? 0, 24);
  return b;
}

export function encodeScroll(args: {
  x: number;
  y: number;
  screenW: number;
  screenH: number;
  hScroll: number;
  vScroll: number;
}): Buffer {
  const b = Buffer.alloc(17);
  b.writeUInt8(CTRL.SCROLL, 0);
  b.writeInt32BE(Math.round(args.x), 1);
  b.writeInt32BE(Math.round(args.y), 5);
  b.writeUInt16BE(clampU16(args.screenW), 9);
  b.writeUInt16BE(clampU16(args.screenH), 11);
  // ส่งเป็นจำนวนเต็มคูณ 256 เพื่อเก็บทศนิยมโดยไม่ต้องใช้ float บนสาย
  b.writeInt16BE(clampI16(Math.round(args.hScroll * 256)), 13);
  b.writeInt16BE(clampI16(Math.round(args.vScroll * 256)), 15);
  return b;
}

export function encodeBackOrScreenOn(action: number): Buffer {
  return Buffer.from([CTRL.BACK_OR_SCREEN_ON, action]);
}

export function encodeScreenPowerMode(mode: number): Buffer {
  return Buffer.from([CTRL.SCREEN_POWER_MODE, mode]);
}

export function encodeShellExec(command: string): Buffer {
  const payload = Buffer.from(command, 'utf8');
  const b = Buffer.alloc(5 + payload.length);
  b.writeUInt8(CTRL.SHELL_EXEC, 0);
  b.writeInt32BE(payload.length, 1);
  payload.copy(b, 5);
  return b;
}

// ─────────────────────────── ตัวถอดรหัสวิดีโอ ───────────────────────────

export interface VideoHeader {
  deviceName: string;
  width: number;
  height: number;
  codec: 'h264' | 'h265';
}

export const VIDEO_HEADER_SIZE = 64 + 4 + 4 + 4;

export function parseVideoHeader(buf: Buffer): VideoHeader {
  const nameField = buf.subarray(0, 64);
  const nul = nameField.indexOf(0);
  const deviceName = nameField.subarray(0, nul < 0 ? 64 : nul).toString('utf8');
  const width = buf.readInt32BE(64);
  const height = buf.readInt32BE(68);
  const codec = buf.subarray(72, 76).toString('ascii') === 'h265' ? 'h265' : 'h264';
  return { deviceName, width, height, codec };
}

export interface VideoPacket {
  /** true = แพ็กเก็ตตั้งค่า (SPS/PPS) ไม่ใช่ภาพ ต้องป้อนให้ตัวถอดรหัสก่อนเฟรมแรก */
  config: boolean;
  keyFrame: boolean;
  /** ไมโครวินาที — ไม่มีความหมายเมื่อ config === true */
  ptsUs: bigint;
  data: Buffer;
}

export const PACKET_HEADER_SIZE = 12;

/** บิตบนสุดสองบิตของหัวแพ็กเก็ตเป็นธง ไม่ใช่เวลา */
const FLAG_CONFIG = 1n << 63n;
const FLAG_KEYFRAME = 1n << 62n;
const PTS_MASK = (1n << 62n) - 1n;

export function parsePacketHeader(buf: Buffer): { config: boolean; keyFrame: boolean; ptsUs: bigint; size: number } {
  const raw = buf.readBigUInt64BE(0);
  return {
    config: (raw & FLAG_CONFIG) !== 0n,
    keyFrame: (raw & FLAG_KEYFRAME) !== 0n,
    ptsUs: raw & PTS_MASK,
    size: buf.readInt32BE(8),
  };
}

// ─────────────────────────── ตัวช่วย ───────────────────────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampU16(v: number): number {
  const n = Math.round(v);
  return n < 0 ? 0 : n > 65535 ? 65535 : n;
}

function clampI16(v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}
