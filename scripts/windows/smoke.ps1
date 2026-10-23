<#
.SYNOPSIS
    Post-deploy smoke test (PowerShell port of scripts/smoke.sh).

.DESCRIPTION
    Process startup alone does not prove multiplayer correctness: follow with the two-browser
    checks in docs/DEPLOYMENT_WINDOWS.md. Runs on the VPS or on any PC with PowerShell.

.EXAMPLE
    .\scripts\windows\smoke.ps1 https://realtime.example.com https://game.example.com
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$RealtimeUrl,
    [Parameter(Mandatory = $true, Position = 1)]
    [string]$GameUrl
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# Status, headers and body of a request; HTTP error statuses are returned, not thrown, and a
# request that gets no answer at all (DNS, TLS, refused) has status 0 and the reason.
function Send-Request([string]$Uri, [string]$Method = 'GET', [hashtable]$Headers = @{}) {
    try {
        $r = Invoke-WebRequest -Uri $Uri -Method $Method -Headers $Headers -UseBasicParsing -TimeoutSec 15
        return @{ Status = [int]$r.StatusCode; Headers = $r.Headers; Body = [string]$r.Content }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) {
            return @{ Status = 0; Headers = $null; Body = ''; Error = $_.Exception.Message }
        }
        return @{ Status = [int]$resp.StatusCode; Headers = $null; Body = '' }
    }
}

function Get-Detail($Response) {
    if ($Response.Status -eq 0) {
        return "(no response: $($Response.Error))"
    }
    return "($($Response.Status))"
}

function Test-Step([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) {
        Write-Host "  ok   $Name"
    } else {
        Write-Host "  FAIL $Name $Detail" -ForegroundColor Red
        exit 1
    }
}

$preflight = @{ 'Access-Control-Request-Method' = 'POST' }

$r = Send-Request "$RealtimeUrl/healthz"
Test-Step 'health' ($r.Status -eq 200) (Get-Detail $r)

$r = Send-Request "$RealtimeUrl/readyz"
Test-Step 'readiness (database)' (($r.Status -eq 200) -and ($r.Body -match '"ok":\s*true')) (Get-Detail $r)

$r = Send-Request "$RealtimeUrl/matchmake/create/restaurant" 'OPTIONS' ($preflight + @{ Origin = $GameUrl })
Test-Step 'matchmaking CORS preflight' ($r.Status -eq 204) (Get-Detail $r)

$r = Send-Request "$RealtimeUrl/matchmake/create/restaurant" 'OPTIONS' ($preflight + @{ Origin = 'https://evil.example' })
$acao = ''
if ($r.Headers) {
    $acao = (@($r.Headers['Access-Control-Allow-Origin']) -join ',')
}
Test-Step 'foreign origin rejected' ($acao -ne 'https://evil.example') "(allowed: $acao)"

$r = Send-Request "$GameUrl/"
Test-Step 'client index' ($r.Status -eq 200) (Get-Detail $r)

$r = Send-Request "$GameUrl/assets/does-not-exist.js"
Test-Step 'missing asset returns 404' ($r.Status -eq 404) (Get-Detail $r)

Write-Host 'Smoke test passed.' -ForegroundColor Green
