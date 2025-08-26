<#!
transcode-subtitles.ps1 (refactored)

Goal: SIMPLE & RELIABLE. Run with no args -> process every *.mkv under media/ recursively, extracting ALL subtitle streams to WebVTT by default, writing sidecars to media/output/.

Features:
 - Auto-detect media root (../media from scripts/).
 - Batch all MKVs by default (if no -Source and no -Single switch).
 - Per-file extraction uses a pure ffmpeg call per subtitle stream (no recursion, no temp conversions unless you choose srt output).
 - All tracks extracted unless -Languages filter supplied.
 - Names: <basename>.<lang>[.<slug>].<ext> ; disambiguate duplicate language with sanitized title or altN.
 - Exit code 0 on full success, 4 if any extraction for any file fails.

Parameters:
  -Source <file|dir>  Optional: single MKV or directory to limit scan.
  -Languages <arr>    Limit to given language codes.
  -Format <vtt|srt>   Output format (default vtt). Uses -c:s webvtt or -c:s srt directly.
  -Force              Overwrite existing outputs.
  -DryRun             Show what would happen.
  -Quiet              Minimal logging.
  -Single             Do not batch; treat -Source (or first found) as a single file only.

Examples:
  pwsh ./scripts/transcode-subtitles.ps1
  pwsh ./scripts/transcode-subtitles.ps1 -Languages eng,spa
  pwsh ./scripts/transcode-subtitles.ps1 -Source media/anime -Format srt
  pwsh ./scripts/transcode-subtitles.ps1 -Source media/anime/episode.mkv -Single
#>
[CmdletBinding()]
param(
  [string] $Source,
  [string[]] $Languages,
  [ValidateSet('vtt','srt')] [string] $Format = 'vtt',
  [switch] $Force,
  [switch] $DryRun,
  [switch] $Quiet,
  [switch] $Single
)

function Write-Info($m){ if(-not $Quiet){ Write-Host $m -ForegroundColor Cyan } }
function Write-Warn($m){ if(-not $Quiet){ Write-Host $m -ForegroundColor Yellow } }
function Write-Err($m){ Write-Host $m -ForegroundColor Red }

$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$mediaRoot = Join-Path $repoRoot 'media'
$outputRoot = Join-Path $mediaRoot 'output'
if(-not (Test-Path $outputRoot)){ try { New-Item -ItemType Directory -Path $outputRoot | Out-Null } catch {} }
if(-not (Test-Path $mediaRoot)){ Write-Err "Media folder not found: $mediaRoot"; exit 1 }

if(-not (Get-Command ffprobe -ErrorAction SilentlyContinue)){ Write-Err 'ffprobe not found (install ffmpeg)'; exit 1 }
if(-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)){ Write-Err 'ffmpeg not found (install ffmpeg)'; exit 1 }

# Resolve file set
$targets = @()
if($Source){
  if(Test-Path -LiteralPath $Source){
    $item = Get-Item -LiteralPath $Source
    if($item.PSIsContainer){
      $targets = Get-ChildItem -Path $item.FullName -Recurse -File -Include *.mkv | Sort-Object FullName
    } else {
      if($Single){ $targets = @($item) } else { $targets = @($item) }
    }
  } else { Write-Err "Source not found: $Source"; exit 1 }
} else {
  # No source provided: batch all MKVs
  $targets = Get-ChildItem -Path $mediaRoot -Recurse -File -Include *.mkv | Sort-Object FullName
}

if(-not $targets -or $targets.Count -eq 0){ Write-Err 'No MKV files found to process.'; exit 1 }
Write-Info "Processing $($targets.Count) MKV file(s)."

$wantLangs = $null
if($Languages){ $wantLangs = $Languages | ForEach-Object { $_.ToLower() } | Sort-Object -Unique }

$anyFail = $false

function Get-SubStreams($mkv){
  $json = & ffprobe -hide_banner -loglevel error -print_format json -show_streams -select_streams s -- "$mkv" 2>$null
  if(-not $json){ return @() }
  try { $p = $json | ConvertFrom-Json } catch { return @() }
  $streams = @($p.streams)
  $list = @()
  $rel = 0
  foreach($s in $streams){
    $lang = $s.tags.language; if([string]::IsNullOrWhiteSpace($lang)){ $lang = 'und' }
    $title = $s.tags.title
    $default = ($s.disposition.default -eq 1)
    $list += [pscustomobject]@{ rel=$rel; lang=$lang; title=$title; default=$default }
    $rel++
  }
  return $list
}

function Build-OutputName($base,$entry,$all){
  $slug = $entry.lang.ToLower()
  $extra = $null
  if(($all | Where-Object { $_.lang -eq $entry.lang }).Count -gt 1){
    if($entry.title){ $extra = ($entry.title -replace '[^A-Za-z0-9]+','-').Trim('-').ToLower() }
    if(-not $extra){ $extra = "alt$($entry.rel)" }
  }
  if($extra){ return "$base.$slug.$extra" } else { return "$base.$slug" }
}

foreach($file in $targets){
  Write-Info "\n==> $($file.FullName)"
  $subs = Get-SubStreams $file.FullName
  if(-not $subs -or $subs.Count -eq 0){ Write-Warn '  No subtitle streams'; continue }
  # List subtitle streams (fix pipeline precedence by separating -join)
  $streamList = ($subs | ForEach-Object { "s:$($_.rel) $($_.lang)" }) -join ', '
  Write-Info ("  Streams: $streamList")
  $extractSet = $subs
  if($wantLangs){ $extractSet = $subs | Where-Object { $wantLangs -contains $_.lang.ToLower() } }
  if(-not $extractSet -or $extractSet.Count -eq 0){ Write-Warn '  (Filtered) No matching languages'; continue }
  $base = [IO.Path]::GetFileNameWithoutExtension($file.Name)
  # Always place outputs in central media/output
  $outDir = $outputRoot
  foreach($sub in $extractSet){
    $core = Build-OutputName $base $sub $subs
    $outPath = Join-Path $outDir "$core.$Format"
  if((Test-Path -LiteralPath $outPath) -and -not $Force){ Write-Info "  Skip existing $([IO.Path]::GetFileName($outPath))"; continue }
    $map = "0:s:$($sub.rel)"
    $codec = if($Format -eq 'vtt'){ 'webvtt' } else { 'srt' }
    if($DryRun){ Write-Info "  DRYRUN ffmpeg -i <src> -map $map -c:s $codec '$([IO.Path]::GetFileName($outPath))'"; continue }
    Write-Info "  Extract s:$($sub.rel) -> $([IO.Path]::GetFileName($outPath))"
    & ffmpeg -y -i "$($file.FullName)" -map $map -c:s $codec "$outPath" 2>$null
    $exists = Test-Path -LiteralPath $outPath
    if($LASTEXITCODE -ne 0 -or -not $exists){
      Write-Warn "    FAIL (exit=$LASTEXITCODE; exists=$exists)"; $anyFail = $true
    } else {
      try { $sz = (Get-Item -LiteralPath $outPath).Length; Write-Info "    OK ($sz bytes)" } catch { Write-Info '    OK' }
    }
  }
}

if($anyFail){ Write-Warn 'One or more extractions failed.'; exit 4 } else { Write-Info 'All subtitle extractions completed successfully.' }
