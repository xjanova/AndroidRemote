/**
 * สัญญาระหว่าง renderer กับ main
 * preload เอา interface นี้ไปวางบน window.androidRemote ผ่าน contextBridge
 */

import type { AdbStatus, DeviceInfo, DiscoveryState, GamepadStateView, ShellResult } from './types';
import type {
  DeviceProfile,
  FracRect,
  MacroRunState,
  MacroView,
  MatchResult,
  ScheduleView,
  ScreenshotPreview,
  TemplateInfo,
  UiNodeView,
  UiSelector,
  VolumeStream,
} from './automation';
import type {
  CreateEmulatorSpec,
  EmulatorBrandId,
  EmulatorManagerState,
  EmulatorOpResult,
} from './emulator';

/** เครื่องที่เคยจับคู่ไว้ — โครงเดียวกับที่ main เก็บลงไฟล์ */
export interface KnownDeviceView {
  serial: string;
  name?: string;
  lastAddress?: string;
  lastPort?: number;
  autoConnect: boolean;
  pairedAt?: number;
  lastSeenAt?: number;
}

export interface WirelessResult {
  ok: boolean;
  message: string;
}

export interface UpdateStateView {
  stage: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error';
  currentVersion: string;
  newVersion?: string;
  percent?: number;
  message?: string;
  /** ระหว่างพัฒนาไม่มีตัวติดตั้ง จึงเช็คอัปเดตไม่ได้ */
  supported: boolean;
}

export interface MirrorOptions {
  maxSize?: number;
  bitRate?: number;
  maxFps?: number;
  codec?: 'h264' | 'h265';
  useRoot?: boolean;
  screenOffOnStart?: boolean;
  /** screen = มิเรอร์จอ · camera = ใช้กล้องแทนเว็บแคม */
  mode?: 'screen' | 'camera';
  /** ไอดีกล้องที่จะเปิด — หนึ่งภาพต่อหนึ่งตัว เปิดพร้อมกันได้ถ้าเครื่องรองรับ */
  cameraIds?: string[];
}

export interface MirrorHeader {
  /** เครื่องที่สตรีมนี้มาจาก — คุมหลายเครื่องพร้อมกันได้ ต้องระบุเสมอ */
  serial: string;
  /** 0 สำหรับมิเรอร์จอ · 0..N-1 สำหรับกล้องแต่ละตัว */
  streamId: number;
  deviceName: string;
  width: number;
  height: number;
  codec: 'h264' | 'h265';
  hasControl: boolean;
}

export interface CameraInfoView {
  id: string;
  facing: 'front' | 'back' | 'external' | 'unknown';
  maxWidth: number;
  maxHeight: number;
  focalLength: number;
  legacy: boolean;
  error?: string;
}

export interface CameraListView {
  cameras: CameraInfoView[];
  /** ชุดกล้องที่เปิดพร้อมกันได้จริง — ว่างแปลว่าเครื่องนี้เปิดได้ทีละตัว */
  concurrent: string[][];
  error?: string;
}

/**
 * หนึ่งแพ็กเก็ตวิดีโอที่ข้ามมาจาก main
 * data เป็น Uint8Array เพราะ Buffer ข้าม contextBridge มาเป็น Uint8Array อยู่ดี
 */
export interface MirrorPacket {
  serial: string;
  streamId: number;
  config: boolean;
  keyFrame: boolean;
  /** ไมโครวินาที */
  ptsUs: number;
  data: Uint8Array;
}

export interface TouchInput {
  serial: string;
  action: number;
  pointerId: number;
  x: number;
  y: number;
  screenW: number;
  screenH: number;
  pressure?: number;
}

export interface AndroidRemoteApi {
  /** ─── adb ─── */
  adbStatus(): Promise<AdbStatus>;
  adbRestart(): Promise<AdbStatus>;

  /** ─── เครื่อง ─── */
  listDevices(): Promise<DeviceInfo[]>;
  refreshDevice(serial: string): Promise<DeviceInfo | null>;
  runShell(serial: string, command: string): Promise<ShellResult>;

  /** ─── ไร้สาย ─── */
  wirelessConnect(hostPort: string): Promise<WirelessResult>;
  wirelessDisconnect(hostPort: string): Promise<WirelessResult>;
  wirelessPair(hostPort: string, code: string): Promise<WirelessResult>;

  /** ─── ค้นหาบนวง Wi-Fi ─── */
  discoveryState(): Promise<DiscoveryState>;
  discoverySweep(): Promise<void>;
  discoveryCancelSweep(): void;
  discoveryConnect(hostPort: string, serial: string | null): Promise<WirelessResult>;
  discoveryPair(hostPort: string, code: string): Promise<WirelessResult>;
  /** เปิดไร้สายผ่านสาย USB ที่เสียบอยู่ — ไม่พึ่ง mDNS ไม่ต้องจับคู่ */
  wirelessViaUsb(serial: string): Promise<{ ok: boolean; hostPort?: string; message: string }>;
  knownDevices(): Promise<KnownDeviceView[]>;

  /** ─── ไฟล์ log ─── */
  logPath(): Promise<string | null>;
  logOpen(): Promise<void>;
  logTail(): Promise<string>;
  forgetDevice(serial: string): Promise<void>;
  setAutoConnect(serial: string, on: boolean): Promise<void>;

  /** ─── มิเรอร์ / กล้อง ─── */
  listCameras(serial: string): Promise<CameraListView>;
  /** เริ่มเซสชันของเครื่องนี้ — เครื่องอื่นที่เปิดอยู่ไม่ถูกปิด คุมพร้อมกันได้ */
  startMirror(serial: string, options?: MirrorOptions): Promise<WirelessResult>;
  /** หยุดเฉพาะเครื่องนี้ · ไม่ระบุ = หยุดทุกเครื่อง */
  stopMirror(serial?: string): Promise<void>;
  activeSessions(): Promise<string[]>;
  sendTouch(input: TouchInput): void;
  sendKey(serial: string, action: number, keycode: number): void;
  sendScreenPower(serial: string, on: boolean): void;

  /** ─── มาโครและตั้งเวลา ─── */
  macroList(): Promise<MacroView[]>;
  macroRecordStart(serial: string, name: string): Promise<void>;
  macroRecordStop(): Promise<MacroView | null>;
  macroRecordingState(): Promise<{ recording: boolean; serial?: string; steps: number }>;
  macroPlay(macroId: string, serials: string[], loops?: number): Promise<{ ok: boolean; message: string }>;
  macroStop(): Promise<void>;
  macroDelete(macroId: string): Promise<void>;
  macroRename(macroId: string, name: string): Promise<void>;
  /** เพิ่มขั้นตอนแบบหา element ด้วยมือ (แทนพิกัดดิบ) เข้ามาโคร */
  macroAddFindTap(macroId: string, selector: UiSelector): Promise<void>;
  /** อ่านโครงหน้าจอปัจจุบันของเครื่อง เพื่อเลือก element ใส่มาโคร */
  uiDump(serial: string): Promise<UiNodeView[]>;
  scheduleList(): Promise<ScheduleView[]>;
  scheduleSave(entry: ScheduleView): Promise<void>;
  scheduleDelete(id: string): Promise<void>;
  onMacroState(cb: (state: MacroRunState) => void): () => void;
  /** บันทึกมาโครทั้งก้อน (แก้ขั้นตอน/ตัวแปร/ชุดเทมเพลต/humanize/นโยบายพัง) */
  macroSave(macro: MacroView): Promise<void>;
  macroRunState(): Promise<MacroRunState>;

  /** ─── โปรไฟล์ต่อเครื่อง (ตัวแปร + เสียง) ─── */
  profileList(): Promise<DeviceProfile[]>;
  profileSave(profile: DeviceProfile): Promise<void>;
  profileDelete(serial: string): Promise<void>;

  /** ─── เทมเพลตภาพ + ภาพหน้าจอสำหรับตัด ─── */
  templateSets(): Promise<string[]>;
  templateList(set: string): Promise<Array<TemplateInfo & { dataUrl: string | null }>>;
  templateDelete(set: string, name: string): Promise<void>;
  screenshotPreview(serial: string): Promise<ScreenshotPreview>;
  /** ตัดจากภาพหน้าจอล่าสุดที่ preview ไว้ (กรอบเดียวกับที่ผู้ใช้ลาก) */
  templateSaveFromPreview(serial: string, set: string, name: string, rect: FracRect): Promise<TemplateInfo>;
  /** ลองหาเทมเพลตบนจอเครื่องตอนนี้ — คืนคะแนนดีที่สุดแม้ไม่ถึงเกณฑ์ */
  templateTest(serial: string, set: string, name: string): Promise<MatchResult | null>;
  ocrTest(serial: string, rect: FracRect, digits: boolean): Promise<{ text: string; confidence: number; tookMs: number }>;

  /** ─── เสียงต่อเครื่อง ─── */
  volumeGet(serial: string, stream: VolumeStream): Promise<{ index: number; max: number; percent: number } | null>;
  volumeSet(serial: string, stream: VolumeStream, percent: number): Promise<{ ok: boolean; via: string }>;

  /** ─── อัปเดตตัวแอป ─── */
  updateState(): Promise<UpdateStateView>;
  updateCheck(): Promise<UpdateStateView>;
  updateDownload(): Promise<void>;
  updateInstall(): void;

  /** ─── สั่งจัดการอีมูเลเตอร์ (สร้าง/เปิด/ปิด/ลบเครื่อง Nox ฯลฯ) ─── */
  emuState(): Promise<EmulatorManagerState>;
  emuCreate(brand: EmulatorBrandId, spec: CreateEmulatorSpec): Promise<EmulatorOpResult>;
  emuLaunch(brand: EmulatorBrandId, id: string): Promise<EmulatorOpResult>;
  emuQuit(brand: EmulatorBrandId, id: string): Promise<EmulatorOpResult>;
  emuReboot(brand: EmulatorBrandId, id: string): Promise<EmulatorOpResult>;
  emuRemove(brand: EmulatorBrandId, id: string): Promise<EmulatorOpResult>;
  onEmuChanged(cb: (state: EmulatorManagerState) => void): () => void;

  /** ─── โหมดจอยเกม ─── */
  gamepadState(): Promise<GamepadStateView>;
  gamepadStart(): Promise<GamepadStateView>;
  gamepadStop(): Promise<GamepadStateView>;
  gamepadSetKey(button: string, vk: number): Promise<GamepadStateView>;
  gamepadResetKeys(): Promise<GamepadStateView>;

  /** ─── หน้าต่าง (เราวาดแถบหัวเอง เลยต้องสั่งเอง) ─── */
  windowMinimize(): void;
  windowToggleMaximize(): void;
  windowClose(): void;
  windowSetAlwaysOnTop(on: boolean): Promise<boolean>;

  /** ─── เหตุการณ์จาก main ─── */
  onDevicesChanged(cb: (devices: DeviceInfo[]) => void): () => void;
  onAdbStatus(cb: (status: AdbStatus) => void): () => void;
  onLog(cb: (entry: LogEntry) => void): () => void;
  onWindowStateChanged(cb: (state: { maximized: boolean }) => void): () => void;
  onDiscoveryChanged(cb: (state: DiscoveryState) => void): () => void;
  onGamepadChanged(cb: (state: GamepadStateView) => void): () => void;
  onUpdateChanged(cb: (state: UpdateStateView) => void): () => void;
  onMirrorHeader(cb: (header: MirrorHeader) => void): () => void;
  onMirrorPacket(cb: (packet: MirrorPacket) => void): () => void;
  onMirrorClosed(cb: (info: { serial: string; reason: string }) => void): () => void;
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  at: number;
}

/** ชื่อช่อง IPC — รวมไว้ที่เดียวกันสองฝั่งจะได้ไม่พิมพ์ผิดคนละแบบ */
export const IPC = {
  adbStatus: 'adb:status',
  adbRestart: 'adb:restart',
  listDevices: 'devices:list',
  refreshDevice: 'device:refresh',
  runShell: 'device:shell',
  wirelessConnect: 'wireless:connect',
  wirelessDisconnect: 'wireless:disconnect',
  wirelessPair: 'wireless:pair',
  discoveryState: 'discovery:state',
  discoverySweep: 'discovery:sweep',
  discoveryCancelSweep: 'discovery:cancel-sweep',
  discoveryConnect: 'discovery:connect',
  discoveryPair: 'discovery:pair',
  wirelessViaUsb: 'wireless:via-usb',
  logPath: 'log:path',
  logOpen: 'log:open',
  logTail: 'log:tail',
  knownDevices: 'known:list',
  forgetDevice: 'known:forget',
  setAutoConnect: 'known:auto-connect',

  updateState: 'update:state',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',

  emuState: 'emu:state',
  emuCreate: 'emu:create',
  emuLaunch: 'emu:launch',
  emuQuit: 'emu:quit',
  emuReboot: 'emu:reboot',
  emuRemove: 'emu:remove',
  evtEmuChanged: 'evt:emu-changed',

  gamepadState: 'gamepad:state',
  gamepadStart: 'gamepad:start',
  gamepadStop: 'gamepad:stop',
  gamepadSetKey: 'gamepad:set-key',
  gamepadResetKeys: 'gamepad:reset-keys',

  listCameras: 'camera:list',
  mirrorStart: 'mirror:start',
  mirrorStop: 'mirror:stop',
  mirrorSessions: 'mirror:sessions',

  macroList: 'macro:list',
  macroRecordStart: 'macro:record-start',
  macroRecordStop: 'macro:record-stop',
  macroRecordingState: 'macro:recording-state',
  macroPlay: 'macro:play',
  macroStop: 'macro:stop',
  macroDelete: 'macro:delete',
  macroRename: 'macro:rename',
  macroAddFindTap: 'macro:add-find-tap',
  uiDump: 'ui:dump',
  scheduleList: 'schedule:list',
  scheduleSave: 'schedule:save',
  scheduleDelete: 'schedule:delete',
  evtMacroState: 'evt:macro-state',
  macroSave: 'macro:save',
  macroRunState: 'macro:run-state',
  profileList: 'profile:list',
  profileSave: 'profile:save',
  profileDelete: 'profile:delete',
  templateSets: 'template:sets',
  templateList: 'template:list',
  templateDelete: 'template:delete',
  screenshotPreview: 'screenshot:preview',
  templateSaveFromPreview: 'template:save-from-preview',
  templateTest: 'template:test',
  ocrTest: 'ocr:test',
  volumeGet: 'volume:get',
  volumeSet: 'volume:set',
  mirrorTouch: 'mirror:touch',
  mirrorKey: 'mirror:key',
  mirrorScreenPower: 'mirror:screen-power',

  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowAlwaysOnTop: 'window:always-on-top',

  evtDevicesChanged: 'evt:devices-changed',
  evtAdbStatus: 'evt:adb-status',
  evtLog: 'evt:log',
  evtWindowState: 'evt:window-state',
  evtDiscoveryChanged: 'evt:discovery-changed',
  evtGamepadChanged: 'evt:gamepad-changed',
  evtUpdateChanged: 'evt:update-changed',
  evtMirrorHeader: 'evt:mirror-header',
  evtMirrorPacket: 'evt:mirror-packet',
  evtMirrorClosed: 'evt:mirror-closed',
} as const;
