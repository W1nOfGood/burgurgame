# Helpers shared by the Windows Server scripts (docs/DEPLOYMENT_WINDOWS.md).
# Dot-source it:  . (Join-Path $PSScriptRoot 'common.ps1')
# Keep these files ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

# Runs a native program and throws on a non-zero exit code. Native stderr (npm warnings,
# progress) must not count as a PowerShell error, which Windows PowerShell 5.1 does when the
# output is redirected and $ErrorActionPreference is 'Stop'.
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Arguments
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
    if ($code -ne 0) {
        throw "$(Split-Path -Leaf $Exe) exited with code $code"
    }
}

# KEY=VALUE lines of the game's environment file (the same file node --env-file reads).
function Read-EnvFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Environment file not found: $Path (see docs/DEPLOYMENT_WINDOWS.md, step 3)"
    }
    $vars = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            $vars[$Matches[1]] = $Matches[2].Trim('"', "'")
        }
    }
    return $vars
}

# A PostgreSQL client program from PATH, else from the newest C:\Program Files\PostgreSQL\<n>.
function Find-PgTool([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }
    $hit = Get-ChildItem -Path "$env:ProgramFiles\PostgreSQL\*\bin" -Filter $Name -ErrorAction SilentlyContinue |
        Sort-Object { [int]('0' + ($_.Directory.Parent.Name -replace '\D', '')) } -Descending |
        Select-Object -First 1
    if (-not $hit) {
        throw "$Name not found. Is PostgreSQL installed?"
    }
    return $hit.FullName
}

# Stops a Windows service and makes sure its process is really gone. A service whose process
# lingers after the stop request stays "Stop pending" and refuses further control messages
# ("The service cannot accept control messages at this time"). So: ask it to stop, wait up to
# $TimeoutSeconds, and if it is still not stopped, kill the service's process tree (NSSM and
# the node.exe it runs) and any node.exe still running $CommandLineLike. Returns the final
# status as a string ('Stopped', 'StopPending', ...; 'Missing' if there is no such service).
function Stop-ServiceRobust {
    param(
        [string]$Name,
        [int]$TimeoutSeconds = 15,
        [string]$CommandLineLike = '*apps\server\dist\index.js*'
    )
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) {
        return 'Missing'
    }
    if ($svc.Status -eq 'Stopped') {
        return 'Stopped'
    }
    try {
        $svc.Stop()
    } catch {
        # Already stop-pending (or paused): it will not take another request; wait, then kill.
        Write-Host "    stop request not accepted (status: $($svc.Status))"
    }
    try {
        $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds($TimeoutSeconds))
    } catch {
        # Timed out: handled below.
    }
    $svc.Refresh()
    if ($svc.Status -ne 'Stopped') {
        Write-Warning "$Name is still '$($svc.Status)' after $TimeoutSeconds s; ending its processes."
        $saved = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & taskkill.exe /F /T /FI "SERVICES eq $Name" 2>&1 | Out-Null
        } finally {
            $ErrorActionPreference = $saved
        }
        Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
            Where-Object { $_.CommandLine -and ($_.CommandLine -like $CommandLineLike) } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        try {
            $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(10))
        } catch {
            # Reported below.
        }
        $svc.Refresh()
    }
    return [string]$svc.Status
}

# Waits until the game service answers /readyz (database reachable).
function Wait-Ready([string]$Port, [int]$Seconds = 60) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        try {
            $ready = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/readyz" -UseBasicParsing -TimeoutSec 3
            if ($ready.ok) {
                return
            }
        } catch {
            # Not listening yet, or 503 while the database connects.
        }
    }
    throw "The game service did not become ready within $Seconds s. See C:\after-hours-data\logs\game.log"
}
