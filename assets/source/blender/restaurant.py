"""After Hours Burger — restaurant environment.

Builds the restaurant shell, kitchen line, dining room and street to match the shared layout
(``assets/source/layout.json``, exported from ``packages/data``), lights it for night, bakes
Cycles global illumination into lightmaps and an interior environment probe, and exports glTF.

    python assets/source/blender/restaurant.py --preview      # quick Cycles renders, no bake
    python assets/source/blender/restaurant.py                # full bake + export
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))

import bpy  # noqa: E402

from ahb import bl, kit  # noqa: E402
import dining  # noqa: E402
import exterior  # noqa: E402
import kitchen  # noqa: E402
from ahb.kit import aabb, area_light, emitter, floor_rect, point_light, quad, spot_light, wall_rect  # noqa: E402
from ahb.library import ART, BUILD, ROOT, material, size_of  # noqa: E402

LAYOUT = json.load(open(os.path.join(ROOT, "assets", "source", "layout.json")))
BOX = {b["id"]: b for b in LAYOUT["BOXES"]}
OUT = os.path.join(ART, "restaurant")
PREVIEW = os.path.join(BUILD, "preview")


def ext(box_id: str) -> tuple[float, float, float, float, float, float]:
    b = BOX[box_id]
    (cx, cy, cz), (hx, hy, hz) = b["center"], b["half"]
    return cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz


# Colours (sRGB) used by lights.
K_NEUTRAL = (1.0, 0.92, 0.84)  # ~3800 K kitchen LED
K_WARM = (1.0, 0.76, 0.52)  # ~2700 K dining
K_HEAT = (1.0, 0.42, 0.16)  # heat lamp elements
K_SODIUM = (1.0, 0.62, 0.28)  # street lights


class Scene:
    def __init__(self) -> None:
        self.groups: dict[str, list[bpy.types.Object]] = {"kitchen": [], "dining": [], "exterior": []}
        self.unbaked: list[bpy.types.Object] = []  # exported, not lightmapped (glass, emitters)
        self.bake_only: list[bpy.types.Object] = []  # occluders for the bake, exported elsewhere
        # Parts that move in the game (the front door's leaves): in the bake as occluders, then
        # exported as their own nodes, pivoted on their hinges, never lightmapped.
        self.movable: dict[str, tuple[tuple[float, float, float], list[bpy.types.Object]]] = {}
        self.m = {}
        self.layout = LAYOUT
        self.gfx = {}

    def box(self, box_id: str):
        return ext(box_id)

    def add(self, group: str, *objs: bpy.types.Object) -> None:
        for o in objs:
            if o is None:
                continue
            if group in self.groups:
                self.groups[group].append(o)
            elif group == "unbaked":
                self.unbaked.append(o)
            elif group == "bake_only":
                self.bake_only.append(o)
            o["group"] = group

    def add_movable(self, name: str, pivot: tuple[float, float, float], *objs: bpy.types.Object) -> None:
        self.movable.setdefault(name, (pivot, []))[1].extend(o for o in objs if o is not None)

    # --------------------------------------------------------------------------------------
    def materials(self) -> None:
        from ahb.library import ensure

        ensure()
        m = self.m
        for name in ("quarry", "checker", "subway_white", "tile_green", "plaster_cream", "plaster_white", "plaster_dark", "ceiling_tile", "steel", "steel_worn", "griddle", "oak", "walnut_slats", "vinyl_red", "powder_black", "enamel_white", "brick", "brick_dark", "asphalt", "sidewalk", "terrazzo", "hdpe", "rubber_mat", "cardboard"):
            m[name] = material(name)
        m["chrome"] = bl.solid("chrome", (0.86, 0.87, 0.89), 0.06, 1.0)
        m["brass"] = bl.solid("brass", (0.83, 0.66, 0.4), 0.28, 1.0)
        m["black_metal"] = bl.solid("black_metal", (0.03, 0.03, 0.035), 0.35, 0.6)
        m["rubber"] = bl.solid("rubber", (0.04, 0.04, 0.04), 0.85)
        m["grout_trim"] = bl.solid("trim_white", (0.92, 0.91, 0.88), 0.2)
        m["baseboard"] = bl.solid("baseboard_black", (0.04, 0.04, 0.04), 0.45)
        m["oil"] = bl.solid("fryer_oil", (0.55, 0.36, 0.08), 0.03, coat=1.0)
        m["glass"] = bl.solid("glass", (0.9, 0.95, 0.95), 0.02, transmission=1.0, ior=1.5)

    # --------------------------------------------------------------------------------------
    def architecture(self) -> None:
        m = self.m
        rb = LAYOUT["ROOM_BOUNDS"]
        X0, X1, Z0, Z1, H = rb["minX"], rb["maxX"], rb["minZ"], rb["maxZ"], 3.2
        K = "kitchen"
        Dn = "dining"
        # Floors: quarry tile behind the counter, checkerboard in the dining room.
        self.add(K, floor_rect("floor_kitchen", X0, X1, 0.0, Z1, 0.0, m["quarry"]))
        self.add(Dn, floor_rect("floor_dining", X0, X1, Z0, 0.0, 0.0, m["checker"]))
        # Kitchen walls: subway tile to 2.4 m with a coved quarry base and a bullnose cap.
        for name, axis, at, a0, a1, facing in (("n", "z", Z1, X0, X1, -1), ("w", "x", X0, 0.0, Z1, 1), ("e", "x", X1, 0.0, Z1, -1)):
            self.add(K, wall_rect(f"ktile_{name}", axis, at, a0, a1, 0.12, 2.4, facing, m["subway_white"]))
            self.add(K, wall_rect(f"kbase_{name}", axis, at, a0, a1, 0.0, 0.12, facing, m["quarry"]))
            self.add(K, wall_rect(f"kupper_{name}", axis, at, a0, a1, 2.4, H, facing, m["plaster_white"]))
            # Bullnose trim proud of the tile.
            if axis == "z":
                self.add(K, aabb(f"kcap_{name}", a0, 2.39, at - 0.012, a1, 2.42, at, m["grout_trim"], cull_bottom=False))
            else:
                lo, hi = (at, at + 0.012) if facing > 0 else (at - 0.012, at)
                self.add(K, aabb(f"kcap_{name}", lo, 2.39, a0, hi, 2.42, a1, m["grout_trim"], cull_bottom=False))
        # Dining west wall: green stacked tile wainscot, brass cap, cream plaster above.
        self.add(Dn, wall_rect("dbase_w", "x", X0, Z0, 0.0, 0.0, 0.1, 1, m["baseboard"]))
        self.add(Dn, wall_rect("dtile_w", "x", X0, Z0, 0.0, 0.1, 1.2, 1, m["tile_green"]))
        self.add(Dn, aabb("dcap_w", X0, 1.19, Z0, X0 + 0.018, 1.225, 0.0, m["brass"], cull_bottom=False))
        self.add(Dn, wall_rect("dupper_w", "x", X0, Z0, 0.0, 1.2, H, 1, m["plaster_cream"]))
        # Dining east wall: exposed brick, full height, with a black baseboard.
        self.add(Dn, wall_rect("dbase_e", "x", X1, Z0, 0.0, 0.0, 0.1, -1, m["baseboard"]))
        self.add(Dn, wall_rect("dbrick_e", "x", X1, Z0, 0.0, 0.1, H, -1, m["brick"]))
        # Storefront (south wall, z = Z0): sills at 0.9, glazing to 2.4, door 2.0 m wide.
        win_y0, win_y1, door_x, door_h = 0.9, 2.4, 1.0, 2.5
        for side, (a0, a1) in (("l", (X0, -door_x)), ("r", (door_x, X1))):
            self.add(Dn, wall_rect(f"sbase_{side}", "z", Z0, a0, a1, 0.0, 0.1, 1, m["baseboard"]))
            self.add(Dn, wall_rect(f"stile_{side}", "z", Z0, a0, a1, 0.1, win_y0, 1, m["tile_green"]))
            self.add(Dn, wall_rect(f"supper_{side}", "z", Z0, a0, a1, win_y1, H, 1, m["plaster_cream"]))
            # Oak sill board.
            self.add(Dn, aabb(f"sill_{side}", a0, win_y0 - 0.03, Z0 - 0.12, a1, win_y0, Z0 + 0.06, m["oak"], bevel=0.004, cull_bottom=False))
            # Window head reveal.
            self.add(Dn, floor_rect(f"shead_{side}", a0, a1, Z0 - 0.2, Z0, win_y1, m["plaster_cream"], down=True))
        self.add(Dn, wall_rect("sdoor_head", "z", Z0, -door_x, door_x, door_h, H, 1, m["plaster_cream"]))
        self.add(Dn, floor_rect("sdoor_soffit", -door_x, door_x, Z0 - 0.2, Z0, door_h, m["plaster_cream"], down=True))
        # Door threshold (brushed steel) and jamb reveals.
        self.add(Dn, aabb("threshold", -door_x, 0.0, Z0 - 0.2, door_x, 0.012, Z0 + 0.03, m["steel"], bevel=0.003, cull_bottom=False))
        for sx in (-door_x, door_x):
            self.add(Dn, wall_rect(f"jamb_{sx}", "x", sx, Z0 - 0.2, Z0, 0.0, door_h, 1 if sx > 0 else -1, m["plaster_cream"]))
        # Ceilings: lay-in acoustic grid over the kitchen, charcoal plaster over the dining room,
        # with a bulkhead over the service counter.
        self.add(K, floor_rect("ceil_kitchen", X0, X1, 0.3, Z1, H, m["ceiling_tile"], down=True))
        self.add(Dn, floor_rect("ceil_dining", X0, X1, Z0, -0.3, H, m["plaster_dark"], down=True))
        bh = 2.88
        self.add(Dn, floor_rect("bulk_soffit", X0, X1, -0.3, 0.3, bh, m["plaster_dark"], down=True))
        self.add(Dn, wall_rect("bulk_front", "z", -0.3, X0, X1, bh, H, -1, m["plaster_dark"]))
        self.add(K, wall_rect("bulk_back", "z", 0.3, X0, X1, bh, H, 1, m["plaster_white"]))
        self.add(Dn, aabb("bulk_trim", X0, bh - 0.02, -0.31, X1, bh, -0.29, m["brass"], cull_bottom=False))

    # --------------------------------------------------------------------------------------
    def storefront(self) -> None:
        """Black aluminium mullions, glazing (unbaked, glass material) and the double door."""
        m = self.m
        rb = LAYOUT["ROOM_BOUNDS"]
        X0, X1, Z0 = rb["minX"], rb["maxX"], rb["minZ"]
        z = Z0 - 0.1
        parts = []
        for x in (X0 + 0.03, -3.6, -1.03, 1.03, 3.6, X1 - 0.03):
            parts.append(aabb(f"mullion_{x:.2f}", x - 0.03, 0.9, z - 0.05, x + 0.03, 2.4, z + 0.05, m["black_metal"], cull_bottom=False))
        for (a0, a1) in ((X0, -1.0), (1.0, X1)):
            parts.append(aabb(f"transom_b_{a0}", a0, 0.9, z - 0.05, a1, 0.94, z + 0.05, m["black_metal"], cull_bottom=False))
            parts.append(aabb(f"transom_t_{a0}", a0, 2.36, z - 0.05, a1, 2.4, z + 0.05, m["black_metal"], cull_bottom=False))
        # Door frame and two leaves with brushed push bars. The leaves open (customers come and
        # go): each is its own node, hinged at its outer edge.
        parts += kit.frame("door_frame", -1.0, 0.0, 1.0, 2.5, z, 0.1, 0.05, m["black_metal"])
        for i, (a0, a1) in enumerate(((-0.95, 0.0), (0.0, 0.95))):
            leaf = kit.frame(f"leaf_{i}", a0, 0.012, a1, 2.45, z, 0.045, 0.06, m["black_metal"])
            leaf.append(aabb(f"leaf_kick_{i}", a0 + 0.06, 0.012, z - 0.02, a1 - 0.06, 0.2, z + 0.02, m["black_metal"], cull_bottom=False))
            for zz, sign in ((z + 0.09, 1), (z - 0.09, -1)):
                leaf.append(bl.tube(f"pushbar_{i}_{sign}", [(a0 + 0.12, 1.05, z + 0.02 * sign), (a0 + 0.12, 1.05, zz), (a1 - 0.12, 1.05, zz), (a1 - 0.12, 1.05, z + 0.02 * sign)], 0.016, m["chrome"]))
            g0, g1 = (-0.89, -0.06) if i == 0 else (0.06, 0.89)
            leaf.append(wall_rect(f"glass_d{i}", "z", z, g0, g1, 0.2, 2.39, 1, m["glass"], uv=1.0))
            self.add_movable(f"door_leaf_{i}", (a0 if i == 0 else a1, 0.0, z), *leaf)
        for p in parts:
            self.add("dining", p)
        # Glazing panes (two layers would be a box; one double-sided pane is enough here).
        for name, (a0, a1, y0, y1) in {"glass_l": (X0, -1.0, 0.94, 2.36), "glass_r": (1.0, X1, 0.94, 2.36)}.items():
            g = wall_rect(name, "z", z, a0, a1, y0, y1, 1, m["glass"], uv=1.0)
            self.add("unbaked", g)

    # --------------------------------------------------------------------------------------
    def lights(self) -> None:
        """Night lighting: neutral kitchen LEDs, warm pools in the dining room, amber heat lamps."""
        # Kitchen troffers (0.6 x 1.2 m) aligned to the ceiling grid.
        for i, (x0, z0) in enumerate(((-4.8, 1.8), (-2.4, 1.8), (0.0, 1.8), (2.4, 1.8), (-3.6, 3.6), (-1.2, 3.6), (1.2, 3.6), (3.6, 3.6))):
            cx, cz = x0 + 0.3, z0 + 0.6
            area_light(f"troffer_{i}", (cx, 3.17, cz), (0.58, 1.18), 40.0, K_NEUTRAL, spread=150)
            panel = floor_rect(f"troffer_lens_{i}", x0 + 0.01, x0 + 0.59, z0 + 0.01, z0 + 1.19, 3.195, emitter("troffer", K_NEUTRAL, 6.0), down=True, uv=1.0)
            kit.no_light_contribution(panel)
            self.add("unbaked", panel)


args_exposure = 1.0


HERO_SHOTS = {
    "hero_line": ((0.9, 1.62, 2.6), (-0.5, 0.95, 4.7), 22),
    "hero_dining": ((4.6, 1.55, -1.0), (-2.8, 1.25, -4.6), 20),
    "hero_counter": ((-1.2, 1.55, -3.6), (-0.4, 1.35, 1.2), 22),
    "hero_booth": ((-1.0, 1.35, -1.6), (-5.6, 1.5, -3.4), 26),
    "hero_street": ((3.2, 1.6, -16.2), (-0.6, 1.75, -6.2), 22),
}


def dress_for_hero() -> None:
    """Puts the props and some food in place (as the game would) for presentation renders."""
    import food
    import props

    objs = {o.name: o for o in props.build()}
    by_food = {o.name: o for o in bpy.data.objects if o.name in ("patty", "bun_bottom", "bun_top", "cheese", "lettuce", "tomato", "onion", "tray", "ketchup_bottle", "mustard_bottle", "mayo_bottle", "sauce_bottle", "bbq_bottle", "spatula", "bacon", "egg")}
    for i, z in enumerate(LAYOUT["GRILL_ZONES"]):
        k = objs["knob"] if i == 0 else bl.duplicate(objs["knob"], f"knob_{i}")
        k.location = bl.G(z["knob"][0], z["knob"][1], 4.157)
    for d in LAYOUT["DISPENSERS"]:
        o = objs.get(d["id"] if d["id"].startswith("bin_") else f"bin_{d['id']}")
        if o is not None:
            o.location = bl.G(d["center"][0], 0.972 if d["center"][2] > 3 else 0.952, d["center"][2])
    dr = LAYOUT["CHILLER_DRAWER"]
    objs["drawer"].location = bl.G(*dr["handle"])
    td = next(d for d in LAYOUT["DISPENSERS"] if d["kind"] == "tray")
    objs["tray_stack"].location = bl.G(*td["center"])
    for n in ("switch_plate", "switch_lever"):
        objs[n].location = bl.G(LAYOUT["SHIFT_SWITCH"][0], LAYOUT["SHIFT_SWITCH"][1], 0.352 + (0.012 if n == "switch_lever" else 0.0))
        objs[n].rotation_euler.z = math.pi
    objs["open_sign"].location = bl.G(-3.6, 1.9, -6.0)
    # Patties searing on the flat-top, at different stages.
    ft = food.foodtex.build_all()
    seared = food.cooked_variant(by_food["patty"], "patty_seared", "food_patty_seared", ft["beef"]["seared"], 0.45)
    for i, (x, z, src) in enumerate(((-0.55, 4.45, by_food["patty"]), (-0.3, 4.62, seared), (0.05, 4.4, seared), (0.3, 4.66, by_food["patty"]))):
        o = bl.duplicate(src, f"grill_patty_{i}", linked=True)
        o.location = bl.G(x, 0.9 + 0.012, z)
        o.rotation_euler.z = i * 1.3
    for i, (n, x, z) in enumerate((("bacon", 0.55, 4.4), ("egg", 0.6, 4.7))):
        o = bl.duplicate(by_food[n], f"grill_{n}", linked=True)
        o.location = bl.G(x, 0.9 + 0.004, z)
    # A finished cheeseburger on a tray on the pass.
    tray = bl.duplicate(by_food["tray"], "pass_tray", linked=True)
    tray.location = bl.G(-0.5, 1.016, 0.0)
    y = 1.026
    for n, src in (("bun_bottom", by_food["bun_bottom"]), ("patty", seared), ("cheese", by_food["cheese"]), ("lettuce", by_food["lettuce"]), ("tomato", by_food["tomato"]), ("onion", by_food["onion"]), ("bun_top", by_food["bun_top"])):
        lh = food.ITEMS[n]["layerHeight"]
        o = bl.duplicate(src, f"pass_{n}", linked=True)
        o.location = bl.G(-0.5, y + lh / 2, 0.0)
        y += lh
    for i, n in enumerate(("ketchup_bottle", "mustard_bottle", "mayo_bottle", "bbq_bottle", "sauce_bottle")):
        o = bl.duplicate(by_food[n], f"island_{n}", linked=True)
        o.location = bl.G(0.2 + i * 0.09, 0.92 + 0.09, 2.0)
    sp = bl.duplicate(by_food["spatula"], "island_spatula", linked=True)
    sp.location = bl.G(0.95, 0.93, 4.12)
    sp.rotation_euler.z = 0.4
    # Pan fills and drawer patties are copies of the hidden food templates; show what was placed.
    for o in objs.values():
        o.hide_render = False
    for o in bpy.data.objects:
        if o.name.startswith(("grill_", "pass_", "island_", "knob")):
            o.hide_render = False
    for o in list(by_food.values()) + [seared]:
        o.hide_render = True


def preview(scene: Scene, tag: str, hero: bool = False, only: set[str] | None = None) -> None:
    os.makedirs(PREVIEW, exist_ok=True)
    if hero:
        dress_for_hero()
        for name, (eye, target, lens) in HERO_SHOTS.items():
            if only and name not in only:
                continue
            bl.camera(f"cam_{name}", eye, target, lens=lens)
            t = time.time()
            bl.render(os.path.join(PREVIEW, f"{name}.jpg"), width=1600, height=900, samples=128, exposure=args_exposure)
            print(f"[hero] {name} {time.time() - t:.1f}s")
        return
    shots = {
        "line": ((0.4, 1.62, 2.9), (-0.9, 0.95, 4.7), 18),
        "dining": ((3.2, 1.62, -1.2), (-3.0, 1.2, -4.5), 18),
        "counter": ((-2.0, 1.62, -3.2), (0.0, 1.3, 1.0), 20),
        "booth": ((1.5, 1.62, -1.0), (-6.0, 1.4, -3.6), 20),
        "window": ((1.8, 1.62, -3.6), (-1.0, 1.5, -12.0), 22),
    }
    for name, (eye, target, lens) in shots.items():
        bl.camera(f"cam_{name}", eye, target, lens=lens)
        t = time.time()
        bl.render(os.path.join(PREVIEW, f"{tag}_{name}.jpg"), width=960, height=540, samples=48, exposure=args_exposure)
        print(f"[preview] {name} {time.time() - t:.1f}s")


def _principled(mat):
    if mat is None or not mat.use_nodes:
        return None
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


def _untextured_metal(mat) -> bool:
    b = _principled(mat)
    if b is None:
        return False
    if any(l.to_node == b for l in mat.node_tree.links if l.to_socket.name in ("Base Color", "Metallic")):
        return False
    return b.inputs["Metallic"].default_value >= 0.5


def _transparent(mat) -> bool:
    return mat is not None and (mat.name == "glass" or getattr(mat, "surface_render_method", "") == "BLENDED" or mat.name.startswith("emit_"))


def classify(s: Scene) -> None:
    """Moves objects that a lightmap can't help (tiny, bare metal, transparent) to 'unbaked'."""
    moved = 0
    for g, objs in s.groups.items():
        keep = []
        for o in objs:
            mats = [sl.material for sl in o.material_slots]
            dims = o.dimensions
            if max(dims) < 0.05 or (mats and all(_untextured_metal(mm) for mm in mats)) or any(_transparent(mm) for mm in mats):
                s.unbaked.append(o)
                moved += 1
            else:
                keep.append(o)
        s.groups[g] = keep
    print(f"[classify] {moved} objects unbaked; " + ", ".join(f"{g}: {len(v)}" for g, v in s.groups.items()))


LIGHTMAP_SIZE = {"kitchen": 2048, "dining": 2048, "exterior": 1024}
PROBES = {
    # Captured at the box centre: Babylon's box projection assumes that.
    "kitchen": {"center": (0.0, 1.6, 2.5), "min": (-6.0, 0.0, 0.0), "max": (6.0, 3.2, 5.0)},
    "dining": {"center": (0.0, 1.6, -3.0), "min": (-6.0, 0.0, -6.0), "max": (6.0, 3.2, 0.0)},
}


def bake_and_export(s: Scene, *, samples: int, ao_samples: int, probe_samples: int, size_scale: float, reuse: bool = False) -> None:
    """Bakes lightmaps, AO and probes, then exports. With ``reuse`` the existing lightmaps,
    AO maps and probes are kept (only valid while the lightmapped geometry is unchanged: the
    lightmap UVs are recomputed identically from it)."""
    import numpy as np

    os.makedirs(OUT, exist_ok=True)
    manifest: dict = {"version": 1, "lightmaps": {}, "probes": {}, "generated": time.strftime("%Y-%m-%d")}
    previous = json.load(open(os.path.join(OUT, "restaurant.json"))) if reuse else None
    classify(s)
    # Glass is invisible to light paths during the bake (thin glazing; lets street light in).
    movable_parts = [o for _pivot, objs in s.movable.values() for o in objs]
    glass = [o for o in s.unbaked + movable_parts if any(sl.material and sl.material.name == "glass" for sl in o.material_slots)]
    for o in glass:
        o.visible_diffuse = o.visible_glossy = o.visible_transmission = o.visible_shadow = False
    bpy.context.scene.world.light_settings.distance = 0.6
    joined = {}
    for g, objs in s.groups.items():
        for o in objs:
            bl.ensure_uv(o)
        obj = bl.join(objs, g)
        obj["lightmap"] = g
        joined[g] = obj
        size = int(LIGHTMAP_SIZE[g] * size_scale)
        t = time.time()
        bl.lightmap_uv([obj], margin=3.0 / size)
        print(f"[lightmap] {g}: uv {time.time() - t:.1f}s, {len(obj.data.polygons)} faces")
        if previous is not None:
            manifest["lightmaps"][g] = previous["lightmaps"][g]
            continue
        t = time.time()
        irr = bl.bake_lightmap([obj], size, samples, name=f"lm_{g}")
        print(f"[lightmap] {g}: irradiance bake {time.time() - t:.1f}s (max {irr.max():.2f}, mean {irr.mean():.3f})")
        t = time.time()
        ao = bl.bake_lightmap([obj], size // 2, ao_samples, name=f"ao_{g}", kind="AO")
        print(f"[lightmap] {g}: ao bake {time.time() - t:.1f}s")
        mask = bl.coverage_mask([obj], size)
        irr = bl.dilate(bl.denoise(irr), mask, 24)
        scale = bl.encode_lightmap(irr, os.path.join(OUT, f"lm_{g}.webp"), quality=90)
        mask2 = bl.coverage_mask([obj], size // 2)
        ao_d = bl.dilate(bl.denoise(np.repeat(ao[..., :1], 3, -1)), mask2, 24)[..., 0]
        from PIL import Image

        Image.fromarray(np.clip(ao_d * 255 + 0.5, 0, 255).astype(np.uint8), "L").save(os.path.join(OUT, f"ao_{g}.webp"), quality=88, method=6)
        manifest["lightmaps"][g] = {"lightmap": f"lm_{g}.webp", "ao": f"ao_{g}.webp", "scale": round(scale, 4), "size": size}
    for o in glass:
        o.visible_diffuse = o.visible_glossy = o.visible_transmission = o.visible_shadow = True
    # Reflection probes (box projected in the client).
    for name, p in PROBES.items():
        if previous is not None:
            manifest["probes"][name] = previous["probes"][name]
            continue
        t = time.time()
        faces, mats = bl.render_cube(p["center"], 384, probe_samples)
        eq = bl.cube_to_equirect(faces, mats, 1024)
        bl.save_hdr(eq, os.path.join(BUILD, f"probe_{name}.hdr"))
        manifest["probes"][name] = {"hdr": f"probe_{name}.hdr", "env": f"probe_{name}.env", "center": p["center"], "min": p["min"], "max": p["max"]}
        print(f"[probe] {name} {time.time() - t:.1f}s")
    # Unbaked geometry: one object per region (the exporter splits primitives per material); the
    # region picks the reflection probe in the client.
    regions: dict[str, list] = {"kitchen": [], "dining": [], "exterior": []}
    for o in s.unbaked:
        bl.ensure_uv(o)
        c = o.matrix_world @ (sum((v.co for v in o.data.vertices), start=o.data.vertices[0].co * 0) / max(1, len(o.data.vertices)))
        gz = -c.y
        regions["exterior" if gz < -6.15 else "kitchen" if gz > 0.0 else "dining"].append(o)
    unbaked = []
    for region, objs in regions.items():
        if objs:
            u = bl.join(objs, f"unbaked_{region}")
            u["lightmap"] = ""
            u["region"] = region
            unbaked.append(u)
    for o in s.bake_only:
        bpy.data.objects.remove(o)
    # Moving parts: one node per part with its origin on the pivot, under an "unbaked_door" root
    # so the client probe-lights them and leaves their transforms live.
    from mathutils import Matrix, Vector

    door_root = bpy.data.objects.new("unbaked_door", None)
    bl.link(door_root, None)
    movable = [door_root]
    for name, (pivot, objs) in s.movable.items():
        for o in objs:
            bl.ensure_uv(o)
        obj = bl.join(objs, name)
        at = Vector(bl.G(*pivot))
        obj.data.transform(Matrix.Translation(obj.location - at))
        obj.location = at
        obj.parent = door_root
        obj["lightmap"] = ""
        obj["region"] = "dining"
        movable.append(obj)
    # Glass ships as a plain blended material (the client dresses it); transmission would make
    # Babylon render an extra refraction pass.
    gm = bpy.data.materials.get("glass")
    if gm is not None:
        b = _principled(gm)
        b.inputs["Transmission Weight"].default_value = 0.0
        b.inputs["Alpha"].default_value = 0.12
        gm.surface_render_method = "BLENDED"
    bl.export_gltf(os.path.join(ART, "restaurant.gltf"), [*joined.values(), *unbaked, *movable], image_format="WEBP", quality=86)
    json.dump(manifest, open(os.path.join(OUT, "restaurant.json"), "w"), indent=1)
    print("[export] done", OUT)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--tag", default="p")
    ap.add_argument("--fast", action="store_true", help="low samples / half-res lightmaps for iteration")
    ap.add_argument("--reuse-lightmaps", action="store_true", help="re-export keeping the current lightmaps and probes (lightmapped geometry unchanged)")
    ap.add_argument("--hero", action="store_true", help="presentation renders (Cycles, path traced)")
    ap.add_argument("--shots", default="", help="with --hero: comma-separated shot names (default: all)")
    args = ap.parse_args([a for a in sys.argv[1:] if a != "--"])
    bl.reset()
    s = Scene()
    s.materials()
    s.architecture()
    s.storefront()
    kitchen.build(s)
    dining.build(s)
    exterior.build(s)
    s.lights()
    if args.preview or args.hero:
        preview(s, args.tag, hero=args.hero, only={n for n in args.shots.split(",") if n} or None)
        return
    fast = args.fast
    bake_and_export(s, samples=48 if fast else 384, ao_samples=16 if fast else 64, probe_samples=32 if fast else 192, size_scale=0.5 if fast else 1.0, reuse=args.reuse_lightmaps)


if __name__ == "__main__":
    main()
