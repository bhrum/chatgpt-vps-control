$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$helper = Join-Path $root 'native\windows\computer-helper.ps1'
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
  $snapshot = Wait-Elements
  $entry = @($snapshot.elements) | Where-Object { $_.role -eq 'edit' -and $_.name -like '*Semantic entry*' } | Select-Object -First 1
  $button = @($snapshot.elements) | Where-Object { $_.role -eq 'button' -and $_.name -like '*Apply semantic value*' } | Select-Object -First 1
  if ($null -eq $entry) { throw "Semantic entry not found: $($snapshot.elements | ConvertTo-Json -Depth 8 -Compress)" }
  if ($null -eq $button) { throw 'Semantic button not found.' }
  if (-not $snapshot.elementApplicationId.StartsWith('win32:')) { throw "Missing stable Windows application id: $($snapshot.elementApplicationId)" }
  if (-not $entry.identifier -or $entry.depth -lt 1) { throw 'Windows UIA metadata was incomplete.' }
  if (@($button.nativeActions) -notcontains 'Invoke') { throw "Windows button did not advertise Invoke: $($button.nativeActions -join ', ')" }

  Invoke-Helper @{ apiWidth=1280; actions=@(); includeScreenshot=$false; includeWindows=$false; elementAction=@{ elementId=$entry.id; action='set_value'; value='semantic-windows-ok' } } | Out-Null
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
