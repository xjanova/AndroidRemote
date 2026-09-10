/**
 * ชนิดข้อมูลของมาโครและการตั้งเวลา — ใช้ร่วมกันทั้ง main และ renderer
 * ห้าม import จาก node/electron ในไฟล์นี้
 *
 * แนวคิดเดียวกับ tping: บันทึกขั้นตอน → เล่นซ้ำ → วนได้ → หา element แทนพิกัดดิบ
 * ต่างตรงที่ทำจาก PC ผ่านช่องควบคุมของแต่ละเครื่อง จึงยิงไปหลายเครื่องพร้อมกันได้
 * และไม่ต้องลงแอปหรือเปิด Accessibility บนมือถือ
 *
 * v2 (สำหรับเกม/บอท): ตัวแปร + โปรไฟล์ต่อเครื่อง · เงื่อนไข/กระโดด · หาภาพ (template)
 * · อ่านตัวเลข (OCR) · เสียงต่อเครื่อง · สุ่มให้เหมือนคน · นโยบายเมื่อพัง
 */

/**
 * ตัวเลือก element บนหน้าจอ — เรียงตามความแม่นเหมือน tping
 * ตอนเล่น ใช้ตัวที่แม่นสุดที่มีก่อน แล้วค่อยถอยลงมา สุดท้ายคือพิกัด
 */
export interface UiSelector {
  resourceId?: string;
  text?: string;
  contentDesc?: string;
  className?: string;
  /** พิกัดสำรอง (สัดส่วน 0..1 ของจอ) ใช้เมื่อหา element ไม่เจอเลย */
  fallback?: { fx: number; fy: number };
}

/** โหนดหนึ่งตัวจาก uiautomator dump ที่ตัดให้เหลือแค่ที่ใช้เลือกได้ */
export interface UiNodeView {
  resourceId: string;
  text: string;
  contentDesc: string;
  className: string;
  /** กรอบบนจอจริง */
  bounds: { left: number; top: number; right: number; bottom: number };
  clickable: boolean;
}

/** กรอบบนจอเป็นสัดส่วน 0..1 — ใช้ได้ทุกความละเอียด */
export interface FracRect {
  fx: number;
  fy: number;
  fw: number;
  fh: number;
}

export type VolumeStream = 'media' | 'ring' | 'notification' | 'alarm';

/**
 * ขั้นตอนหนึ่งในมาโคร
 * พิกัดเก็บเป็น**สัดส่วนของจอ** (0..1) ไม่ใช่พิกเซล — จะได้เล่นซ้ำบนเครื่องคนละความละเอียดได้
 * ค่าที่เป็นข้อความ (text/url/template/value) ใส่ {{ชื่อตัวแปร}} ได้ — แต่ละเครื่องแทนค่าต่างกันตามโปรไฟล์
 */
export type MacroStep =
  | { t: 'tap'; fx: number; fy: number; holdMs?: number }
  | { t: 'swipe'; fx1: number; fy1: number; fx2: number; fy2: number; durationMs: number }
  | { t: 'key'; keycode: number }
  | { t: 'text'; value: string }
  | { t: 'wait'; ms: number }
  | { t: 'find_tap'; selector: UiSelector; timeoutMs?: number }
  | { t: 'launch'; packageName: string }
  /** เปิดลิงก์ในเบราว์เซอร์ — เกมเบราว์เซอร์อย่าง g123 */
  | { t: 'open_url'; url: string }
  /** ตั้งตัวแปรระหว่างเล่น (ทับค่าจากโปรไฟล์ได้) */
  | { t: 'set_var'; name: string; value: string }
  /** หาภาพเทมเพลตบนจอแล้วแตะตรงกลาง (+offset เป็นสัดส่วนจอ) รอจนเจอหรือหมดเวลา */
  | { t: 'find_image_tap'; template: string; threshold?: number; timeoutMs?: number; offset?: { dx: number; dy: number } }
  /** รอจนภาพ "ปรากฏ" (appear=true) หรือ "หายไป" (appear=false) */
  | { t: 'wait_image'; template: string; appear: boolean; timeoutMs: number; threshold?: number }
  /** ถ้า (เจอภาพ == found) กระโดดไป label */
  | { t: 'if_image'; template: string; found: boolean; goto: string; threshold?: number }
  /** อ่านข้อความในกรอบด้วย OCR แล้วเทียบ (substring หรือ /regex/) ถ้า (ตรง == found) กระโดด */
  | { t: 'if_text'; rect: FracRect; match: string; found: boolean; goto: string; digits?: boolean }
  /** เทียบตัวแปรแล้วกระโดด */
  | { t: 'if_var'; name: string; op: 'eq' | 'ne' | 'lt' | 'gt' | 'empty' | 'notempty' | 'contains'; value?: string; goto: string }
  /** อ่านข้อความ/ตัวเลขในกรอบเก็บลงตัวแปร */
  | { t: 'ocr_var'; rect: FracRect; name: string; digits?: boolean }
  /** จุดหมายของการกระโดด */
  | { t: 'label'; name: string }
  /** กระโดดไป label — maxTimes กันวนไม่รู้จบ (ค่าเริ่มต้น 100) */
  | { t: 'goto'; label: string; maxTimes?: number }
  /** เรียกมาโครอื่นเป็นรูทีนย่อย (skill) ใช้ตัวแปรร่วมกัน */
  | { t: 'run_macro'; macroId: string }
  /** ตั้งเสียงของเครื่องนี้ */
  | { t: 'volume'; stream: VolumeStream; percent: number }
  /** จบมาโครของเครื่องนี้แบบสำเร็จ */
  | { t: 'stop'; message?: string }
  /** จบแบบล้มเหลว (ให้ผู้ใช้เห็นว่าผิดปกติ) */
  | { t: 'fail'; message?: string };

export type MacroStepType = MacroStep['t'];

export interface Macro {
  id: string;
  name: string;
  /** ขนาดจอตอนบันทึก — เผื่อโชว์ให้ผู้ใช้รู้ว่าบันทึกมาจากจอแบบไหน */
  recordedOn: { serial: string; width: number; height: number };
  steps: Array<MacroStep & { atMs: number }>;
  createdAt: number;
  updatedAt: number;
  /** ค่าเริ่มต้นของตัวแปร — โปรไฟล์เครื่องทับได้ */
  vars?: Record<string, string>;
  /** ชุดเทมเพลตภาพที่มาโครนี้ใช้ (ชื่อโฟลเดอร์ เช่น "dropkick") */
  templateSet?: string;
  /** สุ่มให้เหมือนคน: เขย่าตำแหน่งแตะ (สัดส่วนจอ) + หน่วงสุ่มระหว่างขั้น */
  humanize?: { jitter: number; delayMs: [number, number] };
  /** เมื่อขั้นตอนล้มเหลว: หยุดเครื่องนี้ | ข้ามขั้นนั้น | ลองใหม่ n ครั้งก่อนหยุด */
  onError?: { mode: 'stop' | 'skip' | 'retry'; retries?: number };
}

export type MacroView = Macro;

/** โปรไฟล์ต่อเครื่อง — สิ่งที่ทำให้ "แต่ละเครื่องทำต่างกัน" ด้วยมาโครเดียวกัน */
export interface DeviceProfile {
  serial: string;
  /** ชื่อเล่น เช่น "บัญชี A" */
  label?: string;
  /** ตัวแปรของเครื่องนี้ ทับค่าเริ่มต้นของมาโคร */
  vars: Record<string, string>;
  /** เสียง (%) ที่จะตั้งให้ก่อนเริ่มเล่นมาโครทุกครั้ง */
  volume?: Partial<Record<VolumeStream, number>>;
  /** false = ข้ามเครื่องนี้แม้ถูกเลือก */
  enabled?: boolean;
}

/** เทมเพลตภาพหนึ่งชิ้น — ตัดมาจากจอเครื่องอ้างอิง ระบบสเกลให้เองตอนหาบนเครื่องอื่น */
export interface TemplateInfo {
  set: string;
  name: string;
  /** ขนาดชิ้นภาพ (พิกเซลของเครื่องอ้างอิง) */
  width: number;
  height: number;
  /** ขนาดจอเครื่องอ้างอิงตอนตัด */
  refWidth: number;
  refHeight: number;
  /** ตำแหน่งที่ตัดมา (สัดส่วน) — ใช้เป็นพื้นที่ค้นหาโดยประมาณและพิกัดสำรอง */
  rect: FracRect;
  createdAt: number;
}

export interface MatchResult {
  name: string;
  /** 0..1 ยิ่งใกล้ 1 ยิ่งเหมือน */
  score: number;
  /** จุดกึ่งกลางที่เจอ (สัดส่วนจอ) */
  fx: number;
  fy: number;
  fw: number;
  fh: number;
}

export interface MacroRunLogEntry {
  serial: string;
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface MacroRunState {
  running: boolean;
  macroId?: string;
  macroName?: string;
  serials: string[];
  /** ขั้นที่กำลังทำต่อเครื่อง */
  progress: Record<string, { step: number; total: number; loop: number; error?: string; note?: string; vars?: Record<string, string> }>;
  loopsTotal: number;
  /** บันทึกแยกเครื่อง (ล่าสุดไม่เกิน 300 บรรทัด) */
  log: MacroRunLogEntry[];
}

export type ScheduleMode = 'once' | 'interval' | 'daily';

export interface ScheduleView {
  id: string;
  name: string;
  macroId: string;
  serials: string[];
  mode: ScheduleMode;
  /** once/daily: เวลาแบบ epoch ms (once) หรือ นาทีของวัน 0..1439 (daily) */
  at: number;
  /** interval: ทุกกี่มิลลิวินาที */
  everyMs?: number;
  loops: number;
  enabled: boolean;
  lastRunAt?: number;
  lastResult?: string;
}

/** ภาพหน้าจอย่อสำหรับให้ผู้ใช้ลากกรอบตัดเทมเพลต */
export interface ScreenshotPreview {
  serial: string;
  /** data URL (jpeg ย่อ) */
  dataUrl: string;
  /** ขนาดจอจริง */
  width: number;
  height: number;
  takenAt: number;
}
