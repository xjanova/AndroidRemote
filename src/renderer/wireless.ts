/**
 * หน้าต่างค้นหาและจับคู่อุปกรณ์บน Wi-Fi
 *
 * แยกออกมาจาก main.ts เพราะมีสถานะของตัวเองที่อัปเดตทุกไม่กี่วินาที
 * (mDNS ได้ยินซ้ำเรื่อยๆ) และไม่ควรลาก renderAll() ของหน้าหลักมาวาดใหม่ทั้งจอ
 */

import type { AndroidRemoteApi, KnownDeviceView } from '../shared/api';
import type { DiscoveredDevice, DiscoveryState } from '../shared/types';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

const KIND_CHIP: Record<DiscoveredDevice['kind'], { cls: string; label: string }> = {
  pairing: { cls: 'chip--pairing', label: 'กำลังจับคู่' },
  connect: { cls: 'chip--ready', label: 'พร้อมต่อ' },
  legacy: { cls: 'chip--legacy', label: 'พอร์ตเก่า' },
};

const SOURCE_LABEL: Record<string, string> = {
  mdns: 'mDNS',
  'adb-mdns': 'adb',
  scan: 'กวาดพอร์ต',
};

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function openWirelessDialog(api: AndroidRemoteApi, log: Log): void {
  const root = document.getElementById('modal-root');
  if (!root || root.childElementCount > 0) return;

  let state: DiscoveryState = { running: false, sweeping: false, sweepDone: 0, sweepTotal: 0, devices: [] };
  let knownList: KnownDeviceView[] = [];
  /**
   * รหัสจับคู่ที่ผู้ใช้พิมพ์ค้างไว้ เก็บนอก DOM
   * เพราะรายการถูกวาดใหม่ทุกครั้งที่ mDNS ได้ยินซ้ำ ถ้าไม่เก็บไว้จะพิมพ์ไม่ทัน
   */
  const codeDrafts = new Map<string, string>();
  let manualDraft = '';
  let busyKey: string | null = null;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  root.appendChild(backdrop);

  const unsubscribe = api.onDiscoveryChanged((s) => {
    state = s;
    render();
  });

  function close(): void {
    unsubscribe();
    document.removeEventListener('keydown', onKeyDown);
    backdrop.remove();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKeyDown);

  // ─────────────────────────── การกระทำ ───────────────────────────

  async function doConnect(device: DiscoveredDevice): Promise<void> {
    busyKey = device.key;
    render();
    const res = await api.discoveryConnect(`${device.address}:${device.port}`, device.serial);
    log(res.ok ? 'info' : 'warn', res.message);
    busyKey = null;
    await refreshKnown();
    render();
  }

  async function doPair(device: DiscoveredDevice): Promise<void> {
    const code = (codeDrafts.get(device.key) ?? '').replace(/\D/g, '');
    if (code.length !== 6) {
      log('warn', 'รหัสจับคู่ต้องเป็นตัวเลข 6 หลัก');
      return;
    }
    busyKey = device.key;
    render();
    const res = await api.discoveryPair(`${device.address}:${device.port}`, code);
    log(res.ok ? 'info' : 'warn', res.message);
    if (res.ok) codeDrafts.delete(device.key);
    busyKey = null;
    await refreshKnown();
    render();
  }

  async function doManualConnect(): Promise<void> {
    const value = manualDraft.trim();
    if (!value) return;
    // ไม่ใส่พอร์ตมา ให้เดา 5555 ซึ่งเป็นค่าที่ `adb tcpip` ใช้เสมอ
    const hostPort = /:\d+$/.test(value) ? value : `${value}:5555`;
    busyKey = 'manual';
    render();
    const res = await api.discoveryConnect(hostPort, null);
    log(res.ok ? 'info' : 'warn', res.message);
    if (res.ok) manualDraft = '';
    busyKey = null;
    await refreshKnown();
    render();
  }

  async function refreshKnown(): Promise<void> {
    knownList = await api.knownDevices();
  }

  // ─────────────────────────── การวาด ───────────────────────────

  function foundRow(device: DiscoveredDevice): string {
    const chip = KIND_CHIP[device.kind];
    const title = device.name ?? device.serial ?? device.address;
    const busy = busyKey === device.key;

    const sources = device.sources
      .map((s) => `<span class="chip chip--source">${esc(SOURCE_LABEL[s] ?? s)}</span>`)
      .join('');

    let action: string;
    if (device.connected) {
      action = `<span class="chip chip--ready">ต่ออยู่</span>`;
    } else if (device.kind === 'pairing') {
      action = `
        <input class="code-input" data-code="${esc(device.key)}" maxlength="6" inputmode="numeric"
               placeholder="รหัส 6 หลัก" value="${esc(codeDrafts.get(device.key) ?? '')}" />
        <button class="xpbtn" data-pair="${esc(device.key)}"${busy ? ' disabled' : ''}>${busy ? 'กำลังจับคู่…' : 'จับคู่'}</button>`;
    } else {
      action = `<button class="xpbtn" data-connect="${esc(device.key)}"${busy ? ' disabled' : ''}>${busy ? 'กำลังต่อ…' : 'ต่อ'}</button>`;
    }

    return `
      <div class="found__row">
        <div class="dot" style="background:${device.connected ? '#3f9c4a' : device.kind === 'pairing' ? '#d4a017' : '#8b8c9e'}"></div>
        <div class="found__text">
          <div class="found__name">${esc(title)}</div>
          <div class="found__sub">${esc(device.address)}:${device.port}</div>
        </div>
        <div style="display:flex;align-items:center;gap:4px">
          <span class="chip ${chip.cls}">${esc(chip.label)}</span>
          ${device.known ? `<span class="chip chip--known">จำไว้แล้ว</span>` : ''}
          ${sources}
        </div>
        <div style="display:flex;align-items:center;gap:5px">${action}</div>
      </div>`;
  }

  function knownRow(entry: KnownDeviceView): string {
    const where = entry.lastAddress ? `${entry.lastAddress}:${entry.lastPort ?? 5555}` : 'ยังไม่เคยเห็นที่อยู่';
    return `
      <div class="found__row">
        <div class="found__text">
          <div class="found__name">${esc(entry.name ?? entry.serial)}</div>
          <div class="found__sub">${esc(entry.serial)} · ${esc(where)}</div>
        </div>
        <div class="switch" data-auto="${esc(entry.serial)}" title="เจอบนวงแล้วต่อให้เลย">
          <div class="switch__box">
            ${
              entry.autoConnect
                ? `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#1f6b2c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.6 5.2 3.9 7.6 8.4 2.6"></path></svg>`
                : ''
            }
          </div>
          <span>ต่ออัตโนมัติ</span>
        </div>
        <button class="xpbtn" data-forget="${esc(entry.serial)}">ลืม</button>
      </div>`;
  }

  function render(): void {
    // จำตำแหน่งเคอร์เซอร์ไว้ก่อนวาดใหม่ ไม่งั้นพิมพ์รหัสไม่ได้เลยเพราะโฟกัสหลุดทุก 3 วินาที
    const active = document.activeElement as HTMLInputElement | null;
    const focusedCode = active?.dataset?.code ?? null;
    const focusedManual = active?.id === 'manual-input';
    const selStart = active?.selectionStart ?? null;

    const devices = state.devices;
    const pct = state.sweepTotal > 0 ? Math.round((state.sweepDone / state.sweepTotal) * 100) : 0;

    backdrop.innerHTML = `
      <div class="modal metal-tall" role="dialog">
        <div class="titlebar metal" style="-webkit-app-region:no-drag">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#2f4a6d" stroke-width="1.3" stroke-linecap="round">
            <path d="M2.2 6.4a8.4 8.4 0 0 1 11.6 0"></path><path d="M4.6 9a5 5 0 0 1 6.8 0"></path>
            <circle cx="8" cy="12" r="1.3" fill="#2f4a6d" stroke="none"></circle>
          </svg>
          <div class="titlebar__text">ค้นหาอุปกรณ์บน Wi-Fi</div>
          <div class="titlebar__buttons">
            <div class="capbtn capbtn--close" id="wl-close" title="ปิด">
              <svg width="9" height="9" viewBox="0 0 10 10" stroke="#fff" stroke-width="1.9" stroke-linecap="round">
                <line x1="1.6" y1="1.6" x2="8.4" y2="8.4"></line><line x1="8.4" y1="1.6" x2="1.6" y2="8.4"></line>
              </svg>
            </div>
          </div>
        </div>

        <div class="modal__body">
          <div class="gbox">
            <div class="gbox__title">เจอบนวงนี้ (${devices.length})</div>
            <div class="found sunken">
              ${
                devices.length === 0
                  ? `<div class="found__empty">
                       ยังไม่เจออะไร<br />
                       <span style="font-size:10px">บนมือถือเปิด ตัวเลือกสำหรับนักพัฒนา → การแก้จุดบกพร่องแบบไร้สาย<br />
                       เครื่องที่สั่ง <b>adb tcpip 5555</b> เองต้องกด “กวาดทั้งวง” ถึงจะเจอ</span>
                     </div>`
                  : devices.map(foundRow).join('')
              }
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:9px">
              ${
                state.sweeping
                  ? `<button class="xpbtn" id="wl-cancel-sweep">หยุดกวาด</button>
                     <div class="progress sunken" style="flex:1"><div class="progress__fill" style="width:${pct}%"></div></div>
                     <span style="color:var(--ink-dim);white-space:nowrap">${state.sweepDone}/${state.sweepTotal}</span>`
                  : `<button class="xpbtn" id="wl-sweep">กวาดทั้งวง</button>
                     <span style="flex:1;color:var(--ink-dim);font-size:10px">หาเครื่องที่เปิดพอร์ต 5555 ไว้เอง — ใช้เวลาสักครู่</span>`
              }
            </div>
          </div>

          <div class="gbox">
            <div class="gbox__title">ใส่ที่อยู่เอง</div>
            <div style="display:flex;gap:7px;align-items:center">
              <input class="text-input" id="manual-input" style="flex:1"
                     placeholder="192.168.1.42:5555" value="${esc(manualDraft)}" />
              <button class="xpbtn" id="wl-manual"${busyKey === 'manual' ? ' disabled' : ''}>ต่อ</button>
            </div>
          </div>

          <div class="gbox">
            <div class="gbox__title">เครื่องที่จำไว้ (${knownList.length})</div>
            <div class="found sunken">
              ${
                knownList.length === 0
                  ? `<div class="found__empty">ยังไม่มี — จับคู่หรือต่อสำเร็จครั้งแรกแล้วจะจำให้เอง</div>`
                  : knownList.map(knownRow).join('')
              }
            </div>
          </div>
        </div>

        <div class="modal__foot">
          <div style="flex:1;display:flex;align-items:center;gap:6px;color:var(--ink-dim)">
            <div class="dot" style="background:${state.running ? '#3f9c4a' : '#8b8c9e'}"></div>
            ${state.running ? 'กำลังฟังอยู่' : 'ยังไม่ได้เริ่มค้นหา'}
          </div>
          <button class="gel" id="wl-done">เสร็จสิ้น</button>
        </div>
      </div>`;

    wireEvents();

    // คืนโฟกัสให้ช่องที่ผู้ใช้กำลังพิมพ์อยู่
    if (focusedCode) {
      const node = backdrop.querySelector<HTMLInputElement>(`[data-code="${CSS.escape(focusedCode)}"]`);
      node?.focus();
      if (node && selStart !== null) node.setSelectionRange(selStart, selStart);
    } else if (focusedManual) {
      const node = backdrop.querySelector<HTMLInputElement>('#manual-input');
      node?.focus();
      if (node && selStart !== null) node.setSelectionRange(selStart, selStart);
    }
  }

  function wireEvents(): void {
    backdrop.querySelector('#wl-close')?.addEventListener('click', close);
    backdrop.querySelector('#wl-done')?.addEventListener('click', close);
    backdrop.querySelector('#wl-sweep')?.addEventListener('click', () => void api.discoverySweep());
    backdrop.querySelector('#wl-cancel-sweep')?.addEventListener('click', () => api.discoveryCancelSweep());

    const manual = backdrop.querySelector<HTMLInputElement>('#manual-input');
    manual?.addEventListener('input', () => {
      manualDraft = manual.value;
    });
    manual?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void doManualConnect();
    });
    backdrop.querySelector('#wl-manual')?.addEventListener('click', () => void doManualConnect());

    backdrop.querySelectorAll<HTMLInputElement>('[data-code]').forEach((input) => {
      input.addEventListener('input', () => {
        // ยอมรับเฉพาะตัวเลข — ผู้ใช้พิมพ์ขีดหรือช่องว่างมาจะได้ไม่พังตอนส่ง
        input.value = input.value.replace(/\D/g, '').slice(0, 6);
        codeDrafts.set(input.dataset.code!, input.value);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const device = state.devices.find((d) => d.key === input.dataset.code);
        if (device) void doPair(device);
      });
    });

    backdrop.querySelectorAll<HTMLElement>('[data-pair]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const device = state.devices.find((d) => d.key === btn.dataset.pair);
        if (device) void doPair(device);
      });
    });

    backdrop.querySelectorAll<HTMLElement>('[data-connect]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const device = state.devices.find((d) => d.key === btn.dataset.connect);
        if (device) void doConnect(device);
      });
    });

    backdrop.querySelectorAll<HTMLElement>('[data-auto]').forEach((node) => {
      node.addEventListener('click', async () => {
        const serial = node.dataset.auto!;
        const entry = knownList.find((k) => k.serial === serial);
        if (!entry) return;
        await api.setAutoConnect(serial, !entry.autoConnect);
        await refreshKnown();
        render();
      });
    });

    backdrop.querySelectorAll<HTMLElement>('[data-forget]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api.forgetDevice(btn.dataset.forget!);
        await refreshKnown();
        render();
      });
    });
  }

  // เปิดมาแล้ววาดทันทีด้วยสถานะล่าสุด ไม่ต้องรอเหตุการณ์รอบถัดไป
  void (async () => {
    [state, knownList] = await Promise.all([api.discoveryState(), api.knownDevices()]);
    render();
  })();

  render();
}
