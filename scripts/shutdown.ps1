Param(
  [switch] $Quiet,
  [switch] $Force,
  [switch] $LeaveTunnel,
  [int] $GraceSeconds = 5
)
# shutdown.ps1 - simple catch-all shutdown script
$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$stateDir = Join-Path $repoRoot 'state'
if (-not (Test-Path $stateDir)) { if (-not $Quiet) { Write-Host '[shutdown] no state dir' -ForegroundColor Yellow }; exit 0 }

# Offline flag
$offlineFlag = Join-Path $stateDir 'offline.flag'
try { Set-Content -Path $offlineFlag -Value '' -NoNewline -ErrorAction SilentlyContinue } catch {}
if (-not $Quiet) { Write-Host '[shutdown] offline flag created' -ForegroundColor Cyan }

# Stop server
$pidFile = Join-Path $stateDir 'server.proc'
$serverPid = $null
if (Test-Path $pidFile) { try { $serverPid = (Get-Content $pidFile -ErrorAction SilentlyContinue).Trim() } catch {} }
$serverStopped = $false
if ($serverPid) {
  $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
  if ($proc) {
    if (-not $Quiet) { Write-Host "[shutdown] stopping server PID $serverPid (grace $GraceSeconds s)" -ForegroundColor Cyan }
    try { $proc.CloseMainWindow() | Out-Null } catch {}
    $elapsed = 0
    while ($elapsed -lt $GraceSeconds) {
      Start-Sleep -Milliseconds 500; $elapsed += 0.5
      $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
      if (-not $proc) { $serverStopped = $true; break }
    }
    if (-not $serverStopped -and ($Force -or $true)) {
      if (-not $Quiet) { Write-Host "[shutdown] force killing server PID $serverPid" -ForegroundColor Yellow }
      try { Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue } catch {}
      $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
      if (-not $proc) { $serverStopped = $true }
    }
  } else { if (-not $Quiet) { Write-Host '[shutdown] server not running' -ForegroundColor DarkGray } }
} else { if (-not $Quiet) { Write-Host '[shutdown] no server PID file' -ForegroundColor DarkGray } }
if ($serverStopped -and -not $Quiet) { Write-Host '[shutdown] server stopped' -ForegroundColor Green }

# Kill cloudflared
if (-not $LeaveTunnel) {
  $cfs = Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue
  if ($cfs) {
    $count = ($cfs | Measure-Object).Count
    if (-not $Quiet) { Write-Host "[shutdown] killing $count cloudflared process(es)" -ForegroundColor Cyan }
    foreach ($c in $cfs) { try { Stop-Process -Id $c.Id -Force -ErrorAction SilentlyContinue } catch {} }
  } else { if (-not $Quiet) { Write-Host '[shutdown] no cloudflared processes' -ForegroundColor DarkGray } }
} else { if (-not $Quiet) { Write-Host '[shutdown] leaving tunnel running (-LeaveTunnel)' -ForegroundColor Yellow } }

# Summary
if (-not $Quiet) {
  $srvRemain = $null; if ($serverPid) { $srvRemain = Get-Process -Id $serverPid -ErrorAction SilentlyContinue }
  $cfRemain = Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue
  Write-Host '[shutdown] summary' -ForegroundColor White
  Write-Host ("  offline.flag : {0}" -f (Test-Path $offlineFlag))
  if ($srvRemain) { Write-Host '  server       : RUNNING' } else { Write-Host '  server       : stopped' }
  $cfCount = ($cfRemain | Measure-Object).Count
  Write-Host ("  tunnel procs : {0}" -f $cfCount)
}