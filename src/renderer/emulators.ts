/**
 * หน้าต่างสร้าง/จัดการเครื่องจำลอง
 *
 * "โคลนจากเครื่องเดิม" เป็นค่าเริ่มต้นเมื่อมีเครื่องอยู่แล้ว เพราะใช้อิมเมจที่มีแน่นอน
 * ไม่เสี่ยงเจอ "ยังไม่ได้ดาวน์โหลดอิมเมจ Android รุ่นนี้"
 */

import type { AndroidRemoteApi } from '../shared/api';
import type {
  AndroidVersionChoice,
  CreateEmulatorSpec,
  EmulatorInstanceView,
  EmulatorManagerState,
  EmulatorProviderView,
} from '../shared/emulator';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function openEmulatorDialog(api: AndroidRemoteApi, log: Log): void {
  const root = document.getElementById('modal-root');
  if (!root || root.childElementCount > 0) return;

  let state: EmulatorManagerState = { providers: [], instances: [], busy: null };
  let busyLocal = false;

  // ฟอร์มสร้าง
  const form: {
    name: string;
    mode: 'clone' | 'new';
    cloneFromId: string;
    androidVersion: AndroidVersionChoice;
    count: number;
    randomizeIdentity: boolean;
    resolution: string;
    cpu: number;
    memoryMb: number;
  } = {
    name: 'AR',
    mode: 'clone',
    cloneFromId: '',
    androidVersion: '7',
    count: 1,
    randomizeIdentity: true,
    resolution: '720,1280,320',
    cpu: 2,
    memoryMb: 2048,
  };

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  root.appendChild(backdrop);

  const unsub = api.onEmuChanged((s) => {
    state = s;
    render();
  });

  function close(): void {
    unsub();
    document.removeEventListener('keydown', onKeyDown);
    backdrop.remove();
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && !busyLocal) close();
  }
  document.addEventListener('keydown', onKeyDown);

  async function reload(): Promise<void> {
    state = await api.emuState();
    // ตั้ง cloneFrom เริ่มต้นเป็นเครื่องแรกที่มี
    if (!form.cloneFromId && state.instances.length > 0) form.cloneFromId = state.instances[0].id;
    render();
  }

  const nox = (): EmulatorProviderView | undefined => state.providers.find((p) => p.brand === 'nox');

  async function doCreate(): Promise<void> {
    const p = nox();
    if (!p?.available) return log('warn', 'ไม่พบ Nox ในเครื่อง');
    if (!form.name.trim()) return log('warn', 'ตั้งชื่อเครื่องก่อน');
    if (form.mode === 'clone' && !form.cloneFromId) return log('warn', 'เลือกเครื่องต้นทางที่จะโคลน');

    const [w, h, dpi] = form.resolution.split(',').map((n) => parseInt(n.trim(), 10));
    const spec: CreateEmulatorSpec = {
      name: form.name.trim(),
      androidVersion: form.androidVersion,
      count: form.count,
      randomizeIdentity: form.randomizeIdentity,
      cpu: form.cpu,
      memoryMb: form.memoryMb,
      width: w || undefined,
      height: h || undefined,
      dpi: dpi || undefined,
      cloneFromId: form.mode === 'clone' ? form.cloneFromId : undefined,
    };

    busyLocal = true;
    render();
    const res = await api.emuCreate('nox', spec);
    log(res.ok ? 'info' : 'warn', res.message);
    busyLocal = false;
    await reload();
  }

  async function op(fn: () => Promise<{ ok: boolean; message: string }>): Promise<void> {
    busyLocal = true;
    render();
    const res = await fn();
    log(res.ok ? 'info' : 'warn', res.message);
    busyLocal = false;
    await reload();
  }

  function instRow(inst: EmulatorInstanceView): string {
    return `
      <div class="found__row">
        <div class="dot" style="background:${inst.running ? '#3f9c4a' : '#8b8c9e'}"></div>
        <div class="found__text">
          <div class="found__name">${esc(inst.name)}</div>
          <div class="found__sub">${inst.running ? 'กำลังรัน' : 'ปิดอยู่'} · ${esc(inst.brand)}</div>
        </div>
        ${
          inst.running
            ? `<button class="xpbtn" data-quit="${esc(inst.id)}">ปิด</button>
               <button class="xpbtn" data-reboot="${esc(inst.id)}">รีบูต</button>`
            : `<button class="gel" style="height:23px;padding:0 14px" data-launch="${esc(inst.id)}">เปิด</button>`
        }
        <button class="xpbtn" data-remove="${esc(inst.id)}">ลบ</button>
      </div>`;
  }

  function render(): void {
    const p = nox();
    const busy = busyLocal || state.busy !== null;
    const versions = p?.androidVersions ?? (['5', '7', '9', '12'] as AndroidVersionChoice[]);

    backdrop.innerHTML = `
      <div class="modal metal-tall" role="dialog" style="width:640px">
        <div class="titlebar metal" style="-webkit-app-region:no-drag">
          <div class="titlebar__text">เครื่องจำลอง</div>
          <div class="titlebar__buttons"><div class="capbtn capbtn--close" id="em-close" title="ปิด"><svg width="9" height="9" viewBox="0 0 10 10" stroke="#fff" stroke-width="1.9" stroke-linecap="round"><line x1="1.6" y1="1.6" x2="8.4" y2="8.4"></line><line x1="8.4" y1="1.6" x2="1.6" y2="8.4"></line></svg></div></div>
        </div>
        <div class="modal__body">
          ${
            !p?.available
              ? `<div class="gbox"><div class="gbox__title">Nox</div>
                   <div style="color:var(--ink-dim);line-height:1.7">ไม่พบ Nox ในเครื่องนี้<br />
                   ติดตั้ง Nox แล้วเปิดหน้านี้ใหม่ (รองรับ Nox ก่อน ยี่ห้ออื่นจะเพิ่มทีหลัง)</div></div>`
              : `
            ${
              p.adbVersionMatches === false
                ? `<div class="blocker"><div class="blocker__head">
                     <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex:0 0 16px;margin-top:1px"><path d="M8 1.9 15 14H1z" fill="#f0c040" stroke="#a8801a" stroke-width="1.1" stroke-linejoin="round"></path><rect x="7.25" y="6" width="1.5" height="4.2" rx=".7" fill="#5a4207"></rect><circle cx="8" cy="11.9" r=".95" fill="#5a4207"></circle></svg>
                     <div class="blocker__detail">Nox แถม adb ${esc(p.bundledAdbVersion)} ไม่ตรงกับเรา — ถ้าเครื่องต่อแล้วหลุดบ่อย ก็อป <code>platform-tools\\adb.exe</code> ไปทับที่โฟลเดอร์ Nox</div>
                   </div></div>`
                : ''
            }
            <div class="gbox">
              <div class="gbox__title">สร้างเครื่องใหม่</div>
              <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 10px;align-items:center">
                <span>ชื่อ</span>
                <input class="text-input" id="em-name" value="${esc(form.name)}" placeholder="เช่น ทดสอบ, บัญชี" />

                <span>วิธีสร้าง</span>
                <div style="display:flex;gap:14px;flex-wrap:wrap">
                  <label style="display:flex;gap:5px;align-items:center"><input type="radio" name="em-mode" value="clone" ${form.mode === 'clone' ? 'checked' : ''} ${state.instances.length === 0 ? 'disabled' : ''}/> โคลนจากเครื่องเดิม</label>
                  <label style="display:flex;gap:5px;align-items:center"><input type="radio" name="em-mode" value="new" ${form.mode === 'new' ? 'checked' : ''}/> สร้างใหม่จาก Android version</label>
                </div>

                ${
                  form.mode === 'clone'
                    ? `<span>ต้นทาง</span>
                       <select class="text-input" id="em-clone">${state.instances.map((i) => `<option value="${esc(i.id)}" ${i.id === form.cloneFromId ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select>`
                    : `<span>Android</span>
                       <select class="text-input" id="em-version">${versions.map((v) => `<option value="${v}" ${v === form.androidVersion ? 'selected' : ''}>Android ${v}</option>`).join('')}</select>`
                }

                <span>สเปก</span>
                <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
                  <input class="text-input" id="em-res" value="${esc(form.resolution)}" style="width:120px" title="กว้าง,สูง,dpi" />
                  <label>CPU <input class="text-input" id="em-cpu" type="number" min="1" max="8" value="${form.cpu}" style="width:48px" /></label>
                  <label>RAM <input class="text-input" id="em-ram" type="number" min="512" step="512" value="${form.memoryMb}" style="width:70px" /> MB</label>
                </div>

                <span>จำนวน</span>
                <div style="display:flex;gap:14px;align-items:center">
                  <input class="text-input" id="em-count" type="number" min="1" max="20" value="${form.count}" style="width:56px" />
                  <label style="display:flex;gap:5px;align-items:center"><input type="checkbox" id="em-rand" ${form.randomizeIdentity ? 'checked' : ''}/> สุ่มตัวตน (IMEI/รุ่น) ต่างกันทุกเครื่อง</label>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;margin-top:11px">
                <button class="gel" id="em-create" ${busy ? 'disabled' : ''}>${busyLocal ? 'กำลังทำ…' : 'สร้าง'}</button>
                <span style="color:var(--ink-dim);font-size:10px">${form.count > 1 ? `จะสร้าง ${form.count} เครื่อง ตั้งชื่อ ${esc(form.name)}-1 ถึง -${form.count}` : 'สร้างเครื่องจำลองใหม่ กินพื้นที่ ~1-2GB ต่อเครื่อง'}</span>
              </div>
            </div>

            <div class="gbox">
              <div class="gbox__title">เครื่องที่มี (${state.instances.length})</div>
              <div class="found sunken">
                ${state.instances.length === 0 ? `<div class="found__empty">ยังไม่มีเครื่อง — สร้างจากด้านบน</div>` : state.instances.map(instRow).join('')}
              </div>
              <div style="font-size:10px;color:var(--ink-dim);margin-top:7px">กด “เปิด” แล้วเครื่องจะโผล่ในรายการอุปกรณ์เองภายในไม่กี่วินาที คุมได้เหมือนมือถือจริง</div>
            </div>`
          }
          ${state.busy ? `<div style="color:#8a6508">⏳ ${esc(state.busy)}</div>` : ''}
        </div>
        <div class="modal__foot"><span style="flex:1"></span><button class="gel" id="em-done">เสร็จสิ้น</button></div>
      </div>`;
    wire();
  }

  function wire(): void {
    backdrop.querySelector('#em-close')?.addEventListener('click', close);
    backdrop.querySelector('#em-done')?.addEventListener('click', close);

    const bind = (id: string, ev: string, fn: (el: HTMLInputElement) => void): void => {
      const el = backdrop.querySelector<HTMLInputElement>(`#${id}`);
      el?.addEventListener(ev, () => fn(el));
    };
    bind('em-name', 'input', (el) => (form.name = el.value));
    bind('em-res', 'input', (el) => (form.resolution = el.value));
    bind('em-cpu', 'input', (el) => (form.cpu = Math.max(1, parseInt(el.value, 10) || 2)));
    bind('em-ram', 'input', (el) => (form.memoryMb = Math.max(512, parseInt(el.value, 10) || 2048)));
    bind('em-count', 'input', (el) => {
      form.count = Math.max(1, Math.min(20, parseInt(el.value, 10) || 1));
      render();
    });
    bind('em-rand', 'change', (el) => (form.randomizeIdentity = el.checked));
    bind('em-clone', 'change', (el) => (form.cloneFromId = el.value));
    bind('em-version', 'change', (el) => (form.androidVersion = el.value as AndroidVersionChoice));
    backdrop.querySelectorAll<HTMLInputElement>('input[name="em-mode"]').forEach((r) =>
      r.addEventListener('change', () => {
        if (r.checked) {
          form.mode = r.value as 'clone' | 'new';
          render();
        }
      }),
    );

    backdrop.querySelector('#em-create')?.addEventListener('click', () => void doCreate());
    backdrop.querySelectorAll<HTMLElement>('[data-launch]').forEach((b) => b.addEventListener('click', () => void op(() => api.emuLaunch('nox', b.dataset.launch!))));
    backdrop.querySelectorAll<HTMLElement>('[data-quit]').forEach((b) => b.addEventListener('click', () => void op(() => api.emuQuit('nox', b.dataset.quit!))));
    backdrop.querySelectorAll<HTMLElement>('[data-reboot]').forEach((b) => b.addEventListener('click', () => void op(() => api.emuReboot('nox', b.dataset.reboot!))));
    backdrop.querySelectorAll<HTMLElement>('[data-remove]').forEach((b) =>
      b.addEventListener('click', () => {
        if (!window.confirm(`ลบเครื่อง "${b.dataset.remove}"? ข้อมูลในเครื่องหายทั้งหมด ย้อนกลับไม่ได้`)) return;
        void op(() => api.emuRemove('nox', b.dataset.remove!));
      }),
    );
  }

  render();
  void reload();
}
