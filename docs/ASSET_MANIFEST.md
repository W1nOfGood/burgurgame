# Asset manifest

Every visual and audio asset currently in the game is generated procedurally in source code by
this project. There are no third-party models, textures, fonts or sound files, and no
attribution requirements. Production assets will be added here with source, author, permitted
use and attribution as they arrive (spec §11).

| Asset | Source | Author | Permitted use | Attribution |
| --- | --- | --- | --- | --- |
| Restaurant shell, counters, equipment (boxes merged per material) | `apps/client/src/game/scene.ts`, `props.ts` | This project | Apache-2.0 with the code | None |
| Surface textures (tile, plaster, timber, laminate, steel, street) | Canvas-painted, `materials.ts` | This project | Apache-2.0 | None |
| Food models and textures (patties, buns, cheese, vegetables, bacon, egg, mushrooms, sauces) | `items.ts`, `foodTextures.ts` | This project | Apache-2.0 | None |
| Signs, menu board, posters, tickets, labels | Canvas-drawn text, `scene.ts`, `props.ts` | This project | Apache-2.0 | None |
| Teammate avatars and first-person hands | Primitive meshes, `players.ts`, `hands.ts` | This project | Apache-2.0 | None |
| Sound (sizzle, ventilation, effects) | Web Audio synthesis, `audio.ts` | This project | Apache-2.0 | None |
| Favicon | `apps/client/public/favicon.svg` | This project | Apache-2.0 | None |
| UI fonts | System font stacks (no font files shipped) | — | — | — |

All meshes above carry `metadata.placeholder = true` so they can be audited before the Stage 3
visual benchmark is declared complete.
