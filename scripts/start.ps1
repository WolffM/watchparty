Param(
  [switch] $Quiet,
  [int] $PreferredPort = 3000,
  [switch] $NoTunnel,
  [switch] $FollowTunnel,
  [switch] $BackgroundTunnel,
  # Deprecated legacy flag (ignored, retained so old muscle memory doesn't break the script)
  [switch] $UseNetlify
)

<#
start.ps1 – launches the watchparty server AND (by default) a Cloudflare quick tunnel.

Switches:
  -Quiet        Reduce console noise.
  -PreferredPort <int>  Starting port to probe (default 3000).
  -NoTunnel         Skip launching any tunnel; just run local server.

Environment overrides (optional):
  PORT, ADMIN_KEY

Behavior:
  * Ensures ADMIN_KEY (persist + reuse state/admin.key)
  * Ensures at least one playable *.wp.mp4 / .webm (attempts bootstrap transcode if ffmpeg + source file)
  * Starts server in background (records PID)
  * If tunnel enabled: Cloudflare prints viewer + admin URLs
  * Ctrl+C stops tunnel only; server keeps running. Use Stop-Process -Id <PID> to stop server manually.
#>

function Get-FreePort {
  param([int]$Start,[int]$End)
  for($p=$Start; $p -le $End; $p++){
    $busy = Test-NetConnection -ComputerName 'localhost' -Port $p -InformationLevel Quiet -WarningAction SilentlyContinue
    if(-not $busy){ return $p }
  }
  return $Start
}

# --- .env loader (loads ADMIN_KEY / PORT if not already set in environment) ---
$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName  # scripts/ -> repo root
$dotenv = Join-Path $repoRoot '.env'
if (Test-Path $dotenv) {
  foreach ($line in Get-Content $dotenv) {
    if ($line -match '^\s*#') { continue }
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$') {
      $k = $matches[1]
      $v = $matches[2].Trim().Trim('"').Trim("'")
  $existingVal = $null
  try { $existingVal = (Get-Item -Path env:$k -ErrorAction SilentlyContinue).Value } catch {}
  if ([string]::IsNullOrWhiteSpace($existingVal)) { Set-Item -Path env:$k -Value $v }
    }
  }
}

if ($UseNetlify -and -not $Quiet) {
  Write-Host "(-UseNetlify ignored; Netlify support was removed)" -ForegroundColor DarkYellow
}

# Ensure ADMIN_KEY present (re-usable for future milestones)
if (-not $env:ADMIN_KEY -or [string]::IsNullOrWhiteSpace($env:ADMIN_KEY)) {
  $env:ADMIN_KEY = [guid]::NewGuid().ToString('N')
  if (-not $Quiet) { Write-Host "Generated ADMIN_KEY: $($env:ADMIN_KEY)" -ForegroundColor Cyan }
} else {
  if (-not $Quiet) { Write-Host "Using existing ADMIN_KEY (hidden)" -ForegroundColor Cyan }
}

# Persist key to repo-local state/admin.key for convenience (local dev only)
$stateDir = Join-Path $repoRoot 'state'
if (-not (Test-Path $stateDir)) { try { New-Item -ItemType Directory -Path $stateDir | Out-Null } catch {} }
$adminKeyFile = Join-Path $stateDir 'admin.key'
try { Set-Content -Path $adminKeyFile -Value $env:ADMIN_KEY -NoNewline } catch { if (-not $Quiet) { Write-Host "(Failed to save admin.key: $($_.Exception.Message))" -ForegroundColor DarkRed } }
if ((Test-Path $adminKeyFile) -and -not $Quiet) { Write-Host "(Saved ADMIN_KEY to $adminKeyFile)" -ForegroundColor DarkGray }

<# Determine port & whether a server is already running #>
if (-not $env:PORT -or [string]::IsNullOrWhiteSpace($env:PORT)) {
  $free = Get-FreePort -Start $PreferredPort -End ($PreferredPort + 10)
  if ($free -ne $PreferredPort -and -not $Quiet) { Write-Host "Port $PreferredPort busy; using free port $free" -ForegroundColor Yellow }
  $env:PORT = $free
} elseif (-not $Quiet) { Write-Host "Using preset PORT=$($env:PORT)" -ForegroundColor DarkCyan }

$existing = Test-NetConnection -ComputerName 'localhost' -Port $env:PORT -InformationLevel Quiet -WarningAction SilentlyContinue
if ($existing) {
  if (-not $Quiet) { Write-Host "Re-using existing server on port $($env:PORT) (no new process started)." -ForegroundColor DarkYellow }
}
else {
  if (-not $Quiet) { Write-Host "Starting watchparty server on port $($env:PORT)..." -ForegroundColor Green }
}

# --- Library Verification & Bootstrap Transcode ---
$mediaRoot = Join-Path $repoRoot 'media'
if (-not (Test-Path $mediaRoot)) { New-Item -ItemType Directory -Path $mediaRoot | Out-Null }

function Get-PlayableFiles {
  Get-ChildItem -Path $mediaRoot -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name.ToLower().EndsWith('.wp.mp4') -or $_.Name.ToLower().EndsWith('.webm') }
}
function Get-FirstSourceMedia {
  $mkv = Get-ChildItem -Path $mediaRoot -Recurse -File -Include *.mkv -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($mkv) { return $mkv }
  $rawMp4 = Get-ChildItem -Path $mediaRoot -Recurse -File -Include *.mp4 -ErrorAction SilentlyContinue | Where-Object { -not $_.Name.ToLower().EndsWith('.wp.mp4') } | Select-Object -First 1
  return $rawMp4
}
$playable = Get-PlayableFiles
if (-not $playable -or $playable.Count -eq 0) {
  if (-not $Quiet) { Write-Host "No playable *.wp.mp4/.webm assets. Attempting bootstrap transcode..." -ForegroundColor Yellow }
  $firstSrc = Get-FirstSourceMedia
  if ($firstSrc) {
    if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
      Write-Host "ffmpeg not found. Cannot transcode. Install ffmpeg or add a playable file." -ForegroundColor Red
      exit 1
    }
    $base = if ($firstSrc.Name.ToLower().EndsWith('.mkv')) { $firstSrc.FullName -replace '\\.mkv$','' } elseif ($firstSrc.Name.ToLower().EndsWith('.mp4')) { $firstSrc.FullName -replace '\\.mp4$','' } else { $firstSrc.FullName }
    $outPath = $base + '.wp.mp4'
    if (-not (Test-Path $outPath)) {
      Write-Host "Transcoding: $($firstSrc.Name) -> $(Split-Path -Leaf $outPath)" -ForegroundColor Cyan
  # Force 8-bit yuv420p output (hardware/browser friendly) regardless of 10-bit source
  $ffArgs = @('-y','-i', $firstSrc.FullName,'-c:v','libx264','-pix_fmt','yuv420p','-profile:v','high','-level:v','4.0','-preset','veryfast','-crf','22','-c:a','aac','-b:a','128k','-movflags','+faststart', $outPath)
      & ffmpeg @ffArgs
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path $outPath)) {
        Write-Host "Bootstrap transcode failed." -ForegroundColor Red
        exit 1
      }
    }
    $playable = Get-PlayableFiles
  }
}
if (-not $playable -or $playable.Count -eq 0) {
  Write-Host "Library verification failed: no mp4/webm playable assets present." -ForegroundColor Red
  exit 1
} else {
  if (-not $Quiet) { Write-Host "Playable assets detected: $($playable.Count)" -ForegroundColor DarkGreen }
}

if (-not $existing) {
  # Launch server in background so we can also run tunnel
  $repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
  $serverCmd = "cd `"$repoRoot`"; npm run start"
  $serverProc = Start-Process -FilePath 'powershell' -ArgumentList '-NoLogo','-NoProfile','-Command', $serverCmd -PassThru
  if (-not $Quiet) { Write-Host "Server PID: $($serverProc.Id) (logs in that process)" -ForegroundColor DarkGray }
  # Wait until port is listening (or timeout)
  $tries = 0
  while ($tries -lt 30) {
    $listening = Test-NetConnection -ComputerName 'localhost' -Port $env:PORT -InformationLevel Quiet -WarningAction SilentlyContinue
    if ($listening) { break }
    Start-Sleep -Milliseconds 300
    $tries++
  }
  if (-not $listening) { Write-Host "Server failed to listen on port $($env:PORT) within timeout." -ForegroundColor Red; exit 1 }
  if (-not $Quiet) { Write-Host "Server is listening." -ForegroundColor DarkGreen }
} else { $serverProc = $null }

if ($NoTunnel) {
  if (-not $Quiet) { Write-Host "Tunnel disabled (-NoTunnel)." -ForegroundColor Yellow }
  Write-Host "Local Admin URL: http://localhost:$($env:PORT)/?admin=$($env:ADMIN_KEY)" -ForegroundColor Cyan
  Write-Host "Viewer URL:      http://localhost:$($env:PORT)/" -ForegroundColor Cyan
  if ($serverProc) { Write-Host "Press Ctrl+C to end this wrapper (server continues) or stop PID $($serverProc.Id)." -ForegroundColor DarkGray; Wait-Process -Id $serverProc.Id }
  else { Write-Host "Existing server in use; this wrapper will now wait (Ctrl+C to exit)." -ForegroundColor DarkGray; while ($true) { Start-Sleep -Seconds 3600 } }
  exit 0
}


if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host "cloudflared not found. Install it or use -NoTunnel to skip." -ForegroundColor Yellow
  Write-Host "Local Admin URL: http://localhost:$($env:PORT)/?admin=$($env:ADMIN_KEY)" -ForegroundColor Cyan
  Write-Host "Viewer URL:      http://localhost:$($env:PORT)/" -ForegroundColor Cyan
  if ($serverProc) { Wait-Process -Id $serverProc.Id } else { while ($true) { Start-Sleep -Seconds 3600 } }
  exit 0
}

if ($BackgroundTunnel) {
  if (-not $Quiet) { Write-Host "Launching Cloudflare quick tunnel (background mode)..." -ForegroundColor Yellow }
  $tunnelLogDir = Join-Path $stateDir 'logs'
  if (-not (Test-Path $tunnelLogDir)) { try { New-Item -ItemType Directory -Path $tunnelLogDir | Out-Null } catch {} }
  $tunnelLogBase = 'cloudflared-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  $tunnelLogOut = Join-Path $tunnelLogDir ($tunnelLogBase + '.out.log')
  $tunnelLogErr = Join-Path $tunnelLogDir ($tunnelLogBase + '.err.log')
  $cfArgs = @('tunnel','--url',"http://127.0.0.1:$($env:PORT)")
  try {
    $cloudflaredProc = Start-Process -FilePath 'cloudflared' -ArgumentList $cfArgs -RedirectStandardOutput $tunnelLogOut -RedirectStandardError $tunnelLogErr -PassThru -WindowStyle Hidden
  } catch {
    Write-Host "Failed to start cloudflared: $($_.Exception.Message)" -ForegroundColor Red
  }
  if ($cloudflaredProc) { if (-not $Quiet) { Write-Host "cloudflared PID: $($cloudflaredProc.Id) (logs in $tunnelLogDir)" -ForegroundColor DarkGray } }
  $regex = [regex]'https://[a-z0-9-]+\.trycloudflare\.com'
  $tunnelUrl = $null
  $sw = [System.Diagnostics.Stopwatch]::StartNew(); $timeoutSec = 45
  while ($cloudflaredProc -and $sw.Elapsed.TotalSeconds -lt $timeoutSec -and -not $tunnelUrl) {
    foreach ($p in @($tunnelLogErr,$tunnelLogOut)) {
      if (-not (Test-Path $p)) { continue }
      $content = Get-Content $p -Raw -ErrorAction SilentlyContinue
      if ($content) {
        $m = $regex.Matches($content) | Select-Object -Last 1
        if ($m -and $m.Value) { $tunnelUrl = $m.Value; break }
      }
    }
    if (-not $tunnelUrl) { Start-Sleep -Milliseconds 300 }
  }
  if ($tunnelUrl) {
    Write-Host "`n=== TUNNEL READY ===" -ForegroundColor Cyan
    Write-Host "Public Viewer URL: $tunnelUrl" -ForegroundColor Green
    Write-Host "Admin Control URL: $tunnelUrl/?admin=$($env:ADMIN_KEY)" -ForegroundColor Green
    try { Set-Content -Path (Join-Path $stateDir 'tunnel.latest.txt') -Value $tunnelUrl -NoNewline -ErrorAction SilentlyContinue } catch {}
  } else { Write-Host "(Background mode) Did not capture tunnel URL yet; tail logs in $tunnelLogDir" -ForegroundColor Yellow }
  Write-Host "Local Viewer URL:  http://localhost:$($env:PORT)/" -ForegroundColor DarkCyan
  Write-Host "Local Admin URL:   http://localhost:$($env:PORT)/?admin=$($env:ADMIN_KEY)" -ForegroundColor DarkCyan
  Write-Host "Press Ctrl+C to stop (server keeps running)." -ForegroundColor DarkGray
  if ($cloudflaredProc) { try { while (-not $cloudflaredProc.HasExited) { Start-Sleep -Seconds 2 } } catch {} }
  if ($serverProc -and -not $serverProc.HasExited) { Write-Host "Server still running: http://localhost:$($env:PORT)/ (PID $($serverProc.Id))" -ForegroundColor DarkGray }
  exit 0
}

if (-not $Quiet) { Write-Host "Launching Cloudflare quick tunnel (inline mode)..." -ForegroundColor Yellow }
Write-Host "Local Viewer URL:  http://localhost:$($env:PORT)/" -ForegroundColor DarkCyan
Write-Host "Local Admin URL:   http://localhost:$($env:PORT)/?admin=$($env:ADMIN_KEY)" -ForegroundColor DarkCyan

$regex = [regex]'https://[a-z0-9-]+\.trycloudflare\.com'
$tunnelPrinted = $false
try {
  & cloudflared tunnel --url "http://127.0.0.1:$($env:PORT)" 2>&1 | ForEach-Object {
    $line = $_ -replace '\x1B\[[0-9;]*[A-Za-z]', ''
    if (-not $tunnelPrinted) {
      $m = $regex.Match($line)
      if ($m.Success) {
        $url = $m.Value
        Write-Host "`n=== TUNNEL READY ===" -ForegroundColor Cyan
        Write-Host "Public Viewer URL: $url" -ForegroundColor Green
        Write-Host "Admin Control URL: $url/?admin=$($env:ADMIN_KEY)" -ForegroundColor Green
        try { Set-Content -Path (Join-Path $stateDir 'tunnel.latest.txt') -Value $url -NoNewline -ErrorAction SilentlyContinue } catch {}
        $tunnelPrinted = $true
      }
    }
    $_
  }
} finally {
  if (-not $tunnelPrinted) {
    # Last-chance scan of accumulated lines in case match arrived late
    try {
      $all = ($global:LAST_CLOUDFLARE_OUTPUT -join "`n")
    } catch {}
  }
}

