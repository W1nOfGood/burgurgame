<#
.SYNOPSIS
    Restores a dump made by backup.ps1 into the game database (Windows Server VPS).

.DESCRIPTION
    Stops the game service so no kitchen writes meanwhile, restores the dump, re-runs the
    migrations and starts the service again. Practise this on a spare machine regularly: a
    backup is only proven by a restore. See docs/DEPLOYMENT_WINDOWS.md ("Restore").

.EXAMPLE
    .\scripts\windows\restore.ps1 C:\after-hours-data\backups\afterhours-20261023T041500Z.dump
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$File,
    [string]$EnvFile = 'C:\after-hours-data\game.env',
    [string]$Service = 'AfterHoursGame'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not (Test-Path -LiteralPath $File)) {
    throw "Backup file not found: $File"
}
$config = Read-EnvFile $EnvFile
$db = $config['DATABASE_URL']
if (-not $db) {
    throw "DATABASE_URL is missing from $EnvFile"
}
$port = '2567'
if ($config['PORT']) {
    $port = $config['PORT']
}
$pgRestore = Find-PgTool 'pg_restore.exe'

$answer = Read-Host 'This replaces the current database contents. Type RESTORE to continue'
if ($answer -cne 'RESTORE') {
    Write-Host 'Aborted.'
    exit 1
}

Set-Location -LiteralPath (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$svc = Get-Service -Name $Service -ErrorAction SilentlyContinue
if ($svc) {
    Write-Step "Stopping $Service"
    $state = Stop-ServiceRobust -Name $Service
    if ($state -ne 'Stopped') {
        throw "$Service did not stop (it is '$state'); nothing was restored. See 'Stuck in Stop pending' in docs/DEPLOYMENT_WINDOWS.md."
    }
}
Write-Step "Restoring $File"
Invoke-Native $pgRestore @("--dbname=$db", '--clean', '--if-exists', '--no-owner', $File)
Write-Step 'Applying database migrations'
Invoke-Native 'node.exe' @("--env-file=$EnvFile", 'apps\server\dist\migrate.js')
if ($svc) {
    Write-Step "Starting $Service"
    Start-Service -Name $Service
    Wait-Ready $port
}
Write-Host "Restored $File" -ForegroundColor Green
