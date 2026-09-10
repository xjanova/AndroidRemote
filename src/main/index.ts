/**
 * โพรเซสหลักของ Electron — สร้างหน้าต่าง ต่อสายทุกอย่างเข้าหากัน
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { AdbClient } from './adb/AdbClient';
import { DeviceRegistry } from './device/DeviceRegistry';
import { Discovery } from './discovery/Discovery';
import { KnownDevices } from './store/KnownDevices';
import { ServerSession, listCameras } from './server/ServerSession';
import { GamepadServer } from './gamepad/GamepadServer';
import { KeyInjector } from './gamepad/KeyInjector';
import { AutoUpdate } from './update/AutoUpdate';
import { FileLog } from './log';
import { MacroPlayer, MacroRecorder, MacroStore } from './automation/Macros';
import { Scheduler } from './automation/Scheduler';
import { dumpUi } from './automation/UiDump';
import { ProfileStore } from './automation/Profiles';
import { TemplateStore } from './vision/templates';
import { Ocr, ocrCacheDir } from './vision/ocr';
import { captureFrame, previewJpeg, type Frame } from './vision/capture';
import { scoreTemplate, warmUpMatcher } from './vision/match';
import { getVolume, setVolume } from './device/volume';
import type { DeviceProfile, FracRect, MacroView, ScheduleView, UiSelector, VolumeStream } from '../shared/automation';
import { EmulatorManager } from './emulator/EmulatorManager';
import type { CreateEmulatorSpec, EmulatorBrandId } from '../shared/emulator';
import {
  SCREEN_POWER,
  encodeKeycode,
  encodeScreenPowerMode,
  encodeTouch,
} from './server/messages';
import { IPC, type LogEntry, type MirrorOptions, type TouchInput } from '../shared/api';
import { DEFAULT_KEYMAP, type AdbStatus, type DeviceInfo, type GamepadStateView } from '../shared/types';
import fs from 'node:fs';

let mainWindow: BrowserWindow | null = null;
let adb: AdbClient;
let registry: DeviceRegistry;
let known: KnownDevices;
let discovery: Discovery;
/** เซสชันที่เปิดอยู่ — หนึ่งเครื่องต่อหนึ่งเซสชัน คุมพร้อมกันได้หลายเครื่อง */
const sessions = new Map<string, ServerSession>();
let macroStore: MacroStore;
let recorder: MacroRecorder;
let player: MacroPlayer;
let scheduler: Scheduler;
let profiles: ProfileStore;
let templates: TemplateStore;
let ocr: Ocr;
/** เฟรมล่าสุดต่อเครื่อง — ให้หลายขั้นตอนใน 300ms เดียวกันใช้ภาพเดียว และให้ตัดเทมเพลตจากภาพที่ผู้ใช้เห็น */
const lastFrames = new Map<string, Frame>();
async function captureCached(serial: string, maxAgeMs = 300): Promise<Frame> {
  const hit = lastFrames.get(serial);
  if (hit && Date.now() - hit.takenAt < maxAgeMs) return hit;
  const f = await captureFrame(adb, serial);
  lastFrames.set(serial, f);
  return f;
}
let emulators: EmulatorManager;
let gamepad: GamepadServer;
let injector: KeyInjector;
let updater: AutoUpdate;
let keymap: Record<string, number> = { ...DEFAULT_KEYMAP };

/** ส่ง log ไปโชว์ในแอปด้วย ไม่ใช่แค่ค้างอยู่ใน terminal ที่ผู้ใช้ไม่เห็น */
let fileLog: FileLog | null = null;

function pushLog(level: LogEntry['level'], scope: string, message: string): void {
  const entry: LogEntry = { level, scope, message, at: Date.now() };
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[${scope}] ${message}`);
  // ลงไฟล์ด้วยเสมอ — กล่องในแอปหายตอนปิด แต่ไฟล์นี้คือสิ่งเดียวที่เอามาวินิจฉัยทีหลังได้
  fileLog?.write(level, scope, message);
  mainWindow?.webContents.send(IPC.evtLog, entry);
}

/**
 * เปิดไร้สายผ่านสาย USB ที่เสียบอยู่ — ทางที่ไม่ต้องพึ่ง mDNS และไม่ต้องจับคู่
 * ลำดับสำคัญ: อ่าน IP **ก่อน** สั่ง tcpip เพราะหลังสั่ง adbd รีสตาร์ตแล้วสายจะหลุดชั่วครู่
 */
async function enableWirelessViaUsb(serial: string): Promise<{ ok: boolean; hostPort?: string; message: string }> {
  const device = registry.get(serial);
  if (!device || device.state !== 'device') return { ok: false, message: 'เครื่องยังไม่พร้อม' };
  if (device.transport !== 'usb') return { ok: false, message: 'ต้องเป็นเครื่องที่เสียบสาย USB อยู่' };

  const ip = await adb.wifiAddress(serial);
  if (!ip) {
    return { ok: false, message: 'มือถือยังไม่ได้ต่อ Wi-Fi — ต่อ Wi-Fi วงเดียวกับ PC ก่อนแล้วลองใหม่' };
  }

  const reply = await adb.tcpip(serial, 5555).catch((e) => `ผิดพลาด: ${e instanceof Error ? e.message : e}`);
  pushLog('info', 'ไร้สาย', `สั่ง tcpip 5555 บน ${device.model ?? serial}: ${reply || '(เงียบ)'}`);

  // adbd กำลังรีสตาร์ต — รอให้มันขึ้นมารับ TCP ก่อนค่อยต่อ
  const hostPort = `${ip}:5555`;
  let message = '';
  for (let attempt = 1; attempt <= 6; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    message = await adb.connectTcp(hostPort).catch((e) => String(e));
    if (/connected to/i.test(message)) {
      if (device.hwSerial) {
        known.remember({ serial: device.hwSerial, name: device.model, lastAddress: ip, lastPort: 5555 });
      }
      pushLog('info', 'ไร้สาย', `${device.model ?? serial} พร้อมใช้ไร้สายที่ ${hostPort} — ถอดสายได้เลย`);
      return { ok: true, hostPort, message: `ต่อไร้สายที่ ${hostPort} แล้ว ถอดสาย USB ได้เลย` };
    }
  }
  pushLog('warn', 'ไร้สาย', `เปิด tcpip แล้วแต่ต่อ ${hostPort} ไม่ติด: ${message}`);
  return {
    ok: false,
    hostPort,
    message: `เปิดโหมดแล้วแต่ต่อ ${hostPort} ไม่ติด — เช็คว่า PC กับมือถืออยู่วงเดียวกัน (${message})`,
  };
}

async function buildAdbStatus(): Promise<AdbStatus> {
  const execPath = adb.executablePath;
  if (!execPath) {
    return {
      ok: false,
      error: 'หา adb.exe ไม่เจอ — ตั้งค่า ANDROID_HOME หรือระบุพาธเองในหน้าตั้งค่า',
    };
  }
  try {
    const version = await adb.version();
    return { ok: true, path: execPath, version };
  } catch (err) {
    return {
      ok: false,
      path: execPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    show: false,
    // เราวาดแถบหัวเองเป็นธีม XP Silver เลยต้องปิดกรอบของ Windows
    frame: false,
    backgroundColor: '#333d54',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // แสดงหน้าต่างตอนวาดเสร็จแล้วเท่านั้น — กันจอขาววาบตอนเปิดแอป
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  const sendWindowState = (): void => {
    mainWindow?.webContents.send(IPC.evtWindowState, {
      maximized: mainWindow.isMaximized(),
    });
  };
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);

  // ลิงก์ภายนอกให้เปิดในเบราว์เซอร์จริง ไม่ใช่กลืนหน้าต่างแอปทิ้ง
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // โหมดแคปหน้าจอตัวเองสำหรับนักพัฒนา: AR_UI_SHOT='[{"click":"#btn-macro"},{"wait":1500},{"shot":"D:/x/a.png"}]'
  // แคปจากข้างในด้วย capturePage — ไม่แย่งโฟกัส ไม่ขยับเมาส์ผู้ใช้ (ต่างจากการจำลองคลิกบนเดสก์ท็อป)
  if (process.env.AR_UI_SHOT) {
    mainWindow.webContents.once('did-finish-load', () => void runUiShotScript(process.env.AR_UI_SHOT ?? '[]'));
  }
}

async function runUiShotScript(json: string): Promise<void> {
  const wc = mainWindow?.webContents;
  if (!wc) return;
  const steps = JSON.parse(json) as Array<{ click?: string; wait?: number; shot?: string; js?: string }>;
  await new Promise((r) => setTimeout(r, 2500));
  for (const step of steps) {
    if (step.click) {
      const r = await wc.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(step.click)}); if (!el) return 'ไม่พบ ' + ${JSON.stringify(step.click)}; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'ok'; })()`,
      );
      pushLog('info', 'ui-shot', `คลิก ${step.click}: ${String(r)}`);
    }
    if (step.js) pushLog('info', 'ui-shot', `js: ${JSON.stringify(await wc.executeJavaScript(step.js))}`);
    if (step.wait) await new Promise((r) => setTimeout(r, step.wait));
    if (step.shot) {
      const img = await wc.capturePage();
      fs.writeFileSync(step.shot, img.toPNG());
      pushLog('info', 'ui-shot', `แคป ${step.shot}`);
    }
  }
  app.quit();
}

function registerIpc(): void {
  ipcMain.handle(IPC.adbStatus, () => buildAdbStatus());

  ipcMain.handle(IPC.adbRestart, async () => {
    pushLog('info', 'adb', 'กำลังรีสตาร์ท adb server');
    try {
      await adb.killServer();
    } catch {
      // ถ้ามันตายอยู่แล้วก็ไม่เป็นไร
    }
    const status = await buildAdbStatus();
    // สตรีมเดิมขาดไปพร้อม server — เปิดใหม่
    registry.dispose();
    registry = createRegistry();
    await registry.start();
    mainWindow?.webContents.send(IPC.evtAdbStatus, status);
    return status;
  });

  ipcMain.handle(IPC.listDevices, () => registry.list());

  ipcMain.handle(IPC.refreshDevice, async (_e, serial: string) => {
    return (await registry.refresh(serial)) ?? null;
  });

  ipcMain.handle(IPC.runShell, async (_e, serial: string, command: string) => {
    return adb.exec(serial, command);
  });

  ipcMain.handle(IPC.wirelessConnect, async (_e, hostPort: string) => {
    try {
      const message = await adb.connectTcp(hostPort);
      const ok = /connected to/i.test(message);
      pushLog(ok ? 'info' : 'warn', 'ไร้สาย', message);
      return { ok, message };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushLog('error', 'ไร้สาย', message);
      return { ok: false, message };
    }
  });

  ipcMain.handle(IPC.wirelessDisconnect, async (_e, hostPort: string) => {
    try {
      const message = await adb.disconnectTcp(hostPort);
      return { ok: true, message };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC.wirelessPair, async (_e, hostPort: string, code: string) => {
    const result = await adb.pair(hostPort, code);
    pushLog(result.ok ? 'info' : 'warn', 'จับคู่', result.message);
    return result;
  });

  // ─────────────────────────── ค้นหาบนวง Wi-Fi ───────────────────────────

  ipcMain.handle(IPC.discoveryState, () => discovery.state());
  ipcMain.handle(IPC.discoverySweep, () => discovery.sweepNow());
  ipcMain.on(IPC.discoveryCancelSweep, () => discovery.cancelSweep());

  ipcMain.handle(IPC.discoveryConnect, async (_e, hostPort: string, serial: string | null) => {
    const result = await discovery.connectAndRemember(hostPort, serial);
    pushLog(result.ok ? 'info' : 'warn', 'ไร้สาย', result.message);
    return result;
  });

  ipcMain.handle(IPC.discoveryPair, async (_e, hostPort: string, code: string) => {
    const result = await discovery.pairAndRemember(hostPort, code);
    pushLog(result.ok ? 'info' : 'warn', 'จับคู่', result.message);
    return result;
  });

  ipcMain.handle(IPC.wirelessViaUsb, (_e, serial: string) => enableWirelessViaUsb(serial));

  ipcMain.handle(IPC.logPath, () => fileLog?.filePath ?? null);
  ipcMain.handle(IPC.logOpen, () => {
    if (fileLog) shell.showItemInFolder(fileLog.filePath);
  });
  ipcMain.handle(IPC.logTail, () => fileLog?.tail() ?? '');

  ipcMain.handle(IPC.knownDevices, () => known.list());
  ipcMain.handle(IPC.forgetDevice, (_e, serial: string) => {
    known.forget(serial);
    pushLog('info', 'ไร้สาย', `ลบ ${serial} ออกจากรายชื่อที่จำไว้แล้ว`);
  });
  ipcMain.handle(IPC.setAutoConnect, (_e, serial: string, on: boolean) => {
    known.setAutoConnect(serial, on);
  });

  // ─────────────────────────── อัปเดตตัวแอป ───────────────────────────

  ipcMain.handle(IPC.updateState, () => updater.current());
  ipcMain.handle(IPC.updateCheck, () => updater.check());
  ipcMain.handle(IPC.updateDownload, () => updater.download());
  ipcMain.on(IPC.updateInstall, () => updater.installNow());

  // ─────────────────────────── สั่งจัดการอีมูเลเตอร์ ───────────────────────────

  ipcMain.handle(IPC.emuState, () => emulators.state());
  ipcMain.handle(IPC.emuCreate, (_e, brand: EmulatorBrandId, spec: CreateEmulatorSpec) => emulators.create(brand, spec));
  ipcMain.handle(IPC.emuLaunch, (_e, brand: EmulatorBrandId, id: string) => emulators.launch(brand, id));
  ipcMain.handle(IPC.emuQuit, (_e, brand: EmulatorBrandId, id: string) => emulators.quit(brand, id));
  ipcMain.handle(IPC.emuReboot, (_e, brand: EmulatorBrandId, id: string) => emulators.reboot(brand, id));
  ipcMain.handle(IPC.emuRemove, (_e, brand: EmulatorBrandId, id: string) => emulators.remove(brand, id));

  // ─────────────────────────── โหมดจอยเกม ───────────────────────────

  ipcMain.handle(IPC.gamepadState, () => gamepadState());

  ipcMain.handle(IPC.gamepadStart, async () => {
    if (!KeyInjector.available()) {
      pushLog('error', 'จอย',
        process.platform === 'win32'
          ? 'ไม่พบ inputhelper.exe — รัน npm run helper:build ก่อน'
          : 'โหมดจอยรองรับเฉพาะ Windows ในตอนนี้');
      return gamepadState();
    }
    injector.start();
    await gamepad.start();
    const state = gamepadState();
    pushLog('info', 'จอย', `เปิดแล้ว — บนมือถือเปิด ${state.urls[0] ?? `พอร์ต ${state.port}`}`);
    return state;
  });

  ipcMain.handle(IPC.gamepadStop, () => {
    gamepad.stop();
    injector.stop();
    return gamepadState();
  });

  ipcMain.handle(IPC.gamepadSetKey, (_e, button: string, vk: number) => {
    keymap[button] = vk;
    saveKeymap();
    emitGamepadState();
    return gamepadState();
  });

  ipcMain.handle(IPC.gamepadResetKeys, () => {
    keymap = { ...DEFAULT_KEYMAP };
    saveKeymap();
    emitGamepadState();
    return gamepadState();
  });

  // ─────────────────────────── มิเรอร์ / กล้อง ───────────────────────────

  ipcMain.handle(IPC.listCameras, async (_e, serial: string) => {
    const device = registry.get(serial);
    if (!device || device.state !== 'device') {
      return { cameras: [], concurrent: [], error: 'อุปกรณ์ยังไม่พร้อม' };
    }
    const result = await listCameras(adb, serial, device.tier === 'root');
    if (result.error) pushLog('warn', 'กล้อง', result.error);
    else pushLog('info', 'กล้อง', `เครื่องนี้มีกล้อง ${result.cameras.length} ตัว`);
    return result;
  });

  ipcMain.handle(IPC.mirrorStart, async (_e, serial: string, options: MirrorOptions = {}) => {
    // เครื่องเดิมที่เปิดอยู่ให้ปิดก่อนเปิดใหม่ เครื่องอื่นไม่ยุ่ง — คุมหลายเครื่องพร้อมกัน
    stopSession(serial, 'เริ่มเซสชันใหม่');

    const device = registry.get(serial);
    if (!device) return { ok: false, message: 'ไม่พบอุปกรณ์นี้แล้ว' };
    if (device.state !== 'device') return { ok: false, message: `อุปกรณ์อยู่ในสถานะ ${device.state}` };
    // อย่าให้ผู้ใช้ติดค้างรอ su ที่ไม่มีวันผ่าน — ตรวจจากผลที่ probe ไว้แล้ว
    if (options.useRoot && device.tier !== 'root') {
      return { ok: false, message: 'เครื่องนี้ยังไม่ได้สิทธิ์ root — ยกเลิกก่อนเสียเวลา' };
    }

    const s = new ServerSession(adb, serial, options);
    sessions.set(serial, s);
    const tag = device.model ?? serial;

    s.on('log', (line: string) => pushLog(/\[AR\] E /.test(line) ? 'error' : 'info', tag, line));
    s.on('header', (h) => {
      mainWindow?.webContents.send(IPC.evtMirrorHeader, { ...h, serial, hasControl: s.hasControl });
    });
    s.on('packet', (p) => {
      mainWindow?.webContents.send(IPC.evtMirrorPacket, {
        serial,
        streamId: p.streamId,
        config: p.config,
        keyFrame: p.keyFrame,
        // BigInt ข้าม IPC ได้ แต่ฝั่ง renderer ใช้เป็นตัวเลขธรรมดาสะดวกกว่า
        // และ µs ของเซสชันหนึ่งไม่มีทางเกิน 2^53
        ptsUs: Number(p.ptsUs),
        data: p.data,
      });
    });
    s.on('shellResult', (r) => pushLog('info', tag, `คำสั่งจบ (exit ${r.exitCode}): ${r.output.trim()}`));
    s.on('closed', (reason: string) => {
      if (sessions.get(serial) === s) sessions.delete(serial);
      mainWindow?.webContents.send(IPC.evtMirrorClosed, { serial, reason });
      pushLog('info', tag, `เซสชันปิด: ${reason}`);
    });

    try {
      await s.start();
      return { ok: true, message: 'เริ่มมิเรอร์แล้ว' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushLog('error', tag, message);
      if (sessions.get(serial) === s) sessions.delete(serial);
      return { ok: false, message };
    }
  });

  ipcMain.handle(IPC.mirrorStop, (_e, serial?: string) => {
    if (serial) stopSession(serial, 'ผู้ใช้สั่งหยุด');
    else stopAllSessions('ผู้ใช้สั่งหยุดทั้งหมด');
  });

  ipcMain.handle(IPC.mirrorSessions, () => [...sessions.keys()]);

  ipcMain.on(IPC.mirrorTouch, (_e, input: TouchInput) => {
    // ตัวบันทึกมาโครดักตรงนี้ — ทุกอย่างที่ผู้ใช้ทำผ่านแอปไหลผ่านจุดเดียว
    recorder.onTouch(input);
    sessions.get(input.serial)?.send(
      encodeTouch({
        action: input.action,
        pointerId: BigInt(input.pointerId),
        x: input.x,
        y: input.y,
        screenW: input.screenW,
        screenH: input.screenH,
        pressure: input.pressure,
      }),
    );
  });

  ipcMain.on(IPC.mirrorKey, (_e, serial: string, action: number, keycode: number) => {
    recorder.onKey(serial, action, keycode);
    sessions.get(serial)?.send(encodeKeycode(action, keycode));
  });

  ipcMain.on(IPC.mirrorScreenPower, (_e, serial: string, on: boolean) => {
    sessions.get(serial)?.send(encodeScreenPowerMode(on ? SCREEN_POWER.NORMAL : SCREEN_POWER.OFF));
  });

  // ─────────────────────────── มาโครและตั้งเวลา ───────────────────────────

  ipcMain.handle(IPC.macroList, () => macroStore.list());
  ipcMain.handle(IPC.macroRecordingState, () => {
    const a = recorder.active;
    return a ? { recording: true, serial: a.serial, steps: a.steps } : { recording: false, steps: 0 };
  });
  ipcMain.handle(IPC.macroRecordStart, (_e, serial: string, name: string) => {
    const size = screenSizeOf(serial);
    if (!size) throw new Error('ต้องเปิดเซสชันของเครื่องนี้ก่อนบันทึก');
    recorder.start(serial, name, size);
    pushLog('info', 'มาโคร', `เริ่มบันทึกจาก ${registry.get(serial)?.model ?? serial}`);
  });
  ipcMain.handle(IPC.macroRecordStop, () => {
    const m = recorder.stop();
    if (m && m.steps.length > 0) {
      macroStore.put(m);
      pushLog('info', 'มาโคร', `บันทึก "${m.name}" ${m.steps.length} ขั้นตอน`);
      return m;
    }
    if (m) pushLog('warn', 'มาโคร', 'ไม่ได้บันทึก — ไม่มีขั้นตอนเลย');
    return null;
  });
  ipcMain.handle(IPC.macroPlay, async (_e, macroId: string, serials: string[], loops = 1) => {
    const m = macroStore.get(macroId);
    if (!m) return { ok: false, message: 'ไม่พบมาโครนี้' };
    return player.play(m, serials, Math.max(1, loops));
  });
  ipcMain.handle(IPC.macroStop, () => player.stop());
  ipcMain.handle(IPC.macroDelete, (_e, id: string) => macroStore.delete(id));
  ipcMain.handle(IPC.macroRename, (_e, id: string, name: string) => {
    const m = macroStore.get(id);
    if (m) macroStore.put({ ...m, name: name.trim() || m.name });
  });
  ipcMain.handle(IPC.macroAddFindTap, (_e, id: string, selector: UiSelector) => {
    const m = macroStore.get(id);
    if (!m) return;
    const last = m.steps[m.steps.length - 1];
    m.steps.push({ t: 'find_tap', selector, timeoutMs: 5000, atMs: (last?.atMs ?? 0) + 800 });
    macroStore.put(m);
  });
  ipcMain.handle(IPC.uiDump, (_e, serial: string) => dumpUi(adb, serial));
  ipcMain.handle(IPC.scheduleList, () => scheduler.list());
  ipcMain.handle(IPC.scheduleSave, (_e, entry: ScheduleView) => scheduler.put(entry));
  ipcMain.handle(IPC.scheduleDelete, (_e, id: string) => scheduler.delete(id));
  ipcMain.handle(IPC.macroSave, (_e, m: MacroView) => {
    if (!m?.id) throw new Error('มาโครไม่มี id');
    macroStore.put({ ...m, steps: m.steps.map((st) => ({ ...st, atMs: Number.isFinite(st.atMs) ? st.atMs : 0 })) });
  });
  ipcMain.handle(IPC.macroRunState, () => player.current());

  // ─────────────────────────── โปรไฟล์ / เทมเพลต / OCR / เสียง ───────────────────────────

  ipcMain.handle(IPC.profileList, () => profiles.list());
  ipcMain.handle(IPC.profileSave, (_e, p: DeviceProfile) => profiles.put(p));
  ipcMain.handle(IPC.profileDelete, (_e, serial: string) => profiles.delete(serial));

  ipcMain.handle(IPC.templateSets, () => templates.sets());
  ipcMain.handle(IPC.templateList, (_e, set: string) =>
    templates.list(set).map((t) => ({ ...t, dataUrl: templates.dataUrl(set, t.name) })),
  );
  ipcMain.handle(IPC.templateDelete, (_e, set: string, name: string) => templates.delete(set, name));
  ipcMain.handle(IPC.screenshotPreview, async (_e, serial: string) => {
    const f = await captureFrame(adb, serial);
    lastFrames.set(serial, f);
    const jpg = await previewJpeg(f, 360);
    return { serial, dataUrl: `data:image/jpeg;base64,${jpg.toString('base64')}`, width: f.width, height: f.height, takenAt: f.takenAt };
  });
  ipcMain.handle(IPC.templateSaveFromPreview, async (_e, serial: string, set: string, name: string, rect: FracRect) => {
    // ใช้เฟรมเดียวกับที่ผู้ใช้เห็นตอนลากกรอบ (ไม่ถ่ายใหม่ — หน้าจออาจเปลี่ยนไปแล้ว)
    const f = lastFrames.get(serial) ?? (await captureFrame(adb, serial));
    const info = await templates.save(set, name, f, rect);
    pushLog('info', 'เทมเพลต', `บันทึก "${set}/${name}" ${info.width}×${info.height}px`);
    return info;
  });
  ipcMain.handle(IPC.templateTest, async (_e, serial: string, set: string, name: string) => {
    const tpl = await templates.load(set, name);
    const f = await captureCached(serial, 0);
    return scoreTemplate(f, tpl);
  });
  ipcMain.handle(IPC.ocrTest, async (_e, serial: string, rect: FracRect, digits: boolean) => {
    const f = await captureCached(serial, 0);
    return ocr.read(f, rect, { digits });
  });

  ipcMain.handle(IPC.volumeGet, (_e, serial: string, stream: VolumeStream) => getVolume(adb, serial, stream));
  ipcMain.handle(IPC.volumeSet, async (_e, serial: string, stream: VolumeStream, percent: number) => {
    const r = await setVolume(adb, serial, stream, percent);
    pushLog(r.ok ? 'info' : 'warn', 'เสียง', `${registry.get(serial)?.model ?? serial}: ${stream} ${percent}% ${r.ok ? `(${r.via})` : 'ตั้งไม่ได้'}`);
    return { ok: r.ok, via: r.via };
  });

  ipcMain.on(IPC.windowMinimize, () => mainWindow?.minimize());
  ipcMain.on(IPC.windowToggleMaximize, () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on(IPC.windowClose, () => mainWindow?.close());
  ipcMain.handle(IPC.windowAlwaysOnTop, (_e, on: boolean) => {
    mainWindow?.setAlwaysOnTop(on);
    return mainWindow?.isAlwaysOnTop() ?? false;
  });
}

// ─────────────────────────── ผังปุ่มจอย ───────────────────────────

function keymapPath(): string {
  return path.join(app.getPath('userData'), 'gamepad-keymap.json');
}

function loadKeymap(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(keymapPath(), 'utf8')) as Record<string, number>;
    // รวมกับค่าเริ่มต้นเสมอ — ปุ่มที่เพิ่มมาใหม่ในเวอร์ชันหลังจะได้มีค่าใช้
    keymap = { ...DEFAULT_KEYMAP, ...raw };
  } catch {
    keymap = { ...DEFAULT_KEYMAP };
  }
}

function saveKeymap(): void {
  try {
    fs.writeFileSync(keymapPath(), JSON.stringify(keymap, null, 2), 'utf8');
  } catch (err) {
    pushLog('warn', 'จอย', `บันทึกผังปุ่มไม่ได้: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function gamepadState(): GamepadStateView {
  return { ...gamepad.state(injector.isReady), keymap };
}

function emitGamepadState(): void {
  mainWindow?.webContents.send(IPC.evtGamepadChanged, gamepadState());
}

function stopSession(serial: string, reason: string): void {
  const s = sessions.get(serial);
  sessions.delete(serial);
  s?.stop(reason);
}

function stopAllSessions(reason: string): void {
  for (const serial of [...sessions.keys()]) stopSession(serial, reason);
}

/** ขนาดจอจริงของเครื่องที่มีเซสชันอยู่ — ตัวเล่นมาโครใช้แปลงสัดส่วนเป็นพิกเซล */
function screenSizeOf(serial: string): { width: number; height: number } | null {
  if (!sessions.has(serial)) return null;
  const d = registry.get(serial);
  if (!d?.screenWidth || !d.screenHeight) return null;
  return { width: d.screenWidth, height: d.screenHeight };
}

/**
 * ตัวรันที่ตัวตั้งเวลาเรียก: เปิดเซสชันแบบประหยัดให้เครื่องที่ยังไม่มี → เล่น → ปิดเฉพาะที่เราเปิดเอง
 * ใช้ภาพเล็ก (320px) เพราะไม่มีใครดู แค่ต้องการช่องควบคุม
 */
async function runScheduled(entry: ScheduleView): Promise<string> {
  const m = macroStore.get(entry.macroId);
  if (!m) return 'ไม่พบมาโคร';
  const opened: string[] = [];
  for (const serial of entry.serials) {
    if (sessions.has(serial)) continue;
    const d = registry.get(serial);
    if (!d || d.state !== 'device') continue;
    const s = new ServerSession(adb, serial, { mode: 'screen', maxSize: 320, maxFps: 10, bitRate: 500_000 });
    sessions.set(serial, s);
    s.on('closed', () => {
      if (sessions.get(serial) === s) sessions.delete(serial);
    });
    try {
      await s.start();
      opened.push(serial);
    } catch (err) {
      pushLog('warn', 'ตั้งเวลา', `${d.model ?? serial}: เปิดเซสชันไม่ได้ (${err instanceof Error ? err.message : err})`);
      sessions.delete(serial);
    }
  }
  const result = await player.play(m, entry.serials, entry.loops);
  for (const serial of opened) stopSession(serial, 'งานตั้งเวลาเสร็จ');
  return result.message;
}

function createRegistry(): DeviceRegistry {
  const reg = new DeviceRegistry(adb, (level, message) => pushLog(level, 'เครื่อง', message));
  reg.on('devices:changed', (devices) => {
    mainWindow?.webContents.send(IPC.evtDevicesChanged, devices);
  });
  // ต่อไร้สายสำเร็จแล้วต้องจำไว้ทันที — ครั้งหน้าจะได้ต่อให้เองโดยไม่ต้องจับคู่ใหม่
  reg.on('device:updated', (info: DeviceInfo) => {
    if (info.transport !== 'tcp' || info.state !== 'device' || !info.hwSerial) return;
    const colon = info.serial.lastIndexOf(':');
    known.remember({
      serial: info.hwSerial,
      name: info.model,
      lastAddress: colon > 0 ? info.serial.slice(0, colon) : info.serial,
      lastPort: colon > 0 ? parseInt(info.serial.slice(colon + 1), 10) || 5555 : 5555,
    });
  });
  return reg;
}

/** serial ที่ adb กำลังต่ออยู่ — ทั้งชื่อ ip:port และ serial ฮาร์ดแวร์ */
function connectedKeys(): Set<string> {
  const out = new Set<string>();
  for (const d of registry?.list() ?? []) {
    if (d.state !== 'device') continue;
    out.add(d.serial);
    if (d.hwSerial) out.add(d.hwSerial);
  }
  return out;
}

// อนุญาตให้เปิดแอปได้ครั้งเดียว — สอง instance จะแย่งสตรีม adb กันจนสับสน
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    fileLog = new FileLog(app.getPath('userData'));
    fileLog.banner({
      เวอร์ชัน: app.getVersion(),
      แพ็กแล้ว: app.isPackaged,
      exe: process.execPath,
      resources: process.resourcesPath,
      platform: `${process.platform} ${process.getSystemVersion()}`,
      electron: process.versions.electron,
    });

    adb = new AdbClient({ log: (level, message) => pushLog(level, 'adb', message) });
    pushLog('info', 'adb', `ใช้ adb ที่ ${adb.executablePath ?? '(หาไม่เจอ)'}`);
    known = new KnownDevices(app.getPath('userData'));
    registry = createRegistry();
    discovery = new Discovery(
      adb,
      known,
      (level, message) => pushLog(level, 'ค้นหา', message),
      connectedKeys,
    );
    discovery.on('changed', (state) => {
      mainWindow?.webContents.send(IPC.evtDiscoveryChanged, state);
    });

    updater = new AutoUpdate(
      (level, message) => pushLog(level, 'อัปเดต', message),
      (state) => mainWindow?.webContents.send(IPC.evtUpdateChanged, state),
    );
    // ต้องเรียกทุกครั้งที่เปิด ไม่ใช่แค่ตอนติดตั้ง — สายอัปเดตอัตโนมัติไม่สร้างไอคอนให้
    AutoUpdate.repairDesktopShortcut((level, message) => pushLog(level, 'อัปเดต', message));

    macroStore = new MacroStore(app.getPath('userData'));
    recorder = new MacroRecorder();
    profiles = new ProfileStore(app.getPath('userData'));
    templates = new TemplateStore(path.join(app.getPath('userData'), 'templates'));
    ocr = new Ocr(ocrCacheDir(app.getPath('userData')), (level, message) => pushLog(level, 'OCR', message));
    warmUpMatcher();
    player = new MacroPlayer(
      {
        adb,
        send: (serial, msg) => sessions.get(serial)?.send(msg) ?? false,
        screenSize: screenSizeOf,
        templates,
        capture: (serial) => captureCached(serial),
        ocr,
        profiles,
        getMacro: (id) => macroStore.get(id),
        setVolume: (serial, stream, percent) => setVolume(adb, serial, stream, percent),
      },
      (level, message) => pushLog(level, 'มาโคร', message),
    );
    player.on('state', (state) => mainWindow?.webContents.send(IPC.evtMacroState, state));
    scheduler = new Scheduler(app.getPath('userData'), runScheduled, (level, message) =>
      pushLog(level, 'ตั้งเวลา', message),
    );
    emulators = new EmulatorManager(adb.executablePath, (level, message) => pushLog(level, 'อีมูเลเตอร์', message));
    emulators.on('changed', () => {
      void emulators.state().then((s) => mainWindow?.webContents.send(IPC.evtEmuChanged, s));
    });

    loadKeymap();
    injector = new KeyInjector((level, message) => pushLog(level, 'จอย', message));
    gamepad = new GamepadServer((level, message) => pushLog(level, 'จอย', message));
    gamepad.on('button', ({ button, down }: { button: string; down: boolean }) => {
      const vk = keymap[button];
      if (vk === undefined) return;
      if (down) injector.down(vk);
      else injector.up(vk);
    });
    // สายหลุดกลางเกม = ปุ่มค้าง ตัวละครจะเดินหน้าไม่หยุด ต้องปล่อยทันที
    gamepad.on('release-all', () => injector.releaseAll());
    gamepad.on('changed', () => emitGamepadState());

    registerIpc();
    createWindow();

    const status = await buildAdbStatus();
    mainWindow?.webContents.send(IPC.evtAdbStatus, status);
    if (!status.ok) {
      pushLog('error', 'adb', status.error ?? 'adb ใช้งานไม่ได้');
    }

    await registry.start();

    // เช็คอัปเดตหลังแอปนิ่งแล้ว อย่าไปแย่งแบนด์วิดท์กับการต่อเครื่องตอนเปิด
    setTimeout(() => void updater.check(), 8000);

    if (status.ok) {
      await discovery.start();
      scheduler.start();
      // ลองต่อเครื่องที่จำไว้ตามที่อยู่ล่าสุดเลย ไม่ต้องรอให้ mDNS เห็นก่อน
      void discovery.reconnectKnown();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // ต้องหยุดเซสชันก่อนออก ไม่งั้นโพรเซส server บนมือถือค้างกินแบตต่อไปเรื่อยๆ
    stopAllSessions('ปิดแอป');
    scheduler?.stop();
    gamepad?.stop();
    injector?.stop();
    discovery?.stop();
    registry?.dispose();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    stopAllSessions('ปิดแอป');
    scheduler?.stop();
    fileLog?.close();
  });
}
