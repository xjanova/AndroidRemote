package com.androidremote.companion;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.List;

/**
 * ทุกอย่างที่เกี่ยวกับการทำให้ PC หาเครื่องนี้เจอบนวง Wi-Fi
 *
 * หัวใจของแอปนี้อยู่ที่ {@link #restoreAdbPort()} — พอร์ต adb over TCP
 * **หายทุกครั้งที่รีบูต** เพราะ `service.adb.tcp.port` เป็น property ที่ไม่ค้าง
 * ปกติผู้ใช้ต้องเสียบสาย USB แล้วสั่ง `adb tcpip 5555` ใหม่ทุกรอบ
 * ถ้าเครื่องมี root เราตั้งคืนให้เองได้ ผู้ใช้ก็ไม่ต้องเสียบสายอีกเลย
 */
public final class Wireless {

    /** พอร์ตมาตรฐานที่ `adb tcpip` ใช้ */
    public static final int ADB_PORT = 5555;

    private Wireless() {
    }

    /** ที่อยู่ IPv4 บนวงที่ใช้งานอยู่ — null ถ้าไม่ได้ต่อ Wi-Fi */
    public static String localIpv4(Context context) {
        // ทางที่แม่นกว่า: ถามจากเครือข่ายที่ระบบใช้อยู่จริง ไม่ใช่ไล่ทุกอินเทอร์เฟซ
        try {
            ConnectivityManager cm =
                    (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                Network active = cm.getActiveNetwork();
                if (active != null) {
                    LinkProperties props = cm.getLinkProperties(active);
                    if (props != null) {
                        for (LinkAddress la : props.getLinkAddresses()) {
                            InetAddress addr = la.getAddress();
                            if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                                return addr.getHostAddress();
                            }
                        }
                    }
                }
            }
        } catch (Throwable ignored) {
            // ตกไปใช้ทางสำรองข้างล่าง
        }

        try {
            List<NetworkInterface> ifaces = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface iface : ifaces) {
                if (!iface.isUp() || iface.isLoopback()) {
                    continue;
                }
                for (InetAddress addr : Collections.list(iface.getInetAddresses())) {
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Throwable ignored) {
            // ไม่มีก็คืน null
        }
        return null;
    }

    /** พอร์ต adb over TCP ที่เปิดอยู่ตอนนี้ — 0 หรือ -1 แปลว่าปิดอยู่ */
    public static int currentAdbPort() {
        String value = getProp("service.adb.tcp.port");
        if (value == null || value.trim().isEmpty()) {
            return -1;
        }
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    public static boolean isWirelessOn() {
        return currentAdbPort() > 0;
    }

    /**
     * เปิดพอร์ต adb over TCP คืน — ต้องมี root
     *
     * ⚠ ต้อง restart adbd หลังตั้ง property ไม่งั้นค่าใหม่ไม่มีผลจนกว่าจะรีบูตอีกรอบ
     *
     * @return ข้อความบอกผลที่เอาไปโชว์ผู้ใช้ได้เลย
     */
    public static String restoreAdbPort() {
        if (!hasRoot()) {
            return "เครื่องนี้ไม่มี root — เปิดพอร์ตคืนอัตโนมัติไม่ได้ "
                    + "ต้องเสียบสาย USB แล้วสั่ง adb tcpip 5555 เอง";
        }
        String out = runAsRoot(
                "setprop service.adb.tcp.port " + ADB_PORT + "; stop adbd; start adbd");
        if (out == null) {
            return "สั่งเปิดพอร์ตไม่สำเร็จ — แอปจัดการ root อาจไม่ได้อนุญาต";
        }
        // adbd ใช้เวลาสักครู่กว่าจะขึ้นมาใหม่ ตรวจย้ำก่อนตอบ
        sleep(1200);
        int port = currentAdbPort();
        return port > 0
                ? "เปิดพอร์ต " + port + " คืนแล้ว — PC ต่อได้เลยโดยไม่ต้องเสียบสาย"
                : "ตั้งค่าแล้วแต่ยังไม่เห็นพอร์ตเปิด ลองใหม่อีกครั้ง";
    }

    public static boolean hasRoot() {
        return runAsRoot("id -u") != null;
    }

    /**
     * รันคำสั่งด้วย su — คืน null ถ้าไม่มี su หรือผู้ใช้ไม่อนุญาต
     *
     * ⚠ ห้ามเรียกจากเธรดหลัก: Magisk/KernelSU จะเด้งกล่องขออนุญาตแล้วบล็อกรอ
     *    ถ้าอยู่บนเธรดหลักจะได้ ANR
     */
    public static String runAsRoot(String command) {
        Process process = null;
        try {
            process = Runtime.getRuntime().exec("su");
            OutputStream stdin = process.getOutputStream();
            stdin.write((command + "\nexit\n").getBytes("UTF-8"));
            stdin.flush();
            stdin.close();

            StringBuilder sb = new StringBuilder();
            BufferedReader reader =
                    new BufferedReader(new InputStreamReader(process.getInputStream(), "UTF-8"));
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
            int code = process.waitFor();
            return code == 0 ? sb.toString() : null;
        } catch (Throwable t) {
            return null;
        } finally {
            if (process != null) {
                process.destroy();
            }
        }
    }

    private static String getProp(String key) {
        try {
            Process p = Runtime.getRuntime().exec(new String[]{"getprop", key});
            BufferedReader reader =
                    new BufferedReader(new InputStreamReader(p.getInputStream(), "UTF-8"));
            String value = reader.readLine();
            p.waitFor();
            return value;
        } catch (Throwable t) {
            return null;
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
