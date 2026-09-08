// ตัวฉีดคีย์บอร์ดเข้า Windows
//
// Electron ยิงคีย์เข้าระบบเองไม่ได้ ต้องผ่าน SendInput ของ user32 ซึ่งเรียกจาก
// Node ตรงๆ ไม่ได้ถ้าไม่ลง native module (ที่ต้องคอมไพล์ตอนติดตั้ง)
//
// ทางที่เลือก: exe เล็กๆ ตัวเดียว คอมไพล์ด้วย csc.exe ที่ **มีอยู่ใน Windows ทุกเครื่อง**
// อยู่แล้ว ไม่ต้องโหลดอะไรเพิ่ม โพรเซสนี้เปิดค้างไว้ตัวเดียว อ่านคำสั่งทาง stdin
// (เปิด-ปิดโพรเซสต่อหนึ่งปุ่มจะหน่วงเป็นร้อยมิลลิวินาที ใช้เล่นเกมไม่ได้)
//
// รูปแบบคำสั่งหนึ่งบรรทัด:  D <vk>  หรือ  U <vk>   เช่น "D 87" = กด W ค้าง
//                          Q       = เลิกและปล่อยทุกปุ่มที่ค้างอยู่

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

internal static class InputHelper
{
    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public KEYBDINPUT ki;
        // MOUSEINPUT/HARDWAREINPUT ใหญ่กว่า KEYBDINPUT — ต้องจองที่เผื่อไว้
        // ไม่งั้นขนาดโครงสร้างไม่ตรงกับที่ user32 คาดหวัง แล้ว SendInput จะเงียบ
        [FieldOffset(0)] public MOUSEINPUT mi;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_SCANCODE = 0x0008;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern uint MapVirtualKey(uint uCode, uint uMapType);

    private const uint MAPVK_VK_TO_VSC = 0;

    /// ปุ่มที่ต้องติดธง extended ไม่งั้นเกมจะอ่านเป็นปุ่มบนคีย์แพดตัวเลขแทน
    private static readonly HashSet<ushort> Extended = new HashSet<ushort>
    {
        0x25, 0x26, 0x27, 0x28, // ลูกศร ซ้าย บน ขวา ล่าง
        0x21, 0x22, 0x23, 0x24, // PageUp PageDown End Home
        0x2D, 0x2E,             // Insert Delete
        0xA3, 0xA5,             // Ctrl ขวา, Alt ขวา
        0x5B, 0x5C, 0x5D        // Win ซ้าย/ขวา, Menu
    };

    private static readonly HashSet<ushort> Held = new HashSet<ushort>();

    private static void Send(ushort vk, bool down)
    {
        // 🔑 ส่งเป็น scan code ไม่ใช่ virtual key
        //    เกมจำนวนมากอ่านอินพุตผ่าน DirectInput/Raw Input ซึ่ง **มองไม่เห็น**
        //    เหตุการณ์ที่ส่งมาเป็น virtual key ล้วน — ต้องแปลงเป็น scan code ก่อน
        ushort scan = (ushort)MapVirtualKey(vk, MAPVK_VK_TO_VSC);

        uint flags = KEYEVENTF_SCANCODE;
        if (!down) flags |= KEYEVENTF_KEYUP;
        if (Extended.Contains(vk)) flags |= KEYEVENTF_EXTENDEDKEY;

        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki = new KEYBDINPUT
        {
            wVk = scan == 0 ? vk : (ushort)0, // ไม่มี scan code ก็ถอยไปใช้ virtual key
            wScan = scan,
            dwFlags = scan == 0 ? (down ? 0 : KEYEVENTF_KEYUP) : flags,
            time = 0,
            dwExtraInfo = IntPtr.Zero
        };

        uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent == 0)
        {
            Console.Error.WriteLine("ERR SendInput vk=" + vk + " win32=" + Marshal.GetLastWin32Error());
        }
    }

    private static void ReleaseAll()
    {
        // ปุ่มที่ค้างตอนโพรเซสตายจะค้างต่อไปในระบบจนผู้ใช้ไปกดเอง — ต้องปล่อยให้หมด
        foreach (ushort vk in new List<ushort>(Held))
        {
            Send(vk, false);
        }
        Held.Clear();
    }

    private static int Main()
    {
        AppDomain.CurrentDomain.ProcessExit += delegate { ReleaseAll(); };
        Console.Out.WriteLine("READY");
        Console.Out.Flush();

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            // ตัด BOM ทิ้งด้วย ไม่ใช่แค่ช่องว่าง — ผู้เขียนบางตัว (เช่น PowerShell)
            // เติม U+FEFF หน้าบรรทัดแรก ซึ่ง Trim() ธรรมดาไม่เอาออกให้
            // เจอมาแล้วตอนทดสอบ: คำสั่งแรกถูกเมินเงียบๆ โดยไม่มี error อะไรเลย
            line = line.Trim().Trim('﻿').Trim();
            if (line.Length == 0) continue;
            if (line == "Q") break;

            string[] parts = line.Split(' ');
            if (parts.Length != 2) continue;

            ushort vk;
            if (!ushort.TryParse(parts[1], out vk)) continue;

            if (parts[0] == "D")
            {
                Held.Add(vk);
                Send(vk, true);
            }
            else if (parts[0] == "U")
            {
                Held.Remove(vk);
                Send(vk, false);
            }
        }

        ReleaseAll();
        return 0;
    }
}
