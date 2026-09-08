package com.androidremote.server;

import android.os.Looper;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * จุดเริ่มของ server ฝั่งมือถือ
 *
 * ถูกเรียกด้วย:
 *   CLASSPATH=/data/local/tmp/androidremote-server.jar \
 *   app_process / com.androidremote.server.Main <key=value ...>
 *
 * โพรเซสนี้ไม่ใช่แอป ไม่มี Activity — เป็นโพรเซส Java เปล่าๆ ที่บังเอิญอยู่ใน
 * runtime ของแอนดรอยด์ และมี uid เท่ากับคนที่สั่งรัน
 * (2000 ถ้ามาทาง adb shell, 0 ถ้ามาทาง su)
 *
 * โหมด:
 *   mode=screen       มิเรอร์จอ (ค่าเริ่มต้น)
 *   mode=camera       ส่งภาพจากกล้อง เปิดพร้อมกันได้หลายตัว
 *   mode=camera-list  พิมพ์รายการกล้องเป็น JSON แล้วจบ ไม่ต้องต่อซ็อกเก็ต
 */
public final class Main {

    private Main() {
    }

    public static void main(String... args) {
        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            Ln.e("เธรด " + thread.getName() + " ตายเพราะข้อผิดพลาดที่ไม่ได้ดัก", throwable);
            System.exit(1);
        });

        Options options = Options.parse(args);

        // 🔑 ต้องเตรียม looper ก่อนแตะ API ของเฟรมเวิร์ก และต้องเตรียม**ทางเดียว**
        //    SystemContext.prepare() เรียก prepareMainLooper() ให้ข้างในแล้ว
        //    ถ้าเรียกเองซ้ำจะได้ RuntimeException ว่าเตรียมไว้แล้ว
        if (SystemContext.prepare() == null) {
            try {
                Looper.prepareMainLooper();
            } catch (IllegalStateException ignored) {
                // เตรียมไว้แล้วจากที่อื่น ไม่เป็นไร
            }
        }

        // โหมดนี้แค่ตอบคำถามแล้วจบ ไม่ต้องมี looper วนหรือซ็อกเก็ต
        if ("camera-list".equals(options.mode)) {
            System.out.println(CameraCapture.listJson());
            System.out.flush();
            System.exit(0);
            return;
        }

        Ln.i("เริ่ม server — " + options);
        Ln.i("uid=" + android.os.Process.myUid() + " sdk=" + android.os.Build.VERSION.SDK_INT
                + " รุ่น=" + android.os.Build.MODEL);

        Thread worker = new Thread(() -> work(options), "androidremote-worker");
        worker.setDaemon(false);
        worker.start();

        Looper.loop();
    }

    private static void work(Options options) {
        DesktopConnection connection = null;
        ScreenEncoder screenEncoder = null;
        List<CameraCapture> cameras = new ArrayList<>();
        List<Thread> cameraThreads = new ArrayList<>();
        Controller controller = null;
        Thread controlThread = null;

        try {
            boolean cameraMode = "camera".equals(options.mode);
            int streams = cameraMode ? Math.max(1, options.cameraIds.length) : 1;

            if (cameraMode && options.cameraIds.length == 0) {
                throw new IllegalArgumentException("โหมดกล้องต้องระบุ camera_ids มาด้วย");
            }

            connection = DesktopConnection.open(options.socketName, options.control, streams);
            Ln.i("ต่อกลับไปหา PC สำเร็จ (" + streams + " สตรีม"
                    + (connection.hasControl() ? " + ช่องควบคุม" : "") + ")");

            if (connection.hasControl()) {
                controller = new Controller(options, connection);
                controlThread = new Thread(controller, "androidremote-control");
                controlThread.setDaemon(true);
                controlThread.start();
            }

            if (cameraMode) {
                // กล้องแต่ละตัวมีเธรดของตัวเอง — ตัวหนึ่งพังต้องไม่ลากตัวอื่นไปด้วย
                for (int i = 0; i < options.cameraIds.length; i++) {
                    String id = options.cameraIds[i].trim();
                    CameraCapture cam = new CameraCapture(options, connection, i, id, "กล้อง " + id);
                    cameras.add(cam);
                    Thread t = new Thread(cam, "androidremote-cam-" + id);
                    t.start();
                    cameraThreads.add(t);
                }
                for (Thread t : cameraThreads) {
                    t.join();
                }
                Ln.i("กล้องทุกตัวหยุดแล้ว");
            } else {
                if (options.screenPowerMode >= 0) {
                    android.os.IBinder token = Wrappers.SurfaceControlW.getBuiltInDisplayToken();
                    if (token != null) {
                        Wrappers.SurfaceControlW.setDisplayPowerMode(token, options.screenPowerMode);
                    }
                }
                screenEncoder = new ScreenEncoder(options, connection);
                screenEncoder.streamUntilStopped();
                Ln.i("สตรีมจบตามปกติ");
            }
        } catch (IOException e) {
            Ln.e("สตรีมขาด", e);
        } catch (Throwable t) {
            Ln.e("server ล้ม", t);
        } finally {
            if (screenEncoder != null) {
                screenEncoder.stop();
            }
            for (CameraCapture cam : cameras) {
                cam.stop();
            }
            if (controller != null) {
                controller.stop();
            }
            if (controlThread != null) {
                controlThread.interrupt();
            }
            if (connection != null) {
                connection.close();
            }
            // ต้องสั่งจบเอง เพราะเธรดหลักยังวน Looper อยู่ ไม่งั้นโพรเซสค้างตลอดกาล
            System.exit(0);
        }
    }
}
