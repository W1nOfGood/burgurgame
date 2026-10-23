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
- **Two independent networks** and **multi-room load tests** have not been run, so no player
  or room capacity is promised. `MAX_ROOMS` defaults to 20 as a conservative guard until
  measured. Long-route latency and jitter (a Thailand client on a US server) are covered by
  simulated tests of the server input queue and the client interpolation, not by play over a
  real intercontinental link. Everything you do still waits one round trip for the server's
  answer; a server in your region (Singapore for Thailand) is the real fix for that.

## Not built yet

- **Art is authored by code, not by hand.** Every model, texture and bake is produced by the
  Blender scripts in `assets/source/blender` (procedural modelling, numpy-synthesised PBR
  textures, signed-distance sculpting). There is no photogrammetry, scanned material library or
  hand sculpting; fine organic detail (food surfaces, cloth folds, faces) is good at game
  distance but does not hold up to extreme close-ups the way scanned assets would.
- **Characters** are stylised-real: realistic proportions, but teammates wear caps and
  food-safety masks rather than showing a fully modelled face, and the rig is driven
  procedurally (walk, reach, crouch, look, finger curl) — there are no motion-captured or
  keyframed clips, no facial animation and no cloth simulation. The teammate is the weakest
  model: fine at gameplay distance, but close up the shirt/skin split leaves jagged sleeve hems
  and the apron creases unnaturally. First-person hands have no
  wrist joint: each forearm is aimed at its shoulder and the hand follows it.
- **Grilled onion** keeps its raw look; only patties, buns, bacon, mushrooms and egg white
  have cooked textures.
- **Lighting is static.** Global illumination, AO and reflections are baked for the night
  layout; moving equipment in `packages/data` requires rebuilding the restaurant. Dynamic
  objects get one real-time key light with shadows plus the probes, so they never bounce
  light onto the room, and reflections in steel/glass do not show moving players or food.
- **Recorded audio** has not been produced: sound is still Web Audio synthesis.
- **Art on real GPUs** has only been reviewed in software-rendered (SwiftShader) captures and
  Cycles previews; colour, exposure and texture density need a pass on calibrated displays and
  on an iPad.
- **Customers** walk in, order at the counter and collect their food, but they do not queue
  behind each other (each takes a free counter spot; with every spot taken, nobody new comes
  in until one frees), do not sit down to eat, do not react to a refused burger beyond the
  toast, and walk through other people rather than around them.
- **Stage 4:** fries, drinks, cleaning/spills, stock purchasing UI,
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
