Param(
  [switch] $Quiet
)
<#!
status.ps1 - show deployment/runtime state.
Prints: server PID (if running), offline flag status, ADMIN_KEY (masked), viewer/admin URLs (if urls.txt present).
#>
$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$stateDir = Join-Path $repoRoot 'state'
$pidFile = Join-Path $stateDir 'server.proc'
$offlineFlag = Join-Path $stateDir 'offline.flag'
$adminKeyFile = Join-Path $stateDir 'admin.key'
$urlsFile = Join-Path $stateDir 'urls.txt'

if (-not (Test-Path $stateDir)) { Write-Host "state directory missing" -ForegroundColor Yellow; exit 0 }

$pidVal = $null
if (Test-Path $pidFile) { try { $pidVal = Get-Content $pidFile -ErrorAction SilentlyContinue } catch {} }
$pidRunning = $false
if ($pidVal) { $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue; if ($proc) { $pidRunning=$true } }

$keyVal = $null
if (Test-Path $adminKeyFile) { try { $keyVal = Get-Content $adminKeyFile -ErrorAction SilentlyContinue } catch {} }
$masked = if ($keyVal -and $keyVal.Length -gt 8) { $keyVal.Substring(0,4) + '...' + $keyVal.Substring($keyVal.Length-4) } elseif ($keyVal) { $keyVal } else { '(none)' }

$offline = Test-Path $offlineFlag

Write-Host "Server PID File : $pidVal" -ForegroundColor Cyan
Write-Host "Server Running  : $pidRunning" -ForegroundColor Cyan
Write-Host "Offline Flag    : $offline" -ForegroundColor Cyan
Write-Host "ADMIN_KEY       : $masked" -ForegroundColor Cyan
if ($pidRunning) {
  try {
    $port = if ($env:PORT) { $env:PORT } else { '3000' }
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($resp -and $resp.StatusCode -eq 200) { Write-Host "Healthz         : OK" -ForegroundColor Green } else { Write-Host "Healthz         : FAIL" -ForegroundColor Red }
  } catch { Write-Host "Healthz         : ERR" -ForegroundColor Red }
}
# Tunnel process (simple presence check)
$tunnel = Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue
if ($tunnel) { $pids = ($tunnel | Select-Object -ExpandProperty Id) -join ','; Write-Host "Tunnel Process  : running (PID $pids)" -ForegroundColor Green }
else { Write-Host "Tunnel Process  : not running" -ForegroundColor Yellow }
if (Test-Path $urlsFile) {
  Write-Host "URLs:" -ForegroundColor Green
  Get-Content $urlsFile | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }
} else {
  Write-Host "(urls.txt not present - run deploy.ps1)" -ForegroundColor DarkGray
}
