Param(
  [switch] $Quiet,
  [string] $Hostname = 'hadoku.me',
  [string] $TunnelName = 'hadokume',   # Named tunnel you created earlier
  [switch] $RunTunnel,                 # Tunnel now runs by default; use -RunTunnel:$false to skip
  [string] $ServiceName = 'watchparty',
  [string] $ConfigPath = "$env:USERPROFILE\.cloudflared\config.yml",  # cloudflared config (YAML)
  [switch] $CheckPublic                 # After start, probe https://$Hostname/healthz
)
<#
deploy.ps1 – Bring site online (clears offline.flag), ensure ADMIN_KEY, start server, optionally run a named Cloudflare tunnel.

Prereqs for -RunTunnel:
  * cloudflared installed & authenticated (cloudflared tunnel login)
  * Named tunnel already created: cloudflared tunnel create <TunnelName>
  * DNS CNAME (or AAAA) for $Hostname points to the tunnel (cloudflared tunnel route dns <TunnelName> <hostname>)

Outputs:
  * state/server.proc : PID file
  * state/admin.key      : persisted ADMIN_KEY
  * state/urls.txt       : viewer/admin URLs
  * Clears state/offline.flag to allow traffic
#>
# Default: run tunnel unless user explicitly sets -RunTunnel:$false
if (-not $PSBoundParameters.ContainsKey('RunTunnel')) { $RunTunnel = $true }
$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$stateDir = Join-Path $repoRoot 'state'
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir | Out-Null }
$offlineFlag = Join-Path $stateDir 'offline.flag'
if (Test-Path $offlineFlag) { Remove-Item $offlineFlag -ErrorAction SilentlyContinue }
if (-not $Quiet) { Write-Host "[deploy] Online (offline flag cleared)" -ForegroundColor Green }

# Ensure ADMIN_KEY (reuse if exists)
$adminKeyFile = Join-Path $stateDir 'admin.key'
if (-not $env:ADMIN_KEY -or [string]::IsNullOrWhiteSpace($env:ADMIN_KEY)) {
  if (Test-Path $adminKeyFile) { $env:ADMIN_KEY = Get-Content $adminKeyFile -ErrorAction SilentlyContinue }
}
if (-not $env:ADMIN_KEY -or [string]::IsNullOrWhiteSpace($env:ADMIN_KEY)) {
  $env:ADMIN_KEY = [guid]::NewGuid().ToString('N')
  if (-not $Quiet) { Write-Host "[deploy] Generated ADMIN_KEY (hidden)" -ForegroundColor Cyan }
} else { if (-not $Quiet) { Write-Host "[deploy] Using existing ADMIN_KEY (hidden)" -ForegroundColor DarkCyan } }
try { Set-Content -Path $adminKeyFile -Value $env:ADMIN_KEY -NoNewline } catch {}

# Port
if (-not $env:PORT -or [string]::IsNullOrWhiteSpace($env:PORT)) { $env:PORT = '3000' }

$pidFile = Join-Path $stateDir 'server.proc'
if (Test-Path $pidFile) {
  try {
    $existingId = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($existingId) {
      $procLive = Get-Process -Id $existingId -ErrorAction SilentlyContinue
      if ($procLive) { if (-not $Quiet) { Write-Host "[deploy] Server already running (PID $existingId)" -ForegroundColor Yellow }
        $alreadyRunning = $true
      }
    }
  } catch {}
}
if (-not $alreadyRunning) {
  if (-not $Quiet) { Write-Host "[deploy] Starting server (node) on port $($env:PORT)..." -ForegroundColor Cyan }
  $logDir = Join-Path $stateDir 'logs'; if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $outLog = Join-Path $logDir "server-$stamp.out.log"
  $errLog = Join-Path $logDir "server-$stamp.err.log"
  try {
    $proc = Start-Process -FilePath 'node' -WorkingDirectory $repoRoot -ArgumentList 'apps/watchparty-server/server.js' -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  } catch {
    Write-Host "[deploy] Failed to start node: $($_.Exception.Message)" -ForegroundColor Red; exit 1
  }
  Set-Content -Path $pidFile -Value $proc.Id -NoNewline -ErrorAction SilentlyContinue
  if (-not $Quiet) { Write-Host "[deploy] Server PID: $($proc.Id) (logs: $outLog)" -ForegroundColor DarkGray }
  # Health check loop
  $healthy=$false; for($i=0;$i -lt 40;$i++){ try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($env:PORT)/healthz" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue; if ($r.StatusCode -eq 200) { $healthy=$true; break } } catch {}; Start-Sleep -Milliseconds 250 }
  if (-not $healthy) {
    Write-Host "[deploy] Health check failed; recent stderr:" -ForegroundColor Red
    if (Test-Path $errLog) { Get-Content $errLog -Tail 40 }
    else { Write-Host "(no stderr log yet)" -ForegroundColor DarkGray }
    Write-Host "[deploy] Stopping failed process." -ForegroundColor Red
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    exit 1
  } elseif (-not $Quiet) { Write-Host "[deploy] Health OK." -ForegroundColor Green }
}

$viewerUrl = "https://$Hostname/watchparty?key=$($env:ADMIN_KEY)"
$adminUrl  = "https://$Hostname/watchparty-admin?key=$($env:ADMIN_KEY)"
Write-Host "Viewer URL: $viewerUrl" -ForegroundColor Green
Write-Host "Admin URL : $adminUrl" -ForegroundColor Green
try { Set-Content -Path (Join-Path $stateDir 'urls.txt') -Value @($viewerUrl,$adminUrl) -ErrorAction SilentlyContinue } catch {}

if ($RunTunnel) {
  if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host "[deploy] cloudflared not installed; skipping tunnel" -ForegroundColor Yellow
  }
  else {
    # Detect existing cloudflared for this tunnel (simple heuristic)
    $existingTunnel = Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and (Get-Content -Path $_.Path -ErrorAction SilentlyContinue | Out-String) -match $TunnelName } # heuristic weak; ignore if fails
    if ($existingTunnel) {
      if (-not $Quiet) { Write-Host "[deploy] Tunnel '$TunnelName' already appears to be running (PID $($existingTunnel.Id)); skipping start" -ForegroundColor Yellow }
    } else {
      if (-not $Quiet) { Write-Host "[deploy] Starting named tunnel '$TunnelName' (background)..." -ForegroundColor DarkCyan }
      $logDir = Join-Path $stateDir 'logs'; if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
  $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
  $outLog = Join-Path $logDir ("tunnel-" + $ts + '.out.log')
  $errLog = Join-Path $logDir ("tunnel-" + $ts + '.err.log')
  $args = @('tunnel')
      if (Test-Path $ConfigPath) { $args += @('--config', $ConfigPath) }
      $args += @('run', $TunnelName)
  try { Start-Process -FilePath 'cloudflared' -ArgumentList $args -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden | Out-Null }
      catch { Write-Host "[deploy] Failed to start tunnel: $($_.Exception.Message)" -ForegroundColor Red }
  if (-not $Quiet) { Write-Host "[deploy] Tunnel logs: $outLog / $errLog" -ForegroundColor DarkGray }
    }
  }
}

if ($CheckPublic) {
  if (-not $Quiet) { Write-Host "[deploy] Probing public https://$Hostname/healthz ..." -ForegroundColor DarkGray }
  $ok=$false; for($i=0;$i -lt 40;$i++){ try { $r = Invoke-WebRequest -Uri "https://$Hostname/healthz" -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue; if ($r.StatusCode -eq 200) { $ok=$true; break } } catch {}; Start-Sleep -Milliseconds 500 }
  if ($ok) { if (-not $Quiet) { Write-Host "[deploy] Public health OK" -ForegroundColor Green } }
  else { Write-Host "[deploy] Public health probe failed (maybe DNS/TLS not propagated yet)" -ForegroundColor Yellow }
}
