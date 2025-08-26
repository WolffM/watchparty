<#
Cloudflare Tunnel helper.
Creates (or reuses) a dev ADMIN_KEY, starts the watchparty server if not running,
then launches an ephemeral Cloudflare quick tunnel pointing at the local port.

Prerequisites:
  1. Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation
     (On Windows you can winget:  winget install --id Cloudflare.cloudflared )
  2. Ensure it is in PATH (cloudflared --version works).

Usage:
  powershell -ExecutionPolicy Bypass -File .\scripts\tunnel.ps1

Optional env vars before running:
  $env:PORT          Force specific local port (otherwise will probe starting 3000)
  $env:ADMIN_KEY     Provide explicit admin key (else autogen)

Security note:
  Anyone with the admin key query (?admin=KEY) can control playback (only when visiting the /admin path).
  When using a public tunnel DO NOT expose /admin-key (works only in non-production anyway) —
  share only the base viewer URL and keep the /admin URL with the key private.
#>
Param(
  [int] $PreferredPort = 3000,
  [switch] $Quiet
)

function Get-FreePort {
  param([int]$Start,[int]$End)
  for($p=$Start; $p -le $End; $p++){
    $busy = Test-NetConnection -ComputerName 'localhost' -Port $p -InformationLevel Quiet
    if(-not $busy){ return $p }
  }
  return $Start
}

$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$stateDir = Join-Path $repoRoot 'state'
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir | Out-Null }
$adminKeyFile = Join-Path $stateDir 'admin.key'

if (-not $env:ADMIN_KEY -or [string]::IsNullOrWhiteSpace($env:ADMIN_KEY)) {
  if (Test-Path $adminKeyFile) {
    $env:ADMIN_KEY = Get-Content -Path $adminKeyFile -ErrorAction SilentlyContinue
  }
}
if (-not $env:ADMIN_KEY -or [string]::IsNullOrWhiteSpace($env:ADMIN_KEY)) {
  $env:ADMIN_KEY = [guid]::NewGuid().ToString('N')
  if (-not $Quiet) { Write-Host "Generated ADMIN_KEY: $($env:ADMIN_KEY)" -ForegroundColor Cyan }
  Set-Content -Path $adminKeyFile -Value $env:ADMIN_KEY -NoNewline
} else {
  if (-not $Quiet) { Write-Host "Using existing ADMIN_KEY (hidden)" -ForegroundColor Cyan }
  try { Set-Content -Path $adminKeyFile -Value $env:ADMIN_KEY -NoNewline } catch {}
}

if (-not $env:PORT -or [string]::IsNullOrWhiteSpace($env:PORT)) {
  $env:PORT = Get-FreePort -Start $PreferredPort -End ($PreferredPort+10)
}

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host 'cloudflared not found in PATH. Install it first.' -ForegroundColor Red
  exit 1
}

if (-not $Quiet) { Write-Host "Local server port: $($env:PORT)" -ForegroundColor Green }

# Detect if server already listening
$serverUp = Test-NetConnection -ComputerName 'localhost' -Port $env:PORT -InformationLevel Quiet
if (-not $serverUp) {
  if (-not $Quiet) { Write-Host 'Starting local server...' -ForegroundColor DarkGreen }
  $serverProc = Start-Process -FilePath 'powershell' -ArgumentList '-NoLogo','-NoProfile','-Command', "cd `"$repoRoot`"; npm run start" -PassThru
  # Wait briefly for startup
  Start-Sleep -Seconds 2
  $tries = 0
  while ($tries -lt 15 -and -not (Test-NetConnection -ComputerName 'localhost' -Port $env:PORT -InformationLevel Quiet)) {
    Start-Sleep -Milliseconds 400
    $tries++
  }
  if (-not (Test-NetConnection -ComputerName 'localhost' -Port $env:PORT -InformationLevel Quiet)) {
    Write-Host 'Server failed to start.' -ForegroundColor Red
    if ($serverProc) { try { $serverProc | Stop-Process -Force } catch {} }
    exit 1
  }
}

if (-not $Quiet) { Write-Host 'Launching Cloudflare quick tunnel...' -ForegroundColor Yellow }

$tunnelUrl = $null
# We stream output and capture the first trycloudflare URL
& cloudflared tunnel --url "http://localhost:$($env:PORT)" 2>&1 | ForEach-Object {
  $_
  if (-not $tunnelUrl -and $_ -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
    $tunnelUrl = $Matches[0]
    Write-Host "\n=== TUNNEL READY ===" -ForegroundColor Cyan
  Write-Host "Public URL (viewer):    $tunnelUrl" -ForegroundColor Green
  Write-Host "Admin URL (control):    $tunnelUrl/admin?admin=$($env:ADMIN_KEY)" -ForegroundColor Green
    Write-Host "(Keep admin key private; only share viewer URL)" -ForegroundColor DarkGray
    Write-Host "Press Ctrl+C to stop tunnel (server keeps running if started earlier)." -ForegroundColor DarkGray
  }
}
