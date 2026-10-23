# Asset pipeline

All art in the game is authored by code in `assets/source/blender/` and built with headless
Blender (the `bpy` 5.2.3 Python module). Nothing is hand-placed in a GUI, so every asset can be
rebuilt, reviewed in a diff and changed in the same pull request as the gameplay it depends on.

```
assets/source/
  layout.json          shared layout exported from packages/data (do not edit by hand)
  fonts/               signage fonts (Inter, DejaVu Serif, JetBrains Mono) + LICENSES.txt
  blender/
    ahb/texgen.py      tileable PBR materials: tile, steel, wood, plaster, terrazzo, street...
    ahb/foodtex.py     food texture sets: raw/cooked/progress maps (beef, bun, bacon...)
    ahb/graphics.py    posters, soda-fountain lightbox, box/can labels, screens (Pillow)
    ahb/bl.py          Blender helpers: coordinates, meshes, materials, UVs, baking, export
    ahb/kit.py         game-space modelling kit (boxes by extents, quads, lights, emitters)
    ahb/sdf.py         signed-distance sculpting + marching cubes + distance skinning
    restaurant.py      shell, storefront, lights, bake and export (+ kitchen.py, dining.py,
                       exterior.py for the contents)
    food.py            food, tools and service items (item-local, per ITEMS shapes)
    props.py           knobs, drawer, stocked pans, tray stack, switch, neon OPEN sign
    characters.py      rigged first-person hands
    people.py          the line cook (teammates) and six walk-in customers, dressed and rigged
    build.py           runs the targets in order
```

## Building

```bash
# One-time: a Python 3.13 environment with the asset dependencies
python3.13 -m venv .venv-assets
.venv-assets/bin/pip install bpy==5.2.3 numpy scipy pillow pyoidn==2.5.1.0 scikit-image==0.26.0

ASSET_PYTHON=.venv-assets/bin/python npm run assets         # everything (~85 min on 4 cores)
ASSET_PYTHON=.venv-assets/bin/python npm run assets:fast    # half-res, low-sample bake
ASSET_PYTHON=.venv-assets/bin/python sh scripts/assets.sh food props   # selected targets
```

Targets: `layout` (export `packages/data` to `layout.json`), `restaurant` (model, bake, export),
`env` (convert the HDR probes to Babylon `.env` in headless Chromium), `food`, `props`,
`characters`, `people`. Every target also has a `--preview` mode (`python restaurant.py --preview`) that
renders denoised Cycles look-development shots into `assets/build/preview/` with the same ACES
tone mapping the game uses. Intermediate files (texture sets, probes, previews) live in
`assets/build/` and are not committed.

The shipped art in `apps/client/public/art/` is committed so the game runs without Blender:

```
art/
  restaurant.gltf/.bin   food.gltf/.bin   props.gltf/.bin   hands.gltf/.bin   crew.gltf/.bin
  customer_<look>.gltf/.bin   one per customer look (student, office, nurse, worker, coat, varsity)
  textures/              WebP texture sets shared by every glTF (one download, one GPU copy)
  restaurant/            restaurant.json, lm_*/ao_* lightmaps, probe_*.env
  food/                  cooked textures and progress maps loaded by the cooking shader
```

Every glTF sits at the root so its texture URIs (`textures/steel_albedo.webp`) stay inside its
own folder: Babylon's loader rejects URIs containing `..`, and `tests/assets.test.ts` checks
for it. `optimize.py` (the last build target) caps texture sizes for tablet GPU memory.

## How the restaurant is lit

1. **Modelled to the layout.** Every collision box in `packages/data/src/layout.ts` has a
   dressed counterpart (`kitchen.py`, `dining.py`): the server and client prediction keep using
   the boxes, the art only has to agree with them. If you move a box, rebuild the restaurant.
2. **Night lighting in Cycles.** LED troffers, hood lamps, the amber heat lamp, warm pendants,
   picture lights, neon, the menu light box and sodium street lights are real area/spot/point
   lights or emissive meshes.
3. **Lightmaps.** Static geometry is joined per region (kitchen, dining, exterior), unwrapped
   to a shared second UV set and baked: diffuse *irradiance only* (no albedo) plus ambient
   occlusion, denoised with Intel Open Image Denoise's lightmap filter, dilated past island
   edges and stored as sRGB WebP with a scale factor in `restaurant.json`. Tiny parts, bare
   metal and transparent surfaces are left unbaked and lit at runtime.
4. **Reflection probes.** Six 90° faces are rendered at the centre of the kitchen and of the
   dining room, assembled into an equirectangular HDR in Babylon's convention and converted to
   prefiltered `.env` files by `scripts/make-env.mjs` (Babylon itself in headless Chromium).

In the client (`apps/client/src/game/environment.ts`):

- Each baked material gets its region's lightmap on UV2. The single key light uses
  `Light.LIGHTMAP_SHADOWSONLY`, which makes Babylon add `lightmap × shadow` to the diffuse
  term: baked irradiance is multiplied by the full-resolution albedo, and food or players still
  cast real-time shadows onto baked counters.
- A small material plugin removes the probe's diffuse irradiance from those materials (the
  lightmap already holds all diffuse light); the probe still supplies box-projected
  reflections, occluded by the baked AO.
- Other dynamic lights exclude baked meshes. Dynamic objects (food, tools, players, hands) are
  lit by the key light, the kitchen probe as image-based light, and local accents.
- If any of this fails to load, the procedural restaurant is used instead.

## Food and cooking state

`food.py` builds each item at its physics size with its origin at the shape centre. Cookable
materials (`food_patty`, `food_bun_crumb`, `food_bacon`, `food_mushroom`, `food_egg_white`)
ship with a cooked texture and a *progress* map; `apps/client/src/game/food.ts` attaches a
shader plugin that blends raw → cooked where `progress < doneness` (so browning starts on the
high strands and edges and spreads), picks top/bottom/edge doneness from the surface normal
relative to the item's own up axis (a flipped patty shows its seared side), darkens toward
char with burn and dulls dropped food. Cheese melt is a vertex drape. Appearance stays a pure
function of the replicated values.

## Characters

Hands and people are sculpted as signed-distance fields (tapered phalanges, knuckle and joint
bulges, palm pads, smooth blends only where anatomy blends), polygonised with marching cubes,
decimated, and skinned by distance to bone segments with rules that stop neighbouring fingers
or legs from sharing weights.

`people.py` builds one parametric adult per `Spec` (sex, height, build, skin, hair, beard,
hat, garments) on a shared skeleton: skull, brows, cheekbones and jaw; eyeballs behind
almond-shaped lids; nose, lips on the dental arch, ears; shoulders that slope down to the
acromion. Clothes are shells around the body with folds sculpted in (tops hang straight past
the hips and over the trousers; hats are fitted to the skull clear of the hair), and the body
keeps only the skin that shows. Hair and beards are shells that thin out and dip under the skin
at the hairline, so the line is clean. Skin, hair and cloth are painted in texel space
(`ahb/skin.py`) and normals baked in Cycles. The crew member and the six customer looks share
the crew rig's bones, so teammates and customers are driven the same way. The client drives bones procedurally
(`apps/client/src/game/rig.ts`): each joint's flex axis is derived from the rest pose and
sign-checked against the direction its child should move, so no animation clips are needed for
grips, walking, reaching, crouching or looking.

## Budgets (measured on the current build)

| Asset | Triangles | Notes |
| --- | --- | --- |
| Restaurant (baked + unbaked) | 154 k | 6 nodes after joining by material and lightmap region |
| Food library | 36 k for 21 items + sauce drizzle | 0.4–6 k per item (sesame bun top is the largest) |
| Props | 19 k unique, 87 k drawn | pans hold instanced copies at 32 % detail |
| First-person hands | 19 k (both) | always visible |
| Crew member | 43 k | per teammate |
| Customers | 33–40 k | per look (six looks, loaded after you enter the kitchen) |

Download: 29 MB in total before gzip (restaurant 9.5 MB with its lightmaps, characters 13 MB —
hands 2, crew 2, the six customers 9 — textures 4 MB, food 2 MB). Customers stream in behind
stand-ins once the kitchen is open, so they never hold up joining. Estimated GPU texture memory
after `optimize.py`: 338 MB. Texture sets are 1024² for large surfaces and hero food, 512²
otherwise; people get 512² colour for faces and large garments and 128–256² for the rest. Lightmaps are 2048² (kitchen, dining) and
1024² (exterior); AO maps are half size. The full-quality bake takes about 80 minutes on four
CPU cores (Cycles, 384 samples); `--fast` takes about 5.
