<#
.SYNOPSIS
    Writes a compressed PostgreSQL dump of the game database (Windows Server VPS).

.DESCRIPTION
    Uses DATABASE_URL from the game's environment file, writes afterhours-<UTC stamp>.dump to the
    backup directory (outside any web root) and keeps the newest -Keep dumps.
    See docs/DEPLOYMENT_WINDOWS.md ("Backups").

.EXAMPLE
    .\scripts\windows\backup.ps1
#>
[CmdletBinding()]
param(
    [string]$Dir = 'C:\after-hours-data\backups',
    [int]$Keep = 14,
    [string]$EnvFile = 'C:\after-hours-data\game.env'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$db = (Read-EnvFile $EnvFile)['DATABASE_URL']
if (-not $db) {
    throw "DATABASE_URL is missing from $EnvFile"
}
$pgDump = Find-PgTool 'pg_dump.exe'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$file = Join-Path $Dir "afterhours-$stamp.dump"
Invoke-Native $pgDump @('--format=custom', "--dbname=$db", "--file=$file.partial")
Move-Item -LiteralPath "$file.partial" -Destination $file

Get-ChildItem -LiteralPath $Dir -Filter 'afterhours-*.dump' | Sort-Object Name -Descending |
    Select-Object -Skip $Keep | Remove-Item -Force

$mb = [math]::Round((Get-Item -LiteralPath $file).Length / 1MB, 2)
Write-Output "$(Get-Date -Format s) backup written: $file ($mb MB)"
