package com.androidremote.server;

/**
 * อาร์กิวเมนต์ที่ฝั่ง PC ส่งมาตอนสั่งรัน
 *
 * รูปแบบ key=value ล้วน ไม่มี flag เดี่ยว — เพราะ app_process ส่งอาร์กิวเมนต์
 * ผ่าน shell อีกชั้น การมีแต่ key=value ทำให้ไม่ต้องกังวลเรื่องลำดับหรือ escape
 */
public final class Options {

    /** screen = มิเรอร์จอ · camera = ใช้กล้องแทนเว็บแคม · camera-list = แค่บอกว่ามีกล้องอะไรบ้างแล้วจบ */
    public String mode = "screen";
    /** ไอดีกล้องที่จะเปิด คั่นด้วยจุลภาค — ใช้เฉพาะ mode=camera */
    public String[] cameraIds = new String[0];

    public String socketName = "androidremote";
    public int maxSize = 0;              // 0 = ตามจอจริง
    public int bitRate = 8_000_000;
    public int maxFps = 60;
    public String codec = "h264";        // h264 | h265
    public int displayId = 0;
    public boolean control = true;
    public boolean sendFrameMeta = true;
    /** ระดับสิทธิ์ที่ฝั่ง PC ตรวจมาแล้ว ใช้ตัดสินว่าจะเปิดฟีเจอร์ระดับ root ไหม */
    public boolean rootMode = false;
    public int screenPowerMode = -1;     // -1 = ไม่ยุ่ง, 0 = ปิดจอ

    public static Options parse(String... args) {
        Options o = new Options();
        for (String arg : args) {
            int eq = arg.indexOf('=');
            if (eq < 0) {
                Ln.w("ข้ามอาร์กิวเมนต์ที่ไม่ใช่ key=value: " + arg);
                continue;
            }
            String key = arg.substring(0, eq);
            String value = arg.substring(eq + 1);
            switch (key) {
                case "mode": o.mode = value; break;
                case "camera_ids": o.cameraIds = value.isEmpty() ? new String[0] : value.split(","); break;
                case "socket_name": o.socketName = value; break;
                case "max_size": o.maxSize = parseInt(value, o.maxSize); break;
                case "bit_rate": o.bitRate = parseInt(value, o.bitRate); break;
                case "max_fps": o.maxFps = parseInt(value, o.maxFps); break;
                case "codec": o.codec = value; break;
                case "display_id": o.displayId = parseInt(value, o.displayId); break;
                case "control": o.control = Boolean.parseBoolean(value); break;
                case "send_frame_meta": o.sendFrameMeta = Boolean.parseBoolean(value); break;
                case "root": o.rootMode = Boolean.parseBoolean(value); break;
                case "screen_power_mode": o.screenPowerMode = parseInt(value, o.screenPowerMode); break;
                default: Ln.w("ไม่รู้จักตัวเลือก: " + key); break;
            }
        }
        return o;
    }

    private static int parseInt(String value, int fallback) {
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException e) {
            Ln.w("ค่าตัวเลขไม่ถูกต้อง: " + value + " ใช้ " + fallback + " แทน");
            return fallback;
        }
    }

    @Override
    public String toString() {
        return "mode=" + mode + " socket=" + socketName + " maxSize=" + maxSize + " bitRate=" + bitRate
                + " maxFps=" + maxFps + " codec=" + codec + " display=" + displayId
                + " control=" + control + " root=" + rootMode
                + (cameraIds.length > 0 ? " cameras=" + String.join(",", cameraIds) : "");
    }
}
