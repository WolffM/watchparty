Param(
  [switch] $Quiet,
  [switch] $StopProcess
)
<#
Marks the service offline (creates state/offline.flag) so requests return 404.
Optionally stops the running server process recorded in state/server.proc.
#>
$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$stateDir = Join-Path $repoRoot 'state'
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir | Out-Null }
$offlineFlag = Join-Path $stateDir 'offline.flag'
Set-Content -Path $offlineFlag -Value 'offline' -NoNewline -ErrorAction SilentlyContinue
if (-not $Quiet) { Write-Host "[takedown] Offline flag created ($offlineFlag). Incoming requests will 404." -ForegroundColor Yellow }
if ($StopProcess) {
  $serverFileMarker = Join-Path $stateDir 'server.proc'
  if (Test-Path $serverFileMarker) {
    try {
      $procRef = Get-Content $serverFileMarker -ErrorAction SilentlyContinue
      if ($procRef) {
        $proc = Get-Process -Id $procRef -ErrorAction SilentlyContinue
        if ($proc) {
          if (-not $Quiet) { Write-Host "[takedown] Stopping server process $procRef" -ForegroundColor Cyan }
          try { Stop-Process -Id $procRef -Force } catch {}
        } else { if (-not $Quiet) { Write-Host "[takedown] No live process for recorded id $procRef" -ForegroundColor DarkGray } }
      }
    } catch {}
  }
}
