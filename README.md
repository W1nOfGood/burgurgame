# After Hours Burger

A first-person cooperative burger restaurant for the web. One to four cooks share a late-night
kitchen: grab ingredients, turn the grill knobs, flip patties with a spatula, melt cheese,
squeeze the right sauces and serve burgers built from memory. Works with mouse and keyboard and
with iPad touch controls, in the same room.

> **Status:** Stage 1 (real multiplayer interaction slice) is playable, with Stage 2
> (persistence and recovery) foundations and an early visual pass. Art is procedural
> placeholder, not final hero assets. See [docs/PLAN.md](docs/PLAN.md) and
> [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md).

## Install on your VPS

**Full guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).** The short version, on Ubuntu/Debian
with two DNS records (`game.` and `realtime.`) pointing at the VPS:

```bash
curl -fsSL https://get.docker.com | sudo sh
git clone https://github.com/w1nofgood/burgurgame.git /opt/after-hours && cd /opt/after-hours
cp deploy/.env.example deploy/.env      # set POSTGRES_PASSWORD, GUEST_TOKEN_SECRET, ALLOWED_ORIGINS, VITE_REALTIME_URL
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
scripts/build-client.sh https://realtime.example.com /var/www/after-hours/client
# then Nginx + Let's Encrypt (deploy/nginx/after-hours.conf), or your DirectAdmin panel
scripts/smoke.sh https://realtime.example.com https://game.example.com
```

**Do you need DirectAdmin or a separate static host?** No. The same VPS serves the static
website (via Nginx) and runs the game service and database in Docker. If your VPS already uses
DirectAdmin, the guide shows how to use its web server instead. A static-only/shared host can't
run the game service, which needs a long-running process with WebSockets.

## Play locally (development)

Requirements: Node.js 22.12+ (24 LTS recommended) and npm.

```bash
npm install
npm run dev:server     # game service on http://localhost:2567 (in-memory saves)
npm run dev:client     # client on http://localhost:5173
```

Open http://localhost:5173 in two browser windows (or a second device on your network using
`http://<your-ip>:5173/?realtime=http://<your-ip>:2567` — add that origin to `ALLOWED_ORIGINS`),
open a kitchen in one and join with the room code in the other.

To develop against PostgreSQL instead of the in-memory store:

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/afterhours
npm run migrate && npm run dev:server
```

## How to play

- Flip the **OPEN sign** switch by the counter passage to start taking orders.
- Tickets show only the burger's **name**. Learn the builds — the **recipe book** (R, the touch
  *Recipes* button, or the menu) has every recipe; *Settings → Show recipe builds on tickets*
  turns on hints while you learn.
- Patties brown on the side touching the grill: **flip** them (spatula, or E/Use for a quick
  flip). Cheese melts on a hot patty. Some burgers want **grilled** onions, others raw.
- Build on a tray from the bottom bun up, add exactly the sauces the recipe calls for, close it
  with the top bun and put the tray on the **pickup shelf** under the heat lamp.
- More recipes unlock as the night goes on: 3 at first, 8 after a few minutes, then all 16.

Controls are in [docs/CONTROLS.md](docs/CONTROLS.md).

## Tests

```bash
npm test                                   # rules, protocol, server room and store tests
TEST_DATABASE_URL=postgres://… npm test     # also runs the store contract against PostgreSQL
npm run test:e2e                           # desktop + iPad-emulated browsers in one kitchen
npm run typecheck
```

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/client` | Vite + Babylon.js client: menus, rendering, input (mouse/keyboard and touch), audio, networking |
| `apps/server` | Colyseus room, authoritative kitchen simulation, HTTP routes, persistence, migrations runner |
| `packages/simulation` | Engine-independent cooking, recipe scoring, stacking, interaction rules, shared Rapier physics |
| `packages/protocol` | Replicated state schema, message validators, protocol version |
| `packages/data` | Layout, items, recipes, prices, tuning |
| `database/migrations` | PostgreSQL schema |
| `deploy/` | Dockerfile, Compose, Nginx example, environment template |
| `scripts/` | Client build, backup, restore, smoke test |
| `tests/e2e` | Playwright multi-browser tests |
| `docs/` | Plan, deployment, architecture, controls, recipes, assets, limitations |

## Documentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — VPS install, DirectAdmin, updates, backups
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — authority, networking, persistence, security
- [docs/CONTROLS.md](docs/CONTROLS.md) — desktop and touch controls
- [docs/RECIPES.md](docs/RECIPES.md) — the menu
- [docs/ASSET_MANIFEST.md](docs/ASSET_MANIFEST.md) — asset sources and licences
- [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) — what is not done or not yet verified
- [docs/PLAN.md](docs/PLAN.md) — staged plan against the specification

Licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).
