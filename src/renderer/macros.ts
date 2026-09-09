/**
 * หน้าต่างมาโครและตั้งเวลา
 *
 * บันทึกจากเครื่องที่เลือก → เล่นซ้ำไปกี่เครื่องก็ได้ที่เปิดเซสชันอยู่ → ตั้งเวลาให้ทำเอง
 * เพิ่มขั้นตอนแบบ "หา element" ได้จากโครงหน้าจอจริง เพื่อให้ทนต่อการเปลี่ยนตำแหน่งแบบ tping
 */

import type { AndroidRemoteApi } from '../shared/api';
import type { DeviceInfo } from '../shared/types';
import type { MacroRunState, MacroView, ScheduleView, UiNodeView } from '../shared/automation';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stepLabel(step: MacroView['steps'][number]): string {
  switch (step.t) {
    case 'tap':
      return `แตะ (${Math.round(step.fx * 100)}%, ${Math.round(step.fy * 100)}%)${step.holdMs ? ` ค้าง ${step.holdMs}ms` : ''}`;
    case 'swipe':
      return `ปัด → (${Math.round(step.fx2 * 100)}%, ${Math.round(step.fy2 * 100)}%) ${step.durationMs}ms`;
    case 'key':
      return `ปุ่ม ${step.keycode === 4 ? 'ย้อนกลับ' : step.keycode === 3 ? 'หน้าหลัก' : step.keycode}`;
    case 'text':
      return `พิมพ์ "${step.value}"`;
    case 'wait':
      return `รอ ${step.ms}ms`;
    case 'find_tap':
      return `หาแล้วแตะ: ${step.selector.resourceId ?? step.selector.text ?? step.selector.contentDesc ?? step.selector.className ?? 'พิกัด'}`;
    case 'launch':
      return `เปิดแอป ${step.packageName}`;
  }
}

export function openMacroDialog(
  api: AndroidRemoteApi,
  devices: DeviceInfo[],
  activeSerials: string[],
  selectedSerial: string | null,
  log: Log,
): void {
  const root = document.getElementById('modal-root');
  if (!root || root.childElementCount > 0) return;

  let macros: MacroView[] = [];
  let schedules: ScheduleView[] = [];
  let run: MacroRunState = { running: false, serials: [], progress: {}, loopsTotal: 1 };
  let recording: { recording: boolean; serial?: string; steps: number } = { recording: false, steps: 0 };
  let tab: 'macros' | 'schedules' = 'macros';
  let openMacroId: string | null = null;
  let uiNodes: UiNodeView[] | null = null;
  const targets = new Set<string>(activeSerials);
  let loops = 1;
  let newName = '';

  const nameOf = (serial: string): string => devices.find((d) => d.serial === serial)?.model ?? serial;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  root.appendChild(backdrop);

  const unsubRun = api.onMacroState((s) => {
    run = s;
    render();
  });
  const pollRec = window.setInterval(async () => {
    if (!recording.recording) return;
    recording = await api.macroRecordingState();
    render();
  }, 1000);

  function close(): void {
    unsubRun();
    window.clearInterval(pollRec);
    document.removeEventListener('keydown', onKeyDown);
    backdrop.remove();
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKeyDown);

  async function reload(): Promise<void> {
    [macros, schedules, recording] = await Promise.all([api.macroList(), api.scheduleList(), api.macroRecordingState()]);
    render();
  }

  // ─────────────────────────── การกระทำ ───────────────────────────

  async function startRecording(): Promise<void> {
    if (!selectedSerial) return log('warn', 'เลือกเครื่องก่อน');
    if (!activeSerials.includes(selectedSerial)) return log('warn', 'เปิดมิเรอร์ของเครื่องที่เลือกก่อน แล้วค่อยบันทึก');
    try {
      await api.macroRecordStart(selectedSerial, newName);
      newName = '';
      close(); // ปิดหน้าต่างให้ผู้ใช้ไปกดบนจอมิเรอร์ได้ กลับมากดหยุดทีหลัง
      log('info', 'กำลังบันทึก — ทำบนจอมิเรอร์ได้เลย เสร็จแล้วเปิดหน้ามาโครมากด “หยุดบันทึก”');
    } catch (err) {
      log('error', err instanceof Error ? err.message : String(err));
    }
  }

  async function stopRecording(): Promise<void> {
    const m = await api.macroRecordStop();
    log(m ? 'info' : 'warn', m ? `บันทึก "${m.name}" ${m.steps.length} ขั้นตอน` : 'ไม่ได้บันทึก — ไม่มีขั้นตอน');
    await reload();
  }

  async function play(macroId: string): Promise<void> {
    const list = [...targets].filter((s) => activeSerials.includes(s));
    if (list.length === 0) return log('warn', 'เลือกเครื่องที่เปิดเซสชันอยู่อย่างน้อยหนึ่งเครื่อง');
    const res = await api.macroPlay(macroId, list, loops);
    log(res.ok ? 'info' : 'warn', res.message);
  }

  async function loadUi(): Promise<void> {
    if (!selectedSerial) return log('warn', 'เลือกเครื่องก่อน');
    uiNodes = null;
    render();
    try {
      uiNodes = (await api.uiDump(selectedSerial)).filter((n) => n.clickable || n.text || n.resourceId);
    } catch (err) {
      uiNodes = [];
      log('error', err instanceof Error ? err.message : String(err));
    }
    render();
  }

  // ─────────────────────────── การวาด ───────────────────────────

  function macroRow(m: MacroView): string {
    const open = openMacroId === m.id;
    return `
      <div class="found__row" style="flex-wrap:wrap">
        <div class="found__text" data-open="${esc(m.id)}" style="cursor:pointer">
          <div class="found__name">${esc(m.name)}</div>
          <div class="found__sub">${m.steps.length} ขั้นตอน · บันทึกจาก ${esc(nameOf(m.recordedOn.serial))}</div>
        </div>
        <button class="gel" data-play="${esc(m.id)}" style="height:23px;padding:0 14px"${run.running ? ' disabled' : ''}>เล่น</button>
        <button class="xpbtn" data-rename="${esc(m.id)}">ชื่อ</button>
        <button class="xpbtn" data-del="${esc(m.id)}">ลบ</button>
        ${
          open
            ? `<div style="flex-basis:100%;margin-top:6px;padding:6px 8px;background:#f3f4f9;border-radius:3px;font-size:10px;line-height:1.7">
                 ${m.steps.map((s, i) => `<div>${i + 1}. ${esc(stepLabel(s))} <span style="color:var(--ink-dim)">@${(s.atMs / 1000).toFixed(1)}s</span></div>`).join('')}
                 <div style="margin-top:6px;display:flex;gap:6px;align-items:center">
                   <button class="xpbtn" data-ui="${esc(m.id)}">+ ขั้นตอนหา element จากจอตอนนี้</button>
                 </div>
                 ${
                   uiNodes !== null && openMacroId === m.id
                     ? `<div class="found sunken" style="margin-top:6px;max-height:160px;overflow-y:auto">
                          ${
                            uiNodes.length === 0
                              ? `<div class="found__empty">ไม่มี element ที่เลือกได้</div>`
                              : uiNodes
                                  .slice(0, 80)
                                  .map(
                                    (n, i) => `<div class="found__row" data-node="${i}" style="cursor:pointer;padding:3px 6px">
                                      <div class="found__text">
                                        <div class="found__name">${esc(n.text || n.contentDesc || n.resourceId.split('/').pop() || n.className.split('.').pop())}</div>
                                        <div class="found__sub">${esc(n.resourceId || n.className)}</div>
                                      </div>
                                      ${n.clickable ? `<span class="chip chip--ready">กดได้</span>` : ''}
                                    </div>`,
                                  )
                                  .join('')
                          }
                        </div>`
                     : ''
                 }
               </div>`
            : ''
        }
      </div>`;
  }

  function progressRow(): string {
    if (!run.running && Object.keys(run.progress).length === 0) return '';
    return `
      <div class="gbox" style="margin-top:0">
        <div class="gbox__title">${run.running ? 'กำลังเล่น' : 'ผลรอบล่าสุด'} — ${esc(run.macroName ?? '')}</div>
        ${Object.entries(run.progress)
          .map(([serial, p]) => {
            const pct = p.total ? Math.round((p.step / p.total) * 100) : 0;
            return `<div style="display:flex;align-items:center;gap:8px;padding:3px 0">
              <span style="width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(nameOf(serial))}</span>
              <div class="progress sunken" style="flex:1"><div class="progress__fill" style="width:${pct}%;${p.error ? 'filter:hue-rotate(-100deg)' : ''}"></div></div>
              <span style="width:110px;font-size:10px;color:${p.error ? '#a5301f' : 'var(--ink-dim)'}">${p.error ? esc(p.error) : `${p.step}/${p.total} รอบ ${p.loop}/${run.loopsTotal}`}</span>
            </div>`;
          })
          .join('')}
        ${run.running ? `<button class="xpbtn" id="mc-stop" style="margin-top:6px">หยุดเล่น</button>` : ''}
      </div>`;
  }

  function scheduleRow(s: ScheduleView): string {
    const when =
      s.mode === 'once'
        ? new Date(s.at).toLocaleString('th-TH')
        : s.mode === 'daily'
          ? `ทุกวัน ${String(Math.floor(s.at / 60)).padStart(2, '0')}:${String(s.at % 60).padStart(2, '0')}`
          : `ทุก ${Math.round((s.everyMs ?? 0) / 60000)} นาที`;
    return `
      <div class="found__row">
        <div class="switch" data-toggle="${esc(s.id)}"><div class="switch__box">${s.enabled ? '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#1f6b2c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.6 5.2 3.9 7.6 8.4 2.6"></path></svg>' : ''}</div></div>
        <div class="found__text">
          <div class="found__name">${esc(s.name)}</div>
          <div class="found__sub">${esc(when)} · ${esc(macros.find((m) => m.id === s.macroId)?.name ?? '(มาโครถูกลบ)')} · ${s.serials.length} เครื่อง · ${s.loops} รอบ${s.lastResult ? ` · ล่าสุด: ${esc(s.lastResult)}` : ''}</div>
        </div>
        <button class="xpbtn" data-sdel="${esc(s.id)}">ลบ</button>
      </div>`;
  }

  function render(): void {
    const activeDevices = devices.filter((d) => activeSerials.includes(d.serial));
    backdrop.innerHTML = `
      <div class="modal metal-tall" role="dialog" style="width:680px">
        <div class="titlebar metal" style="-webkit-app-region:no-drag">
          <div class="titlebar__text">มาโครและตั้งเวลา</div>
          <div class="titlebar__buttons"><div class="capbtn capbtn--close" id="mc-close" title="ปิด"><svg width="9" height="9" viewBox="0 0 10 10" stroke="#fff" stroke-width="1.9" stroke-linecap="round"><line x1="1.6" y1="1.6" x2="8.4" y2="8.4"></line><line x1="8.4" y1="1.6" x2="1.6" y2="8.4"></line></svg></div></div>
        </div>
        <div class="modal__body">
          <div style="display:flex;gap:2px;align-items:flex-end;padding-left:3px">
            <div class="tab${tab === 'macros' ? ' act' : ''}" data-tab="macros">มาโคร (${macros.length})</div>
            <div class="tab${tab === 'schedules' ? ' act' : ''}" data-tab="schedules">ตั้งเวลา (${schedules.length})</div>
          </div>
          <div style="margin-top:-1px;border:1px solid #8e8fa2;border-radius:0 3px 3px 3px;background:#eceef5;padding:14px;display:flex;flex-direction:column;gap:12px">
          ${
            tab === 'macros'
              ? `
            <div class="gbox">
              <div class="gbox__title">บันทึกใหม่</div>
              ${
                recording.recording
                  ? `<div style="display:flex;align-items:center;gap:8px">
                       <div class="dot recdot" style="background:#e8503a;box-shadow:0 0 6px #e8503a"></div>
                       <span>กำลังบันทึกจาก <b>${esc(nameOf(recording.serial ?? ''))}</b> — ${recording.steps} ขั้นตอน</span>
                       <span style="flex:1"></span>
                       <button class="gel" id="mc-rec-stop" style="height:23px">หยุดบันทึก</button>
                     </div>`
                  : `<div style="display:flex;gap:7px;align-items:center">
                       <input class="text-input" id="mc-name" style="flex:1" placeholder="ชื่อมาโคร (ไม่ใส่ก็ได้)" value="${esc(newName)}" />
                       <button class="gel" id="mc-rec-start" style="height:23px"${selectedSerial && activeSerials.includes(selectedSerial) ? '' : ' disabled'}>บันทึกจาก ${esc(selectedSerial ? nameOf(selectedSerial) : '—')}</button>
                     </div>
                     <div style="font-size:10px;color:var(--ink-dim);margin-top:6px">ต้องเปิดมิเรอร์ของเครื่องที่เลือกก่อน ทุกอย่างที่กดบนจอมิเรอร์จะถูกบันทึก</div>`
              }
            </div>

            <div class="gbox">
              <div class="gbox__title">เล่นบนเครื่องไหน (${targets.size})</div>
              ${
                activeDevices.length === 0
                  ? `<div style="color:var(--ink-dim)">ยังไม่มีเครื่องที่เปิดเซสชันอยู่ — เปิดมิเรอร์ก่อน แล้วเครื่องจะโผล่ให้เลือกที่นี่ (เลือกได้หลายเครื่องพร้อมกัน)</div>`
                  : `<div style="display:flex;flex-wrap:wrap;gap:6px 14px">
                       ${activeDevices.map((d) => `<div class="switch" data-target="${esc(d.serial)}"><div class="switch__box">${targets.has(d.serial) ? '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#1f6b2c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.6 5.2 3.9 7.6 8.4 2.6"></path></svg>' : ''}</div><span>${esc(d.model ?? d.serial)}</span></div>`).join('')}
                       <span style="flex:1"></span>
                       <label style="display:flex;align-items:center;gap:6px">วน <input class="text-input" id="mc-loops" type="number" min="1" max="9999" value="${loops}" style="width:56px" /> รอบ</label>
                     </div>`
              }
            </div>

            ${progressRow()}

            <div class="gbox">
              <div class="gbox__title">มาโครที่มี</div>
              <div class="found sunken">
                ${macros.length === 0 ? `<div class="found__empty">ยังไม่มี — บันทึกอันแรกจากด้านบน</div>` : macros.map(macroRow).join('')}
              </div>
            </div>`
              : `
            <div class="gbox">
              <div class="gbox__title">เพิ่มรายการ</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <input class="text-input" id="sc-name" placeholder="ชื่องาน" />
                <select class="text-input" id="sc-macro">${macros.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select>
                <select class="text-input" id="sc-mode"><option value="daily">ทุกวันเวลา</option><option value="interval">ทุกๆ กี่นาที</option><option value="once">ครั้งเดียว</option></select>
                <input class="text-input" id="sc-when" placeholder="เช่น 08:30 · หรือ 30 (นาที) · หรือ 2026-09-10 08:30" />
                <div style="grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center">
                  <span style="color:var(--ink-dim)">เครื่อง:</span>
                  ${devices.filter((d) => d.state === 'device').map((d) => `<div class="switch" data-starget="${esc(d.serial)}"><div class="switch__box">${targets.has(d.serial) ? '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#1f6b2c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.6 5.2 3.9 7.6 8.4 2.6"></path></svg>' : ''}</div><span>${esc(d.model ?? d.serial)}</span></div>`).join('')}
                  <span style="flex:1"></span>
                  <label style="display:flex;align-items:center;gap:6px">วน <input class="text-input" id="sc-loops" type="number" min="1" value="1" style="width:56px" /> รอบ</label>
                  <button class="gel" id="sc-add" style="height:23px"${macros.length === 0 ? ' disabled' : ''}>เพิ่ม</button>
                </div>
              </div>
              <div style="font-size:10px;color:#8a6508;margin-top:8px">⚠ ทำงานเฉพาะตอนแอปเปิดอยู่ — ปิดแอปแล้วงานตั้งเวลาไม่ทำงาน</div>
            </div>
            <div class="gbox">
              <div class="gbox__title">รายการ</div>
              <div class="found sunken">${schedules.length === 0 ? `<div class="found__empty">ยังไม่มี</div>` : schedules.map(scheduleRow).join('')}</div>
            </div>`
          }
          </div>
        </div>
        <div class="modal__foot"><span style="flex:1"></span><button class="gel" id="mc-done">เสร็จสิ้น</button></div>
      </div>`;
    wire();
  }

  function wire(): void {
    backdrop.querySelector('#mc-close')?.addEventListener('click', close);
    backdrop.querySelector('#mc-done')?.addEventListener('click', close);
    backdrop.querySelectorAll<HTMLElement>('[data-tab]').forEach((t) =>
      t.addEventListener('click', () => {
        tab = t.dataset.tab as typeof tab;
        render();
      }),
    );
    const nameInput = backdrop.querySelector<HTMLInputElement>('#mc-name');
    nameInput?.addEventListener('input', () => (newName = nameInput.value));
    backdrop.querySelector('#mc-rec-start')?.addEventListener('click', () => void startRecording());
    backdrop.querySelector('#mc-rec-stop')?.addEventListener('click', () => void stopRecording());
    backdrop.querySelector('#mc-stop')?.addEventListener('click', () => void api.macroStop());
    const loopsInput = backdrop.querySelector<HTMLInputElement>('#mc-loops');
    loopsInput?.addEventListener('input', () => (loops = Math.max(1, parseInt(loopsInput.value, 10) || 1)));

    backdrop.querySelectorAll<HTMLElement>('[data-target],[data-starget]').forEach((n) =>
      n.addEventListener('click', () => {
        const s = n.dataset.target ?? n.dataset.starget!;
        if (targets.has(s)) targets.delete(s);
        else targets.add(s);
        render();
      }),
    );
    backdrop.querySelectorAll<HTMLElement>('[data-open]').forEach((n) =>
      n.addEventListener('click', () => {
        openMacroId = openMacroId === n.dataset.open ? null : n.dataset.open!;
        uiNodes = null;
        render();
      }),
    );
    backdrop.querySelectorAll<HTMLElement>('[data-play]').forEach((n) => n.addEventListener('click', () => void play(n.dataset.play!)));
    backdrop.querySelectorAll<HTMLElement>('[data-del]').forEach((n) =>
      n.addEventListener('click', async () => {
        if (!window.confirm('ลบมาโครนี้? ย้อนกลับไม่ได้')) return;
        await api.macroDelete(n.dataset.del!);
        await reload();
      }),
    );
    backdrop.querySelectorAll<HTMLElement>('[data-rename]').forEach((n) =>
      n.addEventListener('click', async () => {
        const m = macros.find((x) => x.id === n.dataset.rename);
        const name = window.prompt('ชื่อใหม่', m?.name ?? '');
        if (name === null) return;
        await api.macroRename(n.dataset.rename!, name);
        await reload();
      }),
    );
    backdrop.querySelectorAll<HTMLElement>('[data-ui]').forEach((n) => n.addEventListener('click', () => void loadUi()));
    backdrop.querySelectorAll<HTMLElement>('[data-node]').forEach((n) =>
      n.addEventListener('click', async () => {
        const node = uiNodes?.[parseInt(n.dataset.node!, 10)];
        const d = devices.find((x) => x.serial === selectedSerial);
        if (!node || !openMacroId || !d?.screenWidth || !d.screenHeight) return;
        const cx = (node.bounds.left + node.bounds.right) / 2;
        const cy = (node.bounds.top + node.bounds.bottom) / 2;
        await api.macroAddFindTap(openMacroId, {
          resourceId: node.resourceId || undefined,
          text: node.text || undefined,
          contentDesc: node.contentDesc || undefined,
          className: node.className || undefined,
          fallback: { fx: cx / d.screenWidth, fy: cy / d.screenHeight },
        });
        uiNodes = null;
        await reload();
      }),
    );

    backdrop.querySelector('#sc-add')?.addEventListener('click', async () => {
      const name = (backdrop.querySelector<HTMLInputElement>('#sc-name')?.value ?? '').trim() || 'งานตั้งเวลา';
      const macroId = backdrop.querySelector<HTMLSelectElement>('#sc-macro')?.value ?? '';
      const mode = (backdrop.querySelector<HTMLSelectElement>('#sc-mode')?.value ?? 'daily') as ScheduleView['mode'];
      const when = (backdrop.querySelector<HTMLInputElement>('#sc-when')?.value ?? '').trim();
      const scLoops = Math.max(1, parseInt(backdrop.querySelector<HTMLInputElement>('#sc-loops')?.value ?? '1', 10) || 1);
      const serials = [...targets];
      if (serials.length === 0) return log('warn', 'เลือกเครื่องอย่างน้อยหนึ่งเครื่อง');
      let at = 0;
      let everyMs: number | undefined;
      if (mode === 'daily') {
        const m = /^(\d{1,2}):(\d{2})$/.exec(when);
        if (!m) return log('warn', 'เวลาต้องเป็นรูปแบบ 08:30');
        at = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      } else if (mode === 'interval') {
        const mins = parseInt(when, 10);
        if (!mins || mins < 1) return log('warn', 'ใส่จำนวนนาที เช่น 30');
        everyMs = mins * 60_000;
      } else {
        const t = Date.parse(when.replace(' ', 'T'));
        if (Number.isNaN(t)) return log('warn', 'วันเวลาต้องเป็นรูปแบบ 2026-09-10 08:30');
        at = t;
      }
      await api.scheduleSave({ id: crypto.randomUUID(), name, macroId, serials, mode, at, everyMs, loops: scLoops, enabled: true });
      await reload();
    });
    backdrop.querySelectorAll<HTMLElement>('[data-toggle]').forEach((n) =>
      n.addEventListener('click', async () => {
        const s = schedules.find((x) => x.id === n.dataset.toggle);
        if (!s) return;
        await api.scheduleSave({ ...s, enabled: !s.enabled });
        await reload();
      }),
    );
    backdrop.querySelectorAll<HTMLElement>('[data-sdel]').forEach((n) =>
      n.addEventListener('click', async () => {
        await api.scheduleDelete(n.dataset.sdel!);
        await reload();
      }),
    );
  }

  render();
  void reload();
}
