Param(
  [string] $SourceRoot = (Join-Path ((Get-Item $PSScriptRoot).Parent.FullName) 'media/anime'),
  [string] $OutDir = (Join-Path ((Get-Item $PSScriptRoot).Parent.FullName) 'media/output/components'),
  [switch] $Force,
  [switch] $Verbose,
  [switch] $DryRun,
  [string[]] $Include,   # optional glob/regex fragments to filter episode keys
  [switch] $SkipSubs,    # skip subtitle extraction
  [switch] $SkipAudio,   # skip audio extraction
  [switch] $SkipVideo,   # skip video selection
  [switch] $TranscodeVideoToH264 # if set, transcode chosen video (else copy original stream)
)

<#
extract-components.ps1

Goal: From multiple variant MKVs of the SAME episode (e.g. different language bundles), pull out:
  * Best video stream (once) -> <ep>.video.mkv (or .mp4 if transcoded)
  * All unique audio tracks -> <ep>.<lang>[.<n>].m4a
  * All subtitle tracks -> <ep>.<lang>[.<slug>].vtt

Assumptions:
  - Source files share identical basename (before extension) across variants OR user passes -Include filters.
  - Legacy folders ignored (any path segment named 'legacy').
  - Lang detection from ffprobe stream tags.language; fallback 'und'.
  - For duplicate audio language, keep highest bitrate (BPS or bit_rate) OR first if metrics missing.
  - Subtitles converted to WebVTT; duplicate language disambiguated by title slug or numeric suffix.

Outputs placed under $OutDir/<episodeKey>/ to avoid clutter.
Creates an index JSON summarizing what was extracted: index.json

Usage examples:
  pwsh ./scripts/extract-components.ps1
  pwsh ./scripts/extract-components.ps1 -Include "Frieren Beyond" -Verbose
  pwsh ./scripts/extract-components.ps1 -TranscodeVideoToH264 -Force

#>

function Write-Info($m){ if($Verbose){ Write-Host $m -ForegroundColor Cyan } }
function Write-Warn($m){ Write-Host $m -ForegroundColor Yellow }
function Write-Err($m){ Write-Host $m -ForegroundColor Red }

if (-not (Test-Path $SourceRoot)) { Write-Err "Source root not found: $SourceRoot"; exit 1 }
if (-not (Test-Path $OutDir)) { try { New-Item -ItemType Directory -Path $OutDir | Out-Null } catch {} }
if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) { Write-Err 'ffprobe not in PATH'; exit 1 }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Write-Err 'ffmpeg not in PATH'; exit 1 }

# Gather candidate mkv/mp4 files (prefer mkv).
$all = Get-ChildItem -Path $SourceRoot -Recurse -File -Include *.mkv,*.mp4
if (-not $all) { Write-Warn 'No source media found.'; exit 0 }

# Group by base filename (without extension)
$groups = @{}
foreach ($f in $all) {
  $bn = [IO.Path]::GetFileNameWithoutExtension($f.Name)
  if ($Include -and ($Include | Where-Object { $bn -notmatch $_ }) -and -not ($Include | Where-Object { $bn -match $_ })) { continue }
  if (-not $groups.ContainsKey($bn)) { $groups[$bn] = @() }
  $groups[$bn] += $f.FullName
}

if ($groups.Count -eq 0) { Write-Warn 'No matching episode groups.'; exit 0 }
Write-Info "Episode groups: $($groups.Keys.Count)"

$index = @()

function Probe($file){
  $json = & ffprobe -v error -print_format json -show_streams -show_format -- "$file" 2>$null
  if (-not $json) { return $null }
  try { return $json | ConvertFrom-Json } catch { return $null }
}

foreach ($ep in $groups.Keys | Sort-Object) {
  $files = $groups[$ep]
  Write-Host "\n==> Episode: $ep (variants=$($files.Count))" -ForegroundColor Green
  $epDir = Join-Path $OutDir $ep
  if (-not (Test-Path $epDir)) { New-Item -ItemType Directory -Path $epDir | Out-Null }
  $probes = @()
  foreach ($f in $files) {
    $p = Probe $f
    if (-not $p) { Write-Warn "  Probe failed: $f"; continue }
    $probes += [pscustomobject]@{ file=$f; data=$p }
  }
  if (-not $probes) { Write-Warn '  No probe data; skipping'; continue }

  # 1. Choose best video (largest resolution then higher bitrate or larger file size)
  $bestVideo = $null
  if (-not $SkipVideo) {
    $candidates = @()
    foreach ($pr in $probes) {
      $v = $pr.data.streams | Where-Object { $_.codec_type -eq 'video' } | Select-Object -First 1
      if ($v) {
        $w=[int]($v.width); $h=[int]($v.height); $bps = 0
        if ($v.bit_rate) { $bps = [int64]$v.bit_rate } elseif ($pr.data.format.bit_rate){ $bps = [int64]$pr.data.format.bit_rate }
        $candidates += [pscustomobject]@{ file=$pr.file; width=$w; height=$h; pixels=($w*$h); bitrate=$bps; size=(Get-Item $pr.file).Length }
      }
    }
    $bestVideo = $candidates | Sort-Object -Property pixels,bitrate,size -Descending | Select-Object -First 1
    if ($bestVideo) {
      $videoOutExt = if ($TranscodeVideoToH264) { '.video.mp4' } else { '.video.mkv' }
      $videoOut = Join-Path $epDir ($ep + $videoOutExt)
      if (-not $Force -and (Test-Path $videoOut)) {
        Write-Info "  Video exists: $(Split-Path -Leaf $videoOut)"
      } else {
        if ($DryRun) { Write-Host "  DRYRUN extract video from $($bestVideo.file) -> $videoOut" -ForegroundColor Cyan }
        else {
          Write-Host "  Extract video: $(Split-Path -Leaf $bestVideo.file)" -ForegroundColor Cyan
          if ($TranscodeVideoToH264) {
            & ffmpeg -y -i "$($bestVideo.file)" -map 0:v:0 -c:v libx264 -pix_fmt yuv420p -preset slow -crf 20 -movflags +faststart "$videoOut" 2>&1 | ForEach-Object { if($Verbose){ "    $_" } }
          } else {
            & ffmpeg -y -i "$($bestVideo.file)" -map 0:v:0 -c copy "$videoOut" 2>&1 | ForEach-Object { if($Verbose){ "    $_" } }
          }
        }
      }
    } else { Write-Warn '  No video stream found.' }
  }

  # 2. Collect audio tracks
  $audioExtracted = @()
  if (-not $SkipAudio) {
    # Build list of all audio streams with language + bitrate
    $audioStreams = @()
    foreach ($pr in $probes) {
      $vStreams = $pr.data.streams | Where-Object { $_.codec_type -eq 'audio' }
      $idx=0
      foreach ($a in $vStreams) {
        $lang = $null; try { $lang = $a.tags.language } catch {} ; if (-not $lang) { $lang='und' } else { $lang=$lang.ToLower() }
        $title = $null; try { $title = $a.tags.title } catch {}
        $bps = 0; if ($a.bit_rate) { $bps=[int64]$a.bit_rate }
        $audioStreams += [pscustomobject]@{ file=$pr.file; streamIndex=$idx; lang=$lang; title=$title; bitrate=$bps; codec=$a.codec_name }
        $idx++
      }
    }
    # For each language, pick highest bitrate (or first)
    $byLang = $audioStreams | Group-Object -Property lang
    foreach ($g in $byLang) {
      $chosen = $g.Group | Sort-Object -Property bitrate -Descending | Select-Object -First 1
      $baseName = "$ep.$($g.Name)"
      $outFile = Join-Path $epDir ($baseName + '.m4a')
      if (-not $Force -and (Test-Path $outFile)) { Write-Info "  Audio exists: $(Split-Path -Leaf $outFile)"; $audioExtracted += (Split-Path -Leaf $outFile); continue }
      if ($DryRun) { Write-Host "  DRYRUN extract audio $($g.Name) from $(Split-Path -Leaf $chosen.file) -> $(Split-Path -Leaf $outFile)" -ForegroundColor Cyan; $audioExtracted += (Split-Path -Leaf $outFile); continue }
      Write-Host "  Extract audio [$($g.Name)] from $(Split-Path -Leaf $chosen.file)" -ForegroundColor Magenta
      if ($chosen.codec -eq 'aac') {
        & ffmpeg -y -i "$($chosen.file)" -map 0:a:$($chosen.streamIndex) -c copy "$outFile" 2>$null
      } else {
        & ffmpeg -y -i "$($chosen.file)" -map 0:a:$($chosen.streamIndex) -c:a aac -b:a 160k "$outFile" 2>$null
      }
      if (Test-Path $outFile) { $audioExtracted += (Split-Path -Leaf $outFile) } else { Write-Warn "    FAIL audio $($g.Name)" }
    }
  }

  # 3. Collect subtitle tracks
  $subsExtracted = @()
  if (-not $SkipSubs) {
    $subStreams = @()
    foreach ($pr in $probes) {
      $sStreams = $pr.data.streams | Where-Object { $_.codec_type -eq 'subtitle' }
      $sIdx=0
      foreach ($s in $sStreams) {
        $lang=$null; try { $lang=$s.tags.language } catch {}; if (-not $lang) { $lang='und' } else { $lang=$lang.ToLower() }
        $title=$null; try { $title=$s.tags.title } catch {}
        $subStreams += [pscustomobject]@{ file=$pr.file; streamIndex=$sIdx; lang=$lang; title=$title }
        $sIdx++
      }
    }
    # Allow multiple per language; build slug
    $counts=@{}
    foreach ($s in $subStreams) {
      $slugBase = $s.lang
      $slugExtra = ''
      if ($s.title) { $slugExtra = ($s.title -replace '[^A-Za-z0-9]+','-').Trim('-').ToLower() }
      if (-not $slugExtra) {
        if (-not $counts.ContainsKey($s.lang)) { $counts[$s.lang]=0 }
        else { $counts[$s.lang]++ }
        if ($counts[$s.lang] -gt 0) { $slugExtra = 'alt' + $counts[$s.lang] }
      }
      $fileCore = if ($slugExtra) { "$ep.$slugBase.$slugExtra" } else { "$ep.$slugBase" }
      $outFile = Join-Path $epDir ($fileCore + '.vtt')
      if (-not $Force -and (Test-Path $outFile)) { Write-Info "  Subtitle exists: $(Split-Path -Leaf $outFile)"; $subsExtracted += (Split-Path -Leaf $outFile); continue }
      if ($DryRun) { Write-Host "  DRYRUN extract subtitle $fileCore" -ForegroundColor Cyan; $subsExtracted += (Split-Path -Leaf $outFile); continue }
      Write-Host "  Extract subtitle [$($s.lang)] from $(Split-Path -Leaf $s.file)" -ForegroundColor DarkCyan
      # Convert to webvtt via ffmpeg
      & ffmpeg -y -i "$($s.file)" -map 0:s:$($s.streamIndex) -c:s webvtt "$outFile" 2>$null
      if (Test-Path $outFile) { $subsExtracted += (Split-Path -Leaf $outFile) } else { Write-Warn "    FAIL subtitle $fileCore" }
    }
  }

  $index += [pscustomobject]@{
    episode = $ep
    video   = if ($bestVideo) { (Get-ChildItem -Path $epDir -Filter "$ep.video.*" | Select-Object -First 1 | ForEach-Object Name) } else { $null }
    audio   = $audioExtracted
    subs    = $subsExtracted
  }
}

# Write index
$indexPath = Join-Path $OutDir 'index.json'
$index | ConvertTo-Json -Depth 6 | Out-File -Encoding UTF8 $indexPath
Write-Host "\nExtraction complete. Index: $indexPath" -ForegroundColor Green
