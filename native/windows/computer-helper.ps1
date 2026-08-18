$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$signature = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeComputer {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
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
function Get-Applications {
  $byId = @{}
  foreach ($process in @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 })) {
    $processName = [string]$process.ProcessName
    $id = "win32:$($processName.ToLowerInvariant())"
    $path = ''
    try { $path = [string]$process.Path } catch {}
    $byId[$id] = @{
      id=$id; displayName=$(if ($process.MainWindowTitle) { [string]$process.MainWindowTitle } else { $processName })
      path=$path; isRunning=$true; pid=[int]$process.Id
    }
  }
  if (Get-Command Get-StartApps -ErrorAction SilentlyContinue) {
    foreach ($app in @(Get-StartApps)) {
      $appId = [string]$app.AppID
      if (-not $appId) { continue }
      $id = "startapp:$appId"
      if (-not $byId.ContainsKey($id)) {
        $byId[$id] = @{ id=$id; displayName=[string]$app.Name; path=$appId; isRunning=$false; pid=$null }
      }
      if ($byId.Count -ge 400) { break }
    }
  }
  return @($byId.Values | Sort-Object @{Expression='isRunning';Descending=$true}, @{Expression='displayName';Ascending=$true})
}
function Capture-Screenshot($res) {
  $bmp = New-Object System.Drawing.Bitmap($res.display.width, $res.display.height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
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
$vk = @{ 'return'=0x0D; 'enter'=0x0D; 'tab'=0x09; 'space'=0x20; 'backspace'=0x08; 'delete'=0x2E; 'escape'=0x1B; 'esc'=0x1B; 'left'=0x25; 'up'=0x26; 'right'=0x27; 'down'=0x28; 'home'=0x24; 'end'=0x23; 'pageup'=0x21; 'pagedown'=0x22; 'ctrl'=0x11; 'control'=0x11; 'alt'=0x12; 'shift'=0x10; 'meta'=0x5B; 'win'=0x5B; 'super'=0x5B }
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

function Encode-ElementId([long]$hwnd, [int[]]$path, $element) {
  $automationId = ''
  $controlType = ''
  try { $automationId = [string]$element.Current.AutomationId } catch {}
  try { $controlType = [string]$element.Current.ControlType.ProgrammaticName } catch {}
  $json = @{ source='windows-uia'; hwnd=$hwnd; path=@($path); automationId=$automationId; controlType=$controlType } | ConvertTo-Json -Compress
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+','-').Replace('/','_')
}
function Decode-ElementId([string]$value) {
  $base64 = $value.Replace('-','+').Replace('_','/')
  while (($base64.Length % 4) -ne 0) { $base64 += '=' }
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($base64)) | ConvertFrom-Json
  if ($payload.source -ne 'windows-uia') { throw 'Invalid Windows UIA element id.' }
  return $payload
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
  $root = Get-RootElement ([long]$payload.hwnd)
  $element = $root
  $pathResolved = $true
  try {
    foreach ($index in @($payload.path)) {
      $children = @(Get-UIAChildren $element)
      if ([int]$index -lt 0 -or [int]$index -ge $children.Count) { $pathResolved = $false; break }
      $element = $children[[int]$index]
    }
  } catch { $pathResolved = $false }

  $automationId = [string]$payload.automationId
  $controlType = [string]$payload.controlType
  if ($pathResolved) {
    $identityMatches = $true
    try {
      if ($automationId -and [string]$element.Current.AutomationId -ne $automationId) { $identityMatches = $false }
      if ($controlType -and [string]$element.Current.ControlType.ProgrammaticName -ne $controlType) { $identityMatches = $false }
    } catch { $identityMatches = $false }
    if ($identityMatches) { return $element }
  }

  # Control-view paths can move between short-lived helper processes. When the
  # provider exposes a stable AutomationId, recover the same semantic element
  # inside the original window instead of acting on whatever now occupies the
  # stale path.
  if ($automationId) {
    $idCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      $automationId
    )
    $matches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $idCondition)
    for ($i=0; $i -lt $matches.Count; $i++) {
      $candidate = $matches.Item($i)
      try {
        if (-not $controlType -or [string]$candidate.Current.ControlType.ProgrammaticName -eq $controlType) { return $candidate }
      } catch {}
    }
  }
  throw 'The Windows accessibility snapshot is stale; refresh computer_elements.'
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
function Get-UIAElementInfo($element, [long]$hwnd, [int[]]$path, [int]$depth) {
  $type = Get-ControlTypeName $element
  $invoke = Try-Pattern $element ([System.Windows.Automation.InvokePattern]::Pattern)
  $valuePattern = Try-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
  $toggle = Try-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern)
  $selection = Try-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $expand = Try-Pattern $element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  $range = Try-Pattern $element ([System.Windows.Automation.RangeValuePattern]::Pattern)
  $scrollItem = Try-Pattern $element ([System.Windows.Automation.ScrollItemPattern]::Pattern)
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
  if ($null -ne $invoke -or $null -ne $selection -or $null -ne $toggle -or $null -ne $expand) { [void]$actions.Add('press') }
  if ($element.Current.IsKeyboardFocusable) { [void]$actions.Add('focus') }
  if (($null -ne $valuePattern -and -not $valuePattern.Current.IsReadOnly) -or $type -eq 'Edit') { [void]$actions.Add('set_value') }
  if ($null -ne $toggle) { [void]$actions.Add('toggle') }
  if ($null -ne $range -and -not $range.Current.IsReadOnly) { [void]$actions.Add('increment'); [void]$actions.Add('decrement') }
  if ($null -ne $scrollItem) { [void]$actions.Add('scroll_into_view') }
  $value = ''
  if ($null -ne $valuePattern) { $value = [string]$valuePattern.Current.Value }
  elseif ($null -ne $range) { $value = [string]$range.Current.Value }
  $checked = if ($null -ne $toggle) { $toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On } else { $null }
  $expanded = if ($null -ne $expand) { $expand.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded } else { $null }
  return @{
    id = Encode-ElementId $hwnd $path $element; source='windows-uia'; role=$type.ToLowerInvariant(); name=[string]$element.Current.Name
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
  $includeStatic = [bool]$options.includeStaticText
  $includeContainers = [bool]$options.includeContainers
  $roleFilter = ([string]$options.role).ToLowerInvariant()
  $query = ([string]$(if ($options.query) { $options.query } else { $options.name })).ToLowerInvariant()
  $items = New-Object System.Collections.ArrayList
  function Walk-UIA($element, [int[]]$path, [int]$depth) {
    if ($depth -gt 20 -or $items.Count -ge $max) { return }
    $type = Get-ControlTypeName $element
    $interesting = $InteractiveTypes -contains $type -or $element.Current.IsKeyboardFocusable -or ($includeStatic -and $StaticTypes -contains $type) -or ($includeContainers -and $ContainerTypes -contains $type -and [string]$element.Current.Name)
    if ($depth -gt 0 -and $interesting) {
      $info = Get-UIAElementInfo $element $hwnd $path $depth
      $searchable = "$($info.name) $($info.description) $($info.value)".ToLowerInvariant()
      if ((-not $roleFilter -or $info.role -eq $roleFilter) -and (-not $query -or $searchable.Contains($query))) { [void]$items.Add($info) }
    }
    $children = @(Get-UIAChildren $element)
    for ($i=0; $i -lt $children.Count -and $items.Count -lt $max; $i++) { Walk-UIA $children[$i] @($path + $i) ($depth + 1) }
  }
  Walk-UIA $root @() 0
  $processName = ''
  try { $processName = ([Diagnostics.Process]::GetProcessById($root.Current.ProcessId).ProcessName).ToLowerInvariant() } catch {}
  return @{ hwnd=$hwnd; application=[string]$root.Current.Name; applicationId=$(if ($processName) { "win32:$processName" } else { [string]$selected.applicationId }); elements=@($items) }
}
function Invoke-UIAElementAction($request) {
  $payload = Decode-ElementId ([string]$request.elementId)
  $element = Resolve-UIAElement $payload
  $action = [string]$request.action
  if ($action.StartsWith('native:')) {
    $nativeAction = $action.Substring(7)
    switch ($nativeAction) {
      'Invoke' { $pattern=Try-Pattern $element ([System.Windows.Automation.InvokePattern]::Pattern); if ($null -eq $pattern) { throw 'Invoke is no longer available.' }; $pattern.Invoke() }
      'Select' { $pattern=Try-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern); if ($null -eq $pattern) { throw 'Select is no longer available.' }; $pattern.Select() }
      'AddToSelection' { $pattern=Try-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern); if ($null -eq $pattern) { throw 'AddToSelection is no longer available.' }; $pattern.AddToSelection() }
      'RemoveFromSelection' { $pattern=Try-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern); if ($null -eq $pattern) { throw 'RemoveFromSelection is no longer available.' }; $pattern.RemoveFromSelection() }
      'Toggle' { $pattern=Try-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern); if ($null -eq $pattern) { throw 'Toggle is no longer available.' }; $pattern.Toggle() }
      'Expand' { $pattern=Try-Pattern $element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern); if ($null -eq $pattern) { throw 'Expand is no longer available.' }; $pattern.Expand() }
      'Collapse' { $pattern=Try-Pattern $element ([System.Windows.Automation.ExpandCollapsePattern]::Pattern); if ($null -eq $pattern) { throw 'Collapse is no longer available.' }; $pattern.Collapse() }
      'Increment' { $request.action='increment'; return Invoke-UIAElementAction $request }
      'Decrement' { $request.action='decrement'; return Invoke-UIAElementAction $request }
      'ScrollIntoView' { $request.action='scroll_into_view'; return Invoke-UIAElementAction $request }
      'SetFocus' { $element.SetFocus() }
      'SetValue' { $request.action='set_value'; return Invoke-UIAElementAction $request }
      default { throw "Unsupported Windows UIA native action: $nativeAction" }
    }
    return @{ ok=$true; source='windows-uia'; action=$action }
  }
  switch ($action) {
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
  return @{ ok=$true; source='windows-uia'; action=$action }
}

try {
  $text = [Console]::In.ReadToEnd()
  $request = $text | ConvertFrom-Json
  $apiWidth = if ($request.apiWidth) { [int]$request.apiWidth } else { 1280 }
  $res = Get-Resolution $apiWidth
  $elementActionResult = $null
  if ($null -ne $request.elementAction) { $elementActionResult = Invoke-UIAElementAction $request.elementAction }
  if ($request.targetApplication) {
    $target = [string]$request.targetApplication
    $needle = $target.ToLowerInvariant().Replace('win32:','')
    $candidate = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName.ToLowerInvariant() -eq $needle -or $_.MainWindowTitle.ToLowerInvariant().Contains($needle)) } | Select-Object -First 1)
    if ($candidate.Count -gt 0) {
      [NativeComputer]::BringWindowToTop([IntPtr]$candidate[0].MainWindowHandle) | Out-Null
      [NativeComputer]::SetForegroundWindow([IntPtr]$candidate[0].MainWindowHandle) | Out-Null
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
  if (@($request.actions).Count -gt 0 -or $null -ne $request.elementAction) { Start-Sleep -Milliseconds 180 }
  $listed = $null
  if ($request.includeElements) { $listed = Get-UIAElements $(if ($null -ne $request.elementOptions) { $request.elementOptions } else { [pscustomobject]@{} }) }
  $applications = if ($request.listApplications) { @(Get-Applications) } else { $null }
  $point = New-Object NativeComputer+POINT; [NativeComputer]::GetCursorPos([ref]$point) | Out-Null
  $active = [NativeComputer]::GetForegroundWindow(); $activeTitle = if ($active -ne [IntPtr]::Zero) { Get-WindowTitle $active } else { '' }
  $shot = if ($request.includeScreenshot) { Capture-Screenshot $res } else { $null }
  $response = @{
    ok=$true; displayResolution=$res.display; apiResolution=$res.api; cursorPosition=Api-Point $point.X $point.Y $res
    activeWindow=if ($active -ne [IntPtr]::Zero) { @{ id=$active.ToInt64().ToString(); name=$activeTitle } } else { $null }
    windows=if ($request.includeWindows) { @(Get-VisibleWindows) } else { @() }
    screenshotMimeType=if ($shot) { 'image/png' } else { $null }; screenshotBase64=$shot
    permissions=@{ interactiveDesktop=$true; elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
    elementSource=if ($null -ne $listed) { 'windows-uia' } else { $null }
    elementApplication=if ($null -ne $listed) { $listed.application } else { $null }
    elementApplicationId=if ($null -ne $listed) { $listed.applicationId } else { $null }
    elements=if ($null -ne $listed) { @($listed.elements) } else { $null }
    elementMessage=if ($null -ne $listed) { "Returned $(@($listed.elements).Count) Windows UI Automation elements." } else { $null }
    elementActionResult=$elementActionResult
    applications=$applications
  }
  $response | ConvertTo-Json -Depth 12 -Compress
} catch { Fail $_.Exception.Message }
