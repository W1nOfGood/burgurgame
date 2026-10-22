# After Hours Burger — implementation plan

Source of truth: `After_Hours_Burger_Game_Spec.md` v2.1 (23 Oct 2026). This plan turns the
spec's delivery stages into concrete engineering work and records the decisions taken while
building. Everything numeric here is a target to measure, not a claim.

## Pinned toolchain (checked 22 Oct 2026)

| Concern | Package | Version |
| --- | --- | --- |
| Language | typescript | 5.9.3 (TS 7 native compiler skipped for now: schema codegen needs the JS compiler API) |
| Multiplayer server | @colyseus/core, @colyseus/ws-transport | 0.18.23, 0.18.4 |
| State sync | @colyseus/schema | 5.0.42 (`schema()` builder API, no decorators) |
| Client SDK | @colyseus/sdk | 0.18.6 |
| Room tests | @colyseus/testing | 0.18.6 |
| Physics | @dimforge/rapier3d-compat | 0.21.0 (same build on server and client) |
| Rendering | @babylonjs/core | 9.32.0 |
| Runtime validation | zod | 4.6.7 (Colyseus 0.18 peer) |
| HTTP routes | express | 5.x (Colyseus `express` server option) |
| Database | PostgreSQL 16 via `pg` 8.23 |
| Build | vite 8, vitest 5, @playwright/test 1.64 |
| Runtime | Node 24 LTS in the production image; dev container runs Node 22 |

Colyseus 0.18 ships its own input/prediction API. Stage 1 uses plain room messages with our own
sequenced input batches instead, because the spec asks for ~30 messages/s carrying several
60 Hz samples and we want full control of reconciliation. Revisit once the slice is measured.

## Status (22 Oct 2026)

| Stage | State |
| --- | --- |
| 1 — Multiplayer interaction slice | Playable: shared kitchen for desktop + touch, grab/hand-over, knobs, drawer, spatula flips, assembly, sauces, serving with one-time payment. Verified by room tests and Playwright desktop + iPad-emulated tests. **Physical iPad not yet tested.** |
| 2 — Persistence and recovery | Foundations built and tested: guest identity, PostgreSQL schema + migrations, fenced leases, transactional sales/purchases, checkpoints, restore without double-serving, room lifecycle, pause rules. |
| 3 — Visual benchmark | Procedural placeholder pass only (see `ASSET_MANIFEST.md`). |
| 4 — Restaurant shift | 16 recipes in three unlock tiers, modifiers, scoring, ledger overlay. No customers, fries, drinks, cleaning or upgrades yet. |
| 5 — Release hardening | Deployment stack, backups and smoke test exist; measurements, physical-device and load testing outstanding. |

See `KNOWN_LIMITATIONS.md` for the full list.

## Workspace layout

```
apps/client        Vite + Babylon.js browser client, HTML/CSS menus, input, audio, networking
apps/server        Colyseus room, authority, HTTP routes, persistence, health
packages/data      Layout, stations, items, recipes, prices, tuning (plain data, no deps)
packages/simulation Engine-independent cooking, recipe scoring, movement, interaction rules,
                    shared Rapier world builder (no Babylon/DOM/DB imports)
packages/protocol  Protocol version, message names, zod validators, Colyseus state schema
database/migrations PostgreSQL schema
deploy/            Dockerfile, Compose, Nginx example, env template
scripts/           migrate, backup, restore, smoke helpers
tests/e2e          Playwright multi-client tests
docs/              Plan, architecture, protocol, controls, known limitations
```

Packages export TypeScript source under a `source` export condition (used by Vite, Vitest and
`tsx` in development) and compiled `dist/` JavaScript as the default (used by the production
Node server).

## Stage 1 — real multiplayer interaction slice (building now)

Goal: desktop and touch clients share one authoritative kitchen and complete a cheeseburger.

1. **Shared rules** (`packages/simulation`, `packages/data`)
   - Fictional cooking curves: per-side surface browning, internal progress, burn, moisture,
     warmth/cooling, cheese melt, bun toast. Flipping swaps which side gets direct heat.
   - Recipe evaluation with explicit scoring weights and specific feedback strings.
   - Movement rules and a Rapier world builder used by both the server and client prediction.
   - Interaction rules: reach (1.8 m), line of sight, placement validation, grab arbitration.
2. **Protocol** (`packages/protocol`)
   - Colyseus schema for players, items, burger layers, grill knobs, tickets, restaurant.
   - Cooking values quantised to `uint8` so patches only go out when the visible state changes.
   - zod validators for every client message; protocol version checked at join.
3. **Server room** (`apps/server`)
   - Private room whose room ID *is* the 6-character join code (no second registry).
   - 60 Hz fixed step, 20 Hz patches, bounded per-player input queue (max 12 samples), stale
     input cleared after 250 ms, no unbounded catch-up.
   - Rapier: static restaurant colliders, kinematic character capsules, loose items as dynamic
     bodies, held items kinematic and reach-clamped.
   - Intents: input, grab, release/place, set-down, knob, tool use (slide/flip/squeeze),
     dispense from bins, open shift, serve. Every intent validated for identity, reach, LOS,
     ownership, revision and allowed transition; command IDs deduplicated.
   - Contested grabs resolved by the room's serial message order plus revision check: exactly
     one owner.
   - Orders: ticket rail with numbered orders; serving at the pickup shelf evaluates the tray
     and credits payment exactly once through the store (idempotency key per order).
4. **Client** (`apps/client`)
   - HTML menus: name, create room, join by code, settings, reconnect/error overlays.
   - Babylon WebGL2 scene (WebGPU only behind a capability check, falling back to WebGL2).
   - First-person camera, pointer lock on desktop with graceful denial, drag-to-look on touch.
   - Unified Pointer Events input: desktop bindings (remappable), touch stick/look/buttons,
     toggle-to-hold, cancel/lost-capture handling, input cleared on blur/background.
   - Local movement prediction with the shared Rapier motor + server reconciliation; remote
     players and items interpolated ~100 ms behind.
   - Food appearance driven only by replicated cooking state.
   - Procedural placeholder geometry/materials (allowed for early layout by spec §11).
   - Web Audio: positional grill sizzle that follows cooking state; unlock on first tap.
5. **Tests**: Vitest rule/protocol tests; Colyseus room tests (join, move, contested grab,
   handoff, flip, assemble, serve-once, duplicate command, capacity race); Playwright with a
   desktop context and an iPad-emulated touch context in one room.

## Stage 2 — persistence and recovery (foundations in this pass)

- Guest profiles with server-generated HMAC credentials; recovery code export.
- PostgreSQL schema: profiles, restaurants (owner, version, balance, stock, upgrades),
  restaurant permissions, leases with fencing tokens, checkpoints, sales (unique per order),
  economic events, command log, schema migrations.
- `Store` interface with in-memory (dev/test) and PostgreSQL implementations.
- Sales committed in one transaction (order record + balance + event); duplicates return the
  original result; acknowledgment after commit.
- Checkpoint every 15 s and at shift boundaries; restore skips orders already paid.
- Room lifecycle: creator leaving keeps the shift running; admin passes to the longest-connected
  player; empty room stops simulating at once, persists, keeps reconnect state 60 s, unloads.
- Solo pause through a server-approved request; co-op pause by unanimous vote; resume with a
  visible countdown.

## Stage 3 — visual benchmark (not started; needs authored assets)

Hero assets (hands, grill, food, tools) authored in Blender as GLB with PBR maps; asset
manifest; reflection probes; baked lighting; audio library. Placeholders are marked as such in
code (`placeholder` mesh metadata) so they can be audited before the milestone is called done.

## Stage 4 — restaurant shift (partially scaffolded)

Customers with queue reservations, fries, drinks, cleaning, stock purchasing, upgrades,
ledger UI, double/mushroom burgers, modifiers, player-count pacing.

## Stage 5 — release hardening

Accessibility pass, tutorials, graphics presets, **physical iPad Safari tests**, latency/load
tests, backups and restore drills, deployment docs, recoverable failure UIs.

## Deployment (scaffolded in this pass)

Multi-stage Dockerfile (Node 24), Compose with game + Postgres + one-shot migrate service,
loopback-only port 2567, Nginx site example for `game.` and `realtime.` hosts, env template,
backup/restore scripts.

## Things this environment cannot verify

- Physical iPad and two-network tests, VPS deployment, real performance numbers on reference
  hardware, finished art. These are listed in `docs/KNOWN_LIMITATIONS.md` and must be done
  before the matching acceptance items in spec §18 are claimed.
