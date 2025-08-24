Param(
  [switch] $Quiet,
  [int] $PreferredPort = 3000
)

function Get-FreePort {
  param([int]$Start,[int]$End)
  for($p=$Start; $p -le $End; $p++){
    $busy = Test-NetConnection -ComputerName 'localhost' -Port $p -InformationLevel Quiet
    if(-not $busy){ return $p }
  }
  return $Start
}

# Ensure ADMIN_KEY present (re-usable for future milestones)
if (-not $env:ADMIN_KEY -or [string]::IsNullOrWhiteSpace($env:ADMIN_KEY)) {
  $env:ADMIN_KEY = [guid]::NewGuid().ToString('N')
  if (-not $Quiet) { Write-Host "Generated ADMIN_KEY: $($env:ADMIN_KEY)" -ForegroundColor Cyan }
} else {
  if (-not $Quiet) { Write-Host "Using existing ADMIN_KEY (hidden)" -ForegroundColor Cyan }
}

# Persist key to repo-local state/admin.key for convenience (local dev only)
$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName  # scripts/ -> repo root
$stateDir = Join-Path $repoRoot 'state'
if (-not (Test-Path $stateDir)) { try { New-Item -ItemType Directory -Path $stateDir | Out-Null } catch {} }
$adminKeyFile = Join-Path $stateDir 'admin.key'
try { Set-Content -Path $adminKeyFile -Value $env:ADMIN_KEY -NoNewline } catch { if (-not $Quiet) { Write-Host "(Failed to save admin.key: $($_.Exception.Message))" -ForegroundColor DarkRed } }
if ((Test-Path $adminKeyFile) -and -not $Quiet) { Write-Host "(Saved ADMIN_KEY to $adminKeyFile)" -ForegroundColor DarkGray }

# Port detection (avoid EADDRINUSE)
if (-not $env:PORT -or [string]::IsNullOrWhiteSpace($env:PORT)) {
  $free = Get-FreePort -Start $PreferredPort -End ($PreferredPort + 10)
  if ($free -ne $PreferredPort -and -not $Quiet) {
    Write-Host "Port $PreferredPort busy; using free port $free" -ForegroundColor Yellow
  }
  $env:PORT = $free
} else {
  if (-not $Quiet) { Write-Host "Using preset PORT=$($env:PORT)" -ForegroundColor DarkCyan }
}

if (-not $Quiet) { Write-Host "Starting watchparty server on port $($env:PORT)..." -ForegroundColor Green }

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

npm run start
