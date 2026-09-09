/**
 * ชนิดข้อมูลสำหรับ "สั่งจัดการอีมูเลเตอร์" — สร้าง/เปิด/ปิด/ลบเครื่องจากในแอป
 * ต่างจาก discovery (ที่แค่ "หา" เครื่องที่รันอยู่) — อันนี้คือ "สั่งการ" ตัวโปรแกรมอีมูเลเตอร์
 *
 * ห้าม import node/electron ในไฟล์นี้
 */

export type EmulatorBrandId = 'nox' | 'ldplayer' | 'memu';

/** Android รุ่นที่ให้เลือกตอนสร้าง — แต่ละยี่ห้อรองรับไม่เท่ากัน provider เป็นคนกรอง */
export type AndroidVersionChoice = '4' | '5' | '7' | '9' | '12';

export interface EmulatorInstanceView {
  brand: EmulatorBrandId;
  /** ชื่อภายในที่ CLI ใช้อ้างอิง (เช่น Nox_1) — คีย์หลักของทุกคำสั่ง */
  id: string;
  /** ชื่อที่ผู้ใช้ตั้ง/เห็น (title) */
  name: string;
  running: boolean;
}

export interface CreateEmulatorSpec {
  name: string;
  androidVersion: AndroidVersionChoice;
  /** สเปกเครื่อง — ไม่ใส่ = ใช้ค่าเริ่มต้นของยี่ห้อ */
  width?: number;
  height?: number;
  dpi?: number;
  cpu?: number;
  memoryMb?: number;
  /** ปลอมตัวตนเครื่อง — สำหรับทดสอบหลายบัญชี */
  manufacturer?: string;
  model?: string;
  brand?: string;
  /** สุ่ม IMEI/androidId/mac ใหม่ (แต่ละเครื่องต่างกัน) */
  randomizeIdentity?: boolean;
  /** จำนวนเครื่องที่จะสร้างรวด — ตั้งชื่อต่อท้าย -1, -2, … */
  count?: number;
  /** โคลนจากเครื่องที่มีอยู่ (id) แทนสร้างใหม่ — ใช้อิมเมจเดิม ไม่ต้องเลือก Android version */
  cloneFromId?: string;
}

export interface EmulatorProviderView {
  brand: EmulatorBrandId;
  label: string;
  /** ติดตั้งในเครื่องนี้ไหม — ถ้าไม่ ให้ปุ่มเทา */
  available: boolean;
  /** พาธ CLI ที่เจอ (ไว้โชว์ว่าเจอตรงไหน) */
  cliPath?: string;
  /** เวอร์ชัน adb ที่ยี่ห้อนี้แถมมา ไม่ตรงกับของเรา = ต้นเหตุ "ต่อแล้วหลุด" */
  bundledAdbVersion?: string;
  adbVersionMatches?: boolean;
  /** รุ่น Android ที่สร้างได้ */
  androidVersions: AndroidVersionChoice[];
}

export interface EmulatorManagerState {
  providers: EmulatorProviderView[];
  instances: EmulatorInstanceView[];
  /** งานที่กำลังทำ (สร้าง/ลบใช้เวลานาน) — โชว์สถานะให้ผู้ใช้ */
  busy: string | null;
}

export interface EmulatorOpResult {
  ok: boolean;
  message: string;
}
