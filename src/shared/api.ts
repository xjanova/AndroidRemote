/**
 * สัญญาระหว่าง renderer กับ main
 * preload เอา interface นี้ไปวางบน window.androidRemote ผ่าน contextBridge
 */

import type { AdbStatus, DeviceInfo, DiscoveryState, GamepadStateView, ShellResult } from './types';

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
  streamId: number;
  config: boolean;
  keyFrame: boolean;
  /** ไมโครวินาที */
  ptsUs: number;
  data: Uint8Array;
}

export interface TouchInput {
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
  knownDevices(): Promise<KnownDeviceView[]>;
  forgetDevice(serial: string): Promise<void>;
  setAutoConnect(serial: string, on: boolean): Promise<void>;

  /** ─── มิเรอร์ / กล้อง ─── */
  listCameras(serial: string): Promise<CameraListView>;
  startMirror(serial: string, options?: MirrorOptions): Promise<WirelessResult>;
  stopMirror(): Promise<void>;
  sendTouch(input: TouchInput): void;
  sendKey(action: number, keycode: number): void;
  sendScreenPower(on: boolean): void;

  /** ─── อัปเดตตัวแอป ─── */
  updateState(): Promise<UpdateStateView>;
  updateCheck(): Promise<UpdateStateView>;
  updateDownload(): Promise<void>;
  updateInstall(): void;

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
  onMirrorClosed(cb: (reason: string) => void): () => void;
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
  knownDevices: 'known:list',
  forgetDevice: 'known:forget',
  setAutoConnect: 'known:auto-connect',

  updateState: 'update:state',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',

  gamepadState: 'gamepad:state',
  gamepadStart: 'gamepad:start',
  gamepadStop: 'gamepad:stop',
  gamepadSetKey: 'gamepad:set-key',
  gamepadResetKeys: 'gamepad:reset-keys',

  listCameras: 'camera:list',
  mirrorStart: 'mirror:start',
  mirrorStop: 'mirror:stop',
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
