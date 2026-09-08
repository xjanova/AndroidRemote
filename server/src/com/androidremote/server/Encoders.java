package com.androidremote.server;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;

import java.io.IOException;

/**
 * ที่เดียวที่ตั้งค่าตัวเข้ารหัสวิดีโอ
 *
 * ทั้งมิเรอร์จอและกล้องใช้สูตรเดียวกัน — เคยเขียนซ้ำสองที่แล้วพบว่าอันตราย
 * เพราะกับดัก KEY_REPEAT_PREVIOUS_FRAME_AFTER ข้างล่างถ้าลืมที่ใดที่หนึ่ง
 * อาการจะออกมาเหมือนแอปค้าง ซึ่งไล่หาสาเหตุยากมาก
 */
public final class Encoders {

    private Encoders() {
    }

    public static String mimeOf(String codec) {
        return "h265".equalsIgnoreCase(codec) ? MediaFormat.MIMETYPE_VIDEO_HEVC : MediaFormat.MIMETYPE_VIDEO_AVC;
    }

    public static MediaCodec createVideoEncoder(String codec, int width, int height, int bitRate, int maxFps)
            throws IOException {
        String mime = mimeOf(codec);

        MediaFormat format = MediaFormat.createVideoFormat(mime, width, height);
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        format.setInteger(MediaFormat.KEY_BIT_RATE, bitRate);
        format.setInteger(MediaFormat.KEY_FRAME_RATE, maxFps);
        // คีย์เฟรมทุก 10 วินาที — ถี่กว่านี้เปลืองบิตเรต ห่างกว่านี้ต่อกลางสตรีมช้า
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10);
        // 🔑 ภาพนิ่ง = ตัวเข้ารหัสไม่ปล่อยเฟรมเลย แล้วฝั่ง PC จะเหมือนแอปค้าง
        //    บอกให้ส่งเฟรมซ้ำถ้าไม่มีอะไรใหม่ภายใน 100 ms
        format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000L);

        MediaCodec encoder = MediaCodec.createEncoderByType(mime);
        encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        return encoder;
    }

    /**
     * ปรับขนาดให้ด้านยาวไม่เกิน maxSize โดยคงอัตราส่วน
     *
     * ⚠ ตัวเข้ารหัสฮาร์ดแวร์หลายตัวต้องการให้ความกว้าง/สูงหารด้วย 8 ลงตัว
     *    ไม่งั้นได้ภาพเป็นแถบ หรือ configure ไม่ผ่านไปเลย
     */
    public static int[] fit(int width, int height, int maxSize) {
        if (maxSize > 0) {
            int major = Math.max(width, height);
            if (major > maxSize) {
                double scale = (double) maxSize / major;
                width = (int) Math.round(width * scale);
                height = (int) Math.round(height * scale);
            }
        }
        return new int[]{roundTo8(width), roundTo8(height)};
    }

    private static int roundTo8(int value) {
        return Math.max((value + 4) / 8 * 8, 8);
    }

    /** ระบายเอาต์พุตหนึ่งรอบ — คืน true ถ้าสตรีมจบแล้ว */
    public interface PacketSink {
        void onPacket(long ptsUs, boolean config, boolean keyFrame, byte[] data) throws IOException;
    }

    /**
     * ดึงแพ็กเก็ตที่พร้อมแล้วออกจากตัวเข้ารหัสหนึ่งรอบ
     *
     * @return true ถ้าเจอธง END_OF_STREAM
     */
    public static boolean drainOnce(MediaCodec codec, MediaCodec.BufferInfo info, long timeoutUs, PacketSink sink)
            throws IOException {
        int index = codec.dequeueOutputBuffer(info, timeoutUs);
        if (index < 0) {
            return false;
        }
        try {
            java.nio.ByteBuffer buffer = codec.getOutputBuffer(index);
            if (buffer != null && info.size > 0) {
                boolean config = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
                boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                buffer.position(info.offset);
                buffer.limit(info.offset + info.size);
                byte[] data = new byte[info.size];
                buffer.get(data);
                sink.onPacket(info.presentationTimeUs, config, key, data);
            }
        } finally {
            codec.releaseOutputBuffer(index, false);
        }
        return (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
    }
}
