/**
 * ชนิดข้อมูลที่ main process กับ renderer ใช้ร่วมกัน
 * ห้าม import อะไรจาก node หรือ electron ในไฟล์นี้ — renderer ต้องกินได้ด้วย
 */

/** สถานะที่ adb รายงานกลับมาใน `host:track-devices` */
export type AdbState =
  | 'device'
  | 'unauthorized'
  | 'offline'
  | 'authorizing'
  | 'connecting'
  | 'bootloader'
  | 'recovery'
  | 'sideload'
  | 'rescue'
  | 'no permissions'
  | 'unknown';

/**
 * ระดับสิทธิ์ที่ยิงคำสั่งเข้าเครื่องได้ — เรียงจากน้อยไปมาก
 * ตัวเลขมีความหมาย ใช้เทียบ >= ได้ (ดู TIER_RANK)
 */
export type PrivilegeTier = 'none' | 'shell' | 'shizuku' | 'root';

export const TIER_RANK: Record<PrivilegeTier, number> = {
  none: 0,
  shell: 1,
  shizuku: 2,
  root: 3,
};

export function tierAtLeast(have: PrivilegeTier, need: PrivilegeTier): boolean {
  return TIER_RANK[have] >= TIER_RANK[need];
}

/** ช่องทางที่เครื่องต่ออยู่ */
export type TransportKind = 'usb' | 'tcp' | 'emulator' | 'unknown';

/**
 * ความสามารถแต่ละอย่างที่แอปทำได้ ผูกกับระดับสิทธิ์ขั้นต่ำที่ต้องมี
 * นี่คือแหล่งความจริงเดียวของคำถาม "เครื่องนี้ทำอะไรได้บ้าง"
 */
export type CapabilityId =
  | 'mirror'
  | 'control'
  | 'audio'
  | 'clipboard'
  | 'fileTransfer'
  | 'appManage'
  | 'settingsWrite'
  | 'virtualDisplay'
  | 'lockScreenInput'
  | 'rawInputDevice'
  | 'appDataAccess'
  | 'systemAppInstall'
  | 'processControl'
  | 'selinuxControl';

export interface CapabilitySpec {
  id: CapabilityId;
  /** ชื่อที่โชว์บน UI */
  label: string;
  /** ระดับสิทธิ์ขั้นต่ำ */
  requires: PrivilegeTier;
  /** ระดับ API ขั้นต่ำ (ไม่ระบุ = ไม่จำกัด) */
  minSdk?: number;
  /** อธิบายสั้นๆ ว่าทำอะไรได้ */
  note: string;
}

export const CAPABILITIES: CapabilitySpec[] = [
  { id: 'mirror',           label: 'มิเรอร์หน้าจอ',              requires: 'shell', note: 'จับภาพจอผ่าน SurfaceControl แล้วเข้ารหัสด้วย MediaCodec' },
  { id: 'control',          label: 'สั่งงานหน้าจอ',              requires: 'shell', note: 'ยิง touch/key ผ่าน InputManager — บาง OEM ต้องเปิดสวิตช์เพิ่ม' },
  { id: 'audio',            label: 'ดึงเสียง',                   requires: 'shell', minSdk: 30, note: 'AudioRecord บน REMOTE_SUBMIX' },
  { id: 'clipboard',        label: 'คลิปบอร์ดสองทาง',            requires: 'shell', note: 'อ่าน/เขียนผ่าน ClipboardManager' },
  { id: 'fileTransfer',     label: 'รับส่งไฟล์',                 requires: 'shell', note: 'adb sync protocol' },
  { id: 'appManage',        label: 'ติดตั้ง/ถอนแอป',             requires: 'shell', note: 'pm install / uninstall' },
  { id: 'settingsWrite',    label: 'แก้ค่าระบบ',                 requires: 'shell', note: 'settings put global/system/secure' },
  { id: 'virtualDisplay',   label: 'จอเสมือนแยกหน้าต่าง',        requires: 'shell', minSdk: 29, note: 'เปิดแอปในจอเสมือนโดยจอจริงยังใช้ได้' },
  { id: 'lockScreenInput',  label: 'สั่งงานตอนล็อกหน้าจอ',        requires: 'root',  note: 'เขียน /dev/input โดยตรง ข้ามชั้น InputManager' },
  { id: 'rawInputDevice',   label: 'ป้อนอินพุตระดับไดรเวอร์',     requires: 'root',  note: 'สร้าง uinput device — ใช้ได้แม้แอปกันการจำลองสัมผัส' },
  { id: 'appDataAccess',    label: 'เข้าถึงข้อมูลแอปอื่น',        requires: 'root',  note: 'อ่าน/เขียน /data/data/<pkg> ของทุกแอป' },
  { id: 'systemAppInstall', label: 'ติดตั้งเป็นแอประบบ',          requires: 'root',  note: 'วางลง /system/priv-app แล้ว remount' },
  { id: 'processControl',   label: 'คุมโพรเซสทุกตัว',            requires: 'root',  note: 'kill/renice/trace ได้ทุก uid' },
  { id: 'selinuxControl',   label: 'สลับโหมด SELinux',           requires: 'root',  note: 'setenforce 0/1 — ปลดล็อกงานที่ policy บล็อกไว้' },
];

/** สาเหตุที่เครื่องยังใช้งานไม่ได้ พร้อมวิธีแก้ที่เจาะจงพอจะทำตามได้จริง */
export type BlockerId =
  | 'usb-debugging-off'
  | 'unauthorized'
  | 'offline'
  | 'miui-secure-settings'
  | 'no-root'
  | 'shizuku-not-running';

export interface Blocker {
  id: BlockerId;
  /** ระดับความรุนแรง — fatal = ใช้งานไม่ได้เลย, limited = ใช้ได้แต่ขาดฟีเจอร์ */
  severity: 'fatal' | 'limited';
  title: string;
  detail: string;
  /** ขั้นตอนแก้ ทีละข้อ เขียนให้ทำตามได้โดยไม่ต้องเดา */
  steps: string[];
}

export interface DeviceInfo {
  /** serial ที่ adb ใช้อ้างอิงเครื่อง — เป็น ip:port เมื่อต่อไร้สาย */
  serial: string;
  /**
   * serial จริงของฮาร์ดแวร์ (ro.serialno)
   * ต่างจาก serial ด้านบนเมื่อต่อไร้สาย และเป็นตัวเดียวกับที่แอนดรอยด์ใช้
   * ตั้งชื่อบริการ mDNS (adb-<hwSerial>-<สุ่ม>) จึงใช้จับคู่กันได้
   */
  hwSerial?: string;
  state: AdbState;
  transport: TransportKind;

  /** ข้อมูลด้านล่างจะมีก็ต่อเมื่อ state === 'device' (probe สำเร็จ) */
  model?: string;
  brand?: string;
  manufacturer?: string;
  androidRelease?: string;
  sdk?: number;
  /** ชื่อ ROM ที่ผู้ผลิตครอบมา เช่น HyperOS, One UI — ว่างถ้าเป็น AOSP */
  romName?: string;
  abi?: string;
  screenWidth?: number;
  screenHeight?: number;
  screenDensity?: number;
  batteryLevel?: number;
  batteryCharging?: boolean;

  tier: PrivilegeTier;
  /** true ถ้ามี su แต่ผู้ใช้ยังไม่กดอนุญาตในแอป root manager */
  rootAvailableButDenied?: boolean;
  capabilities: CapabilityId[];
  blockers: Blocker[];

  /** เวลาที่ probe ล่าสุดสำเร็จ (epoch ms) */
  probedAt?: number;
  /** ข้อความ error จาก probe รอบล่าสุด ถ้ามี */
  probeError?: string;
}

/** ผลลัพธ์การรันคำสั่งบนเครื่อง */
export interface ShellResult {
  stdout: string;
  stderr: string;
  /** -1 = ไม่ทราบ (โปรโตคอล exec: ไม่ส่ง exit code กลับมา) */
  exitCode: number;
}

/** สถานะของตัว adb server บนเครื่อง PC */
export interface AdbStatus {
  ok: boolean;
  /** พาธของ adb.exe ที่ใช้อยู่ */
  path?: string;
  version?: string;
  /** ข้อความบอกสาเหตุเมื่อ ok === false */
  error?: string;
}

// ─────────────────────────── ค้นหาเครื่องบนวง LAN ───────────────────────────

/**
 * ชนิดของสิ่งที่เจอ
 *   connect = เปิดไร้สายอยู่ จับคู่แล้ว ต่อได้เลย
 *   pairing = กำลังเปิดหน้าจับคู่อยู่ตอนนี้ ต้องใส่รหัส 6 หลัก
 *   legacy  = เปิดพอร์ต 5555 ไว้แบบเก่า (adb tcpip) ต่อได้โดยไม่ต้องจับคู่
 */
export type DiscoveryKind = 'connect' | 'pairing' | 'legacy';

/** ทางที่เจอ — บอกผู้ใช้ได้ว่าทำไมบางเครื่องขึ้นบางเครื่องไม่ขึ้น */
export type DiscoverySource = 'mdns' | 'adb-mdns' | 'scan';

export interface DiscoveredDevice {
  /** กุญแจซ้ำไม่ได้ — ใช้รวมผลจากหลายทางที่ชี้เครื่องเดียวกัน */
  key: string;
  kind: DiscoveryKind;
  /** serial ที่แกะจากชื่อ mDNS — null ถ้ามาจากการกวาดพอร์ต */
  serial: string | null;
  address: string;
  port: number;
  name?: string;
  sources: DiscoverySource[];
  /** อยู่ในรายชื่อเครื่องที่เคยจับคู่ไว้ */
  known: boolean;
  /** ต่ออยู่แล้วในตอนนี้ */
  connected: boolean;
  at: number;
}

export interface DiscoveryState {
  running: boolean;
  /** กำลังกวาดพอร์ตอยู่ไหม พร้อมความคืบหน้า */
  sweeping: boolean;
  sweepDone: number;
  sweepTotal: number;
  devices: DiscoveredDevice[];
}

// ─────────────────────────── โหมดจอยเกม ───────────────────────────

export const GAMEPAD_BUTTONS = [
  'UP', 'DOWN', 'LEFT', 'RIGHT',
  'A', 'B', 'X', 'Y',
  'L1', 'R1', 'L2', 'R2',
  'START', 'SELECT',
] as const;

export type GamepadButton = (typeof GAMEPAD_BUTTONS)[number];

/**
 * ผังปุ่มเริ่มต้น — อิงจากที่เกม PC ส่วนใหญ่ใช้กันจริง
 * ปุ่มทิศทางเป็น WASD ไม่ใช่ลูกศร เพราะเกมยิงมุมมองบุคคลที่หนึ่งแทบทุกเกมใช้ WASD
 */
export const DEFAULT_KEYMAP: Record<GamepadButton, number> = {
  UP: 0x57,     // W
  DOWN: 0x53,   // S
  LEFT: 0x41,   // A
  RIGHT: 0x44,  // D
  A: 0x20,      // Space — กระโดด
  B: 0xa0,      // Shift ซ้าย — วิ่ง
  X: 0x45,      // E — ใช้งาน
  Y: 0x52,      // R — เปลี่ยนกระสุน
  L1: 0x51,     // Q
  R1: 0x46,     // F
  L2: 0xa2,     // Ctrl ซ้าย — ย่อ
  R2: 0x47,     // G — ระเบิด
  START: 0x1b,  // Esc
  SELECT: 0x09, // Tab
};

/** ชื่อปุ่มที่อ่านออก สำหรับรหัสที่ไม่ใช่ตัวอักษร/ตัวเลขธรรมดา */
export const VK_NAMES: Record<number, string> = {
  0x08: 'Backspace', 0x09: 'Tab', 0x0d: 'Enter', 0x10: 'Shift', 0x11: 'Ctrl', 0x12: 'Alt',
  0x14: 'CapsLock', 0x1b: 'Esc', 0x20: 'Space', 0x21: 'PageUp', 0x22: 'PageDown',
  0x23: 'End', 0x24: 'Home', 0x25: '◀', 0x26: '▲', 0x27: '▶', 0x28: '▼',
  0x2d: 'Insert', 0x2e: 'Delete',
  0xa0: 'Shift ซ้าย', 0xa1: 'Shift ขวา', 0xa2: 'Ctrl ซ้าย', 0xa3: 'Ctrl ขวา',
  0xa4: 'Alt ซ้าย', 0xa5: 'Alt ขวา',
  0x70: 'F1', 0x71: 'F2', 0x72: 'F3', 0x73: 'F4', 0x74: 'F5', 0x75: 'F6',
  0x76: 'F7', 0x77: 'F8', 0x78: 'F9', 0x79: 'F10', 0x7a: 'F11', 0x7b: 'F12',
};

/** แปลงรหัสปุ่มวินโดวส์เป็นข้อความที่ผู้ใช้อ่านรู้เรื่อง */
export function vkLabel(vk: number): string {
  if (VK_NAMES[vk]) return VK_NAMES[vk];
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);          // 0-9
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);          // A-Z
  if (vk >= 0x60 && vk <= 0x69) return `Num ${vk - 0x60}`;
  return `รหัส ${vk}`;
}

export interface GamepadStateView {
  running: boolean;
  port: number;
  /** ที่อยู่ที่มือถือเปิดได้ — มีหลายอันถ้า PC ต่อหลายวง */
  urls: string[];
  connected: number;
  /** ตัวฉีดคีย์พร้อมหรือยัง — ถ้าไม่พร้อม กดปุ่มแล้วจะไม่มีอะไรเกิดขึ้น */
  injectorReady: boolean;
  keymap: Record<string, number>;
}

/** เหตุการณ์ที่ main ยิงไปหา renderer */
export interface MainEvents {
  'devices:changed': DeviceInfo[];
  'device:updated': DeviceInfo;
  'adb:status': AdbStatus;
  'log': { level: 'info' | 'warn' | 'error'; scope: string; message: string; at: number };
}
