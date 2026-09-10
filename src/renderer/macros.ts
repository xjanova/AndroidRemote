/**
 * หน้าต่างมาโคร/โปรไฟล์เครื่อง/เทมเพลตภาพ/ตั้งเวลา
 *
 * v2: แก้ขั้นตอนได้ทุกชนิด (ตัวแปร เงื่อนไข หาภาพ OCR เสียง) · ตัดเทมเพลตจากภาพหน้าจอจริง
 * · โปรไฟล์ต่อเครื่องทำให้มาโครเดียวกันทำต่างกันในแต่ละเครื่อง · log แยกเครื่องตอนเล่น
 */

import type { AndroidRemoteApi } from '../shared/api';
import type { DeviceInfo } from '../shared/types';
import type {
  DeviceProfile,
  FracRect,
  MacroRunState,
  MacroStep,
  MacroStepType,
  MacroView,
  ScheduleView,
  ScreenEntry,
  ScreenshotPreview,
  TemplateInfo,
  UiNodeView,
  VlmStatus,
  VolumeStream,
} from '../shared/automation';

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;
type Step = MacroView['steps'][number];

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const pct = (f: number): string => `${Math.round(f * 100)}%`;
const rectText = (r: FracRect): string => `${(r.fx * 100).toFixed(1)},${(r.fy * 100).toFixed(1)},${(r.fw * 100).toFixed(1)},${(r.fh * 100).toFixed(1)}`;
const CHECK_SVG =
  '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#1f6b2c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.6 5.2 3.9 7.6 8.4 2.6"></path></svg>';
const check = (on: boolean): string => `<div class="switch__box">${on ? CHECK_SVG : ''}</div>`;

const KEY_NAMES: Record<number, string> = { 3: 'หน้าหลัก', 4: 'ย้อนกลับ', 24: 'เสียง+', 25: 'เสียง−', 26: 'เปิด/ปิดจอ', 66: 'Enter', 187: 'แอปล่าสุด' };

export function stepLabel(step: Step): string {
  switch (step.t) {
    case 'tap':
      return `แตะ (${pct(step.fx)}, ${pct(step.fy)})${step.holdMs ? ` ค้าง ${step.holdMs}ms` : ''}`;
    case 'swipe':
      return `ปัด (${pct(step.fx1)}, ${pct(step.fy1)}) → (${pct(step.fx2)}, ${pct(step.fy2)}) ${step.durationMs}ms`;
    case 'key':
      return `ปุ่ม ${KEY_NAMES[step.keycode] ?? step.keycode}`;
    case 'text':
      return `พิมพ์ "${step.value}"`;
    case 'wait':
      return `รอ ${step.ms}ms`;
    case 'find_tap':
      return `หา element แล้วแตะ: ${step.selector.resourceId ?? step.selector.text ?? step.selector.contentDesc ?? step.selector.className ?? 'พิกัด'}`;
    case 'launch':
      return `เปิดแอป ${step.packageName}`;
    case 'open_url':
      return `เปิดลิงก์ ${step.url}`;
    case 'set_var':
      return `ตั้งตัวแปร ${step.name} = "${step.value}"`;
    case 'find_image_tap':
      return `หาภาพ "${step.template}" แล้วแตะ${step.threshold ? ` (เกณฑ์ ${step.threshold})` : ''}`;
    case 'wait_image':
      return `รอภาพ "${step.template}" ${step.appear ? 'ปรากฏ' : 'หายไป'} ≤${Math.round(step.timeoutMs / 1000)}s`;
    case 'if_image':
      return `ถ้า${step.found ? 'เจอ' : 'ไม่เจอ'}ภาพ "${step.template}" → ไป ${step.goto}`;
    case 'if_text':
      return `ถ้าอ่านได้${step.found ? '' : 'ไม่'}ตรง "${step.match}" ในกรอบ [${rectText(step.rect)}] → ไป ${step.goto}`;
    case 'if_var':
      return `ถ้า ${step.name} ${step.op} ${step.value ?? ''} → ไป ${step.goto}`;
    case 'ocr_var':
      return `อ่าน${step.digits ? 'ตัวเลข' : 'ข้อความ'}ในกรอบ [${rectText(step.rect)}] เก็บใน ${step.name}`;
    case 'label':
      return `● label ${step.name}`;
    case 'goto':
      return `ไป ${step.label}${step.maxTimes ? ` (ไม่เกิน ${step.maxTimes} ครั้ง)` : ''}`;
    case 'run_macro':
      return `เรียกรูทีน ${step.macroId.slice(0, 8)}…`;
    case 'volume':
      return `เสียง ${step.stream} = ${step.percent}%`;
    case 'stop':
      return `จบ${step.message ? `: ${step.message}` : ''}`;
    case 'fail':
      return `ล้มเหลว${step.message ? `: ${step.message}` : ''}`;
    case 'vlm_tap':
      return `AI หา "${step.query}" แล้วแตะ${step.learn === false ? ' (ไม่จำ)' : ''}`;
    case 'vlm_var':
      return `AI ถาม "${step.question}" เก็บใน ${step.name}`;
    case 'if_screen':
      return `ถ้าหน้าจอ${step.found ? '' : 'ไม่'}ใช่ "${step.screen}" → ไป ${step.goto}`;
    case 'wait_screen':
      return `รอหน้า "${step.screen}" ≤${Math.round(step.timeoutMs / 1000)}s`;
    case 'screen_var':
      return `ชื่อหน้าจอตอนนี้ → ${step.name}`;
  }
}

// ─────────────────────────── ฟอร์มเพิ่มขั้นตอน ───────────────────────────

type FieldKind = 'num' | 'text' | 'bool' | 'template' | 'rect' | 'macro' | 'stream' | 'op' | 'label';
interface Field {
  k: string;
  l: string;
  kind: FieldKind;
  d?: string;
}

const STEP_TYPES: Array<{ t: MacroStepType; label: string; group: string }> = [
  { t: 'tap', label: 'แตะ', group: 'พื้นฐาน' },
  { t: 'swipe', label: 'ปัด', group: 'พื้นฐาน' },
  { t: 'key', label: 'ปุ่ม', group: 'พื้นฐาน' },
  { t: 'text', label: 'พิมพ์ข้อความ', group: 'พื้นฐาน' },
  { t: 'wait', label: 'รอ', group: 'พื้นฐาน' },
  { t: 'launch', label: 'เปิดแอป', group: 'พื้นฐาน' },
  { t: 'open_url', label: 'เปิดลิงก์ (เกมเบราว์เซอร์)', group: 'พื้นฐาน' },
  { t: 'find_image_tap', label: 'หาภาพแล้วแตะ', group: 'ภาพ' },
  { t: 'wait_image', label: 'รอภาพปรากฏ/หายไป', group: 'ภาพ' },
  { t: 'vlm_tap', label: 'AI หาจากคำบรรยายแล้วแตะ', group: 'ตา AI' },
  { t: 'wait_screen', label: 'รอจนถึงหน้าจอที่ระบุ', group: 'ตา AI' },
  { t: 'vlm_var', label: 'AI ตอบคำถามเก็บตัวแปร', group: 'ตา AI' },
  { t: 'screen_var', label: 'ชื่อหน้าจอตอนนี้ → ตัวแปร', group: 'ตา AI' },
  { t: 'if_image', label: 'ถ้าเจอ/ไม่เจอภาพ → ไป', group: 'เงื่อนไข' },
  { t: 'if_screen', label: 'ถ้าหน้าจอใช่/ไม่ใช่ → ไป', group: 'เงื่อนไข' },
  { t: 'if_text', label: 'ถ้าอ่านข้อความได้ → ไป', group: 'เงื่อนไข' },
  { t: 'if_var', label: 'ถ้าตัวแปร → ไป', group: 'เงื่อนไข' },
  { t: 'ocr_var', label: 'อ่านข้อความ/ตัวเลขเก็บตัวแปร', group: 'ตัวแปร' },
  { t: 'set_var', label: 'ตั้งตัวแปร', group: 'ตัวแปร' },
  { t: 'label', label: 'label (จุดกระโดด)', group: 'ลำดับ' },
  { t: 'goto', label: 'ไป label', group: 'ลำดับ' },
  { t: 'run_macro', label: 'เรียกมาโครอื่น (รูทีน)', group: 'ลำดับ' },
  { t: 'stop', label: 'จบ (สำเร็จ)', group: 'ลำดับ' },
  { t: 'fail', label: 'จบ (ล้มเหลว)', group: 'ลำดับ' },
  { t: 'volume', label: 'ตั้งเสียง', group: 'เครื่อง' },
];

const FIELDS: Partial<Record<MacroStepType, Field[]>> = {
  tap: [
    { k: 'fx', l: 'x %', kind: 'num', d: '50' },
    { k: 'fy', l: 'y %', kind: 'num', d: '50' },
    { k: 'holdMs', l: 'ค้าง ms', kind: 'num', d: '' },
  ],
  swipe: [
    { k: 'fx1', l: 'จาก x %', kind: 'num', d: '50' },
    { k: 'fy1', l: 'จาก y %', kind: 'num', d: '70' },
    { k: 'fx2', l: 'ถึง x %', kind: 'num', d: '50' },
    { k: 'fy2', l: 'ถึง y %', kind: 'num', d: '30' },
    { k: 'durationMs', l: 'ms', kind: 'num', d: '300' },
  ],
  key: [{ k: 'keycode', l: 'keycode (3 หน้าหลัก, 4 ย้อน, 66 Enter)', kind: 'num', d: '3' }],
  text: [{ k: 'value', l: 'ข้อความ — ใส่ {{ตัวแปร}} ได้', kind: 'text' }],
  wait: [{ k: 'ms', l: 'ms', kind: 'num', d: '1000' }],
  launch: [{ k: 'packageName', l: 'ชื่อแพ็กเกจ', kind: 'text' }],
  open_url: [{ k: 'url', l: 'URL — ใส่ {{ตัวแปร}} ได้', kind: 'text', d: 'https://' }],
  set_var: [
    { k: 'name', l: 'ชื่อตัวแปร', kind: 'text' },
    { k: 'value', l: 'ค่า', kind: 'text' },
  ],
  find_image_tap: [
    { k: 'template', l: 'เทมเพลต', kind: 'template' },
    { k: 'threshold', l: 'เกณฑ์ 0-1', kind: 'num', d: '0.8' },
    { k: 'timeoutMs', l: 'รอไม่เกิน ms', kind: 'num', d: '8000' },
    { k: 'dx', l: 'เลื่อนแตะ x %', kind: 'num', d: '0' },
    { k: 'dy', l: 'เลื่อนแตะ y %', kind: 'num', d: '0' },
  ],
  wait_image: [
    { k: 'template', l: 'เทมเพลต', kind: 'template' },
    { k: 'appear', l: 'รอให้ปรากฏ (ไม่ติ๊ก = รอให้หาย)', kind: 'bool', d: 'true' },
    { k: 'timeoutMs', l: 'รอไม่เกิน ms', kind: 'num', d: '15000' },
    { k: 'threshold', l: 'เกณฑ์ 0-1', kind: 'num', d: '0.8' },
  ],
  if_image: [
    { k: 'template', l: 'เทมเพลต', kind: 'template' },
    { k: 'found', l: 'เมื่อเจอ (ไม่ติ๊ก = เมื่อไม่เจอ)', kind: 'bool', d: 'true' },
    { k: 'goto', l: 'ไป label', kind: 'label' },
    { k: 'threshold', l: 'เกณฑ์ 0-1', kind: 'num', d: '0.8' },
  ],
  if_text: [
    { k: 'rect', l: 'กรอบ x,y,w,h (%)', kind: 'rect' },
    { k: 'match', l: 'ข้อความที่ต้องมี หรือ /regex/', kind: 'text' },
    { k: 'found', l: 'เมื่อตรง (ไม่ติ๊ก = เมื่อไม่ตรง)', kind: 'bool', d: 'true' },
    { k: 'goto', l: 'ไป label', kind: 'label' },
    { k: 'digits', l: 'อ่านเฉพาะตัวเลข', kind: 'bool', d: '' },
  ],
  if_var: [
    { k: 'name', l: 'ตัวแปร', kind: 'text' },
    { k: 'op', l: 'เงื่อนไข', kind: 'op' },
    { k: 'value', l: 'ค่า', kind: 'text' },
    { k: 'goto', l: 'ไป label', kind: 'label' },
  ],
  ocr_var: [
    { k: 'rect', l: 'กรอบ x,y,w,h (%)', kind: 'rect' },
    { k: 'name', l: 'เก็บในตัวแปร', kind: 'text' },
    { k: 'digits', l: 'อ่านเฉพาะตัวเลข', kind: 'bool', d: 'true' },
  ],
  label: [{ k: 'name', l: 'ชื่อ label', kind: 'text' }],
  goto: [
    { k: 'label', l: 'ไป label', kind: 'label' },
    { k: 'maxTimes', l: 'วนได้ไม่เกิน', kind: 'num', d: '100' },
  ],
  run_macro: [{ k: 'macroId', l: 'มาโคร', kind: 'macro' }],
  volume: [
    { k: 'stream', l: 'ช่องเสียง', kind: 'stream' },
    { k: 'percent', l: '%', kind: 'num', d: '50' },
  ],
  stop: [{ k: 'message', l: 'ข้อความ (ไม่ใส่ก็ได้)', kind: 'text' }],
  fail: [{ k: 'message', l: 'ข้อความ (ไม่ใส่ก็ได้)', kind: 'text' }],
  vlm_tap: [
    { k: 'query', l: 'บรรยายสิ่งที่จะแตะ (อังกฤษแม่นกว่า) เช่น close X button top right', kind: 'text' },
    { k: 'timeoutMs', l: 'รอไม่เกิน ms (AI ใช้ ~5-20 วิ/ครั้ง)', kind: 'num', d: '30000' },
    { k: 'learn', l: 'จำหน้าจอ/ปุ่มไว้ใช้ครั้งหน้า', kind: 'bool', d: 'true' },
  ],
  vlm_var: [
    { k: 'question', l: 'คำถาม เช่น How many gems? Answer with a number', kind: 'text' },
    { k: 'name', l: 'เก็บในตัวแปร', kind: 'text' },
  ],
  if_screen: [
    { k: 'screen', l: 'ชื่อหน้า (บางส่วน หรือ /regex/)', kind: 'text' },
    { k: 'found', l: 'เมื่อใช่ (ไม่ติ๊ก = เมื่อไม่ใช่)', kind: 'bool', d: 'true' },
    { k: 'goto', l: 'ไป label', kind: 'label' },
  ],
  wait_screen: [
    { k: 'screen', l: 'ชื่อหน้า (บางส่วน หรือ /regex/)', kind: 'text' },
    { k: 'timeoutMs', l: 'รอไม่เกิน ms', kind: 'num', d: '60000' },
  ],
  screen_var: [{ k: 'name', l: 'เก็บในตัวแปร', kind: 'text', d: 'screen' }],
};

function parseRect(s: string): FracRect | null {
  const p = s.split(',').map((x) => parseFloat(x.trim()));
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null;
  return { fx: p[0] / 100, fy: p[1] / 100, fw: p[2] / 100, fh: p[3] / 100 };
}

/** ประกอบ step จากค่าที่กรอก — คืนข้อความผิดพลาดถ้าไม่ครบ */
function buildStep(t: MacroStepType, v: Record<string, string>): MacroStep | string {
  const n = (k: string, d = 0): number => {
    const x = parseFloat(v[k] ?? '');
    return Number.isFinite(x) ? x : d;
  };
  const b = (k: string): boolean => v[k] === 'true';
  const s = (k: string): string => (v[k] ?? '').trim();
  const need = (k: string, name: string): string | null => (s(k) ? null : `ต้องใส่${name}`);
  switch (t) {
    case 'tap':
      return { t, fx: n('fx', 50) / 100, fy: n('fy', 50) / 100, holdMs: n('holdMs') || undefined };
    case 'swipe':
      return { t, fx1: n('fx1', 50) / 100, fy1: n('fy1', 70) / 100, fx2: n('fx2', 50) / 100, fy2: n('fy2', 30) / 100, durationMs: n('durationMs', 300) };
    case 'key':
      return { t, keycode: n('keycode', 3) };
    case 'text':
      return need('value', 'ข้อความ') ?? { t, value: v.value ?? '' };
    case 'wait':
      return { t, ms: n('ms', 1000) };
    case 'launch':
      return need('packageName', 'ชื่อแพ็กเกจ') ?? { t, packageName: s('packageName') };
    case 'open_url':
      return need('url', 'URL') ?? { t, url: s('url') };
    case 'set_var':
      return need('name', 'ชื่อตัวแปร') ?? { t, name: s('name'), value: v.value ?? '' };
    case 'find_image_tap':
      return need('template', 'เทมเพลต') ?? { t, template: s('template'), threshold: n('threshold', 0.8), timeoutMs: n('timeoutMs', 8000), offset: { dx: n('dx') / 100, dy: n('dy') / 100 } };
    case 'wait_image':
      return need('template', 'เทมเพลต') ?? { t, template: s('template'), appear: b('appear'), timeoutMs: n('timeoutMs', 15000), threshold: n('threshold', 0.8) };
    case 'if_image':
      return need('template', 'เทมเพลต') ?? need('goto', 'label ปลายทาง') ?? { t, template: s('template'), found: b('found'), goto: s('goto'), threshold: n('threshold', 0.8) };
    case 'if_text': {
      const rect = parseRect(s('rect'));
      if (!rect) return 'กรอบต้องเป็น x,y,w,h เป็น % เช่น 20,65,50,3';
      return need('match', 'ข้อความที่ต้องมี') ?? need('goto', 'label ปลายทาง') ?? { t, rect, match: s('match'), found: b('found'), goto: s('goto'), digits: b('digits') || undefined };
    }
    case 'if_var':
      return need('name', 'ชื่อตัวแปร') ?? need('goto', 'label ปลายทาง') ?? { t, name: s('name'), op: (s('op') || 'eq') as Extract<MacroStep, { t: 'if_var' }>['op'], value: v.value ?? '', goto: s('goto') };
    case 'ocr_var': {
      const rect = parseRect(s('rect'));
      if (!rect) return 'กรอบต้องเป็น x,y,w,h เป็น % เช่น 20,65,50,3';
      return need('name', 'ชื่อตัวแปร') ?? { t, rect, name: s('name'), digits: b('digits') || undefined };
    }
    case 'label':
      return need('name', 'ชื่อ label') ?? { t, name: s('name') };
    case 'goto':
      return need('label', 'label ปลายทาง') ?? { t, label: s('label'), maxTimes: n('maxTimes', 100) };
    case 'run_macro':
      return need('macroId', 'มาโคร') ?? { t, macroId: s('macroId') };
    case 'volume':
      return { t, stream: (s('stream') || 'media') as VolumeStream, percent: n('percent', 50) };
    case 'stop':
      return { t, message: s('message') || undefined };
    case 'fail':
      return { t, message: s('message') || undefined };
    case 'vlm_tap':
      return need('query', 'คำบรรยายสิ่งที่จะแตะ') ?? { t, query: s('query'), timeoutMs: n('timeoutMs', 30000), learn: b('learn') ? undefined : false };
    case 'vlm_var':
      return need('question', 'คำถาม') ?? need('name', 'ชื่อตัวแปร') ?? { t, question: s('question'), name: s('name') };
    case 'if_screen':
      return need('screen', 'ชื่อหน้า') ?? need('goto', 'label ปลายทาง') ?? { t, screen: s('screen'), found: b('found'), goto: s('goto') };
    case 'wait_screen':
      return need('screen', 'ชื่อหน้า') ?? { t, screen: s('screen'), timeoutMs: n('timeoutMs', 60000) };
    case 'screen_var':
      return need('name', 'ชื่อตัวแปร') ?? { t, name: s('name') };
    case 'find_tap':
      return 'เพิ่มขั้นตอนนี้จากปุ่ม “หา element จากจอตอนนี้”';
  }
}

// ─────────────────────────── หน้าต่าง ───────────────────────────

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
  let profiles: DeviceProfile[] = [];
  let run: MacroRunState = { running: false, serials: [], progress: {}, loopsTotal: 1, log: [] };
  let recording: { recording: boolean; serial?: string; steps: number } = { recording: false, steps: 0 };
  let tab: 'macros' | 'profiles' | 'templates' | 'schedules' = 'macros';
  let openMacroId: string | null = null;
  let uiNodes: UiNodeView[] | null = null;
  const targets = new Set<string>(activeSerials);
  let loops = 1;
  let newName = '';
  let logFilter: string | 'all' = 'all';

  // เทมเพลต + ภาพหน้าจอ
  let templateSets: string[] = [];
  let currentSet = '';
  let templateItems: Array<TemplateInfo & { dataUrl: string | null }> = [];
  let preview: ScreenshotPreview | null = null;
  let sel: FracRect | null = null;
  let shotSerial: string | null = selectedSerial;
  let testResult = '';

  // ตา AI + แค็ตตาล็อกหน้าจอ
  let vlmStatus: VlmStatus | null = null;
  let screens: Array<ScreenEntry & { thumb: string | null }> = [];
  let aiQuery = '';
  let aiBusy = false;

  // ฟอร์มขั้นตอน
  let addType: MacroStepType = 'find_image_tap';
  let addValues: Record<string, string> = {};
  let insertAt = -1; // -1 = ต่อท้าย

  const nameOf = (serial: string): string => devices.find((d) => d.serial === serial)?.model ?? serial;
  const openMacro = (): MacroView | undefined => macros.find((m) => m.id === openMacroId);

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
    [macros, schedules, recording, profiles, templateSets, run] = await Promise.all([
      api.macroList(),
      api.scheduleList(),
      api.macroRecordingState(),
      api.profileList(),
      api.templateSets(),
      api.macroRunState(),
    ]);
    if (!currentSet && templateSets.length > 0) currentSet = templateSets[0];
    await reloadTemplates();
    render();
    // สถานะ Ollama เช็คทีหลัง (คำขอเครือข่าย) — ไม่ให้หน้าต่างรอ
    vlmStatus = await api.vlmStatus().catch(() => null);
    render();
  }
  async function reloadTemplates(): Promise<void> {
    const set = openMacro()?.templateSet || currentSet;
    [templateItems, screens] = set ? await Promise.all([api.templateList(set), api.screenList(set).catch(() => [])]) : [[], []];
  }
  /** ชุดที่ใช้อยู่ = ชื่อเกม — ทั้งเทมเพลตและแค็ตตาล็อกหน้าจอใช้กุญแจเดียวกัน */
  const activeSet = (): string => openMacro()?.templateSet || currentSet;

  // ─────────────────────────── การกระทำ ───────────────────────────

  async function startRecording(): Promise<void> {
    if (!selectedSerial) return log('warn', 'เลือกเครื่องก่อน');
    if (!activeSerials.includes(selectedSerial)) return log('warn', 'เปิดมิเรอร์ของเครื่องที่เลือกก่อน แล้วค่อยบันทึก');
    try {
      await api.macroRecordStart(selectedSerial, newName);
      newName = '';
      close();
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
  async function saveMacro(m: MacroView): Promise<void> {
    await api.macroSave(m);
    macros = await api.macroList();
    render();
  }
  async function createEmptyMacro(): Promise<void> {
    const d = devices.find((x) => x.serial === selectedSerial);
    const m: MacroView = {
      id: crypto.randomUUID(),
      name: newName.trim() || `มาโครใหม่ ${new Date().toLocaleTimeString('th-TH')}`,
      recordedOn: { serial: selectedSerial ?? '-', width: d?.screenWidth ?? 1080, height: d?.screenHeight ?? 2340 },
      steps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      templateSet: currentSet || undefined,
    };
    newName = '';
    await api.macroSave(m);
    openMacroId = m.id;
    await reload();
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
  async function takeShot(): Promise<void> {
    const serial = shotSerial ?? selectedSerial;
    if (!serial) return log('warn', 'เลือกเครื่องที่จะถ่ายจอ');
    try {
      preview = await api.screenshotPreview(serial);
      sel = null;
      testResult = '';
    } catch (err) {
      log('error', err instanceof Error ? err.message : String(err));
    }
    render();
  }
  async function saveSelAsTemplate(): Promise<string | null> {
    if (!preview || !sel) {
      log('warn', 'ถ่ายจอแล้วลากกรอบรอบสิ่งที่ต้องการก่อน');
      return null;
    }
    const set = openMacro()?.templateSet || currentSet || window.prompt('ชื่อชุดเทมเพลต (เช่น ชื่อเกม)', 'game');
    if (!set) return null;
    const name = window.prompt('ชื่อเทมเพลต (เช่น mail, close_x, claim)', '');
    if (!name) return null;
    try {
      await api.templateSaveFromPreview(preview.serial, set, name, sel);
      currentSet = set;
      const m = openMacro();
      if (m && !m.templateSet) await api.macroSave({ ...m, templateSet: set });
      await reload();
      log('info', `บันทึกเทมเพลต ${set}/${name}`);
      return name;
    } catch (err) {
      log('error', err instanceof Error ? err.message : String(err));
      return null;
    }
  }
  async function testTemplate(set: string, name: string): Promise<void> {
    const serial = shotSerial ?? selectedSerial;
    if (!serial) return log('warn', 'เลือกเครื่องก่อน');
    testResult = `กำลังหา ${name}…`;
    render();
    try {
      const r = await api.templateTest(serial, set, name);
      testResult = r ? `${name}: ใกล้สุด ${Math.round(r.score * 100)}% ที่ (${pct(r.fx)}, ${pct(r.fy)})` : `${name}: ไม่พบ`;
    } catch (err) {
      testResult = err instanceof Error ? err.message : String(err);
    }
    render();
  }
  async function testOcr(digits: boolean): Promise<void> {
    const serial = shotSerial ?? selectedSerial;
    if (!serial || !sel) return log('warn', 'ถ่ายจอแล้วลากกรอบรอบข้อความก่อน');
    testResult = 'กำลังอ่าน…';
    render();
    try {
      const r = await api.ocrTest(serial, sel, digits);
      testResult = `อ่านได้ "${r.text}" (มั่นใจ ${r.confidence}% · ${r.tookMs}ms)`;
    } catch (err) {
      testResult = err instanceof Error ? err.message : String(err);
    }
    render();
  }
  /** ให้ AI หาสิ่งที่พิมพ์บนภาพที่ preview ไว้ — เจอแล้ววาดกรอบให้ (ใช้ต่อเป็นเทมเพลตได้เลย) */
  async function aiLocate(): Promise<void> {
    if (aiBusy) return; // กด Enter รัว → ไม่ยิงซ้ำ
    const serial = preview?.serial ?? shotSerial ?? selectedSerial;
    if (!serial) return log('warn', 'เลือกเครื่องก่อน');
    if (!aiQuery.trim()) return log('warn', 'พิมพ์สิ่งที่จะให้ AI หาก่อน เช่น close button');
    if (!preview) await takeShot();
    aiBusy = true;
    testResult = `AI กำลังหา "${aiQuery}"… (5-20 วิ, ครั้งแรกโหลดโมเดลนานกว่า)`;
    render();
    try {
      const r = await api.vlmLocate(serial, aiQuery);
      if (r.found && r.rect) {
        sel = r.rect;
        testResult = `AI เจอ "${r.label ?? aiQuery}" ที่ (${pct(r.rect.fx + r.rect.fw / 2)}, ${pct(r.rect.fy + r.rect.fh / 2)}) · ${r.tookMs}ms — วาดกรอบให้แล้ว`;
      } else testResult = `AI ไม่เห็น "${aiQuery}" บนจอนี้ (${r.tookMs}ms)`;
    } catch (err) {
      testResult = err instanceof Error ? err.message : String(err);
    }
    aiBusy = false;
    render();
  }
  /** ให้ AI ตั้งชื่อหน้า + บอกปุ่ม แล้วจำเข้าแค็ตตาล็อกของชุดปัจจุบัน */
  async function aiDescribe(): Promise<void> {
    if (aiBusy) return;
    const serial = preview?.serial ?? shotSerial ?? selectedSerial;
    if (!serial) return log('warn', 'เลือกเครื่องก่อน');
    if (!preview) await takeShot();
    const set = activeSet() || window.prompt('ชื่อเกม/ชุด สำหรับเก็บหน้าจอที่จำได้', 'game');
    if (!set) return;
    aiBusy = true;
    testResult = 'AI กำลังอ่านหน้าจอ… (10-30 วิ)';
    render();
    try {
      const r = await api.vlmDescribe(serial, set);
      currentSet = set;
      testResult = `หน้า "${r.screen}" — ${r.elements.length} ปุ่ม: ${r.elements.slice(0, 8).map((e) => e.label).join(', ')}${r.elements.length > 8 ? '…' : ''} (${r.tookMs}ms) — จำไว้ในชุด ${set} แล้ว`;
      await reloadTemplates();
    } catch (err) {
      testResult = err instanceof Error ? err.message : String(err);
    }
    aiBusy = false;
    render();
  }
  async function addStep(): Promise<void> {
    const m = openMacro();
    if (!m) return;
    const built = buildStep(addType, addValues);
    if (typeof built === 'string') return log('warn', built);
    const steps = [...m.steps];
    const at = insertAt < 0 || insertAt > steps.length ? steps.length : insertAt;
    steps.splice(at, 0, { ...built, atMs: 0 });
    addValues = {};
    insertAt = -1;
    await saveMacro({ ...m, steps });
  }

  // ─────────────────────────── ชิ้นส่วน UI ───────────────────────────

  function shotPanel(): string {
    const activeDevices = devices.filter((d) => d.state === 'device');
    return `
      <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">
        <div style="flex:0 0 auto">
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
            <select class="text-input" id="shot-serial" style="width:134px">${activeDevices.map((d) => `<option value="${esc(d.serial)}" ${d.serial === (shotSerial ?? selectedSerial) ? 'selected' : ''}>${esc(d.model ?? d.serial)}</option>`).join('')}</select>
            <button class="xpbtn" id="shot-take">ถ่ายจอ</button>
          </div>
          ${
            preview
              ? `<div id="shot-box" style="position:relative;display:inline-block;user-select:none;cursor:crosshair;border:1px solid #8e8fa2">
                   <img src="${preview.dataUrl}" style="display:block;width:200px" draggable="false" />
                   <div id="shot-sel" style="position:absolute;border:2px solid #f0c040;background:rgba(240,192,64,.18);pointer-events:none;${sel ? `left:${sel.fx * 100}%;top:${sel.fy * 100}%;width:${sel.fw * 100}%;height:${sel.fh * 100}%` : 'display:none'}"></div>
                 </div>
                 <div style="font-size:10px;color:var(--ink-dim);margin-top:4px">${preview.width}×${preview.height} · ${sel ? `กรอบ ${rectText(sel)}` : 'ลากกรอบรอบปุ่ม/ข้อความ'}</div>`
              : `<div class="found sunken" style="width:200px;height:110px;display:flex;align-items:center;justify-content:center;color:var(--ink-dim);font-size:10px">กด “ถ่ายจอ” เพื่อดูหน้าจอตอนนี้</div>`
          }
        </div>
        <div class="shot-actions" style="display:flex;flex-direction:column;gap:6px;flex:1 1 150px;min-width:0">
          <button class="xpbtn" id="shot-save-tpl" ${sel ? '' : 'disabled'}>บันทึกกรอบเป็นเทมเพลต…</button>
          <div style="display:flex;gap:6px"><button class="xpbtn" id="shot-ocr" ${sel ? '' : 'disabled'}>ทดสอบอ่านข้อความ</button><button class="xpbtn" id="shot-ocr-d" ${sel ? '' : 'disabled'}>อ่านตัวเลข</button></div>
          <button class="xpbtn" id="shot-use-rect" ${sel ? '' : 'disabled'}>ใช้กรอบนี้ในฟอร์มขั้นตอน</button>
          <div style="display:flex;gap:6px;align-items:center;margin-top:2px">
            <span style="font-size:10px;white-space:nowrap">ตา AI ${vlmStatus === null ? '<span style="color:var(--ink-dim)">(กำลังเช็ค…)</span>' : vlmStatus.ok ? '<span class="chip chip--ready">พร้อม</span>' : `<span class="chip chip--pairing" title="${esc(vlmStatus.message)}">ไม่พร้อม</span>`}</span>
            <input class="text-input" id="ai-query" value="${esc(aiQuery)}" placeholder="บรรยายสิ่งที่จะหา เช่น close button" style="flex:1;min-width:0" ${aiBusy ? 'disabled' : ''} />
            <button class="xpbtn" id="ai-locate" ${aiBusy || !vlmStatus?.ok ? 'disabled' : ''}>AI หา</button>
          </div>
          <button class="xpbtn" id="ai-describe" ${aiBusy || !vlmStatus?.ok ? 'disabled' : ''} title="ตั้งชื่อหน้า + บอกปุ่มทั้งหมด แล้วจำเข้าแค็ตตาล็อกของชุดนี้">AI อ่านหน้าจอทั้งหน้าแล้วจำไว้</button>
          ${testResult ? `<div style="font-size:10px;padding:5px 7px;background:#fff9e3;border:1px solid #e0c060;border-radius:3px;word-break:break-word">${esc(testResult)}</div>` : ''}
          ${vlmStatus && !vlmStatus.ok ? `<div style="font-size:10px;color:#8a6508;line-height:1.5">${esc(vlmStatus.message)}</div>` : ''}
          <div style="font-size:10px;color:var(--ink-dim);line-height:1.6">เทมเพลตตัดจากจอเครื่องไหนก็ได้ — ตอนเล่นบนเครื่องอื่นระบบสเกลให้ตามความกว้างจอเอง · AI = โมเดลภาพใน Ollama บนเครื่องนี้ ช้ากว่าเทมเพลตมากแต่ไม่ต้องตัดภาพเอง และจำหน้าที่เคยเห็นไว้</div>
        </div>
      </div>`;
  }

  /** หน้าจอที่ AI จำได้ในชุดนี้ */
  function screensPanel(): string {
    const set = activeSet();
    return `
      <div class="gbox">
        <div class="gbox__title">หน้าจอที่ AI จำได้ในชุด ${esc(set || '—')} (${screens.length})</div>
        <div style="display:grid;grid-template-columns:auto 1fr auto auto;gap:6px 10px;align-items:center;font-size:10px;margin-bottom:8px">
          <span>โมเดล</span>
          <div style="display:flex;gap:6px"><input class="text-input" id="vlm-model" list="vlm-models" value="${esc(vlmStatus?.settings.model ?? 'qwen3-vl:4b')}" style="flex:1" /><datalist id="vlm-models">${(vlmStatus?.models ?? []).map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist></div>
          <span>ภาพกว้าง <input class="text-input" id="vlm-width" type="number" min="240" max="1600" step="20" value="${vlmStatus?.settings.imageWidth ?? 540}" style="width:60px" /> px</span>
          <button class="xpbtn" id="vlm-save">บันทึก/เช็คใหม่</button>
        </div>
        <div style="font-size:10px;color:${vlmStatus?.ok ? 'var(--ink-dim)' : '#8a6508'};margin-bottom:8px">${esc(vlmStatus?.message ?? 'กำลังเช็ค Ollama…')}${vlmStatus?.ok ? ' · ต้องเปิด Ollama ไว้ · โมเดลสาย instruct เร็วกว่าสาย thinking' : ''}</div>
        <div class="found sunken">
          ${
            screens.length === 0
              ? `<div class="found__empty">ยังไม่มี — กด “AI อ่านหน้าจอทั้งหน้าแล้วจำไว้” หรือใช้ขั้นตอน AI ในมาโคร แล้วหน้าที่เห็นจะถูกจำที่นี่ (ครั้งต่อไปไม่ต้องถาม AI)</div>`
              : screens
                  .map(
                    (e) => `<div class="found__row">
                      ${e.thumb ? `<img src="${e.thumb}" style="height:44px;width:auto;background:#fff;border:1px solid #c5c7d4" />` : ''}
                      <div class="found__text"><div class="found__name">${esc(e.name)}</div><div class="found__sub">${e.elements.length} ปุ่ม: ${esc(e.elements.slice(0, 6).map((x) => x.label).join(', '))}${e.elements.length > 6 ? '…' : ''} · เห็น ${e.seen} ครั้ง · ลายเซ็น ${e.hashes.length}</div></div>
                      <button class="xpbtn" data-sren="${esc(e.id)}">ชื่อ</button>
                      <button class="xpbtn" data-sdel2="${esc(e.id)}">ลบ</button>
                    </div>`,
                  )
                  .join('')
          }
        </div>
      </div>`;
  }

  function fieldInput(f: Field, m: MacroView): string {
    const val = addValues[f.k] ?? f.d ?? '';
    const id = `af-${f.k}`;
    switch (f.kind) {
      case 'num':
        return `<input class="text-input" id="${id}" type="number" step="any" value="${esc(val)}" style="width:90px" />`;
      case 'text':
        return `<input class="text-input" id="${id}" value="${esc(val)}" style="width:100%" />`;
      case 'bool':
        return `<div class="switch" id="${id}" data-bool="${f.k}">${check(val === 'true')}</div>`;
      case 'template':
        return `<div style="display:flex;gap:6px"><select class="text-input" id="${id}" style="flex:1"><option value="">— เลือก —</option>${templateItems.map((t) => `<option value="${esc(t.name)}" ${t.name === val ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select><button class="xpbtn" id="af-new-tpl" title="ตัดจากกรอบที่ลากไว้">＋ จากกรอบ</button></div>`;
      case 'rect':
        return `<input class="text-input" id="${id}" value="${esc(val)}" placeholder="x,y,w,h เป็น % เช่น 20,65,50,3" style="width:100%" />`;
      case 'macro':
        return `<select class="text-input" id="${id}" style="width:100%">${macros.filter((x) => x.id !== m.id).map((x) => `<option value="${esc(x.id)}" ${x.id === val ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
      case 'stream':
        return `<select class="text-input" id="${id}"><option value="media">สื่อ/เกม</option><option value="ring">เสียงเรียกเข้า</option><option value="notification">แจ้งเตือน</option><option value="alarm">นาฬิกาปลุก</option></select>`;
      case 'op':
        return `<select class="text-input" id="${id}">${['eq|เท่ากับ', 'ne|ไม่เท่ากับ', 'lt|น้อยกว่า', 'gt|มากกว่า', 'contains|มีคำว่า', 'empty|ว่าง', 'notempty|ไม่ว่าง'].map((o) => {
          const [k, l] = o.split('|');
          return `<option value="${k}" ${k === val ? 'selected' : ''}>${l}</option>`;
        }).join('')}</select>`;
      case 'label': {
        const labels = m.steps.filter((s): s is Step & { t: 'label' } => s.t === 'label').map((s) => s.name);
        return `<input class="text-input" id="${id}" list="af-labels" value="${esc(val)}" style="width:100%" /><datalist id="af-labels">${labels.map((l) => `<option value="${esc(l)}"></option>`).join('')}</datalist>`;
      }
    }
  }

  function macroEditor(m: MacroView): string {
    const varsText = Object.entries(m.vars ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
    const groups = [...new Set(STEP_TYPES.map((s) => s.group))];
    return `
      <div class="macro-editor" style="flex-basis:100%;margin-top:6px;padding:8px;background:#f3f4f9;border-radius:3px;font-size:10px;line-height:1.7;display:flex;flex-direction:column;gap:10px">

        <div style="display:grid;grid-template-columns:auto 1fr auto 1fr;gap:6px 10px;align-items:center">
          <span>ชุดเทมเพลต</span>
          <div style="display:flex;gap:6px"><input class="text-input" id="me-set" list="me-sets" value="${esc(m.templateSet ?? '')}" placeholder="เช่น dropkick" style="flex:1" /><datalist id="me-sets">${templateSets.map((s) => `<option value="${esc(s)}"></option>`).join('')}</datalist></div>
          <span>เมื่อขั้นตอนพัง</span>
          <div style="display:flex;gap:6px;align-items:center"><select class="text-input" id="me-onerr"><option value="stop" ${!m.onError || m.onError.mode === 'stop' ? 'selected' : ''}>หยุดเครื่องนั้น</option><option value="skip" ${m.onError?.mode === 'skip' ? 'selected' : ''}>ข้ามขั้นนั้น</option><option value="retry" ${m.onError?.mode === 'retry' ? 'selected' : ''}>ลองใหม่</option></select><input class="text-input" id="me-retries" type="number" min="1" value="${m.onError?.retries ?? 2}" style="width:48px" title="จำนวนครั้งที่ลองใหม่" /></div>
          <span>ตัวแปรเริ่มต้น</span>
          <textarea class="text-input" id="me-vars" rows="2" placeholder="ชื่อ=ค่า บรรทัดละตัว — โปรไฟล์เครื่องทับได้" style="width:100%;resize:vertical;font-family:inherit">${esc(varsText)}</textarea>
          <span>เหมือนคน</span>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><label><input type="checkbox" id="me-hum" ${m.humanize ? 'checked' : ''}/> เปิด</label> เขย่า <input class="text-input" id="me-jit" type="number" step="0.1" value="${((m.humanize?.jitter ?? 0.006) * 100).toFixed(1)}" style="width:48px" />% หน่วง <input class="text-input" id="me-d0" type="number" value="${m.humanize?.delayMs[0] ?? 150}" style="width:56px" />–<input class="text-input" id="me-d1" type="number" value="${m.humanize?.delayMs[1] ?? 600}" style="width:56px" /> ms</div>
        </div>
        <div><button class="xpbtn" id="me-save-settings">บันทึกการตั้งค่า</button></div>

        <div class="found sunken" style="max-height:220px;overflow-y:auto">
          ${
            m.steps.length === 0
              ? `<div class="found__empty">ยังไม่มีขั้นตอน — เพิ่มจากด้านล่าง หรือบันทึกจากจอมิเรอร์</div>`
              : m.steps
                  .map(
                    (s, i) => `<div class="found__row" style="padding:2px 6px;gap:6px">
                      <span style="width:22px;color:var(--ink-dim)">${i + 1}.</span>
                      <div class="found__text" style="${s.t === 'label' ? 'font-weight:600' : ''}">${esc(stepLabel(s))}${s.atMs ? ` <span style="color:var(--ink-dim)">@${(s.atMs / 1000).toFixed(1)}s</span>` : ''}</div>
                      <button class="xpbtn" data-ins="${i}" title="แทรกก่อนขั้นนี้" style="padding:0 5px">⤴</button>
                      <button class="xpbtn" data-up="${i}" style="padding:0 5px" ${i === 0 ? 'disabled' : ''}>↑</button>
                      <button class="xpbtn" data-down="${i}" style="padding:0 5px" ${i === m.steps.length - 1 ? 'disabled' : ''}>↓</button>
                      <button class="xpbtn" data-rm="${i}" style="padding:0 5px">✕</button>
                    </div>`,
                  )
                  .join('')
          }
        </div>

        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px">
          <div style="min-width:0">
            <div style="font-weight:600;margin-bottom:4px">เพิ่มขั้นตอน ${insertAt >= 0 ? `(แทรกก่อนขั้น ${insertAt + 1} <a href="#" id="af-append">ต่อท้ายแทน</a>)` : '(ต่อท้าย)'}</div>
            <select class="text-input" id="af-type" style="width:100%;margin-bottom:6px">
              ${groups.map((g) => `<optgroup label="${esc(g)}">${STEP_TYPES.filter((s) => s.group === g).map((s) => `<option value="${s.t}" ${s.t === addType ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</optgroup>`).join('')}
            </select>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:5px 8px;align-items:center">
              ${(FIELDS[addType] ?? []).map((f) => `<span>${esc(f.l)}</span>${fieldInput(f, m)}`).join('')}
            </div>
            <div style="display:flex;gap:6px;margin-top:8px;align-items:center">
              <button class="gel" id="af-add" style="height:23px;padding:0 14px">เพิ่ม</button>
              <button class="xpbtn" data-ui="${esc(m.id)}">หา element จากจอตอนนี้</button>
            </div>
            ${
              uiNodes !== null
                ? `<div class="found sunken" style="margin-top:6px;max-height:140px;overflow-y:auto">
                     ${uiNodes.length === 0 ? `<div class="found__empty">ไม่มี element ที่เลือกได้ (เกมที่วาดเองจะไม่มี — ใช้ “หาภาพ” แทน)</div>` : uiNodes.slice(0, 80).map((n, i) => `<div class="found__row" data-node="${i}" style="cursor:pointer;padding:3px 6px"><div class="found__text"><div class="found__name">${esc(n.text || n.contentDesc || n.resourceId.split('/').pop() || n.className.split('.').pop())}</div><div class="found__sub">${esc(n.resourceId || n.className)}</div></div>${n.clickable ? `<span class="chip chip--ready">กดได้</span>` : ''}</div>`).join('')}
                   </div>`
                : ''
            }
          </div>
          <div style="min-width:0">
            <div style="font-weight:600;margin-bottom:4px">ภาพหน้าจอ / เทมเพลต</div>
            ${shotPanel()}
            ${
              templateItems.length > 0
                ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px">${templateItems.map((t) => `<div style="display:flex;align-items:center;gap:3px;border:1px solid #c5c7d4;background:#fff;padding:2px 4px;border-radius:3px">${t.dataUrl ? `<img src="${t.dataUrl}" style="height:22px;max-width:60px;object-fit:contain" />` : ''}<span>${esc(t.name)}</span><a href="#" data-ttest="${esc(t.name)}" title="ลองหาบนจอตอนนี้">ทดสอบ</a></div>`).join('')}</div>`
                : ''
            }
          </div>
        </div>
      </div>`;
  }

  function macroRow(m: MacroView): string {
    const open = openMacroId === m.id;
    return `
      <div class="found__row" style="flex-wrap:wrap">
        <div class="found__text" data-open="${esc(m.id)}" style="cursor:pointer">
          <div class="found__name">${esc(m.name)}</div>
          <div class="found__sub">${m.steps.length} ขั้นตอน${m.templateSet ? ` · เทมเพลต ${esc(m.templateSet)}` : ''}${Object.keys(m.vars ?? {}).length ? ` · ตัวแปร ${Object.keys(m.vars ?? {}).join(', ')}` : ''}</div>
        </div>
        <button class="gel" data-play="${esc(m.id)}" style="height:23px;padding:0 14px"${run.running ? ' disabled' : ''}>เล่น</button>
        <button class="xpbtn" data-rename="${esc(m.id)}">ชื่อ</button>
        <button class="xpbtn" data-dup="${esc(m.id)}" title="ทำสำเนา">สำเนา</button>
        <button class="xpbtn" data-del="${esc(m.id)}">ลบ</button>
        ${open ? macroEditor(m) : ''}
      </div>`;
  }

  function progressPanel(): string {
    if (!run.running && Object.keys(run.progress).length === 0) return '';
    const shown = run.log.filter((e) => logFilter === 'all' || e.serial === logFilter).slice(-40).reverse();
    return `
      <div class="gbox" style="margin-top:0">
        <div class="gbox__title">${run.running ? 'กำลังเล่น' : 'ผลรอบล่าสุด'} — ${esc(run.macroName ?? '')}</div>
        ${Object.entries(run.progress)
          .map(([serial, p]) => {
            const done = p.total ? Math.round((p.step / p.total) * 100) : 0;
            return `<div style="display:flex;align-items:center;gap:8px;padding:3px 0">
              <span style="width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(nameOf(serial))}</span>
              <div class="progress sunken" style="flex:1"><div class="progress__fill" style="width:${done}%;${p.error ? 'filter:hue-rotate(-100deg)' : ''}"></div></div>
              <span style="width:240px;font-size:10px;color:${p.error ? '#a5301f' : 'var(--ink-dim)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(p.error ?? p.note ?? '')}">${p.error ? esc(p.error) : `${p.step}/${p.total} รอบ ${p.loop}/${run.loopsTotal}${p.note ? ` · ${esc(p.note)}` : ''}`}</span>
            </div>`;
          })
          .join('')}
        <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
          ${run.running ? `<button class="xpbtn" id="mc-stop">หยุดเล่น</button>` : ''}
          <span style="flex:1"></span>
          <span style="font-size:10px;color:var(--ink-dim)">บันทึกของ</span>
          <select class="text-input" id="mc-logfilter" style="width:140px"><option value="all">ทุกเครื่อง</option>${run.serials.map((s) => `<option value="${esc(s)}" ${logFilter === s ? 'selected' : ''}>${esc(nameOf(s))}</option>`).join('')}</select>
        </div>
        <div class="found sunken" style="max-height:120px;overflow-y:auto;margin-top:4px;font-size:10px;font-family:Consolas,monospace">
          ${shown.length === 0 ? `<div class="found__empty">—</div>` : shown.map((e) => `<div style="padding:1px 6px;color:${e.level === 'error' ? '#a5301f' : e.level === 'warn' ? '#8a6508' : 'inherit'}">${new Date(e.at).toLocaleTimeString('th-TH')} <b>${esc(nameOf(e.serial).slice(0, 14))}</b> ${esc(e.message)}</div>`).join('')}
        </div>
      </div>`;
  }

  function profilesTab(): string {
    const serials = [...new Set([...devices.filter((d) => d.state === 'device').map((d) => d.serial), ...profiles.map((p) => p.serial)])];
    return `
      <div class="gbox">
        <div class="gbox__title">โปรไฟล์ต่อเครื่อง</div>
        <div style="font-size:10px;color:var(--ink-dim);margin-bottom:8px;line-height:1.6">มาโครเดียวกันเขียน <code>{{username}}</code> ไว้ แต่ละเครื่องแทนค่าของตัวเองจากตรงนี้ — ทำให้ “เครื่องใครเครื่องมัน” ได้โดยไม่ต้องมีมาโครแยก · เสียงตั้งให้ก่อนเริ่มเล่นทุกครั้ง</div>
        ${
          serials.length === 0
            ? `<div class="found__empty">ยังไม่มีเครื่อง</div>`
            : serials
                .map((serial) => {
                  const p = profiles.find((x) => x.serial === serial) ?? { serial, vars: {}, enabled: true };
                  const varsText = Object.entries(p.vars).map(([k, v]) => `${k}=${v}`).join('\n');
                  const online = devices.some((d) => d.serial === serial && d.state === 'device');
                  return `<div class="found__row" style="flex-wrap:wrap;gap:6px;align-items:flex-start" data-prow="${esc(serial)}">
                    <div style="width:170px">
                      <div class="found__name">${esc(nameOf(serial))}${online ? '' : ' <span style="color:var(--ink-dim)">(ออฟไลน์)</span>'}</div>
                      <div class="found__sub">${esc(serial)}</div>
                      <div class="switch" data-pen="${esc(serial)}" style="margin-top:4px">${check(p.enabled !== false)}<span>เข้าร่วมเล่นมาโคร</span></div>
                      <input class="text-input" data-plabel="${esc(serial)}" value="${esc(p.label ?? '')}" placeholder="ชื่อเล่น เช่น บัญชี A" style="width:100%;margin-top:4px" />
                    </div>
                    <textarea class="text-input" data-pvars="${esc(serial)}" rows="3" placeholder="username=alpha&#10;server=3" style="flex:1;min-width:160px;resize:vertical;font-family:inherit">${esc(varsText)}</textarea>
                    <div style="display:flex;flex-direction:column;gap:4px;width:150px">
                      <label style="display:flex;gap:4px;align-items:center">เสียงเกม <input class="text-input" data-pvol="${esc(serial)}" type="number" min="0" max="100" value="${p.volume?.media ?? ''}" placeholder="—" style="width:52px" />%</label>
                      <div style="display:flex;gap:4px"><button class="gel" data-psave="${esc(serial)}" style="height:23px;padding:0 10px">บันทึก</button><button class="xpbtn" data-pvolnow="${esc(serial)}" ${online ? '' : 'disabled'} title="ตั้งเสียงเดี๋ยวนี้">🔊 เดี๋ยวนี้</button></div>
                      ${profiles.some((x) => x.serial === serial) ? `<button class="xpbtn" data-pdel="${esc(serial)}">ล้างโปรไฟล์</button>` : ''}
                    </div>
                  </div>`;
                })
                .join('')
        }
      </div>`;
  }

  function templatesTab(): string {
    return `
      <div class="gbox">
        <div class="gbox__title">ชุดเทมเพลต</div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
          <input class="text-input" id="tt-set" list="tt-sets" value="${esc(currentSet)}" placeholder="ชื่อชุด เช่น dropkick" style="width:200px" /><datalist id="tt-sets">${templateSets.map((s) => `<option value="${esc(s)}"></option>`).join('')}</datalist>
          <button class="xpbtn" id="tt-open">เปิดชุด</button>
          <span style="font-size:10px;color:var(--ink-dim)">ไฟล์อยู่ในโฟลเดอร์ข้อมูลแอป → templates/&lt;ชุด&gt; ก็อปไปเครื่องอื่นได้</span>
        </div>
        ${shotPanel()}
      </div>
      <div class="gbox">
        <div class="gbox__title">เทมเพลตในชุด ${esc(currentSet || '—')} (${templateItems.length})</div>
        <div class="found sunken">
          ${
            templateItems.length === 0
              ? `<div class="found__empty">ยังไม่มี — ถ่ายจอ ลากกรอบ แล้วกด “บันทึกกรอบเป็นเทมเพลต”</div>`
              : templateItems
                  .map(
                    (t) => `<div class="found__row">
                      ${t.dataUrl ? `<img src="${t.dataUrl}" style="height:34px;max-width:90px;object-fit:contain;background:#fff;border:1px solid #c5c7d4" />` : ''}
                      <div class="found__text"><div class="found__name">${esc(t.name)}</div><div class="found__sub">${t.width}×${t.height}px จากจอ ${t.refWidth}×${t.refHeight} · ที่ (${pct(t.rect.fx)}, ${pct(t.rect.fy)})</div></div>
                      <button class="xpbtn" data-ttest="${esc(t.name)}">ทดสอบบนจอ</button>
                      <button class="xpbtn" data-tdel="${esc(t.name)}">ลบ</button>
                    </div>`,
                  )
                  .join('')
          }
        </div>
      </div>
      ${screensPanel()}`;
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
        <div class="switch" data-toggle="${esc(s.id)}">${check(s.enabled)}</div>
        <div class="found__text">
          <div class="found__name">${esc(s.name)}</div>
          <div class="found__sub">${esc(when)} · ${esc(macros.find((m) => m.id === s.macroId)?.name ?? '(มาโครถูกลบ)')} · ${s.serials.length} เครื่อง · ${s.loops} รอบ${s.lastResult ? ` · ล่าสุด: ${esc(s.lastResult)}` : ''}</div>
        </div>
        <button class="xpbtn" data-sdel="${esc(s.id)}">ลบ</button>
      </div>`;
  }

  function schedulesTab(): string {
    return `
      <div class="gbox">
        <div class="gbox__title">เพิ่มรายการ</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <input class="text-input" id="sc-name" placeholder="ชื่องาน" />
          <select class="text-input" id="sc-macro">${macros.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select>
          <select class="text-input" id="sc-mode"><option value="daily">ทุกวันเวลา</option><option value="interval">ทุกๆ กี่นาที</option><option value="once">ครั้งเดียว</option></select>
          <input class="text-input" id="sc-when" placeholder="เช่น 08:30 · หรือ 30 (นาที) · หรือ 2026-09-10 08:30" />
          <div style="grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center">
            <span style="color:var(--ink-dim)">เครื่อง:</span>
            ${devices.filter((d) => d.state === 'device').map((d) => `<div class="switch" data-starget="${esc(d.serial)}">${check(targets.has(d.serial))}<span>${esc(d.model ?? d.serial)}</span></div>`).join('')}
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
      </div>`;
  }

  function macrosTab(): string {
    const activeDevices = devices.filter((d) => activeSerials.includes(d.serial));
    return `
      <div class="gbox">
        <div class="gbox__title">สร้างใหม่</div>
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
                 <button class="xpbtn" id="mc-new-empty">สร้างเปล่า (เขียนขั้นตอนเอง)</button>
               </div>
               <div style="font-size:10px;color:var(--ink-dim);margin-top:6px">บันทึก = ทุกอย่างที่กดบนจอมิเรอร์ถูกจด · สร้างเปล่า = ประกอบขั้นตอนจากฟอร์ม (หาภาพ เงื่อนไข ตัวแปร)</div>`
        }
      </div>

      <div class="gbox">
        <div class="gbox__title">เล่นบนเครื่องไหน (${targets.size})</div>
        ${
          activeDevices.length === 0
            ? `<div style="color:var(--ink-dim)">ยังไม่มีเครื่องที่เปิดเซสชันอยู่ — เปิดมิเรอร์ก่อน แล้วเครื่องจะโผล่ให้เลือกที่นี่ (เลือกได้หลายเครื่องพร้อมกัน)</div>`
            : `<div style="display:flex;flex-wrap:wrap;gap:6px 14px">
                 ${activeDevices.map((d) => `<div class="switch" data-target="${esc(d.serial)}">${check(targets.has(d.serial))}<span>${esc(d.model ?? d.serial)}${profiles.find((p) => p.serial === d.serial)?.label ? ` <span style="color:var(--ink-dim)">(${esc(profiles.find((p) => p.serial === d.serial)?.label)})</span>` : ''}</span></div>`).join('')}
                 <span style="flex:1"></span>
                 <label style="display:flex;align-items:center;gap:6px">วน <input class="text-input" id="mc-loops" type="number" min="1" max="9999" value="${loops}" style="width:56px" /> รอบ</label>
               </div>`
        }
      </div>

      ${progressPanel()}

      <div class="gbox">
        <div class="gbox__title">มาโครที่มี</div>
        <div class="found sunken">
          ${macros.length === 0 ? `<div class="found__empty">ยังไม่มี — บันทึกหรือสร้างเปล่าจากด้านบน</div>` : macros.map(macroRow).join('')}
        </div>
      </div>`;
  }

  function render(): void {
    backdrop.innerHTML = `
      <div class="modal metal-tall" role="dialog" style="width:820px;max-width:96vw">
        <div class="titlebar metal" style="-webkit-app-region:no-drag">
          <div class="titlebar__text">มาโคร · โปรไฟล์เครื่อง · เทมเพลต · ตั้งเวลา</div>
          <div class="titlebar__buttons"><div class="capbtn capbtn--close" id="mc-close" title="ปิด"><svg width="9" height="9" viewBox="0 0 10 10" stroke="#fff" stroke-width="1.9" stroke-linecap="round"><line x1="1.6" y1="1.6" x2="8.4" y2="8.4"></line><line x1="8.4" y1="1.6" x2="1.6" y2="8.4"></line></svg></div></div>
        </div>
        <div class="modal__body" style="max-height:78vh;overflow-y:auto">
          <div style="display:flex;gap:2px;align-items:flex-end;padding-left:3px">
            <div class="tab${tab === 'macros' ? ' act' : ''}" data-tab="macros">มาโคร (${macros.length})</div>
            <div class="tab${tab === 'profiles' ? ' act' : ''}" data-tab="profiles">โปรไฟล์เครื่อง (${profiles.length})</div>
            <div class="tab${tab === 'templates' ? ' act' : ''}" data-tab="templates">เทมเพลตภาพ</div>
            <div class="tab${tab === 'schedules' ? ' act' : ''}" data-tab="schedules">ตั้งเวลา (${schedules.length})</div>
          </div>
          <div style="margin-top:-1px;border:1px solid #8e8fa2;border-radius:0 3px 3px 3px;background:#eceef5;padding:14px;display:flex;flex-direction:column;gap:12px">
            ${tab === 'macros' ? macrosTab() : tab === 'profiles' ? profilesTab() : tab === 'templates' ? templatesTab() : schedulesTab()}
          </div>
        </div>
        <div class="modal__foot"><span style="flex:1"></span><button class="gel" id="mc-done">เสร็จสิ้น</button></div>
      </div>`;
    wire();
  }

  // ─────────────────────────── ต่อสายเหตุการณ์ ───────────────────────────

  const q = <T extends HTMLElement>(sel: string): T | null => backdrop.querySelector<T>(sel);
  const qa = <T extends HTMLElement>(sel: string): T[] => [...backdrop.querySelectorAll<T>(sel)];
  const on = (sel: string, ev: string, fn: (el: HTMLElement) => void): void => {
    qa(sel).forEach((el) => el.addEventListener(ev, () => fn(el)));
  };

  function wireShot(): void {
    on('#shot-take', 'click', () => void takeShot());
    const ss = q<HTMLSelectElement>('#shot-serial');
    ss?.addEventListener('change', () => (shotSerial = ss.value));
    on('#shot-save-tpl', 'click', () => void saveSelAsTemplate());
    on('#shot-ocr', 'click', () => void testOcr(false));
    on('#shot-ocr-d', 'click', () => void testOcr(true));
    on('#shot-use-rect', 'click', () => {
      if (!sel) return;
      addValues = { ...addValues, rect: rectText(sel) };
      if (!FIELDS[addType]?.some((f) => f.kind === 'rect')) addType = 'ocr_var';
      render();
    });
    on('[data-ttest]', 'click', (el) => void testTemplate(openMacro()?.templateSet || currentSet, el.dataset.ttest!));

    // ตา AI
    const aq = q<HTMLInputElement>('#ai-query');
    aq?.addEventListener('input', () => (aiQuery = aq.value));
    aq?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void aiLocate();
    });
    on('#ai-locate', 'click', () => void aiLocate());
    on('#ai-describe', 'click', () => void aiDescribe());

    // ลากกรอบบนภาพ
    const box = q<HTMLElement>('#shot-box');
    const selEl = q<HTMLElement>('#shot-sel');
    if (!box || !selEl) return;
    let start: { x: number; y: number } | null = null;
    const frac = (e: MouseEvent): { x: number; y: number } => {
      const r = box.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
    };
    const apply = (a: { x: number; y: number }, b: { x: number; y: number }): FracRect => ({
      fx: Math.min(a.x, b.x),
      fy: Math.min(a.y, b.y),
      fw: Math.abs(a.x - b.x),
      fh: Math.abs(a.y - b.y),
    });
    box.addEventListener('mousedown', (e) => {
      start = frac(e);
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!start) return;
      const r = apply(start, frac(e));
      selEl.style.display = 'block';
      selEl.style.left = `${r.fx * 100}%`;
      selEl.style.top = `${r.fy * 100}%`;
      selEl.style.width = `${r.fw * 100}%`;
      selEl.style.height = `${r.fh * 100}%`;
    });
    window.addEventListener('mouseup', (e) => {
      if (!start) return;
      const r = apply(start, frac(e));
      start = null;
      if (r.fw > 0.005 && r.fh > 0.005) {
        sel = r;
        render();
      }
    });
  }

  function wire(): void {
    on('#mc-close', 'click', close);
    on('#mc-done', 'click', close);
    on('[data-tab]', 'click', (t) => {
      tab = t.dataset.tab as typeof tab;
      void reloadTemplates().then(render);
    });
    const nameInput = q<HTMLInputElement>('#mc-name');
    nameInput?.addEventListener('input', () => (newName = nameInput.value));
    on('#mc-rec-start', 'click', () => void startRecording());
    on('#mc-rec-stop', 'click', () => void stopRecording());
    on('#mc-new-empty', 'click', () => void createEmptyMacro());
    on('#mc-stop', 'click', () => void api.macroStop());
    const lf = q<HTMLSelectElement>('#mc-logfilter');
    lf?.addEventListener('change', () => {
      logFilter = lf.value;
      render();
    });
    const loopsInput = q<HTMLInputElement>('#mc-loops');
    loopsInput?.addEventListener('input', () => (loops = Math.max(1, parseInt(loopsInput.value, 10) || 1)));

    on('[data-target],[data-starget]', 'click', (n) => {
      const s = n.dataset.target ?? n.dataset.starget!;
      if (targets.has(s)) targets.delete(s);
      else targets.add(s);
      render();
    });
    on('[data-open]', 'click', (n) => {
      openMacroId = openMacroId === n.dataset.open ? null : n.dataset.open!;
      uiNodes = null;
      insertAt = -1;
      void reloadTemplates().then(render);
    });
    on('[data-play]', 'click', (n) => void play(n.dataset.play!));
    on('[data-del]', 'click', (n) => {
      if (!window.confirm('ลบมาโครนี้? ย้อนกลับไม่ได้')) return;
      void api.macroDelete(n.dataset.del!).then(reload);
    });
    on('[data-rename]', 'click', (n) => {
      const m = macros.find((x) => x.id === n.dataset.rename);
      const name = window.prompt('ชื่อใหม่', m?.name ?? '');
      if (name === null) return;
      void api.macroRename(n.dataset.rename!, name).then(reload);
    });
    on('[data-dup]', 'click', (n) => {
      const m = macros.find((x) => x.id === n.dataset.dup);
      if (!m) return;
      void api.macroSave({ ...m, id: crypto.randomUUID(), name: `${m.name} (สำเนา)`, createdAt: Date.now(), updatedAt: Date.now() }).then(reload);
    });
    on('[data-ui]', 'click', () => void loadUi());
    on('[data-node]', 'click', (n) => {
      const node = uiNodes?.[parseInt(n.dataset.node!, 10)];
      const d = devices.find((x) => x.serial === selectedSerial);
      if (!node || !openMacroId || !d?.screenWidth || !d.screenHeight) return;
      const cx = (node.bounds.left + node.bounds.right) / 2;
      const cy = (node.bounds.top + node.bounds.bottom) / 2;
      void api
        .macroAddFindTap(openMacroId, {
          resourceId: node.resourceId || undefined,
          text: node.text || undefined,
          contentDesc: node.contentDesc || undefined,
          className: node.className || undefined,
          fallback: { fx: cx / d.screenWidth, fy: cy / d.screenHeight },
        })
        .then(() => {
          uiNodes = null;
          return reload();
        });
    });

    // ตัวแก้มาโคร
    const m = openMacro();
    if (m) {
      on('#me-save-settings', 'click', () => {
        const vars: Record<string, string> = {};
        for (const line of (q<HTMLTextAreaElement>('#me-vars')?.value ?? '').split('\n')) {
          const i = line.indexOf('=');
          if (i > 0) vars[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
        const mode = (q<HTMLSelectElement>('#me-onerr')?.value ?? 'stop') as NonNullable<MacroView['onError']>['mode'];
        const hum = q<HTMLInputElement>('#me-hum')?.checked;
        void saveMacro({
          ...m,
          templateSet: (q<HTMLInputElement>('#me-set')?.value ?? '').trim() || undefined,
          vars,
          onError: { mode, retries: parseInt(q<HTMLInputElement>('#me-retries')?.value ?? '2', 10) || 2 },
          humanize: hum
            ? {
                jitter: (parseFloat(q<HTMLInputElement>('#me-jit')?.value ?? '0.6') || 0.6) / 100,
                delayMs: [parseInt(q<HTMLInputElement>('#me-d0')?.value ?? '150', 10) || 0, parseInt(q<HTMLInputElement>('#me-d1')?.value ?? '600', 10) || 0],
              }
            : undefined,
        }).then(() => log('info', 'บันทึกการตั้งค่ามาโครแล้ว'));
      });
      on('[data-rm]', 'click', (el) => {
        const steps = [...m.steps];
        steps.splice(parseInt(el.dataset.rm!, 10), 1);
        void saveMacro({ ...m, steps });
      });
      on('[data-up]', 'click', (el) => {
        const i = parseInt(el.dataset.up!, 10);
        const steps = [...m.steps];
        [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
        void saveMacro({ ...m, steps });
      });
      on('[data-down]', 'click', (el) => {
        const i = parseInt(el.dataset.down!, 10);
        const steps = [...m.steps];
        [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]];
        void saveMacro({ ...m, steps });
      });
      on('[data-ins]', 'click', (el) => {
        insertAt = parseInt(el.dataset.ins!, 10);
        render();
      });
      on('#af-append', 'click', () => {
        insertAt = -1;
        render();
      });
      const typeSel = q<HTMLSelectElement>('#af-type');
      typeSel?.addEventListener('change', () => {
        addType = typeSel.value as MacroStepType;
        addValues = {};
        render();
      });
      for (const f of FIELDS[addType] ?? []) {
        const el = q<HTMLInputElement | HTMLSelectElement>(`#af-${f.k}`);
        if (!el) continue;
        if (f.kind === 'bool') {
          if (addValues[f.k] === undefined) addValues[f.k] = f.d ?? '';
          el.addEventListener('click', () => {
            addValues[f.k] = addValues[f.k] === 'true' ? '' : 'true';
            render();
          });
        } else {
          if (addValues[f.k] === undefined && f.d !== undefined) addValues[f.k] = f.d;
          el.addEventListener('input', () => (addValues[f.k] = (el as HTMLInputElement).value));
          el.addEventListener('change', () => (addValues[f.k] = (el as HTMLInputElement).value));
        }
      }
      on('#af-new-tpl', 'click', () => {
        void saveSelAsTemplate().then((name) => {
          if (name) {
            addValues = { ...addValues, template: name };
            render();
          }
        });
      });
      on('#af-add', 'click', () => void addStep());
      wireShot();
    }

    // โปรไฟล์
    on('[data-pen]', 'click', (el) => {
      const serial = el.dataset.pen!;
      const p = profiles.find((x) => x.serial === serial) ?? { serial, vars: {}, enabled: true };
      void api.profileSave({ ...p, enabled: p.enabled === false }).then(reload);
    });
    on('[data-psave]', 'click', (el) => {
      const serial = el.dataset.psave!;
      const vars: Record<string, string> = {};
      for (const line of (q<HTMLTextAreaElement>(`[data-pvars="${CSS.escape(serial)}"]`)?.value ?? '').split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) vars[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const vol = parseInt(q<HTMLInputElement>(`[data-pvol="${CSS.escape(serial)}"]`)?.value ?? '', 10);
      const prev = profiles.find((x) => x.serial === serial);
      void api
        .profileSave({
          serial,
          label: (q<HTMLInputElement>(`[data-plabel="${CSS.escape(serial)}"]`)?.value ?? '').trim() || undefined,
          vars,
          volume: Number.isFinite(vol) ? { media: vol } : undefined,
          enabled: prev?.enabled ?? true,
        })
        .then(() => {
          log('info', `บันทึกโปรไฟล์ ${nameOf(serial)}`);
          return reload();
        });
    });
    on('[data-pvolnow]', 'click', (el) => {
      const serial = el.dataset.pvolnow!;
      const vol = parseInt(q<HTMLInputElement>(`[data-pvol="${CSS.escape(serial)}"]`)?.value ?? '', 10);
      if (!Number.isFinite(vol)) return log('warn', 'ใส่ % เสียงก่อน');
      void api.volumeSet(serial, 'media', vol).then((r) => log(r.ok ? 'info' : 'warn', r.ok ? `ตั้งเสียง ${nameOf(serial)} ${vol}% แล้ว (${r.via})` : `ตั้งเสียง ${nameOf(serial)} ไม่ได้`));
    });
    on('[data-pdel]', 'click', (el) => void api.profileDelete(el.dataset.pdel!).then(reload));

    // เทมเพลต
    on('#tt-open', 'click', () => {
      currentSet = (q<HTMLInputElement>('#tt-set')?.value ?? '').trim();
      void reloadTemplates().then(render);
    });
    on('[data-tdel]', 'click', (el) => {
      if (!window.confirm(`ลบเทมเพลต "${el.dataset.tdel}"?`)) return;
      void api.templateDelete(currentSet, el.dataset.tdel!).then(() => reloadTemplates().then(render));
    });
    if (tab === 'templates') wireShot();

    // แค็ตตาล็อกหน้าจอ + ตั้งค่าโมเดล
    on('[data-sren]', 'click', (el) => {
      const e = screens.find((x) => x.id === el.dataset.sren);
      const name = window.prompt('ชื่อหน้าจอ (ใช้ใน if_screen / wait_screen)', e?.name ?? '');
      if (!name || !e) return;
      void api.screenRename(activeSet(), e.id, name).then(() => reloadTemplates().then(render));
    });
    on('[data-sdel2]', 'click', (el) => {
      const e = screens.find((x) => x.id === el.dataset.sdel2);
      if (!e || !window.confirm(`ลืมหน้า "${e.name}"? AI จะต้องอ่านใหม่เมื่อเจออีก`)) return;
      void api.screenDelete(activeSet(), e.id).then(() => reloadTemplates().then(render));
    });
    on('#vlm-save', 'click', () => {
      vlmStatus = null;
      const model = (q<HTMLInputElement>('#vlm-model')?.value ?? '').trim();
      const imageWidth = parseInt(q<HTMLInputElement>('#vlm-width')?.value ?? '', 10);
      render();
      void api
        .vlmSettingsSave({ model: model || undefined, imageWidth: Number.isFinite(imageWidth) ? imageWidth : undefined })
        .then((s) => {
          vlmStatus = s;
          log(s.ok ? 'info' : 'warn', `ตา AI: ${s.message}`);
          render();
        });
    });

    // ตั้งเวลา
    on('#sc-add', 'click', () => {
      const name = (q<HTMLInputElement>('#sc-name')?.value ?? '').trim() || 'งานตั้งเวลา';
      const macroId = q<HTMLSelectElement>('#sc-macro')?.value ?? '';
      const mode = (q<HTMLSelectElement>('#sc-mode')?.value ?? 'daily') as ScheduleView['mode'];
      const when = (q<HTMLInputElement>('#sc-when')?.value ?? '').trim();
      const scLoops = Math.max(1, parseInt(q<HTMLInputElement>('#sc-loops')?.value ?? '1', 10) || 1);
      const serials = [...targets];
      if (serials.length === 0) return log('warn', 'เลือกเครื่องอย่างน้อยหนึ่งเครื่อง');
      let at = 0;
      let everyMs: number | undefined;
      if (mode === 'daily') {
        const mm = /^(\d{1,2}):(\d{2})$/.exec(when);
        if (!mm) return log('warn', 'เวลาต้องเป็นรูปแบบ 08:30');
        at = parseInt(mm[1], 10) * 60 + parseInt(mm[2], 10);
      } else if (mode === 'interval') {
        const mins = parseInt(when, 10);
        if (!mins || mins < 1) return log('warn', 'ใส่จำนวนนาที เช่น 30');
        everyMs = mins * 60_000;
      } else {
        const t = Date.parse(when.replace(' ', 'T'));
        if (Number.isNaN(t)) return log('warn', 'วันเวลาต้องเป็นรูปแบบ 2026-09-10 08:30');
        at = t;
      }
      void api.scheduleSave({ id: crypto.randomUUID(), name, macroId, serials, mode, at, everyMs, loops: scLoops, enabled: true }).then(reload);
    });
    on('[data-toggle]', 'click', (n) => {
      const s = schedules.find((x) => x.id === n.dataset.toggle);
      if (!s) return;
      void api.scheduleSave({ ...s, enabled: !s.enabled }).then(reload);
    });
    on('[data-sdel]', 'click', (n) => void api.scheduleDelete(n.dataset.sdel!).then(reload));
  }

  render();
  void reload();
}
