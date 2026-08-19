$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$helper = Join-Path $root 'native\windows\computer-helper.ps1'
$observerPing = '{"id":1,"command":"ping"}' | powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper --observer-server | ConvertFrom-Json
if (-not $observerPing.ok -or $observerPing.source -ne 'windows-uia-service') { throw 'Windows UIA observer service ping failed.' }
$requestProbe = '{"id":2,"command":"request","payload":{"apiWidth":1280,"actions":[],"includeScreenshot":false,"includeWindows":false}}' | powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper --request-server | ConvertFrom-Json
if (-not $requestProbe.ok -or -not $requestProbe.result.ok) { throw "Windows native request service probe failed: $($requestProbe | ConvertTo-Json -Depth 8 -Compress)" }
$appScript = Join-Path $env:RUNNER_TEMP 'chatgpt-computer-uia-test-app.ps1'
if (-not $env:RUNNER_TEMP) { $appScript = Join-Path $env:TEMP 'chatgpt-computer-uia-test-app.ps1' }

@'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'ChatGPT Computer Semantic Test'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(520,260)
$entry = New-Object System.Windows.Forms.TextBox
$entry.Name = 'semanticEntry'
$entry.Location = New-Object System.Drawing.Point(30,30)
$entry.Size = New-Object System.Drawing.Size(430,30)
$entry.AccessibleName = 'Semantic entry'
$button = New-Object System.Windows.Forms.Button
$button.Name = 'applySemanticValue'
$button.Location = New-Object System.Drawing.Point(30,80)
$button.Size = New-Object System.Drawing.Size(220,35)
$button.Text = 'Apply semantic value'
$button.AccessibleName = 'Apply semantic value'
$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(30,135)
$status.Size = New-Object System.Drawing.Size(430,35)
$status.Text = 'idle'
$button.Add_Click({ $status.Text = 'clicked:' + $entry.Text })
$form.Controls.AddRange(@($entry,$button,$status))
[System.Windows.Forms.Application]::Run($form)
'@ | Set-Content -Path $appScript -Encoding UTF8

$app = Start-Process powershell.exe -ArgumentList @('-NoProfile','-STA','-ExecutionPolicy','Bypass','-File', $appScript) -PassThru
function Invoke-Helper($payload) {
  $text = $payload | ConvertTo-Json -Depth 12 -Compress
  $output = $text | powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper
  $json = $output | ConvertFrom-Json
  if (-not $json.ok) { throw $json.error }
  return $json
}
function Wait-Elements {
  for ($i=0; $i -lt 50; $i++) {
    try {
      $result = Invoke-Helper @{ apiWidth=1280; actions=@(); includeScreenshot=$false; includeWindows=$false; includeElements=$true; elementOptions=@{ application='ChatGPT Computer Semantic Test'; includeStaticText=$true; maxElements=80 } }
      if (@($result.elements).Count -gt 0) { return $result }
    } catch {}
    Start-Sleep -Milliseconds 200
  }
  throw 'Windows UI Automation test app did not expose elements.'
}

try {
  $applications = Invoke-Helper @{ apiWidth=1280; actions=@(); includeScreenshot=$false; includeWindows=$false; listApplications=$true }
  if (@($applications.applications).Count -lt 1) { throw 'Windows application inventory was empty.' }
  if (@($applications.applications | Where-Object { -not $_.PSObject.Properties['lastUsedDate'] -or -not $_.PSObject.Properties['useCount'] }).Count -gt 0) { throw 'Windows application usage metadata fields were missing.' }
  if (-not $applications.permissions.interactiveDesktop) { throw 'Windows runner did not report an interactive input desktop.' }
  $snapshot = Wait-Elements
  $entry = @($snapshot.elements) | Where-Object { $_.role -eq 'edit' -and $_.name -like '*Semantic entry*' } | Select-Object -First 1
  $button = @($snapshot.elements) | Where-Object { $_.role -eq 'button' -and $_.name -like '*Apply semantic value*' } | Select-Object -First 1
  if ($null -eq $entry) { throw "Semantic entry not found: $($snapshot.elements | ConvertTo-Json -Depth 8 -Compress)" }
  if ($null -eq $button) { throw 'Semantic button not found.' }
  if (-not $snapshot.elementApplicationId.StartsWith('win32:')) { throw "Missing stable Windows application id: $($snapshot.elementApplicationId)" }
  $scoped = Invoke-Helper @{ apiWidth=1280; actions=@(); includeScreenshot=$true; includeWindows=$false; includeElements=$true; elementOptions=@{ application='ChatGPT Computer Semantic Test'; includeStaticText=$true; maxElements=20 } }
  if ($scoped.screenshotScope -ne 'application' -or $null -eq $scoped.screenshotBounds -or -not $scoped.screenshotBase64) { throw 'Windows application state did not return a window-scoped screenshot.' }
  if (-not $entry.identifier -or $entry.depth -lt 1) { throw 'Windows UIA metadata was incomplete.' }
  if (@($button.nativeActions) -notcontains 'Invoke') { throw "Windows button did not advertise Invoke: $($button.nativeActions -join ', ')" }

  $windowState = Invoke-Helper @{ apiWidth=1280; actions=@(); includeScreenshot=$false; includeWindows=$true }
  $window = @($windowState.windows) | Where-Object { $_.name -like '*ChatGPT Computer Semantic Test*' } | Select-Object -First 1
  if ($null -eq $window) { throw 'Windows test window was not listed.' }
  foreach ($windowAction in @('activate','minimize','restore','maximize','restore')) {
    $controlled = Invoke-Helper @{ apiWidth=1280; actions=@(); includeScreenshot=$false; includeWindows=$true; windowAction=@{ windowId=$window.id; action=$windowAction } }
    if ($controlled.windowActionResult.source -ne 'windows-win32-window') { throw "Windows window action failed: $($controlled | ConvertTo-Json -Depth 6 -Compress)" }
  }
  $controlled = Invoke-Helper @{ apiWidth=1280; actions=@(); includeScreenshot=$false; includeWindows=$true; windowAction=@{ windowId=$window.id; action='move_resize'; x=40; y=40; width=800; height=500 } }
  if ($controlled.windowActionResult.action -ne 'move_resize') { throw 'Windows move_resize did not complete.' }

  # Window mutations can rebuild the UIA subtree. Refresh the semantic snapshot
  # instead of intentionally exercising a stale element id through the bounds fallback.
  $snapshot = Wait-Elements
  $entry = @($snapshot.elements) | Where-Object { $_.role -eq 'edit' -and $_.name -like '*Semantic entry*' } | Select-Object -First 1
  if ($null -eq $entry) { throw 'Semantic entry disappeared after Windows window actions.' }
  $setValue = Invoke-Helper @{ apiWidth=1280; actions=@(); includeScreenshot=$false; includeWindows=$false; elementAction=@{ elementId=$entry.id; action='set_value'; value='semantic-windows-ok' } }
  if ($setValue.elementActionResult.settleSource -ne 'uia-events') { throw "Windows action did not use UIA event settling: $($setValue.elementActionResult | ConvertTo-Json -Compress)" }
  if ($setValue.elementActionResult.settleDurationMs -lt 0) { throw 'Windows settle duration was invalid.' }
  $snapshot = Wait-Elements
  $entry = @($snapshot.elements) | Where-Object { $_.role -eq 'edit' -and $_.name -like '*Semantic entry*' } | Select-Object -First 1
  if (@($entry.actions) -notcontains 'select_text') { throw "Windows entry did not advertise select_text: $($entry.actions -join ', ')" }
  Invoke-Helper @{ apiWidth=1280; actions=@(); includeScreenshot=$false; includeWindows=$false; elementAction=@{ elementId=$entry.id; action='select_text'; text='windows'; prefix='semantic-'; suffix='-ok'; selectionType='text' } } | Out-Null
  $snapshot = Wait-Elements
  $button = @($snapshot.elements) | Where-Object { $_.role -eq 'button' -and $_.name -like '*Apply semantic value*' } | Select-Object -First 1
  Invoke-Helper @{ apiWidth=1280; actions=@(); includeScreenshot=$false; includeWindows=$false; elementAction=@{ elementId=$button.id; action='click'; button='left'; count=1 } } | Out-Null
  Start-Sleep -Milliseconds 200
  $snapshot = Wait-Elements
  $button = @($snapshot.elements) | Where-Object { $_.role -eq 'button' -and $_.name -like '*Apply semantic value*' } | Select-Object -First 1
  Invoke-Helper @{ apiWidth=1280; actions=@(); includeScreenshot=$false; includeWindows=$false; elementAction=@{ elementId=$button.id; action='native:Invoke'; value='' } } | Out-Null
  Start-Sleep -Milliseconds 300
  $snapshot = Wait-Elements
  $status = @($snapshot.elements) | Where-Object { "$($_.name) $($_.value)" -like '*clicked:semantic-windows-ok*' } | Select-Object -First 1
  if ($null -eq $status) { throw "Windows semantic action result not observed: $($snapshot.elements | ConvertTo-Json -Depth 8 -Compress)" }
  Write-Host 'Windows UI Automation semantic smoke passed.'
} finally {
  if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $appScript -Force -ErrorAction SilentlyContinue
}
