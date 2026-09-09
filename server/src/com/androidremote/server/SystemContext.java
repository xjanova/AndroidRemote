package com.androidremote.server;

import android.content.Context;
import android.content.pm.ApplicationInfo;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * หา Context ทั้งที่เราไม่ใช่แอป
 *
 * โพรเซสนี้รันผ่าน app_process จึงไม่มี Application ไม่มี Activity และไม่มี Context
 * แต่บริการอย่าง CameraManager เรียกใช้ไม่ได้ถ้าไม่มี Context
 *
 * สองทาง เรียงจากง่ายไปยาก:
 *   1. `ActivityThread.systemMain()` — ง่าย แต่ **โยน InvocationTargetException บน API 34**
 *      (เจอกับอีมูเลเตอร์ Android 14 จริง) เพราะข้างในมันพยายาม attach เป็นโพรเซสระบบ
 *   2. สร้าง ActivityThread เองด้วย constructor ส่วนตัว แล้วปลอม AppBindData/ApplicationInfo
 *      ให้ดูเหมือนแอป com.android.shell — ทางเดียวกับที่ scrcpy ใช้ ทนกว่าข้ามเวอร์ชัน
 *
 * ⚠ ทั้งสองทางเรียก Looper.prepareMainLooper() ให้ข้างในเอง ห้ามเรียกซ้ำก่อนหน้า
 */
public final class SystemContext {

    private static Context cached;
    private static boolean attempted;

    private SystemContext() {
    }

    public static synchronized Context prepare() {
        if (attempted) {
            return cached;
        }
        attempted = true;

        Throwable first;
        try {
            cached = viaSystemMain();
            Ln.i("ได้ system context ทาง systemMain()");
            return cached;
        } catch (Throwable t) {
            first = root(t);
        }

        try {
            cached = viaFakeAppThread();
            Ln.i("ได้ system context ทางสร้าง ActivityThread เอง (systemMain ล้ม: " + first + ")");
            return cached;
        } catch (Throwable t) {
            Ln.w("ขอ system context ไม่ได้ทั้งสองทาง — โหมดกล้องจะใช้ไม่ได้"
                    + " | systemMain: " + first
                    + " | fakeThread: " + root(t));
            return null;
        }
    }

    private static Context viaSystemMain() throws Exception {
        Class<?> at = Class.forName("android.app.ActivityThread");
        Method systemMain = at.getDeclaredMethod("systemMain");
        systemMain.setAccessible(true);
        Object thread = systemMain.invoke(null);
        return systemContextOf(at, thread);
    }

    /**
     * ทางของ scrcpy: ประกอบ ActivityThread ขึ้นมาเองแล้วบอกว่าเราคือแอป com.android.shell
     * ต้องเตรียม Looper หลักเองก่อน เพราะไม่ได้ผ่าน systemMain() ที่ทำให้
     */
    private static Context viaFakeAppThread() throws Exception {
        try {
            android.os.Looper.prepareMainLooper();
        } catch (IllegalStateException ignored) {
            // เตรียมไว้แล้ว
        }

        Class<?> at = Class.forName("android.app.ActivityThread");
        Constructor<?> ctor = at.getDeclaredConstructor();
        ctor.setAccessible(true);
        Object thread = ctor.newInstance();

        // ให้ ActivityThread.currentActivityThread() คืนตัวเรา — หลายที่ในเฟรมเวิร์กถามตัวนี้
        Field sCurrent = at.getDeclaredField("sCurrentActivityThread");
        sCurrent.setAccessible(true);
        sCurrent.set(null, thread);

        // ปลอมข้อมูลแอปให้เป็น shell — เป็น uid ที่เรารันอยู่จริง สิทธิ์จะได้ตรงกัน
        ApplicationInfo appInfo = new ApplicationInfo();
        appInfo.packageName = "com.android.shell";
        appInfo.uid = android.os.Process.myUid();

        Class<?> bindCls = Class.forName("android.app.ActivityThread$AppBindData");
        Constructor<?> bindCtor = bindCls.getDeclaredConstructor();
        bindCtor.setAccessible(true);
        Object bind = bindCtor.newInstance();
        Field appInfoField = bindCls.getDeclaredField("appInfo");
        appInfoField.setAccessible(true);
        appInfoField.set(bind, appInfo);

        Field mBound = at.getDeclaredField("mBoundApplication");
        mBound.setAccessible(true);
        mBound.set(thread, bind);

        return systemContextOf(at, thread);
    }

    private static Context systemContextOf(Class<?> at, Object thread) throws Exception {
        Method getSystemContext = at.getDeclaredMethod("getSystemContext");
        getSystemContext.setAccessible(true);
        Context ctx = (Context) getSystemContext.invoke(thread);
        if (ctx == null) {
            throw new IllegalStateException("getSystemContext คืน null");
        }
        return ctx;
    }

    /** เอาสาเหตุจริงออกมา — InvocationTargetException เปล่าๆ ไม่บอกอะไรเลย */
    private static Throwable root(Throwable t) {
        Throwable cur = t;
        while (cur instanceof InvocationTargetException && cur.getCause() != null) {
            cur = cur.getCause();
        }
        return cur;
    }

    public static Context peek() {
        return cached;
    }
}
