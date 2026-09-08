package com.androidremote.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;

/**
 * กัน Wi-Fi หลับตอนจอดับ
 *
 * แอนดรอยด์ตัดการ์ด Wi-Fi ลงโหมดประหยัดเมื่อจอดับ ทำให้ PC หาเครื่องไม่เจอ
 * หรือภาพมิเรอร์กระตุกหนัก — WifiLock แบบ HIGH_PERF กันตรงนี้
 *
 * ต้องเป็น foreground service เท่านั้น ไม่งั้นแอนดรอยด์ 8+ ฆ่าทิ้งในไม่กี่นาที
 */
public class KeepAliveService extends Service {

    private static final String CHANNEL_ID = "androidremote_keepalive";
    private static final int NOTIFICATION_ID = 1;

    private WifiManager.WifiLock wifiLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        acquireWifiLock();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, buildNotification());
        // START_STICKY: ถ้าระบบฆ่าเพราะหน่วยความจำไม่พอ ให้เปิดกลับเอง
        return START_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "การต่อกับ PC", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("แจ้งว่ากำลังคงการต่อไร้สายไว้");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        String ip = Wireless.localIpv4(this);
        int port = Wireless.currentAdbPort();
        String text = ip == null
                ? "ยังไม่ได้ต่อ Wi-Fi"
                : port > 0 ? ip + ":" + port + " — PC ต่อได้" : ip + " — พอร์ต adb ปิดอยู่";

        Intent open = new Intent(this, MainActivity.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return builder
                .setContentTitle("AndroidRemote พร้อมให้ต่อ")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentIntent(pending)
                .setOngoing(true)
                .build();
    }

    private void acquireWifiLock() {
        try {
            WifiManager wifi = (WifiManager) getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wifi == null) {
                return;
            }
            int mode = Build.VERSION.SDK_INT >= 29
                    ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wifi.createWifiLock(mode, "AndroidRemote:keepalive");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        } catch (Throwable ignored) {
            // ล็อกไม่ได้ก็ยังทำงานได้ แค่ภาพอาจกระตุกตอนจอดับ
        }
    }

    @Override
    public void onDestroy() {
        if (wifiLock != null && wifiLock.isHeld()) {
            wifiLock.release();
        }
        wifiLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // ไม่มีใครผูกกับบริการนี้
    }
}
