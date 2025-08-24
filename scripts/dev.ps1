Param(
  [switch] $Quiet
)

function Ensure-Dependencies {
  if (-not (Test-Path -Path 'node_modules')) {
    if (-not $Quiet) { Write-Host 'Installing npm dependencies (first run)...' -ForegroundColor Yellow }
    npm install | Out-Null
  }
}

Ensure-Dependencies

& "$PSScriptRoot/start.ps1" -Quiet:$Quiet
