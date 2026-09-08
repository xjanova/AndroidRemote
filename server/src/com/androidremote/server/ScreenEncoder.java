package com.androidremote.server;

import android.graphics.Rect;
import android.media.MediaCodec;
import android.os.IBinder;
import android.view.Surface;

import java.io.IOException;

/**
 * จับภาพจอแล้วเข้ารหัสส่งออกไป
 *
 * ทางเดินของภาพ:
 *   จอจริง → layer stack → จอเสมือนที่เราสร้าง → Surface ของ MediaCodec → NAL → ซ็อกเก็ต
 *
 * ไม่มีการก็อปพิกเซลผ่าน CPU เลยสักขั้น — ทั้งหมดอยู่บน GPU/ฮาร์ดแวร์เข้ารหัส
 * นี่คือเหตุผลที่วิธีนี้กินซีพียูแทบไม่ขึ้นแม้ที่ 1080p 60fps
 */
public final class ScreenEncoder {

    /** MediaCodec คืน -1 เมื่อยังไม่มีอะไรให้เอาออก — รอเท่านี้ต่อรอบ */
    private static final long DEQUEUE_TIMEOUT_US = 100_000;

    /** เช็คการหมุนจอทุกกี่แพ็กเก็ต — ถี่กว่านี้เปลืองโดยไม่จำเป็น */
    private static final int ROTATION_CHECK_INTERVAL = 30;

    private final Options options;
    private final DesktopConnection connection;

    private IBinder virtualDisplay;
    private MediaCodec codec;
    private Surface inputSurface;

    private int encodedWidth;
    private int encodedHeight;
    private int lastRotation = -1;

    /** ตั้งจากเธรดอื่นเมื่อถึงเวลาเลิก */
    private volatile boolean stopped;

    public ScreenEncoder(Options options, DesktopConnection connection) {
        this.options = options;
        this.connection = connection;
    }

    public void stop() {
        stopped = true;
    }

    /**
     * วนส่งภาพจนกว่าจะถูกสั่งหยุดหรือซ็อกเก็ตขาด
     * จอหมุนเมื่อไหร่ต้องสร้างตัวเข้ารหัสใหม่ทั้งชุด เพราะขนาดเฟรมเปลี่ยน
     */
    public void streamUntilStopped() throws IOException {
        boolean headerSent = false;

        while (!stopped) {
            Wrappers.Displays.Info info = Wrappers.Displays.info(options.displayId);
            if (info == null) {
                throw new IOException("อ่านข้อมูลจอ " + options.displayId + " ไม่ได้");
            }
            lastRotation = info.rotation;

            int[] size = Encoders.fit(info.width, info.height, options.maxSize);
            encodedWidth = size[0];
            encodedHeight = size[1];

            if (!headerSent) {
                connection.writeVideoHeader(0, deviceName(), encodedWidth, encodedHeight, options.codec);
                headerSent = true;
                Ln.i("เริ่มสตรีม " + encodedWidth + "x" + encodedHeight + " จากจอ " + info);
            }

            boolean rotated;
            try {
                setup(info);
                rotated = encodeLoop();
            } finally {
                teardown();
            }

            if (!rotated) {
                return; // ถูกสั่งหยุด หรือสตรีมจบ
            }
            Ln.i("จอหมุน — สร้างตัวเข้ารหัสใหม่");
        }
    }

    // ─────────────────────────── ตั้งค่า ───────────────────────────

    private void setup(Wrappers.Displays.Info info) throws IOException {
        codec = Encoders.createVideoEncoder(options.codec, encodedWidth, encodedHeight,
                options.bitRate, options.maxFps);
        inputSurface = codec.createInputSurface();

        virtualDisplay = Wrappers.SurfaceControlW.createDisplay("androidremote", /* secure */ false);
        Wrappers.SurfaceControlW.openTransaction();
        try {
            Wrappers.SurfaceControlW.setDisplaySurface(virtualDisplay, inputSurface);
            // ต้นทาง = จอจริงทั้งจอ, ปลายทาง = เฟรมที่เราเข้ารหัส
            Wrappers.SurfaceControlW.setDisplayProjection(
                    virtualDisplay,
                    0,
                    new Rect(0, 0, info.width, info.height),
                    new Rect(0, 0, encodedWidth, encodedHeight));
            Wrappers.SurfaceControlW.setDisplayLayerStack(virtualDisplay, info.layerStack);
        } finally {
            Wrappers.SurfaceControlW.closeTransaction();
        }

        codec.start();
    }

    private void teardown() {
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
        if (virtualDisplay != null) {
            Wrappers.SurfaceControlW.destroyDisplay(virtualDisplay);
            virtualDisplay = null;
        }
    }

    // ─────────────────────────── วนเข้ารหัส ───────────────────────────

    /** @return true ถ้าออกเพราะจอหมุน (ต้องตั้งใหม่), false ถ้าจบจริง */
    private boolean encodeLoop() throws IOException {
        MediaCodec.BufferInfo bufferInfo = new MediaCodec.BufferInfo();
        int sinceRotationCheck = 0;

        while (!stopped) {
            boolean end = Encoders.drainOnce(codec, bufferInfo, DEQUEUE_TIMEOUT_US,
                    (pts, config, key, data) ->
                            connection.writeVideoPacket(0, pts, config, key, data, 0, data.length));
            if (end) {
                return false;
            }

            // ตรวจการหมุนแบบห่างๆ — เรียก DisplayManagerGlobal ทุกเฟรมแพงเกินไป
            if (++sinceRotationCheck >= ROTATION_CHECK_INTERVAL) {
                sinceRotationCheck = 0;
                Wrappers.Displays.Info now = Wrappers.Displays.info(options.displayId);
                if (now != null && now.rotation != lastRotation) {
                    return true;
                }
            }
        }
        return false;
    }

    // ─────────────────────────── ตัวช่วย ───────────────────────────

    private static String deviceName() {
        String model = android.os.Build.MODEL;
        return model == null || model.isEmpty() ? "Android" : model;
    }
}
