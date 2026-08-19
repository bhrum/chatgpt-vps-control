$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$signature = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public static class NativeComputer {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")] public static extern IntPtr SendMessageText(IntPtr hWnd, uint message, IntPtr wParam, StringBuilder lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SwitchDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr desktop);

  public const uint DESKTOP_SWITCHDESKTOP = 0x0100;

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
  public const uint WM_GETTEXT = 0x000D;
  public const uint WM_GETTEXTLENGTH = 0x000E;
  public const uint EM_SETSEL = 0x00B1;
  public const uint EM_SCROLLCARET = 0x00B7;

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

public sealed class UIASettleSubscription : IDisposable {
  private readonly AutomationElement root;
  private readonly StructureChangedEventHandler structureHandler;
  private readonly AutomationPropertyChangedEventHandler propertyHandler;
  private readonly AutomationEventHandler automationHandler;
  private readonly List<AutomationEvent> automationEvents = new List<AutomationEvent>();
  private bool structureRegistered;
  private bool propertyRegistered;
  private long lastTicks = Stopwatch.GetTimestamp();
  private int eventCount;

  public UIASettleSubscription(AutomationElement root) {
    if (root == null) throw new ArgumentNullException("root");
    this.root = root;
    structureHandler = (sender, args) => Record();
    propertyHandler = (sender, args) => Record();
    automationHandler = (sender, args) => Record();
    try { Automation.AddStructureChangedEventHandler(root, TreeScope.Subtree, structureHandler); structureRegistered = true; } catch { }
    try {
      Automation.AddAutomationPropertyChangedEventHandler(root, TreeScope.Subtree, propertyHandler,
        AutomationElement.NameProperty, AutomationElement.IsEnabledProperty, AutomationElement.HasKeyboardFocusProperty,
        ValuePattern.ValueProperty, TogglePattern.ToggleStateProperty, ExpandCollapsePattern.ExpandCollapseStateProperty,
        SelectionItemPattern.IsSelectedProperty);
      propertyRegistered = true;
    } catch { }
    foreach (AutomationEvent eventId in new [] { WindowPattern.WindowOpenedEvent, WindowPattern.WindowClosedEvent, InvokePattern.InvokedEvent, SelectionItemPattern.ElementSelectedEvent }) {
      try { Automation.AddAutomationEventHandler(eventId, root, TreeScope.Subtree, automationHandler); automationEvents.Add(eventId); } catch { }
    }
  }

  private void Record() {
    Interlocked.Increment(ref eventCount);
    Interlocked.Exchange(ref lastTicks, Stopwatch.GetTimestamp());
  }

  public int EventCount { get { return Volatile.Read(ref eventCount); } }
  public bool IsActive { get { return structureRegistered || propertyRegistered || automationEvents.Count > 0; } }

  public int WaitForQuiet(int minimumMs, int quietMs, int maximumMs) {
    Stopwatch elapsed = Stopwatch.StartNew();
    while (elapsed.ElapsedMilliseconds < maximumMs) {
      long last = Interlocked.Read(ref lastTicks);
      double sinceLastMs = (Stopwatch.GetTimestamp() - last) * 1000.0 / Stopwatch.Frequency;
      if (elapsed.ElapsedMilliseconds >= minimumMs && sinceLastMs >= quietMs) break;
      Thread.Sleep(25);
    }
    return (int)elapsed.ElapsedMilliseconds;
  }

  public void Dispose() {
    if (structureRegistered) { try { Automation.RemoveStructureChangedEventHandler(root, structureHandler); } catch { } }
    if (propertyRegistered) { try { Automation.RemoveAutomationPropertyChangedEventHandler(root, propertyHandler); } catch { } }
    foreach (AutomationEvent eventId in automationEvents) { try { Automation.RemoveAutomationEventHandler(eventId, root, automationHandler); } catch { } }
  }
}
"@
$references = @(
  [System.Uri].Assembly.Location,
  [System.Linq.Enumerable].Assembly.Location,
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.AutomationIdentifier].Assembly.Location
) | Where-Object { $_ } | Sort-Object -Unique
Add-Type -TypeDefinition $signature -ReferencedAssemblies $references
[NativeComputer]::SetProcessDPIAware() | Out-Null

function Fail($message) {
  @{ ok = $false; error = [string]$message } | ConvertTo-Json -Depth 12 -Compress
  exit 0
}
function Get-Resolution($apiWidth) {
  $w = [NativeComputer]::GetSystemMetrics(0)
  $h = [NativeComputer]::GetSystemMetrics(1)
  if ($w -le 0 -or $h -le 0) { throw 'No interactive Windows desktop is available.' }
  $apiHeight = [int][Math]::Round($apiWidth / ($w / [double]$h))
  return @{ display = @{ width = $w; height = $h }; api = @{ width = $apiWidth; height = $apiHeight } }
}
function Test-InteractiveDesktop {
  $desktop = [NativeComputer]::OpenInputDesktop(0, $false, [NativeComputer]::DESKTOP_SWITCHDESKTOP)
  if ($desktop -eq [IntPtr]::Zero) { return $false }
  try { return [NativeComputer]::SwitchDesktop($desktop) }
  finally { [NativeComputer]::CloseDesktop($desktop) | Out-Null }
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
function Get-NativeControlText([IntPtr]$hwnd) {
  # GetWindowText intentionally does not retrieve child-control text from a
  # different process. For a previously verified native Edit HWND, use the
  # standard control messages instead.
  $length = [int][NativeComputer]::SendMessage($hwnd, [NativeComputer]::WM_GETTEXTLENGTH, [IntPtr]::Zero, [IntPtr]::Zero)
  $length = [Math]::Max(0, [Math]::Min(1048576, $length))
  $capacity = $length + 1
  $sb = New-Object System.Text.StringBuilder $capacity
  [NativeComputer]::SendMessageText($hwnd, [NativeComputer]::WM_GETTEXT, [IntPtr]$capacity, $sb) | Out-Null
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
function Get-Applications {
  $byId = @{}
  foreach ($process in @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 })) {
    $processName = [string]$process.ProcessName
    $id = "win32:$($processName.ToLowerInvariant())"
    $path = ''
    try { $path = [string]$process.Path } catch {}
    $lastUsedDate = $null
    try { $lastUsedDate = $process.StartTime.ToUniversalTime().ToString('o') } catch {}
    $byId[$id] = @{
      id=$id; displayName=$(if ($process.MainWindowTitle) { [string]$process.MainWindowTitle } else { $processName })
      path=$path; isRunning=$true; pid=[int]$process.Id; lastUsedDate=$lastUsedDate; useCount=$null
    }
  }
  if (Get-Command Get-StartApps -ErrorAction SilentlyContinue) {
    foreach ($app in @(Get-StartApps)) {
      $appId = [string]$app.AppID
      if (-not $appId) { continue }
      $id = "startapp:$appId"
      if (-not $byId.ContainsKey($id)) {
        $byId[$id] = @{ id=$id; displayName=[string]$app.Name; path=$appId; isRunning=$false; pid=$null; lastUsedDate=$null; useCount=$null }
      }
      if ($byId.Count -ge 400) { break }
    }
  }
  return @($byId.Values | Sort-Object @{Expression='isRunning';Descending=$true}, @{Expression='displayName';Ascending=$true})
}
function Capture-Screenshot($res, $bounds = $null) {
  $x = 0; $y = 0; $width = [int]$res.display.width; $height = [int]$res.display.height
  if ($null -ne $bounds -and [int]$bounds.width -gt 0 -and [int]$bounds.height -gt 0) {
    $x = [Math]::Max(0, [int]$bounds.x); $y = [Math]::Max(0, [int]$bounds.y)
    $width = [Math]::Min([int]$bounds.width, [int]$res.display.width - $x)
    $height = [Math]::Min([int]$bounds.height, [int]$res.display.height - $y)
  }
  if ($width -le 0 -or $height -le 0) { return $null }
  $bmp = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    $ms = New-Object System.IO.MemoryStream
    try { $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); return [Convert]::ToBase64String($ms.ToArray()) }
    finally { $ms.Dispose() }
  } finally { $g.Dispose(); $bmp.Dispose() }
}
function Mouse-Flags($button, $down) {
  switch ($button) {
    'right' { if ($down) { return [NativeComputer]::MOUSEEVENTF_RIGHTDOWN } else { return [NativeComputer]::MOUSEEVENTF_RIGHTUP } }
    'middle' { if ($down) { return [NativeComputer]::MOUSEEVENTF_MIDDLEDOWN } else { return [NativeComputer]::MOUSEEVENTF_MIDDLEUP } }
    default { if ($down) { return [NativeComputer]::MOUSEEVENTF_LEFTDOWN } else { return [NativeComputer]::MOUSEEVENTF_LEFTUP } }
  }
}
$vk = @{ 'return'=0x0D; 'enter'=0x0D; 'tab'=0x09; 'space'=0x20; 'backspace'=0x08; 'delete'=0x2E; 'escape'=0x1B; 'esc'=0x1B; 'left'=0x25; 'up'=0x26; 'right'=0x27; 'down'=0x28; 'home'=0x24; 'end'=0x23; 'pageup'=0x21; 'pagedown'=0x22; 'ctrl'=0x11; 'control'=0x11; 'ctrl_l'=0x11; 'ctrl_r'=0x11; 'control_l'=0x11; 'control_r'=0x11; 'alt'=0x12; 'alt_l'=0x12; 'alt_r'=0x12; 'option'=0x12; 'option_l'=0x12; 'option_r'=0x12; 'shift'=0x10; 'shift_l'=0x10; 'shift_r'=0x10; 'meta'=0x5B; 'meta_l'=0x5B; 'meta_r'=0x5B; 'cmd'=0x5B; 'command'=0x5B; 'win'=0x5B; 'super'=0x5B; 'super_l'=0x5B; 'super_r'=0x5B }
function Send-KeyChord($raw) {
  $parts = ([string]$raw).ToLowerInvariant().Split('+') | Where-Object { $_ }
  if ($parts.Count -eq 0) { return }
  $mods = @(); if ($parts.Count -gt 1) { $mods = @($parts[0..($parts.Count-2)]) }
  $keyPart = $parts[-1]; $pressed = @()
  foreach ($m in $mods) { if ($vk.ContainsKey($m)) { [NativeComputer]::Key([uint16]$vk[$m], $true); $pressed += [uint16]$vk[$m] } }
  if ($vk.ContainsKey($keyPart)) { $keyCode = [uint16]$vk[$keyPart] }
  elseif ($keyPart.Length -eq 1) { $keyCode = [uint16][char]$keyPart.ToUpperInvariant() }
  else { [NativeComputer]::UnicodeText($raw); return }
  [NativeComputer]::Key($keyCode, $true); Start-Sleep -Milliseconds 15; [NativeComputer]::Key($keyCode, $false)
  [array]::Reverse($pressed); foreach ($m in $pressed) { [NativeComputer]::Key([uint16]$m, $false) }
}

# UI Automation semantic tree
$ControlWalker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$InteractiveTypes = @('Button','CheckBox','ComboBox','Edit','Hyperlink','ListItem','MenuItem','RadioButton','ScrollBar','Slider','Spinner','TabItem','TreeItem')
$StaticTypes = @('Header','Image','Text')
$ContainerTypes = @('Custom','DataGrid','Group','List','Menu','Pane','Tab','Table','ToolBar','Tree','Window')

function Encode-ElementId([long]$hwnd, [int[]]$path, $element, $rootElement) {
  $automationId = ''
  $controlType = ''
  $name = ''
  $nativeHwnd = 0
  $className = ''
  $processId = 0
  $runtimeId = @()
  $rootRuntimeId = @()
  $bounds = $null
  try { $automationId = [string]$element.Current.AutomationId } catch {}
  try { $controlType = [string]$element.Current.ControlType.ProgrammaticName } catch {}
  try { $name = [string]$element.Current.Name } catch {}
  try { $nativeHwnd = [long]$element.Current.NativeWindowHandle } catch {}
  try { $className = [string]$element.Current.ClassName } catch {}
  try { $processId = [int]$element.Current.ProcessId } catch {}
  try { $runtimeId = @($element.GetRuntimeId() | ForEach-Object { [int]$_ }) } catch {}
  try { if ($null -ne $rootElement) { $rootRuntimeId = @($rootElement.GetRuntimeId() | ForEach-Object { [int]$_ }) } } catch {}
  try {
    $rect = $element.Current.BoundingRectangle
    if (-not $rect.IsEmpty) { $bounds = @{ x=[int]$rect.X; y=[int]$rect.Y; width=[int]$rect.Width; height=[int]$rect.Height } }
  } catch {}
  $json = @{ source='windows-uia'; hwnd=$hwnd; processId=$processId; path=@($path); automationId=$automationId; controlType=$controlType; name=$name; nativeHwnd=$nativeHwnd; className=$className; runtimeId=@($runtimeId); rootRuntimeId=@($rootRuntimeId); bounds=$bounds } | ConvertTo-Json -Compress
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+','-').Replace('/','_')
}
function Decode-ElementId([string]$value) {
  $base64 = $value.Replace('-','+').Replace('_','/')
  while (($base64.Length % 4) -ne 0) { $base64 += '=' }
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($base64)) | ConvertFrom-Json
  if ($payload.source -ne 'windows-uia') { throw 'Invalid Windows UIA element id.' }
  return $payload
}
function Test-RuntimeIdEqual($left, $right) {
  $a = @($left)
  $b = @($right)
  if ($a.Count -eq 0 -or $a.Count -ne $b.Count) { return $false }
  for ($i=0; $i -lt $a.Count; $i++) { if ([int]$a[$i] -ne [int]$b[$i]) { return $false } }
  return $true
}
function Get-RootElement([long]$hwnd) {
  if ($hwnd -eq 0) { return [System.Windows.Automation.AutomationElement]::RootElement }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
  if ($null -eq $root) { throw 'The window for this accessibility snapshot no longer exists.' }
  return $root
}
function Get-UIAChildren($element) {
  $items = New-Object System.Collections.ArrayList
  $child = $ControlWalker.GetFirstChild($element)
  while ($null -ne $child -and $items.Count -lt 500) { [void]$items.Add($child); $child = $ControlWalker.GetNextSibling($child) }
  return @($items)
}
function Resolve-UIAElement($payload) {
  $debugEnabled = $env:CHATGPT_COMPUTER_UIA_DEBUG -eq '1'
  $debug = New-Object System.Collections.Generic.List[string]
  $hwnd = [long]$payload.hwnd
  $processId = [int]$payload.processId
  $runtimeId = @($payload.runtimeId)
  $rootRuntimeId = @($payload.rootRuntimeId)
  $root = Get-RootElement $hwnd
  if ($debugEnabled) { $debug.Add("hwnd=$hwnd;pid=$processId;path=$(@($payload.path).Count);aid=$([bool][string]$payload.automationId);name=$([bool][string]$payload.name);rid=$($runtimeId.Count);rootRid=$($rootRuntimeId.Count)") }

  # A WinForms/WPF provider root reached through AutomationElement.FromHandle
  # can expose a different ControlView subtree than the same top-level window
  # reached through the desktop UIA tree. Snapshots are built from that desktop
  # tree, so recover the matching desktop child by process and HWND before
  # replaying the encoded path. This keeps element ids stable across short-lived
  # helper processes without accepting an unrelated element.
  if ($processId -gt 0) {
    try {
      $processCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        $processId
      )
      $desktop = [System.Windows.Automation.AutomationElement]::RootElement
      $processRoots = $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, $processCondition)
      $matchedRoot = $null
      for ($i=0; $i -lt $processRoots.Count; $i++) {
        $candidateRoot = $processRoots.Item($i)
        try {
          $candidateHwnd = [long]$candidateRoot.Current.NativeWindowHandle
          $candidateRootRuntimeId = @($candidateRoot.GetRuntimeId())
          if ($rootRuntimeId.Count -gt 0 -and (Test-RuntimeIdEqual $candidateRootRuntimeId $rootRuntimeId)) {
            $matchedRoot = $candidateRoot
            if ($debugEnabled) { $debug.Add('desktop-root-runtime=matched') }
            break
          }
          if ($rootRuntimeId.Count -eq 0 -and (($hwnd -ne 0 -and $candidateHwnd -eq $hwnd) -or ($hwnd -eq 0 -and $null -eq $matchedRoot))) {
            $matchedRoot = $candidateRoot
            if ($hwnd -ne 0) { break }
          }
        } catch {}
      }
      if ($null -eq $matchedRoot -and $rootRuntimeId.Count -eq 0 -and $processRoots.Count -eq 1) { $matchedRoot = $processRoots.Item(0) }
      if ($null -ne $matchedRoot) {
        $root = $matchedRoot
        if ($debugEnabled) { $debug.Add('desktop-process-root=matched') }
      } elseif ($debugEnabled) {
        $debug.Add('desktop-process-root=missing')
      }
    } catch {
      if ($debugEnabled) { $debug.Add('desktop-process-root=error:' + $_.Exception.GetType().Name) }
    }
  }
  $element = $root
  $pathResolved = $true
  try {
    foreach ($index in @($payload.path)) {
      $children = @(Get-UIAChildren $element)
      if ([int]$index -lt 0 -or [int]$index -ge $children.Count) { $pathResolved = $false; break }
      $element = $children[[int]$index]
    }
  } catch { $pathResolved = $false; if ($debugEnabled) { $debug.Add('path=error:' + $_.Exception.GetType().Name) } }
  if ($debugEnabled) { $debug.Add('path-resolved=' + [string]$pathResolved) }

  $automationId = [string]$payload.automationId
  $controlType = [string]$payload.controlType
  $name = [string]$payload.name
  if ($debugEnabled) { $debug.Add("identity=aid:$([bool]$automationId)|type:$controlType|name:$([bool]$name)") }
  $nativeHwnd = [long]$payload.nativeHwnd
  if ($nativeHwnd -ne 0) {
    try {
      $nativeElement = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$nativeHwnd)
      if ($null -ne $nativeElement) {
        $nativeMatches = $true
        if ($automationId -and [string]$nativeElement.Current.AutomationId -ne $automationId) { $nativeMatches = $false }
        if ($controlType -and [string]$nativeElement.Current.ControlType.ProgrammaticName -ne $controlType) { $nativeMatches = $false }
        if (-not $automationId -and $name -and [string]$nativeElement.Current.Name -ne $name) { $nativeMatches = $false }
        if ($nativeMatches) { if ($debugEnabled) { $debug.Add('native-hwnd=matched') }; return $nativeElement }
        elseif ($debugEnabled) { $debug.Add('native-hwnd=mismatch') }
      }
    } catch {}
  }
  if ($pathResolved) {
    $identityMatches = $true
    try {
      if ($runtimeId.Count -gt 0 -and (Test-RuntimeIdEqual @($element.GetRuntimeId()) $runtimeId)) {
        if ($debugEnabled) { $debug.Add('path-runtime=matched') }
        return $element
      }
      if ($automationId -and [string]$element.Current.AutomationId -ne $automationId) { $identityMatches = $false }
      if ($controlType -and [string]$element.Current.ControlType.ProgrammaticName -ne $controlType) { $identityMatches = $false }
      if (-not $automationId -and $name -and [string]$element.Current.Name -ne $name) { $identityMatches = $false }
    } catch { $identityMatches = $false }
    if ($identityMatches) { if ($debugEnabled) { $debug.Add('path-identity=matched') }; return $element }
    elseif ($debugEnabled) { $debug.Add('path-identity=mismatch') }
  }

  # Control-view paths can move between short-lived helper processes. Use the
  # same TreeWalker view that produced the snapshot for identity recovery.
  # Some WinForms providers return zero results for FindAll(PropertyCondition)
  # even though ControlViewWalker can enumerate the same descendants.
  $identityQueue = New-Object System.Collections.ArrayList
  foreach ($child in @(Get-UIAChildren $root)) { [void]$identityQueue.Add($child) }
  $scanned = 0
  while ($identityQueue.Count -gt 0 -and $scanned -lt 4000) {
    $candidate = $identityQueue[0]
    $identityQueue.RemoveAt(0)
    $scanned++
    $candidateMatches = $true
    try {
      if ($runtimeId.Count -gt 0 -and (Test-RuntimeIdEqual @($candidate.GetRuntimeId()) $runtimeId)) {
        if ($debugEnabled) { $debug.Add('tree-runtime=matched;scanned=' + [string]$scanned) }
        return $candidate
      }
      $candidatePid = [int]$candidate.Current.ProcessId
      $candidateAutomationId = [string]$candidate.Current.AutomationId
      $candidateControlType = [string]$candidate.Current.ControlType.ProgrammaticName
      $candidateName = [string]$candidate.Current.Name
      if ($debugEnabled -and $scanned -le 6) {
        $debug.Add("candidate$scanned=pidMatch:$($processId -le 0 -or $candidatePid -eq $processId)|aidMatch:$(-not $automationId -or $candidateAutomationId -eq $automationId)|type:$candidateControlType|namePresent:$([bool]$candidateName)")
      }
      if ($processId -gt 0 -and $candidatePid -ne $processId) { $candidateMatches = $false }
      if ($controlType -and $candidateControlType -ne $controlType) { $candidateMatches = $false }
      if ($automationId) {
        if ($candidateAutomationId -ne $automationId) { $candidateMatches = $false }
      } elseif ($name -and $candidateName -ne $name) {
        $candidateMatches = $false
      }
    } catch { $candidateMatches = $false }
    if ($candidateMatches) {
      if ($debugEnabled) { $debug.Add('tree-identity=matched;scanned=' + [string]$scanned) }
      return $candidate
    }
    foreach ($child in @(Get-UIAChildren $candidate)) {
      if ($identityQueue.Count -ge 4000) { break }
      [void]$identityQueue.Add($child)
    }
  }
  if ($debugEnabled) { $debug.Add('tree-identity=missing;scanned=' + [string]$scanned) }

  # Some providers reorder their ControlView tree between short-lived helper
  # processes. Recover by the snapshot point only when the element under that
  # point (or one of its parents) still matches the encoded semantic identity.
  $bounds = $payload.bounds
  if ($null -ne $bounds -and [int]$bounds.width -gt 0 -and [int]$bounds.height -gt 0) {
    try {
      $point = [System.Windows.Point]::new(
        ([double]$bounds.x + ([double]$bounds.width / 2)),
        ([double]$bounds.y + ([double]$bounds.height / 2))
      )
      $candidate = [System.Windows.Automation.AutomationElement]::FromPoint($point)
      if ($debugEnabled) { $debug.Add('from-point=' + [string]($null -ne $candidate)) }
      for ($depth=0; $depth -lt 12 -and $null -ne $candidate; $depth++) {
        $matchesIdentity = $true
        try {
          if ($runtimeId.Count -gt 0 -and (Test-RuntimeIdEqual @($candidate.GetRuntimeId()) $runtimeId)) { return $candidate }
          if ($processId -gt 0 -and [int]$candidate.Current.ProcessId -ne $processId) { $matchesIdentity = $false }
          if ($automationId -and [string]$candidate.Current.AutomationId -ne $automationId) { $matchesIdentity = $false }
          if ($controlType -and [string]$candidate.Current.ControlType.ProgrammaticName -ne $controlType) { $matchesIdentity = $false }
          if (-not $automationId -and $name -and [string]$candidate.Current.Name -ne $name) { $matchesIdentity = $false }
        } catch { $matchesIdentity = $false }
        if ($matchesIdentity) { return $candidate }
        $candidate = $ControlWalker.GetParent($candidate)
      }
    } catch { if ($debugEnabled) { $debug.Add('from-point=error:' + $_.Exception.GetType().Name) } }
  }
  $suffix = if ($debugEnabled) { ' [' + ($debug -join ';') + ']' } else { '' }
  throw ('The Windows accessibility snapshot is stale; refresh computer_elements.' + $suffix)
}
function Get-ControlTypeName($element) {
  $programmatic = $element.Current.ControlType.ProgrammaticName
  return ($programmatic -replace '^ControlType\.','')
}
function Try-Pattern($element, $pattern) {
  $object = $null
  if ($element.TryGetCurrentPattern($pattern, [ref]$object)) { return $object }
  return $null
}
function Get-UIABounds($element) {
  $rect = $element.Current.BoundingRectangle
  if ($rect.IsEmpty -or [double]::IsInfinity($rect.X) -or [double]::IsNaN($rect.X)) { return $null }
  return @{ x=[int][Math]::Round($rect.X); y=[int][Math]::Round($rect.Y); width=[Math]::Max(0,[int][Math]::Round($rect.Width)); height=[Math]::Max(0,[int][Math]::Round($rect.Height)) }
}
function Get-UIAElementInfo($element, [long]$hwnd, [int[]]$path, [int]$depth, $rootElement) {
  $type = Get-ControlTypeName $element
  $invoke = Try-Pattern $element ([System.Windows.Automation.InvokePattern]::Pattern)
  $valuePattern = Try-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
  $toggle = Try-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern)
  $selection = Try-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $expand = Try-Pattern $element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  $range = Try-Pattern $element ([System.Windows.Automation.RangeValuePattern]::Pattern)
  $scrollItem = Try-Pattern $element ([System.Windows.Automation.ScrollItemPattern]::Pattern)
  $textPattern = Try-Pattern $element ([System.Windows.Automation.TextPattern]::Pattern)
  $actions = New-Object System.Collections.ArrayList
  $nativeActions = New-Object System.Collections.ArrayList
  if ($null -ne $invoke) { [void]$nativeActions.Add('Invoke') }
  if ($null -ne $selection) {
    [void]$nativeActions.Add('Select'); [void]$nativeActions.Add('AddToSelection'); [void]$nativeActions.Add('RemoveFromSelection')
  }
  if ($null -ne $toggle) { [void]$nativeActions.Add('Toggle') }
  if ($null -ne $expand) { [void]$nativeActions.Add('Expand'); [void]$nativeActions.Add('Collapse') }
  if ($null -ne $range -and -not $range.Current.IsReadOnly) { [void]$nativeActions.Add('Increment'); [void]$nativeActions.Add('Decrement') }
  if ($null -ne $scrollItem) { [void]$nativeActions.Add('ScrollIntoView') }
  if ($null -ne $valuePattern -and -not $valuePattern.Current.IsReadOnly) { [void]$nativeActions.Add('SetValue') }
  if ($element.Current.IsKeyboardFocusable) { [void]$nativeActions.Add('SetFocus') }
  if ($null -ne $invoke -or $null -ne $selection -or $null -ne $toggle -or $null -ne $expand) { [void]$actions.Add('press'); [void]$actions.Add('click') }
  if ($element.Current.IsKeyboardFocusable) { [void]$actions.Add('focus') }
  if (($null -ne $valuePattern -and -not $valuePattern.Current.IsReadOnly) -or $type -eq 'Edit') { [void]$actions.Add('set_value') }
  $nativeTextHwnd = 0
  $nativeTextClass = ''
  try { $nativeTextHwnd = [long]$element.Current.NativeWindowHandle } catch {}
  try { $nativeTextClass = [string]$element.Current.ClassName } catch {}
  if ($null -ne $textPattern -or ($type -eq 'Edit' -and $nativeTextHwnd -ne 0 -and $nativeTextClass -match '(?i)edit')) { [void]$actions.Add('select_text') }
  if ($null -ne $toggle) { [void]$actions.Add('toggle') }
  if ($null -ne $range -and -not $range.Current.IsReadOnly) { [void]$actions.Add('increment'); [void]$actions.Add('decrement') }
  if ($null -ne $scrollItem) { [void]$actions.Add('scroll_into_view') }
  $elementBounds = Get-UIABounds $element
  if ($null -ne $elementBounds) { [void]$actions.Add('scroll'); if (-not $actions.Contains('click')) { [void]$actions.Add('click') } }
  $value = ''
  if ($null -ne $valuePattern) { $value = [string]$valuePattern.Current.Value }
  elseif ($null -ne $range) { $value = [string]$range.Current.Value }
  $checked = if ($null -ne $toggle) { $toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On } else { $null }
  $expanded = if ($null -ne $expand) { $expand.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded } else { $null }
  return @{
    id = Encode-ElementId $hwnd $path $element $rootElement; source='windows-uia'; role=$type.ToLowerInvariant(); name=[string]$element.Current.Name
    value=$value; description=[string]$element.Current.HelpText; enabled=[bool]$element.Current.IsEnabled
    focused=[bool]$element.Current.HasKeyboardFocus; selected=if ($null -ne $selection) { [bool]$selection.Current.IsSelected } else { $false }
    checked=$checked; expanded=$expanded; bounds=Get-UIABounds $element; actions=@($actions); nativeActions=@($nativeActions)
    subrole=[string]$element.Current.ClassName; identifier=[string]$element.Current.AutomationId
    placeholder=[string]$element.Current.ItemStatus; url=''; depth=$depth; framework=[string]$element.Current.FrameworkId
  }
}
function Get-UIAApplicationRoot($options) {
  $requestedRaw = ([string]$options.application).ToLowerInvariant()
  $requested = $requestedRaw
  if ($requested.StartsWith('win32:')) { $requested = $requested.Substring(6) }
  if ($requested.StartsWith('startapp:')) { $requested = $requested.Substring(9) }
  if ($requestedRaw.StartsWith('startapp:')) {
    $hwnd = [NativeComputer]::GetForegroundWindow().ToInt64()
    return @{ hwnd=$hwnd; element=Get-RootElement $hwnd; applicationId=$requestedRaw }
  }
  if (-not $requested) {
    $hwnd = [NativeComputer]::GetForegroundWindow().ToInt64()
    return @{ hwnd=$hwnd; element=Get-RootElement $hwnd }
  }
  $desktop = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($candidate in @(Get-UIAChildren $desktop)) {
    $name = ([string]$candidate.Current.Name).ToLowerInvariant()
    $processName = ''
    try { $processName = ([Diagnostics.Process]::GetProcessById($candidate.Current.ProcessId).ProcessName).ToLowerInvariant() } catch {}
    if ($name -eq $requested -or $processName -eq $requested -or $name.Contains($requested) -or $processName.Contains($requested)) {
      $hwnd = [long]$candidate.Current.NativeWindowHandle
      return @{ hwnd=$hwnd; element=$candidate; applicationId="win32:$processName" }
    }
  }
  throw "No Windows UI Automation application matches '$requested'."
}
function Get-UIAElements($options) {
  $selected = Get-UIAApplicationRoot $options
  $hwnd = [long]$selected.hwnd
  $root = $selected.element
  $max = if ($options.maxElements) { [Math]::Max(1,[Math]::Min(500,[int]$options.maxElements)) } else { 120 }
  $maxDepth = if ($options.maxDepth) { [Math]::Max(1,[Math]::Min(40,[int]$options.maxDepth)) } else { 16 }
  $maxVisited = if ($options.maxVisitedNodes) { [Math]::Max($max,[Math]::Min(20000,[int]$options.maxVisitedNodes)) } else { [Math]::Max(1500,$max * 12) }
  $includeStatic = [bool]$options.includeStaticText
  $includeContainers = [bool]$options.includeContainers
  $roleFilter = ([string]$options.role).ToLowerInvariant()
  $query = ([string]$(if ($options.query) { $options.query } else { $options.name })).ToLowerInvariant()
  $items = New-Object System.Collections.ArrayList
  $script:visitedUIANodes = 0
  function Walk-UIA($element, [int[]]$path, [int]$depth) {
    if ($depth -gt $maxDepth -or $items.Count -ge $max -or $script:visitedUIANodes -ge $maxVisited) { return }
    $script:visitedUIANodes++
    $type = Get-ControlTypeName $element
    $interesting = $InteractiveTypes -contains $type -or $element.Current.IsKeyboardFocusable -or ($includeStatic -and $StaticTypes -contains $type) -or ($includeContainers -and $ContainerTypes -contains $type -and [string]$element.Current.Name)
    if ($depth -gt 0 -and $interesting) {
      $info = Get-UIAElementInfo $element $hwnd $path $depth $root
      $searchable = "$($info.name) $($info.description) $($info.value)".ToLowerInvariant()
      if ((-not $roleFilter -or $info.role -eq $roleFilter) -and (-not $query -or $searchable.Contains($query))) { [void]$items.Add($info) }
    }
    $children = @(Get-UIAChildren $element)
    for ($i=0; $i -lt $children.Count -and $items.Count -lt $max -and $script:visitedUIANodes -lt $maxVisited; $i++) { Walk-UIA $children[$i] @($path + $i) ($depth + 1) }
  }
  Walk-UIA $root @() 0
  $processName = ''
  try { $processName = ([Diagnostics.Process]::GetProcessById($root.Current.ProcessId).ProcessName).ToLowerInvariant() } catch {}
  $applicationBounds = Get-UIABounds $root
  if ($null -eq $applicationBounds -and $hwnd -ne 0) {
    $rect = New-Object NativeComputer+RECT
    if ([NativeComputer]::GetWindowRect([IntPtr]$hwnd, [ref]$rect)) {
      $applicationBounds = @{ x=$rect.Left; y=$rect.Top; width=$rect.Right-$rect.Left; height=$rect.Bottom-$rect.Top }
    }
  }
  return @{ hwnd=$hwnd; application=[string]$root.Current.Name; applicationId=$(if ($processName) { "win32:$processName" } else { [string]$selected.applicationId }); elements=@($items); screenshotBounds=$applicationBounds }
}
function Complete-UIASettle($subscription) {
  if ($null -eq $subscription -or -not $subscription.IsActive) {
    if ($null -ne $subscription) { $subscription.Dispose() }
    Start-Sleep -Milliseconds 180
    return @{ settleDurationMs=180; settleEventCount=0; settleSource='bounded-fallback' }
  }
  try {
    $duration = $subscription.WaitForQuiet(180, 250, 5000)
    return @{ settleDurationMs=[int]$duration; settleEventCount=[int]$subscription.EventCount; settleSource='uia-events' }
  } finally { $subscription.Dispose() }
}
function Invoke-UIAElementAction($request) {
  $payload = Decode-ElementId ([string]$request.elementId)
  $action = [string]$request.action
  try { $element = Resolve-UIAElement $payload }
  catch {
    $resolverError = $_.Exception.Message
    $bounds = $payload.bounds
    $canClick = $null -ne $bounds -and [int]$bounds.width -gt 0 -and [int]$bounds.height -gt 0
    $isPress = $action -eq 'press' -or $action -eq 'click' -or $action -eq 'native:Invoke'
    $isSetValue = $action -eq 'set_value' -or $action -eq 'native:SetValue'
    if (-not $canClick -or (-not $isPress -and -not $isSetValue)) { throw }
    $hwnd = [IntPtr][long]$payload.hwnd
    [NativeComputer]::BringWindowToTop($hwnd) | Out-Null
    [NativeComputer]::SetForegroundWindow($hwnd) | Out-Null
    [NativeComputer]::SetCursorPos([int]$bounds.x + [int]([int]$bounds.width/2), [int]$bounds.y + [int]([int]$bounds.height/2)) | Out-Null
    if ($action -eq 'click' -and [string]$request.button -eq 'right') { $down=[NativeComputer]::MOUSEEVENTF_RIGHTDOWN; $up=[NativeComputer]::MOUSEEVENTF_RIGHTUP }
    elseif ($action -eq 'click' -and [string]$request.button -eq 'middle') { $down=[NativeComputer]::MOUSEEVENTF_MIDDLEDOWN; $up=[NativeComputer]::MOUSEEVENTF_MIDDLEUP }
    else { $down=[NativeComputer]::MOUSEEVENTF_LEFTDOWN; $up=[NativeComputer]::MOUSEEVENTF_LEFTUP }
    $clickCount = if ($action -eq 'click' -and $request.count) { [Math]::Max(1,[Math]::Min(3,[int]$request.count)) } else { 1 }
    for ($i=0; $i -lt $clickCount; $i++) { [NativeComputer]::Mouse($down,0); [NativeComputer]::Mouse($up,0); Start-Sleep -Milliseconds 35 }
    if ($isSetValue) {
      Start-Sleep -Milliseconds 80
      Send-KeyChord 'ctrl+a'
      Start-Sleep -Milliseconds 30
      [NativeComputer]::UnicodeText([string]$request.value)
    }
    Start-Sleep -Milliseconds 180
    $fallback = @{ ok=$true; source='windows-uia-bounds-fallback'; action=$action; settleDurationMs=180; settleEventCount=0; settleSource='bounded-fallback' }
    if ($env:CHATGPT_COMPUTER_UIA_DEBUG -eq '1') { $fallback.resolverError = $resolverError }
    return $fallback
  }
  $settleSubscription = $null
  if (-not $request.eventObserverActive) {
    try {
      $observationRoot = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$payload.hwnd)
      if ($null -eq $observationRoot) { $observationRoot = $element }
      $settleSubscription = [UIASettleSubscription]::new($observationRoot)
    } catch {}
  }
  if ($action.StartsWith('native:')) {
    $nativeAction = $action.Substring(7)
    switch ($nativeAction) {
      'Invoke' { $pattern=Try-Pattern $element ([System.Windows.Automation.InvokePattern]::Pattern); if ($null -eq $pattern) { if ($null -ne $settleSubscription) { $settleSubscription.Dispose() }; $request.action='press'; return Invoke-UIAElementAction $request }; $pattern.Invoke() }
      'Select' { $pattern=Try-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern); if ($null -eq $pattern) { throw 'Select is no longer available.' }; $pattern.Select() }
      'AddToSelection' { $pattern=Try-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern); if ($null -eq $pattern) { throw 'AddToSelection is no longer available.' }; $pattern.AddToSelection() }
      'RemoveFromSelection' { $pattern=Try-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern); if ($null -eq $pattern) { throw 'RemoveFromSelection is no longer available.' }; $pattern.RemoveFromSelection() }
      'Toggle' { $pattern=Try-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern); if ($null -eq $pattern) { throw 'Toggle is no longer available.' }; $pattern.Toggle() }
      'Expand' { $pattern=Try-Pattern $element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern); if ($null -eq $pattern) { throw 'Expand is no longer available.' }; $pattern.Expand() }
      'Collapse' { $pattern=Try-Pattern $element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern); if ($null -eq $pattern) { throw 'Collapse is no longer available.' }; $pattern.Collapse() }
      'Increment' { if ($null -ne $settleSubscription) { $settleSubscription.Dispose() }; $request.action='increment'; return Invoke-UIAElementAction $request }
      'Decrement' { if ($null -ne $settleSubscription) { $settleSubscription.Dispose() }; $request.action='decrement'; return Invoke-UIAElementAction $request }
      'ScrollIntoView' { if ($null -ne $settleSubscription) { $settleSubscription.Dispose() }; $request.action='scroll_into_view'; return Invoke-UIAElementAction $request }
      'SetFocus' { $element.SetFocus() }
      'SetValue' { if ($null -ne $settleSubscription) { $settleSubscription.Dispose() }; $request.action='set_value'; return Invoke-UIAElementAction $request }
      default { throw "Unsupported Windows UIA native action: $nativeAction" }
    }
    $settled = if ($request.eventObserverActive) { @{ settleDurationMs=0; settleEventCount=0; settleSource='external-observer-pending' } } else { Complete-UIASettle $settleSubscription }
    return @{ ok=$true; source='windows-uia'; action=$action; settleDurationMs=$settled.settleDurationMs; settleEventCount=$settled.settleEventCount; settleSource=$settled.settleSource }
  }
  switch ($action) {
    'click' {
      $bounds = Get-UIABounds $element
      if ($null -eq $bounds -or $bounds.width -le 0 -or $bounds.height -le 0) { throw 'Element has no visible click bounds.' }
      $hwnd = [IntPtr][long]$payload.hwnd
      [NativeComputer]::BringWindowToTop($hwnd) | Out-Null
      [NativeComputer]::SetForegroundWindow($hwnd) | Out-Null
      [NativeComputer]::SetCursorPos($bounds.x + [int]($bounds.width / 2), $bounds.y + [int]($bounds.height / 2)) | Out-Null
      $button = [string]$request.button
      if ($button -eq 'right') { $down=[NativeComputer]::MOUSEEVENTF_RIGHTDOWN; $up=[NativeComputer]::MOUSEEVENTF_RIGHTUP }
      elseif ($button -eq 'middle') { $down=[NativeComputer]::MOUSEEVENTF_MIDDLEDOWN; $up=[NativeComputer]::MOUSEEVENTF_MIDDLEUP }
      else { $down=[NativeComputer]::MOUSEEVENTF_LEFTDOWN; $up=[NativeComputer]::MOUSEEVENTF_LEFTUP }
      $count = [Math]::Max(1,[Math]::Min(3,[int]$(if ($request.count) { $request.count } else { 1 })))
      for ($i=0; $i -lt $count; $i++) { [NativeComputer]::Mouse($down,0); [NativeComputer]::Mouse($up,0); Start-Sleep -Milliseconds 35 }
    }
    'focus' { $element.SetFocus() }
    'set_value' {
      $pattern = Try-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
      if ($null -ne $pattern -and -not $pattern.Current.IsReadOnly) {
        $pattern.SetValue([string]$request.value)
        break
      }
      $hwnd = [IntPtr][long]$payload.hwnd
      [NativeComputer]::BringWindowToTop($hwnd) | Out-Null
      [NativeComputer]::SetForegroundWindow($hwnd) | Out-Null
      try { $element.SetFocus() } catch {}
      Start-Sleep -Milliseconds 100
      $bounds = Get-UIABounds $element
      if ($null -ne $bounds -and $bounds.width -gt 0 -and $bounds.height -gt 0) {
        [NativeComputer]::SetCursorPos($bounds.x + [int]($bounds.width / 2), $bounds.y + [int]($bounds.height / 2)) | Out-Null
        [NativeComputer]::Mouse([NativeComputer]::MOUSEEVENTF_LEFTDOWN, 0)
        [NativeComputer]::Mouse([NativeComputer]::MOUSEEVENTF_LEFTUP, 0)
        Start-Sleep -Milliseconds 80
      }
      Send-KeyChord 'ctrl+a'
      Start-Sleep -Milliseconds 30
      [NativeComputer]::Key([uint16]$vk['backspace'], $true)
      [NativeComputer]::Key([uint16]$vk['backspace'], $false)
      [NativeComputer]::UnicodeText([string]$request.value)
    }
    'toggle' {
      $pattern = Try-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern)
      if ($null -eq $pattern) { throw 'Element does not support toggle.' }
      $pattern.Toggle()
    }
    'increment' {
      $pattern = Try-Pattern $element ([System.Windows.Automation.RangeValuePattern]::Pattern)
      if ($null -eq $pattern -or $pattern.Current.IsReadOnly) { throw 'Element does not support range changes.' }
      $step = if ($pattern.Current.SmallChange -gt 0) { $pattern.Current.SmallChange } else { 1 }
      $pattern.SetValue([Math]::Min($pattern.Current.Maximum, $pattern.Current.Value + $step))
    }
    'decrement' {
      $pattern = Try-Pattern $element ([System.Windows.Automation.RangeValuePattern]::Pattern)
      if ($null -eq $pattern -or $pattern.Current.IsReadOnly) { throw 'Element does not support range changes.' }
      $step = if ($pattern.Current.SmallChange -gt 0) { $pattern.Current.SmallChange } else { 1 }
      $pattern.SetValue([Math]::Max($pattern.Current.Minimum, $pattern.Current.Value - $step))
    }
    'scroll_into_view' {
      $pattern = Try-Pattern $element ([System.Windows.Automation.ScrollItemPattern]::Pattern)
      if ($null -ne $pattern) { $pattern.ScrollIntoView() } else { $element.SetFocus() }
    }
    'scroll' {
      $bounds = Get-UIABounds $element
      if ($null -eq $bounds -or $bounds.width -le 0 -or $bounds.height -le 0) { throw 'Element has no visible scroll bounds.' }
      $hwnd = [IntPtr][long]$payload.hwnd
      [NativeComputer]::BringWindowToTop($hwnd) | Out-Null
      [NativeComputer]::SetForegroundWindow($hwnd) | Out-Null
      [NativeComputer]::SetCursorPos($bounds.x + [int]($bounds.width / 2), $bounds.y + [int]($bounds.height / 2)) | Out-Null
      $direction = [string]$request.direction
      $pages = [Math]::Max(1,[Math]::Min(100,[int]$(if ($request.pages) { $request.pages } else { 1 })))
      $horizontal = $direction -eq 'left' -or $direction -eq 'right'
      $sign = if ($direction -eq 'up' -or $direction -eq 'left') { 1 } else { -1 }
      [NativeComputer]::Mouse($(if ($horizontal) { [NativeComputer]::MOUSEEVENTF_HWHEEL } else { [NativeComputer]::MOUSEEVENTF_WHEEL }), $sign * 120 * $pages)
    }
    'select_text' {
      $needle = [string]$request.text
      if (-not $needle) { throw 'select_text requires non-empty text.' }
      $pattern = Try-Pattern $element ([System.Windows.Automation.TextPattern]::Pattern)
      if ($null -ne $pattern) {
        $document = $pattern.DocumentRange
        $remaining = $document.Clone()
        $match = $null
        while ($null -ne $remaining) {
          $candidate = $remaining.FindText($needle, $false, $false)
          if ($null -eq $candidate) { break }
          $before = $document.Clone(); $before.MoveEndpointByRange([System.Windows.Automation.TextPatternRangeEndpoint]::End, $candidate, [System.Windows.Automation.TextPatternRangeEndpoint]::Start) | Out-Null
          $after = $document.Clone(); $after.MoveEndpointByRange([System.Windows.Automation.TextPatternRangeEndpoint]::Start, $candidate, [System.Windows.Automation.TextPatternRangeEndpoint]::End) | Out-Null
          $prefix = [string]$request.prefix; $suffix = [string]$request.suffix
          if ((-not $prefix -or $before.GetText(-1).EndsWith($prefix)) -and (-not $suffix -or $after.GetText(-1).StartsWith($suffix))) { $match = $candidate; break }
          $remaining = $document.Clone()
          $remaining.MoveEndpointByRange([System.Windows.Automation.TextPatternRangeEndpoint]::Start, $candidate, [System.Windows.Automation.TextPatternRangeEndpoint]::End) | Out-Null
        }
        if ($null -eq $match) { throw 'Text was not found in the Windows UI Automation element.' }
        if ([string]$request.selectionType -eq 'cursor_before') { $match.MoveEndpointByRange([System.Windows.Automation.TextPatternRangeEndpoint]::End, $match, [System.Windows.Automation.TextPatternRangeEndpoint]::Start) | Out-Null }
        elseif ([string]$request.selectionType -eq 'cursor_after') { $match.MoveEndpointByRange([System.Windows.Automation.TextPatternRangeEndpoint]::Start, $match, [System.Windows.Automation.TextPatternRangeEndpoint]::End) | Out-Null }
        $match.Select()
        break
      }

      # Standard Win32/WinForms Edit providers can expose ValuePattern without
      # TextPattern. Use their real child HWND for EM_SETSEL rather than global
      # keyboard emulation. The opaque element id supplies that HWND, and the
      # resolver has already verified the semantic UIA element identity.
      $valuePattern = Try-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
      $nativeTextHwnd = [IntPtr][long]$payload.nativeHwnd
      $snapshotControlType = [string]$payload.controlType
      $snapshotClassName = [string]$payload.className
      $nativePid = [uint32]0
      if ($nativeTextHwnd -eq [IntPtr]::Zero -or -not [NativeComputer]::IsWindow($nativeTextHwnd) -or
          $snapshotControlType -ne 'ControlType.Edit' -or $snapshotClassName -notmatch '(?i)edit' -or
          [NativeComputer]::GetWindowThreadProcessId($nativeTextHwnd, [ref]$nativePid) -eq 0 -or
          ($processId -gt 0 -and [int]$nativePid -ne $processId)) {
        throw 'Element does not support UI Automation text selection.'
      }
      # Once the native Edit identity has been verified, read from that HWND
      # directly. Windows 2025 can surface a transient UIA proxy whose
      # ValuePattern value lags the actual Win32 control text.
      $textValue = Get-NativeControlText $nativeTextHwnd
      $prefix = [string]$request.prefix
      $suffix = [string]$request.suffix
      $matchStart = -1
      $searchFrom = 0
      while ($searchFrom -le $textValue.Length) {
        $index = $textValue.IndexOf($needle, $searchFrom, [StringComparison]::Ordinal)
        if ($index -lt 0) { break }
        $beforeText = $textValue.Substring(0, $index)
        $afterIndex = $index + $needle.Length
        $afterText = $textValue.Substring($afterIndex)
        if ((-not $prefix -or $beforeText.EndsWith($prefix, [StringComparison]::Ordinal)) -and
            (-not $suffix -or $afterText.StartsWith($suffix, [StringComparison]::Ordinal))) {
          $matchStart = $index
          break
        }
        $searchFrom = $index + [Math]::Max(1, $needle.Length)
      }
      if ($matchStart -lt 0) { throw 'Text was not found in the Windows UI Automation element.' }
      $selectionStart = $matchStart
      $selectionEnd = $matchStart + $needle.Length
      if ([string]$request.selectionType -eq 'cursor_before') { $selectionEnd = $selectionStart }
      elseif ([string]$request.selectionType -eq 'cursor_after') { $selectionStart = $selectionEnd }
      [NativeComputer]::SendMessage($nativeTextHwnd, [NativeComputer]::EM_SETSEL, [IntPtr]$selectionStart, [IntPtr]$selectionEnd) | Out-Null
      [NativeComputer]::SendMessage($nativeTextHwnd, [NativeComputer]::EM_SCROLLCARET, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    }
    'press' {
      $pattern = Try-Pattern $element ([System.Windows.Automation.InvokePattern]::Pattern)
      if ($null -ne $pattern) { $pattern.Invoke(); break }
      $pattern = Try-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
      if ($null -ne $pattern) { $pattern.Select(); break }
      $pattern = Try-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern)
      if ($null -ne $pattern) { $pattern.Toggle(); break }
      $pattern = Try-Pattern $element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      if ($null -ne $pattern) {
        if ($pattern.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $pattern.Collapse() } else { $pattern.Expand() }
        break
      }
      $bounds = Get-UIABounds $element
      if ($null -eq $bounds) { throw 'Element has no invokable UIA pattern or visible bounds.' }
      $hwnd = [IntPtr][long]$payload.hwnd
      [NativeComputer]::BringWindowToTop($hwnd) | Out-Null
      [NativeComputer]::SetForegroundWindow($hwnd) | Out-Null
      [NativeComputer]::SetCursorPos($bounds.x + [int]($bounds.width/2), $bounds.y + [int]($bounds.height/2)) | Out-Null
      [NativeComputer]::Mouse([NativeComputer]::MOUSEEVENTF_LEFTDOWN,0); [NativeComputer]::Mouse([NativeComputer]::MOUSEEVENTF_LEFTUP,0)
    }
    default { throw "Unsupported Windows UIA action: $action" }
  }
  $settled = if ($request.eventObserverActive) { @{ settleDurationMs=0; settleEventCount=0; settleSource='external-observer-pending' } } else { Complete-UIASettle $settleSubscription }
  return @{ ok=$true; source='windows-uia'; action=$action; settleDurationMs=$settled.settleDurationMs; settleEventCount=$settled.settleEventCount; settleSource=$settled.settleSource }
}

function Invoke-WindowAction($request, $res) {
  $windowId = [string]$request.windowId
  $hwnd = [IntPtr][long]$windowId
  if ($hwnd -eq [IntPtr]::Zero -or -not [NativeComputer]::IsWindow($hwnd)) { throw 'The Windows window is stale or unavailable; refresh computer_state.' }
  if ($request.expectedName -and (Get-WindowTitle $hwnd) -ne [string]$request.expectedName) { throw 'The Windows window identity changed; refresh computer_state before acting.' }
  $subscription = $null
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -ne $root) { $subscription = [UIASettleSubscription]::new($root) }
  } catch {}
  $action = [string]$request.action
  switch ($action) {
    'activate' {
      [NativeComputer]::ShowWindow($hwnd, 9) | Out-Null
      [NativeComputer]::BringWindowToTop($hwnd) | Out-Null
      if (-not [NativeComputer]::SetForegroundWindow($hwnd)) { throw 'Windows refused to activate the selected window.' }
    }
    'close' { [NativeComputer]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
    'minimize' { [NativeComputer]::ShowWindow($hwnd, 6) | Out-Null }
    'maximize' { [NativeComputer]::ShowWindow($hwnd, 3) | Out-Null }
    'restore' { [NativeComputer]::ShowWindow($hwnd, 9) | Out-Null }
    'move_resize' {
      if ($null -eq $request.x -or $null -eq $request.y -or $null -eq $request.width -or $null -eq $request.height -or [int]$request.width -le 0 -or [int]$request.height -le 0) {
        throw 'move_resize requires x, y, and positive width and height.'
      }
      $x = [int][Math]::Round(([int]$request.x / [double]$res.api.width) * $res.display.width)
      $y = [int][Math]::Round(([int]$request.y / [double]$res.api.height) * $res.display.height)
      $width = [int][Math]::Round(([int]$request.width / [double]$res.api.width) * $res.display.width)
      $height = [int][Math]::Round(([int]$request.height / [double]$res.api.height) * $res.display.height)
      [NativeComputer]::ShowWindow($hwnd, 9) | Out-Null
      if (-not [NativeComputer]::MoveWindow($hwnd, $x, $y, $width, $height, $true)) { throw 'Windows refused the requested window geometry.' }
    }
    default { throw "Unsupported Windows window action: $action" }
  }
  $settled = Complete-UIASettle $subscription
  return @{ ok=$true; source='windows-win32-window'; action=$action; windowId=$windowId; settleDurationMs=$settled.settleDurationMs; settleEventCount=$settled.settleEventCount; settleSource=$settled.settleSource }
}

function Run-UIAObserverServer {
  $observations = @{}
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    $request = $null
    try {
      $request = $line | ConvertFrom-Json
      $target = [string]$request.target
      switch ([string]$request.command) {
        'ping' { $response = @{ id=$request.id; ok=$true; source='windows-uia-service' } }
        'watch' {
          if (-not $observations.ContainsKey($target)) {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$target)
            if ($null -eq $root) { throw 'Windows UIA observer target is stale.' }
            $subscription = [UIASettleSubscription]::new($root)
            if (-not $subscription.IsActive) { $subscription.Dispose(); throw 'Windows UIA event subscription is unavailable.' }
            $observations[$target] = $subscription
          }
          $subscription = $observations[$target]
          $response = @{ id=$request.id; ok=$true; source='windows-uia-service'; generation=[int]$subscription.EventCount }
        }
        'wait' {
          if (-not $observations.ContainsKey($target)) { throw 'Windows UIA target is not watched.' }
          $subscription = $observations[$target]
          $baseline = if ($null -ne $request.baseline) { [int]$request.baseline } else { 0 }
          $duration = $subscription.WaitForQuiet(
            $(if ($request.minimumMs) { [int]$request.minimumMs } else { 180 }),
            $(if ($request.quietMs) { [int]$request.quietMs } else { 250 }),
            $(if ($request.maximumMs) { [int]$request.maximumMs } else { 5000 })
          )
          $response = @{ id=$request.id; ok=$true; source='windows-uia-service'; durationMs=[int]$duration; eventCount=[Math]::Max(0,[int]$subscription.EventCount-$baseline); generation=[int]$subscription.EventCount }
        }
        'unwatch' {
          if ($observations.ContainsKey($target)) { $observations[$target].Dispose(); $observations.Remove($target) }
          $response = @{ id=$request.id; ok=$true; source='windows-uia-service' }
        }
        default { throw 'Unsupported observer command.' }
      }
    } catch {
      $response = @{ id=$(if ($null -ne $request) { $request.id } else { $null }); ok=$false; error=$_.Exception.Message }
    }
    [Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 6 -Compress))
    [Console]::Out.Flush()
  }
  foreach ($subscription in $observations.Values) { $subscription.Dispose() }
}

function Run-NativeRequestServer {
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    $request = $null
    try {
      if ([Text.Encoding]::UTF8.GetByteCount($line) -gt 1048576) { throw 'Native request exceeds its size limit.' }
      $request = $line | ConvertFrom-Json
      if ([string]$request.command -ne 'request' -or $null -eq $request.payload) { throw 'Invalid native request envelope.' }
      $payload = $request.payload | ConvertTo-Json -Depth 20 -Compress
      $pipe = New-Object System.IO.Pipes.AnonymousPipeServerStream(
        [System.IO.Pipes.PipeDirection]::Out,
        [System.IO.HandleInheritability]::Inheritable
      )
      $process = New-Object System.Diagnostics.Process
      $process.StartInfo.FileName = 'powershell.exe'
      $escapedPath = $PSCommandPath.Replace('"','\"')
      $pipeHandle = $pipe.GetClientHandleAsString()
      $process.StartInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$escapedPath`" --one-shot --request-pipe $pipeHandle"
      $process.StartInfo.UseShellExecute = $false
      $process.StartInfo.CreateNoWindow = $true
      $process.StartInfo.RedirectStandardOutput = $true
      $process.StartInfo.RedirectStandardError = $true
      if (-not $process.Start()) { $pipe.Dispose(); throw 'Could not start native helper child.' }
      $pipe.DisposeLocalCopyOfClientHandle()
      try {
        $writer = New-Object System.IO.StreamWriter($pipe, (New-Object System.Text.UTF8Encoding($false)))
        $writer.Write($payload)
        $writer.Flush()
        $writer.Dispose()
      } finally {
        $pipe.Dispose()
      }
      $output = $process.StandardOutput.ReadToEnd()
      $errorOutput = $process.StandardError.ReadToEnd()
      $process.WaitForExit()
      if ($process.ExitCode -ne 0) { throw $(if ($errorOutput) { $errorOutput.Trim() } else { "Native helper child exited with $($process.ExitCode)." }) }
      if ([Text.Encoding]::UTF8.GetByteCount($output) -gt 25165824) { throw 'Native helper child response exceeded its size limit.' }
      $result = $output | ConvertFrom-Json
      $response = @{ id=$request.id; ok=$true; result=$result }
    } catch {
      $response = @{ id=$(if ($null -ne $request) { $request.id } else { $null }); ok=$false; error=$_.Exception.Message }
    }
    [Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 20 -Compress))
    [Console]::Out.Flush()
  }
}

try {
  if ($args -contains '--request-server') { Run-NativeRequestServer; exit 0 }
  if ($args -contains '--observer-server') { Run-UIAObserverServer; exit 0 }
  $pipeIndex = [Array]::IndexOf([string[]]$args, '--request-pipe')
  if ($pipeIndex -ge 0 -and ($pipeIndex + 1) -lt $args.Count) {
    $clientPipe = New-Object System.IO.Pipes.AnonymousPipeClientStream(
      [System.IO.Pipes.PipeDirection]::In,
      [string]$args[$pipeIndex + 1]
    )
    try {
      $reader = New-Object System.IO.StreamReader($clientPipe, [System.Text.Encoding]::UTF8)
      $text = $reader.ReadToEnd()
      $reader.Dispose()
    } finally {
      $clientPipe.Dispose()
    }
  } else {
    $text = [Console]::In.ReadToEnd()
  }
  $request = $text | ConvertFrom-Json
  $apiWidth = if ($request.apiWidth) { [int]$request.apiWidth } else { 1280 }
  $res = Get-Resolution $apiWidth
  $interactiveDesktop = Test-InteractiveDesktop
  $mutatingActions = @($request.actions | Where-Object { [string]$_.action -ne 'screenshot' -and [string]$_.action -ne 'wait' })
  if (($null -ne $request.elementAction -or $null -ne $request.windowAction -or $request.targetApplication -or $mutatingActions.Count -gt 0) -and -not $interactiveDesktop) {
    Fail 'The Windows input desktop is locked, disconnected, or is a secure desktop; unlock the normal user desktop before sending computer input.'
  }
  $elementActionResult = $null
  if ($null -ne $request.elementAction) { $elementActionResult = Invoke-UIAElementAction $request.elementAction }
  $windowActionResult = $null
  if ($null -ne $request.windowAction) { $windowActionResult = Invoke-WindowAction $request.windowAction $res }
  if ($request.targetApplication) {
    $target = [string]$request.targetApplication
    $needle = $target.ToLowerInvariant().Replace('win32:','')
    $candidate = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName.ToLowerInvariant() -eq $needle -or $_.MainWindowTitle.ToLowerInvariant().Contains($needle)) } | Select-Object -First 1)
    if ($candidate.Count -gt 0) {
      if ($request.activateTargetApplication -ne $false) {
        [NativeComputer]::BringWindowToTop([IntPtr]$candidate[0].MainWindowHandle) | Out-Null
        [NativeComputer]::SetForegroundWindow([IntPtr]$candidate[0].MainWindowHandle) | Out-Null
      }
    } elseif ($target.StartsWith('startapp:')) {
      Start-Process explorer.exe "shell:AppsFolder\$($target.Substring(9))"
      Start-Sleep -Milliseconds 600
    } else { Start-Process $target; Start-Sleep -Milliseconds 600 }
  }
  foreach ($a in @($request.actions)) {
    switch ([string]$a.action) {
      'screenshot' { }
      'move' {
        if ($null -eq $a.x -or $null -eq $a.y) { Fail 'move requires x and y' }
        $p = Scale-Point ([int]$a.x) ([int]$a.y) $res; [NativeComputer]::SetCursorPos($p.x, $p.y) | Out-Null
      }
      'click' {
        if ($null -ne $a.x -and $null -ne $a.y) { $p = Scale-Point ([int]$a.x) ([int]$a.y) $res; [NativeComputer]::SetCursorPos($p.x, $p.y) | Out-Null }
        $button = if ($a.button) { [string]$a.button } else { 'left' }; $count = if ($a.count) { [int]$a.count } else { 1 }
        1..$count | ForEach-Object { [NativeComputer]::Mouse((Mouse-Flags $button $true), 0); Start-Sleep -Milliseconds 35; [NativeComputer]::Mouse((Mouse-Flags $button $false), 0); Start-Sleep -Milliseconds 35 }
      }
      'drag' {
        $points = @()
        if ($a.path -and @($a.path).Count -ge 2) { $points = @($a.path) }
        elseif ($null -ne $a.x -and $null -ne $a.y -and $null -ne $a.x2 -and $null -ne $a.y2) { $points = @(@{x=$a.x;y=$a.y}, @{x=$a.x2;y=$a.y2}) }
        else { Fail 'drag requires path or x/y/x2/y2' }
        $button = if ($a.button) { [string]$a.button } else { 'left' }
        $first = Scale-Point ([int]$points[0].x) ([int]$points[0].y) $res
        [NativeComputer]::SetCursorPos($first.x, $first.y) | Out-Null; [NativeComputer]::Mouse((Mouse-Flags $button $true), 0)
        foreach ($pt in $points[1..($points.Count-1)]) { $p = Scale-Point ([int]$pt.x) ([int]$pt.y) $res; [NativeComputer]::SetCursorPos($p.x, $p.y) | Out-Null; Start-Sleep -Milliseconds 12 }
        [NativeComputer]::Mouse((Mouse-Flags $button $false), 0)
      }
      'type' { [NativeComputer]::UnicodeText([string]$a.text) }
      'key' { Send-KeyChord ([string]$a.key) }
      'scroll' {
        if ($null -ne $a.x -and $null -ne $a.y) { $p = Scale-Point ([int]$a.x) ([int]$a.y) $res; [NativeComputer]::SetCursorPos($p.x, $p.y) | Out-Null }
        $amount = if ($a.amount) { [int]$a.amount } else { 3 }; $direction = if ($a.direction) { [string]$a.direction } else { 'down' }
        $delta = [int32](120 * $amount * $(if ($direction -eq 'up' -or $direction -eq 'left') { 1 } else { -1 }))
        $flags = if ($direction -eq 'left' -or $direction -eq 'right') { [NativeComputer]::MOUSEEVENTF_HWHEEL } else { [NativeComputer]::MOUSEEVENTF_WHEEL }
        [NativeComputer]::Mouse($flags, $delta)
      }
      'wait' { Start-Sleep -Milliseconds $(if ($a.durationMs) { [int]$a.durationMs } else { 1000 }) }
      default { Fail "unsupported action $($a.action)" }
    }
  }
  if (@($request.actions).Count -gt 0) { Start-Sleep -Milliseconds 180 }
  $listed = $null
  if ($request.includeElements) { $listed = Get-UIAElements $(if ($null -ne $request.elementOptions) { $request.elementOptions } else { [pscustomobject]@{} }) }
  $applications = if ($request.listApplications) { @(Get-Applications) } else { $null }
  $point = New-Object NativeComputer+POINT; [NativeComputer]::GetCursorPos([ref]$point) | Out-Null
  $active = [NativeComputer]::GetForegroundWindow(); $activeTitle = if ($active -ne [IntPtr]::Zero) { Get-WindowTitle $active } else { '' }
  $screenshotBounds = if ($null -ne $listed) { $listed.screenshotBounds } else { $null }
  if ($null -ne $screenshotBounds) {
    $cropX = [Math]::Max(0, [int]$screenshotBounds.x); $cropY = [Math]::Max(0, [int]$screenshotBounds.y)
    $cropWidth = [Math]::Min([int]$screenshotBounds.width, [int]$res.display.width - $cropX)
    $cropHeight = [Math]::Min([int]$screenshotBounds.height, [int]$res.display.height - $cropY)
    $screenshotBounds = if ($cropWidth -gt 0 -and $cropHeight -gt 0) { @{ x=$cropX; y=$cropY; width=$cropWidth; height=$cropHeight } } else { $null }
  }
  $shot = if ($request.includeScreenshot) { Capture-Screenshot $res $screenshotBounds } else { $null }
  $response = @{
    ok=$true; displayResolution=$res.display; apiResolution=$res.api; cursorPosition=Api-Point $point.X $point.Y $res
    activeWindow=if ($active -ne [IntPtr]::Zero) { @{ id=$active.ToInt64().ToString(); name=$activeTitle } } else { $null }
    windows=if ($request.includeWindows) { @(Get-VisibleWindows) } else { @() }
    screenshotMimeType=if ($shot) { 'image/png' } else { $null }; screenshotBase64=$shot
    screenshotScope=if ($shot) { if ($null -ne $screenshotBounds) { 'application' } else { 'desktop' } } else { $null }
    screenshotBounds=if ($shot) { $screenshotBounds } else { $null }
    permissions=@{ interactiveDesktop=$interactiveDesktop; screenLocked=(-not $interactiveDesktop); elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
    elementSource=if ($null -ne $listed) { 'windows-uia' } else { $null }
    elementApplication=if ($null -ne $listed) { $listed.application } else { $null }
    elementApplicationId=if ($null -ne $listed) { $listed.applicationId } else { $null }
    elements=if ($null -ne $listed) { @($listed.elements) } else { $null }
    elementMessage=if ($null -ne $listed) { "Returned $(@($listed.elements).Count) Windows UI Automation elements." } else { $null }
    elementActionResult=$elementActionResult
    windowActionResult=$windowActionResult
    applications=$applications
  }
  $response | ConvertTo-Json -Depth 12 -Compress
} catch { Fail $_.Exception.Message }
