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
/** เซสชันมิเรอร์ที่เปิดอยู่ — ทีละหนึ่งเครื่องเท่านั้นในตอนนี้ */
let session: ServerSession | null = null;
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
    stopSession('เริ่มเซสชันใหม่');

    const device = registry.get(serial);
    if (!device) return { ok: false, message: 'ไม่พบอุปกรณ์นี้แล้ว' };
    if (device.state !== 'device') return { ok: false, message: `อุปกรณ์อยู่ในสถานะ ${device.state}` };
    // อย่าให้ผู้ใช้ติดค้างรอ su ที่ไม่มีวันผ่าน — ตรวจจากผลที่ probe ไว้แล้ว
    if (options.useRoot && device.tier !== 'root') {
      return { ok: false, message: 'เครื่องนี้ยังไม่ได้สิทธิ์ root — ยกเลิกก่อนเสียเวลา' };
    }

    const s = new ServerSession(adb, serial, options);
    session = s;

    s.on('log', (line: string) => pushLog(/\[AR\] E /.test(line) ? 'error' : 'info', 'มิเรอร์', line));
    s.on('header', (h) => {
      mainWindow?.webContents.send(IPC.evtMirrorHeader, { ...h, hasControl: s.hasControl });
    });
    s.on('packet', (p) => {
      mainWindow?.webContents.send(IPC.evtMirrorPacket, {
        streamId: p.streamId,
        config: p.config,
        keyFrame: p.keyFrame,
        // BigInt ข้าม IPC ได้ แต่ฝั่ง renderer ใช้เป็นตัวเลขธรรมดาสะดวกกว่า
        // และ µs ของเซสชันหนึ่งไม่มีทางเกิน 2^53
        ptsUs: Number(p.ptsUs),
        data: p.data,
      });
    });
    s.on('shellResult', (r) => pushLog('info', 'มิเรอร์', `คำสั่งจบ (exit ${r.exitCode}): ${r.output.trim()}`));
    s.on('closed', (reason: string) => {
      if (session === s) session = null;
      mainWindow?.webContents.send(IPC.evtMirrorClosed, reason);
      pushLog('info', 'มิเรอร์', `เซสชันปิด: ${reason}`);
    });

    try {
      await s.start();
      return { ok: true, message: 'เริ่มมิเรอร์แล้ว' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushLog('error', 'มิเรอร์', message);
      if (session === s) session = null;
      return { ok: false, message };
    }
  });

  ipcMain.handle(IPC.mirrorStop, () => {
    stopSession('ผู้ใช้สั่งหยุด');
  });

  ipcMain.on(IPC.mirrorTouch, (_e, input: TouchInput) => {
    session?.send(
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

  ipcMain.on(IPC.mirrorKey, (_e, action: number, keycode: number) => {
    session?.send(encodeKeycode(action, keycode));
  });

  ipcMain.on(IPC.mirrorScreenPower, (_e, on: boolean) => {
    session?.send(encodeScreenPowerMode(on ? SCREEN_POWER.NORMAL : SCREEN_POWER.OFF));
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

function stopSession(reason: string): void {
  const s = session;
  session = null;
  s?.stop(reason);
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
      // ลองต่อเครื่องที่จำไว้ตามที่อยู่ล่าสุดเลย ไม่ต้องรอให้ mDNS เห็นก่อน
      void discovery.reconnectKnown();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // ต้องหยุดเซสชันก่อนออก ไม่งั้นโพรเซส server บนมือถือค้างกินแบตต่อไปเรื่อยๆ
    stopSession('ปิดแอป');
    gamepad?.stop();
    injector?.stop();
    discovery?.stop();
    registry?.dispose();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    stopSession('ปิดแอป');
    fileLog?.close();
  });
}
