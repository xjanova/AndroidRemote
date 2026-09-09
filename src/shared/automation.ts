/**
 * ชนิดข้อมูลของมาโครและการตั้งเวลา — ใช้ร่วมกันทั้ง main และ renderer
 * ห้าม import จาก node/electron ในไฟล์นี้
 *
 * แนวคิดเดียวกับ tping: บันทึกขั้นตอน → เล่นซ้ำ → วนได้ → หา element แทนพิกัดดิบ
 * ต่างตรงที่ทำจาก PC ผ่านช่องควบคุมของแต่ละเครื่อง จึงยิงไปหลายเครื่องพร้อมกันได้
 * และไม่ต้องลงแอปหรือเปิด Accessibility บนมือถือ
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

/**
 * ขั้นตอนหนึ่งในมาโคร
 * พิกัดเก็บเป็น**สัดส่วนของจอ** (0..1) ไม่ใช่พิกเซล — จะได้เล่นซ้ำบนเครื่องคนละความละเอียดได้
 */
export type MacroStep =
  | { t: 'tap'; fx: number; fy: number; holdMs?: number }
  | { t: 'swipe'; fx1: number; fy1: number; fx2: number; fy2: number; durationMs: number }
  | { t: 'key'; keycode: number }
  | { t: 'text'; value: string }
  | { t: 'wait'; ms: number }
  | { t: 'find_tap'; selector: UiSelector; timeoutMs?: number }
  | { t: 'launch'; packageName: string };

export interface Macro {
  id: string;
  name: string;
  /** ขนาดจอตอนบันทึก — เผื่อโชว์ให้ผู้ใช้รู้ว่าบันทึกมาจากจอแบบไหน */
  recordedOn: { serial: string; width: number; height: number };
  steps: Array<MacroStep & { atMs: number }>;
  createdAt: number;
  updatedAt: number;
}

export type MacroView = Macro;

export interface MacroRunState {
  running: boolean;
  macroId?: string;
  macroName?: string;
  serials: string[];
  /** ขั้นที่กำลังทำต่อเครื่อง */
  progress: Record<string, { step: number; total: number; loop: number; error?: string }>;
  loopsTotal: number;
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
