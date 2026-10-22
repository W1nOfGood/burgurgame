# Known limitations

Honest status against the specification. Nothing below is claimed as done.

## Not verified (needs real hardware or infrastructure)

- **Physical iPad testing** has not happened. Touch controls are tested only with Chromium touch
  emulation (Playwright, iPad-sized viewport). The spec requires physical iPad Safari testing, a
  documented minimum iPad model and iPadOS/Safari version, a standard non-Pro iPad and an
  M-series iPad in the matrix. WebKit was not available in the build environment.
- **Performance numbers** are not measured on reference hardware. Development screenshots ran
  on software rendering (SwiftShader); the medium preset measured ~150 draw calls there, which
  says nothing about frame rate on real GPUs or iPads.
- **VPS deployment** has not been performed on your server. The Docker image, Compose stack,
  migrations, health checks, backup and a restore into a clean database were exercised locally.
  The Nginx/DirectAdmin configuration is an example to validate on the real host.
- **Two independent networks**, latency/jitter/packet-loss tests and **multi-room load tests**
  have not been run, so no player or room capacity is promised. `MAX_ROOMS` defaults to 20 as a
  conservative guard until measured.

## Not built yet

- **Stage 3 visual benchmark:** all art is procedural placeholder. No authored GLB hero assets,
  rigged hands or characters, baked lighting, or recorded audio. Metal reflections use a
  runtime reflection probe on desktop presets only.
- **Stage 4:** customers (NPCs, queueing), fries, drinks, cleaning/spills, stock purchasing UI,
  upgrades, decoration, the in-world office catalog/ledger (the ledger appears as an overlay at
  shift end; purchases exist in the store API only).
- **Persistence gaps:** restored kitchens get a new room code (the old code is not reserved);
  account linking for cross-device recovery beyond the guest recovery code; save import.
- **Accessibility:** subtitles setting exists but there is no voiced speech yet; no full
  screen-reader pass of the 3D view; colour-blind review of food states not done.
- **WebGPU** is an untested opt-in (falls back to WebGL2).
- **Optional standalone practice mode** (offline, IndexedDB) is not implemented.
- **Voice chat** is out of scope (text pings only).

## Design simplifications to revisit after playtests

- Players do not collide with each other (smoother prediction); items do not push players.
- Held items pass through other items while carried.
- Cheese that hasn't touched a hot patty is not penalised for being unmelted.
- Ingredient stock decrements are part of the 15 s checkpoint, not individual transactions
  (sales and purchases are transactional).
- The sauce stock is shared by all five sauces.
