"""The street outside the storefront: sidewalk, road, opposite buildings, street lights, props."""

from __future__ import annotations

import math
import random

import bpy

from ahb import bl, kit
from ahb.kit import aabb, area_light, emitter, floor_rect, image_material, image_plane, point_light, quad, spot_light, wall_rect

EX = "exterior"


def sky() -> None:
    """Night sky: deep navy zenith, sodium-tinted city glow at the horizon."""
    w = bpy.context.scene.world
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], ramp.inputs[0])
    els = ramp.color_ramp.elements
    els[0].position = 0.0
    els[0].color = (0.035, 0.022, 0.016, 1)
    els[1].position = 0.35
    els[1].color = (0.004, 0.006, 0.014, 1)
    mid = els.new(0.06)
    mid.color = (0.05, 0.03, 0.022, 1)
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 1.0
    nt.links.new(bg.outputs[0], out.inputs[0])


def street_light(s, x: float, z: float, arm_dir: int, tag: str) -> None:
    m = s.m
    pole_h = 6.2
    s.add(EX, bl.lathe(f"sl_base_{tag}", [(0.0, 0.0), (0.16, 0.0), (0.16, 0.35), (0.11, 0.42), (0.0, 0.42)], (x, 0.0, z), m["powder_black"], segments=16))
    s.add(EX, bl.cylinder(f"sl_pole_{tag}", (x, pole_h / 2, z), 0.075, pole_h, m["powder_black"], segments=16))
    reach = 1.6
    hz = z + arm_dir * reach
    s.add(EX, bl.bezier_tube(f"sl_arm_{tag}", [(x, pole_h - 0.4, z), (x, pole_h + 0.05, z + arm_dir * 0.4), (x, pole_h + 0.1, hz)], 0.045, m["powder_black"]))
    s.add(EX, aabb(f"sl_head_{tag}", x - 0.18, pole_h - 0.02, hz - 0.08 * arm_dir - 0.25, x + 0.18, pole_h + 0.12, hz + 0.25, m["powder_black"], bevel=0.04, cull_bottom=False))
    lens = floor_rect(f"sl_lens_{tag}", x - 0.15, x + 0.15, hz - 0.22, hz + 0.22, pole_h - 0.025, emitter("sodium", (1.0, 0.62, 0.3), 40.0), down=True, uv=1.0)
    kit.no_light_contribution(lens)
    s.add("unbaked", lens)
    spot_light(f"street_{tag}", (x, pole_h - 0.06, hz), (0, -1, 0), 3200.0, (1.0, 0.62, 0.3), angle_deg=120, blend=0.6, radius=0.15)


def hydrant(s, x: float, z: float) -> None:
    red = bl.solid("hydrant_red", (0.62, 0.08, 0.05), 0.45, coat=0.3)
    s.add(EX, bl.lathe("hydrant", [(0.0, 0.0), (0.13, 0.0), (0.13, 0.05), (0.095, 0.07), (0.095, 0.5), (0.11, 0.52), (0.11, 0.56), (0.09, 0.6), (0.06, 0.66), (0.03, 0.7), (0.0, 0.71)], (x, 0.0, z), red, segments=24))
    for dx in (-1, 1):
        s.add(EX, bl.cylinder(f"hydrant_nozzle_{dx}", (x + dx * 0.12, 0.42, z), 0.04, 0.07, red, axis="x", segments=16))
    s.add(EX, bl.cylinder("hydrant_front", (x, 0.38, z - 0.12), 0.055, 0.08, red, axis="z", segments=16))


def bench(s, x: float, z: float) -> None:
    m = s.m
    for dx in (-0.75, 0.75):
        s.add(EX, aabb(f"bench_leg_{dx}", x + dx - 0.03, 0.0, z - 0.25, x + dx + 0.03, 0.45, z + 0.25, m["powder_black"], bevel=0.01))
        s.add(EX, aabb(f"bench_back_leg_{dx}", x + dx - 0.03, 0.45, z + 0.2, x + dx + 0.03, 0.9, z + 0.26, m["powder_black"], bevel=0.01, cull_bottom=False))
    for k in range(4):
        zz = z - 0.2 + k * 0.12
        s.add(EX, aabb(f"bench_slat_{k}", x - 1.0, 0.43, zz - 0.045, x + 1.0, 0.47, zz + 0.045, m["oak"], bevel=0.008, cull_bottom=False))
    for k in range(3):
        y = 0.56 + k * 0.11
        s.add(EX, aabb(f"bench_bslat_{k}", x - 1.0, y - 0.04, z + 0.25, x + 1.0, y + 0.04, z + 0.28, m["oak"], bevel=0.008, cull_bottom=False))


def bicycle(s, x: float, z: float) -> None:
    """Commuter bike leaning on a hoop rack (parallel to the curb, along x)."""
    m = s.m
    black = bl.solid("tyre", (0.03, 0.03, 0.03), 0.8)
    frame = bl.solid("bike_frame", (0.12, 0.32, 0.36), 0.35, coat=0.5)
    r = 0.34
    for k, wx in enumerate((x - 0.52, x + 0.52)):
        t = bl.bezier_tube(f"bike_tyre_{k}", [(wx + r * math.cos(a), r + 0.0 + r * math.sin(a), z) for a in [i * 2 * math.pi / 12 for i in range(12)]], 0.018, black, cyclic=True, resolution=6)
        s.add(EX, t)
        for i in range(16):
            a = i * 2 * math.pi / 16
            s.add(EX, bl.tube(f"bike_spoke_{k}_{i}", [(wx, r, z), (wx + (r - 0.02) * math.cos(a), r + (r - 0.02) * math.sin(a), z)], 0.0012, m["chrome"]))
        s.add(EX, bl.cylinder(f"bike_hub_{k}", (wx, r, z), 0.02, 0.07, m["chrome"], axis="z", segments=12))
    bb = (x - 0.05, 0.3, z)
    seat = (x - 0.18, 0.88, z)
    head = (x + 0.38, 0.86, z)
    pts = [(x - 0.52, r, z), bb, seat, (x - 0.52, r, z)]
    s.add(EX, bl.tube("bike_rear", pts, 0.012, frame))
    s.add(EX, bl.tube("bike_main", [bb, head, (x + 0.52, r, z)], 0.016, frame))
    s.add(EX, bl.tube("bike_top", [(x - 0.16, 0.82, z), (x + 0.36, 0.82, z)], 0.014, frame))
    s.add(EX, bl.tube("bike_bars", [(x + 0.36, 0.92, z - 0.25), (x + 0.38, 0.95, z), (x + 0.36, 0.92, z + 0.25)], 0.011, m["chrome"]))
    s.add(EX, aabb("bike_saddle", seat[0] - 0.12, 0.9, z - 0.06, seat[0] + 0.06, 0.94, z + 0.06, black, bevel=0.015, cull_bottom=False))
    s.add(EX, bl.tube("bike_rack", [(x - 0.4, 0.0, z + 0.12), (x - 0.4, 0.75, z + 0.12), (x + 0.4, 0.75, z + 0.12), (x + 0.4, 0.0, z + 0.12)], 0.025, m["chrome"]))


def facade(s, x0: float, x1: float, z: float, height: float, mat, store: str | None, seed: int) -> None:
    """A building across the street (front face at z, facing +z towards us)."""
    m = s.m
    rnd = random.Random(seed)
    zf = z
    s.add(EX, wall_rect(f"fac_{seed}_upper", "z", zf, x0, x1, 4.2, height, 1, mat))
    s.add(EX, aabb(f"fac_{seed}_cornice", x0 - 0.05, height - 0.3, zf - 0.02, x1 + 0.05, height, zf + 0.25, m["sidewalk"], bevel=0.03, cull_bottom=False))
    s.add(EX, aabb(f"fac_{seed}_band", x0, 3.9, zf - 0.02, x1, 4.2, zf + 0.18, m["sidewalk"], bevel=0.02, cull_bottom=False))
    # Upper windows: recessed, with sills and lintels; some lit.
    cols = max(2, int((x1 - x0) / 1.9))
    for fl in range(int((height - 4.6) / 3.0)):
        y = 4.9 + fl * 3.0
        for c in range(cols):
            cx = x0 + (c + 0.5) * (x1 - x0) / cols
            w, h = 1.0, 1.6
            s.add(EX, aabb(f"fac_{seed}_sill_{fl}_{c}", cx - w / 2 - 0.08, y - 0.08, zf, cx + w / 2 + 0.08, y, zf + 0.08, m["sidewalk"], cull_bottom=False))
            s.add(EX, aabb(f"fac_{seed}_lintel_{fl}_{c}", cx - w / 2 - 0.06, y + h, zf, cx + w / 2 + 0.06, y + h + 0.18, zf + 0.04, m["sidewalk"], cull_bottom=False))
            lit = rnd.random() < 0.38
            if lit:
                win = image_plane(f"fac_{seed}_win_{fl}_{c}", (cx, y + h / 2, zf + 0.001), w, h, (0, 0, 1), image_material(f"apt_{seed % 6}", s.gfx[f"apt_window_{rnd.randint(0, 5)}"], rough=0.2, emission=rnd.uniform(1.2, 3.0)))
                s.add("unbaked", win)
            else:
                win = image_plane(f"fac_{seed}_win_{fl}_{c}", (cx, y + h / 2, zf + 0.001), w, h, (0, 0, 1), bl.solid("dark_window", (0.02, 0.025, 0.03), 0.06, 0.0))
                s.add(EX, win)
            for side in (-1, 1):
                s.add(EX, aabb(f"fac_{seed}_mull_{fl}_{c}_{side}", cx + side * w / 2 - 0.03, y, zf, cx + side * w / 2 + 0.03, y + h, zf + 0.05, m["black_metal"], cull_bottom=False))
            s.add(EX, aabb(f"fac_{seed}_mull_{fl}_{c}_m", cx - w / 2, y + h * 0.62, zf, cx + w / 2, y + h * 0.62 + 0.04, zf + 0.05, m["black_metal"], cull_bottom=False))
    # Ground floor.
    s.add(EX, wall_rect(f"fac_{seed}_pier_l", "z", zf, x0, x0 + 0.5, 0.0, 3.9, 1, mat))
    s.add(EX, wall_rect(f"fac_{seed}_pier_r", "z", zf, x1 - 0.5, x1, 0.0, 3.9, 1, mat))
    s.add(EX, wall_rect(f"fac_{seed}_sign_band", "z", zf, x0 + 0.5, x1 - 0.5, 3.0, 3.9, 1, m["powder_black"]))
    if store:
        sw = image_plane(f"fac_{seed}_store", ((x0 + x1) / 2, 1.65, zf - 0.25), x1 - x0 - 1.0, 2.7, (0, 0, 1), image_material(f"store_{store}", s.gfx[f"store_{store}"], rough=0.3, emission=2.5))
        s.add("unbaked", sw)
        s.add(EX, aabb(f"fac_{seed}_sf_sill", x0 + 0.5, 0.0, zf - 0.25, x1 - 0.5, 0.3, zf + 0.02, m["black_metal"], cull_bottom=False))
        for k in range(3):
            xx = x0 + 0.5 + k * (x1 - x0 - 1.0) / 2
            s.add(EX, aabb(f"fac_{seed}_sf_mull_{k}", xx - 0.04, 0.3, zf - 0.05, xx + 0.04, 3.0, zf + 0.02, m["black_metal"], cull_bottom=False))
        area_light(f"store_glow_{seed}", ((x0 + x1) / 2, 2.8, zf + 0.3), (x1 - x0 - 1.2, 0.6), 160.0, (0.85, 0.92, 1.0) if store == "laundry" else (1.0, 0.95, 0.85), facing=(0, -0.6, 1), up=(0, 1, 0), spread=150)
    else:
        # Roll-down shutter.
        for k in range(30):
            y = 0.1 + k * 0.096
            s.add(EX, aabb(f"fac_{seed}_shutter_{k}", x0 + 0.5, y, zf - 0.2, x1 - 0.5, y + 0.09, zf - 0.17, m["steel_worn"], bevel=0.008, cull_bottom=False))
    # Returns (side walls) so buildings read as solid.
    s.add(EX, wall_rect(f"fac_{seed}_return_l", "x", x0, zf - 6, zf, 0.0, height, -1, mat))
    s.add(EX, wall_rect(f"fac_{seed}_return_r", "x", x1, zf - 6, zf, 0.0, height, 1, mat))


def build(s) -> None:
    m = s.m
    sky()
    # Our sidewalk, curb, road, far sidewalk.
    s.add(EX, floor_rect("sidewalk_near", -14.0, 14.0, -9.8, -6.2, 0.0, m["sidewalk"]))
    s.add(EX, aabb("curb_near", -14.0, -0.15, -10.0, 14.0, 0.0, -9.8, m["sidewalk"], bevel=0.02, cull_bottom=False))
    s.add(EX, floor_rect("road", -14.0, 14.0, -17.8, -10.0, -0.15, m["asphalt"]))
    s.add(EX, aabb("curb_far", -14.0, -0.15, -18.0, 14.0, 0.0, -17.8, m["sidewalk"], bevel=0.02, cull_bottom=False))
    s.add(EX, floor_rect("sidewalk_far", -14.0, 14.0, -21.0, -18.0, 0.0, m["sidewalk"]))
    paint_y = -0.148
    yellow = bl.solid("paint_yellow", (0.85, 0.66, 0.12), 0.55)
    white = bl.solid("paint_white", (0.86, 0.86, 0.82), 0.55)
    for dz in (-0.08, 0.08):
        s.add(EX, floor_rect(f"lane_yellow_{dz}", -14.0, 14.0, -13.9 + dz - 0.05, -13.9 + dz + 0.05, paint_y, yellow, uv=1.0))
    s.add(EX, floor_rect("edge_line_near", -14.0, 14.0, -10.35, -10.25, paint_y, white, uv=1.0))
    s.add(EX, floor_rect("edge_line_far", -14.0, 14.0, -17.55, -17.45, paint_y, white, uv=1.0))
    s.add(EX, bl.cylinder("manhole", (2.2, -0.147, -12.4), 0.33, 0.006, m["steel_worn"], segments=32))
    # Our facade outer skin (seen in window reveals) and a door-side wall light.
    s.add(EX, wall_rect("our_facade_l", "z", -6.2, -8.0, -1.0, 0.0, 3.4, -1, m["brick_dark"]))
    s.add(EX, wall_rect("our_facade_r", "z", -6.2, 1.0, 8.0, 0.0, 3.4, -1, m["brick_dark"]))
    for x in (-1.35, 1.35):
        s.add(EX, bl.lathe(f"door_lamp_{x}", [(0.0, -0.12), (0.07, -0.1), (0.08, 0.0), (0.07, 0.1), (0.0, 0.12)], (x, 2.55, -6.32), bl.solid("opal_glass", (0.95, 0.9, 0.82), 0.3, emission=(1.0, 0.8, 0.55), emission_strength=3.0), segments=20))
        point_light(f"door_lamp_light_{x}", (x, 2.55, -6.45), 40.0, (1.0, 0.78, 0.5), radius=0.07)
    street_light(s, -5.2, -9.55, -1, "a")
    street_light(s, 6.8, -9.55, -1, "b")
    street_light(s, 0.8, -18.25, 1, "c")
    hydrant(s, 3.1, -9.45)
    bench(s, -2.9, -9.3)
    bicycle(s, 4.6, -9.2)
    # Buildings across the street.
    facade(s, -13.0, -5.2, -21.0, 12.5, m["brick"], "mart", 1)
    facade(s, -5.2, 2.2, -21.0, 10.0, m["brick_dark"], None, 2)
    facade(s, 2.2, 10.5, -21.0, 13.5, m["brick"], "laundry", 3)
    facade(s, 10.5, 16.0, -21.0, 9.0, m["brick_dark"], None, 4)
