"""Texture budget pass over the built art (runs after the exports).

Decoded WebP textures cost width*height*4 bytes (+1/3 for mips) of GPU memory each, which
matters on iPad Safari. Normal and ORM maps carry low-contrast detail and are halved; small-
surface materials and signage are capped lower. Files are resized in place, so the glTFs
(which reference them by name) need no changes.

    python assets/source/blender/optimize.py
"""

from __future__ import annotations

import os
import sys

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
ART = os.path.join(ROOT, "apps", "client", "public", "art")

# Albedo of surfaces that fill the screen keep 1024; everything else caps lower.
HERO_ALBEDO = {"subway_white", "tile_green", "quarry", "checker", "steel", "steel_worn", "griddle", "oak", "terrazzo", "plaster_cream", "plaster_white", "beef_raw", "beef_seared", "bun_crust", "bun_crumb", "bun_toasted", "brick", "walnut_slats", "tray_liner"}


# First-person skin is on screen all the time and seen closest: full resolution colour and relief.
SKIN = {"skin_hand_albedo": 2048, "skin_hand_normal": 2048, "skin_hand_orm": 1024, "skin_hand_thickness": 512}


def cap_for(name: str) -> int:
    base = name.rsplit(".", 1)[0]
    if base in SKIN:
        return SKIN[base]
    for suffix in ("_albedo", "_normal", "_orm"):
        if base.endswith(suffix):
            mat = base[: -len(suffix)]
            if suffix == "_albedo":
                return 1024 if mat in HERO_ALBEDO else 512
            return 512
    if base in HERO_ALBEDO:
        return 1024
    if base.endswith("_normal") or base.endswith("_cook") or base.endswith("_rough"):
        return 512
    return 512


def main() -> None:
    before = after = 0
    for sub in ("textures", "food"):
        d = os.path.join(ART, sub)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if not f.endswith(".webp"):
                continue
            p = os.path.join(d, f)
            im = Image.open(p)
            w, h = im.size
            before += w * h * 4 * 4 // 3
            cap = cap_for(f)
            if max(w, h) > cap:
                k = cap / max(w, h)
                im = im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
                im.save(p, quality=88, method=6)
                w, h = im.size
            after += w * h * 4 * 4 // 3
    print(f"[optimize] GPU texture memory estimate {before / 2**20:.0f} MB -> {after / 2**20:.0f} MB")


if __name__ == "__main__":
    sys.exit(main())
