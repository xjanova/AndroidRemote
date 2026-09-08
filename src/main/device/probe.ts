/**
 * ตรวจเครื่องหนึ่งเครื่อง: มันเป็นรุ่นอะไร ทำอะไรได้ และอะไรขวางอยู่
 *
 * หลักที่ยึด — **อย่าเดาแทนผู้ใช้** ถ้าตรวจไม่ได้แน่ชัด ให้บอกว่าไม่แน่ใจ
 * พร้อมวิธีตรวจเอง ดีกว่าขึ้นเขียวแล้วผู้ใช้ไปเจอว่ากดไม่ได้ทีหลัง
 */

import type { AdbClient } from '../adb/AdbClient';
import {
  CAPABILITIES,
  tierAtLeast,
  type Blocker,
  type CapabilityId,
  type DeviceInfo,
  type PrivilegeTier,
  type AdbState,
  type TransportKind,
} from '../../shared/types';

/** แยกผลของ `getprop` ทั้งก้อนเป็น map — รูปแบบหนึ่งบรรทัดคือ `[คีย์]: [ค่า]` */
export function parseGetprop(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /^\[([^\]]+)\]:\s*\[(.*)\]$/;
  for (const line of text.split('\n')) {
    const m = re.exec(line.trim());
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/** เดาช่องทางเชื่อมต่อจากหน้าตาของ serial */
export function transportOf(serial: string): TransportKind {
  if (serial.startsWith('emulator-')) return 'emulator';
  // ไร้สายคือ ip:port หรือ ชื่อโฮสต์:port (adb 11+ ใช้ชื่อ mdns ได้)
  if (/:\d+$/.test(serial)) return 'tcp';
  return 'usb';
}

/** ชื่อ ROM ที่ผู้ผลิตครอบมา — ดึงจาก prop ที่แต่ละเจ้าใช้ไม่เหมือนกัน */
export function detectRom(props: Map<string, string>): string | undefined {
  // HyperOS มาแทน MIUI ตั้งแต่ปี 2023 แต่ prop เก่ายังอยู่ ต้องเช็คตัวใหม่ก่อน
  const hyperOs = props.get('ro.mi.os.version.name');
  if (hyperOs) return `HyperOS ${hyperOs}`;
  const miui = props.get('ro.miui.ui.version.name');
  if (miui) return `MIUI ${miui.replace(/^V/, '')}`;

  const oneUi = props.get('ro.build.version.oneui');
  if (oneUi) {
    // One UI เก็บเป็นเลขล้วน เช่น 60101 = 6.1.1
    const n = parseInt(oneUi, 10);
    if (!Number.isNaN(n)) {
      const major = Math.floor(n / 10000);
      const minor = Math.floor((n % 10000) / 100);
      return `One UI ${major}.${minor}`;
    }
  }
  if (props.get('ro.build.version.emui')) return props.get('ro.build.version.emui');
  if (props.get('ro.build.version.opporom')) return `ColorOS ${props.get('ro.build.version.opporom')}`;
  if (props.get('ro.vivo.os.version')) return `Funtouch/OriginOS ${props.get('ro.vivo.os.version')}`;
  if (props.get('ro.lineage.version')) return `LineageOS ${props.get('ro.lineage.version')}`;
  return undefined;
}

/** true ถ้าเป็น ROM ตระกูล Xiaomi ที่มีสวิตช์ security settings แยกต่างหาก */
export function isXiaomiRom(props: Map<string, string>): boolean {
  return props.has('ro.miui.ui.version.name') || props.has('ro.mi.os.version.name');
}

export interface ProbeResult {
  tier: PrivilegeTier;
  rootAvailableButDenied: boolean;
}

/**
 * หาว่าเรายิงคำสั่งเข้าเครื่องได้ในระดับไหน
 *
 * ลำดับการตรวจสำคัญ: เช็ค uid ปัจจุบันก่อน เพราะถ้า `adb root` สำเร็จไปแล้ว
 * (ROM userdebug) เราเป็น root อยู่แล้วโดยไม่ต้องมี su เลย
 */
export async function probePrivilege(adb: AdbClient, serial: string): Promise<ProbeResult> {
  const uid = await adb.exec(serial, 'id -u');
  if (uid.stdout.trim() === '0') {
    return { tier: 'root', rootAvailableButDenied: false };
  }

  // มี su ไหม — `command -v` พกพาได้กว่า `which` บน toybox
  const hasSu = await adb.exec(serial, 'command -v su || ls /system/xbin/su /system/bin/su 2>/dev/null');
  if (hasSu.stdout.trim()) {
    // มีไฟล์ su ไม่ได้แปลว่าใช้ได้ — ต้องลองจริง เพราะ Magisk/KernelSU
    // จะเด้ง dialog ให้ผู้ใช้กดอนุญาต ถ้าไม่กดจะค้างแล้ว timeout
    const test = await withTimeout(
      adb.exec(serial, 'su -c id -u'),
      6000,
      { stdout: '', stderr: 'timeout', exitCode: -1 },
    );
    if (test.stdout.trim() === '0') {
      return { tier: 'root', rootAvailableButDenied: false };
    }
    // มี su แต่เรียกไม่ผ่าน = ผู้ใช้ยังไม่กดอนุญาต หรือกดปฏิเสธไปแล้ว
    return { tier: 'shell', rootAvailableButDenied: true };
  }

  // Shizuku ทำงานอยู่ไหม — มันรันเป็นโพรเซสด้วย uid 2000 ชื่อขึ้นต้นว่า shizuku
  const shizuku = await adb.exec(serial, 'ps -A -o NAME 2>/dev/null | grep -i shizuku');
  if (shizuku.stdout.trim()) {
    return { tier: 'shizuku', rootAvailableButDenied: false };
  }

  return { tier: 'shell', rootAvailableButDenied: false };
}

/** แปลงระดับสิทธิ์ + SDK เป็นรายการความสามารถที่ใช้ได้จริง */
export function capabilitiesFor(tier: PrivilegeTier, sdk: number | undefined): CapabilityId[] {
  return CAPABILITIES.filter((c) => {
    if (!tierAtLeast(tier, c.requires)) return false;
    if (c.minSdk !== undefined && (sdk === undefined || sdk < c.minSdk)) return false;
    return true;
  }).map((c) => c.id);
}

/** สร้างรายการสิ่งที่ขวางอยู่ พร้อมขั้นตอนแก้ที่ทำตามได้จริง */
export function blockersFor(args: {
  state: AdbState;
  tier: PrivilegeTier;
  rootAvailableButDenied: boolean;
  props: Map<string, string> | null;
}): Blocker[] {
  const list: Blocker[] = [];

  if (args.state === 'unauthorized') {
    list.push({
      id: 'unauthorized',
      severity: 'fatal',
      title: 'เครื่องยังไม่อนุญาตให้ PC เครื่องนี้',
      detail: 'มือถือเห็น PC แล้ว แต่ยังไม่ได้กดยืนยันลายนิ้วมือ RSA',
      steps: [
        'ปลดล็อกหน้าจอมือถือ',
        'มองหากล่อง "อนุญาตการแก้จุดบกพร่อง USB หรือไม่"',
        'ติ๊ก "อนุญาตเสมอจากคอมพิวเตอร์เครื่องนี้" แล้วกดอนุญาต',
        'ถ้ากล่องไม่ขึ้น ให้ถอดสายเสียบใหม่ หรือไปที่ ตัวเลือกสำหรับนักพัฒนา → เพิกถอนสิทธิ์การแก้จุดบกพร่อง USB แล้วเสียบใหม่',
      ],
    });
  }

  if (args.state === 'offline') {
    list.push({
      id: 'offline',
      severity: 'fatal',
      title: 'เครื่องอยู่ในสถานะออฟไลน์',
      detail: 'adb เห็นเครื่องแต่คุยด้วยไม่ได้ — มักเกิดหลังรีบูตหรือสายหลวม',
      steps: [
        'ถอดสายแล้วเสียบใหม่',
        'ถ้ายังไม่หาย กด "รีสตาร์ท adb" ในหน้าตั้งค่า',
        'ถ้าเป็นการต่อไร้สาย ให้ตัดแล้วต่อใหม่ — พอร์ตเปลี่ยนทุกครั้งที่รีบูตมือถือ',
      ],
    });
  }

  if (args.props && isXiaomiRom(args.props)) {
    list.push({
      id: 'miui-secure-settings',
      severity: 'limited',
      title: 'ตรวจพบ ROM ตระกูล Xiaomi',
      detail:
        'MIUI/HyperOS มีสวิตช์แยกอีกอันที่กั้นการจำลองสัมผัสไว้ ถ้ามิเรอร์ได้แต่กดสั่งงานไม่ได้ สาเหตุคือตัวนี้',
      steps: [
        'ลงชื่อเข้าใช้บัญชี Mi บนมือถือก่อน (สวิตช์นี้เปิดไม่ได้ถ้าไม่ล็อกอิน)',
        'ใส่ซิมในเครื่อง แล้วรอสักครู่',
        'ไปที่ ตั้งค่า → เพิ่มเติม → ตัวเลือกสำหรับนักพัฒนา',
        'เปิด "การแก้จุดบกพร่อง USB (การตั้งค่าความปลอดภัย)"',
        'กดยืนยันในกล่องที่เด้งขึ้นมา แล้วเสียบสายใหม่',
      ],
    });
  }

  if (args.tier === 'shell' && args.rootAvailableButDenied) {
    list.push({
      id: 'no-root',
      severity: 'limited',
      title: 'เครื่องมี root แต่ยังไม่ได้รับอนุญาต',
      detail: 'เจอไฟล์ su บนเครื่อง แต่เรียกใช้แล้วไม่ผ่าน — น่าจะยังไม่ได้กดอนุญาตในแอปจัดการ root',
      steps: [
        'เปิดแอป Magisk หรือ KernelSU บนมือถือ',
        'ไปที่หน้า Superuser',
        'หาแอป "shell" แล้วเปลี่ยนเป็นอนุญาต',
        'กลับมากดตรวจเครื่องใหม่ในแอปนี้',
      ],
    });
  }

  return list;
}

/**
 * ตรวจเครื่องเต็มรูปแบบ — เรียกเมื่อเครื่องเข้าสถานะ `device` เท่านั้น
 * ทุกคำสั่งห่อ try ไว้: เครื่องอาจถูกถอดกลางคัน ซึ่งไม่ใช่ข้อผิดพลาดของเรา
 */
export async function probeDevice(
  adb: AdbClient,
  serial: string,
  state: AdbState,
): Promise<DeviceInfo> {
  const base: DeviceInfo = {
    serial,
    state,
    transport: transportOf(serial),
    tier: 'none',
    capabilities: [],
    blockers: [],
  };

  if (state !== 'device') {
    base.blockers = blockersFor({ state, tier: 'none', rootAvailableButDenied: false, props: null });
    return base;
  }

  try {
    // getprop ทั้งก้อนในรอบเดียว — ~50 KB แต่แลกกับการไม่ต้องยิงหลายรอบ
    const propsText = await adb.exec(serial, 'getprop');
    const props = parseGetprop(propsText.stdout);

    const sdkRaw = props.get('ro.build.version.sdk');
    const sdk = sdkRaw ? parseInt(sdkRaw, 10) : undefined;

    const priv = await probePrivilege(adb, serial);
    const screen = await probeScreen(adb, serial);
    const battery = await probeBattery(adb, serial);

    return {
      ...base,
      // ro.serialno อ่านได้ด้วยสิทธิ์ shell — ค่านี้คือกุญแจจำเครื่องข้ามการต่อ USB/ไร้สาย
      hwSerial: cleanSerial(props.get('ro.serialno')) ?? cleanSerial(props.get('ro.boot.serialno')),
      model: props.get('ro.product.model'),
      brand: props.get('ro.product.brand'),
      manufacturer: props.get('ro.product.manufacturer'),
      androidRelease: props.get('ro.build.version.release'),
      sdk: Number.isNaN(sdk) ? undefined : sdk,
      romName: detectRom(props),
      abi: props.get('ro.product.cpu.abi'),
      screenWidth: screen?.width,
      screenHeight: screen?.height,
      screenDensity: screen?.density,
      batteryLevel: battery?.level,
      batteryCharging: battery?.charging,
      tier: priv.tier,
      rootAvailableButDenied: priv.rootAvailableButDenied,
      capabilities: capabilitiesFor(priv.tier, sdk),
      blockers: blockersFor({
        state,
        tier: priv.tier,
        rootAvailableButDenied: priv.rootAvailableButDenied,
        props,
      }),
      probedAt: Date.now(),
    };
  } catch (err) {
    return {
      ...base,
      probeError: err instanceof Error ? err.message : String(err),
      blockers: blockersFor({ state, tier: 'none', rootAvailableButDenied: false, props: null }),
    };
  }
}

/**
 * ขนาดจอจริง
 * `wm size` อาจตอบสองบรรทัด: Physical size แล้วตามด้วย Override size
 * ถ้ามี override ต้องใช้ตัว override เพราะนั่นคือสิ่งที่เราจะจับภาพได้จริง
 */
async function probeScreen(
  adb: AdbClient,
  serial: string,
): Promise<{ width: number; height: number; density?: number } | null> {
  try {
    const size = await adb.exec(serial, 'wm size');
    const all = [...size.stdout.matchAll(/(\d+)x(\d+)/g)];
    if (all.length === 0) return null;
    const last = all[all.length - 1];

    let density: number | undefined;
    const dens = await adb.exec(serial, 'wm density');
    const dAll = [...dens.stdout.matchAll(/(\d+)/g)];
    if (dAll.length) density = parseInt(dAll[dAll.length - 1][1], 10);

    return { width: parseInt(last[1], 10), height: parseInt(last[2], 10), density };
  } catch {
    return null;
  }
}

async function probeBattery(
  adb: AdbClient,
  serial: string,
): Promise<{ level?: number; charging?: boolean } | null> {
  try {
    const out = await adb.exec(serial, 'dumpsys battery');
    const level = /level:\s*(\d+)/.exec(out.stdout);
    const status = /status:\s*(\d+)/.exec(out.stdout);
    // BatteryManager: 2 = กำลังชาร์จ, 5 = เต็ม
    const charging = status ? ['2', '5'].includes(status[1]) : undefined;
    return { level: level ? parseInt(level[1], 10) : undefined, charging };
  } catch {
    return null;
  }
}

/**
 * แอนดรอยด์ 10+ คืน "unknown" ให้แอปที่ไม่มีสิทธิ์ — ค่านั้นใช้เป็นกุญแจไม่ได้
 * ต้องกรองทิ้ง ไม่งั้นทุกเครื่องจะกลายเป็นเครื่องเดียวกันหมด
 */
function cleanSerial(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v || v.toLowerCase() === 'unknown') return undefined;
  return v;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}
