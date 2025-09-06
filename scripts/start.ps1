Param(
  [switch] $Quiet,
  [int] $PreferredPort = 3000
)

<#
start.ps1 – launches the watchparty server locally (no Cloudflare tunnel).

Switches:
  -Quiet              Reduce console noise.
  -PreferredPort N    Starting port to probe (default 3000).

Environment overrides (optional): PORT, ADMIN_KEY

Behavior:
  * Ensures ADMIN_KEY (persist + reuse state/admin.key)
  * Ensures at least one playable *.wp.mp4 / .webm (attempts bootstrap transcode if possible)
  * Starts server in background (records PID) unless already running
  * Prints friendly local URLs using new /watchparty & /watchparty-admin paths (?key=)
  * Ctrl+C exits this wrapper; server keeps running (terminate PID to stop)
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

if (-not $Quiet) { Write-Host "(Cloudflare tunnel disabled; local-only start)" -ForegroundColor DarkGray }

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
## Clear offline flag (was set by shutdown/takedown scripts) so local dev serves content
$offlineFlag = Join-Path $stateDir 'offline.flag'
if (Test-Path $offlineFlag) {
  try { Remove-Item $offlineFlag -ErrorAction SilentlyContinue } catch {}
  if (-not $Quiet) { Write-Host "Cleared offline.flag (local dev online)" -ForegroundColor Green }
}
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
$outputRoot = Join-Path $mediaRoot 'output'
if (-not (Test-Path $outputRoot)) { try { New-Item -ItemType Directory -Path $outputRoot | Out-Null } catch {} }
if (-not (Test-Path $mediaRoot)) { New-Item -ItemType Directory -Path $mediaRoot | Out-Null }

function Get-PlayableFiles {
  if (-not (Test-Path $outputRoot)) { return @() }
  Get-ChildItem -Path $outputRoot -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name.ToLower().EndsWith('.wp.mp4') -or $_.Name.ToLower().EndsWith('.webm') }
}
function Get-FirstSourceMedia {
  $mkv = Get-ChildItem -Path $mediaRoot -Recurse -File -Include *.mkv -ErrorAction SilentlyContinue | Where-Object { -not $_.FullName.StartsWith($outputRoot) } | Select-Object -First 1
  if ($mkv) { return $mkv }
  $rawMp4 = Get-ChildItem -Path $mediaRoot -Recurse -File -Include *.mp4 -ErrorAction SilentlyContinue | Where-Object { -not $_.Name.ToLower().EndsWith('.wp.mp4') -and -not $_.FullName.StartsWith($outputRoot) } | Select-Object -First 1
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
  $isMkv = $firstSrc.Name.ToLower().EndsWith('.mkv')
  $baseName = if ($isMkv) { [IO.Path]::GetFileNameWithoutExtension($firstSrc.Name) } elseif ($firstSrc.Name.ToLower().EndsWith('.mp4')) { ($firstSrc.Name -replace '\\.mp4$','') } else { [IO.Path]::GetFileNameWithoutExtension($firstSrc.Name) }
  $outPath = Join-Path $outputRoot ($baseName + '.wp.mp4')
    if (-not (Test-Path $outPath)) {
      Write-Host "Transcoding: $($firstSrc.Name) -> $(Split-Path -Leaf $outPath)" -ForegroundColor Cyan
  # Force 8-bit yuv420p output (hardware/browser friendly) regardless of 10-bit source
  $ffArgs = @('-y','-i', $firstSrc.FullName,'-c:v','libx264','-pix_fmt','yuv420p','-profile:v','high','-level:v','4.0','-preset','veryfast','-crf','22','-c:a','aac','-b:a','128k','-movflags','+faststart', $outPath)
      & ffmpeg @ffArgs
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path $outPath)) {
        Write-Host "Bootstrap transcode failed." -ForegroundColor Red
        exit 1
      }
      # Attempt subtitle extraction for MKV (first subtitle stream) -> WebVTT
      if ($isMkv) {
        $vttPath = Join-Path $outputRoot ($baseName + '.vtt')
        if (-not (Test-Path $vttPath)) {
          if (-not $Quiet) { Write-Host "Extracting first subtitle track -> $(Split-Path -Leaf $vttPath)" -ForegroundColor DarkCyan }
          try {
            & ffmpeg -y -i $firstSrc.FullName -map 0:s:0 -c:s webvtt $vttPath 2>$null
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $vttPath)) {
              if (-not $Quiet) { Write-Host "(No subtitle stream or extraction failed)" -ForegroundColor DarkYellow }
            }
          } catch { if (-not $Quiet) { Write-Host "(Subtitle extraction error: $($_.Exception.Message))" -ForegroundColor DarkYellow } }
        }
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

Write-Host "Local Viewer URL:  http://localhost:$($env:PORT)/watchparty?key=$($env:ADMIN_KEY)" -ForegroundColor Cyan
Write-Host "Local Admin URL:   http://localhost:$($env:PORT)/watchparty-admin?key=$($env:ADMIN_KEY)" -ForegroundColor Cyan

if ($serverProc) {
  Write-Host "Press Ctrl+C to exit wrapper (server keeps running)." -ForegroundColor DarkGray
  try { Wait-Process -Id $serverProc.Id } catch {}
} else {
  Write-Host "Existing server reused; this wrapper will idle (Ctrl+C to exit)." -ForegroundColor DarkGray
  while ($true) { Start-Sleep -Seconds 3600 }
}

