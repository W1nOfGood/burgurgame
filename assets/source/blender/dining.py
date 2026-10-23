"""Dining room: tables, chairs, banquette, pendants, neon, framed prints, plants, condiments."""

from __future__ import annotations

import math

import bmesh
import bpy

from ahb import bl, kit
from ahb.kit import aabb, area_light, cushion, emitter, image_material, image_plane, point_light
from ahb.library import font

DN = "dining"


def condiments(s, x: float, z: float) -> None:
    m = s.m
    y = 0.74
    s.add(DN, aabb(f"napkins_{x}_{z}", x - 0.06, y, z - 0.05, x + 0.06, y + 0.13, z + 0.05, m["chrome"], bevel=0.008, cull_bottom=False))
    s.add(DN, aabb(f"napkins_paper_{x}_{z}", x - 0.045, y + 0.13, z - 0.04, x + 0.045, y + 0.135, z + 0.04, bl.solid("paper", (0.96, 0.95, 0.92), 0.8), cull_bottom=False))
    bottle = [(0.0, 0.0), (0.028, 0.0), (0.031, 0.006), (0.031, 0.13), (0.026, 0.152), (0.012, 0.162), (0.012, 0.19), (0.004, 0.205), (0.0, 0.205)]
    s.add(DN, bl.lathe(f"ketchup_{x}_{z}", bottle, (x + 0.11, y, z - 0.02), bl.solid("ketchup_bottle", (0.62, 0.05, 0.03), 0.18, coat=0.5), segments=20))
    s.add(DN, bl.lathe(f"mustard_{x}_{z}", bottle, (x + 0.11, y, z + 0.06), bl.solid("mustard_bottle", (0.92, 0.7, 0.06), 0.25, coat=0.5), segments=20))
    shaker = [(0.0, 0.0), (0.019, 0.0), (0.021, 0.01), (0.021, 0.07), (0.0, 0.07)]
    cap = [(0.0, 0.07), (0.021, 0.07), (0.021, 0.085), (0.016, 0.095), (0.0, 0.095)]
    for i, (dx, fill) in enumerate(((-0.11, (0.95, 0.95, 0.95)), (-0.16, (0.2, 0.18, 0.16)))):
        s.add(DN, bl.lathe(f"shaker_{i}_{x}_{z}", shaker, (x + dx, y, z + 0.03), bl.solid("shaker_glass", (0.85, 0.88, 0.88), 0.05, alpha=0.4), segments=16))
        s.add(DN, bl.lathe(f"shaker_fill_{i}_{x}_{z}", [(0.0, 0.002), (0.017, 0.002), (0.017, 0.04), (0.0, 0.04)], (x + dx, y, z + 0.03), bl.solid(f"shaker_fill_{i}", fill, 0.9), segments=16))
        s.add(DN, bl.lathe(f"shaker_cap_{i}_{x}_{z}", cap, (x + dx, y, z + 0.03), m["chrome"], segments=16))


def table(s, b) -> None:
    m = s.m
    x0, _, z0, x1, y1, z1 = b
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    s.add(DN, aabb(f"tb_top_{cx}", x0 + 0.01, y1 - 0.035, z0 + 0.01, x1 - 0.01, y1, z1 - 0.01, m["oak"], bevel=0.008, cull_bottom=False))
    # Ribbed chrome edge band, the classic diner detail.
    for k, dy in enumerate((0.006, 0.017, 0.028)):
        s.add(DN, bl.tube(f"tb_band_{cx}_{k}", [(x0, y1 - dy, z0), (x1, y1 - dy, z0), (x1, y1 - dy, z1), (x0, y1 - dy, z1), (x0, y1 - dy, z0)], 0.004, m["chrome"]))
    s.add(DN, aabb(f"tb_apron_{cx}", cx - 0.25, y1 - 0.06, cz - 0.25, cx + 0.25, y1 - 0.035, cz + 0.25, m["powder_black"], cull_bottom=False))
    s.add(DN, bl.cylinder(f"tb_column_{cx}", (cx, 0.38, cz), 0.035, 0.64, m["powder_black"], segments=20))
    s.add(DN, bl.lathe(f"tb_base_{cx}", [(0.0, 0.0), (0.27, 0.0), (0.275, 0.01), (0.24, 0.03), (0.08, 0.06), (0.05, 0.09), (0.0, 0.09)], (cx, 0.0, cz), m["powder_black"], segments=40))
    condiments(s, cx - 0.2, cz - 0.28)


def chair(s, cx: float, cz: float, face: int, tag: str) -> None:
    """Chrome-tube diner chair with red vinyl seat and back; ``face`` = +1 faces +x, -1 faces -x."""
    m = s.m

    def P(lx: float, ly: float, lz: float) -> tuple[float, float, float]:
        # Local: +z forward (towards the table), +x to the chair's right.
        return (cx + lz * face, ly, cz - lx * face)

    seat_h = 0.46
    hw, hd = 0.21, 0.21
    pts_l = [P(-hw, 0.01, hd - 0.03), P(-hw, seat_h - 0.03, hd - 0.03), P(-hw, seat_h - 0.03, -hd + 0.02), P(-hw - 0.01, 0.01, -hd - 0.04)]
    pts_r = [P(hw, 0.01, hd - 0.03), P(hw, seat_h - 0.03, hd - 0.03), P(hw, seat_h - 0.03, -hd + 0.02), P(hw + 0.01, 0.01, -hd - 0.04)]
    s.add(DN, bl.tube(f"ch_frame_l_{tag}", pts_l, 0.011, m["chrome"]))
    s.add(DN, bl.tube(f"ch_frame_r_{tag}", pts_r, 0.011, m["chrome"]))
    s.add(DN, bl.tube(f"ch_back_post_l_{tag}", [P(-hw + 0.02, seat_h - 0.03, -hd + 0.02), P(-hw + 0.02, 0.88, -hd - 0.03)], 0.01, m["chrome"]))
    s.add(DN, bl.tube(f"ch_back_post_r_{tag}", [P(hw - 0.02, seat_h - 0.03, -hd + 0.02), P(hw - 0.02, 0.88, -hd - 0.03)], 0.01, m["chrome"]))
    s.add(DN, bl.tube(f"ch_stretcher_{tag}", [P(-hw, 0.2, hd - 0.03), P(hw, 0.2, hd - 0.03)], 0.008, m["chrome"]))
    a = P(-hw + 0.005, seat_h - 0.03, -hd + 0.01)
    b = P(hw - 0.005, seat_h + 0.035, hd - 0.0)
    s.add(DN, cushion(f"ch_seat_{tag}", min(a[0], b[0]), seat_h - 0.03, min(a[2], b[2]), max(a[0], b[0]), seat_h + 0.035, max(a[2], b[2]), m["vinyl_red"], radius=0.025))
    a = P(-hw + 0.01, 0.6, -hd - 0.035)
    b = P(hw - 0.01, 0.86, -hd - 0.0)
    s.add(DN, cushion(f"ch_back_{tag}", min(a[0], b[0]), 0.6, min(a[2], b[2]), max(a[0], b[0]), 0.86, max(a[2], b[2]), m["vinyl_red"], radius=0.02))
    for k, lx in enumerate((-hw, hw)):
        for j, lz in enumerate((hd - 0.03, -hd - 0.04)):
            p = P(lx, 0.0, lz)
            s.add(DN, bl.cylinder(f"ch_glide_{tag}_{k}{j}", (p[0], 0.006, p[2]), 0.014, 0.012, m["rubber"], segments=10))


def banquette(s, b) -> None:
    m = s.m
    x0, _, z0, x1, y1, z1 = b  # -5.95, 0, -4.2, -5.25, 0.5, -1.8
    s.add(DN, aabb("bq_plinth", x0, 0.0, z0, x1 - 0.04, 0.1, z1, m["baseboard"]))
    s.add(DN, aabb("bq_base", x0, 0.1, z0, x1, 0.38, z1, m["walnut_slats"], uv=(0.6, 0.6)))
    n = 6
    for k in range(n):
        a0 = z0 + k * (z1 - z0) / n
        a1 = a0 + (z1 - z0) / n
        s.add(DN, cushion(f"bq_seat_{k}", x0 + 0.14, 0.38, a0 + 0.004, x1 + 0.01, 0.5, a1 - 0.004, m["vinyl_red"], radius=0.035))
    # Channel-tufted back: vertical rolls.
    nb = 12
    for k in range(nb):
        a0 = z0 + k * (z1 - z0) / nb
        a1 = a0 + (z1 - z0) / nb
        s.add(DN, cushion(f"bq_back_{k}", x0 + 0.0, 0.48, a0 + 0.003, x0 + 0.15, 1.12, a1 - 0.003, m["vinyl_red"], radius=0.06))
    s.add(DN, aabb("bq_cap", x0, 1.12, z0 - 0.02, x0 + 0.17, 1.16, z1 + 0.02, m["oak"], bevel=0.008, cull_bottom=False))
    for z in (z0 - 0.03, z1 + 0.01):
        s.add(DN, aabb(f"bq_end_{z:.2f}", x0, 0.0, z, x1, 1.16, z + 0.03, m["walnut_slats"], bevel=0.004))


def pendant(s, x: float, z: float, tag: str, bottom: float = 2.05) -> None:
    m = s.m
    shade_h = 0.2
    y0 = bottom
    outer = [(0.21, 0.0), (0.205, 0.015), (0.17, 0.08), (0.11, 0.15), (0.06, 0.19), (0.035, shade_h), (0.0, shade_h)]
    inner = [(0.2, 0.002), (0.195, 0.016), (0.162, 0.08), (0.104, 0.146), (0.056, 0.184), (0.03, shade_h - 0.006), (0.0, shade_h - 0.006)]
    s.add(DN, bl.lathe(f"pd_shade_{tag}", outer, (x, y0, z), m["powder_black"], segments=40))
    s.add(DN, bl.lathe(f"pd_inner_{tag}", inner, (x, y0, z), bl.solid("enamel_inner", (0.93, 0.9, 0.84), 0.35), segments=40))
    s.add(DN, bl.cylinder(f"pd_socket_{tag}", (x, y0 + shade_h - 0.03, z), 0.022, 0.05, m["brass"], segments=16))
    bulb = bl.lathe(f"pd_bulb_{tag}", [(0.0, -0.11), (0.018, -0.105), (0.03, -0.085), (0.034, -0.06), (0.028, -0.03), (0.014, -0.01), (0.012, 0.0), (0.0, 0.0)], (x, y0 + shade_h - 0.05, z), emitter("bulb_warm", (1.0, 0.72, 0.42), 18.0), segments=20)
    kit.no_light_contribution(bulb)
    s.add("unbaked", bulb)
    s.add(DN, bl.tube(f"pd_cord_{tag}", [(x, y0 + shade_h, z), (x, 3.2, z)], 0.0035, m["black_metal"]))
    s.add(DN, bl.cylinder(f"pd_canopy_{tag}", (x, 3.18, z), 0.05, 0.04, m["powder_black"], segments=20))
    point_light(f"pendant_{tag}", (x, y0 + shade_h - 0.12, z), 60.0, (1.0, 0.74, 0.46), radius=0.03)


def neon_text(name: str, body: str, font_file: str, size: float, color, strength: float, at, facing, *, tube: float = 0.0045) -> bpy.types.Object:
    """Neon tubing: a light-weight font with an extruded, bevelled (round) stroke."""
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = body
    cu.font = bpy.data.fonts.load(font(font_file), check_existing=True)
    cu.size = size
    cu.extrude = tube * 0.6
    cu.bevel_depth = tube * 0.55
    cu.bevel_resolution = 3
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.resolution_u = 8
    obj = bpy.data.objects.new(name, cu)
    bl.link(obj, None)
    cu.materials.append(emitter(name, color, strength))
    obj = bl.to_mesh(obj, smooth=True)
    kit.orient(obj, facing, at=at)
    return obj


def neon(s) -> None:
    pink = (1.0, 0.18, 0.42)
    cyan = (0.55, 0.95, 1.0)
    x = -5.955
    a = neon_text("neon_after_hours", "after hours", "InterDisplay-LightItalic.otf", 0.42, pink, 26.0, (x, 2.15, -3.0), (1, 0, 0))
    b = neon_text("neon_burgers", "BURGERS · SHAKES · LATE", "InterDisplay-Light.otf", 0.11, cyan, 20.0, (x, 1.78, -3.0), (1, 0, 0), tube=0.003)
    s.add("unbaked", a, b)
    # Clear acrylic backer with stand-offs.
    s.add(DN, aabb("neon_backer", -6.0, 1.66, -4.25, -5.985, 2.42, -1.75, bl.solid("acrylic", (0.9, 0.92, 0.95), 0.05, alpha=0.18), cull_bottom=False))
    for z in (-4.15, -1.85):
        for y in (1.7, 2.38):
            s.add(DN, bl.cylinder(f"neon_standoff_{z}_{y}", (-5.99, y, z), 0.008, 0.02, s.m["chrome"], axis="x", segments=12))
    # Transformer box.
    s.add(DN, aabb("neon_transformer", -6.0, 2.55, -2.2, -5.94, 2.66, -1.95, s.m["powder_black"], bevel=0.005, cull_bottom=False))


def framed_print(s, name: str, z: float, y: float, w: float, h: float, img: str) -> None:
    m = s.m
    x = 6.0
    d = 0.03
    s.add(DN, aabb(f"{name}_frame_l", x - d, y - h / 2 - 0.03, z - w / 2 - 0.03, x, y + h / 2 + 0.03, z - w / 2, m["powder_black"], bevel=0.004, cull_bottom=False))
    s.add(DN, aabb(f"{name}_frame_r", x - d, y - h / 2 - 0.03, z + w / 2, x, y + h / 2 + 0.03, z + w / 2 + 0.03, m["powder_black"], bevel=0.004, cull_bottom=False))
    s.add(DN, aabb(f"{name}_frame_t", x - d, y + h / 2, z - w / 2, x, y + h / 2 + 0.03, z + w / 2, m["powder_black"], bevel=0.004, cull_bottom=False))
    s.add(DN, aabb(f"{name}_frame_b", x - d, y - h / 2 - 0.03, z - w / 2, x, y - h / 2, z + w / 2, m["powder_black"], bevel=0.004, cull_bottom=False))
    s.add(DN, aabb(f"{name}_back", x - 0.006, y - h / 2, z - w / 2, x, y + h / 2, z + w / 2, bl.solid("mat_board", (0.95, 0.94, 0.9), 0.9), cull_bottom=False))
    s.add(DN, image_plane(f"{name}_art", (x - 0.008, y, z), w - 0.08, h - 0.08, (-1, 0, 0), image_material(f"print_{name}", img, rough=0.35)))
    # Brass picture light above the frame.
    s.add(DN, bl.cylinder(f"{name}_pl_bar", (x - 0.1, y + h / 2 + 0.12, z), 0.018, w * 0.6, m["brass"], axis="z", segments=16))
    s.add(DN, bl.tube(f"{name}_pl_arm", [(x, y + h / 2 + 0.08, z), (x - 0.1, y + h / 2 + 0.12, z)], 0.006, m["brass"]))
    area_light(f"{name}_picture_light", (x - 0.11, y + h / 2 + 0.1, z), (w * 0.55, 0.03), 9.0, (1.0, 0.8, 0.55), facing=(0.3, -1, 0), up=(1, 0, 0), spread=120)


def snake_plant(s, cx: float, cz: float, tag: str, scale: float = 1.0, pot_r: float = 0.17) -> None:
    m = s.m
    pot_h = 0.32 * scale
    s.add(DN, bl.lathe(f"pot_{tag}", [(0.0, 0.0), (pot_r * 0.72, 0.0), (pot_r * 0.75, 0.01), (pot_r, pot_h - 0.03), (pot_r + 0.012, pot_h - 0.02), (pot_r + 0.012, pot_h), (pot_r - 0.01, pot_h), (pot_r - 0.012, pot_h - 0.03), (0.0, pot_h - 0.03)], (cx, 0.0 if scale > 0.6 else 0.9, cz), bl.solid("terracotta", (0.66, 0.36, 0.24), 0.85), segments=32))
    base_y = (0.0 if scale > 0.6 else 0.9) + pot_h - 0.035
    leaf_mat = bl.solid("leaf", (0.16, 0.3, 0.14), 0.45)
    edge_mat = bl.solid("leaf_edge", (0.7, 0.66, 0.3), 0.5)
    import random

    import zlib

    rnd = random.Random(zlib.crc32(tag.encode()) & 0xFFFF)  # stable across runs (str hash is salted)
    leaves = []
    for k in range(int(11 * (0.6 + 0.4 * scale))):
        a = rnd.uniform(0, 2 * math.pi)
        r0 = rnd.uniform(0.0, pot_r * 0.6)
        h = rnd.uniform(0.45, 0.95) * scale
        w = rnd.uniform(0.035, 0.055) * (0.7 + 0.3 * scale)
        lean = rnd.uniform(0.05, 0.22)
        twist = rnd.uniform(-0.9, 0.9)
        bm = bmesh.new()
        rows = []
        steps = 10
        for i in range(steps + 1):
            t = i / steps
            width = w * (math.sin(min(1.0, t * 1.3 + 0.08) * math.pi) ** 0.6) * (1 - t) ** 0.25
            ang = a + twist * t
            ox = cx + math.cos(a) * (r0 + lean * t * t * h)
            oz = cz + math.sin(a) * (r0 + lean * t * t * h)
            y = base_y + t * h
            dx, dz = -math.sin(ang) * width, math.cos(ang) * width
            fold = 0.012 * (1 - t)
            rows.append([bm.verts.new(bl.G(ox - dx, y, oz - dz)), bm.verts.new(bl.G(ox + math.cos(ang) * fold, y, oz + math.sin(ang) * fold)), bm.verts.new(bl.G(ox + dx, y, oz + dz))])
        for i in range(steps):
            for j in range(2):
                bm.faces.new((rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]))
        o = bl._obj_from_bm(f"leaf_{tag}_{k}", bm, leaf_mat, None)
        for p in o.data.polygons:
            p.use_smooth = True
        bl.ensure_uv(o)
        leaves.append(o)
    s.add(DN, bl.join(leaves, f"plant_{tag}"))
    s.add(DN, bl.cylinder(f"soil_{tag}", (cx, base_y + 0.004, cz), pot_r - 0.012, 0.008, bl.solid("soil", (0.12, 0.08, 0.06), 0.95), segments=24))


def window_lettering(s) -> None:
    """Gold-leaf lettering on the left window, readable from the street (mirrored inside)."""
    m = s.m
    t = bl.text("win_letter_a", "AFTER HOURS", font("InterDisplay-Black.otf"), 0.2, m["brass"], extrude=0.0004)
    kit.orient(t, (0, 0, -1), at=(-3.6, 2.05, -6.112))
    t2 = bl.text("win_letter_b", "BURGERS  ·  OPEN LATE", font("InterDisplay-Bold.otf"), 0.075, m["brass"], extrude=0.0004)
    kit.orient(t2, (0, 0, -1), at=(-3.6, 1.86, -6.112))
    s.add("unbaked", t, t2)
    hours = bl.text("door_hours", "MON–THU 6PM–2AM\nFRI–SAT 6PM–4AM\nSUN 6PM–1AM", font("Inter-SemiBold.otf"), 0.03, bl.solid("decal_white", (0.95, 0.95, 0.93), 0.4), extrude=0.0003)
    kit.orient(hours, (0, 0, -1), at=(0.45, 1.45, -6.112))
    s.add("unbaked", hours)
    push = bl.text("door_push", "PUSH", font("InterDisplay-Bold.otf"), 0.035, bl.solid("decal_white", (0.95, 0.95, 0.93), 0.4), extrude=0.0003)
    kit.orient(push, (0, 0, 1), at=(-0.47, 1.15, -6.088))
    s.add("unbaked", push)


def build(s) -> None:
    gfx = s.gfx
    for tid in ("table_1", "table_2", "table_3"):
        b = s.box(tid)
        table(s, b)
        cx, cz = (b[0] + b[3]) / 2, (b[2] + b[5]) / 2
        chair(s, cx - 0.66, cz, 1, f"{tid}_w")
        chair(s, cx + 0.66, cz, -1, f"{tid}_e")
        pendant(s, cx, cz, tid)
    banquette(s, s.box("booth_west"))
    neon(s)
    framed_print(s, "print_smash", -1.55, 1.75, 0.62, 0.82, gfx["poster_smash"])
    framed_print(s, "print_hours", -3.0, 1.75, 0.62, 0.82, gfx["poster_hours"])
    framed_print(s, "print_anatomy", -4.45, 1.75, 0.62, 0.82, gfx["poster_anatomy"])
    snake_plant(s, 5.55, -5.55, "corner", 1.0)
    snake_plant(s, -5.2, -6.05, "sill_a", 0.45, pot_r=0.07)
    snake_plant(s, 2.6, -6.05, "sill_b", 0.4, pot_r=0.065)
    window_lettering(s)
    # Warm wall sconce over the banquette end and by the door.
    for i, (z, y) in enumerate(((-1.2, 1.95), (-5.0, 1.95))):
        s.add(DN, bl.lathe(f"sconce_{i}", [(0.0, -0.09), (0.06, -0.09), (0.075, 0.0), (0.06, 0.09), (0.0, 0.09)], (-5.93, y, z), bl.solid("opal_glass", (0.95, 0.9, 0.82), 0.3, emission=(1.0, 0.8, 0.55), emission_strength=3.0), segments=24))
        s.add(DN, bl.cylinder(f"sconce_plate_{i}", (-5.995, y, z), 0.06, 0.01, s.m["brass"], axis="x", segments=24))
        point_light(f"sconce_light_{i}", (-5.88, y, z), 16.0, (1.0, 0.78, 0.52), radius=0.06)
    # Recessed warm downlights along the storefront and the brick wall.
    for i, (x, z) in enumerate(((-4.8, -5.3), (-2.4, -5.3), (2.4, -5.3), (4.8, -5.3), (5.3, -1.6), (5.3, -4.4))):
        s.add(DN, bl.cylinder(f"downlight_trim_{i}", (x, 3.198, z), 0.06, 0.004, s.m["powder_black"], segments=24))
        lens = bl.cylinder(f"downlight_lens_{i}", (x, 3.195, z), 0.045, 0.004, emitter("downlight", (1.0, 0.8, 0.58), 12.0), segments=24)
        kit.no_light_contribution(lens)
        s.add("unbaked", lens)
        kit.spot_light(f"downlight_{i}", (x, 3.17, z), (0, -1, 0), 55.0, (1.0, 0.78, 0.55), angle_deg=70, blend=0.7, radius=0.04)
