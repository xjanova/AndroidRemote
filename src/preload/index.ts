/**
 * สะพานเดียวที่ renderer มองเห็น main
 *
 * renderer ไม่มี node integration และ contextIsolation เปิดอยู่ — ทุกอย่าง
 * ต้องผ่านช่องที่ประกาศไว้ตรงนี้เท่านั้น ไม่มีทางลัด
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AndroidRemoteApi,
  type LogEntry,
  type MirrorHeader,
  type MirrorPacket,
  type UpdateStateView,
} from '../shared/api';
import type { MacroRunState } from '../shared/automation';
import type {
  AdbStatus,
  DeviceInfo,
  DiscoveryState,
  GamepadStateView,
  ShellResult,
} from '../shared/types';

/** ห่อ ipcRenderer.on ให้คืนฟังก์ชันถอดผู้ฟัง — กัน listener รั่วเวลา re-render */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: AndroidRemoteApi = {
  adbStatus: () => ipcRenderer.invoke(IPC.adbStatus) as Promise<AdbStatus>,
  adbRestart: () => ipcRenderer.invoke(IPC.adbRestart) as Promise<AdbStatus>,

  listDevices: () => ipcRenderer.invoke(IPC.listDevices) as Promise<DeviceInfo[]>,
  refreshDevice: (serial) => ipcRenderer.invoke(IPC.refreshDevice, serial) as Promise<DeviceInfo | null>,
  runShell: (serial, command) =>
    ipcRenderer.invoke(IPC.runShell, serial, command) as Promise<ShellResult>,

  wirelessConnect: (hostPort) => ipcRenderer.invoke(IPC.wirelessConnect, hostPort),
  wirelessDisconnect: (hostPort) => ipcRenderer.invoke(IPC.wirelessDisconnect, hostPort),
  wirelessPair: (hostPort, code) => ipcRenderer.invoke(IPC.wirelessPair, hostPort, code),

  discoveryState: () => ipcRenderer.invoke(IPC.discoveryState),
  discoverySweep: () => ipcRenderer.invoke(IPC.discoverySweep) as Promise<void>,
  discoveryCancelSweep: () => ipcRenderer.send(IPC.discoveryCancelSweep),
  discoveryConnect: (hostPort, serial) => ipcRenderer.invoke(IPC.discoveryConnect, hostPort, serial),
  discoveryPair: (hostPort, code) => ipcRenderer.invoke(IPC.discoveryPair, hostPort, code),
  wirelessViaUsb: (serial) => ipcRenderer.invoke(IPC.wirelessViaUsb, serial),
  knownDevices: () => ipcRenderer.invoke(IPC.knownDevices),
  logPath: () => ipcRenderer.invoke(IPC.logPath),
  logOpen: () => ipcRenderer.invoke(IPC.logOpen) as Promise<void>,
  logTail: () => ipcRenderer.invoke(IPC.logTail),
  forgetDevice: (serial) => ipcRenderer.invoke(IPC.forgetDevice, serial) as Promise<void>,
  setAutoConnect: (serial, on) => ipcRenderer.invoke(IPC.setAutoConnect, serial, on) as Promise<void>,

  updateState: () => ipcRenderer.invoke(IPC.updateState),
  updateCheck: () => ipcRenderer.invoke(IPC.updateCheck),
  updateDownload: () => ipcRenderer.invoke(IPC.updateDownload) as Promise<void>,
  updateInstall: () => ipcRenderer.send(IPC.updateInstall),

  gamepadState: () => ipcRenderer.invoke(IPC.gamepadState),
  gamepadStart: () => ipcRenderer.invoke(IPC.gamepadStart),
  gamepadStop: () => ipcRenderer.invoke(IPC.gamepadStop),
  gamepadSetKey: (button, vk) => ipcRenderer.invoke(IPC.gamepadSetKey, button, vk),
  gamepadResetKeys: () => ipcRenderer.invoke(IPC.gamepadResetKeys),

  listCameras: (serial) => ipcRenderer.invoke(IPC.listCameras, serial),
  startMirror: (serial, options) => ipcRenderer.invoke(IPC.mirrorStart, serial, options),
  stopMirror: (serial) => ipcRenderer.invoke(IPC.mirrorStop, serial) as Promise<void>,
  activeSessions: () => ipcRenderer.invoke(IPC.mirrorSessions) as Promise<string[]>,
  sendTouch: (input) => ipcRenderer.send(IPC.mirrorTouch, input),
  sendKey: (serial, action, keycode) => ipcRenderer.send(IPC.mirrorKey, serial, action, keycode),
  sendScreenPower: (serial, on) => ipcRenderer.send(IPC.mirrorScreenPower, serial, on),

  macroList: () => ipcRenderer.invoke(IPC.macroList),
  macroRecordStart: (serial, name) => ipcRenderer.invoke(IPC.macroRecordStart, serial, name) as Promise<void>,
  macroRecordStop: () => ipcRenderer.invoke(IPC.macroRecordStop),
  macroRecordingState: () => ipcRenderer.invoke(IPC.macroRecordingState),
  macroPlay: (macroId, serials, loops) => ipcRenderer.invoke(IPC.macroPlay, macroId, serials, loops),
  macroStop: () => ipcRenderer.invoke(IPC.macroStop) as Promise<void>,
  macroDelete: (macroId) => ipcRenderer.invoke(IPC.macroDelete, macroId) as Promise<void>,
  macroRename: (macroId, name) => ipcRenderer.invoke(IPC.macroRename, macroId, name) as Promise<void>,
  macroAddFindTap: (macroId, selector) => ipcRenderer.invoke(IPC.macroAddFindTap, macroId, selector) as Promise<void>,
  uiDump: (serial) => ipcRenderer.invoke(IPC.uiDump, serial),
  scheduleList: () => ipcRenderer.invoke(IPC.scheduleList),
  scheduleSave: (entry) => ipcRenderer.invoke(IPC.scheduleSave, entry) as Promise<void>,
  scheduleDelete: (id) => ipcRenderer.invoke(IPC.scheduleDelete, id) as Promise<void>,
  onMacroState: (cb) => subscribe<MacroRunState>(IPC.evtMacroState, cb),

  windowMinimize: () => ipcRenderer.send(IPC.windowMinimize),
  windowToggleMaximize: () => ipcRenderer.send(IPC.windowToggleMaximize),
  windowClose: () => ipcRenderer.send(IPC.windowClose),
  windowSetAlwaysOnTop: (on) => ipcRenderer.invoke(IPC.windowAlwaysOnTop, on) as Promise<boolean>,

  onDevicesChanged: (cb) => subscribe<DeviceInfo[]>(IPC.evtDevicesChanged, cb),
  onAdbStatus: (cb) => subscribe<AdbStatus>(IPC.evtAdbStatus, cb),
  onLog: (cb) => subscribe<LogEntry>(IPC.evtLog, cb),
  onWindowStateChanged: (cb) => subscribe<{ maximized: boolean }>(IPC.evtWindowState, cb),
  onDiscoveryChanged: (cb) => subscribe<DiscoveryState>(IPC.evtDiscoveryChanged, cb),
  onGamepadChanged: (cb) => subscribe<GamepadStateView>(IPC.evtGamepadChanged, cb),
  onUpdateChanged: (cb) => subscribe<UpdateStateView>(IPC.evtUpdateChanged, cb),
  onMirrorHeader: (cb) => subscribe<MirrorHeader>(IPC.evtMirrorHeader, cb),
  onMirrorPacket: (cb) => subscribe<MirrorPacket>(IPC.evtMirrorPacket, cb),
  onMirrorClosed: (cb) => subscribe<{ serial: string; reason: string }>(IPC.evtMirrorClosed, cb),
};

contextBridge.exposeInMainWorld('androidRemote', api);
