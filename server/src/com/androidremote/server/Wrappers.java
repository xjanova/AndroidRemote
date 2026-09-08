package com.androidremote.server;

import android.os.IBinder;
import android.view.InputEvent;

import java.lang.reflect.Method;

/**
 * ทางเข้าสู่ API ที่ซ่อนอยู่ในเฟรมเวิร์ก
 *
 * ทุกอย่างในนี้เป็น reflection เพราะคลาสพวกนี้ไม่มีใน android.jar สาธารณะ
 * และลายเซ็นเมธอดเปลี่ยนไปมาตามเวอร์ชันแอนดรอยด์
 *
 * หลักที่ยึด:
 *   1. ผูกเมธอดครั้งเดียวแล้วแคชไว้ — reflection ทุกเฟรมแพงเกินไปที่ 60 fps
 *   2. หาไม่เจอให้โยน UnsupportedOperationException พร้อมบอกว่าเวอร์ชันไหนหาย
 *      ไม่ใช่ NPE เปล่าๆ ที่ debug ไม่ได้
 *   3. ทางที่ใหม่กว่าลองก่อนเสมอ แล้วค่อยถอยไปทางเก่า
 */
public final class Wrappers {

    private Wrappers() {
    }

    // ═══════════════════════════ ServiceManager ═══════════════════════════

    public static final class Services {
        private static Method getService;

        private Services() {
        }

        public static IBinder get(String name) {
            try {
                if (getService == null) {
                    Class<?> cls = Class.forName("android.os.ServiceManager");
                    getService = cls.getDeclaredMethod("getService", String.class);
                }
                return (IBinder) getService.invoke(null, name);
            } catch (Exception e) {
                throw new UnsupportedOperationException("เข้าถึงบริการ " + name + " ไม่ได้", e);
            }
        }
    }

    // ═══════════════════════════ SurfaceControl ═══════════════════════════

    /**
     * ตัวสร้างจอเสมือนสำหรับจับภาพ
     *
     * ⚠ นี่คือส่วนที่เปราะที่สุดของทั้งโปรเจค — Google ขยับ API ชุดนี้เกือบทุกเวอร์ชัน
     * ถ้ามิเรอร์พังหลังผู้ใช้อัปเดตแอนดรอยด์ ให้มาดูตรงนี้ก่อนที่อื่น
     */
    public static final class SurfaceControlW {
        private static Class<?> cls;
        private static Method createDisplay;
        private static Method destroyDisplay;
        private static Method openTransaction;
        private static Method closeTransaction;
        private static Method setDisplaySurface;
        private static Method setDisplayProjection;
        private static Method setDisplayLayerStack;
        private static Method setDisplayPowerMode;
        private static Method getPhysicalDisplayToken;
        private static Method getPhysicalDisplayIds;
        private static Method getBuiltInDisplay;

        private SurfaceControlW() {
        }

        private static Class<?> cls() throws ClassNotFoundException {
            if (cls == null) {
                cls = Class.forName("android.view.SurfaceControl");
            }
            return cls;
        }

        public static IBinder createDisplay(String name, boolean secure) {
            try {
                if (createDisplay == null) {
                    createDisplay = cls().getMethod("createDisplay", String.class, boolean.class);
                }
                return (IBinder) createDisplay.invoke(null, name, secure);
            } catch (Exception e) {
                throw new UnsupportedOperationException(
                        "SurfaceControl.createDisplay ใช้ไม่ได้บน API " + android.os.Build.VERSION.SDK_INT
                                + " — เครื่องนี้อาจต้องใช้ทาง virtual display แทน", e);
            }
        }

        public static void destroyDisplay(IBinder display) {
            try {
                if (destroyDisplay == null) {
                    destroyDisplay = cls().getMethod("destroyDisplay", IBinder.class);
                }
                destroyDisplay.invoke(null, display);
            } catch (Exception e) {
                Ln.w("ลบจอเสมือนไม่สำเร็จ (ปล่อยให้ระบบเก็บกวาดเอง): " + e);
            }
        }

        public static void openTransaction() {
            try {
                if (openTransaction == null) {
                    openTransaction = cls().getMethod("openTransaction");
                }
                openTransaction.invoke(null);
            } catch (Exception e) {
                throw new UnsupportedOperationException("openTransaction ไม่สำเร็จ", e);
            }
        }

        public static void closeTransaction() {
            try {
                if (closeTransaction == null) {
                    closeTransaction = cls().getMethod("closeTransaction");
                }
                closeTransaction.invoke(null);
            } catch (Exception e) {
                throw new UnsupportedOperationException("closeTransaction ไม่สำเร็จ", e);
            }
        }

        public static void setDisplaySurface(IBinder display, android.view.Surface surface) {
            try {
                if (setDisplaySurface == null) {
                    setDisplaySurface = cls().getMethod("setDisplaySurface", IBinder.class, android.view.Surface.class);
                }
                setDisplaySurface.invoke(null, display, surface);
            } catch (Exception e) {
                throw new UnsupportedOperationException("setDisplaySurface ไม่สำเร็จ", e);
            }
        }

        public static void setDisplayProjection(IBinder display, int orientation,
                                                android.graphics.Rect layerStackRect,
                                                android.graphics.Rect displayRect) {
            try {
                if (setDisplayProjection == null) {
                    setDisplayProjection = cls().getMethod("setDisplayProjection", IBinder.class, int.class,
                            android.graphics.Rect.class, android.graphics.Rect.class);
                }
                setDisplayProjection.invoke(null, display, orientation, layerStackRect, displayRect);
            } catch (Exception e) {
                throw new UnsupportedOperationException("setDisplayProjection ไม่สำเร็จ", e);
            }
        }

        public static void setDisplayLayerStack(IBinder display, int layerStack) {
            try {
                if (setDisplayLayerStack == null) {
                    setDisplayLayerStack = cls().getMethod("setDisplayLayerStack", IBinder.class, int.class);
                }
                setDisplayLayerStack.invoke(null, display, layerStack);
            } catch (Exception e) {
                throw new UnsupportedOperationException("setDisplayLayerStack ไม่สำเร็จ", e);
            }
        }

        /** ปิด/เปิดจอมือถือโดยที่ยังมิเรอร์ต่อได้ — 0 = OFF, 2 = NORMAL */
        public static boolean setDisplayPowerMode(IBinder display, int mode) {
            try {
                if (setDisplayPowerMode == null) {
                    setDisplayPowerMode = cls().getMethod("setDisplayPowerMode", IBinder.class, int.class);
                }
                setDisplayPowerMode.invoke(null, display, mode);
                return true;
            } catch (Exception e) {
                Ln.w("ตั้งโหมดพลังงานจอไม่ได้: " + e);
                return false;
            }
        }

        /**
         * โทเคนของจอจริงในเครื่อง
         * API 29 ขึ้นไปใช้ physical display id ส่วนก่อนหน้านั้นใช้เลข built-in
         */
        public static IBinder getBuiltInDisplayToken() {
            try {
                if (android.os.Build.VERSION.SDK_INT >= 29) {
                    if (getPhysicalDisplayIds == null) {
                        getPhysicalDisplayIds = cls().getMethod("getPhysicalDisplayIds");
                    }
                    long[] ids = (long[]) getPhysicalDisplayIds.invoke(null);
                    if (ids == null || ids.length == 0) {
                        return null;
                    }
                    if (getPhysicalDisplayToken == null) {
                        getPhysicalDisplayToken = cls().getMethod("getPhysicalDisplayToken", long.class);
                    }
                    return (IBinder) getPhysicalDisplayToken.invoke(null, ids[0]);
                }
                if (getBuiltInDisplay == null) {
                    getBuiltInDisplay = cls().getMethod("getBuiltInDisplay", int.class);
                }
                return (IBinder) getBuiltInDisplay.invoke(null, 0);
            } catch (Exception e) {
                Ln.w("หาโทเคนจอจริงไม่เจอ: " + e);
                return null;
            }
        }
    }

    // ═══════════════════════════ InputManager ═══════════════════════════

    /**
     * ยิงอินพุตเข้าระบบ
     *
     * Android 14 (API 34) ย้าย getInstance ไปอยู่ InputManagerGlobal
     * ต้องลองตัวใหม่ก่อน ไม่งั้นจะพังบนเครื่องใหม่ทั้งหมด
     */
    public static final class Input {
        /** ยิงแล้วไม่รอผล — เร็วที่สุด เหมาะกับ touch ที่มาถี่ */
        public static final int MODE_ASYNC = 0;

        private static Object manager;
        private static Method inject;

        private Input() {
        }

        private static synchronized void bind() {
            if (inject != null) {
                return;
            }
            Exception last = null;

            // ทางใหม่ก่อน (API 34+)
            try {
                Class<?> cls = Class.forName("android.hardware.input.InputManagerGlobal");
                manager = cls.getMethod("getInstance").invoke(null);
                inject = cls.getMethod("injectInputEvent", InputEvent.class, int.class);
                Ln.i("ใช้ InputManagerGlobal (API " + android.os.Build.VERSION.SDK_INT + ")");
                return;
            } catch (Exception e) {
                last = e;
            }

            // ทางเดิม (API < 34)
            try {
                Class<?> cls = Class.forName("android.hardware.input.InputManager");
                manager = cls.getMethod("getInstance").invoke(null);
                inject = cls.getMethod("injectInputEvent", InputEvent.class, int.class);
                Ln.i("ใช้ InputManager.getInstance (API " + android.os.Build.VERSION.SDK_INT + ")");
                return;
            } catch (Exception e) {
                last = e;
            }

            throw new UnsupportedOperationException(
                    "เข้าถึงตัวยิงอินพุตไม่ได้บน API " + android.os.Build.VERSION.SDK_INT, last);
        }

        public static boolean inject(InputEvent event) {
            try {
                bind();
                Object ok = inject.invoke(manager, event, MODE_ASYNC);
                return Boolean.TRUE.equals(ok);
            } catch (Exception e) {
                Ln.e("ยิงอินพุตไม่สำเร็จ", e);
                return false;
            }
        }
    }

    // ═══════════════════════════ ข้อมูลจอ ═══════════════════════════

    public static final class Displays {
        private static Object global;
        private static Method getDisplayInfo;

        private Displays() {
        }

        /**
         * ขนาดและการหมุนของจอ
         * ใช้ DisplayManagerGlobal เพราะเป็นทางเดียวที่ได้ข้อมูลโดยไม่ต้องมี Context
         */
        public static Info info(int displayId) {
            try {
                if (getDisplayInfo == null) {
                    Class<?> cls = Class.forName("android.hardware.display.DisplayManagerGlobal");
                    global = cls.getMethod("getInstance").invoke(null);
                    getDisplayInfo = cls.getMethod("getDisplayInfo", int.class);
                }
                Object di = getDisplayInfo.invoke(global, displayId);
                if (di == null) {
                    return null;
                }
                Class<?> dic = di.getClass();
                int w = dic.getField("logicalWidth").getInt(di);
                int h = dic.getField("logicalHeight").getInt(di);
                int rotation = dic.getField("rotation").getInt(di);
                int layerStack = dic.getField("layerStack").getInt(di);
                return new Info(w, h, rotation, layerStack);
            } catch (Exception e) {
                Ln.e("อ่านข้อมูลจอ " + displayId + " ไม่ได้", e);
                return null;
            }
        }

        public static final class Info {
            public final int width;
            public final int height;
            /** 0/1/2/3 = 0°/90°/180°/270° */
            public final int rotation;
            public final int layerStack;

            Info(int width, int height, int rotation, int layerStack) {
                this.width = width;
                this.height = height;
                this.rotation = rotation;
                this.layerStack = layerStack;
            }

            @Override
            public String toString() {
                return width + "x" + height + " rot=" + rotation + " layerStack=" + layerStack;
            }
        }
    }
}
