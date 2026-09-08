/**
 * อัปเดตอัตโนมัติผ่าน GitHub Releases + ซ่อมไอคอนเดสก์ท็อป
 *
 * สองเรื่องนี้อยู่ไฟล์เดียวกันเพราะผูกกัน: ทางที่ไอคอนหายคือ "สายอัปเดตอัตโนมัติ"
 * โดยเฉพาะ ต้องซ่อมตรงนี้เท่านั้น ตั้งค่าใน electron-builder อย่างเดียวแก้ไม่ได้
 */

import { app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { autoUpdater } from 'electron-updater';

export type UpdateStage =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'none'
  | 'error';

export interface UpdateState {
  stage: UpdateStage;
  currentVersion: string;
  newVersion?: string;
  percent?: number;
  message?: string;
  /** ระหว่างพัฒนาไม่มีตัวติดตั้ง จึงเช็คอัปเดตไม่ได้ */
  supported: boolean;
}

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

export class AutoUpdate {
  private state: UpdateState;

  constructor(
    private log: Log,
    private onChange: (state: UpdateState) => void,
  ) {
    this.state = {
      stage: 'idle',
      currentVersion: app.getVersion(),
      supported: app.isPackaged,
    };

    // ให้ผู้ใช้เลือกเองว่าจะติดตั้งเมื่อไหร่ — อย่ารีสตาร์ทกลางที่ผู้ใช้กำลังคุมมือถืออยู่
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => this.set({ stage: 'checking' }));
    autoUpdater.on('update-available', (info) => {
      this.set({ stage: 'available', newVersion: info.version });
      this.log('info', `มีเวอร์ชันใหม่ ${info.version}`);
    });
    autoUpdater.on('update-not-available', () => this.set({ stage: 'none' }));
    autoUpdater.on('download-progress', (p) => {
      this.set({ stage: 'downloading', percent: Math.round(p.percent) });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.set({ stage: 'ready', newVersion: info.version, percent: 100 });
      this.log('info', `ดาวน์โหลด ${info.version} เสร็จแล้ว พร้อมติดตั้ง`);
    });
    autoUpdater.on('error', (err) => {
      this.set({ stage: 'error', message: err.message });
      this.log('warn', `ตรวจอัปเดตไม่สำเร็จ: ${err.message}`);
    });
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  current(): UpdateState {
    return this.state;
  }

  async check(): Promise<UpdateState> {
    if (!this.state.supported) {
      this.set({ stage: 'none', message: 'ระหว่างพัฒนา ไม่มีตัวติดตั้งให้อัปเดต' });
      return this.state;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.set({ stage: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    return this.state;
  }

  async download(): Promise<void> {
    if (this.state.stage !== 'available') return;
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      this.set({ stage: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** ปิดแอปแล้วติดตั้งทันที */
  installNow(): void {
    if (this.state.stage !== 'ready') return;
    // isSilent=false เพื่อให้ผู้ใช้เห็นว่ากำลังติดตั้ง, isForceRunAfter=true เปิดกลับให้เอง
    autoUpdater.quitAndInstall(false, true);
  }

  /**
   * 🔑 ชั้นที่ 2 ของกับดักไอคอนเดสก์ท็อป
   *
   * โน้ต 2026-08-23 (masternode): ใน NSIS สาขาที่สร้างไอคอนมี `${ifNot} ${isUpdated}`
   * คร่อมอยู่ แปลว่า **ตัวติดตั้งที่รันด้วยแฟลก --updated จะไม่สร้างไอคอนคืนไม่ว่าตั้งค่าอย่างไร**
   * ผู้ใช้ที่เคยลบไอคอนทิ้ง (หรือโดนกับดัก keepShortcuts) จะไม่มีวันได้คืน
   *
   * ทางแก้เดียวที่ได้ผลจริงคือแอปสร้างเองตอนเปิด ซึ่ง Electron ทำได้ในตัวด้วย
   * shell.writeShortcutLink ไม่ต้องพึ่งไลบรารีเสริม
   */
  static repairDesktopShortcut(log: Log): void {
    if (process.platform !== 'win32' || !app.isPackaged) return;

    try {
      const desktop = path.join(os.homedir(), 'Desktop');
      if (!fs.existsSync(desktop)) return;

      const linkPath = path.join(desktop, 'AndroidRemote.lnk');
      if (fs.existsSync(linkPath)) return;

      const ok = shell.writeShortcutLink(linkPath, 'create', {
        target: process.execPath,
        cwd: path.dirname(process.execPath),
        description: 'รีโมทมือถือแอนดรอยด์จาก PC',
      });
      log(ok ? 'info' : 'warn', ok ? 'สร้างไอคอนเดสก์ท็อปคืนแล้ว' : 'สร้างไอคอนเดสก์ท็อปไม่สำเร็จ');
    } catch (err) {
      // ไม่ใช่เรื่องคอขาดบาดตาย ห้ามให้แอปเปิดไม่ขึ้นเพราะเรื่องไอคอน
      log('warn', `ซ่อมไอคอนเดสก์ท็อปไม่ได้: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
