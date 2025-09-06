Param(
  [string] $Source,
  [switch] $Force,
  [switch] $Verbose,
  [switch] $DryRun,
  [string[]] $LanguagesSubs,
  [ValidateSet('vtt','srt')] [string] $SubtitleFormat = 'vtt'
)

<#
transcribe-subtitles.ps1
Wrapper to re-extract subtitle tracks ONLY via transcribe-all.ps1 (SkipVideo, SkipAudio).
#>

$scriptPath = Join-Path $PSScriptRoot 'transcribe-all.ps1'
if(-not (Test-Path $scriptPath)){ Write-Host 'transcribe-all.ps1 not found.' -ForegroundColor Red; exit 1 }

$invoke = @('-File', $scriptPath, '-SkipVideo', '-SkipAudio', '-SubtitleFormat', $SubtitleFormat)
if($Source){ $invoke += @('-Source', $Source) }
if($Force){ $invoke += '-Force' }
if($Verbose){ $invoke += '-Verbose' }
if($DryRun){ $invoke += '-DryRun' }
if($LanguagesSubs){ $invoke += @('-LanguagesSubs', ($LanguagesSubs -join ',')) }

powershell -NoLogo -NoProfile @invoke
exit $LASTEXITCODE
