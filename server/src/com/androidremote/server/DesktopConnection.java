package com.androidremote.server;

import android.net.LocalSocket;
import android.net.LocalSocketAddress;

import java.io.Closeable;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * ท่อคุยกับฝั่ง PC
 *
 * ฝั่ง PC ตั้ง `adb reverse localabstract:<ชื่อ> tcp:<พอร์ต>` ไว้ก่อน แล้วเราวิ่งเข้าไปหา
 * ทำแบบนี้แทน forward เพราะไม่ต้องเดาว่าอีกฝั่งเปิดพอร์ตเสร็จหรือยัง
 *
 * หนึ่งซ็อกเก็ตต่อหนึ่งสตรีม ไม่ยัดรวมกัน — เฟรมวิดีโอก้อนใหญ่ต้องไม่ไปขวางคิว
 * คำสั่งควบคุมที่ต้องถึงภายในไม่กี่มิลลิวินาที และกล้องสองตัวก็ต้องไม่ขวางกันเอง
 *
 * ไบต์แรกสองตัวหลังต่อติด: [ช่อง][หมายเลขสตรีม]
 * ต้องมีหมายเลขสตรีมเพราะโหมดกล้องเปิดได้หลายตัวพร้อมกัน และ TCP ที่คั่นกลาง
 * ไม่การันตีว่าซ็อกเก็ตจะมาถึงตามลำดับที่เราเปิด
 */
public final class DesktopConnection implements Closeable {

    public static final byte CHANNEL_VIDEO = 0x01;
    public static final byte CHANNEL_CONTROL = 0x03;

    /** ความยาวคงที่ของช่องชื่อในหัวข้อมูล — ฝั่ง PC อ่านตามนี้เป๊ะๆ */
    private static final int NAME_FIELD = 64;

    private final List<LocalSocket> videoSockets = new ArrayList<>();
    private final List<DataOutputStream> videoOuts = new ArrayList<>();
    private final LocalSocket controlSocket;
    private final DataInputStream controlIn;
    private final DataOutputStream controlOut;

    private DesktopConnection(List<LocalSocket> videoSockets, LocalSocket controlSocket) throws IOException {
        this.videoSockets.addAll(videoSockets);
        for (LocalSocket s : videoSockets) {
            this.videoOuts.add(new DataOutputStream(s.getOutputStream()));
        }
        this.controlSocket = controlSocket;
        this.controlIn = controlSocket == null ? null : new DataInputStream(controlSocket.getInputStream());
        this.controlOut = controlSocket == null ? null : new DataOutputStream(controlSocket.getOutputStream());
    }

    /**
     * @param videoStreams จำนวนสตรีมวิดีโอ — 1 สำหรับมิเรอร์จอ, N สำหรับกล้อง N ตัว
     */
    public static DesktopConnection open(String socketName, boolean control, int videoStreams) throws IOException {
        List<LocalSocket> videos = new ArrayList<>();
        try {
            for (int i = 0; i < videoStreams; i++) {
                videos.add(connect(socketName, CHANNEL_VIDEO, (byte) i));
            }
        } catch (IOException e) {
            for (LocalSocket s : videos) {
                closeQuietly(s);
            }
            throw e;
        }

        LocalSocket ctrl = null;
        if (control) {
            try {
                ctrl = connect(socketName, CHANNEL_CONTROL, (byte) 0);
            } catch (IOException e) {
                // มิเรอร์อย่างเดียวยังดีกว่าไม่ได้อะไรเลย — แจ้งแล้วไปต่อ
                Ln.w("เปิดช่องควบคุมไม่ได้ จะส่งภาพอย่างเดียว: " + e.getMessage());
            }
        }
        return new DesktopConnection(videos, ctrl);
    }

    private static LocalSocket connect(String name, byte channel, byte streamId) throws IOException {
        LocalSocket socket = new LocalSocket();
        socket.connect(new LocalSocketAddress(name, LocalSocketAddress.Namespace.ABSTRACT));
        socket.getOutputStream().write(new byte[]{channel, streamId});
        socket.getOutputStream().flush();
        return socket;
    }

    public boolean hasControl() {
        return controlSocket != null;
    }

    public int videoStreamCount() {
        return videoOuts.size();
    }

    public DataInputStream controlInput() {
        return controlIn;
    }

    public DataOutputStream controlOutput() {
        return controlOut;
    }

    /**
     * หัวข้อมูลของสตรีมหนึ่ง ส่งครั้งเดียวก่อนแพ็กเก็ตแรกเสมอ
     *
     * @param label ชื่อที่โชว์ให้ผู้ใช้ เช่น "หน้าจอ" หรือ "กล้องหลัง (0)"
     */
    public void writeVideoHeader(int stream, String label, int width, int height, String codec) throws IOException {
        DataOutputStream out = videoOuts.get(stream);
        byte[] name = label.getBytes(StandardCharsets.UTF_8);
        byte[] field = new byte[NAME_FIELD];
        // ตัดให้พอดีช่องโดยเหลือที่ให้ null อย่างน้อยหนึ่งไบต์
        System.arraycopy(name, 0, field, 0, Math.min(name.length, NAME_FIELD - 1));

        synchronized (out) {
            out.write(field);
            out.writeInt(width);
            out.writeInt(height);
            out.write(fourCC(codec));
            out.flush();
        }
    }

    private static byte[] fourCC(String codec) {
        String tag = "h265".equalsIgnoreCase(codec) ? "h265" : "h264";
        return tag.getBytes(StandardCharsets.US_ASCII);
    }

    /**
     * ส่งหนึ่งแพ็กเก็ต
     *
     * รูปแบบ: [8] pts | [4] ความยาว | [N] ข้อมูล
     * บิตบนสุดสองบิตของ pts เป็นธง ไม่ใช่เวลา:
     *   bit 63 = แพ็กเก็ตตั้งค่า (SPS/PPS) ไม่มีเวลาจริง
     *   bit 62 = คีย์เฟรม
     */
    public void writeVideoPacket(int stream, long ptsUs, boolean config, boolean keyFrame,
                                 byte[] data, int offset, int length) throws IOException {
        DataOutputStream out = videoOuts.get(stream);
        long header = config ? 0 : ptsUs;
        if (config) {
            header |= 1L << 63;
        }
        if (keyFrame) {
            header |= 1L << 62;
        }
        // กล้องหลายตัวเขียนคนละเธรด — ล็อกต่อสตรีมพอ ไม่ต้องล็อกรวม
        synchronized (out) {
            out.writeLong(header);
            out.writeInt(length);
            out.write(data, offset, length);
            out.flush();
        }
    }

    @Override
    public void close() {
        for (LocalSocket s : videoSockets) {
            closeQuietly(s);
        }
        closeQuietly(controlSocket);
    }

    private static void closeQuietly(LocalSocket s) {
        if (s == null) {
            return;
        }
        try {
            s.shutdownInput();
        } catch (IOException ignored) {
            // ปิดอยู่แล้วก็ไม่เป็นไร
        }
        try {
            s.shutdownOutput();
        } catch (IOException ignored) {
            // เหมือนกัน
        }
        try {
            s.close();
        } catch (IOException ignored) {
            // เหมือนกัน
        }
    }
}
