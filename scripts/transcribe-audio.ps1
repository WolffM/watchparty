Param(
  [string] $Source,
  [switch] $Force,
  [switch] $Verbose,
  [switch] $DryRun,
  [string[]] $LanguagesAudio
)

<#
transcribe-audio.ps1
Convenience wrapper to (re)extract sidecar audio tracks using transcribe-all.ps1 without re-transcoding video (SkipVideo) and without touching subtitles (SkipSubs).
#>

$scriptPath = Join-Path $PSScriptRoot 'transcribe-all.ps1'
if(-not (Test-Path $scriptPath)){ Write-Host 'transcribe-all.ps1 not found.' -ForegroundColor Red; exit 1 }

$invoke = @('-File', $scriptPath, '-SkipVideo', '-SkipSubs')
if($Source){ $invoke += @('-Source', $Source) }
if($Force){ $invoke += '-Force' }
if($Verbose){ $invoke += '-Verbose' }
if($DryRun){ $invoke += '-DryRun' }
if($LanguagesAudio){ $invoke += @('-LanguagesAudio', ($LanguagesAudio -join ',')) }

powershell -NoLogo -NoProfile @invoke
exit $LASTEXITCODE
