/**
 * หาอีมูเลเตอร์ที่รันอยู่บนเครื่องเดียวกัน
 *
 * อีมูเลเตอร์ **ไม่ได้อยู่บนวงแลน** — มันเปิด adb ไว้ที่ 127.0.0.1 บนพอร์ตประจำของแต่ละยี่ห้อ
 * mDNS ไม่เห็น การกวาดวง LAN ก็ข้าม loopback จึงต้องมีตัวสแกนนี้แยกต่างหาก
 *
 * แต่ละยี่ห้อมีสูตรพอร์ตของตัวเอง (ศึกษาจากเอกสารและพฤติกรรมจริงของแต่ละตัว):
 *
 * | ยี่ห้อ            | อินสแตนซ์ที่ 1 | ตัวถัดไป          | หมายเหตุ |
 * |------------------|--------------|-------------------|---------|
 * | Android Studio    | 5555         | +2 (5557, 5559…)  | adb เห็นเองเป็น emulator-5554 ไม่ต้อง connect |
 * | BlueStacks 5      | 5555         | +10 (5565, 5575…) | ต้องเปิด ADB ใน Settings → Advanced ก่อน |
 * | LDPlayer          | 5555         | +2 (5557, 5559…)  | ชนช่วงกับ AVD/BlueStacks — แยกด้วยโพรเซส |
 * | Nox               | 62001        | 62025, 62026…     | มี nox_adb.exe ของตัวเอง |
 * | MEmu              | 21503        | +10 (21513…)      | |
 * | MuMu 12           | 16384        | +32 (16416…)      | MuMu รุ่นเก่าใช้ 7555 |
 * | WSA               | 58526        | —                 | Microsoft เลิกพัฒนาแล้วแต่ยังมีคนใช้ |
 * | Genymotion        | 5555 บน IP ของ VM (192.168.56.x) | | มาทางการกวาด LAN เพราะ VirtualBox host-only adapter อยู่ในรายการอินเทอร์เฟซอยู่แล้ว |
 *
 * 🔴 กับดักใหญ่: LDPlayer/Nox/MEmu **แถม adb.exe คนละเวอร์ชันมาด้วย** พอมันเปิด server ที่ 5037
 *    ก่อนเรา client ของเราจะบอกว่า "version doesn't match; killing" แล้วรีสตาร์ต server —
 *    อีมูเลเตอร์ก็หลุด สลับกันฆ่าไปมา ทางแก้ที่ได้ผลจริงคือก็อป platform-tools/adb.exe
 *    ไปทับตัวที่อีมูเลเตอร์แถมมา ให้เป็นตัวเดียวกัน
 */

import net from 'node:net';
import { spawnSync } from 'node:child_process';

export type EmulatorBrand = 'avd' | 'bluestacks' | 'ldplayer' | 'nox' | 'memu' | 'mumu' | 'wsa' | 'genymotion';

export interface EmulatorSpec {
  brand: EmulatorBrand;
  label: string;
  /** ชื่อโพรเซสที่บ่งบอกว่ายี่ห้อนี้กำลังรัน (ตัวพิมพ์เล็ก ไม่มี .exe) */
  processes: string[];
  /** พอร์ต adb ที่ควรลอง เรียงจากอินสแตนซ์แรก */
  ports: number[];
  /** ข้อความช่วยเหลือเมื่อเห็นโพรเซสรันอยู่แต่ต่อพอร์ตไม่ติด */
  hint?: string;
  /** ชื่อไฟล์ adb ที่แถมมา — มีไว้เตือนเรื่องเวอร์ชันชน */
  bundledAdb?: string;
}

function series(start: number, step: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i * step);
}

export const EMULATORS: EmulatorSpec[] = [
  {
    brand: 'avd',
    label: 'Android Studio Emulator',
    processes: ['qemu-system-x86_64', 'qemu-system-aarch64', 'emulator'],
    ports: series(5555, 2, 8),
  },
  {
    brand: 'bluestacks',
    label: 'BlueStacks',
    processes: ['hd-player', 'bluestacks'],
    ports: series(5555, 10, 6),
    hint: 'เปิด BlueStacks → Settings → Advanced → เปิด "Android Debug Bridge" แล้วดูพอร์ตที่มันบอก',
  },
  {
    brand: 'ldplayer',
    label: 'LDPlayer',
    processes: ['dnplayer', 'ldvboxheadless', 'dnmultiplayer'],
    ports: series(5555, 2, 8),
    bundledAdb: 'adb.exe ในโฟลเดอร์ LDPlayer',
  },
  {
    brand: 'nox',
    label: 'Nox',
    processes: ['nox', 'noxvmhandle', 'multiplayermanager'],
    ports: [62001, ...series(62025, 1, 8)],
    bundledAdb: 'nox_adb.exe',
  },
  {
    brand: 'memu',
    label: 'MEmu',
    processes: ['memu', 'memuheadless', 'memuconsole'],
    ports: series(21503, 10, 6),
    bundledAdb: 'adb.exe ในโฟลเดอร์ MEmu',
  },
  {
    brand: 'mumu',
    label: 'MuMu',
    processes: ['mumuplayer', 'mumuvmmheadless', 'nemuplayer', 'nemuheadless'],
    ports: [7555, ...series(16384, 32, 6)],
  },
  {
    brand: 'wsa',
    label: 'Windows Subsystem for Android',
    processes: ['wsaclient', 'wsaservice'],
    ports: [58526],
    hint: 'เปิด Windows Subsystem for Android Settings → Developer → เปิด Developer mode',
  },
  {
    brand: 'genymotion',
    label: 'Genymotion',
    processes: ['player', 'vboxheadless'],
    ports: [], // มาทางการกวาด LAN บน host-only adapter
  },
];

/** พอร์ตทั้งหมดที่ควรลองบน loopback ไม่ซ้ำ และไม่มี 5037 (adb server) เด็ดขาด */
export function allEmulatorPorts(): number[] {
  const set = new Set<number>();
  for (const e of EMULATORS) for (const p of e.ports) if (p !== 5037) set.add(p);
  return [...set].sort((a, b) => a - b);
}

export interface RunningEmulator {
  brand: EmulatorBrand;
  label: string;
  processes: string[];
}

/** ยี่ห้อไหนกำลังรันอยู่ ดูจากโพรเซส — ใช้ tasklist เพราะไม่ต้องพึ่ง PowerShell ที่ช้ากว่ามาก */
export function runningEmulators(): RunningEmulator[] {
  if (process.platform !== 'win32') return [];
  const res = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0 || !res.stdout) return [];

  const names = new Set<string>();
  for (const line of res.stdout.split('\n')) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.add(m[1].toLowerCase().replace(/\.exe$/, ''));
  }

  const out: RunningEmulator[] = [];
  for (const e of EMULATORS) {
    const hit = e.processes.filter((p) => names.has(p));
    if (hit.length) out.push({ brand: e.brand, label: e.label, processes: hit });
  }
  return out;
}

export interface OpenEmulatorPort {
  port: number;
  /** ยี่ห้อที่น่าจะเป็น — เดาจากพอร์ต + โพรเซสที่รันอยู่ ช่วงพอร์ตซ้ำกันได้ (5555) */
  brand: EmulatorBrand;
  label: string;
}

/** ลองต่อ TCP ทุกพอร์ตที่รู้จักบน 127.0.0.1 — เร็ว เพราะ loopback ตอบทันทีว่าเปิดหรือปิด */
export async function scanEmulatorPorts(timeoutMs = 300): Promise<OpenEmulatorPort[]> {
  const running = runningEmulators();
  const ports = allEmulatorPorts();

  const results = await Promise.all(
    ports.map(
      (port) =>
        new Promise<number | null>((resolve) => {
          const s = new net.Socket();
          let done = false;
          const finish = (ok: boolean): void => {
            if (done) return;
            done = true;
            s.destroy();
            resolve(ok ? port : null);
          };
          s.setTimeout(timeoutMs);
          s.once('connect', () => finish(true));
          s.once('timeout', () => finish(false));
          s.once('error', () => finish(false));
          s.connect(port, '127.0.0.1');
        }),
    ),
  );

  const open = results.filter((p): p is number => p !== null);
  return open.map((port) => ({ port, ...guessBrand(port, running) }));
}

/**
 * ระบุยี่ห้อจากพอร์ต — ถ้าช่วงชนกัน (5555 เป็นได้ทั้ง AVD/BlueStacks/LDPlayer)
 * ให้เชื่อโพรเซสที่กำลังรันอยู่ ถ้าไม่มีอะไรรันเลยก็ตอบตามที่พบก่อน
 */
function guessBrand(port: number, running: RunningEmulator[]): { brand: EmulatorBrand; label: string } {
  const candidates = EMULATORS.filter((e) => e.ports.includes(port));
  const active = candidates.find((e) => running.some((r) => r.brand === e.brand));
  const pick = active ?? candidates[0];
  return pick ? { brand: pick.brand, label: pick.label } : { brand: 'avd', label: 'อีมูเลเตอร์' };
}

/**
 * AVD ของ Google ประกาศตัวกับ adb เองเป็น emulator-<consolePort> ซึ่ง = adbPort - 1
 * ถ้าเราไป adb connect 127.0.0.1:5555 ซ้ำ จะได้เครื่องเดียวกันโผล่สองรายการ
 */
export function isAlreadyNativeAvd(port: number, knownSerials: Iterable<string>): boolean {
  const consoleSerial = `emulator-${port - 1}`;
  for (const s of knownSerials) if (s === consoleSerial) return true;
  return false;
}

export function specFor(brand: EmulatorBrand): EmulatorSpec | undefined {
  return EMULATORS.find((e) => e.brand === brand);
}
