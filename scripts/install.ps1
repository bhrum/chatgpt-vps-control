$ErrorActionPreference = 'Stop'
$RepoUrl = if ($env:CHATGPT_COMPUTER_REPO_URL) { $env:CHATGPT_COMPUTER_REPO_URL } else { 'https://github.com/bhrum/chatgpt-vps-control.git' }
$InstallRoot = if ($env:CHATGPT_COMPUTER_INSTALL_ROOT) { $env:CHATGPT_COMPUTER_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'ChatGPTComputerControl' }
$Src = Join-Path $InstallRoot 'src'

function Has-Command($name) { return $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

if (-not (Has-Command 'git.exe')) {
  if (Has-Command 'winget.exe') { winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements }
  else { throw 'Git is required. Install Git and rerun this installer.' }
}
if (-not (Has-Command 'node.exe')) {
  if (Has-Command 'winget.exe') { winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements }
  else { throw 'Node.js 20+ is required. Install Node.js and rerun this installer.' }
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}
$major = [int]((& node -p "Number(process.versions.node.split('.')[0])").Trim())
if ($major -lt 20) { throw "Node.js 20+ is required; found $(& node --version)." }

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
if (Test-Path (Join-Path $Src '.git')) {
  & git -C $Src fetch --all --prune
  & git -C $Src pull --ff-only
} else {
  if (Test-Path $Src) { Remove-Item -Recurse -Force $Src }
  & git clone $RepoUrl $Src
}
& npm --prefix $Src ci --omit=dev
Push-Location $Src
try { & npm link } finally { Pop-Location }

& chatgpt-computer-control setup
try { & chatgpt-computer-control doctor } catch { Write-Warning $_ }
& chatgpt-computer-control service install

Write-Host ''
Write-Host 'ChatGPT Computer Control installed.'
Write-Host 'Run: chatgpt-computer-control url'
Write-Host 'The MCP binds to loopback by default. Use an authenticated HTTPS tunnel or trusted private transport when connecting remotely.'
