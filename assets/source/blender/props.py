"""Interactive and stocked props the client animates or swaps at runtime: grill knob, chiller
drawer with raw patties, ingredient pans filled with the real food models, tray stack, wall
toggle and the neon OPEN sign. Positions are item-local; the client places them from the
shared layout (packages/data DISPENSERS, CHILLER_DRAWER, GRILL_ZONES, SHIFT_SWITCH).

    python assets/source/blender/props.py [--preview]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(__file__))

import bpy  # noqa: E402

import food  # noqa: E402
from ahb import bl, kit  # noqa: E402
from ahb.kit import aabb  # noqa: E402
from ahb.library import ART, BUILD, ROOT, font  # noqa: E402

LAYOUT = json.load(open(os.path.join(ROOT, "assets", "source", "layout.json")))


def knob(m) -> bpy.types.Object:
    """Fluted phenolic control knob; axis along game Z, face toward -Z, pointer up at rest."""
    prof = [(0.0, 0.0), (0.031, 0.0), (0.035, 0.004), (0.035, 0.012), (0.03, 0.016), (0.027, 0.03), (0.024, 0.036), (0.0, 0.037)]
    k = bl.lathe("knob_body", prof, (0, 0, 0), m["phenolic"], segments=48)
    # Grip flutes around the skirt.
    flutes = []
    for i in range(16):
        a = i / 16 * 2 * math.pi
        f = bl.cylinder(f"knob_flute_{i}", (math.cos(a) * 0.0335, 0.009, math.sin(a) * 0.0335), 0.0035, 0.012, m["phenolic"], segments=10)
        flutes.append(f)
    body = bl.join([k, *flutes], "knob")
    # Pointer fin across the face.
    fin = aabb("knob_fin", -0.005, 0.03, -0.022, 0.005, 0.046, 0.022, m["phenolic"], bevel=0.003, cull_bottom=False)
    line = aabb("knob_line", -0.0012, 0.0461, 0.0, 0.0012, 0.0465, 0.021, m["white_print"], cull_bottom=False)
    o = bl.join([body, fin, line], "knob")
    # Lathe axis is game +Y; turn it so the knob faces -Z with the pointer up.
    o.rotation_euler = (-math.pi / 2, 0, 0)
    bl.transform_apply(o)
    o.location = (0, 0, 0)
    return o


def hotel_pan(name: str, w: float, d: float, depth: float, m) -> bpy.types.Object:
    """Stainless steam-table pan with a rolled lip, open top; origin at lip centre."""
    t = 0.0012
    parts = [
        aabb(f"{name}_floor", -w / 2 + 0.01, -depth, -d / 2 + 0.01, w / 2 - 0.01, -depth + t, d / 2 - 0.01, m["steel"], cull_bottom=False, uv=0.4),
    ]
    for side, (x0, z0, x1, z1) in {"n": (-w / 2, d / 2 - t, w / 2, d / 2), "s": (-w / 2, -d / 2, w / 2, -d / 2 + t), "e": (w / 2 - t, -d / 2, w / 2, d / 2), "w": (-w / 2, -d / 2, -w / 2 + t, d / 2)}.items():
        parts.append(aabb(f"{name}_wall_{side}", x0, -depth, z0, x1, 0.0, z1, m["steel"], cull_bottom=False, uv=0.4))
    lip = bl.tube(f"{name}_lip", [(-w / 2, 0.0, -d / 2), (w / 2, 0.0, -d / 2), (w / 2, 0.0, d / 2), (-w / 2, 0.0, d / 2), (-w / 2, 0.0, -d / 2)], 0.004, m["steel"])
    parts.append(lip)
    for p in parts:
        bl.ensure_uv(p)
    return bl.join(parts, name)


def scatter(src: bpy.types.Object, name: str, placements: list[tuple[tuple[float, float, float], tuple[float, float, float]]]) -> list[bpy.types.Object]:
    """Linked duplicates (glTF instances) of a food model at (position, euler) placements."""
    out = []
    for i, (pos, rot) in enumerate(placements):
        o = bpy.data.objects.new(f"{name}_{i}", src.data)
        bl.link(o, None)
        o.location = bl.G(*pos)
        o.rotation_euler = rot
        out.append(o)
    return out


def fills(foods: dict, m) -> dict[str, list[bpy.types.Object]]:
    """Ingredient piles keyed by dispenser id; positions relative to the dispenser centre top."""
    rnd = random.Random(7)
    result: dict[str, list[bpy.types.Object]] = {}
    for d in LAYOUT["DISPENSERS"]:
        kind, did = d["kind"], d["id"]
        hx, hy, hz = d["half"]
        if kind in ("tray", "cup", "fries") or d.get("requiresDrawer") is not None:
            continue
        w, dd = hx * 2 - 0.006, hz * 2 - 0.006
        # Island topping rail is shallow (the pans sit on the worktop); the prep rail is deep.
        depth = 0.065 if d["center"][2] > 3 else 0.03
        objs = [hotel_pan(f"pan_{did}", w, dd, depth, m)]
        base = -depth + 0.004
        src = foods.get(kind)
        P: list = []
        if kind in ("bun_bottom", "bun_top"):
            # Two stacks of halves, cut face down for tops / up for bottoms.
            for col in (-1, 1):
                for k in range(3):
                    x = col * w * 0.24 + rnd.uniform(-0.004, 0.004)
                    z = rnd.uniform(-0.006, 0.006) + (k - 1) * 0.0
                    y = base + 0.016 + k * (0.033 if kind == "bun_bottom" else 0.046)
                    P.append(((x, y - 0.03 if kind == "bun_top" else y - 0.012, z + (k - 1) * 0.1), (0, 0, rnd.uniform(0, 6.28))))
        elif kind in ("cheese", "swiss"):
            for k in range(14):
                P.append(((rnd.uniform(-0.01, 0.01), base + 0.004 + k * 0.0032, rnd.uniform(-0.012, 0.012) + (0.05 if k % 2 else -0.05)), (0, 0, rnd.uniform(-0.15, 0.15))))
        elif kind == "lettuce":
            for k in range(9):
                P.append(((rnd.uniform(-w * 0.25, w * 0.25), base + 0.01 + k * 0.004, rnd.uniform(-dd * 0.28, dd * 0.28)), (rnd.uniform(-0.35, 0.35), rnd.uniform(-0.35, 0.35), rnd.uniform(0, 6.28))))
        elif kind == "tomato":
            for row in range(4):
                for k in range(3):
                    P.append(((-w * 0.28 + k * w * 0.28, base + 0.008 + row * 0.004 + k * 0.002, -dd * 0.32 + row * dd * 0.21), (0.35, 0, rnd.uniform(0, 6.28))))
        elif kind == "onion":
            for k in range(10):
                P.append(((rnd.uniform(-w * 0.25, w * 0.25), base + 0.006 + k * 0.003, rnd.uniform(-dd * 0.3, dd * 0.3)), (rnd.uniform(-0.25, 0.25), rnd.uniform(-0.25, 0.25), rnd.uniform(0, 6.28))))
        elif kind in ("pickle", "jalapeno", "mushroom"):
            for k in range(7):
                P.append(((rnd.uniform(-w * 0.2, w * 0.2), base + 0.005 + k * 0.003, rnd.uniform(-dd * 0.2, dd * 0.2)), (rnd.uniform(-0.3, 0.3), rnd.uniform(-0.3, 0.3), rnd.uniform(0, 6.28))))
        elif kind == "bacon":
            # Strips laid lengthwise across the pan width, slightly shingled.
            for k in range(7):
                P.append(((rnd.uniform(-0.006, 0.006), base + 0.004 + k * 0.0035, -dd * 0.3 + (k % 4) * dd * 0.2), (0, 0, rnd.uniform(-0.05, 0.05))))
        elif kind == "egg":
            # Whole eggs nested in the pan.
            shell = bl.lathe("egg_shell", [(0.0, -0.028), (0.014, -0.025), (0.0205, -0.012), (0.021, 0.002), (0.018, 0.016), (0.011, 0.026), (0.0, 0.03)], (0, 0, 0), m["eggshell"], segments=24, smooth_angle=80)
            bl.ensure_uv(shell)
            src = shell
            for i in range(2):
                for j in range(2):
                    P.append(((-w * 0.22 + i * w * 0.44, base + 0.022, -dd * 0.2 + j * dd * 0.4), (math.pi / 2, 0, rnd.uniform(0, 6.28))))
        if src is not None and P:
            objs += scatter(src, f"fill_{did}", P)
        result[did] = objs
    return result


def drawer(foods: dict, m) -> list[bpy.types.Object]:
    """Chiller drawer: front, pull bar and a pan of raw patties on paper (beef | veggie)."""
    dr = LAYOUT["CHILLER_DRAWER"]
    hx, hy, hz = dr["half"]
    parts = [aabb("drawer_front", -hx, -hy - 0.03, -0.015, hx, hy + 0.03, 0.015, m["steel"], bevel=0.006, cull_bottom=False, uv=0.4)]
    parts.append(aabb("drawer_gasket", -hx + 0.01, -hy - 0.02, 0.015, hx - 0.01, hy + 0.02, 0.018, m["rubber"], cull_bottom=False))
    parts.append(bl.tube("drawer_pull", [(-hx * 0.7, 0.04, -0.015), (-hx * 0.7, 0.04, -0.045), (hx * 0.7, 0.04, -0.045), (hx * 0.7, 0.04, -0.015)], 0.011, m["chrome"]))
    tub = hotel_pan("drawer_tub", hx * 2 - 0.04, hz * 2, 0.16, m)
    tub.location = bl.G(0, 0.05, hz + 0.015)
    bl.transform_apply(tub)
    parts.append(tub)
    out = [*parts]
    rnd = random.Random(3)
    disp = [d for d in LAYOUT["DISPENSERS"] if d.get("requiresDrawer") is not None]
    for d in disp:
        lx = d["center"][0] - dr["handle"][0]
        src = foods["veggie_patty" if d["kind"] == "veggie_patty" else "patty"]
        paper = aabb(f"paper_{d['id']}", lx - 0.17, 0.0, 0.05, lx + 0.17, 0.0015, hz * 2 - 0.02, m["paper"], cull_bottom=False, uv=1.0)
        out.append(paper)
        P = []
        for row in range(4):
            for col in range(2):
                P.append(((lx - 0.06 + col * 0.12 + rnd.uniform(-0.004, 0.004), 0.014, 0.11 + row * 0.12 + rnd.uniform(-0.004, 0.004)), (0, 0, rnd.uniform(0, 6.28))))
        out += scatter(src, f"drawer_{d['kind']}", P)
    return out


def tray_stack(foods: dict) -> list[bpy.types.Object]:
    rnd = random.Random(5)
    P = [((rnd.uniform(-0.003, 0.003), -0.03 + i * 0.013, rnd.uniform(-0.003, 0.003)), (0, 0, rnd.uniform(-0.02, 0.02))) for i in range(6)]
    return scatter(foods["tray"], "tray_stack", P)


def wall_switch(m) -> tuple[bpy.types.Object, bpy.types.Object]:
    plate = aabb("switch_plate", -0.06, -0.08, -0.008, 0.06, 0.08, 0.0, m["plate"], bevel=0.004, cull_bottom=False, uv=0.2)
    for y in (-0.06, 0.06):
        plate = bl.join([plate, bl.cylinder(f"screw_{y}", (0, y, -0.009), 0.004, 0.002, m["chrome"], axis="z", segments=12)], "switch_plate")
    boss = bl.cylinder("switch_boss", (0, 0, -0.012), 0.012, 0.008, m["chrome"], axis="z", segments=20)
    plate = bl.join([plate, boss], "switch_plate")
    lever = bl.lathe("switch_lever", [(0.0, 0.0), (0.006, 0.0), (0.0045, 0.05), (0.006, 0.056), (0.0, 0.06)], (0, 0, 0), m["chrome"], segments=16)
    # Lever axis along -Z (toward the player); the client tilts it up/down.
    lever.rotation_euler = (-math.pi / 2, 0, 0)
    bl.transform_apply(lever)
    label = bl.text("switch_label", "OPEN SIGN", font("InterDisplay-Bold.otf"), 0.022, m["white_print"], extrude=0.0005)
    kit.orient(label, (0, 0, -1), at=(0.0, 0.105, -0.001))
    bl.transform_apply(label)
    backing = aabb("switch_label_bg", -0.075, 0.09, -0.0008, 0.075, 0.12, 0.0, m["phenolic"], cull_bottom=False)
    plate = bl.join([plate, backing, label], "switch_plate")
    return plate, lever


def open_sign(m) -> list[bpy.types.Object]:
    """Window neon: 'OPEN' in a red tube with a blue border, on a clear backer with chains."""
    from dining import neon_text

    # Reads correctly from the street (-Z); staff inside see it mirrored, like real window neon.
    text = neon_text("neon_open", "OPEN", "InterDisplay-Light.otf", 0.3, (1.0, 0.2, 0.25), 30.0, (0, 0, 0), (0, 0, -1), tube=0.006)
    pts = [(-0.56, -0.18, 0.0), (0.56, -0.18, 0.0), (0.56, 0.18, 0.0), (-0.56, 0.18, 0.0), (-0.56, -0.18, 0.0)]
    border = bl.tube("neon_open_border", pts, 0.0045, kit.emitter("neon_open_border", (0.3, 0.6, 1.0), 26.0))
    backer = aabb("open_backer", -0.6, -0.21, 0.01, 0.6, 0.21, 0.016, m["acrylic"], cull_bottom=False)
    chain_l = bl.tube("open_chain_l", [(-0.5, 0.21, 0.013), (-0.5, 0.55, 0.013)], 0.002, m["chrome"])
    chain_r = bl.tube("open_chain_r", [(0.5, 0.21, 0.013), (0.5, 0.55, 0.013)], 0.002, m["chrome"])
    transformer = aabb("open_transformer", -0.08, -0.26, 0.016, 0.08, -0.21, 0.044, m["phenolic"], bevel=0.004, cull_bottom=False)
    return [text, border, bl.join([backer, chain_l, chain_r, transformer], "open_frame")]


def materials() -> dict:
    from ahb.library import material

    return {
        "steel": material("steel"),
        "chrome": bl.solid("chrome", (0.86, 0.87, 0.89), 0.06, 1.0),
        "rubber": bl.solid("rubber", (0.04, 0.04, 0.04), 0.85),
        "phenolic": bl.solid("phenolic", (0.025, 0.025, 0.027), 0.32),
        "white_print": bl.solid("white_print", (0.92, 0.92, 0.9), 0.5),
        "paper": bl.solid("butcher_paper", (0.93, 0.9, 0.84), 0.85),
        "plate": bl.solid("switch_plate_white", (0.9, 0.89, 0.86), 0.3),
        "eggshell": bl.solid("eggshell", (0.86, 0.66, 0.48), 0.55),
        "acrylic": bl.solid("acrylic", (0.9, 0.92, 0.95), 0.05, alpha=0.18),
    }


def lod(src: bpy.types.Object, ratio: float) -> bpy.types.Object:
    """Reduced-detail copy for stocked food seen at arm's length or further."""
    o = bl.duplicate(src, f"{src.name}_lod")
    dec = o.modifiers.new("dec", "DECIMATE")
    dec.ratio = ratio
    bl.apply_modifiers(o)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def build() -> list[bpy.types.Object]:
    hero = {o.name: o for o in food.build()}
    # Stocked items reuse the hero meshes at about a third of the polygons.
    foods = {name: (lod(o, 0.32) if name not in ("tray",) else o) for name, o in hero.items()}
    # Food templates stay in the file only as instance sources: park them out of sight.
    for o in list(hero.values()) + list(foods.values()):
        o.hide_render = True
        o.location = (0, 0, -50)
    m = materials()
    out: list[bpy.types.Object] = []
    k = knob(m)
    out.append(k)
    dr = drawer(foods, m)
    root = bpy.data.objects.new("drawer", None)
    bl.link(root, None)
    for o in dr:
        o.parent = root
    out += [root, *dr]
    for did, objs in fills(foods, m).items():
        r = bpy.data.objects.new(f"bin_{did}" if not did.startswith("bin_") else did, None)
        bl.link(r, None)
        for o in objs:
            o.parent = r
        out += [r, *objs]
    ts = bpy.data.objects.new("tray_stack", None)
    bl.link(ts, None)
    for o in tray_stack(foods):
        o.parent = ts
        out.append(o)
    out.append(ts)
    plate, lever = wall_switch(m)
    out += [plate, lever]
    sign = bpy.data.objects.new("open_sign", None)
    bl.link(sign, None)
    for o in open_sign(m):
        o.parent = sign
        out.append(o)
    out.append(sign)
    for o in out:
        if o.type == "MESH":
            bl.ensure_uv(o)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true")
    args = ap.parse_args([a for a in sys.argv[1:] if a != "--"])
    bl.reset()
    objs = build()
    if args.preview:
        os.makedirs(os.path.join(BUILD, "preview"), exist_ok=True)
        hdr = os.path.join(BUILD, "probe_kitchen.hdr")
        if os.path.exists(hdr):
            food.world_hdr(hdr, 1.0)
        by = {o.name: o for o in objs}
        lay = {"bin_bin_bun_bottom": (-0.6, 0), "bin_bin_cheese": (-0.2, 0), "bin_bin_lettuce": (0.2, 0), "bin_bin_tomato": (0.6, 0), "bin_bin_bacon": (-0.4, 0.45), "bin_bin_egg": (-0.1, 0.45), "bin_bin_pickle": (0.2, 0.45), "drawer": (0.0, -0.6), "knob": (0.6, 0.45), "switch_plate": (0.8, 0.45), "open_sign": (0.0, 0.9)}
        for name, (x, z) in lay.items():
            o = by.get(name) or by.get(name.replace("bin_bin_", "bin_"))
            if o:
                o.location = bl.G(x, 0.1, z)
        kit.area_light("key", (0.0, 1.6, -0.4), (1.2, 0.8), 160.0, (1.0, 0.95, 0.88), facing=(0, -1, 0.3), up=(0, 0, 1))
        bl.camera("cam", (0.0, 1.1, -1.4), (0.0, 0.0, 0.1), lens=30)
        bl.render(os.path.join(BUILD, "preview", "props.jpg"), width=1280, height=720, samples=96, exposure=1.0)
        return
    bl.export_gltf(os.path.join(ART, "props.gltf"), objs, image_format="WEBP", quality=86)
    print("[props] exported", ART)


if __name__ == "__main__":
    main()
