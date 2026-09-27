# Window helper for server.mjs: finds the Project Zomboid window, clicks into it, captures it, downscales images.
#   win.ps1 -Action info
#   win.ps1 -Action click -X 0.5 -Y 0.5 [-Method post|real]     (X/Y: fraction of the client area)
#   win.ps1 -Action capture -Out shot.png                      (PrintWindow, works while the window is covered)
#   win.ps1 -Action shrink -In big.png -Out small.jpg -MaxWidth 1280
param([string]$Action, [double]$X = 0.5, [double]$Y = 0.5, [string]$Method = "post", [string]$In, [string]$Out, [int]$MaxWidth = 1280)
$ErrorActionPreference = "Stop"

$dll = Join-Path $env:TEMP "pzmcp\PZWin_v1.dll"
if (-not (Test-Path $dll)) {
    New-Item -ItemType Directory -Force (Split-Path $dll) | Out-Null
    Add-Type -OutputAssembly $dll -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
public static class PZWin {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);

    static IntPtr Lp(int x, int y) { return (IntPtr)((y << 16) | (x & 0xFFFF)); }

    public static void ClickPost(IntPtr h, int x, int y) {
        PostMessage(h, 0x0200, IntPtr.Zero, Lp(x, y));          // WM_MOUSEMOVE
        PostMessage(h, 0x0201, (IntPtr)1, Lp(x, y));            // WM_LBUTTONDOWN
        System.Threading.Thread.Sleep(150);
        PostMessage(h, 0x0202, IntPtr.Zero, Lp(x, y));          // WM_LBUTTONUP
    }

    public static void ClickReal(IntPtr h, int x, int y) {
        POINT old; GetCursorPos(out old);
        IntPtr prev = GetForegroundWindow();
        POINT p = new POINT { X = x, Y = y }; ClientToScreen(h, ref p);
        SetForegroundWindow(h);
        System.Threading.Thread.Sleep(150);
        SetCursorPos(p.X, p.Y);
        System.Threading.Thread.Sleep(50);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(150);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(50);
        SetCursorPos(old.X, old.Y);
        if (prev != IntPtr.Zero) SetForegroundWindow(prev);
    }

    public static void Capture(IntPtr h, string path) {
        RECT wr; GetWindowRect(h, out wr);
        RECT cr; GetClientRect(h, out cr);
        POINT o = new POINT { X = 0, Y = 0 }; ClientToScreen(h, ref o);
        int ww = wr.R - wr.L, wh = wr.B - wr.T;
        using (Bitmap full = new Bitmap(ww, wh)) {
            using (Graphics g = Graphics.FromImage(full)) {
                IntPtr hdc = g.GetHdc();
                PrintWindow(h, hdc, 2);                            // PW_RENDERFULLCONTENT
                g.ReleaseHdc(hdc);
            }
            Rectangle client = new Rectangle(o.X - wr.L, o.Y - wr.T, cr.R, cr.B);
            using (Bitmap c = full.Clone(client, full.PixelFormat)) c.Save(path, ImageFormat.Png);
        }
    }

    public static void Shrink(string src, string dst, int maxW) {
        using (Image img = Image.FromFile(src)) {
            int w = img.Width, hh = img.Height;
            if (w > maxW) { hh = hh * maxW / w; w = maxW; }
            using (Bitmap b = new Bitmap(w, hh)) {
                using (Graphics g = Graphics.FromImage(b)) {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.DrawImage(img, 0, 0, w, hh);
                }
                ImageCodecInfo jpg = null;
                foreach (ImageCodecInfo ci in ImageCodecInfo.GetImageEncoders()) if (ci.MimeType == "image/jpeg") jpg = ci;
                EncoderParameters ep = new EncoderParameters(1);
                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 85L);
                b.Save(dst, jpg, ep);
            }
        }
    }
}
"@
}
Add-Type -Path $dll

if ($Action -eq "shrink") { [PZWin]::Shrink($In, $Out, $MaxWidth); "ok"; exit 0 }

$proc = Get-Process ProjectZomboid64 -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { "error=no Project Zomboid window"; exit 2 }
$h = $proc.MainWindowHandle
$r = New-Object PZWin+RECT
[PZWin]::GetClientRect($h, [ref]$r) | Out-Null
$cx = [int]($r.R * $X); $cy = [int]($r.B * $Y)

switch ($Action) {
    "info" { "pid=$($proc.Id)"; "title=$($proc.MainWindowTitle)"; "client=$($r.R)x$($r.B)"; "minimized=$([PZWin]::IsIconic($h))" }
    "click" {
        if ($Method -eq "real") { [PZWin]::ClickReal($h, $cx, $cy) } else { [PZWin]::ClickPost($h, $cx, $cy) }
        "clicked=$cx,$cy method=$Method"
    }
    "capture" { [PZWin]::Capture($h, $Out); "saved=$Out" }
    default { "error=unknown action $Action"; exit 1 }
}
