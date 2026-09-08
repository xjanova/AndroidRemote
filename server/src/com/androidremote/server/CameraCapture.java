package com.androidremote.server;

import android.content.Context;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.MediaCodec;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Range;
import android.util.Size;
import android.view.Surface;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * ใช้กล้องมือถือแทนเว็บแคม
 *
 * เส้นทางของภาพเหมือนโหมดมิเรอร์ทุกประการ ต่างแค่ต้นทาง:
 *   กล้อง → Surface ของ MediaCodec → NAL → ซ็อกเก็ต
 * ไม่มีการก็อปพิกเซลผ่าน CPU เลย
 *
 * เปิดหลายตัวพร้อมกันได้ — หนึ่งอินสแตนซ์ต่อหนึ่งกล้อง หนึ่งเธรด หนึ่งซ็อกเก็ต
 * ⚠ แต่เครื่องส่วนใหญ่เปิดกล้องหน้ากับหลังพร้อมกัน **ไม่ได้** เพราะฮาร์ดแวร์
 *   แชร์ ISP ตัวเดียวกัน ดูรายการชุดที่เปิดพร้อมกันได้จาก listJson()
 */
public final class CameraCapture implements Runnable {

    private static final long DEQUEUE_TIMEOUT_US = 100_000;
    private static final long OPEN_TIMEOUT_SEC = 8;

    private final Options options;
    private final DesktopConnection connection;
    private final int streamIndex;
    private final String cameraId;
    private final String label;

    private HandlerThread handlerThread;
    private CameraDevice device;
    private CameraCaptureSession session;
    private MediaCodec codec;
    private Surface inputSurface;

    private volatile boolean stopped;

    public CameraCapture(Options options, DesktopConnection connection, int streamIndex,
                         String cameraId, String label) {
        this.options = options;
        this.connection = connection;
        this.streamIndex = streamIndex;
        this.cameraId = cameraId;
        this.label = label;
    }

    public void stop() {
        stopped = true;
    }

    @Override
    public void run() {
        try {
            open();
            encodeLoop();
        } catch (Throwable t) {
            Ln.e("กล้อง " + cameraId + " ล้ม", t);
        } finally {
            teardown();
        }
    }

    // ─────────────────────────── เปิดกล้อง ───────────────────────────

    private void open() throws Exception {
        Context ctx = SystemContext.prepare();
        if (ctx == null) {
            throw new IllegalStateException("ไม่มี system context — เปิดกล้องไม่ได้");
        }
        CameraManager manager = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
        if (manager == null) {
            throw new IllegalStateException("ขอ CameraManager ไม่ได้");
        }

        CameraCharacteristics chars = manager.getCameraCharacteristics(cameraId);
        Size picked = pickSize(chars, options.maxSize);
        int[] wh = Encoders.fit(picked.getWidth(), picked.getHeight(), options.maxSize);
        Ln.i("กล้อง " + cameraId + " (" + label + ") เลือกขนาด " + picked + " → เข้ารหัสที่ " + wh[0] + "x" + wh[1]);

        connection.writeVideoHeader(streamIndex, label, wh[0], wh[1], options.codec);

        codec = Encoders.createVideoEncoder(options.codec, wh[0], wh[1], options.bitRate, options.maxFps);
        inputSurface = codec.createInputSurface();
        codec.start();

        handlerThread = new HandlerThread("cam-" + cameraId);
        handlerThread.start();
        Handler handler = new Handler(handlerThread.getLooper());

        // openCamera กับ createCaptureSession ตอบกลับทาง callback — ต้องรอให้เสร็จ
        // ก่อนเริ่มระบายเอาต์พุต ไม่งั้นจะวนอ่านตัวเข้ารหัสที่ยังไม่มีใครป้อนภาพเข้า
        final CountDownLatch opened = new CountDownLatch(1);
        final Exception[] failure = new Exception[1];

        manager.openCamera(cameraId, new CameraDevice.StateCallback() {
            @Override
            public void onOpened(CameraDevice cam) {
                device = cam;
                opened.countDown();
            }

            @Override
            public void onDisconnected(CameraDevice cam) {
                Ln.w("กล้อง " + cameraId + " ถูกตัด (แอปอื่นแย่งไปใช้)");
                stopped = true;
                opened.countDown();
            }

            @Override
            public void onError(CameraDevice cam, int error) {
                failure[0] = new IllegalStateException("เปิดกล้อง " + cameraId + " ไม่ได้ รหัส " + error
                        + (error == CameraDevice.StateCallback.ERROR_MAX_CAMERAS_IN_USE
                        ? " (เปิดกล้องพร้อมกันเกินที่เครื่องรองรับ)" : ""));
                opened.countDown();
            }
        }, handler);

        if (!opened.await(OPEN_TIMEOUT_SEC, TimeUnit.SECONDS)) {
            throw new IllegalStateException("รอเปิดกล้อง " + cameraId + " นานเกิน " + OPEN_TIMEOUT_SEC + " วินาที");
        }
        if (failure[0] != null) {
            throw failure[0];
        }
        if (device == null) {
            throw new IllegalStateException("กล้อง " + cameraId + " เปิดไม่สำเร็จ");
        }

        final CountDownLatch configured = new CountDownLatch(1);
        device.createCaptureSession(Collections.singletonList(inputSurface),
                new CameraCaptureSession.StateCallback() {
                    @Override
                    public void onConfigured(CameraCaptureSession s) {
                        session = s;
                        configured.countDown();
                    }

                    @Override
                    public void onConfigureFailed(CameraCaptureSession s) {
                        failure[0] = new IllegalStateException("ตั้งค่าเซสชันกล้อง " + cameraId + " ไม่สำเร็จ");
                        configured.countDown();
                    }
                }, handler);

        if (!configured.await(OPEN_TIMEOUT_SEC, TimeUnit.SECONDS)) {
            throw new IllegalStateException("รอตั้งค่าเซสชันกล้องนานเกินไป");
        }
        if (failure[0] != null) {
            throw failure[0];
        }

        CaptureRequest.Builder request = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
        request.addTarget(inputSurface);
        Range<Integer> fps = pickFpsRange(chars, options.maxFps);
        if (fps != null) {
            request.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fps);
        }
        session.setRepeatingRequest(request.build(), null, handler);
        Ln.i("กล้อง " + cameraId + " เริ่มส่งภาพแล้ว" + (fps != null ? " ที่ " + fps + " fps" : ""));
    }

    private void encodeLoop() throws IOException {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (!stopped) {
            boolean end = Encoders.drainOnce(codec, info, DEQUEUE_TIMEOUT_US,
                    (pts, config, key, data) ->
                            connection.writeVideoPacket(streamIndex, pts, config, key, data, 0, data.length));
            if (end) {
                return;
            }
        }
    }

    private void teardown() {
        if (session != null) {
            try {
                session.close();
            } catch (Exception ignored) {
                // เซสชันอาจปิดไปแล้วพร้อมกล้อง
            }
            session = null;
        }
        if (device != null) {
            try {
                device.close();
            } catch (Exception ignored) {
                // เหมือนกัน
            }
            device = null;
        }
        if (codec != null) {
            try {
                codec.stop();
            } catch (Exception ignored) {
                // ตัวเข้ารหัสอาจอยู่ในสถานะที่ stop ไม่ได้ — release ก็พอ
            }
            try {
                codec.release();
            } catch (Exception ignored) {
                // เหมือนกัน
            }
            codec = null;
        }
        if (inputSurface != null) {
            inputSurface.release();
            inputSurface = null;
        }
        if (handlerThread != null) {
            handlerThread.quitSafely();
            handlerThread = null;
        }
    }

    // ─────────────────────────── เลือกค่า ───────────────────────────

    /** ขนาดที่ใหญ่ที่สุดที่ยังไม่เกิน maxSize — ถ้าไม่จำกัดก็เอาใหญ่สุดที่กล้องมี */
    private static Size pickSize(CameraCharacteristics chars, int maxSize) {
        StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        if (map == null) {
            return new Size(1280, 720);
        }
        Size[] sizes = map.getOutputSizes(MediaCodec.class);
        if (sizes == null || sizes.length == 0) {
            return new Size(1280, 720);
        }
        Size best = null;
        for (Size s : sizes) {
            int major = Math.max(s.getWidth(), s.getHeight());
            if (maxSize > 0 && major > maxSize) {
                continue;
            }
            if (best == null || (long) s.getWidth() * s.getHeight() > (long) best.getWidth() * best.getHeight()) {
                best = s;
            }
        }
        if (best != null) {
            return best;
        }
        // ทุกขนาดใหญ่เกิน maxSize — เอาที่เล็กที่สุดแล้วให้ Encoders.fit ย่อต่อ
        Size smallest = sizes[0];
        for (Size s : sizes) {
            if ((long) s.getWidth() * s.getHeight() < (long) smallest.getWidth() * smallest.getHeight()) {
                smallest = s;
            }
        }
        return smallest;
    }

    private static Range<Integer> pickFpsRange(CameraCharacteristics chars, int maxFps) {
        Range<Integer>[] ranges = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        if (ranges == null || ranges.length == 0) {
            return null;
        }
        Range<Integer> best = null;
        for (Range<Integer> r : ranges) {
            if (r.getUpper() > maxFps) {
                continue;
            }
            // อยากได้ช่วงที่เพดานสูงสุด และพื้นไม่ต่ำจนภาพกระตุกตอนแสงน้อย
            if (best == null || r.getUpper() > best.getUpper()
                    || (r.getUpper().equals(best.getUpper()) && r.getLower() > best.getLower())) {
                best = r;
            }
        }
        return best;
    }

    // ─────────────────────────── รายการกล้อง ───────────────────────────

    /**
     * รายการกล้องทั้งหมดในเครื่อง เป็น JSON บรรทัดเดียว
     * ฝั่ง PC เรียกโหมดนี้ก่อนเปิดหน้าเลือกกล้อง
     */
    public static String listJson() {
        Context ctx = SystemContext.prepare();
        if (ctx == null) {
            return "{\"error\":\"ไม่มี system context — โหมดกล้องใช้ไม่ได้บนเครื่องนี้\",\"cameras\":[]}";
        }
        CameraManager manager = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
        if (manager == null) {
            return "{\"error\":\"ขอ CameraManager ไม่ได้\",\"cameras\":[]}";
        }

        StringBuilder sb = new StringBuilder();
        sb.append("{\"cameras\":[");
        try {
            String[] ids = manager.getCameraIdList();
            for (int i = 0; i < ids.length; i++) {
                if (i > 0) {
                    sb.append(',');
                }
                sb.append(describe(manager, ids[i]));
            }
        } catch (Throwable t) {
            return "{\"error\":" + quote("อ่านรายการกล้องไม่ได้: " + t) + ",\"cameras\":[]}";
        }
        sb.append(']');

        // ชุดกล้องที่เปิดพร้อมกันได้จริง — เครื่องส่วนใหญ่คืนมาว่างหรือมีแค่ชุดเดียว
        sb.append(",\"concurrent\":").append(concurrentJson(manager));
        sb.append('}');
        return sb.toString();
    }

    private static String describe(CameraManager manager, String id) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"id\":").append(quote(id));
        try {
            CameraCharacteristics c = manager.getCameraCharacteristics(id);

            Integer facing = c.get(CameraCharacteristics.LENS_FACING);
            String facingText = facing == null ? "unknown"
                    : facing == CameraCharacteristics.LENS_FACING_FRONT ? "front"
                    : facing == CameraCharacteristics.LENS_FACING_BACK ? "back" : "external";
            sb.append(",\"facing\":").append(quote(facingText));

            StreamConfigurationMap map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Size largest = null;
            if (map != null) {
                Size[] sizes = map.getOutputSizes(MediaCodec.class);
                if (sizes != null) {
                    for (Size s : sizes) {
                        if (largest == null || (long) s.getWidth() * s.getHeight()
                                > (long) largest.getWidth() * largest.getHeight()) {
                            largest = s;
                        }
                    }
                }
            }
            sb.append(",\"maxWidth\":").append(largest == null ? 0 : largest.getWidth());
            sb.append(",\"maxHeight\":").append(largest == null ? 0 : largest.getHeight());

            float[] focal = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
            sb.append(",\"focalLength\":").append(focal != null && focal.length > 0 ? focal[0] : 0);

            // ระดับความสามารถ LEGACY แปลว่ากล้องนี้คุณภาพสตรีมจะแย่กว่าตัวอื่นชัดเจน
            Integer level = c.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL);
            sb.append(",\"legacy\":").append(level != null
                    && level == CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY);
        } catch (Throwable t) {
            sb.append(",\"error\":").append(quote(String.valueOf(t)));
        }
        sb.append('}');
        return sb.toString();
    }

    private static String concurrentJson(CameraManager manager) {
        if (android.os.Build.VERSION.SDK_INT < 30) {
            return "[]";
        }
        try {
            Set<Set<String>> sets = manager.getConcurrentCameraIds();
            List<String> groups = new ArrayList<>();
            for (Set<String> set : sets) {
                List<String> ids = new ArrayList<>(set);
                Collections.sort(ids);
                StringBuilder g = new StringBuilder("[");
                for (int i = 0; i < ids.size(); i++) {
                    if (i > 0) {
                        g.append(',');
                    }
                    g.append(quote(ids.get(i)));
                }
                g.append(']');
                groups.add(g.toString());
            }
            return "[" + String.join(",", groups) + "]";
        } catch (Throwable t) {
            return "[]";
        }
    }

    /** ป้ายชื่อที่อ่านรู้เรื่องสำหรับกล้องหนึ่งตัว */
    public static String labelFor(String id, String facing) {
        String side = "front".equals(facing) ? "กล้องหน้า"
                : "back".equals(facing) ? "กล้องหลัง"
                : "external".equals(facing) ? "กล้องนอก" : "กล้อง";
        return side + " (" + id + ")";
    }

    private static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (ch < 0x20) {
                        sb.append(String.format("\\u%04x", (int) ch));
                    } else {
                        sb.append(ch);
                    }
            }
        }
        return sb.append('"').toString();
    }

    /** แปลง Arrays.toString ให้อ่านง่ายในล็อก */
    static String join(String[] values) {
        return values == null ? "[]" : Arrays.toString(values);
    }
}
