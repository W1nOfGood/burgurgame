# Installing After Hours Burger on your VPS

This guide takes a fresh Linux VPS to a working, HTTPS-secured game that friends can join.
It covers two setups:

- **A. Plain VPS with Nginx** (recommended if the server has no control panel).
- **B. VPS that already runs DirectAdmin** (or a similar panel such as cPanel or Plesk).

**Windows Server VPS?** Use [DEPLOYMENT_WINDOWS.md](DEPLOYMENT_WINDOWS.md) instead (PowerShell
commands; Node.js, PostgreSQL and Caddy run as Windows services).

## Do I need a static host or DirectAdmin?

**No.** One VPS runs everything:

| Piece | What it is | Where it runs |
| --- | --- | --- |
| Game client | Static HTML/JS/CSS files built by Vite | Served by the web server on your VPS (Nginx, or DirectAdmin's web server) |
| Game service | A long-running Node.js process (Colyseus) using WebSockets | Docker container on the same VPS, listening only on `127.0.0.1:2567` |
| Database | PostgreSQL | Docker container on a private network, never exposed |

DirectAdmin is a hosting control panel, not a requirement. If your VPS **already** uses
DirectAdmin to run its websites, use setup B so you don't fight the panel for ports 80/443. If
the VPS has no panel, setup A is simpler.

A **static-only host** (shared hosting with no SSH, no Docker and no long-running processes) can
serve the client files, but it cannot run the game service — that part must live on a VPS.

## Before you start

- A VPS running Ubuntu 24.04 or Debian 12 (other distros work; commands differ). Suggested
  starting size: 2 vCPU, 2–4 GB RAM, 20 GB disk. Measure before promising a player count
  (see "Capacity" below).
- A domain with two DNS **A records** pointing at the VPS IP:
  - `game.example.com` — the website players open
  - `realtime.example.com` — the game service (WebSockets and API)
- SSH access as a user with `sudo`.

Throughout this guide replace `example.com` with your domain.

## Step 1 — Install Docker and tools

```bash
sudo apt update
sudo apt install -y git curl rsync openssl
curl -fsSL https://get.docker.com | sudo sh          # Docker Engine + Compose plugin
sudo usermod -aG docker "$USER" && newgrp docker      # run docker without sudo
docker compose version                               # should print v2.x
```

## Step 2 — Get the code and configure secrets

```bash
sudo mkdir -p /opt/after-hours && sudo chown "$USER" /opt/after-hours
git clone https://github.com/w1nofgood/burgurgame.git /opt/after-hours   # private repo? use a deploy key or a GitHub token
cd /opt/after-hours
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

Edit `deploy/.env`:

```bash
POSTGRES_PASSWORD=$(openssl rand -hex 24)        # paste the generated value
GUEST_TOKEN_SECRET=$(openssl rand -hex 32)       # paste the generated value
ALLOWED_ORIGINS=https://game.example.com         # exact origin, no trailing slash
VITE_REALTIME_URL=https://realtime.example.com
```

`GUEST_TOKEN_SECRET` signs players' guest identities. Keep it private and stable — changing it
signs everyone out of their saved restaurants.

## Step 3 — Start the game service and database

```bash
cd /opt/after-hours
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps
```

The first build takes a few minutes. Compose then:

1. starts PostgreSQL (private network only, data in the `pgdata` volume),
2. runs the one-off `migrate` service that creates/updates the database schema,
3. starts `game` on `127.0.0.1:2567` once migrations succeed.

Check it locally on the VPS:

```bash
curl -s http://127.0.0.1:2567/healthz    # {"ok":true}
curl -s http://127.0.0.1:2567/readyz     # {"ok":true,"store":"postgres"}
```

## Step 4 — Build the website files

```bash
sudo mkdir -p /var/www/after-hours/client && sudo chown "$USER" /var/www/after-hours/client
scripts/build-client.sh https://realtime.example.com /var/www/after-hours/client
```

This builds the static client inside Docker with your realtime URL baked in and copies it to
the web root. Re-run it whenever you update the game. (On DirectAdmin, use the domain's
`public_html` as the destination instead — see setup B.)

## Step 5A — Web server: plain Nginx

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw --force enable

# One certificate for both names (Nginx's default site answers the challenge).
sudo certbot certonly --nginx -d game.example.com -d realtime.example.com

# WebSocket upgrade map, once per server.
echo 'map $http_upgrade $connection_upgrade { default upgrade; "" close; }' | sudo tee /etc/nginx/conf.d/websocket-map.conf

# The site: copy, replace example.com, enable.
sudo cp deploy/nginx/after-hours.conf /etc/nginx/sites-available/after-hours.conf
sudo sed -i 's/example\.com/YOURDOMAIN.com/g' /etc/nginx/sites-available/after-hours.conf
sudo ln -s /etc/nginx/sites-available/after-hours.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Certbot renews automatically; it reloads Nginx on renewal.

## Step 5B — Web server: DirectAdmin (or another panel)

Let the panel own ports 80/443 and point it at the container. Panel menus differ between
versions and web-server modes, so treat these as the steps to look for rather than exact
clicks.

1. **Create both domains/subdomains** in DirectAdmin: `game.example.com` and
   `realtime.example.com`.
2. **Enable SSL** (Let's Encrypt) for both in DirectAdmin's SSL Certificates page.
3. **Upload the client**: run step 4 with the domain's web root as the destination, e.g.
   `scripts/build-client.sh https://realtime.example.com /home/USER/domains/game.example.com/public_html`
   (then make sure the files are owned by that DirectAdmin user:
   `sudo chown -R USER:USER /home/USER/domains/game.example.com/public_html`).
4. **Reverse-proxy the realtime domain to the container.** As admin, open *Custom HTTPD
   Configurations* for `realtime.example.com` and add a proxy for **every path** with WebSocket
   upgrade support:

   - **Apache** (DirectAdmin's default; needs `mod_proxy`, `mod_proxy_http`,
     `mod_proxy_wstunnel` and `mod_rewrite`, which CustomBuild normally provides):

     ```apache
     ProxyPreserveHost On
     ProxyRequests Off
     RewriteEngine On
     RewriteCond %{HTTP:Upgrade} =websocket [NC]
     RewriteRule ^/?(.*) ws://127.0.0.1:2567/$1 [P,L]
     ProxyPass / http://127.0.0.1:2567/
     ProxyPassReverse / http://127.0.0.1:2567/
     ProxyTimeout 90
     ```

   - **Nginx or Nginx + Apache modes**: use the `location / { … }` block from the
     `realtime.example.com` server in `deploy/nginx/after-hours.conf`. If the panel's template
     already defines `location /` for that domain, override it in the panel's custom config
     rather than adding a second one (Nginx rejects duplicates).
   - **OpenLiteSpeed/LiteSpeed**: add a Web Server external app pointing at
     `127.0.0.1:2567` and a proxy context for `/` (WebSocket proxying is supported).

5. **Static file caching** (optional but recommended): long cache for `/assets/*` (the files
   are fingerprinted), `no-cache` for `index.html` and for `/art/*` (the Blender-built models,
   lightmaps and probes keep their names between builds, so browsers must revalidate them), and
   gzip for `.gltf`/`.bin`/`.env` (`model/gltf+json`, `application/octet-stream`). The Nginx
   example in `deploy/nginx/after-hours.conf` already does all of this.

The game container is unaffected by the panel; Docker and DirectAdmin coexist. PostgreSQL runs
in its own container and does not touch DirectAdmin's MySQL/MariaDB.

## Step 6 — Check the deployment

```bash
scripts/smoke.sh https://realtime.example.com https://game.example.com
```

Then the real test (process startup alone does not prove multiplayer works):

1. Open `https://game.example.com` on a computer, enter a name, **Open kitchen**. Note the
   6-letter room code (top-left).
2. On a phone hotspot or another network, open the same site on an iPad (or a second browser),
   enter the code and **Join**.
3. Both players should see each other. Flip the OPEN sign (by the counter passage), cook a
   patty, flip it, build the burger on a tray, close it with a top bun and place the tray on the
   pickup shelf under the heat lamp. The money in the top bar should go up once.

## Day-to-day operations

**Update to a new version**

```bash
cd /opt/after-hours
git pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build   # migrations run first
scripts/build-client.sh https://realtime.example.com /var/www/after-hours/client
```

Players in a kitchen during the restart see a "server restarting" message; their restaurant is
saved first and the owner reopens it (others rejoin with the new code).

**Logs**

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f game
```

Logs are rotated (5 × 10 MB per container). Credentials are never logged, and the Nginx example
logs realtime requests without query strings.

**Backups** — nightly, kept outside the containers and outside any web root:

```bash
sudo mkdir -p /var/backups/after-hours && sudo chown "$USER" /var/backups/after-hours
crontab -e
# 15 4 * * * cd /opt/after-hours && scripts/backup.sh /var/backups/after-hours >> /var/backups/after-hours/backup.log 2>&1
```

Copy backups off the VPS as well (another machine or object storage). A backup is only proven
by a restore: practise `scripts/restore.sh <file>` on a spare VPS or a local machine.

**Restore**

```bash
scripts/restore.sh /var/backups/after-hours/afterhours-YYYYmmddTHHMMSSZ.dump
```

It stops the game, restores the dump, re-runs migrations and starts the game again.

**Capacity**

`MAX_ROOMS` (default 20) caps simultaneous kitchens. Each kitchen runs a 60 Hz physics
simulation; measure CPU, memory and event-loop delay on your VPS with real players before
raising it (see `docs/KNOWN_LIMITATIONS.md`).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Can't reach the game server" | `realtime.example.com` DNS/SSL/proxy not working; check `curl https://realtime.example.com/healthz` |
| Join fails with CORS errors in the browser console | `ALLOWED_ORIGINS` doesn't exactly match the site's origin (scheme + host, no slash) |
| Connects then drops immediately | WebSocket upgrade not proxied — check the `Upgrade`/`Connection` headers (or Apache `mod_proxy_wstunnel`) |
| `readyz` returns 503 | Database not reachable; `docker compose … logs db migrate` |
| Blank page | Client built with the wrong `VITE_REALTIME_URL`, or files not in the web root |
| Everyone signed out after an update | `GUEST_TOKEN_SECRET` changed |

## Running without a domain (local network / testing)

For a quick LAN test you can skip TLS: set `ALLOWED_ORIGINS=http://<vps-ip>:8080`, build the
client with `http://<vps-ip>:2567`, publish the game port on all interfaces in a copy of the
Compose file, and serve the client with any static server on port 8080. Browsers only allow
pointer lock, audio and WebSockets reliably over HTTPS on the public internet, so use a real
domain for anything beyond testing.
