package com.androidremote.server;

/**
 * ล็อกของ server
 *
 * stdout ของโพรเซสนี้วิ่งกลับไปตามสตรีม adb exec: ที่ฝั่ง PC ถืออยู่
 * เพราะฉะนั้น "พิมพ์ออก stdout" = "ส่งไปโชว์ในแอป" ไม่ใช่หายเข้ากลีบเมฆ
 *
 * ทุกบรรทัดขึ้นต้นด้วยแท็กระดับ เพื่อให้ฝั่ง PC แยกได้ว่าอันไหนคือ error จริง
 */
public final class Ln {

    private static final String TAG = "[AR] ";

    private Ln() {
    }

    public static void i(String message) {
        System.out.println(TAG + "I " + message);
        System.out.flush();
    }

    public static void w(String message) {
        System.out.println(TAG + "W " + message);
        System.out.flush();
    }

    public static void e(String message) {
        System.out.println(TAG + "E " + message);
        System.out.flush();
    }

    public static void e(String message, Throwable t) {
        System.out.println(TAG + "E " + message + " :: " + describe(t));
        System.out.flush();
    }

    /** ย่อ stack trace ให้เหลือแค่ที่ใช้ได้จริง — เต็มๆ ยาวเกินกว่าจะอ่านในกล่องล็อก */
    private static String describe(Throwable t) {
        StringBuilder sb = new StringBuilder();
        Throwable cur = t;
        int depth = 0;
        while (cur != null && depth < 4) {
            if (depth > 0) {
                sb.append(" <- ");
            }
            sb.append(cur.getClass().getSimpleName());
            if (cur.getMessage() != null) {
                sb.append(": ").append(cur.getMessage());
            }
            StackTraceElement[] st = cur.getStackTrace();
            if (st.length > 0) {
                sb.append(" @").append(st[0].getFileName()).append(':').append(st[0].getLineNumber());
            }
            cur = cur.getCause();
            depth++;
        }
        return sb.toString();
    }
}
