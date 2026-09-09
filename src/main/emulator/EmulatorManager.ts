/**
 * รวมทุก provider ไว้ที่เดียว — UI คุยกับตัวนี้ตัวเดียว ไม่ต้องรู้ว่ายี่ห้อไหน
 *
 * งานพิเศษที่ manager ทำนอกเหนือจากส่งต่อคำสั่ง:
 *   1. ตรวจเวอร์ชัน adb ที่แต่ละยี่ห้อแถมมา แล้วเตือนถ้าไม่ตรง (ต้นเหตุ "ต่อแล้วหลุด")
 *   2. หลัง launch เครื่อง คอย poll ให้ discovery จับแล้ว connect (discovery ทำเอง)
 */

import path from 'node:path';
import { EventEmitter } from 'node:events';
import { adbVersionOf, type EmulatorProvider } from './provider';
import { NoxProvider } from './NoxProvider';
import type {
  CreateEmulatorSpec,
  EmulatorBrandId,
  EmulatorManagerState,
  EmulatorOpResult,
  EmulatorProviderView,
} from '../../shared/emulator';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

export class EmulatorManager extends EventEmitter {
  private providers: EmulatorProvider[];
  private busy: string | null = null;

  constructor(
    private ourAdbPath: string | null,
    private log: Log,
  ) {
    super();
    // เพิ่มยี่ห้อใหม่ตรงนี้ที่เดียว — UI ไม่ต้องแก้
    this.providers = [new NoxProvider(log)];
  }

  private ourAdbVersion(): string | null {
    return this.ourAdbPath ? adbVersionOf(this.ourAdbPath) : null;
  }

  private providerViews(): EmulatorProviderView[] {
    const ourVer = this.ourAdbVersion();
    return this.providers.map((p) => {
      const bundled = p.available() ? p.bundledAdbVersion() : null;
      return {
        brand: p.brand,
        label: p.label,
        available: p.available(),
        cliPath: p.cliPath() ?? undefined,
        bundledAdbVersion: bundled ?? undefined,
        adbVersionMatches: bundled === null ? undefined : bundled === ourVer,
        androidVersions: p.androidVersions,
      };
    });
  }

  async state(): Promise<EmulatorManagerState> {
    const instances = [];
    for (const p of this.providers) {
      if (!p.available()) continue;
      try {
        instances.push(...(await p.list()));
      } catch (err) {
        this.log('warn', `อ่านรายการเครื่องของ ${p.label} ไม่ได้: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { providers: this.providerViews(), instances, busy: this.busy };
  }

  private find(brand: EmulatorBrandId): EmulatorProvider | undefined {
    return this.providers.find((p) => p.brand === brand);
  }

  /** เตือนเรื่อง adb เวอร์ชันชนก่อนทำอะไร — ครั้งเดียวพอต่อยี่ห้อ */
  private warnedAdb = new Set<string>();
  private checkAdb(p: EmulatorProvider): void {
    if (this.warnedAdb.has(p.brand)) return;
    const bundled = p.bundledAdbVersion();
    const ours = this.ourAdbVersion();
    if (bundled && ours && bundled !== ours) {
      this.warnedAdb.add(p.brand);
      this.log(
        'warn',
        `${p.label} แถม adb ${bundled} แต่เราใช้ ${ours} — เวอร์ชันไม่ตรงจะสลับกันฆ่า adb server ` +
          'ทำให้เครื่องหลุดเป็นระยะ ถ้าต่อแล้วหลุดบ่อยให้ก็อป platform-tools\\adb.exe ไปทับตัวที่ ' +
          (p.cliPath() ? path.dirname(p.cliPath()!) : 'โฟลเดอร์ของอีมูเลเตอร์'),
      );
    }
  }

  private async withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.busy = label;
    this.emit('changed');
    try {
      return await fn();
    } finally {
      this.busy = null;
      this.emit('changed');
    }
  }

  async create(brand: EmulatorBrandId, spec: CreateEmulatorSpec): Promise<EmulatorOpResult> {
    const p = this.find(brand);
    if (!p?.available()) return { ok: false, message: 'ไม่พบโปรแกรมอีมูเลเตอร์นี้' };
    this.checkAdb(p);
    const r = await this.withBusy(`กำลังสร้างเครื่อง ${p.label}…`, () => p.create(spec));
    this.emit('changed');
    return r;
  }

  async launch(brand: EmulatorBrandId, id: string): Promise<EmulatorOpResult> {
    const p = this.find(brand);
    if (!p?.available()) return { ok: false, message: 'ไม่พบโปรแกรมอีมูเลเตอร์นี้' };
    this.checkAdb(p);
    const r = await p.launch(id);
    // ไม่ต้อง connect เอง — discovery สแกน loopback เจอแล้ว connect ให้ภายในไม่กี่วินาที
    setTimeout(() => this.emit('changed'), 3000);
    return r;
  }

  async quit(brand: EmulatorBrandId, id: string): Promise<EmulatorOpResult> {
    const p = this.find(brand);
    if (!p?.available()) return { ok: false, message: 'ไม่พบ' };
    const r = await p.quit(id);
    this.emit('changed');
    return r;
  }

  async reboot(brand: EmulatorBrandId, id: string): Promise<EmulatorOpResult> {
    const p = this.find(brand);
    if (!p?.available()) return { ok: false, message: 'ไม่พบ' };
    return p.reboot(id);
  }

  async remove(brand: EmulatorBrandId, id: string): Promise<EmulatorOpResult> {
    const p = this.find(brand);
    if (!p?.available()) return { ok: false, message: 'ไม่พบ' };
    const r = await this.withBusy(`กำลังลบเครื่อง…`, () => p.remove(id));
    this.emit('changed');
    return r;
  }
}
