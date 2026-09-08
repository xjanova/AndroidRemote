/**
 * หน้าต่างตั้งค่าโหมดจอยเกม
 *
 * มือถือไม่ต้องลงแอปอะไรเลย — เปิดเบราว์เซอร์ไปที่ที่อยู่ที่แสดงไว้แล้วเล่นได้
 */

import type { AndroidRemoteApi } from '../shared/api';
import { GAMEPAD_BUTTONS, vkLabel, type GamepadStateView } from '../shared/types';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

/** จัดกลุ่มปุ่มให้ตรงกับที่วางบนจอมือถือ ผู้ใช้จะได้หาเจอเร็ว */
const GROUPS: Array<{ title: string; buttons: readonly string[] }> = [
  { title: 'ปุ่มทิศทาง', buttons: ['UP', 'DOWN', 'LEFT', 'RIGHT'] },
  { title: 'ปุ่มหลัก', buttons: ['A', 'B', 'X', 'Y'] },
  { title: 'ปุ่มบ่า', buttons: ['L1', 'R1', 'L2', 'R2'] },
  { title: 'ปุ่มระบบ', buttons: ['START', 'SELECT'] },
];

const BUTTON_LABEL: Record<string, string> = {
  UP: '▲ ขึ้น', DOWN: '▼ ลง', LEFT: '◀ ซ้าย', RIGHT: '▶ ขวา',
  A: 'A', B: 'B', X: 'X', Y: 'Y',
  L1: 'L1', R1: 'R1', L2: 'L2', R2: 'R2',
  START: 'START', SELECT: 'SELECT',
};

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function openGamepadDialog(api: AndroidRemoteApi, log: Log): void {
  const root = document.getElementById('modal-root');
  if (!root || root.childElementCount > 0) return;

  let state: GamepadStateView = {
    running: false, port: 0, urls: [], connected: 0, injectorReady: false, keymap: {},
  };
  /** ปุ่มที่กำลังรอให้ผู้ใช้กดคีย์บอร์ดเพื่อผูก — null = ไม่ได้รออยู่ */
  let capturing: string | null = null;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  root.appendChild(backdrop);

  const unsubscribe = api.onGamepadChanged((s) => {
    state = s;
    render();
  });

  function close(): void {
    unsubscribe();
    document.removeEventListener('keydown', onKeyDown, true);
    backdrop.remove();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (capturing) {
      // ระหว่างจับปุ่ม ต้องกินทุกคีย์ ไม่งั้น Tab/Esc จะไปทำอย่างอื่นแทน
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        capturing = null;
        render();
        return;
      }
      // keyCode เป็นของเลิกใช้แล้วในสเปก แต่บน Windows/Chromium มันคือรหัสปุ่ม
      // ของวินโดวส์ตรงๆ ซึ่งเป็นสิ่งที่ตัวฉีดคีย์ต้องการพอดี
      const vk = e.keyCode;
      if (!vk) return;
      const button = capturing;
      capturing = null;
      void api.gamepadSetKey(button, vk).then((s) => {
        state = s;
        render();
      });
      return;
    }
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKeyDown, true);

  function buttonRow(button: string): string {
    const vk = state.keymap[button];
    const isCapturing = capturing === button;
    return `
      <div class="found__row" style="padding:4px 7px">
        <div class="found__text">
          <div class="found__name">${esc(BUTTON_LABEL[button] ?? button)}</div>
        </div>
        <button class="xpbtn" data-bind="${esc(button)}" style="min-width:104px">
          ${isCapturing ? 'กดปุ่มที่ต้องการ…' : esc(vk === undefined ? 'ยังไม่ผูก' : vkLabel(vk))}
        </button>
      </div>`;
  }

  function render(): void {
    const url = state.urls[0];

    backdrop.innerHTML = `
      <div class="modal metal-tall" role="dialog">
        <div class="titlebar metal" style="-webkit-app-region:no-drag">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#2f4a6d" stroke-width="1.3">
            <rect x="1.4" y="5" width="13.2" height="7.4" rx="3.2" fill="#dfe7f2"></rect>
            <line x1="5" y1="8.7" x2="7" y2="8.7" stroke-linecap="round"></line>
            <line x1="6" y1="7.7" x2="6" y2="9.7" stroke-linecap="round"></line>
            <circle cx="10.4" cy="8" r=".9" fill="#2f4a6d" stroke="none"></circle>
            <circle cx="11.8" cy="9.4" r=".9" fill="#2f4a6d" stroke="none"></circle>
          </svg>
          <div class="titlebar__text">มือถือเป็นจอยเกม</div>
          <div class="titlebar__buttons">
            <div class="capbtn capbtn--close" id="gp-close" title="ปิด">
              <svg width="9" height="9" viewBox="0 0 10 10" stroke="#fff" stroke-width="1.9" stroke-linecap="round">
                <line x1="1.6" y1="1.6" x2="8.4" y2="8.4"></line><line x1="8.4" y1="1.6" x2="1.6" y2="8.4"></line>
              </svg>
            </div>
          </div>
        </div>

        <div class="modal__body">
          <div class="gbox">
            <div class="gbox__title">สถานะ</div>
            ${
              state.running
                ? `<div style="display:flex;flex-direction:column;gap:9px">
                     <div style="display:flex;align-items:center;gap:7px">
                       <div class="dot" style="background:${state.connected > 0 ? '#3f9c4a' : '#d4a017'}"></div>
                       <span>${state.connected > 0 ? `มือถือต่ออยู่ ${state.connected} เครื่อง` : 'รอมือถือเปิดหน้าจอย'}</span>
                     </div>
                     <div>
                       <div style="color:var(--ink-dim);margin-bottom:4px">บนมือถือ เปิดเบราว์เซอร์แล้วพิมพ์ที่อยู่นี้</div>
                       <div class="sunken" style="background:#fff;border-radius:2px;padding:7px 9px;
                            font:bold 15px 'Trebuchet MS',Tahoma;color:#1c3d63;user-select:text;cursor:text">${esc(url ?? `พอร์ต ${state.port}`)}</div>
                       ${
                         state.urls.length > 1
                           ? `<div style="color:var(--ink-dim);font-size:10px;margin-top:4px">
                                ที่อยู่อื่นถ้าอันบนใช้ไม่ได้: ${state.urls.slice(1).map(esc).join(' · ')}
                              </div>`
                           : ''
                       }
                     </div>
                     ${
                       state.injectorReady
                         ? ''
                         : `<div class="blocker"><div class="blocker__head">
                              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex:0 0 16px;margin-top:1px"><path d="M8 1.9 15 14H1z" fill="#f0c040" stroke="#a8801a" stroke-width="1.1" stroke-linejoin="round"></path><rect x="7.25" y="6" width="1.5" height="4.2" rx=".7" fill="#5a4207"></rect><circle cx="8" cy="11.9" r=".95" fill="#5a4207"></circle></svg>
                              <div class="blocker__detail">ตัวฉีดคีย์ยังไม่พร้อม — กดปุ่มบนมือถือแล้วจะยังไม่มีอะไรเกิดขึ้น</div>
                            </div></div>`
                     }
                   </div>`
                : `<div style="color:var(--ink-dim);line-height:1.7">
                     กด “เปิดโหมดจอย” แล้วเอาที่อยู่ที่ขึ้นมาไปเปิดในเบราว์เซอร์ของมือถือ<br />
                     ไม่ต้องลงแอปอะไรบนมือถือ และใช้กับแท็บเล็ตหรือ iPhone ก็ได้<br />
                     <span style="font-size:10px">มือถือกับ PC ต้องอยู่วง Wi-Fi เดียวกัน</span>
                   </div>`
            }
          </div>

          <div class="gbox">
            <div class="gbox__title">ผังปุ่ม</div>
            <div style="color:var(--ink-dim);margin-bottom:7px">
              กดที่ปุ่มด้านขวาแล้วกดคีย์บนคีย์บอร์ดที่อยากให้ส่งไป (Esc = ยกเลิก)
            </div>
            <div class="found sunken" style="max-height:none">
              ${GROUPS.map(
                (g) => `
                  <div style="padding:5px 7px 2px;color:var(--ink-label);font-weight:bold;background:#f3f4f9">${esc(g.title)}</div>
                  ${g.buttons.map(buttonRow).join('')}`,
              ).join('')}
            </div>
            <div style="margin-top:9px">
              <button class="xpbtn" id="gp-reset">คืนค่าเริ่มต้น</button>
            </div>
          </div>
        </div>

        <div class="modal__foot">
          <div style="flex:1;color:var(--ink-dim);font-size:10px">
            ส่งเป็น scan code เพื่อให้เกมที่อ่านผ่าน DirectInput เห็นด้วย
          </div>
          <button class="xpbtn" id="gp-toggle" style="min-width:104px">${state.running ? 'ปิดโหมดจอย' : 'เปิดโหมดจอย'}</button>
          <button class="gel" id="gp-done">เสร็จสิ้น</button>
        </div>
      </div>`;

    backdrop.querySelector('#gp-close')?.addEventListener('click', close);
    backdrop.querySelector('#gp-done')?.addEventListener('click', close);

    backdrop.querySelector('#gp-toggle')?.addEventListener('click', async () => {
      state = state.running ? await api.gamepadStop() : await api.gamepadStart();
      if (state.running && !state.injectorReady) {
        log('warn', 'ตัวฉีดคีย์ยังไม่พร้อม — ดูบันทึกเหตุการณ์');
      }
      render();
    });

    backdrop.querySelector('#gp-reset')?.addEventListener('click', async () => {
      state = await api.gamepadResetKeys();
      render();
    });

    backdrop.querySelectorAll<HTMLElement>('[data-bind]').forEach((btn) => {
      btn.addEventListener('click', () => {
        capturing = btn.dataset.bind!;
        render();
      });
    });
  }

  render();

  void (async () => {
    state = await api.gamepadState();
    render();
  })();
}

/** ปุ่มทั้งหมดที่มี — export ไว้ให้ที่อื่นใช้ตรวจความครบถ้วนของผัง */
export const ALL_BUTTONS = GAMEPAD_BUTTONS;
