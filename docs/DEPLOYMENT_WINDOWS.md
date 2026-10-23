# Installing After Hours Burger on a Windows Server VPS

This guide takes a fresh **Windows Server 2022 or 2025** VPS to a working, HTTPS-secured game
that friends can join. It is the Windows counterpart of [DEPLOYMENT.md](DEPLOYMENT.md) (Linux):
same game, same two web addresses, same database schema, same backups.

## How it runs on Windows

The Linux guide uses Docker Compose, whose containers are Linux containers. Docker on Windows
Server runs Windows containers only, and Linux containers need WSL 2 / nested virtualisation,
which most VPS plans don't offer. So on Windows everything runs **natively as Windows services**:

| Piece | Windows service | Listens on |
| --- | --- | --- |
| Website (static client files in `C:\www\after-hours`) | `Caddy` | public 80 / 443 |
| HTTPS certificates (Let's Encrypt, automatic renewal) and the WebSocket proxy | `Caddy` | (same) |
| Game service (Node.js, Colyseus) | `AfterHoursGame` | `127.0.0.1:2567` only |
| Database (PostgreSQL 16) | `postgresql-x64-16` | `localhost:5432` only |

Both services run as the low-privilege `LocalService` account, and only ports 80 and 443 are
opened. Folders:

| Folder | Contents |
| --- | --- |
| `C:\after-hours` | the code (git checkout) |
| `C:\after-hours-data\game.env` | the game's settings and secrets (the Windows `deploy/.env`) |
| `C:\after-hours-data\logs` | game service logs |
| `C:\after-hours-data\backups` | nightly database backups |
| `C:\www\after-hours` | the website files players download |
| `C:\caddy` | Caddy, its `Caddyfile`, certificates and logs |

**Do you need IIS, Plesk or a separate static host?** No: Caddy serves the site. If the server
**already** hosts websites in IIS or Plesk, keep them and see
[IIS or Plesk instead of Caddy](#iis-or-plesk-instead-of-caddy).

## Before you start

- Windows Server 2022 or 2025 (Desktop Experience or Core). Suggested starting size: 2 vCPU,
  **4 GB RAM** (Windows and the client build need more than Linux), 40 GB disk.
- A domain with two DNS **A records** pointing at the VPS IP:
  - `burgurgame.example.com`, the website players open
  - `realtime.example.com`, the game service (WebSockets and API)
- Remote Desktop (or SSH) as an administrator. Open **Windows PowerShell as Administrator**
  (Start → type `powershell` → right-click → *Run as administrator*). Run steps 1–5 in **one
  window**, because later steps use variables set by earlier ones. Windows PowerShell 5.1 (built
  in) and PowerShell 7 both work.
- If your VPS provider has its own firewall in its control panel, allow **TCP 80, TCP 443 and
  UDP 443** there too.
- Ports 80 and 443 must be free. This should print nothing:

  ```powershell
  Get-NetTCPConnection -LocalPort 80,443 -State Listen -ErrorAction SilentlyContinue
  ```

  If IIS is installed but unused: `Stop-Service W3SVC; Set-Service W3SVC -StartupType Disabled`.

Set your domain once; every later command uses it:

```powershell
$domain = 'example.com'          # <-- your domain, without game. / realtime.
```

## Step 1 — Install the tools

```powershell
# Allow scripts in this window, use TLS 1.2, and make downloads fast in PowerShell 5.1.
Set-ExecutionPolicy Bypass -Scope Process -Force
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
$ProgressPreference = 'SilentlyContinue'

# Chocolatey, a package manager (installs the official upstream installers).
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
function Update-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
Update-SessionPath

# Random secrets for this install (hex, so they are safe inside URLs).
function New-Secret([int]$Bytes) {
    $b = New-Object byte[] $Bytes
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    -join ($b | ForEach-Object { $_.ToString('x2') })
}
$pgSuper = New-Secret 24      # PostgreSQL superuser 'postgres'
$dbPass  = New-Secret 24      # the game's own database user
$token   = New-Secret 32      # GUEST_TOKEN_SECRET (signs players' guest identities)
Write-Host "PostgreSQL superuser password (save it in your password manager): $pgSuper"

# Git, Node.js LTS, NSSM (runs programs as Windows services) and PostgreSQL 16.
choco install -y git nodejs-lts nssm
choco install -y postgresql16 --params "/Password:$pgSuper"
Update-SessionPath
node -v                       # must print v22.12 or newer
```

## Step 2 — Create the database

```powershell
$pgBin = 'C:\Program Files\PostgreSQL\16\bin'
$pgService = (Get-Service -Name 'postgresql*16*').Name        # usually postgresql-x64-16
$env:PGPASSWORD = $pgSuper
& "$pgBin\psql.exe" -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 `
    -c "CREATE ROLE afterhours LOGIN PASSWORD '$dbPass'" `
    -c "CREATE DATABASE afterhours OWNER afterhours" `
    -c "ALTER SYSTEM SET listen_addresses = 'localhost'"
Remove-Item Env:PGPASSWORD
Restart-Service $pgService

# PostgreSQL must listen on loopback only: expect 127.0.0.1 and ::1, nothing else.
Get-NetTCPConnection -LocalPort 5432 -State Listen | Select-Object LocalAddress
```

## Step 3 — Get the code, write the settings, build

```powershell
# core.autocrlf=false keeps files byte-identical to a Linux checkout.
git clone -c core.autocrlf=false https://github.com/w1nofgood/burgurgame.git C:\after-hours   # private repo: Git asks you to sign in to GitHub
New-Item -ItemType Directory -Force -Path C:\after-hours-data\logs, C:\after-hours-data\backups, C:\www\after-hours | Out-Null

# The game's settings: the same variables as deploy/.env on Linux.
@"
NODE_ENV=production
HOST=127.0.0.1
PORT=2567
TRUST_PROXY=1
DATABASE_URL=postgres://afterhours:$dbPass@127.0.0.1:5432/afterhours
GUEST_TOKEN_SECRET=$token
ALLOWED_ORIGINS=https://burgurgame.$domain
MAX_ROOMS=20
LOG_LEVEL=info
"@ | Set-Content -Encoding ASCII -Path C:\after-hours-data\game.env

# Permissions. Secrets: administrators and SYSTEM, plus read-only for the service account
# (LocalService, SID S-1-5-19). Logs: writable by the service. Backups: administrators only.
icacls C:\after-hours-data\game.env /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' '*S-1-5-19:R'
icacls C:\after-hours-data\logs /grant '*S-1-5-19:(OI)(CI)M'
icacls C:\after-hours-data\backups /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F'
icacls C:\after-hours /grant '*S-1-5-19:(OI)(CI)RX'
icacls C:\www\after-hours /grant '*S-1-5-19:(OI)(CI)RX'

# Build everything, create the database tables and publish the website files (takes a few minutes).
cd C:\after-hours
.\scripts\windows\update.ps1 -RealtimeUrl "https://realtime.$domain"
```

`GUEST_TOKEN_SECRET` signs players' guest identities. Keep it private and stable: changing it
signs everyone out of their saved restaurants. To change other settings later, edit
`C:\after-hours-data\game.env` (`notepad C:\after-hours-data\game.env`) and run
`Restart-Service AfterHoursGame`.

## Step 4 — Run the game service

```powershell
$node = (Get-Command node.exe).Source
nssm install AfterHoursGame $node --env-file=C:\after-hours-data\game.env apps\server\dist\index.js
nssm set AfterHoursGame AppDirectory C:\after-hours
nssm set AfterHoursGame DisplayName 'After Hours Burger game service'
nssm set AfterHoursGame DependOnService $pgService
nssm set AfterHoursGame AppStopMethodConsole 30000      # 30 s to save kitchens on stop/restart
nssm set AfterHoursGame AppStdout C:\after-hours-data\logs\game.log
nssm set AfterHoursGame AppStderr C:\after-hours-data\logs\game.log
nssm set AfterHoursGame AppRotateFiles 1
nssm set AfterHoursGame AppRotateOnline 1
nssm set AfterHoursGame AppRotateBytes 10485760

# Run as the low-privilege LocalService account instead of SYSTEM.
function Set-LocalServiceAccount([string]$Name) {
    $r = Get-CimInstance Win32_Service -Filter "Name='$Name'" |
        Invoke-CimMethod -MethodName Change -Arguments @{ StartName = 'NT AUTHORITY\LocalService'; StartPassword = '' }
    if ($r.ReturnValue -ne 0) { throw "Could not change the account of $Name (code $($r.ReturnValue))" }
}
Set-LocalServiceAccount AfterHoursGame

Start-Service AfterHoursGame
Start-Sleep -Seconds 5
Invoke-RestMethod http://127.0.0.1:2567/healthz       # ok: True
Invoke-RestMethod http://127.0.0.1:2567/readyz        # ok: True, store: postgres
```

If either check fails, read `Get-Content C:\after-hours-data\logs\game.log -Tail 30`.

## Step 5 — HTTPS web server (Caddy)

Caddy serves the website, proxies `realtime.` (including WebSockets) to the game service, and
gets and renews the Let's Encrypt certificates by itself. Its site file is
[`deploy/windows/Caddyfile`](../deploy/windows/Caddyfile), the Caddy version of the Linux Nginx
example (same cache rules and headers).

```powershell
New-Item -ItemType Directory -Force -Path C:\caddy\data, C:\caddy\config, C:\caddy\logs | Out-Null
Invoke-WebRequest 'https://caddyserver.com/api/download?os=windows&arch=amd64' -OutFile C:\caddy\caddy.exe -UseBasicParsing
C:\caddy\caddy.exe version

# The site file with your domain filled in.
(Get-Content C:\after-hours\deploy\windows\Caddyfile) -replace 'example\.com', $domain | Set-Content -Encoding ASCII C:\caddy\Caddyfile
C:\caddy\caddy.exe validate --config C:\caddy\Caddyfile --adapter caddyfile

foreach ($d in 'data', 'config', 'logs') { icacls "C:\caddy\$d" /grant '*S-1-5-19:(OI)(CI)M' | Out-Null }
nssm install Caddy C:\caddy\caddy.exe run --config C:\caddy\Caddyfile --adapter caddyfile
nssm set Caddy AppDirectory C:\caddy
nssm set Caddy AppEnvironmentExtra XDG_DATA_HOME=C:\caddy\data XDG_CONFIG_HOME=C:\caddy\config
nssm set Caddy AppStopMethodConsole 10000
nssm set Caddy AppStdout C:\caddy\logs\caddy.log
nssm set Caddy AppStderr C:\caddy\logs\caddy.log
nssm set Caddy AppRotateFiles 1
nssm set Caddy AppRotateOnline 1
nssm set Caddy AppRotateBytes 10485760
Set-LocalServiceAccount Caddy

# Open the web ports (2567 and 5432 stay closed: those services listen on loopback only).
New-NetFirewallRule -DisplayName 'After Hours HTTP'   -Direction Inbound -Protocol TCP -LocalPort 80  -Action Allow | Out-Null
New-NetFirewallRule -DisplayName 'After Hours HTTPS'  -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow | Out-Null
New-NetFirewallRule -DisplayName 'After Hours HTTP/3' -Direction Inbound -Protocol UDP -LocalPort 443 -Action Allow | Out-Null

Start-Service Caddy
Get-Content C:\caddy\logs\caddy.log -Tail 20 -Wait     # watch "certificate obtained successfully"; Ctrl+C stops watching
```

## Step 6 — Check the deployment

```powershell
cd C:\after-hours
.\scripts\windows\smoke.ps1 "https://realtime.$domain" "https://burgurgame.$domain"
```

`smoke.ps1` also works from your own PC (any machine with PowerShell). Then do the real test,
because a service starting does not prove multiplayer works:

1. Open `https://burgurgame.example.com` on a computer, enter a name, **Open kitchen**. Note the
   6-letter room code (top-left).
2. On a phone hotspot or another network, open the same site on an iPad (or a second browser),
   enter the code and **Join**.
3. Both players should see each other. Flip the OPEN sign (by the counter passage), cook a
   patty, flip it, build the burger on a tray, close it with a top bun and place the tray on the
   pickup shelf under the heat lamp. The money in the top bar should go up once.

## Day-to-day operations

Open **PowerShell as Administrator** for these.

**Update to a new version**

```powershell
cd C:\after-hours
.\scripts\windows\update.ps1 -RealtimeUrl https://realtime.example.com
```

It pulls the code, reinstalls dependencies only when `package-lock.json` changed, builds, runs
the database migrations, restarts the game service, waits until it is ready, then publishes the
website (new files first, `index.html` last). Players in a kitchen during the restart see a
"server restarting" message; their restaurant is saved first and the owner reopens it. If
Windows refuses to run the script, use
`powershell -ExecutionPolicy Bypass -File .\scripts\windows\update.ps1 -RealtimeUrl https://realtime.example.com`.

**Status, logs, restart**

```powershell
Get-Service AfterHoursGame, Caddy, postgresql*
Get-Content C:\after-hours-data\logs\game.log -Tail 50 -Wait
Restart-Service AfterHoursGame
```

Credentials are never logged, and Caddy keeps no access log, so the realtime URLs (which carry
the guest credential) are never written to disk. NSSM starts a new log file every 10 MB but
keeps the old ones; to delete those older than 30 days:
`Get-ChildItem C:\after-hours-data\logs, C:\caddy\logs -Filter '*-*.log' | Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) | Remove-Item`.

All three services start automatically with Windows, so a Windows Update reboot only restarts
the game. Set the server's update hours (`sconfig`, or *Settings → Windows Update*) to a quiet
time of day.

**Backups**: nightly at 04:15, kept outside the web root (the newest 14 are kept):

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -Command "& C:\after-hours\scripts\windows\backup.ps1 *>> C:\after-hours-data\backups\backup.log"'
$trigger = New-ScheduledTaskTrigger -Daily -At 4:15am
Register-ScheduledTask -TaskName 'After Hours backup' -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest
Start-ScheduledTask -TaskName 'After Hours backup'      # one backup now, to check it works
Get-Content C:\after-hours-data\backups\backup.log
```

Copy backups off the VPS as well (another machine or object storage). A backup is only proven
by a restore: practise one on a spare machine.

**Restore**

```powershell
.\scripts\windows\restore.ps1 C:\after-hours-data\backups\afterhours-YYYYmmddTHHMMSSZ.dump
```

It stops the game, restores the dump, re-runs the migrations and starts the game again. Dumps
are interchangeable with the Linux `scripts/backup.sh`, so this is also how you move an install
between Linux and Windows. Copy `GUEST_TOKEN_SECRET` across too, or every player is signed out.

**Capacity**

`MAX_ROOMS` (default 20) caps simultaneous kitchens. Each kitchen runs a 60 Hz physics
simulation; measure CPU, memory and event-loop delay on your VPS with real players before
raising it (see `docs/KNOWN_LIMITATIONS.md`).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "running scripts is disabled on this system" | Run `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` once, or start the script with `powershell -ExecutionPolicy Bypass -File …` |
| `AfterHoursGame` stops right after starting | Read `C:\after-hours-data\logs\game.log`: usually a mistake in `game.env` (`ALLOWED_ORIGINS`, a `GUEST_TOKEN_SECRET` shorter than 32 characters) or PostgreSQL not running |
| `readyz` returns 503 | Database not reachable: `Get-Service postgresql*`, and check the password in `DATABASE_URL` |
| No certificate / "challenge failed" in `caddy.log` | DNS doesn't point at the VPS yet, ports 80/443 are blocked by the provider's firewall, or another program holds port 80 (`Get-NetTCPConnection -LocalPort 80 -State Listen`, then `Get-Process -Id <OwningProcess>`) |
| `npm ci` fails with EPERM / "file in use" | Something holds files in `node_modules` (an editor, or the game service): `Stop-Service AfterHoursGame` and run the update again |
| "Can't reach the game server" | `realtime.` DNS, certificate or proxy not working; check `Invoke-RestMethod https://realtime.example.com/healthz` |
| Join fails with CORS errors in the browser console | `ALLOWED_ORIGINS` doesn't exactly match the site's origin (scheme + host, no slash) |
| Connects then drops immediately | Something in front of the VPS (a CDN or proxy) doesn't pass WebSockets; with IIS, the WebSocket Protocol feature is missing |
| Blank page | Client built with the wrong `-RealtimeUrl` (run `update.ps1` again with the right one), or files not in `C:\www\after-hours` |
| Everyone signed out after an update | `GUEST_TOKEN_SECRET` changed |

## IIS or Plesk instead of Caddy

If the server already hosts sites in IIS (or Plesk for Windows, which uses IIS), let IIS keep
ports 80/443 and skip Step 5. Steps 1–4 and 6 stay the same. Menus differ between versions, so
treat these as the things to set up rather than exact clicks.

1. **IIS features.** WebSockets, URL Rewrite and Application Request Routing (the reverse proxy):

   ```powershell
   Install-WindowsFeature Web-Server, Web-WebSockets -IncludeManagementTools
   choco install -y urlrewrite iis-arr
   Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name enabled -Value True
   ```

2. **Two sites** (in Plesk: two domains or subdomains):
   - `burgurgame.example.com`, physical path `C:\www\after-hours`. Copy
     [`deploy/windows/iis-client.web.config`](../deploy/windows/iis-client.web.config) there as
     `web.config` (the glTF/WebP/model types IIS doesn't know, and the cache rules).
     `update.ps1` leaves it in place.
   - `realtime.example.com`, an empty folder such as `C:\www\after-hours-realtime`, with
     [`deploy/windows/iis-realtime.web.config`](../deploy/windows/iis-realtime.web.config)
     copied in as `web.config`. It forwards everything, WebSockets included, to
     `127.0.0.1:2567`.
3. **HTTPS** for both names: in Plesk, *SSL/TLS Certificates → Let's Encrypt* on each domain.
   On plain IIS, use win-acme (`choco install -y win-acme`, then run `wacs.exe` and follow its
   prompts for both names).
4. **Keep the guest credential out of the logs.** The realtime URLs carry it in the query
   string, so remove the query field from that site's IIS log:

   ```powershell
   Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter "system.applicationHost/sites/site[@name='realtime.example.com']/logFile" -Name logExtFileFlags -Value 'Date,Time,ClientIP,Method,UriStem,HttpStatus,TimeTaken,UserAgent'
   ```

   (Use the site name IIS shows. In Plesk the site is usually named after the domain.)

## Running without a domain (local network / testing)

For a quick LAN test you can skip Caddy and TLS: set `ALLOWED_ORIGINS=http://<vps-ip>:8080`
and `HOST=0.0.0.0` in `game.env`, build with `update.ps1 -RealtimeUrl http://<vps-ip>:2567`,
open TCP 2567 and 8080 in the firewall, and serve `C:\www\after-hours` with any static server
on port 8080 (for example `C:\caddy\caddy.exe file-server --root C:\www\after-hours --listen :8080`).
Browsers only allow pointer lock, audio and WebSockets reliably over HTTPS on the public
internet, so use a real domain for anything beyond testing.
