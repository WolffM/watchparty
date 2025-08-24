<#
.SYNOPSIS
  Helper to stage a media file via /api/stage.
.EXAMPLE
  ./stage.ps1 -Path "anime/example.mkv" -Key (Get-Content .envkey)
#>
Param(
  [Parameter(Mandatory=$true)][string] $Path,
  [string] $Key = $env:ADMIN_KEY,
  [string] $BaseUrl = 'http://localhost:3000'
)
if (-not $Key) { Write-Error 'ADMIN_KEY not set. Provide -Key or set $env:ADMIN_KEY.'; exit 1 }
$body = @{ path = $Path; key = $Key } | ConvertTo-Json -Compress
try {
  $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/stage" -ContentType 'application/json' -Body $body
  $resp | ConvertTo-Json -Depth 4
} catch {
  Write-Error $_
}