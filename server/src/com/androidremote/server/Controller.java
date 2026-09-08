package com.androidremote.server;

import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * รับคำสั่งจาก PC แล้วยิงเข้าระบบ
 *
 * ทำงานบนเธรดของตัวเอง เพราะ read() บล็อก และห้ามไปขวางการส่งวิดีโอเด็ดขาด
 */
public final class Controller implements Runnable {

    // ─── PC → เครื่อง ───
    private static final int TYPE_KEYCODE = 0x00;
    private static final int TYPE_TEXT = 0x01;
    private static final int TYPE_TOUCH = 0x02;
    private static final int TYPE_SCROLL = 0x03;
    private static final int TYPE_BACK_OR_SCREEN_ON = 0x04;
    private static final int TYPE_SCREEN_POWER_MODE = 0x05;
    private static final int TYPE_SHELL_EXEC = 0x06;

    // ─── เครื่อง → PC ───
    private static final int REPLY_SHELL_RESULT = 0x80;

    private static final int MAX_POINTERS = 10;
    /** ยาวสุดที่ยอมรับต่อหนึ่งข้อความ — กันฝั่งตรงข้ามส่งความยาวมั่วแล้วเราจองหน่วยความจำจนตาย */
    private static final int MAX_PAYLOAD = 1 << 20;

    private final Options options;
    private final DesktopConnection connection;

    private final MotionEvent.PointerProperties[] pointerProps =
            new MotionEvent.PointerProperties[MAX_POINTERS];
    private final MotionEvent.PointerCoords[] pointerCoords =
            new MotionEvent.PointerCoords[MAX_POINTERS];
    private final long[] pointerIds = new long[MAX_POINTERS];
    private int pointerCount;
    private long touchDownTime;

    private volatile boolean stopped;

    public Controller(Options options, DesktopConnection connection) {
        this.options = options;
        this.connection = connection;
        for (int i = 0; i < MAX_POINTERS; i++) {
            MotionEvent.PointerProperties p = new MotionEvent.PointerProperties();
            p.id = i;
            p.toolType = MotionEvent.TOOL_TYPE_FINGER;
            pointerProps[i] = p;

            MotionEvent.PointerCoords c = new MotionEvent.PointerCoords();
            c.orientation = 0;
            c.size = 1;
            pointerCoords[i] = c;
        }
    }

    public void stop() {
        stopped = true;
    }

    @Override
    public void run() {
        DataInputStream in = connection.controlInput();
        if (in == null) {
            return;
        }
        try {
            while (!stopped) {
                int type = in.read();
                if (type < 0) {
                    Ln.i("ช่องควบคุมปิดจากฝั่ง PC");
                    return;
                }
                handle(in, type);
            }
        } catch (IOException e) {
            if (!stopped) {
                Ln.w("ช่องควบคุมขาด: " + e.getMessage());
            }
        }
    }

    private void handle(DataInputStream in, int type) throws IOException {
        switch (type) {
            case TYPE_KEYCODE: {
                int action = in.readUnsignedByte();
                int keycode = in.readInt();
                int repeat = in.readInt();
                int metaState = in.readInt();
                injectKeycode(action, keycode, repeat, metaState);
                break;
            }
            case TYPE_TEXT: {
                String text = readString(in);
                injectText(text);
                break;
            }
            case TYPE_TOUCH: {
                int action = in.readUnsignedByte();
                long pointerId = in.readLong();
                int x = in.readInt();
                int y = in.readInt();
                int screenW = in.readUnsignedShort();
                int screenH = in.readUnsignedShort();
                int pressureRaw = in.readUnsignedShort();
                int buttons = in.readInt();
                injectTouch(action, pointerId, x, y, screenW, screenH, pressureRaw / 65535f, buttons);
                break;
            }
            case TYPE_SCROLL: {
                int x = in.readInt();
                int y = in.readInt();
                int screenW = in.readUnsignedShort();
                int screenH = in.readUnsignedShort();
                float h = in.readShort() / 256f;
                float v = in.readShort() / 256f;
                injectScroll(x, y, screenW, screenH, h, v);
                break;
            }
            case TYPE_BACK_OR_SCREEN_ON: {
                int action = in.readUnsignedByte();
                injectKeycode(action, KeyEvent.KEYCODE_BACK, 0, 0);
                break;
            }
            case TYPE_SCREEN_POWER_MODE: {
                int mode = in.readUnsignedByte();
                setScreenPowerMode(mode);
                break;
            }
            case TYPE_SHELL_EXEC: {
                String cmd = readString(in);
                execShell(cmd);
                break;
            }
            default:
                Ln.w("ข้อความควบคุมชนิดที่ไม่รู้จัก: " + type + " — ตัดการเชื่อมต่อเพื่อไม่ให้สตรีมเพี้ยน");
                throw new IOException("unknown control message type " + type);
        }
    }

    private static String readString(DataInputStream in) throws IOException {
        int len = in.readInt();
        if (len < 0 || len > MAX_PAYLOAD) {
            throw new IOException("ความยาวข้อความไม่สมเหตุผล: " + len);
        }
        byte[] buf = new byte[len];
        in.readFully(buf);
        return new String(buf, StandardCharsets.UTF_8);
    }

    // ─────────────────────────── ยิงอินพุต ───────────────────────────

    private void injectKeycode(int action, int keycode, int repeat, int metaState) {
        long now = SystemClock.uptimeMillis();
        KeyEvent event = new KeyEvent(now, now, action, keycode, repeat, metaState,
                KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD);
        Wrappers.Input.inject(event);
    }

    /**
     * พิมพ์ข้อความ
     *
     * ⚠ ทางนี้แปลงอักษรเป็นชุดปุ่มผ่าน KeyCharacterMap ซึ่ง**ทำได้เฉพาะอักษรที่มีบนแป้นพิมพ์**
     *    ภาษาไทย จีน อีโมจิ จะไม่ออก — ต้องใช้ทาง UHID หรือ IME ของเราเองแทน
     *    ตรงนี้จงใจปล่อยไว้ก่อน แต่ต้องแจ้งผู้ใช้ ไม่ใช่เงียบแล้วให้งงว่าทำไมพิมพ์ไทยไม่ได้
     */
    private void injectText(String text) {
        KeyCharacterMap map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD);
        KeyEvent[] events = map.getEvents(text.toCharArray());
        if (events == null) {
            Ln.w("พิมพ์ข้อความนี้ผ่านแป้นพิมพ์เสมือนไม่ได้ (น่าจะไม่ใช่อักษรละติน): "
                    + text.length() + " ตัวอักษร");
            return;
        }
        for (KeyEvent e : events) {
            Wrappers.Input.inject(e);
        }
    }

    /**
     * ยิงการสัมผัส
     *
     * พิกัดที่รับมาอิงขนาดจอที่ฝั่ง PC เห็น ต้องแปลงกลับเป็นพิกัดจอจริงก่อนเสมอ
     * ไม่งั้นจะกดเพี้ยนทันทีที่ผู้ใช้ย่อขนาดภาพ
     */
    private void injectTouch(int action, long pointerId, int x, int y,
                             int screenW, int screenH, float pressure, int buttons) {
        Wrappers.Displays.Info info = Wrappers.Displays.info(options.displayId);
        if (info == null) {
            return;
        }
        float realX = screenW > 0 ? x * (float) info.width / screenW : x;
        float realY = screenH > 0 ? y * (float) info.height / screenH : y;

        int index = indexOf(pointerId);
        if (action == MotionEvent.ACTION_DOWN) {
            if (index < 0) {
                index = addPointer(pointerId);
                if (index < 0) {
                    Ln.w("นิ้วเกิน " + MAX_POINTERS + " จุด — ทิ้งจุดนี้");
                    return;
                }
            }
            if (pointerCount == 1) {
                touchDownTime = SystemClock.uptimeMillis();
            }
        } else if (index < 0) {
            // ได้ move/up ของนิ้วที่ไม่เคย down — เกิดตอนต่อใหม่กลางคัน ทิ้งไปเงียบๆ
            return;
        }

        pointerCoords[index].x = realX;
        pointerCoords[index].y = realY;
        pointerCoords[index].pressure = action == MotionEvent.ACTION_UP ? 0 : pressure;

        int resolvedAction = action;
        if (pointerCount > 1) {
            if (action == MotionEvent.ACTION_DOWN) {
                resolvedAction = MotionEvent.ACTION_POINTER_DOWN
                        | (index << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
            } else if (action == MotionEvent.ACTION_UP) {
                resolvedAction = MotionEvent.ACTION_POINTER_UP
                        | (index << MotionEvent.ACTION_POINTER_INDEX_SHIFT);
            }
        }

        long now = SystemClock.uptimeMillis();
        MotionEvent event = MotionEvent.obtain(touchDownTime, now, resolvedAction, pointerCount,
                pointerProps, pointerCoords, 0, buttons, 1f, 1f,
                0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
        try {
            Wrappers.Input.inject(event);
        } finally {
            event.recycle();
        }

        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            removePointer(index);
        }
    }

    private void injectScroll(int x, int y, int screenW, int screenH, float hScroll, float vScroll) {
        Wrappers.Displays.Info info = Wrappers.Displays.info(options.displayId);
        if (info == null) {
            return;
        }
        float realX = screenW > 0 ? x * (float) info.width / screenW : x;
        float realY = screenH > 0 ? y * (float) info.height / screenH : y;

        MotionEvent.PointerProperties[] props = {pointerProps[0]};
        MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords();
        coords.x = realX;
        coords.y = realY;
        coords.setAxisValue(MotionEvent.AXIS_HSCROLL, hScroll);
        coords.setAxisValue(MotionEvent.AXIS_VSCROLL, vScroll);

        long now = SystemClock.uptimeMillis();
        MotionEvent event = MotionEvent.obtain(now, now, MotionEvent.ACTION_SCROLL, 1,
                props, new MotionEvent.PointerCoords[]{coords}, 0, 0, 1f, 1f,
                0, 0, InputDevice.SOURCE_MOUSE, 0);
        try {
            Wrappers.Input.inject(event);
        } finally {
            event.recycle();
        }
    }

    private void setScreenPowerMode(int mode) {
        android.os.IBinder token = Wrappers.SurfaceControlW.getBuiltInDisplayToken();
        if (token == null) {
            Ln.w("ไม่มีโทเคนจอจริง — สั่งปิด/เปิดจอไม่ได้");
            return;
        }
        boolean ok = Wrappers.SurfaceControlW.setDisplayPowerMode(token, mode);
        Ln.i("ตั้งโหมดพลังงานจอเป็น " + mode + (ok ? " สำเร็จ" : " ไม่สำเร็จ"));
    }

    // ─────────────────────────── รันคำสั่ง (ระดับ root) ───────────────────────────

    /**
     * รันคำสั่งเชลล์แล้วส่งผลกลับ
     *
     * เราเป็น uid เดียวกับที่ถูกสั่งรันมาอยู่แล้ว — ถ้าฝั่ง PC สั่งผ่าน su
     * โพรเซสนี้ก็เป็น root ทั้งตัว คำสั่งลูกจึงเป็น root ตามไปเอง ไม่ต้องทำอะไรเพิ่ม
     */
    private void execShell(String command) {
        DataOutputStream out = connection.controlOutput();
        if (out == null) {
            return;
        }
        int exitCode = -1;
        String output;
        try {
            Process p = Runtime.getRuntime().exec(new String[]{"sh", "-c", command});
            output = readAll(p.getInputStream()) + readAll(p.getErrorStream());
            exitCode = p.waitFor();
        } catch (Exception e) {
            output = "รันคำสั่งไม่สำเร็จ: " + e;
        }
        try {
            byte[] payload = output.getBytes(StandardCharsets.UTF_8);
            synchronized (out) {
                out.write(REPLY_SHELL_RESULT);
                out.writeInt(exitCode);
                out.writeInt(payload.length);
                out.write(payload);
                out.flush();
            }
        } catch (IOException e) {
            Ln.w("ส่งผลคำสั่งกลับไม่ได้: " + e.getMessage());
        }
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) {
            bos.write(buf, 0, n);
        }
        return bos.toString("UTF-8");
    }

    // ─────────────────────────── ทะเบียนนิ้ว ───────────────────────────

    private int indexOf(long pointerId) {
        for (int i = 0; i < pointerCount; i++) {
            if (pointerIds[i] == pointerId) {
                return i;
            }
        }
        return -1;
    }

    private int addPointer(long pointerId) {
        if (pointerCount >= MAX_POINTERS) {
            return -1;
        }
        int index = pointerCount++;
        pointerIds[index] = pointerId;
        return index;
    }

    /** เอานิ้วออกแล้วเลื่อนตัวหลังมาแทน — MotionEvent ต้องการดัชนีที่ต่อเนื่องไม่มีรู */
    private void removePointer(int index) {
        for (int i = index; i < pointerCount - 1; i++) {
            pointerIds[i] = pointerIds[i + 1];
            pointerCoords[i].copyFrom(pointerCoords[i + 1]);
        }
        pointerCount = Math.max(0, pointerCount - 1);
    }
}
