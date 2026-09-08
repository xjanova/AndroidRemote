package com.androidremote.companion;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * หน้าเดียวของแอป
 *
 * สร้าง UI ด้วยโค้ดล้วน ไม่มี layout XML — เพราะ APK นี้ build ด้วย
 * aapt2 + javac + d8 ตรงๆ ไม่ผ่าน Gradle การตัดทรัพยากรออกให้เหลือแค่ไอคอน
 * ทำให้ท่อ build สั้นลงมากและพังยากกว่า
 */
public class MainActivity extends Activity {

    private final Handler main = new Handler(Looper.getMainLooper());

    private TextView statusValue;
    private TextView ipValue;
    private TextView portValue;
    private TextView rootValue;
    private TextView hint;
    private Button actionButton;

    private static final int BG = 0xFF14171D;
    private static final int CARD = 0xFF1E232C;
    private static final int INK = 0xFFCFD6E2;
    private static final int DIM = 0xFF7F8B9E;
    private static final int OK = 0xFF4FBF63;
    private static final int WARN = 0xFFE5A01A;
    private static final int BAD = 0xFFD9503A;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildUi());
        refresh();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    private View buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(24), dp(20), dp(24));
        scroll.addView(root, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = new TextView(this);
        title.setText("AndroidRemote");
        title.setTextColor(INK);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        root.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("ทำให้ PC ต่อเครื่องนี้ได้โดยไม่ต้องเสียบสาย");
        subtitle.setTextColor(DIM);
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        subtitle.setPadding(0, dp(4), 0, dp(20));
        root.addView(subtitle);

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundColor(CARD);
        card.setPadding(dp(16), dp(16), dp(16), dp(16));
        root.addView(card, matchWidth(0));

        statusValue = addRow(card, "สถานะ", "กำลังตรวจ…");
        ipValue = addRow(card, "ที่อยู่ในวง", "—");
        portValue = addRow(card, "พอร์ต adb", "—");
        rootValue = addRow(card, "สิทธิ์ root", "—");

        actionButton = new Button(this);
        actionButton.setAllCaps(false);
        actionButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        actionButton.setText("เปิดการต่อไร้สายคืน");
        actionButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                restore();
            }
        });
        root.addView(actionButton, matchWidth(dp(20)));

        Button keepAlive = new Button(this);
        keepAlive.setAllCaps(false);
        keepAlive.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        keepAlive.setText("เปิดตัวคงการเชื่อมต่อ (กัน Wi-Fi หลับ)");
        keepAlive.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent intent = new Intent(MainActivity.this, KeepAliveService.class);
                if (Build.VERSION.SDK_INT >= 26) {
                    startForegroundService(intent);
                } else {
                    startService(intent);
                }
                toastLike("เปิดตัวคงการเชื่อมต่อแล้ว");
            }
        });
        root.addView(keepAlive, matchWidth(dp(10)));

        hint = new TextView(this);
        hint.setTextColor(DIM);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        hint.setLineSpacing(dp(4), 1f);
        hint.setPadding(0, dp(22), 0, 0);
        root.addView(hint);

        return scroll;
    }

    private TextView addRow(LinearLayout parent, String label, String value) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(7), 0, dp(7));
        row.setGravity(Gravity.CENTER_VERTICAL);

        TextView key = new TextView(this);
        key.setText(label);
        key.setTextColor(DIM);
        key.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        LinearLayout.LayoutParams keyParams =
                new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        row.addView(key, keyParams);

        TextView val = new TextView(this);
        val.setText(value);
        val.setTextColor(INK);
        val.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        val.setTextIsSelectable(true);
        row.addView(val);

        parent.addView(row, matchWidth(0));
        return val;
    }

    private LinearLayout.LayoutParams matchWidth(int topMargin) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.topMargin = topMargin;
        return p;
    }

    /** ตรวจสถานะบนเธรดพื้นหลัง — hasRoot() บล็อกรอผู้ใช้กดอนุญาตได้ */
    private void refresh() {
        statusValue.setText("กำลังตรวจ…");
        statusValue.setTextColor(DIM);

        final String ip = Wireless.localIpv4(this);
        final int port = Wireless.currentAdbPort();

        main.post(new Runnable() {
            @Override
            public void run() {
                ipValue.setText(ip == null ? "ไม่ได้ต่อ Wi-Fi" : ip);
                portValue.setText(port > 0 ? String.valueOf(port) : "ปิดอยู่");
                portValue.setTextColor(port > 0 ? OK : WARN);

                boolean ready = ip != null && port > 0;
                statusValue.setText(ready ? "พร้อมให้ PC ต่อ" : "ยังต่อไม่ได้");
                statusValue.setTextColor(ready ? OK : WARN);
                actionButton.setEnabled(!ready);

                hint.setText(ready
                        ? "บน PC เปิด AndroidRemote แล้วกด “ไร้สาย” — เครื่องนี้จะโผล่เอง\n"
                            + "หรือใส่ที่อยู่ " + ip + ":" + port + " ตรงๆ ก็ได้"
                        : "พอร์ต adb over TCP หายทุกครั้งที่รีบูตเครื่อง\n"
                            + "ถ้าเครื่องมี root แอปนี้เปิดคืนให้เองได้ทั้งตอนนี้และตอนบูตครั้งหน้า\n"
                            + "ถ้าไม่มี root ต้องเสียบสาย USB แล้วสั่ง adb tcpip 5555 หนึ่งครั้ง");
            }
        });

        new Thread(new Runnable() {
            @Override
            public void run() {
                final boolean rooted = Wireless.hasRoot();
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        rootValue.setText(rooted ? "มีและอนุญาตแล้ว" : "ไม่มี หรือยังไม่อนุญาต");
                        rootValue.setTextColor(rooted ? OK : DIM);
                    }
                });
            }
        }, "root-check").start();
    }

    private void restore() {
        actionButton.setEnabled(false);
        actionButton.setText("กำลังเปิด…");
        new Thread(new Runnable() {
            @Override
            public void run() {
                final String result = Wireless.restoreAdbPort();
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        actionButton.setText("เปิดการต่อไร้สายคืน");
                        toastLike(result);
                        refresh();
                    }
                });
            }
        }, "restore-adb").start();
    }

    private void toastLike(String message) {
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show();
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    @SuppressWarnings("unused")
    private static int unusedColorGuard() {
        return Color.TRANSPARENT + BAD;
    }
}
