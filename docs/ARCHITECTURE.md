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
  runs **every** sample a client simulated: on long routes input arrives in bursts after
  stalls, so the per-player queue holds 2 s (`NET.maxQueuedSamples`) and a long queue is worked
  off at up to 4 samples per tick. A per-player credit (one sample per tick, capped at the
  queue size) keeps any client from moving faster than real time.
- Player motors run in their own physics world that holds only the static kitchen, exactly
  the world the client predicts against, so the same inputs give bit-identical results on both
  sides (`apps/server/src/room/latency.test.ts`). Loose items live in the main world.
- Each patch carries the last processed sequence (`ack`), the player's position and velocity
  at full (64-bit) precision and its ground contact; the client resets its motor to exactly
  that state and replays unacknowledged samples, so a correction only appears when the server
  really did something else. (32-bit positions were off by up to 30 cm after a replay along a
  wall.) Small errors are smoothed; corrections over 0.5 m (teleports, restores) snap.
- Remote players and items are interpolated by server tick. The render delay is one patch
  interval plus the recent peak arrival jitter (100–500 ms, `NET.interpolationDelayMs` to
  `NET.maxInterpolationDelayMs`): it rises within a fraction of a second when patches start
  arriving late and eases back over seconds, so playback slows or speeds up slightly instead
  of freezing. A patch that is still late is covered by up to 100 ms of extrapolation, and the
  correction when it lands is faded in (`apps/client/src/net/interp.ts`).
- Your own pick-ups and put-downs are predicted: a grabbed item flies into your hand at once,
  and a placed or set-down item stays where you put it until the delayed view reaches the
  server patch that confirms it, then blends to the server's pose. A rejection undoes the
  prediction immediately.
- Cooking values are quantised to bytes before replication, so patches are sent only when the
  visible state changes. Food appearance on clients is a function of those values only.

## Supplies and money

The restaurant's balance moves only through the store: a sale credits it, and an order at the
office computer (`buy`: a supply line and 1–10 packs) debits it. The room checks the player is at
the monitor, then `Store.purchaseStock` pays and adds the packs in one transaction (keyed by
session and command id, so a retry never charges twice); the kitchen then adds the same quantity
to its live stock and takes the balance the store returned. Checkpoints write the kitchen's stock
back. Running out of a line fails grabs with "Out of …" until someone orders more.

## Items and stacks

Burgers are logical stacks, not towers of rigid bodies: a physical root (tray, spatula or a loose
item) plus layers positioned by accumulated layer heights. Loose roots are Rapier dynamic bodies
(they fall, land on the floor and get marked dirty); held items have no body and follow the
holder's hand target, clamped against walls. Grill contact is derived from geometry each tick.

## Customers, orders and payment

Every ticket belongs to a walk-in customer. At a pace scaled by connected players the server
sends a customer in from the street; they come through the front door and down a lane between
the dining tables to a free spot at the counter, and the ticket prints when they arrive (with
their name; recipes unlock in tiers during a shift). The walk is not streamed: `CustomerState`
replicates only the phase (`arriving`, `waiting`, `collecting`, `leaving`), the tick it started,
the counter spot and a look/name seed, and both sides rebuild the same rounded route from
`packages/data/src/customers.ts` and evaluate it at the current tick
(`packages/simulation/src/customers.ts`). Timelines are shifted on resume, so a pause freezes
them; closing waits for customers still walking in; a restored kitchen puts waiting customers
back at the counter.

A tray placed on the pickup shelf with a closed burger is evaluated against all open tickets
(best score wins), locked, and a sale is committed in one transaction — sale row (unique per
restaurant + order key), balance update, ledger event; a duplicate commit returns the original
sale, and on failure the tray is unlocked and nothing is handed over. After the commit the
customer steps to the shelf and takes the food: the stack stays on the locked tray until that
moment, then they leave carrying a takeaway bag. In a normal shift a customer who waits too long
leaves without their order.

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

## Rendering

- **Environment:** the restaurant is a Blender-built glTF with Cycles-baked irradiance and AO
  lightmaps (UV2) and box-projected `.env` reflection probes (`docs/ASSET_PIPELINE.md`). One
  key light in Babylon's `LIGHTMAP_SHADOWSONLY` mode applies the lightmaps and lets dynamic
  objects shadow baked surfaces; a material plugin drops probe irradiance from baked materials.
  Gameplay never depends on the art: layout boxes from `packages/data` remain the collision
  (server, prediction) and invisible pick proxies (client).
- **Food:** item visuals are clones of authored meshes with per-item materials; a shader
  plugin blends raw → cooked textures from the replicated cooking bytes (per-side browning,
  burn, dirt), so every client shows the same state without extra messages.
- **Characters:** skinned first-person hands, teammates and customers share one bone layout and
  are posed procedurally — hands from the grip, teammates from replicated input (movement, look
  pitch, crouch, holding), customers from their route pose (stride tied to distance walked, so
  feet don't slide; reach and carry at the shelf). The front door swings open as people pass.
- **Fallbacks:** each authored layer loads asynchronously; if it fails, the procedural stand-in
  stays (the game remains playable with no art files at all).
- **Presets:** tablet and low skip bloom, glow and SSAO and use smaller shadow maps; high adds
  SSAO, MSAA and sharpening.
