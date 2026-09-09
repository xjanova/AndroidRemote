/**
 * ตรรกะฝั่งหน้าจอ — ไม่ใช้เฟรมเวิร์ก
 *
 * เหตุผล: ตัวแอปนี้จะต้องรับเฟรมวิดีโอ 60–120 fps เข้ามาวาดในอีกสไลซ์ถัดไป
 * การมี virtual DOM คั่นกลางมีแต่เสีย ส่วนหน้าตาที่เหลือเปลี่ยนไม่ถี่พอ
 * จะคุ้มกับ runtime ของเฟรมเวิร์ก
 */

import { CAPABILITIES, type CapabilityId, type DeviceInfo, type PrivilegeTier } from '../shared/types';
import type { AndroidRemoteApi, LogEntry, MirrorHeader, UpdateStateView } from '../shared/api';
import type { AdbStatus } from '../shared/types';
import { VideoSink } from './video';
import { openWirelessDialog } from './wireless';
import { openCameraDialog } from './cameras';
import { openGamepadDialog } from './gamepad';

declare global {
  interface Window {
    androidRemote: AndroidRemoteApi;
  }
}

const api = window.androidRemote;

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`ไม่พบอิลิเมนต์ #${id}`);
  return node as T;
};

/** สร้าง element จาก HTML string — เนื้อหาทั้งหมดมาจากเราเอง ไม่มีอินพุตผู้ใช้ */
function html(markup: string): string {
  return markup;
}

/** หนีอักขระก่อนเอาค่าจากเครื่องปลายทางไปวางใน HTML — ชื่อรุ่นมาจากเครื่องผู้ใช้ */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────── สถานะฝั่งหน้าจอ ───────────────────────────────

let devices: DeviceInfo[] = [];
let selectedSerial: string | null = null;
let adbStatus: AdbStatus = { ok: false };
let pinned = false;

/** ─── สถานะมิเรอร์ / กล้อง ─── */
interface StreamView {
  header: MirrorHeader;
  canvas: HTMLCanvasElement;
  sink: VideoSink;
  stats: { fps: number; kbps: number };
}

/**
 * หนึ่งรายการต่อหนึ่งสตรีม — โหมดกล้องเปิดได้หลายตัวพร้อมกัน
 *
 * 🔑 แคนวาสสร้างครั้งเดียวแล้ว "ย้ายที่" เอา ห้ามให้ renderStage() วาดใหม่
 *    เพราะ innerHTML จะฆ่า element เดิมทิ้ง แล้ว VideoSink จะวาดลงแคนวาสผี
 *    ที่ไม่ได้อยู่ในหน้าจอแล้ว — อาการคือภาพดำสนิททั้งที่ fps ขึ้นปกติ
 */
const streams = new Map<number, StreamView>();
let mirrorMode: 'screen' | 'camera' = 'screen';
let mirrorStarting = false;

function isMirroring(): boolean {
  return streams.size > 0;
}

/** สตรีมที่รับการสัมผัสได้ — มีเฉพาะโหมดมิเรอร์จอเท่านั้น */
function touchableStream(): StreamView | null {
  return mirrorMode === 'screen' ? (streams.get(0) ?? null) : null;
}

function createStreamView(header: MirrorHeader): StreamView {
  const canvas = document.createElement('canvas');
  canvas.dataset.stream = String(header.streamId);
  canvas.style.cssText =
    'max-width:100%;max-height:100%;object-fit:contain;border:1px solid #0b0d12;' +
    'box-shadow:0 0 0 1px rgba(255,255,255,.09),0 8px 22px rgba(0,0,0,.55);' +
    'image-rendering:auto;touch-action:none;background:#000;' +
    (mirrorMode === 'screen' ? 'cursor:crosshair' : 'cursor:default');

  const view: StreamView = {
    header,
    canvas,
    stats: { fps: 0, kbps: 0 },
    sink: new VideoSink(canvas, {
      onFirstFrame: () => localLog('info', `${header.deviceName}: ได้เฟรมแรกแล้ว`),
      onError: (m) => localLog('error', `${header.deviceName}: ${m}`),
      onStats: (s) => {
        view.stats = s;
        updateStreamStats(header.streamId);
      },
    }),
  };

  if (mirrorMode === 'screen') wireCanvasTouch(canvas);
  return view;
}

const TIER_LABEL: Record<PrivilegeTier, string> = {
  none: 'ยังใช้ไม่ได้',
  shell: 'shell (uid 2000)',
  shizuku: 'Shizuku',
  root: 'root (uid 0)',
};

const STATE_LABEL: Record<string, string> = {
  device: 'พร้อมใช้งาน',
  unauthorized: 'รออนุญาต',
  offline: 'ออฟไลน์',
  authorizing: 'กำลังยืนยันสิทธิ์',
  connecting: 'กำลังเชื่อมต่อ',
  bootloader: 'อยู่ใน bootloader',
  recovery: 'อยู่ใน recovery',
  sideload: 'โหมด sideload',
  rescue: 'โหมด rescue',
  'no permissions': 'ไดรเวอร์ USB ไม่ให้สิทธิ์',
  unknown: 'ไม่ทราบสถานะ',
};

const TRANSPORT_LABEL: Record<string, string> = {
  usb: 'USB',
  tcp: 'ไร้สาย',
  emulator: 'อีมูเลเตอร์',
  unknown: '—',
};

function selected(): DeviceInfo | null {
  return devices.find((d) => d.serial === selectedSerial) ?? null;
}

function stateDot(state: string): string {
  if (state === 'device') return '#3f9c4a';
  if (state === 'unauthorized' || state === 'authorizing' || state === 'connecting') return '#d4a017';
  return '#8b8c9e';
}

// ─────────────────────────────── การวาด ───────────────────────────────

function renderDeviceList(): void {
  const box = el('devlist');

  if (devices.length === 0) {
    box.innerHTML = html(`
      <div class="devlist__empty">
        ยังไม่พบอุปกรณ์<br />
        <span style="font-size:10px">เสียบสาย USB หรือกดปุ่ม “ไร้สาย”</span>
      </div>
    `);
    return;
  }

  box.innerHTML = devices
    .map((d) => {
      const name = d.model ?? d.serial;
      const sub = `${TRANSPORT_LABEL[d.transport] ?? d.transport} · ${STATE_LABEL[d.state] ?? d.state}`;
      return html(`
        <div class="row${d.serial === selectedSerial ? ' is-selected' : ''}" data-serial="${esc(d.serial)}">
          <div class="row__icon">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#3b5573" stroke-width="1.3">
              <rect x="4.6" y="1.6" width="6.8" height="12.8" rx="1.5" fill="#e6edf7"></rect>
              <line x1="6.7" y1="12.4" x2="9.3" y2="12.4" stroke-linecap="round"></line>
            </svg>
          </div>
          <div class="row__text">
            <div class="row__name">${esc(name)}</div>
            <div class="row__sub">${esc(sub)}</div>
          </div>
          <div class="dot" style="background:${stateDot(d.state)};box-shadow:inset 0 1px 0 rgba(255,255,255,.6),0 0 4px ${stateDot(d.state)}"></div>
        </div>
      `);
    })
    .join('');

  box.querySelectorAll<HTMLElement>('.row').forEach((row) => {
    row.addEventListener('click', () => {
      selectedSerial = row.dataset.serial ?? null;
      renderAll();
    });
  });
}

function renderDeviceDetail(): void {
  const box = el('device-detail');
  const d = selected();

  if (!d) {
    box.innerHTML = '';
    return;
  }

  const rows: Array<[string, string]> = [];
  if (d.model) rows.push(['รุ่น', d.model]);
  if (d.manufacturer) rows.push(['ผู้ผลิต', d.manufacturer]);
  if (d.androidRelease) rows.push(['แอนดรอยด์', `${d.androidRelease}${d.sdk ? ` (API ${d.sdk})` : ''}`]);
  if (d.romName) rows.push(['ROM', d.romName]);
  if (d.screenWidth && d.screenHeight) {
    rows.push(['ความละเอียด', `${d.screenWidth} × ${d.screenHeight}${d.screenDensity ? ` · ${d.screenDensity} dpi` : ''}`]);
  }
  if (d.abi) rows.push(['สถาปัตยกรรม', d.abi]);
  if (d.batteryLevel !== undefined) {
    rows.push(['แบตเตอรี่', `${d.batteryLevel}%${d.batteryCharging ? ' กำลังชาร์จ' : ''}`]);
  }
  rows.push(['Serial', d.serial]);

  const tierClass = `tier--${d.tier}`;

  box.innerHTML = html(`
    <div class="gbox" style="margin-top:13px">
      <div class="gbox__title">รายละเอียด</div>
      <div style="margin-bottom:9px">
        <span class="tier ${tierClass}">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
            <path d="M8 1.9 13.6 4v4.2c0 3-2.3 5.2-5.6 6-3.3-.8-5.6-3-5.6-6V4z"></path>
          </svg>
          ${esc(TIER_LABEL[d.tier])}
        </span>
      </div>
      <div class="kv">
        ${rows
          .map(
            ([k, v]) =>
              `<div class="kv__row"><span class="kv__k">${esc(k)}</span><span class="kv__v" title="${esc(v)}">${esc(v)}</span></div>`,
          )
          .join('')}
      </div>
      ${
        d.transport === 'usb' && d.state === 'device'
          ? `<button class="xpbtn" id="detail-wifi" style="width:100%;margin-top:10px;justify-content:center" title="สั่ง adb tcpip แล้วต่อผ่าน Wi-Fi ให้เอง ไม่ต้องจับคู่ ไม่ต้องพึ่ง mDNS">เปิดไร้สายผ่านสายนี้ แล้วถอดสายได้</button>`
          : ''
      }
      ${
        d.probeError
          ? `<div style="margin-top:9px;color:#a5301f;line-height:1.5">ตรวจไม่สำเร็จ: ${esc(d.probeError)}</div>`
          : ''
      }
    </div>
  `);
  document.getElementById('detail-wifi')?.addEventListener('click', () => void wirelessViaUsb());
}

/**
 * ทางที่ไม่พึ่ง mDNS: เสียบสายครั้งเดียว ให้แอปสั่ง tcpip + อ่าน IP + ต่อ + จำเครื่อง
 * หลังจากนี้ถอดสายได้ และครั้งหน้าเจอบนวงเมื่อไหร่ต่อให้เอง
 */
async function wirelessViaUsb(): Promise<void> {
  const d = selected();
  if (!d) return;
  const btn = document.getElementById('detail-wifi') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'กำลังเปิด… (สายจะหลุดชั่วครู่ ปกติ)';
  }
  localLog('info', `กำลังเปิดไร้สายผ่านสาย USB ของ ${d.model ?? d.serial}`);
  const res = await api.wirelessViaUsb(d.serial);
  localLog(res.ok ? 'info' : 'warn', res.message);
  renderAll();
}

function renderCapabilities(): void {
  const box = el('caps');
  const d = selected();

  if (!d) {
    box.innerHTML = html(`<div style="color:var(--ink-dim);padding:4px 2px;line-height:1.6">เลือกเครื่องก่อน<br />แล้วจะแสดงว่าทำอะไรได้บ้าง</div>`);
    return;
  }

  const have = new Set<CapabilityId>(d.capabilities);

  box.innerHTML = CAPABILITIES.map((c) => {
    const on = have.has(c.id);
    const needsMore = !on && c.requires !== 'shell';
    return html(`
      <div class="cap${on ? '' : ' is-off'}" title="${esc(c.note)}">
        <span class="cap__mark">
          ${
            on
              ? `<svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="#1f6b2c" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M1.6 5.2 3.9 7.6 8.4 2.6"></path></svg>`
              : `<svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="#a8a9b8" stroke-width="1.7" stroke-linecap="round"><line x1="2" y1="5" x2="8" y2="5"></line></svg>`
          }
        </span>
        <span class="cap__label">${esc(c.label)}</span>
        ${needsMore ? `<span class="cap__need">ต้อง ${esc(c.requires)}</span>` : ''}
      </div>
    `);
  }).join('');
}

/**
 * เวทีกลาง — ที่นี่คือที่ที่ผู้ใช้จะมองเวลาอะไรไม่เวิร์ก
 * เลยต้องตอบให้ครบว่า "ตอนนี้เป็นอะไร" และ "ต้องทำอะไรต่อ" ไม่ใช่แค่ขึ้นว่าว่างเปล่า
 */
function renderStage(): void {
  const box = el('stage');

  // มิเรอร์/กล้องอยู่ → วาดโครงแล้วย้ายแคนวาสตัวเดิมเข้าไป ไม่สร้างใหม่
  if (isMirroring()) {
    const ordered = [...streams.values()].sort((a, b) => a.header.streamId - b.header.streamId);
    // กล้องหลายตัวจัดเป็นตาราง — ตัวเดียวกินเต็มพื้นที่
    const cols = ordered.length <= 1 ? 1 : ordered.length <= 4 ? 2 : 3;

    box.innerHTML = html(`
      <div id="video-wrap" style="flex:1;min-height:0;width:100%;display:grid;gap:10px;
           grid-template-columns:repeat(${cols}, minmax(0, 1fr));align-items:center;justify-items:center"></div>
      <div style="display:flex;align-items:center;gap:6px">
        ${
          mirrorMode === 'screen'
            ? `<div class="navb" id="nav-back" title="ย้อนกลับ">
                 <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#33506f" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.2 3.2 5.4 8l4.8 4.8"></path></svg>
               </div>
               <div class="navb" id="nav-home" title="หน้าหลัก">
                 <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#33506f" stroke-width="1.5"><circle cx="8" cy="8" r="4.6"></circle></svg>
               </div>
               <div class="navb" id="nav-recents" title="แอปล่าสุด">
                 <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#33506f" stroke-width="1.5"><rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.2"></rect></svg>
               </div>
               <div class="tsep" style="height:18px;align-self:center"></div>
               <div class="navb" id="nav-screen-off" title="ปิดจอมือถือ (ยังคุมได้)">
                 <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#33506f" stroke-width="1.4" stroke-linecap="round"><rect x="4.6" y="1.8" width="6.8" height="12.4" rx="1.5"></rect><path d="M2.2 2.2 13.8 13.8" stroke="#a04a38"></path></svg>
               </div>`
            : ''
        }
        <div class="navb" style="width:auto;padding:0 10px" id="nav-stop">หยุด</div>
        <div id="mirror-stats" style="margin-left:6px;color:#8b95a8;font-size:11px"></div>
      </div>
    `);

    const wrap = el('video-wrap');
    for (const view of ordered) {
      const cell = document.createElement('div');
      cell.style.cssText =
        'display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0;min-height:0;max-height:100%';
      cell.appendChild(view.canvas);
      if (ordered.length > 1) {
        const label = document.createElement('div');
        label.style.cssText = 'font:11px Tahoma;color:#8b95a8';
        label.textContent = view.header.deviceName;
        cell.appendChild(label);
      }
      wrap.appendChild(cell);
    }
    updateStreamStats();

    if (mirrorMode === 'screen') {
      el('nav-back').addEventListener('click', () => tapKey(4));
      el('nav-home').addEventListener('click', () => tapKey(3));
      el('nav-recents').addEventListener('click', () => tapKey(187));
      el('nav-screen-off').addEventListener('click', () => api.sendScreenPower(false));
    }
    el('nav-stop').addEventListener('click', () => void stopMirror());
    return;
  }

  if (!adbStatus.ok) {
    box.innerHTML = html(`
      <svg width="40" height="40" viewBox="0 0 16 16" fill="none" stroke="#6b5560" stroke-width="1.1" stroke-linecap="round">
        <path d="M8 1.9 15 14H1z" stroke="#a04a38"></path>
        <line x1="8" y1="6" x2="8" y2="9.6"></line><circle cx="8" cy="11.6" r=".8" fill="#a04a38" stroke="none"></circle>
      </svg>
      <div class="stage__title">ใช้ adb ไม่ได้</div>
      <div class="stage__hint">${esc(adbStatus.error ?? 'ไม่ทราบสาเหตุ')}</div>
      <button class="xpbtn" id="stage-restart-adb">ลองรีสตาร์ท adb</button>
    `);
    el('stage-restart-adb').addEventListener('click', restartAdb);
    return;
  }

  if (devices.length === 0) {
    box.innerHTML = html(`
      <svg width="40" height="40" viewBox="0 0 16 16" fill="none" stroke="#4d5568" stroke-width="1.1" stroke-linecap="round">
        <rect x="4.6" y="1.6" width="6.8" height="12.8" rx="1.5"></rect>
        <line x1="6.7" y1="12.4" x2="9.3" y2="12.4"></line>
      </svg>
      <div class="stage__title">ยังไม่พบอุปกรณ์</div>
      <div class="stage__hint">
        ถ้าเสียบสายแล้วยังไม่ขึ้น แปลว่ามือถือยังไม่ได้เปิดโหมดนักพัฒนา
      </div>
      <button class="xpbtn" id="stage-wireless">ค้นหาบน Wi-Fi แทน</button>
      <div style="max-width:420px;margin-top:2px;padding:12px 14px;border:1px solid #4a5468;border-radius:4px;background:rgba(255,255,255,.04);color:#9aa5b8;line-height:1.9">
        <div style="color:#c3ccdb;font-weight:bold;margin-bottom:6px">เปิดโหมดนักพัฒนาบนมือถือ</div>
        <div>1. ตั้งค่า → เกี่ยวกับโทรศัพท์</div>
        <div>2. กดที่ <b style="color:#c3ccdb">หมายเลขบิลด์</b> ติดกัน 7 ครั้ง</div>
        <div>3. กลับไป ตั้งค่า → ระบบ → ตัวเลือกสำหรับนักพัฒนา</div>
        <div>4. เปิด <b style="color:#c3ccdb">การแก้จุดบกพร่อง USB</b></div>
        <div>5. เสียบสาย แล้วกดอนุญาตในกล่องที่เด้งขึ้นบนมือถือ</div>
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.09);color:#8b95a8">
          Xiaomi / HyperOS ต้องเปิด <b style="color:#c3ccdb">USB debugging (Security settings)</b> เพิ่มอีกอัน ไม่งั้นจะเห็นภาพแต่กดสั่งงานไม่ได้
        </div>
      </div>
    `);
    el('stage-wireless').addEventListener('click', () => openWireless());
    return;
  }

  const d = selected();
  if (!d) {
    box.innerHTML = html(`<div class="stage__title">เลือกอุปกรณ์จากรายการทางซ้าย</div>`);
    return;
  }

  const fatal = d.blockers.filter((b) => b.severity === 'fatal');
  const limited = d.blockers.filter((b) => b.severity === 'limited');

  if (fatal.length > 0) {
    box.innerHTML = html(`
      <div style="width:100%;max-width:520px;display:flex;flex-direction:column;gap:12px">
        ${fatal.map(blockerCard).join('')}
      </div>
      <button class="xpbtn" id="stage-recheck">ตรวจใหม่</button>
    `);
    el('stage-recheck').addEventListener('click', () => void refreshSelected());
    return;
  }

  box.innerHTML = html(`
    <svg width="40" height="40" viewBox="0 0 16 16" fill="none" stroke="#5c7d5f" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2.2 8.4 6 12.2 13.8 4.2"></path>
    </svg>
    <div class="stage__title">${esc(d.model ?? d.serial)} พร้อมรับคำสั่งแล้ว</div>
    <div class="stage__hint">
      สิทธิ์ระดับ <b style="color:#a8b4c6">${esc(TIER_LABEL[d.tier])}</b> · ใช้ได้ ${d.capabilities.length} จาก ${CAPABILITIES.length} อย่าง
    </div>
    <div style="display:flex;gap:8px">
      <button class="xpbtn" id="stage-shell">ลองยิงคำสั่ง</button>
      <button class="xpbtn" id="stage-camera">ใช้กล้องเป็นเว็บแคม</button>
      <button class="gel" id="stage-mirror"${mirrorStarting ? ' disabled' : ''}>${mirrorStarting ? 'กำลังเริ่ม…' : 'เริ่มมิเรอร์'}</button>
    </div>
    ${
      VideoSink.supported
        ? ''
        : `<div class="stage__hint" style="color:#c07a6a">เบราว์เซอร์รุ่นนี้ไม่มี WebCodecs — ถอดรหัสวิดีโอไม่ได้</div>`
    }
    ${
      limited.length
        ? `<div style="width:100%;max-width:520px;display:flex;flex-direction:column;gap:10px;margin-top:4px">${limited.map(blockerCard).join('')}</div>`
        : ''
    }
  `);
  el('stage-shell').addEventListener('click', () => void trialShell());
  el('stage-mirror').addEventListener('click', () => void startMirror('screen'));
  el('stage-camera').addEventListener('click', () => openCameras());
}

/**
 * ช่องอัปเดตในแถบสถานะ — โผล่เฉพาะตอนมีอะไรให้ทำจริงๆ
 * ไม่ขึ้น "เป็นเวอร์ชันล่าสุดแล้ว" ค้างไว้ให้รก
 */
function renderUpdateCell(state: UpdateStateView): void {
  const cell = el('status-update');

  if (state.stage === 'available') {
    cell.hidden = false;
    cell.style.cursor = 'pointer';
    cell.textContent = `มีเวอร์ชัน ${state.newVersion} — กดเพื่อดาวน์โหลด`;
    cell.onclick = () => void api.updateDownload();
    return;
  }
  if (state.stage === 'downloading') {
    cell.hidden = false;
    cell.style.cursor = 'default';
    cell.textContent = `กำลังดาวน์โหลด ${state.percent ?? 0}%`;
    cell.onclick = null;
    return;
  }
  if (state.stage === 'ready') {
    cell.hidden = false;
    cell.style.cursor = 'pointer';
    cell.textContent = `พร้อมติดตั้ง ${state.newVersion} — กดเพื่อรีสตาร์ท`;
    cell.onclick = () => api.updateInstall();
    return;
  }
  cell.hidden = true;
  cell.onclick = null;
}

function updateStreamStats(_streamId?: number): void {
  const node = document.getElementById('mirror-stats');
  if (!node || streams.size === 0) return;
  const ordered = [...streams.values()].sort((a, b) => a.header.streamId - b.header.streamId);

  if (ordered.length === 1) {
    const v = ordered[0];
    node.textContent =
      `${v.header.width}×${v.header.height} · ${v.stats.fps} fps · ${v.stats.kbps} kbps` +
      (mirrorMode === 'screen' && !v.header.hasControl ? ' · คุมไม่ได้' : '');
    return;
  }
  // หลายสตรีม: รวม fps/บิตเรตให้เห็นภาระรวม ไม่งั้นบรรทัดจะยาวจนอ่านไม่ไหว
  const fps = ordered.reduce((n, v) => n + v.stats.fps, 0);
  const kbps = ordered.reduce((n, v) => n + v.stats.kbps, 0);
  node.textContent = `${ordered.length} ภาพ · รวม ${fps} fps · ${kbps} kbps`;
}

function blockerCard(b: DeviceInfo['blockers'][number]): string {
  const icon =
    b.severity === 'fatal'
      ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex:0 0 16px;margin-top:1px"><circle cx="8" cy="8" r="6.6" fill="#f0c8bf" stroke="#b76b5c" stroke-width="1.1"></circle><line x1="5.6" y1="5.6" x2="10.4" y2="10.4" stroke="#8a3423" stroke-width="1.6" stroke-linecap="round"></line><line x1="10.4" y1="5.6" x2="5.6" y2="10.4" stroke="#8a3423" stroke-width="1.6" stroke-linecap="round"></line></svg>`
      : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex:0 0 16px;margin-top:1px"><path d="M8 1.9 15 14H1z" fill="#f0c040" stroke="#a8801a" stroke-width="1.1" stroke-linejoin="round"></path><rect x="7.25" y="6" width="1.5" height="4.2" rx=".7" fill="#5a4207"></rect><circle cx="8" cy="11.9" r=".95" fill="#5a4207"></circle></svg>`;

  return html(`
    <div class="blocker${b.severity === 'fatal' ? ' blocker--fatal' : ''}">
      <div class="blocker__head">
        ${icon}
        <div>
          <div class="blocker__title">${esc(b.title)}</div>
          <div class="blocker__detail">${esc(b.detail)}</div>
        </div>
      </div>
      <ol class="blocker__steps">${b.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    </div>
  `);
}

function renderStatusBar(): void {
  const d = selected();
  const online = devices.filter((x) => x.state === 'device').length;

  const dot = el('status-dot');
  const text = el('status-text');

  if (!adbStatus.ok) {
    dot.style.background = '#b23524';
    dot.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,.6), 0 0 5px #b23524';
    text.textContent = 'adb ใช้งานไม่ได้';
  } else if (devices.length === 0) {
    dot.style.background = '#8b8c9e';
    dot.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,.6)';
    text.textContent = 'รออุปกรณ์';
  } else {
    dot.style.background = '#3f9c4a';
    dot.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,.6), 0 0 5px #3f9c4a';
    text.textContent = d ? (STATE_LABEL[d.state] ?? d.state) : 'พร้อม';
  }

  el('status-count').textContent = `${devices.length} เครื่อง (ออนไลน์ ${online})`;
  el('status-tier').textContent = d ? TIER_LABEL[d.tier] : '—';
  el('status-adb').textContent = adbStatus.ok ? `adb ${adbStatus.version ?? '?'}` : 'adb ไม่พร้อม';

  el('title-text').textContent = d ? `AndroidRemote — ${d.model ?? d.serial}` : 'AndroidRemote';

  const badge = el('adb-badge');
  badge.innerHTML = adbStatus.ok
    ? html(`<span style="font-size:11px">adb</span><span style="font-weight:bold;color:#2c6b34">พร้อม</span>`)
    : html(`<span style="font-size:11px">adb</span><span style="font-weight:bold;color:#a5301f">ไม่พร้อม</span>`);
}

function renderAll(): void {
  renderDeviceList();
  renderDeviceDetail();
  renderCapabilities();
  renderStage();
  renderStatusBar();
}

// ─────────────────────────────── บันทึกเหตุการณ์ ───────────────────────────────

const MAX_LOG_LINES = 300;

function appendLog(entry: LogEntry): void {
  const box = el('logbox');
  // ต่อท้ายเฉพาะเมื่อผู้ใช้อยู่ล่างสุดอยู่แล้ว — ไม่งั้นจะกระชากตอนกำลังอ่านย้อน
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;

  const time = new Date(entry.at).toLocaleTimeString('th-TH', { hour12: false });
  const div = document.createElement('div');
  div.className = `logline${entry.level === 'info' ? '' : ` logline--${entry.level}`}`;
  div.innerHTML = html(`<span class="logline__time">${esc(time)}</span> ${esc(entry.message)}`);
  box.appendChild(div);

  while (box.childElementCount > MAX_LOG_LINES) box.removeChild(box.firstElementChild!);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function localLog(level: LogEntry['level'], message: string): void {
  appendLog({ level, scope: 'ui', message, at: Date.now() });
}

// ─────────────────────────────── การกระทำ ───────────────────────────────

async function refreshSelected(): Promise<void> {
  const d = selected();
  if (!d) return;
  localLog('info', `กำลังตรวจ ${d.model ?? d.serial} ใหม่`);
  const updated = await api.refreshDevice(d.serial);
  if (updated) {
    devices = devices.map((x) => (x.serial === updated.serial ? updated : x));
    renderAll();
  }
}

async function restartAdb(): Promise<void> {
  localLog('info', 'กำลังรีสตาร์ท adb server');
  adbStatus = await api.adbRestart();
  devices = await api.listDevices();
  renderAll();
}

/** ยิงคำสั่งทดสอบเพื่อพิสูจน์ว่าช่องทางคุยกับเครื่องใช้ได้จริง */
async function trialShell(): Promise<void> {
  const d = selected();
  if (!d) return;
  const cmd = 'id; getprop ro.product.model; uptime';
  localLog('info', `$ ${cmd}`);
  try {
    const res = await api.runShell(d.serial, cmd);
    for (const line of res.stdout.split('\n')) {
      if (line.trim()) localLog('info', `  ${line.trim()}`);
    }
    localLog(res.exitCode === 0 ? 'info' : 'warn', `  (exit ${res.exitCode})`);
  } catch (err) {
    localLog('error', `คำสั่งล้มเหลว: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─────────────────────────── มิเรอร์ ───────────────────────────

/** ค่าเดียวกับ KeyEvent ของแอนดรอยด์: 3=HOME 4=BACK 187=APP_SWITCH */
function tapKey(keycode: number): void {
  api.sendKey(0, keycode); // DOWN
  api.sendKey(1, keycode); // UP
}

async function startMirror(mode: 'screen' | 'camera' = 'screen', cameraIds?: string[]): Promise<void> {
  const d = selected();
  if (!d || mirrorStarting) return;

  mirrorStarting = true;
  mirrorMode = mode;
  renderStage();
  localLog('info', mode === 'camera'
    ? `กำลังเปิดกล้อง ${cameraIds?.join(', ')} ของ ${d.model ?? d.serial}`
    : `กำลังเริ่มมิเรอร์ ${d.model ?? d.serial}`);

  try {
    const res = await api.startMirror(d.serial, {
      mode,
      cameraIds,
      maxSize: 1080,
      bitRate: 8_000_000,
      maxFps: 60,
      codec: 'h264',
      // ใช้ root ก็ต่อเมื่อมีจริง — ไม่งั้นจะไปค้างรอ su ที่ไม่มีวันผ่าน
      useRoot: d.tier === 'root',
    });
    if (!res.ok) {
      localLog('error', `เริ่มไม่สำเร็จ: ${res.message}`);
    }
  } finally {
    mirrorStarting = false;
    renderAll();
  }
}

function clearStreams(): void {
  for (const view of streams.values()) view.sink.stop();
  streams.clear();
}

async function stopMirror(): Promise<void> {
  await api.stopMirror();
  clearStreams();
  renderAll();
}

/**
 * ส่งการสัมผัสจากแคนวาสไปเครื่อง
 * ต้องแปลงพิกัดหน้าจอ → พิกัดในภาพก่อนเสมอ เพราะแคนวาสถูก CSS ย่อให้พอดีกรอบ
 */
function wireCanvasTouch(canvas: HTMLCanvasElement): void {
  const point = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: Math.max(0, Math.min(canvas.width - 1, (e.clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.min(canvas.height - 1, (e.clientY - rect.top) * scaleY)),
    };
  };

  const send = (action: number, e: PointerEvent): void => {
    if (!touchableStream()) return;
    const p = point(e);
    api.sendTouch({
      action,
      pointerId: e.pointerId,
      x: p.x,
      y: p.y,
      screenW: canvas.width,
      screenH: canvas.height,
      pressure: e.pressure > 0 ? e.pressure : 1,
    });
  };

  canvas.addEventListener('pointerdown', (e) => {
    // จับตัวชี้ไว้กับแคนวาส ไม่งั้นลากออกนอกกรอบแล้วจะไม่ได้ pointerup เลย
    // ผลคือนิ้วค้างบนเครื่องตลอดกาล
    canvas.setPointerCapture(e.pointerId);
    send(0, e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons === 0) return;
    send(2, e);
  });
  canvas.addEventListener('pointerup', (e) => {
    send(1, e);
    canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointercancel', (e) => send(3, e));
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    tapKey(4); // คลิกขวา = ปุ่มย้อนกลับ ตามที่คนคุ้นจาก scrcpy
  });
}

function openWireless(): void {
  openWirelessDialog(api, (level, message) => localLog(level, message));
}

function openCameras(): void {
  const d = selected();
  if (!d) {
    localLog('warn', 'เลือกอุปกรณ์ก่อน');
    return;
  }
  openCameraDialog(
    api,
    d.serial,
    (level, message) => localLog(level, message),
    (ids) => void startMirror('camera', ids),
  );
}

// ─────────────────────────────── ต่อสาย ───────────────────────────────

function wireControls(): void {
  el('btn-min').addEventListener('click', () => api.windowMinimize());
  el('btn-max').addEventListener('click', () => api.windowToggleMaximize());
  el('btn-close').addEventListener('click', () => api.windowClose());

  el('btn-refresh').addEventListener('click', () => void refreshSelected());
  el('btn-restart-adb').addEventListener('click', () => void restartAdb());
  el('btn-log').addEventListener('click', () => void api.logOpen());
  el('btn-wireless').addEventListener('click', () => openWireless());
  el('btn-mirror').addEventListener('click', () => {
    if (isMirroring()) void stopMirror();
    else void startMirror('screen');
  });
  el('btn-camera').addEventListener('click', () => openCameras());
  el('btn-gamepad').addEventListener('click', () =>
    openGamepadDialog(api, (level, message) => localLog(level, message)),
  );

  const pin = el('btn-pin');
  pin.addEventListener('click', async () => {
    pinned = await api.windowSetAlwaysOnTop(!pinned);
    pin.classList.toggle('is-on', pinned);
    localLog('info', pinned ? 'ปักหมุดหน้าต่างไว้บนสุดแล้ว' : 'เลิกปักหมุดแล้ว');
  });
}

async function boot(): Promise<void> {
  wireControls();

  api.onDevicesChanged((list) => {
    devices = list;
    // เครื่องที่เลือกไว้ถูกถอดออก → เด้งไปเครื่องแรกที่ยังอยู่ ไม่ปล่อยให้จอค้างข้อมูลเก่า
    if (selectedSerial && !list.some((d) => d.serial === selectedSerial)) {
      selectedSerial = list[0]?.serial ?? null;
    }
    // ยังไม่เคยเลือก → เลือกเครื่องแรกที่พร้อมใช้งานให้เลย
    if (!selectedSerial) {
      selectedSerial = (list.find((d) => d.state === 'device') ?? list[0])?.serial ?? null;
    }
    renderAll();
  });

  api.onAdbStatus((status) => {
    adbStatus = status;
    renderAll();
  });

  api.onLog((entry) => appendLog(entry));

  api.onWindowStateChanged(({ maximized }) => {
    el('btn-max').title = maximized ? 'คืนขนาด' : 'ขยาย';
  });

  api.onUpdateChanged((state) => renderUpdateCell(state));

  api.onMirrorHeader((header) => {
    // สตรีมเดิมมาซ้ำ (เช่นจอหมุนแล้ว server ส่งหัวใหม่) → ใช้ตัวเดิม อย่าสร้างแคนวาสใหม่
    const existing = streams.get(header.streamId);
    const view = existing ?? createStreamView(header);
    view.header = header;
    streams.set(header.streamId, view);
    view.sink.start(header.width, header.height, header.codec);

    localLog(
      'info',
      `${header.deviceName} ${header.width}×${header.height} ${header.codec}` +
        (mirrorMode === 'screen' && !header.hasControl ? ' (ไม่มีช่องควบคุม)' : ''),
    );
    renderAll();
  });

  api.onMirrorPacket((packet) => {
    streams.get(packet.streamId)?.sink.push(packet);
  });

  api.onMirrorClosed((reason) => {
    if (!isMirroring()) return;
    clearStreams();
    localLog('info', `หยุดแล้ว: ${reason}`);
    renderAll();
  });

  adbStatus = await api.adbStatus();
  devices = await api.listDevices();
  if (!selectedSerial) {
    selectedSerial = (devices.find((d) => d.state === 'device') ?? devices[0])?.serial ?? null;
  }
  renderAll();
  renderUpdateCell(await api.updateState());
  localLog('info', 'AndroidRemote พร้อมทำงาน');
}

void boot();
