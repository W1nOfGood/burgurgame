<#
.SYNOPSIS
    Builds After Hours Burger and (re)deploys it on a Windows Server VPS.

.DESCRIPTION
    Pulls the latest code, installs dependencies when package-lock.json changed, builds the
    shared packages, the server and the client (with the realtime origin baked in), applies
    database migrations, restarts the game service and publishes the client to the web root.
    The first run (before the service exists) only builds, migrates and publishes.
    See docs/DEPLOYMENT_WINDOWS.md.

.EXAMPLE
    .\scripts\windows\update.ps1 -RealtimeUrl https://realtime.example.com
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RealtimeUrl,
    [string]$WebRoot = 'C:\www\after-hours',
    [string]$EnvFile = 'C:\after-hours-data\game.env',
    [string]$Service = 'AfterHoursGame'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $repo
$config = Read-EnvFile $EnvFile
$port = '2567'
if ($config['PORT']) {
    $port = $config['PORT']
}
$svc = Get-Service -Name $Service -ErrorAction SilentlyContinue

Write-Step 'Pulling the latest code'
Invoke-Native 'git.exe' @('pull', '--ff-only')

$lockHash = (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash
$stamp = Join-Path $repo 'node_modules\.ahb-lock-sha256'
$installed = ''
if (Test-Path -LiteralPath $stamp) {
    $installed = (Get-Content -LiteralPath $stamp -Raw).Trim()
}

try {
    if ($installed -ne $lockHash) {
        # The running service keeps native modules open, so it stops before npm replaces them.
        if ($svc) {
            Write-Step "Stopping $Service (players see 'server restarting'; kitchens are saved first)"
            Stop-Service -Name $Service
        }
        Write-Step 'Installing dependencies (npm ci)'
        Invoke-Native 'npm.cmd' @('ci', '--no-audit', '--no-fund')
        Set-Content -LiteralPath $stamp -Value $lockHash -Encoding ASCII
    }

    Write-Step "Building (realtime origin: $RealtimeUrl)"
    $env:VITE_REALTIME_URL = $RealtimeUrl
    Invoke-Native 'npm.cmd' @('run', 'build')

    if ($svc -and (Get-Service -Name $Service).Status -ne 'Stopped') {
        Write-Step "Stopping $Service (players see 'server restarting'; kitchens are saved first)"
        Stop-Service -Name $Service
    }
    Write-Step 'Applying database migrations'
    Invoke-Native 'node.exe' @("--env-file=$EnvFile", 'apps\server\dist\migrate.js')

    if ($svc) {
        Write-Step "Starting $Service"
        Start-Service -Name $Service
        Wait-Ready $port
    }
} catch {
    if ($svc -and (Get-Service -Name $Service).Status -ne 'Running') {
        Write-Warning "$Service is stopped. Fix the error below and run this script again (or 'Start-Service $Service' to bring the previous build back)."
    }
    throw
}

# Copy new hashed assets first, then index.html, so no visitor sees a page without its assets.
Write-Step "Publishing the client to $WebRoot"
$dist = Join-Path $repo 'apps\client\dist'
New-Item -ItemType Directory -Force -Path $WebRoot | Out-Null
function Invoke-Robocopy([string]$From, [string]$To, [string]$Mode) {
    & robocopy.exe $From $To $Mode /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy $From -> $To failed with code $LASTEXITCODE"
    }
}
Invoke-Robocopy (Join-Path $dist 'assets') (Join-Path $WebRoot 'assets') '/E'
# Blender-built art (stable names; served with revalidation, see deploy/windows/Caddyfile).
if (Test-Path -LiteralPath (Join-Path $dist 'art')) {
    Invoke-Robocopy (Join-Path $dist 'art') (Join-Path $WebRoot 'art') '/MIR'
}
Get-ChildItem -LiteralPath $dist -File | Where-Object { $_.Name -ne 'index.html' } |
    Copy-Item -Destination $WebRoot -Force
Copy-Item -LiteralPath (Join-Path $dist 'index.html') -Destination (Join-Path $WebRoot 'index.html') -Force

if ($svc) {
    Write-Host "Done. Game service ready on 127.0.0.1:$port; client published to $WebRoot." -ForegroundColor Green
} else {
    Write-Host "Built, migrated and published to $WebRoot. Next: install the $Service service (docs/DEPLOYMENT_WINDOWS.md, step 4)." -ForegroundColor Green
}
exit 0
