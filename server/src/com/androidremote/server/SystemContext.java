package com.androidremote.server;

import android.content.Context;

import java.lang.reflect.Method;

/**
 * หา Context ทั้งที่เราไม่ใช่แอป
 *
 * โพรเซสนี้รันผ่าน app_process จึงไม่มี Application ไม่มี Activity และไม่มี Context
 * แต่บริการอย่าง CameraManager เรียกใช้ไม่ได้ถ้าไม่มี Context
 *
 * ทางออกคือ `ActivityThread.systemMain()` ซึ่งสร้าง ActivityThread ของโพรเซสระบบขึ้นมา
 * แล้วขอ system context จากมัน — ใช้ได้เพราะเรามี uid shell (2000) หรือ root
 *
 * ⚠ systemMain() เรียก Looper.prepareMainLooper() ให้ข้างในเอง
 *   ห้ามเรียก prepareMainLooper() เองก่อนหน้า ไม่งั้นจะได้ RuntimeException
 *   ว่า main looper ถูกเตรียมไว้แล้ว — ต้องเรียกตัวนี้ก่อนเสมอ แล้วค่อยถอย
 */
public final class SystemContext {

    private static Context cached;
    private static boolean attempted;

    private SystemContext() {
    }

    /**
     * เตรียม system context พร้อม main looper
     * คืน null ถ้าทำไม่ได้ — ผู้เรียกต้องถอยไปเตรียม looper เองแทน
     */
    public static synchronized Context prepare() {
        if (attempted) {
            return cached;
        }
        attempted = true;

        try {
            Class<?> activityThread = Class.forName("android.app.ActivityThread");
            Method systemMain = activityThread.getDeclaredMethod("systemMain");
            systemMain.setAccessible(true);
            Object thread = systemMain.invoke(null);

            Method getSystemContext = activityThread.getDeclaredMethod("getSystemContext");
            getSystemContext.setAccessible(true);
            cached = (Context) getSystemContext.invoke(thread);

            Ln.i("ได้ system context แล้ว (" + (cached == null ? "null" : cached.getClass().getSimpleName()) + ")");
            return cached;
        } catch (Throwable t) {
            Ln.w("ขอ system context ไม่ได้: " + t + " — โหมดกล้องจะใช้ไม่ได้");
            return null;
        }
    }

    /** ได้ context แล้วหรือยัง โดยไม่พยายามขอใหม่ */
    public static Context peek() {
        return cached;
    }
}
