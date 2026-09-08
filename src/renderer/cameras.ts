/**
 * หน้าต่างเลือกกล้อง
 *
 * เครื่องส่วนใหญ่มีกล้องมากกว่าที่ผู้ใช้คิด (หลัง + อัลตร้าไวด์ + เทเล + หน้า)
 * แสดงให้ครบทุกตัว แล้วให้เลือกกี่ตัวก็ได้ — แต่ต้องบอกตรงๆ ว่าเปิดพร้อมกัน
 * ได้จริงหรือไม่ เพราะฮาร์ดแวร์ส่วนใหญ่แชร์ ISP ตัวเดียวกัน
 */

import type { AndroidRemoteApi, CameraInfoView, CameraListView } from '../shared/api';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

const FACING_LABEL: Record<CameraInfoView['facing'], string> = {
  front: 'กล้องหน้า',
  back: 'กล้องหลัง',
  external: 'กล้องภายนอก',
  unknown: 'ไม่ทราบด้าน',
};

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** ประมาณมุมมองจากทางยาวโฟกัส — ช่วยให้ผู้ใช้เดาออกว่าตัวไหนคืออัลตร้าไวด์ */
function lensHint(camera: CameraInfoView): string {
  if (!camera.focalLength) return '';
  if (camera.focalLength < 2.5) return ' · น่าจะเป็นอัลตร้าไวด์';
  if (camera.focalLength > 5.5) return ' · น่าจะเป็นเทเล';
  return '';
}

export function openCameraDialog(
  api: AndroidRemoteApi,
  serial: string,
  log: Log,
  onStart: (cameraIds: string[]) => void,
): void {
  const root = document.getElementById('modal-root');
  if (!root || root.childElementCount > 0) return;

  let list: CameraListView | null = null;
  let loading = true;
  const chosen = new Set<string>();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  root.appendChild(backdrop);

  function close(): void {
    document.removeEventListener('keydown', onKeyDown);
    backdrop.remove();
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKeyDown);

  /**
   * ชุดที่เลือกอยู่ เปิดพร้อมกันได้จริงไหม
   * รายการ concurrent ที่แอนดรอยด์คืนมาคือ "ชุดที่รับประกัน" — เลือกตัวเดียวได้เสมอ
   * ว่างเปล่าแปลว่าเครื่องไม่ประกาศข้อมูลนี้ ซึ่งไม่ได้แปลว่าเปิดพร้อมกันไม่ได้
   */
  function concurrencyNote(): { level: 'ok' | 'warn' | 'unknown'; text: string } {
    if (chosen.size <= 1) return { level: 'ok', text: '' };
    const groups = list?.concurrent ?? [];
    if (groups.length === 0) {
      return {
        level: 'unknown',
        text: 'เครื่องนี้ไม่ได้บอกว่าเปิดกล้องพร้อมกันได้ชุดไหนบ้าง — ลองได้ แต่ถ้าเปิดไม่ขึ้นให้เลือกทีละตัว',
      };
    }
    const fits = groups.some((g) => [...chosen].every((id) => g.includes(id)));
    return fits
      ? { level: 'ok', text: 'เครื่องนี้รองรับการเปิดชุดนี้พร้อมกัน' }
      : {
          level: 'warn',
          text: 'ชุดที่เลือกไม่อยู่ในรายการที่เครื่องรับประกัน — น่าจะเปิดได้แค่บางตัว',
        };
  }

  function cameraRow(camera: CameraInfoView): string {
    const on = chosen.has(camera.id);
    const res = camera.maxWidth > 0 ? `${camera.maxWidth}×${camera.maxHeight}` : 'ไม่ทราบความละเอียด';
    return `
      <div class="found__row" data-pick="${esc(camera.id)}" style="cursor:pointer">
        <div class="switch__box">
          ${
            on
              ? `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#1f6b2c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.6 5.2 3.9 7.6 8.4 2.6"></path></svg>`
              : ''
          }
        </div>
        <div class="found__text">
          <div class="found__name">${esc(FACING_LABEL[camera.facing])} <span style="color:var(--ink-dim)">(id ${esc(camera.id)})</span></div>
          <div class="found__sub">${esc(res)}${esc(lensHint(camera))}</div>
        </div>
        ${camera.legacy ? `<span class="chip chip--pairing">คุณภาพจำกัด</span>` : ''}
        ${camera.error ? `<span class="chip chip--pairing" title="${esc(camera.error)}">อ่านข้อมูลไม่ได้</span>` : ''}
      </div>`;
  }

  function render(): void {
    const note = concurrencyNote();
    const cameras = list?.cameras ?? [];

    backdrop.innerHTML = `
      <div class="modal metal-tall" role="dialog">
        <div class="titlebar metal" style="-webkit-app-region:no-drag">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#2f4a6d" stroke-width="1.3">
            <rect x="1.6" y="4.2" width="12.8" height="9.2" rx="1.6" fill="#dfe7f2"></rect>
            <path d="M5.6 4.2 6.7 2.4h2.6l1.1 1.8" stroke-linejoin="round"></path>
            <circle cx="8" cy="8.8" r="2.6"></circle>
          </svg>
          <div class="titlebar__text">ใช้กล้องมือถือแทนเว็บแคม</div>
          <div class="titlebar__buttons">
            <div class="capbtn capbtn--close" id="cam-close" title="ปิด">
              <svg width="9" height="9" viewBox="0 0 10 10" stroke="#fff" stroke-width="1.9" stroke-linecap="round">
                <line x1="1.6" y1="1.6" x2="8.4" y2="8.4"></line><line x1="8.4" y1="1.6" x2="1.6" y2="8.4"></line>
              </svg>
            </div>
          </div>
        </div>

        <div class="modal__body">
          <div class="gbox">
            <div class="gbox__title">กล้องในเครื่อง${cameras.length ? ` (${cameras.length})` : ''}</div>
            <div class="found sunken">
              ${
                loading
                  ? `<div class="found__empty">กำลังถามเครื่องว่ามีกล้องอะไรบ้าง…</div>`
                  : list?.error
                    ? `<div class="found__empty" style="color:#a5301f">${esc(list.error)}</div>`
                    : cameras.length === 0
                      ? `<div class="found__empty">ไม่พบกล้อง</div>`
                      : cameras.map(cameraRow).join('')
              }
            </div>
            ${
              cameras.length > 1
                ? `<div style="display:flex;gap:6px;margin-top:9px">
                     <button class="xpbtn" id="cam-all">เลือกทั้งหมด</button>
                     <button class="xpbtn" id="cam-none">ล้าง</button>
                   </div>`
                : ''
            }
          </div>

          ${
            note.text
              ? `<div class="${note.level === 'warn' ? 'blocker' : 'blocker'}" style="${
                  note.level === 'ok'
                    ? 'border-color:#8dc196;background-image:linear-gradient(180deg,#f0f9f1 0%,#e0f1e3 100%)'
                    : ''
                }">
                   <div class="blocker__head">
                     <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex:0 0 16px;margin-top:1px">
                       <circle cx="8" cy="8" r="6.6" fill="${note.level === 'ok' ? '#cfe9d4' : '#f0c040'}" stroke="${note.level === 'ok' ? '#6ba173' : '#a8801a'}" stroke-width="1.1"></circle>
                       <rect x="7.25" y="6" width="1.5" height="4.2" rx=".7" fill="#3f4a2a"></rect>
                       <circle cx="8" cy="11.9" r=".95" fill="#3f4a2a"></circle>
                     </svg>
                     <div class="blocker__detail" style="${note.level === 'ok' ? 'color:#2c5c35' : ''}">${esc(note.text)}</div>
                   </div>
                 </div>`
              : ''
          }
        </div>

        <div class="modal__foot">
          <div style="flex:1;color:var(--ink-dim)">
            ${chosen.size === 0 ? 'ยังไม่ได้เลือก' : `เลือกไว้ ${chosen.size} ตัว`}
          </div>
          <button class="xpbtn" id="cam-cancel">ยกเลิก</button>
          <button class="gel" id="cam-start"${chosen.size === 0 ? ' disabled' : ''}>เริ่ม</button>
        </div>
      </div>`;

    backdrop.querySelector('#cam-close')?.addEventListener('click', close);
    backdrop.querySelector('#cam-cancel')?.addEventListener('click', close);

    backdrop.querySelectorAll<HTMLElement>('[data-pick]').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.dataset.pick!;
        if (chosen.has(id)) chosen.delete(id);
        else chosen.add(id);
        render();
      });
    });

    backdrop.querySelector('#cam-all')?.addEventListener('click', () => {
      for (const c of cameras) chosen.add(c.id);
      render();
    });
    backdrop.querySelector('#cam-none')?.addEventListener('click', () => {
      chosen.clear();
      render();
    });

    backdrop.querySelector('#cam-start')?.addEventListener('click', () => {
      if (chosen.size === 0) return;
      // เรียงตามลำดับที่เครื่องรายงาน ไม่ใช่ลำดับที่ผู้ใช้กด — ภาพจะได้เรียงเหมือนเดิมทุกครั้ง
      const ids = cameras.filter((c) => chosen.has(c.id)).map((c) => c.id);
      close();
      onStart(ids);
    });
  }

  render();

  void (async () => {
    list = await api.listCameras(serial);
    loading = false;
    if (list.error) log('warn', list.error);
    // มีกล้องเดียวก็ติ๊กให้เลย ผู้ใช้จะได้กดเริ่มได้ทันที
    if (list.cameras.length === 1) chosen.add(list.cameras[0].id);
    render();
  })();
}
