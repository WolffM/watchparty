Param(
  [string] $BaseUrl = 'http://localhost:3000'
)
$keyFile = Join-Path (Resolve-Path '..') 'state/admin.key'
if (-not (Test-Path $keyFile)) { Write-Error 'admin.key not found. Run start.ps1 first.'; exit 1 }
$key = Get-Content $keyFile -ErrorAction Stop

Write-Host "Using ADMIN_KEY $key" -ForegroundColor DarkCyan
$media = Invoke-RestMethod "$BaseUrl/api/media"
if (-not $media -or $media.Count -eq 0) { Write-Error 'No media files found.'; exit 1 }
$first = $media[0]
Write-Host "Staging $first" -ForegroundColor Yellow
$body = @{ path = $first; key = $key } | ConvertTo-Json -Compress
$resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/stage" -ContentType 'application/json' -Body $body
$resp | ConvertTo-Json
Write-Host 'Staged metadata:' -ForegroundColor Green
Invoke-RestMethod "$BaseUrl/api/staged" | ConvertTo-Json