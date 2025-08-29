Param(
  [string] $SourceRoot = (Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'media') 'anime'),
  [string] $OutputRoot = (Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'media') 'output'),
  [switch] $Force,
  [switch] $Verbose,
  [switch] $Log,
  [string] $LogFile,
  [switch] $ShowCmd
)

# Extract sidecar audio tracks for each episode (best video variant already handled by transcode step).
# For every source video we gather audio stream metadata; for each (lang,title) pair we produce:
#   <base>.audio.<lang>.m4a
# If multiple variants of same episode provide the same language we keep the first produced file unless -Force.
# Additionally we produce a manifest: audio-manifest.json summarizing expected vs produced.

if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) { Write-Host 'ffprobe not in PATH' -ForegroundColor Red; exit 1 }
if (-not (Test-Path $SourceRoot)) { Write-Host "SourceRoot not found: $SourceRoot" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $OutputRoot)) { New-Item -ItemType Directory -Path $OutputRoot | Out-Null }

# Logging (transcript) optional
if ($Log) {
  if (-not $LogFile) {
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $LogFile = Join-Path $OutputRoot "audio-extract-$ts.log"
  }
  try { Start-Transcript -Path $LogFile -Force | Out-Null } catch { Write-Host "(WARN) Failed to start transcript: $_" -ForegroundColor Yellow }
}

$srcFiles = Get-ChildItem -Path $SourceRoot -Recurse -File -Include *.mkv,*.mp4 -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '\\.wp\\.mp4$' }
if (-not $srcFiles) { Write-Host 'No source files.' -ForegroundColor Yellow; exit 0 }

# Episode key heuristic: strip release tags & keep numeric sequence of E## if present else filename w/o extension
function Get-Key($path){
  $name = [IO.Path]::GetFileNameWithoutExtension($path)
  # Try pattern SxxEyy or Eyy
  $m = [Regex]::Match($name,'(S\d{1,2}E\d{1,3})','IgnoreCase')
  if ($m.Success) { return $m.Value.ToUpper() }
  $m2 = [Regex]::Match($name,'E(\d{2,3})','IgnoreCase')
  if ($m2.Success) { return 'E' + $m2.Groups[1].Value }
  return $name
}

$episodes = @{}
foreach($f in $srcFiles){
  $key = Get-Key $f.Name
  if (-not $episodes.ContainsKey($key)) { $episodes[$key] = @() }
  $episodes[$key] += $f.FullName
}

$expected = @()
$produced = @()
$plan = @()

Write-Host "Analyzing source audio streams..." -ForegroundColor Cyan

$episodeAudioMaps = @{}
foreach($ep in $episodes.Keys){
  $variants = $episodes[$ep]
  $langMap = @{}
  foreach($var in $variants){
    $probe = & ffprobe -v error -select_streams a -show_entries stream=index:stream_tags=language -of json "$var" 2>$null
    if (-not $probe) { continue }
    try { $pobj = $probe | ConvertFrom-Json } catch { continue }
    foreach($s in @($pobj.streams)){
      $lang = $null; try { $lang = $s.tags.language } catch {}
      if (-not $lang) { $lang='und' }
      $lang = $lang.ToLower()
      if (-not $langMap.ContainsKey($lang)) { $langMap[$lang] = @() }
      $langMap[$lang] += [pscustomobject]@{ File=$var; Index=$s.index; Lang=$lang }
    }
  }
  $episodeAudioMaps[$ep] = $langMap
  # Determine canonical mp4 base output for naming (match *ep* pattern)
  $candidateMp4 = Get-ChildItem -Path $OutputRoot -Filter "*$ep*.wp.mp4" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $candidateMp4) { Write-Host "(WARN) No transcoded video found for $ep yet; skipping planning." -ForegroundColor Yellow; continue }
  $baseName = [IO.Path]::GetFileNameWithoutExtension($candidateMp4.Name)
  if ($baseName.ToLower().EndsWith('.wp')) { $baseName = $baseName.Substring(0,$baseName.Length-3) }
  foreach($lang in $langMap.Keys){
    $outAudio = Join-Path $OutputRoot ("$baseName.audio.$lang.m4a")
    $expected += $outAudio
    $plan += [pscustomobject]@{ Episode=$ep; Lang=$lang; Output=$outAudio }
  }
}

if($plan.Count){
  Write-Host "Planned sidecar outputs:" -ForegroundColor Cyan
  $plan | Sort-Object Episode, Lang | ForEach-Object { Write-Host ("  {0,-10} {1,-5} -> {2}" -f $_.Episode,$_.Lang,[IO.Path]::GetFileName($_.Output)) -ForegroundColor Gray }
} else {
  Write-Host 'No planned sidecar outputs (nothing to do).' -ForegroundColor Yellow
}

Write-Host "Extracting sidecar audio..." -ForegroundColor Cyan
foreach($p in $plan){
  # IMPORTANT: use -LiteralPath because output filenames may contain [ ] which are wildcard chars.
  if (-not $Force -and (Test-Path -LiteralPath $p.Output)) { if($Verbose){ Write-Host "Skip existing $($p.Lang) $($p.Episode)" -ForegroundColor DarkGray }; continue }
  $langMap = $episodeAudioMaps[$p.Episode]
  if (-not $langMap.ContainsKey($p.Lang)) { continue }
  # Prefer AAC source
  $langEntries = $langMap[$p.Lang]
  $aacSource = $null
  foreach($entry in $langEntries){
    # IMPORTANT: ffprobe stream selection by global index uses -select_streams a:ORDINAL not global index.
    # Instead just query all audio streams once and match index below for codec (simpler & reliable).
    $codecProbe = & ffprobe -v error -show_entries stream=index,codec_type,codec_name -select_streams a -of json $entry.File 2>$null
    try { $codecObj = $codecProbe | ConvertFrom-Json } catch { $codecObj = $null }
    if ($codecObj){
      $matched = $codecObj.streams | Where-Object { $_.index -eq $entry.Index }
      if ($matched -and $matched.codec_name -eq 'aac') { $aacSource = $entry; break }
    }
  }
  $choice = if ($aacSource) { $aacSource } else { $langEntries[0] }
  Write-Host ("Extract {0} {1} from index {2}" -f $p.Episode,$p.Lang,$choice.Index) -ForegroundColor Green

  # Build attempts: first by exact global stream index, fallback by language map if needed.
  $mapAttempts = @(
    @{ desc = 'global-index'; spec = "0:$($choice.Index)" },
    @{ desc = 'language-fallback'; spec = "0:m:language:$($p.Lang)" }
  )

  $success = $false
  foreach($attempt in $mapAttempts){
    if ($success) { break }
    $mapSpec = $attempt.spec
    $ffSpec = @(
      '-hide_banner','-y','-i',$choice.File,
      '-map', $mapSpec,
      '-vn','-sn', # ensure we only output the one audio stream
      '-c:a','aac','-b:a','160k','-ac','2','-ar','48000',
      $p.Output
    )
    if ($ShowCmd) {
      Write-Host ("Attempt {0} map={1}" -f $attempt.desc,$mapSpec) -ForegroundColor DarkGray
      Write-Host ('ffmpeg ' + ($ffSpec -join ' ')) -ForegroundColor DarkGray
    }
    & ffmpeg @ffSpec 2>$null
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $p.Output)) {
      $success = $true
      $produced += $p.Output
    } else {
      if ($ShowCmd) { Write-Host ("  -> failed attempt {0} (exit {1})" -f $attempt.desc,$LASTEXITCODE) -ForegroundColor DarkYellow }
      # If file got partially created remove it before next attempt
      if (Test-Path -LiteralPath $p.Output) { Remove-Item -LiteralPath $p.Output -ErrorAction SilentlyContinue }
    }
  }
  if (-not $success) { Write-Host "Failed extract $($p.Output)" -ForegroundColor Red }
}

# Manifest & verification
$manifest = [pscustomobject]@{
  generated = (Get-Date).ToString('s')
  expected = $expected
  produced = $produced
  missing = @($expected | Where-Object { -not (Test-Path -LiteralPath $_) })
}

# If we skipped existing files they are not in $produced; augment for accurate count
if ($manifest.missing.Count -eq 0) {
  $existing = @($manifest.expected | Where-Object { -not ($manifest.produced -contains $_) })
  $manifest.produced += $existing
}
$manifestPath = Join-Path $OutputRoot 'audio-manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $manifestPath

Write-Host "Manifest: $(Split-Path -Leaf $manifestPath)" -ForegroundColor DarkGray
if ($Log) { Write-Host "Log file: $LogFile" -ForegroundColor DarkGray }
if ($manifest.missing.Count -gt 0) {
  Write-Host "Missing audio sidecars: $($manifest.missing.Count)" -ForegroundColor Yellow
  $manifest.missing | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
  if ($Log) { try { Stop-Transcript | Out-Null } catch {} }
  exit 2
} else {
  Write-Host "All expected audio sidecars present (${($manifest.produced.Count)})" -ForegroundColor DarkGreen
}

if ($Log) { try { Stop-Transcript | Out-Null } catch {} }
