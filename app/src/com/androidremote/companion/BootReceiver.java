package com.androidremote.companion;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * เหตุผลทั้งหมดที่แอปนี้มีอยู่
 *
 * `service.adb.tcp.port` ไม่ค้างข้ามการรีบูต — ปกติผู้ใช้ต้องเสียบสาย USB
 * แล้วสั่ง `adb tcpip 5555` ใหม่ทุกครั้งที่เปิดเครื่อง
 * ถ้ามี root เราตั้งคืนให้เองตรงนี้ ผู้ใช้ก็ไม่ต้องแตะสายอีกเลย
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(final Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            return;
        }

        // onReceive มีเวลาจำกัดมากและอยู่บนเธรดหลัก — su อาจใช้เวลาหลายวินาที
        // ต้องกัน process ถูกฆ่ากลางคันด้วย goAsync()
        final PendingResult pending = goAsync();
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (Wireless.isWirelessOn()) {
                        return; // ROM บางตัวคืนค่าให้เองอยู่แล้ว ไม่ต้องยุ่ง
                    }
                    Wireless.restoreAdbPort();
                } catch (Throwable ignored) {
                    // บูตเสร็จแล้วห้ามแครช ไม่ว่ากรณีใด
                } finally {
                    startKeepAlive(context);
                    pending.finish();
                }
            }
        }, "boot-restore").start();
    }

    private void startKeepAlive(Context context) {
        try {
            Intent service = new Intent(context, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(service);
            } else {
                context.startService(service);
            }
        } catch (Throwable ignored) {
            // Android 12+ จำกัดการเปิด foreground service จากพื้นหลังในบางกรณี
            // เปิดไม่ได้ก็ไม่เป็นไร ผู้ใช้กดเองจากหน้าแอปได้
        }
    }
}
