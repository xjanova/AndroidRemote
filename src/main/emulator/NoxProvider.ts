/**
 * สั่งจัดการ Nox ผ่าน NoxConsole.exe
 *
 * syntax ทดสอบกับ Nox จริงบนเครื่องนี้แล้ว (ไม่เดา):
 *   add -name:X -systemtype:<4|5|7>          → "add emulator successful:<internalName>"
 *   list                                      → index,internalName,title,topH,bindH,status,pid,vmpid
 *   modify -name:X -resolution:w,h,dpi -cpu:n -memory:mb -manufacturer:.. -model:.. -imei:auto
 *   launch|quit|reboot|remove -name:X
 *
 * 🔑 syntax เป็น `-key:value` (colon) ไม่ใช่เว้นวรรค — `add -name X` = error
 * 🔑 add ต้องมี -systemtype เสมอ ไม่งั้น "system type err!"
 * pid/vmpid = -1,-1 แปลว่าเครื่องไม่ได้รันอยู่
 */

import path from 'node:path';
import type {
  AndroidVersionChoice,
  CreateEmulatorSpec,
  EmulatorInstanceView,
  EmulatorOpResult,
} from '../../shared/emulator';
import {
  adbVersionOf,
  firstExisting,
  programDirs,
  runCli,
  type EmulatorProvider,
} from './provider';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

/** Nox engine นี้รองรับ 4/5/7 (ตาม help) — 9/12 มีเฉพาะบาง engine ลองได้แต่ไม่การันตี */
const NOX_VERSIONS: AndroidVersionChoice[] = ['5', '7', '9', '12'];

export class NoxProvider implements EmulatorProvider {
  readonly brand = 'nox' as const;
  readonly label = 'Nox';
  readonly androidVersions = NOX_VERSIONS;

  private consolePath: string | null;

  constructor(private log: Log) {
    this.consolePath = firstExisting(programDirs(path.join('Nox', 'bin', 'NoxConsole.exe')));
  }

  available(): boolean {
    return this.consolePath !== null;
  }
  cliPath(): string | null {
    return this.consolePath;
  }

  bundledAdbVersion(): string | null {
    if (!this.consolePath) return null;
    const dir = path.dirname(this.consolePath);
    // Nox แถมทั้ง nox_adb.exe และ adb.exe — เอาตัวที่มันใช้จริง (nox_adb) ก่อน
    return (
      adbVersionOf(path.join(dir, 'nox_adb.exe')) ?? adbVersionOf(path.join(dir, 'adb.exe'))
    );
  }

  private run(args: string[], timeoutMs?: number): EmulatorOpResult & { raw: string } {
    if (!this.consolePath) return { ok: false, message: 'ไม่พบ NoxConsole', raw: '' };
    const res = runCli(this.consolePath, args, timeoutMs);
    const raw = res.combined;
    // NoxConsole ไม่ค่อยใช้ exit code — ต้องดูข้อความ
    const failed = /err!|not exist|fail|error/i.test(raw);
    return { ok: !failed, message: raw || 'สำเร็จ', raw };
  }

  /** map Android version ที่ผู้ใช้เลือกเป็น systemtype ของ Nox */
  private systemType(v: AndroidVersionChoice): string {
    // Nox: 4=KitKat 5=Lollipop 7=Nougat 9=Pie 12=Android12
    return v;
  }

  async list(): Promise<EmulatorInstanceView[]> {
    const res = this.run(['list'], 15_000);
    const out: EmulatorInstanceView[] = [];
    for (const line of res.raw.split('\n')) {
      const parts = line.trim().split(',');
      // index,internalName,title,topHandle,bindHandle,status,pid,vmpid
      if (parts.length < 8) continue;
      const [, internalName, title, , , , pid, vmpid] = parts;
      if (!internalName) continue;
      // 🔑 id = title ไม่ใช่ internalName เพราะ NoxConsole รับ title กับทุกคำสั่ง
      //    (remove/launch/quit/modify/copy -from ล้วนต้องการ title — ทดสอบแล้ว
      //     internal name ใช้ได้บางคำสั่งไม่ได้บางคำสั่ง เอาให้ปลอดภัยไว้)
      const label = title || internalName;
      out.push({
        brand: 'nox',
        id: label,
        name: label,
        running: pid !== '-1' || vmpid !== '-1',
      });
    }
    return out;
  }

  async create(spec: CreateEmulatorSpec): Promise<EmulatorOpResult> {
    const count = Math.max(1, Math.min(spec.count ?? 1, 20));
    const created: string[] = [];

    // ถ้าเลือก "โคลนจากเครื่องเดิม" ใช้ image ที่มีอยู่แน่นอน ไม่ต้องเสี่ยง systemtype
    // 🔑 copy -from ต้องใช้ **title** (ชื่อที่ผู้ใช้เห็น) ไม่ใช่ internal id หรือ index
    //    (ทดสอบแล้ว: -from:NoxPlayer ผ่าน, -from:nox / -from:0 ไม่ผ่าน)
    let cloneFrom = spec.cloneFromId;
    if (cloneFrom) {
      const src = (await this.list()).find((i) => i.id === cloneFrom || i.name === cloneFrom);
      if (!src) return { ok: false, message: `ไม่พบเครื่องต้นทาง "${cloneFrom}" ที่จะโคลน` };
      cloneFrom = src.name;
    }

    for (let i = 0; i < count; i++) {
      const name = count > 1 ? `${spec.name}-${i + 1}` : spec.name;

      let add;
      if (cloneFrom) {
        this.log('info', `โคลนเครื่อง Nox "${name}" จาก "${cloneFrom}"`);
        add = this.run(['copy', `-name:${name}`, `-from:${cloneFrom}`], 300_000);
      } else {
        this.log('info', `สร้างเครื่อง Nox "${name}" (Android ${spec.androidVersion})`);
        // ⚠ add ช้า (copy system image ~1-2GB) — timeout ยาว
        add = this.run(['add', `-name:${name}`, `-systemtype:${this.systemType(spec.androidVersion)}`], 300_000);
      }

      if (!add.ok) {
        // "system not exist" = ยังไม่ได้ดาวน์โหลด image รุ่นนี้ — บอกทางแก้ที่ทำได้จริง
        if (/system\s*not\s*exist/i.test(add.raw)) {
          return {
            ok: false,
            message:
              `Nox ยังไม่มีอิมเมจ Android ${spec.androidVersion} ในเครื่อง — ` +
              'เปิด Nox MultiPlayer แล้วดาวน์โหลดรุ่นนั้นก่อน หรือเลือก "โคลนจากเครื่องที่มีอยู่" แทน',
          };
        }
        return { ok: false, message: `สร้าง "${name}" ไม่สำเร็จ: ${add.raw}` };
      }
      created.push(name);

      // modify ใช้ title (name ที่เพิ่งตั้ง) — NoxConsole รับ title
      const modifyArgs = this.buildModify(name, spec, i);
      if (modifyArgs.length > 0) {
        const mod = this.run(['modify', `-name:${name}`, ...modifyArgs], 30_000);
        if (!mod.ok) this.log('warn', `ปรับสเปก "${name}" ไม่สำเร็จ: ${mod.raw}`);
      }
    }

    return {
      ok: true,
      message: count > 1 ? `สร้าง ${created.length} เครื่องแล้ว` : `สร้าง "${created[0]}" แล้ว`,
    };
  }

  private buildModify(internal: string, spec: CreateEmulatorSpec, index: number): string[] {
    void internal;
    const args: string[] = [];
    if (spec.width && spec.height) {
      args.push(`-resolution:${spec.width},${spec.height},${spec.dpi ?? 320}`);
    }
    if (spec.cpu) args.push(`-cpu:${spec.cpu}`);
    if (spec.memoryMb) args.push(`-memory:${spec.memoryMb}`);
    if (spec.manufacturer) args.push(`-manufacturer:${spec.manufacturer}`);
    if (spec.model) args.push(`-model:${spec.model}`);
    if (spec.brand) args.push(`-brand:${spec.brand}`);
    if (spec.randomizeIdentity) {
      // auto = Nox สุ่มให้ใหม่ทุกค่า แต่ละเครื่องจะไม่ซ้ำกัน เหมาะกับทดสอบหลายบัญชี
      args.push('-imei:auto', '-imsi:auto', '-androidid:auto', '-mac:auto', '-simserial:auto');
    }
    void index;
    return args;
  }

  async launch(id: string): Promise<EmulatorOpResult> {
    this.log('info', `เปิดเครื่อง Nox "${id}"`);
    return this.run(['launch', `-name:${id}`], 60_000);
  }
  async quit(id: string): Promise<EmulatorOpResult> {
    return this.run(['quit', `-name:${id}`], 30_000);
  }
  async reboot(id: string): Promise<EmulatorOpResult> {
    return this.run(['reboot', `-name:${id}`], 30_000);
  }
  async remove(id: string): Promise<EmulatorOpResult> {
    this.log('info', `ลบเครื่อง Nox "${id}"`);
    return this.run(['remove', `-name:${id}`], 60_000);
  }
}
