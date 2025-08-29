Param(
  [switch] $Force,
  [switch] $Verbose
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
  function Build-FfmpegArgs($src,$dst){
  # Probe audio streams
  $probeJson = & ffprobe -v error -print_format json -show_streams -select_streams a "$src" 2>$null
  $audioStreams = @()
  if ($probeJson) { try { $parsed = $probeJson | ConvertFrom-Json; $audioStreams = @($parsed.streams) } catch {} }

  # Pick default (prefer eng/en)
  $defaultIndex = 0
  for($i=0;$i -lt $audioStreams.Count;$i++){
    $lang = $null; try { $lang = $audioStreams[$i].tags.language } catch {}
    if ($lang -and ($lang -match '^(eng|en)$')) { $defaultIndex = $i; break }
  }

  # Base video transcode (always normalize to H.264 yuv420p for compatibility)
  $args = @(
    '-y','-i', $src,
    '-map','0:v:0',
    '-c:v','libx264','-pix_fmt','yuv420p','-profile:v','high','-level:v','4.0',
    '-preset','slow','-crf','20'
  )

  # Map each audio explicitly; decide copy vs transcode
  for($i=0;$i -lt $audioStreams.Count;$i++){
    $args += @('-map',"0:a:$i")
    $codec = $null
    try { $codec = $audioStreams[$i].codec_name } catch {}
    if ($codec -eq 'aac') {
      $args += @("-c:a:$i",'copy')
    } else {
      # Transcode (e.g. opus/flac) to AAC stereo 48k
      $args += @("-c:a:$i",'aac', "-b:a:$i",'160k', "-ac:a:$i",'2', "-ar:a:$i",'48000')
    }
  }

  # Metadata + default disposition
  for($i=0;$i -lt $audioStreams.Count;$i++){
    $lang = $null; $title = $null
    try { $lang = $audioStreams[$i].tags.language } catch {}
    try { $title = $audioStreams[$i].tags.title } catch {}
    if (-not $lang) { $lang = 'und' } else { $lang = $lang.ToLower() }
    $args += @("-metadata:s:a:$i","language=$lang")
    if ($title) {
      $san = ($title -replace '[:\r\n]',' ').Trim()
      if ($san) { $args += @("-metadata:s:a:$i","title=$san") }
    }
    if ($i -eq $defaultIndex) {
      $args += @("-disposition:a:$i",'default')
    }
  }

  $args += @('-movflags','+faststart', $dst)
  return ,$args
}
  function Invoke-Transcode($src,$dst){
    Write-Host "Start: $(Split-Path -Leaf $src)" -ForegroundColor Green
    $ffArgs = Build-FfmpegArgs $src $dst
    if ($Verbose) { Write-Host "ffmpeg $($ffArgs -join ' ')" -ForegroundColor DarkGray }
    & ffmpeg @ffArgs
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $dst)) {
      Write-Host "Done: $(Split-Path -Leaf $src) -> $(Split-Path -Leaf $dst)" -ForegroundColor Cyan
    } else {
      Write-Host "Failed: $(Split-Path -Leaf $src)" -ForegroundColor Red
    }
  }
  foreach ($q in $queue) { Invoke-Transcode $q.Source $q.Dest }
  Write-Host "Video transcode pass complete." -ForegroundColor DarkGreen
}

# ------------------------------------------------------------
# Subtitle extraction pass (delegates to transcode-subtitles.ps1)
# Skips existing outputs; honors -Force by forwarding.
# ------------------------------------------------------------
$subScript = Join-Path $PSScriptRoot 'transcode-subtitles.ps1'
if (Test-Path -LiteralPath $subScript) {
  Write-Host "Running subtitle extraction..." -ForegroundColor Cyan
  $subArgs = @()
  $subArgs += '-Source'; $subArgs += $inputRoot
  if ($Force) { $subArgs += '-Force' }
  if (-not $Verbose) { $subArgs += '-Quiet' }
  # Prefer pwsh if available, else fallback to current powershell
  $pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
  if ($pwshCmd) {
  & pwsh -NoLogo -NoProfile $subScript @subArgs
  } else {
  & powershell -NoLogo -NoProfile -File $subScript @subArgs
  }
  if ($LASTEXITCODE -ne 0) { Write-Host "Subtitle extraction finished with code $LASTEXITCODE" -ForegroundColor Yellow } else { Write-Host "Subtitle extraction complete." -ForegroundColor DarkGreen }
} else {
  Write-Host "Subtitle script not found: $subScript (skipping)" -ForegroundColor DarkYellow
}

Write-Host "All processing complete." -ForegroundColor Green
