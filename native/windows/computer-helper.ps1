$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$signature = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeComputer {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  public const int INPUT_MOUSE = 0;
  public const int INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint MOUSEEVENTF_HWHEEL = 0x01000;

  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public int type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo;
  }

  public static void UnicodeText(string text) {
    foreach (char c in text) {
      INPUT[] items = new INPUT[2];
      items[0].type = INPUT_KEYBOARD; items[0].U.ki.wScan = c; items[0].U.ki.dwFlags = KEYEVENTF_UNICODE;
      items[1].type = INPUT_KEYBOARD; items[1].U.ki.wScan = c; items[1].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      SendInput(2, items, Marshal.SizeOf(typeof(INPUT)));
    }
  }

  public static void Key(ushort vk, bool down) {
    INPUT[] items = new INPUT[1];
    items[0].type = INPUT_KEYBOARD; items[0].U.ki.wVk = vk; items[0].U.ki.dwFlags = down ? 0 : KEYEVENTF_KEYUP;
    SendInput(1, items, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void Mouse(uint flags, int data) {
    INPUT[] items = new INPUT[1];
    items[0].type = INPUT_MOUSE; items[0].U.mi.dwFlags = flags; items[0].U.mi.mouseData = unchecked((uint)data);
    SendInput(1, items, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
Add-Type -TypeDefinition $signature
[NativeComputer]::SetProcessDPIAware() | Out-Null

function Fail($message) {
  @{ ok = $false; error = [string]$message } | ConvertTo-Json -Compress
  exit 0
}
function Get-Resolution($apiWidth) {
  $w = [NativeComputer]::GetSystemMetrics(0)
  $h = [NativeComputer]::GetSystemMetrics(1)
  $apiHeight = [int][Math]::Round($apiWidth / ($w / [double]$h))
  return @{ display = @{ width = $w; height = $h }; api = @{ width = $apiWidth; height = $apiHeight } }
}
function Scale-Point($x, $y, $res) {
  return @{ x = [int][Math]::Round(($x / [double]$res.api.width) * $res.display.width); y = [int][Math]::Round(($y / [double]$res.api.height) * $res.display.height) }
}
function Api-Point($x, $y, $res) {
  return @{ x = [Math]::Max(0, [Math]::Min($res.api.width - 1, [int][Math]::Round(($x / [double]$res.display.width) * $res.api.width))); y = [Math]::Max(0, [Math]::Min($res.api.height - 1, [int][Math]::Round(($y / [double]$res.display.height) * $res.api.height))) }
}
function Get-WindowTitle([IntPtr]$hwnd) {
  $sb = New-Object System.Text.StringBuilder 1024
  [NativeComputer]::GetWindowText($hwnd, $sb, $sb.Capacity) | Out-Null
  return $sb.ToString()
}
function Get-VisibleWindows {
  $items = New-Object System.Collections.ArrayList
  $callback = [NativeComputer+EnumWindowsProc]{ param([IntPtr]$hWnd, [IntPtr]$lParam)
    if ([NativeComputer]::IsWindowVisible($hWnd)) {
      $title = Get-WindowTitle $hWnd
      if ($title) { [void]$items.Add(@{ id = $hWnd.ToInt64().ToString(); name = $title }) }
    }
    return $items.Count -lt 40
  }
  [NativeComputer]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  return @($items)
}
function Capture-Screenshot($res) {
  $bmp = New-Object System.Drawing.Bitmap($res.display.width, $res.display.height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    $ms = New-Object System.IO.MemoryStream
    try {
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      return [Convert]::ToBase64String($ms.ToArray())
    } finally { $ms.Dispose() }
  } finally { $g.Dispose(); $bmp.Dispose() }
}
function Mouse-Flags($button, $down) {
  switch ($button) {
    'right' { if ($down) { return [NativeComputer]::MOUSEEVENTF_RIGHTDOWN } else { return [NativeComputer]::MOUSEEVENTF_RIGHTUP } }
    'middle' { if ($down) { return [NativeComputer]::MOUSEEVENTF_MIDDLEDOWN } else { return [NativeComputer]::MOUSEEVENTF_MIDDLEUP } }
    default { if ($down) { return [NativeComputer]::MOUSEEVENTF_LEFTDOWN } else { return [NativeComputer]::MOUSEEVENTF_LEFTUP } }
  }
}
$vk = @{ 'return'=0x0D; 'enter'=0x0D; 'tab'=0x09; 'space'=0x20; 'backspace'=0x08; 'delete'=0x2E; 'escape'=0x1B; 'esc'=0x1B; 'left'=0x25; 'up'=0x26; 'right'=0x27; 'down'=0x28; 'home'=0x24; 'end'=0x23; 'pageup'=0x21; 'pagedown'=0x22; 'ctrl'=0x11; 'control'=0x11; 'alt'=0x12; 'shift'=0x10; 'meta'=0x5B; 'win'=0x5B; 'super'=0x5B }
function Send-KeyChord($raw) {
  $parts = ([string]$raw).ToLowerInvariant().Split('+') | Where-Object { $_ }
  if ($parts.Count -eq 0) { return }
  $mods = @()
  if ($parts.Count -gt 1) { $mods = @($parts[0..($parts.Count-2)]) }
  $keyPart = $parts[-1]
  $pressed = @()
  foreach ($m in $mods) { if ($vk.ContainsKey($m)) { [NativeComputer]::Key([ushort]$vk[$m], $true); $pressed += [ushort]$vk[$m] } }
  if ($vk.ContainsKey($keyPart)) { $keyCode = [ushort]$vk[$keyPart] }
  elseif ($keyPart.Length -eq 1) { $keyCode = [ushort][char]$keyPart.ToUpperInvariant() }
  else { [NativeComputer]::UnicodeText($raw); return }
  [NativeComputer]::Key($keyCode, $true); Start-Sleep -Milliseconds 15; [NativeComputer]::Key($keyCode, $false)
  [array]::Reverse($pressed)
  foreach ($m in $pressed) { [NativeComputer]::Key([ushort]$m, $false) }
}

try {
  $text = [Console]::In.ReadToEnd()
  $request = $text | ConvertFrom-Json
  $apiWidth = if ($request.apiWidth) { [int]$request.apiWidth } else { 1280 }
  $res = Get-Resolution $apiWidth
  foreach ($a in @($request.actions)) {
    switch ([string]$a.action) {
      'screenshot' { }
      'move' {
        if ($null -eq $a.x -or $null -eq $a.y) { Fail 'move requires x and y' }
        $p = Scale-Point ([int]$a.x) ([int]$a.y) $res
        [NativeComputer]::SetCursorPos($p.x, $p.y) | Out-Null
      }
      'click' {
        if ($null -ne $a.x -and $null -ne $a.y) { $p = Scale-Point ([int]$a.x) ([int]$a.y) $res; [NativeComputer]::SetCursorPos($p.x, $p.y) | Out-Null }
        $button = if ($a.button) { [string]$a.button } else { 'left' }
        $count = if ($a.count) { [int]$a.count } else { 1 }
        1..$count | ForEach-Object { [NativeComputer]::Mouse((Mouse-Flags $button $true), 0); Start-Sleep -Milliseconds 35; [NativeComputer]::Mouse((Mouse-Flags $button $false), 0); Start-Sleep -Milliseconds 35 }
      }
      'drag' {
        $points = @()
        if ($a.path -and @($a.path).Count -ge 2) { $points = @($a.path) }
        elseif ($null -ne $a.x -and $null -ne $a.y -and $null -ne $a.x2 -and $null -ne $a.y2) { $points = @(@{x=$a.x;y=$a.y}, @{x=$a.x2;y=$a.y2}) }
        else { Fail 'drag requires path or x/y/x2/y2' }
        $button = if ($a.button) { [string]$a.button } else { 'left' }
        $first = Scale-Point ([int]$points[0].x) ([int]$points[0].y) $res
        [NativeComputer]::SetCursorPos($first.x, $first.y) | Out-Null
        [NativeComputer]::Mouse((Mouse-Flags $button $true), 0)
        foreach ($pt in $points[1..($points.Count-1)]) { $p = Scale-Point ([int]$pt.x) ([int]$pt.y) $res; [NativeComputer]::SetCursorPos($p.x, $p.y) | Out-Null; Start-Sleep -Milliseconds 12 }
        [NativeComputer]::Mouse((Mouse-Flags $button $false), 0)
      }
      'type' { [NativeComputer]::UnicodeText([string]$a.text) }
      'key' { Send-KeyChord ([string]$a.key) }
      'scroll' {
        if ($null -ne $a.x -and $null -ne $a.y) { $p = Scale-Point ([int]$a.x) ([int]$a.y) $res; [NativeComputer]::SetCursorPos($p.x, $p.y) | Out-Null }
        $amount = if ($a.amount) { [int]$a.amount } else { 3 }
        $direction = if ($a.direction) { [string]$a.direction } else { 'down' }
        $delta = [int32](120 * $amount * $(if ($direction -eq 'up' -or $direction -eq 'left') { 1 } else { -1 }))
        $flags = if ($direction -eq 'left' -or $direction -eq 'right') { [NativeComputer]::MOUSEEVENTF_HWHEEL } else { [NativeComputer]::MOUSEEVENTF_WHEEL }
        [NativeComputer]::Mouse($flags, $delta)
      }
      'wait' { Start-Sleep -Milliseconds $(if ($a.durationMs) { [int]$a.durationMs } else { 1000 }) }
      default { Fail "unsupported action $($a.action)" }
    }
  }
  if (@($request.actions).Count -gt 0) { Start-Sleep -Milliseconds 180 }
  $point = New-Object NativeComputer+POINT
  [NativeComputer]::GetCursorPos([ref]$point) | Out-Null
  $active = [NativeComputer]::GetForegroundWindow()
  $activeTitle = if ($active -ne [IntPtr]::Zero) { Get-WindowTitle $active } else { '' }
  $shot = if ($request.includeScreenshot) { Capture-Screenshot $res } else { $null }
  $response = @{
    ok = $true
    displayResolution = $res.display
    apiResolution = $res.api
    cursorPosition = Api-Point $point.X $point.Y $res
    activeWindow = if ($active -ne [IntPtr]::Zero) { @{ id = $active.ToInt64().ToString(); name = $activeTitle } } else { $null }
    windows = if ($request.includeWindows) { @(Get-VisibleWindows) } else { @() }
    screenshotMimeType = if ($shot) { 'image/png' } else { $null }
    screenshotBase64 = $shot
    permissions = @{ interactiveDesktop = $true; elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
  }
  $response | ConvertTo-Json -Depth 8 -Compress
} catch {
  Fail $_.Exception.Message
}
