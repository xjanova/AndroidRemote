/**
 * หน้าเว็บที่มือถือเปิด — ตัวจอยจริงๆ อยู่ที่นี่
 *
 * ข้อกำหนดที่ทำให้ตัดสินใจแบบนี้:
 *   · หลายนิ้วพร้อมกันต้องได้ (เดิน + กระโดด + ยิง) → ใช้ Pointer Events ตาม pointerId
 *     ไม่ใช่ click ซึ่งรับได้ทีละจุด
 *   · ห้ามให้หน้าเลื่อน/ซูมตอนลากนิ้ว → touch-action:none + กัน gesture ทุกทาง
 *   · สายหลุดต้องต่อใหม่เอง คนเล่นเกมไม่มามองจอมือถือ
 *   · ปุ่มต้องใหญ่พอกดโดยไม่ต้องมอง — ขั้นต่ำ 56px ตามที่นิ้วโป้งต้องการจริง
 */
export const GAMEPAD_PAGE = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />
<title>AndroidRemote จอย</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body {
    margin: 0; height: 100%; overflow: hidden;
    background: #14171d; color: #cfd6e2;
    font-family: -apple-system, "Noto Sans Thai", Tahoma, sans-serif;
    touch-action: none; user-select: none; -webkit-user-select: none;
    overscroll-behavior: none;
  }
  #bar {
    height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 12px;
    font-size: 12px; color: #7f8b9e;
    background: linear-gradient(180deg, #232833 0%, #1a1e26 100%);
    border-bottom: 1px solid #0c0e13;
  }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #b23524; }
  #dot.on { background: #3f9c4a; box-shadow: 0 0 6px #3f9c4a; }

  #pad {
    height: calc(100% - 34px);
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 14px;
    gap: 10px;
  }

  .cluster { display: grid; gap: 10px; justify-items: center; }
  /* 🔑 ปุ่มในตารางต้องกินเต็มช่อง — .cluster ตั้ง justify-items:center ไว้
     ถ้าไม่บังคับความกว้าง ปุ่มจะยุบเหลือเท่าความกว้างตัวอักษรจนกดไม่โดน */
  .dpad, .face { justify-items: stretch; align-items: stretch; }
  .dpad { grid-template-columns: repeat(3, 60px); grid-template-rows: repeat(3, 60px); gap: 6px; }
  .face { grid-template-columns: repeat(3, 62px); grid-template-rows: repeat(3, 62px); gap: 6px; }

  .btn {
    display: flex; align-items: center; justify-content: center;
    border-radius: 12px; font-size: 15px; font-weight: 700; color: #e6ecf6;
    border: 1px solid #3b4354;
    background-image: linear-gradient(180deg, #4a5265 0%, #3a4152 50%, #2f3542 51%, #262b36 100%);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.18), 0 2px 4px rgba(0,0,0,.5);
    touch-action: none;
  }
  .btn.round { border-radius: 50%; }
  .btn.pressed {
    background-image: linear-gradient(180deg, #f6bc3c 0%, #e5a01a 50%, #c8850c 51%, #a86f08 100%);
    color: #2a1f02;
    border-color: #a97708;
    box-shadow: inset 0 2px 5px rgba(90,55,0,.6);
  }
  .btn.wide { width: 92px; height: 38px; border-radius: 10px; font-size: 13px; }
  .shoulders { display: flex; gap: 10px; justify-content: center; margin-bottom: 4px; }
  .shoulder { width: 96px; height: 40px; }
  .mid { display: flex; flex-direction: column; gap: 12px; align-items: center; }
  .spacer { visibility: hidden; }
</style>
</head>
<body>
  <div id="bar">
    <div id="dot"></div>
    <span id="status">กำลังเชื่อมต่อ…</span>
    <span style="flex:1"></span>
    <span id="hint">กดปุ่มได้หลายนิ้วพร้อมกัน</span>
  </div>

  <div id="pad">
    <div class="cluster">
      <div class="shoulders">
        <div class="btn shoulder" data-b="L1">L1</div>
        <div class="btn shoulder" data-b="L2">L2</div>
      </div>
      <div class="cluster dpad">
        <div class="spacer"></div>
        <div class="btn" data-b="UP">▲</div>
        <div class="spacer"></div>
        <div class="btn" data-b="LEFT">◀</div>
        <div class="spacer"></div>
        <div class="btn" data-b="RIGHT">▶</div>
        <div class="spacer"></div>
        <div class="btn" data-b="DOWN">▼</div>
        <div class="spacer"></div>
      </div>
    </div>

    <div class="mid">
      <div class="btn wide" data-b="SELECT">SELECT</div>
      <div class="btn wide" data-b="START">START</div>
    </div>

    <div class="cluster">
      <div class="shoulders">
        <div class="btn shoulder" data-b="R2">R2</div>
        <div class="btn shoulder" data-b="R1">R1</div>
      </div>
      <div class="cluster face">
        <div class="spacer"></div>
        <div class="btn round" data-b="Y">Y</div>
        <div class="spacer"></div>
        <div class="btn round" data-b="X">X</div>
        <div class="spacer"></div>
        <div class="btn round" data-b="B">B</div>
        <div class="spacer"></div>
        <div class="btn round" data-b="A">A</div>
        <div class="spacer"></div>
      </div>
    </div>
  </div>

<script>
(function () {
  var ws = null;
  var dot = document.getElementById('dot');
  var status = document.getElementById('status');

  function setConnected(on, text) {
    dot.className = on ? 'on' : '';
    status.textContent = text;
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);
    ws.onopen = function () { setConnected(true, 'ต่อแล้ว'); };
    ws.onclose = function () {
      setConnected(false, 'สายหลุด กำลังต่อใหม่…');
      releaseAll();
      // ต่อใหม่เองเสมอ คนเล่นเกมไม่มานั่งมองจอมือถือ
      setTimeout(connect, 1000);
    };
    ws.onerror = function () { setConnected(false, 'ต่อไม่ได้'); };
  }

  function send(type, button) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ t: type, b: button }));
  }

  /** ปุ่มไหนถูกนิ้วไหนกดอยู่ — จำเป็นเพราะนิ้วเลื่อนข้ามปุ่มได้ */
  var byPointer = {};

  function press(el, pointerId) {
    var button = el.getAttribute('data-b');
    if (!button) return;
    if (byPointer[pointerId] === button) return;
    if (byPointer[pointerId]) release(pointerId);
    byPointer[pointerId] = button;
    el.classList.add('pressed');
    send('d', button);
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function release(pointerId) {
    var button = byPointer[pointerId];
    if (!button) return;
    delete byPointer[pointerId];
    var el = document.querySelector('[data-b="' + button + '"]');
    if (el) el.classList.remove('pressed');
    send('u', button);
  }

  function releaseAll() {
    Object.keys(byPointer).forEach(release);
  }

  var pad = document.getElementById('pad');

  pad.addEventListener('pointerdown', function (e) {
    var el = e.target.closest ? e.target.closest('[data-b]') : null;
    if (!el) return;
    e.preventDefault();
    press(el, e.pointerId);
  });

  // นิ้วเลื่อนออกจากปุ่มแล้วไปโดนอีกปุ่ม ต้องสลับให้ถูก ไม่ใช่ค้างปุ่มเดิม
  pad.addEventListener('pointermove', function (e) {
    if (!byPointer[e.pointerId]) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    var target = el && el.closest ? el.closest('[data-b]') : null;
    if (target) press(target, e.pointerId);
    else release(e.pointerId);
  });

  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) {
    pad.addEventListener(name, function (e) { release(e.pointerId); });
  });

  // สลับแท็บ/ล็อกจอ = ปล่อยทุกปุ่ม ไม่งั้นค้างไว้บน PC
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) releaseAll();
  });
  window.addEventListener('blur', releaseAll);

  // กัน gesture ของเบราว์เซอร์ที่จะทำให้หน้าเลื่อนหรือซูมตอนกดรัวๆ
  ['gesturestart', 'gesturechange', 'contextmenu', 'dblclick'].forEach(function (name) {
    document.addEventListener(name, function (e) { e.preventDefault(); }, { passive: false });
  });

  connect();
})();
</script>
</body>
</html>`;
