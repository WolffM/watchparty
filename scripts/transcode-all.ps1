Param(
  [switch] $Force,
  [switch] $Verbose,
  [int] $MaxParallel = 2,
  [switch] $Stream  # stream ffmpeg output live (forces sequential)
)

$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$mediaRoot = Join-Path $repoRoot 'media'
$outputRoot = Join-Path $mediaRoot 'output'
if (-not (Test-Path $outputRoot)) { try { New-Item -ItemType Directory -Path $outputRoot | Out-Null } catch {} }
if (-not (Test-Path $mediaRoot)) { Write-Host "Media directory not found: $mediaRoot" -ForegroundColor Red; exit 1 }

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host "ffmpeg not found in PATH." -ForegroundColor Red
  exit 1
}

# Collect candidate source files: mkv and raw mp4 (exclude already transcoded *.wp.mp4 explicitly and anything in output folder)
$targets = Get-ChildItem -Path $mediaRoot -Recurse -File -Include *.mkv,*.mp4 -ErrorAction SilentlyContinue |
  Where-Object { $name = $_.Name.ToLower(); -not $name.EndsWith('.wp.mp4') -and -not $_.FullName.StartsWith($outputRoot) }
if (-not $targets) { Write-Host "No transcodable source files (mkv/raw mp4) found." -ForegroundColor Yellow; exit 0 }

# Simple job queue
$queue = @()
foreach ($f in $targets) {
  # Extra safety: never treat an existing *.wp.mp4 as a source (even if force flags change later)
  if ($f.Name.ToLower().EndsWith('.wp.mp4')) { continue }
  if ($f.Name.ToLower().EndsWith('.mkv')) {
    $baseName = [IO.Path]::GetFileNameWithoutExtension($f.Name)
    $mp4 = Join-Path $outputRoot ($baseName + '.wp.mp4')
  } elseif ($f.Name.ToLower().EndsWith('.mp4')) {
    # Raw mp4 (not already suffixed) -> add suffix once, place in outputRoot
    $baseName = $f.Name -replace '\.mp4$',''
    $mp4 = Join-Path $outputRoot ($baseName + '.wp.mp4')
  } else { continue }
  if (-not $Force -and (Test-Path $mp4)) {
    if ($Verbose) { Write-Host "Skip existing: $($f.Name)" -ForegroundColor DarkGray }
    continue
  }
  # Quick integrity probe: attempt to read container metadata (fast)
  & ffmpeg -v error -i $f.FullName -f null - 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Corrupt or unreadable: $($f.Name)" -ForegroundColor Red
    continue
  }
  $queue += [pscustomobject]@{ Source=$f.FullName; Dest=$mp4 }
}

if ($queue.Count -eq 0) { Write-Host "Nothing to transcode." -ForegroundColor Yellow; exit 0 }
Write-Host "Queued: $($queue.Count) file(s) for transcode." -ForegroundColor Cyan

if ($Stream -or $MaxParallel -le 1 -or $queue.Count -le 1) {
  if ($Stream -and $MaxParallel -gt 1) { Write-Host "[warn] -Stream forces sequential; ignoring -MaxParallel $MaxParallel" -ForegroundColor Yellow }
  foreach ($item in $queue) {
    Write-Host "Start: $(Split-Path -Leaf $item.Source)" -ForegroundColor Green
  $ffArgs = @('-y','-i', $item.Source,'-c:v','libx264','-pix_fmt','yuv420p','-profile:v','high','-level:v','4.0','-preset','slow','-crf','20','-c:a','aac','-b:a','160k','-movflags','+faststart', $item.Dest)
    Write-Host "ffmpeg $($ffArgs -join ' ')" -ForegroundColor DarkGray
    & ffmpeg @ffArgs
    if ($LASTEXITCODE -eq 0) { Write-Host "Done: $(Split-Path -Leaf $item.Source) -> $(Split-Path -Leaf $item.Dest)" -ForegroundColor Cyan }
    else { Write-Host "Failed: $(Split-Path -Leaf $item.Source)" -ForegroundColor Red }
  }
  Write-Host "All transcodes complete." -ForegroundColor DarkGreen
  exit 0
}

# Parallel mode
$active = @()
foreach ($item in $queue) {
  while ($active.Count -ge $MaxParallel) {
    $finished = Wait-Job -Job $active -Any -Timeout 5
    if ($finished) {
      foreach ($fj in $finished) {
        Receive-Job $fj | Write-Host
        Remove-Job $fj
        $active = $active | Where-Object { $_.Id -ne $fj.Id }
      }
    }
  }
  Write-Host "Start: $(Split-Path -Leaf $item.Source)" -ForegroundColor Green
  $j = Start-Job -ScriptBlock {
    param($src,$dst)
  $ffArgs = @('-y','-i', $src,'-c:v','libx264','-pix_fmt','yuv420p','-profile:v','high','-level:v','4.0','-preset','slow','-crf','20','-c:a','aac','-b:a','160k','-movflags','+faststart', $dst)
    "[cmd] ffmpeg $($ffArgs -join ' ')"
    & ffmpeg @ffArgs 2>&1 | ForEach-Object { "[ffmpeg] $_" }
    if ($LASTEXITCODE -eq 0) { "Done: $(Split-Path -Leaf $src) -> $(Split-Path -Leaf $dst)" } else { "Failed: $(Split-Path -Leaf $src)" }
  } -ArgumentList $item.Source,$item.Dest
  $active += $j
}
while ($active.Count -gt 0) {
  $finished = Wait-Job -Job $active -Any -Timeout 5
  if ($finished) {
    foreach ($fj in $finished) {
      Receive-Job $fj | Write-Host
      Remove-Job $fj
      $active = $active | Where-Object { $_.Id -ne $fj.Id }
    }
  }
}
Write-Host "All transcodes complete." -ForegroundColor DarkGreen
