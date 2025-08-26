Param(
  [switch] $Force,
  [switch] $Verbose,
  [int] $MaxParallel = 2,
  [switch] $Stream  # stream ffmpeg output live (forces sequential)
)

# ------------------------------------------------------------
# FAST TRANSCODE PIPELINE (videos + subtitles)
#  - Input:   media/anime (recursive)
#  - Output:  media/output
#  - Skips any source with existing .wp.mp4 unless -Force
#  - After video pass, invokes transcode-subtitles.ps1 (skip existing)
#  - Removed upfront integrity probe to eliminate long startup delay
# ------------------------------------------------------------

$repoRoot   = (Get-Item $PSScriptRoot).Parent.FullName
$mediaRoot  = Join-Path $repoRoot 'media'
$inputRoot  = Join-Path $mediaRoot 'anime'
$outputRoot = Join-Path $mediaRoot 'output'
if (-not (Test-Path $mediaRoot)) { Write-Host "Media directory not found: $mediaRoot" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $inputRoot)) { Write-Host "Input directory not found (expected media/anime). Creating..." -ForegroundColor Yellow; try { New-Item -ItemType Directory -Path $inputRoot | Out-Null } catch {} }
if (-not (Test-Path $outputRoot)) { try { New-Item -ItemType Directory -Path $outputRoot | Out-Null } catch {} }

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host "ffmpeg not found in PATH." -ForegroundColor Red
  exit 1
}

# Collect candidate source files (limit to inputRoot). Use -File & -Include patterns for speed.
$targets = Get-ChildItem -Path $inputRoot -Recurse -File -Include *.mkv,*.mp4 -ErrorAction SilentlyContinue |
  Where-Object { $n = $_.Name.ToLower(); -not $n.EndsWith('.wp.mp4') }
if (-not $targets -or $targets.Count -eq 0) { Write-Host "No source .mkv/.mp4 files under $inputRoot" -ForegroundColor Yellow; exit 0 }

$queue = @()
foreach ($f in $targets) {
  $isMkv = $f.Name.ToLower().EndsWith('.mkv')
  $isMp4 = $f.Name.ToLower().EndsWith('.mp4')
  if (-not ($isMkv -or $isMp4)) { continue }
  $baseName = if ($isMkv) { [IO.Path]::GetFileNameWithoutExtension($f.Name) } else { ($f.Name -replace '\\.mp4$','') }
  $dest = Join-Path $outputRoot ($baseName + '.wp.mp4')
  if (-not $Force -and (Test-Path -LiteralPath $dest)) {
    if ($Verbose) { Write-Host "Skip existing video: $($f.Name)" -ForegroundColor DarkGray }
    continue
  }
  $queue += [pscustomobject]@{ Source=$f.FullName; Dest=$dest; IsMkv=$isMkv }
}

if ($queue.Count -eq 0) {
  Write-Host "Nothing to transcode (all outputs present)." -ForegroundColor Yellow
} else {
  Write-Host "Queued videos: $($queue.Count)" -ForegroundColor Cyan
  function Invoke-Transcode($src,$dst){
    Write-Host "Start: $(Split-Path -Leaf $src)" -ForegroundColor Green
    $ffArgs = @('-y','-i', $src,'-c:v','libx264','-pix_fmt','yuv420p','-profile:v','high','-level:v','4.0','-preset','slow','-crf','20','-c:a','aac','-b:a','160k','-movflags','+faststart', $dst)
    if ($Verbose) { Write-Host "ffmpeg $($ffArgs -join ' ')" -ForegroundColor DarkGray }
    & ffmpeg @ffArgs
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $dst)) {
      Write-Host "Done: $(Split-Path -Leaf $src) -> $(Split-Path -Leaf $dst)" -ForegroundColor Cyan
    } else {
      Write-Host "Failed: $(Split-Path -Leaf $src)" -ForegroundColor Red
    }
  }
  if ($Stream -or $MaxParallel -le 1 -or $queue.Count -le 1) {
    if ($Stream -and $MaxParallel -gt 1) { Write-Host "[warn] -Stream forces sequential; ignoring -MaxParallel $MaxParallel" -ForegroundColor Yellow }
    foreach ($q in $queue) { Invoke-Transcode $q.Source $q.Dest }
  } else {
    $active = @()
    foreach ($q in $queue) {
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
      Write-Host "Start: $(Split-Path -Leaf $q.Source)" -ForegroundColor Green
      $j = Start-Job -ScriptBlock {
        param($src,$dst,$v)
        $ffArgs = @('-y','-i', $src,'-c:v','libx264','-pix_fmt','yuv420p','-profile:v','high','-level:v','4.0','-preset','slow','-crf','20','-c:a','aac','-b:a','160k','-movflags','+faststart', $dst)
        if ($v) { "[cmd] ffmpeg $($ffArgs -join ' ')" }
        & ffmpeg @ffArgs 2>&1 | ForEach-Object { "[ffmpeg] $_" }
        if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $dst)) { "Done: $(Split-Path -Leaf $src) -> $(Split-Path -Leaf $dst)" } else { "Failed: $(Split-Path -Leaf $src)" }
      } -ArgumentList $q.Source,$q.Dest,$Verbose
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
  }
  Write-Host "Video transcode pass complete." -ForegroundColor DarkGreen
}

# ------------------------------------------------------------
# Subtitle extraction pass (delegates to transcode-subtitles.ps1)
# Skips existing outputs; honors -Force by forwarding.
# ------------------------------------------------------------
$subScript = Join-Path $PSScriptRoot 'transcode-subtitles.ps1'
if (Test-Path -LiteralPath $subScript) {
  Write-Host "Running subtitle extraction..." -ForegroundColor Cyan
  $args = @()
  $args += '-Source'; $args += $inputRoot
  if ($Force) { $args += '-Force' }
  if (-not $Verbose) { $args += '-Quiet' }
  # Prefer pwsh if available, else fallback to current powershell
  $pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
  if ($pwshCmd) {
    & pwsh -NoLogo -NoProfile $subScript @args
  } else {
    & powershell -NoLogo -NoProfile -File $subScript @args
  }
  if ($LASTEXITCODE -ne 0) { Write-Host "Subtitle extraction finished with code $LASTEXITCODE" -ForegroundColor Yellow } else { Write-Host "Subtitle extraction complete." -ForegroundColor DarkGreen }
} else {
  Write-Host "Subtitle script not found: $subScript (skipping)" -ForegroundColor DarkYellow
}

Write-Host "All processing complete." -ForegroundColor Green
