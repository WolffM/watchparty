Param(
  [string] $Source,              # File or directory to scan (if omitted scan media/anime recursively)
  [string] $SourceRoot,          # Backward compatibility alias for extract-audio.ps1
  [string] $InputRoot,           # Explicit root directory for raw sources (overrides default scan roots)
  [string] $OutputRoot,          # Override output root (default media/output)
  [switch] $Force,
  [switch] $Verbose,
  [switch] $Quiet,
  [switch] $DryRun,
  [string[]] $LanguagesAudio,
  [string[]] $LanguagesSubs,
  [ValidateSet('vtt','srt')] [string] $SubtitleFormat = 'vtt',
  [switch] $SkipVideo,
  [switch] $SkipAudio,
  [switch] $SkipSubs,
  [switch] $Single,               # Treat -Source as a single file only when file provided
  [switch] $ListTargets           # Only list resolved source targets then exit (debug)
)

<#
transcribe-all.ps1
Unified pipeline: video transcode (.wp.mp4), sidecar audio extraction (.audio.<lang>.m4a), subtitle extraction (.lang[.slug].vtt|srt).
Replaces legacy scripts: transcode-all.ps1, extract-audio.ps1, transcode-subtitles.ps1
Use transcribe-audio.ps1 / transcribe-subtitles.ps1 wrappers for redo operations.

Exit codes:
  0 success (all requested operations ok)
  1 generic failure (ffmpeg missing / no sources / fatal)
  2 audio extraction partial failures (still may have produced some files)
  4 subtitle extraction partial failures
  8 video transcode partial failures
(Values OR'd if multiple classes failed, e.g. 6 => subtitle+video issues)
#>

function Write-Info($m){ if(-not $Quiet){ Write-Host $m -ForegroundColor Cyan } }
function Write-Warn($m){ if(-not $Quiet){ Write-Host $m -ForegroundColor Yellow } }
function Write-Err($m){ Write-Host $m -ForegroundColor Red }

$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$mediaRoot  = Join-Path $repoRoot 'media'
# Unified raw search roots (ordered). We always traverse all; no silent fallback to outputs.
$scanRoots = @()
if($InputRoot){
  $resolvedInput = (Resolve-Path -LiteralPath $InputRoot -ErrorAction SilentlyContinue)
  if($resolvedInput){ $scanRoots += $resolvedInput.Path }
} else {
  $scanRoots += (Join-Path $mediaRoot 'anime')
  $scanRoots += (Join-Path $mediaRoot 'input' | Join-Path -ChildPath 'anime')
}
if (-not $OutputRoot){ $OutputRoot = Join-Path $mediaRoot 'output' }
if (-not (Test-Path $OutputRoot)) { try { New-Item -ItemType Directory -Path $OutputRoot | Out-Null } catch {} }
if (-not (Test-Path $mediaRoot)) { Write-Err "Media directory not found: $mediaRoot"; exit 1 }

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Write-Err 'ffmpeg not found in PATH'; exit 1 }
if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) { Write-Err 'ffprobe not found in PATH'; exit 1 }

if($SourceRoot -and -not $Source){ $Source = $SourceRoot }

# Build source file set (robust enumeration; avoid -Include pattern pitfalls)
$targets = @()
function Get-RawSources($root){
  if(-not (Test-Path -LiteralPath $root)){ return @() }
  $files = Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue
  if(-not $files){ return @() }
  return $files | Where-Object { $_.Extension -match '^\.(mkv|mp4)$' -and $_.Name -notmatch '\\.wp\\.mp4$' }
}
if ($Source) {
  if (-not (Test-Path -LiteralPath $Source)) { Write-Err "Source not found: $Source"; exit 1 }
  $it = Get-Item -LiteralPath $Source
  if ($it.PSIsContainer) { $targets = Get-RawSources $it.FullName } else { $targets = @($it) }
  if ($Single -and $targets.Count -gt 1) { $targets = @($targets[0]) }
} else {
  $agg = @()
  foreach($root in $scanRoots){ if(Test-Path -LiteralPath $root){ $agg += Get-RawSources $root } }
  # De-duplicate by full path
  if($agg){ $targets = $agg | Sort-Object -Property FullName -Unique }
}

# Remove legacy behavior of silently using existing .wp.mp4 outputs when raw sources absent.

if($ListTargets){
  if(-not $targets -or $targets.Count -eq 0){ Write-Host 'No targets found.'; exit 1 }
  Write-Host "Resolved targets ($($targets.Count)):" -ForegroundColor Cyan
  $targets | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkCyan }
  exit 0
}

if (-not $targets -or $targets.Count -eq 0) { Write-Warn 'No input media found.'; exit 1 }
if(-not $Quiet){ Write-Host "Transcribe targets: $($targets.Count)" -ForegroundColor DarkCyan }

# Normalized language filters
$wantAudio = $null; if($LanguagesAudio){ $wantAudio = $LanguagesAudio | ForEach-Object { $_.ToLower() } | Sort-Object -Unique }
$wantSubs  = $null; if($LanguagesSubs){ $wantSubs = $LanguagesSubs | ForEach-Object { $_.ToLower() } | Sort-Object -Unique }

$videoFails = 0; $audioFails = 0; $subFails = 0

function Invoke-TranscodeVideo {
  param(
    [Parameter(Mandatory)][string]$SrcFile,
    [Parameter(Mandatory)][string]$DestFile
  )
  # Build ffmpeg args (similar to legacy transcode-all, preserving ALL audio streams and default flags)
  $probeJson = & ffprobe -v error -print_format json -show_streams -select_streams a "$SrcFile" 2>$null
  $audioStreams = @(); if($probeJson){ try { $parsed = $probeJson | ConvertFrom-Json; $audioStreams = @($parsed.streams) } catch {} }
  $defaultIndex = 0
  for($i=0;$i -lt $audioStreams.Count;$i++){
    $lang=$null; try { $lang = $audioStreams[$i].tags.language } catch {}
    if($lang -and ($lang -match '^(eng|en)$')){ $defaultIndex = $i; break }
  }
  $ffArgs = @('-y','-i', $SrcFile,'-map','0:v:0','-c:v','libx264','-pix_fmt','yuv420p','-profile:v','high','-level:v','4.0','-preset','slow','-crf','20')
  for($i=0;$i -lt $audioStreams.Count;$i++){
  $ffArgs += @('-map',"0:a:$i")
    $codec=$null; try { $codec=$audioStreams[$i].codec_name } catch {}
  if($codec -eq 'aac'){ $ffArgs += @("-c:a:$i",'copy') }
  else { $ffArgs += @("-c:a:$i",'aac',"-b:a:$i",'160k',"-ac:a:$i",'2',"-ar:a:$i",'48000') }
  }
  for($i=0;$i -lt $audioStreams.Count;$i++){
    $lang=$null; $title=$null; try { $lang=$audioStreams[$i].tags.language } catch {}; try { $title=$audioStreams[$i].tags.title } catch {}
    if(-not $lang){ $lang='und' } else { $lang=$lang.ToLower() }
  $ffArgs += @("-metadata:s:a:$i","language=$lang")
  if($title){ $san = ($title -replace '[:\r\n]',' ').Trim(); if($san){ $ffArgs += @("-metadata:s:a:$i","title=$san") } }
  if($i -eq $defaultIndex){ $ffArgs += @("-disposition:a:$i",'default') }
  }
  $ffArgs += @('-movflags','+faststart', $DestFile)
  if($Verbose){ Write-Host ("ffmpeg " + ($ffArgs -join ' ')) -ForegroundColor DarkGray }
  if($DryRun){ Write-Info "DRYRUN transcode -> $(Split-Path -Leaf $DestFile)"; return $true }
  & ffmpeg @ffArgs
  if($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $DestFile)){ return $false }
  return $true
}

function Invoke-ExtractAudio {
  param(
    [Parameter(Mandatory)][string]$Src,
    [Parameter(Mandatory)][string]$BaseName
  )
  $probe = & ffprobe -v error -select_streams a -show_streams -print_format json "$Src" 2>$null
  if(-not $probe){ return }
  try { $p = $probe | ConvertFrom-Json } catch { return }
  $streams = @($p.streams)
  for($i=0;$i -lt $streams.Count;$i++){
    $lang=$null; try { $lang=$streams[$i].tags.language } catch {}; if(-not $lang){ $lang='und' } else { $lang=$lang.ToLower() }
    if($wantAudio -and (-not ($wantAudio -contains $lang))){ continue }
  $out = Join-Path $OutputRoot ("$BaseName.audio.$lang.m4a")
    if(-not $Force -and (Test-Path -LiteralPath $out)){ if($Verbose){ Write-Host "  Skip existing audio $lang" -ForegroundColor DarkGray }; continue }
    if($DryRun){ Write-Info "  DRYRUN audio $lang"; continue }
    $codec=$streams[$i].codec_name
    if($Verbose){ Write-Host "  Extract audio $lang (stream $i codec=$codec)" -ForegroundColor Magenta }
    if($codec -eq 'aac'){
      & ffmpeg -y -i "$Src" -map 0:a:$i -vn -sn -c:a copy "$out" 2>$null
    } else {
      & ffmpeg -y -i "$Src" -map 0:a:$i -vn -sn -c:a aac -b:a 160k -ac 2 -ar 48000 "$out" 2>$null
    }
    if($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $out)){ $script:audioFails++ ; Write-Warn "    FAIL audio $lang" }
  }
}

function Invoke-ExtractSubs {
  param(
    [Parameter(Mandatory)][string]$Src,
    [Parameter(Mandatory)][string]$BaseName,
    [Parameter(Mandatory)][string]$EpisodeDir
  )
  $probe = & ffprobe -v error -select_streams s -show_streams -print_format json "$Src" 2>$null
  if(-not $probe){ return }
  try { $p = $probe | ConvertFrom-Json } catch { return }
  $streams = @($p.streams)
  if(-not $streams){ return }
  $langCounts = @{}
  for($i=0;$i -lt $streams.Count;$i++){
    $lang=$null; try { $lang=$streams[$i].tags.language } catch {}; if(-not $lang){ $lang='und' } else { $lang=$lang.ToLower() }
    if($wantSubs -and (-not ($wantSubs -contains $lang))){ continue }
    if(-not $langCounts.ContainsKey($lang)){ $langCounts[$lang]=0 } else { $langCounts[$lang]++ }
    $title=$null; try { $title=$streams[$i].tags.title } catch {}
    $slugExtra=''
    if($title){ $slugExtra = ($title -replace '[^A-Za-z0-9]+','-').Trim('-').ToLower() }
    if(-not $slugExtra -and $langCounts[$lang] -gt 0){ $slugExtra = 'alt' + $langCounts[$lang] }
    $core = if($slugExtra){ "$BaseName.$lang.$slugExtra" } else { "$BaseName.$lang" }
    $ext = $SubtitleFormat
    $out = Join-Path $EpisodeDir ("$core.$ext")
    if(-not $Force -and (Test-Path -LiteralPath $out)){ if($Verbose){ Write-Host "  Skip existing sub $core" -ForegroundColor DarkGray }; continue }
    if($DryRun){ Write-Info "  DRYRUN sub $core"; continue }
    $codec = if($SubtitleFormat -eq 'vtt'){ 'webvtt' } else { 'srt' }
    if($Verbose){ Write-Host "  Extract subtitle $core (stream $i)" -ForegroundColor DarkCyan }
    & ffmpeg -y -i "$Src" -map 0:s:$i -c:s $codec "$out" 2>$null
    if($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $out)){ $script:subFails++ ; Write-Warn "    FAIL sub $core" }
  }
}

# Anchor roots for relative mapping (resolved once). Some may not exist.
$anchorInputAnime = Join-Path (Join-Path $mediaRoot 'input') 'anime'
$anchorAnime = Join-Path $mediaRoot 'anime'
$resolvedInputAnchor = $null; try { if(Test-Path -LiteralPath $anchorInputAnime){ $resolvedInputAnchor = (Resolve-Path -LiteralPath $anchorInputAnime).Path } } catch {}
$resolvedAnimeAnchor = $null; try { if(Test-Path -LiteralPath $anchorAnime){ $resolvedAnimeAnchor = (Resolve-Path -LiteralPath $anchorAnime).Path } } catch {}
foreach($f in $targets){
  $isMkv = $f.Name.ToLower().EndsWith('.mkv')
  $baseName = if($isMkv){ [IO.Path]::GetFileNameWithoutExtension($f.Name) } elseif ($f.Name.ToLower().EndsWith('.mp4')) { ($f.Name -replace '\\.mp4$','') } else { [IO.Path]::GetFileNameWithoutExtension($f.Name) }
  $episodeDir = $null
  $dirPath = $f.DirectoryName
  $lowerDir = $dirPath.ToLower()
  if($resolvedInputAnchor -and $lowerDir.StartsWith($resolvedInputAnchor.ToLower())){
    $rel = $dirPath.Substring($resolvedInputAnchor.Length)
    while($rel.StartsWith('\') -or $rel.StartsWith('/')){ $rel = $rel.Substring(1) }
    $episodeDir = Join-Path (Join-Path $OutputRoot 'anime') $rel
  } elseif($resolvedAnimeAnchor -and $lowerDir.StartsWith($resolvedAnimeAnchor.ToLower())){
    $rel = $dirPath.Substring($resolvedAnimeAnchor.Length)
    while($rel.StartsWith('\') -or $rel.StartsWith('/')){ $rel = $rel.Substring(1) }
    $episodeDir = Join-Path (Join-Path $OutputRoot 'anime') $rel
  } else {
    $episodeDir = Join-Path $OutputRoot 'anime'
  }
  if($Verbose){ Write-Host "  episodeDir=$episodeDir" -ForegroundColor DarkGray }
  if(-not (Test-Path -LiteralPath $episodeDir)){ try { New-Item -ItemType Directory -Path $episodeDir -Force | Out-Null } catch {} }
  $videoOut = Join-Path $episodeDir ($baseName + '.wp.mp4')
  Write-Info "\n==> $($f.Name)"
  # Episode-level skip: if output dir already has video + at least one audio + at least one subtitle and not forcing, skip
  if(-not $Force){
  $haveVideoEp = Test-Path -LiteralPath $videoOut
  $haveAudioEp = @(Get-ChildItem -Path (Join-Path $episodeDir ($baseName + '.audio.*.m4a')) -ErrorAction SilentlyContinue).Count -gt 0
  $haveSubsEp = (@(Get-ChildItem -Path (Join-Path $episodeDir ($baseName + '.*.vtt')) -ErrorAction SilentlyContinue).Count -gt 0) -or (@(Get-ChildItem -Path (Join-Path $episodeDir ($baseName + '.*.srt')) -ErrorAction SilentlyContinue).Count -gt 0)
    if($haveVideoEp -and ($SkipAudio -or $haveAudioEp) -and ($SkipSubs -or $haveSubsEp)){
      if($Verbose){ Write-Host '  Skip episode (all artifacts present in episode output dir)' -ForegroundColor DarkGray }
      continue
    }
  }
  # Skip entire item if all three artifact classes already exist and not forcing:
  #  1) video .wp.mp4
  #  2) at least one matching .audio.<lang>.m4a
  #  3) at least one subtitle (.vtt or .srt) with base prefix
  if(-not $Force){
  $haveVideo = Test-Path -LiteralPath $videoOut
  $audioPattern = Join-Path $episodeDir ("$baseName.audio.*.m4a")
  $subPatternVtt = Join-Path $episodeDir ("$baseName.*.vtt")
  $subPatternSrt = Join-Path $episodeDir ("$baseName.*.srt")
  $haveAudio = @(Get-ChildItem -Path $audioPattern -ErrorAction SilentlyContinue).Count -gt 0
  $haveSubs = (@(Get-ChildItem -Path $subPatternVtt -ErrorAction SilentlyContinue).Count -gt 0) -or (@(Get-ChildItem -Path $subPatternSrt -ErrorAction SilentlyContinue).Count -gt 0)
    if($haveVideo -and ($SkipAudio -or $haveAudio) -and ($SkipSubs -or $haveSubs)){
      if($Verbose){ Write-Host '  Skip (all artifacts present)' -ForegroundColor DarkGray }
      if(-not $SkipAudio -and -not $haveAudio -and $Verbose){ Write-Host '   (audio missing but SkipAudio=true so ignoring)' -ForegroundColor DarkGray }
      if(-not $SkipSubs -and -not $haveSubs -and $Verbose){ Write-Host '   (subs missing but SkipSubs=true so ignoring)' -ForegroundColor DarkGray }
      continue
    }
  }
  if(-not $SkipVideo){
    if(-not $Force -and (Test-Path -LiteralPath $videoOut)){
      if($Verbose){ Write-Host '  Skip transcode (exists)' -ForegroundColor DarkGray }
    } else {
  $ok = Invoke-TranscodeVideo -SrcFile $f.FullName -DestFile $videoOut
      if(-not $ok){ $videoFails++; Write-Warn '  Video transcode FAILED' }
      else { if($Verbose){ Write-Host '  Video transcode OK' -ForegroundColor Green } }
    }
  }
  # Source for extraction: prefer transcoded output if exists else original
  $extractSrc = if(Test-Path -LiteralPath $videoOut){ $videoOut } else { $f.FullName }
  if(-not $SkipAudio){ Invoke-ExtractAudio -Src $extractSrc -BaseName $baseName }
  if(-not $SkipSubs){ Invoke-ExtractSubs -Src $extractSrc -BaseName $baseName -EpisodeDir $episodeDir }
}

$exit = 0
if($videoFails -gt 0){ $exit = $exit -bor 8 }
if($audioFails -gt 0){ $exit = $exit -bor 2 }
if($subFails  -gt 0){ $exit = $exit -bor 4 }

if($exit -eq 0){ Write-Host "\nAll requested operations completed successfully." -ForegroundColor Green }
else {
  Write-Warn ("\nCompleted with issues (code $exit). VideoFails=$videoFails AudioFails=$audioFails SubFails=$subFails")
}
exit $exit
