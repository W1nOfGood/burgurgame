# Architecture

## Overview

```
 browser (desktop / iPad)                          VPS
 ┌────────────────────────────┐   HTTPS / WSS   ┌──────────────────────────────────────────┐
 │ Vite static client         │ ──────────────▶ │ Nginx (or panel web server)              │
 │  Babylon.js rendering      │                 │  game.*     → static client files        │
 │  input · prediction        │                 │  realtime.* → 127.0.0.1:2567 (all paths) │
 │  interpolation · audio     │                 ├──────────────────────────────────────────┤
 │  shared rules + Rapier     │                 │ game container (Node 24, Colyseus 0.18)  │
 └────────────────────────────┘                 │  RestaurantRoom per live kitchen         │
                                                │  Kitchen simulation @ 60 Hz + Rapier     │
                                                │  HTTP: /healthz /readyz /api/*           │
                                                ├──────────────────────────────────────────┤
                                                │ PostgreSQL 16 (private network, volume)  │
                                                └──────────────────────────────────────────┘
```

## Packages

- `packages/data` — plain data: layout boxes (shared by server collision, client prediction and
  client geometry), items, recipes, scoring weights, economy, tuning targets.
- `packages/simulation` — engine-independent rules: fictional cooking curves, recipe scoring,
  logical burger stacks, reach/line-of-sight/placement rules, the Rapier world builder and the
  kinematic player motor. No Babylon, DOM, database or server-only imports.
- `packages/protocol` — Colyseus `schema()` state, zod validators for every client message,
  protocol version, byte-quantisation of food state.
- `apps/server` — Colyseus room, the authoritative `Kitchen`, guest auth, HTTP routes, stores.
- `apps/client` — rendering, input, prediction/interpolation, UI, audio.

Packages export TypeScript under a `source` condition for dev tooling and compiled `dist/` for
the production server.

## Authority

The server owns positions, held items, stacks, cooking, orders, stock and money. Clients send
intents; every intent is validated for identity, reach (1.8 m + latency allowance), line of
sight against static geometry, ownership, item revision and the allowed transition before any
mutation. Room messages are processed serially, so the first valid grab of an item wins and
bumps its revision; a competing grab with the old revision is rejected — exactly one owner.

Discrete intents carry a client command id; the room caches results per session so retries are
idempotent. Continuous controls (knob, drawer, squeeze) send a target value; the server limits
their rate of change.

## Simulation timing

- 60 Hz fixed step (`setFixedTimestep`, bounded catch-up), 20 Hz state patches.
- Clients simulate movement locally at 60 Hz with the same Rapier build and motor and send
  ~30 input messages per second, each carrying the samples since the last (≤ 6). The server
  consumes one sample per tick per player with a small catch-up credit (bounded queue of 12;
  stale input cleared after 250 ms; no speed-up beyond real time on average).
- Each patch carries the last processed sequence (`ack`) and the player's velocity; the client
  resets its motor to the server state and replays unacknowledged samples. Small errors are
  smoothed; corrections over 0.5 m (teleports, restores) snap.
- Remote players and items are interpolated by server tick ~100 ms behind (delay adapts to
  observed underruns).
- Cooking values are quantised to bytes before replication, so patches are sent only when the
  visible state changes. Food appearance on clients is a function of those values only.

## Items and stacks

Burgers are logical stacks, not towers of rigid bodies: a physical root (tray, spatula or a loose
item) plus layers positioned by accumulated layer heights. Loose roots are Rapier dynamic bodies
(they fall, land on the floor and get marked dirty); held items have no body and follow the
holder's hand target, clamped against walls. Grill contact is derived from geometry each tick.

## Orders and payment

Tickets are created on the server at a pace scaled by connected players; recipes unlock in tiers
during a shift. A tray placed on the pickup shelf with a closed burger is evaluated against all
open tickets (best score wins), locked, and a sale is committed in one transaction — sale row
(unique per restaurant + order key), balance update, ledger event. The room acknowledges and
removes the food only after commit; a duplicate commit returns the original sale. On failure the
tray is unlocked and nothing is handed over.

## Persistence and lifecycle

- Guest identity: server-generated profile id with an HMAC signature, stored on the device and
  usable as a recovery code. Never put in room metadata or logs.
- A room's id **is** its 6-character join code (private rooms, no second registry). Codes locate
  rooms; ownership of a saved restaurant belongs to its profile. Opening a restaurant requires
  ownership or an explicit staff permission.
- One live room may write a restaurant at a time: a database lease with a fencing epoch that
  every durable write checks.
- Checkpoints every 15 s and at shift end/room unload. If saves fail for longer than twice the
  interval the room pauses with "Saving unavailable" instead of silently widening the recovery
  window. Restoring skips orders and items that a committed sale already handed over.
- Creator leaving: the shift continues; admin passes to the longest-connected player. Dropped
  players keep their seat for 60 s; their held item is set down safely. An empty room stops
  simulating immediately, persists, and unloads after the reconnect window. Restored kitchens
  start paused.
- Pause: solo kitchens pause on request; co-op requires a unanimous vote; resume runs a 3 s
  countdown.

## Security

- Exact-origin CORS (credentialed only for the configured origin, as the SDK requires) and a
  WebSocket `Origin` check in `beforeUpgrade`.
- zod validation on every message; invalid messages are rejected without disconnecting;
  per-client intent rate limiting; WebSocket payload cap; HTTP rate limits on guest creation.
- Structured JSON logs with credential redaction; the Nginx example logs realtime requests
  without query strings (the SDK puts the auth token in the WebSocket URL).
- Test-only teleport hook exists only when `ENABLE_TEST_HOOKS=1`, which the server refuses in
  production.
