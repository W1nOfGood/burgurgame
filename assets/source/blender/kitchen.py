"""Kitchen line, prep, storage and service counter. Footprints follow layout.json boxes."""

from __future__ import annotations

import math

from ahb import bl, kit
from ahb.graphics import build_all as build_graphics
from ahb.kit import aabb, area_light, cushion, emitter, image_material, image_plane, point_light, prism, quad, wall_rect

K = "kitchen"


def legs(s, name: str, x0: float, x1: float, z0: float, z1: float, top: float, *, inset: float = 0.03, size: float = 0.04, mid: bool = False, shelf: float | None = None, group: str = K) -> None:
    """Square stainless legs with bullet feet, optional undershelf."""
    m = s.m
    xs = [x0 + inset, x1 - inset] + ([(x0 + x1) / 2] if mid else [])
    for x in xs:
        for z in (z0 + inset, z1 - inset):
            s.add(group, aabb(f"{name}_leg_{x:.2f}_{z:.2f}", x - size / 2, 0.035, z - size / 2, x + size / 2, top, z + size / 2, m["steel"], bevel=0.004))
            s.add(group, bl.lathe(f"{name}_foot_{x:.2f}_{z:.2f}", [(0.0, 0.0), (0.022, 0.0), (0.024, 0.006), (0.018, 0.02), (0.016, 0.036), (0.0, 0.036)], (x, 0, z), m["chrome"], segments=16))
    if shelf is not None:
        s.add(group, aabb(f"{name}_shelf", x0 + inset, shelf - 0.02, z0 + inset, x1 - inset, shelf, z1 - inset, m["steel"], bevel=0.006))


def griddle(s, ex) -> None:
    m = s.m
    x0, _, z0, x1, y1, z1 = ex  # -0.85, 0, 4.15, 0.85, 0.9, 4.95
    # Equipment stand with undershelf.
    legs(s, "gr_stand", x0 + 0.02, x1 - 0.02, z0 + 0.06, z1 - 0.02, 0.6, shelf=0.22, mid=True)
    s.add(K, aabb("gr_stand_top", x0 + 0.02, 0.58, z0 + 0.06, x1 - 0.02, 0.6, z1 - 0.02, m["steel"], bevel=0.004))
    # Griddle body, front control panel, plate, splash guards, grease trough.
    s.add(K, aabb("gr_body", x0, 0.6, z0 + 0.03, x1, 0.872, z1, m["steel_worn"], bevel=0.008))
    s.add(K, aabb("gr_panel", x0 + 0.01, 0.62, z0 + 0.015, x1 - 0.01, 0.84, z0 + 0.03, m["steel"], bevel=0.004))
    for i, x in enumerate((-0.52, 0.0, 0.52)):
        s.add(K, bl.cylinder(f"gr_bezel_{i}", (x, 0.76, z0 + 0.012), 0.048, 0.006, m["chrome"], axis="z", segments=40, bevel=0.002))
        # Dial scale ticks (printed).
        for k in range(7):
            a = math.radians(90 - k * 45)
            r0, r1 = 0.052, 0.06
            s.add(K, aabb(f"gr_tick_{i}_{k}", x + math.cos(a) * r0 - 0.002, 0.76 + math.sin(a) * r0 - 0.002, z0 + 0.012, x + math.cos(a) * r1 + 0.002, 0.76 + math.sin(a) * r1 + 0.002, z0 + 0.0145, m["black_metal"], cull_bottom=False))
        # Pilot lamp window (lit lamp is dynamic in the client).
        s.add(K, bl.cylinder(f"gr_pilot_bezel_{i}", (x + 0.1, 0.81, z0 + 0.013), 0.012, 0.006, m["chrome"], axis="z", segments=20))
    plate = aabb("gr_plate", x0 + 0.015, 0.872, z0 + 0.05, x1 - 0.015, 0.9, z1 - 0.03, m["griddle"], bevel=0.003)
    s.add(K, plate)
    s.add(K, aabb("gr_splash_back", x0, 0.872, z1 - 0.03, x1, 1.13, z1, m["steel"], bevel=0.003))
    for side, x in (("l", x0), ("r", x1 - 0.012)):
        s.add(K, prism(f"gr_splash_{side}", [(z0 + 0.3, 0.872), (z1, 0.872), (z1, 1.13), (z0 + 0.3, 0.92)], "zy", x, 0.012, m["steel"]))
    # Grease trough: a shallow channel along the front edge with a dark residue strip.
    s.add(K, prism("gr_trough", [(z0 - 0.0, 0.86), (z0 + 0.05, 0.86), (z0 + 0.05, 0.875), (z0 + 0.045, 0.875), (z0 + 0.045, 0.865), (z0 + 0.005, 0.865), (z0 + 0.005, 0.895), (z0, 0.895)], "zy", x0 + 0.02, (x1 - x0) - 0.04, m["steel"]))
    s.add(K, aabb("gr_grease", x0 + 0.03, 0.865, z0 + 0.006, x1 - 0.03, 0.867, z0 + 0.044, bl.solid("grease", (0.16, 0.11, 0.05), 0.08), cull_bottom=False))
    # Grease drawer under the left end.
    s.add(K, aabb("gr_drawer", x0 + 0.05, 0.62, z0 - 0.002, x0 + 0.3, 0.68, z0 + 0.02, m["steel"], bevel=0.004))
    s.add(K, bl.tube("gr_drawer_pull", [(x0 + 0.12, 0.65, z0 - 0.002), (x0 + 0.12, 0.65, z0 - 0.025), (x0 + 0.23, 0.65, z0 - 0.025), (x0 + 0.23, 0.65, z0 - 0.002)], 0.005, m["chrome"]))
    # Name plate.
    plate_txt = bl.text("gr_badge", "AHB · 3-ZONE FLAT TOP", "/home/user/burgurgame/assets/source/fonts/InterDisplay-Bold.otf", 0.022, m["black_metal"], extrude=0.0005)
    kit.orient(plate_txt, (0, 0, -1), at=(0.0, 0.645, z0 + 0.0135))
    s.add(K, plate_txt)


def hood(s, ex) -> None:
    m = s.m
    x0, y0, z0, x1, y1, z1 = ex  # -1.05, 2.15, 4.15, 1.05, 2.75, 5.05
    zb = 5.0
    t = 0.012
    s.add(K, aabb("hd_top", x0, y1 - t, z0, x1, y1, zb, m["steel"]))
    s.add(K, aabb("hd_front", x0, y0 + 0.05, z0, x1, y1, z0 + t, m["steel"], bevel=0.003, cull_bottom=False))
    # Rolled bottom lip and inner gutter.
    s.add(K, bl.cylinder("hd_lip", (0, y0 + 0.05, z0 + 0.012), 0.014, x1 - x0, m["steel"], axis="x", segments=16))
    s.add(K, aabb("hd_gutter", x0 + t, y0 + 0.035, z0 + t, x1 - t, y0 + 0.045, z0 + 0.08, m["steel_worn"], cull_bottom=False))
    for side, x in (("l", x0), ("r", x1 - t)):
        s.add(K, aabb(f"hd_side_{side}", x, y0 + 0.05, z0, x + t, y1, zb, m["steel"], cull_bottom=False))
    # Baffle filter bank on a 45 degree slope at the back, with vertical baffle channels.
    fz0, fy0, fz1, fy1 = 4.62, y1 - 0.03, zb - 0.01, y0 + 0.2
    s.add(K, quad("hd_filter_back", [(x0 + t, fy0, fz0), (x1 - t, fy0, fz0), (x1 - t, fy1, fz1), (x0 + t, fy1, fz1)], (0, -1, -1), m["steel_worn"]))
    n = 40
    for i in range(n):
        x = x0 + 0.04 + i * (x1 - x0 - 0.08) / (n - 1)
        s.add(K, prism(f"hd_baffle_{i}", [(fz0 - 0.012, fy0 - 0.012), (fz0 + 0.004, fy0 + 0.004), (fz1 + 0.004, fy1 + 0.004), (fz1 - 0.012, fy1 - 0.012)], "zy", x - 0.006, 0.012, m["steel"]))
    for i in range(1, 5):
        x = x0 + i * (x1 - x0) / 5
        s.add(K, prism(f"hd_filter_frame_{i}", [(fz0 - 0.016, fy0 - 0.016), (fz0 + 0.006, fy0 + 0.006), (fz1 + 0.006, fy1 + 0.006), (fz1 - 0.016, fy1 - 0.016)], "zy", x - 0.015, 0.03, m["steel"]))
    # Back wall of the hood below the filters.
    s.add(K, wall_rect("hd_back_low", "z", zb - 0.001, x0, x1, y0 + 0.05, fy1, -1, m["steel"]))
    # Fire-suppression pipe with nozzle drops.
    s.add(K, bl.tube("hd_pipe", [(x0 + 0.04, y1 - 0.06, z0 + 0.2), (x1 - 0.04, y1 - 0.06, z0 + 0.2)], 0.011, m["chrome"]))
    for x in (-0.6, 0.0, 0.6):
        s.add(K, bl.tube(f"hd_drop_{x}", [(x, y1 - 0.06, z0 + 0.2), (x, y1 - 0.14, z0 + 0.2)], 0.008, m["chrome"]))
        s.add(K, bl.lathe(f"hd_nozzle_{x}", [(0.0, 0.0), (0.012, 0.0), (0.012, 0.02), (0.006, 0.03), (0.0, 0.03)], (x, y1 - 0.17, z0 + 0.2), m["brass"], segments=12))
    # Two vapour-proof light globes in the canopy.
    for i, x in enumerate((-0.55, 0.55)):
        s.add(K, bl.cylinder(f"hd_lamp_base_{i}", (x, y1 - t - 0.012, 4.45), 0.07, 0.024, m["steel"], segments=24))
        globe = bl.lathe(f"hd_lamp_globe_{i}", [(0.0, -0.075), (0.03, -0.072), (0.052, -0.055), (0.06, -0.03), (0.058, 0.0), (0.0, 0.0)], (x, y1 - t - 0.024, 4.45), emitter("hood_globe", (1.0, 0.9, 0.78), 9.0), segments=24)
        kit.no_light_contribution(globe)
        s.add("unbaked", globe)
        area_light(f"hood_light_{i}", (x, y1 - 0.11, 4.45), (0.1, 0.1), 38.0, (1.0, 0.86, 0.68), spread=170)
    # Exhaust duct to the ceiling.
    s.add(K, aabb("hd_duct", -0.32, y1, 4.48, 0.32, 3.2, 4.92, m["steel_worn"], cull_bottom=False))
    # Stainless wall cladding behind the cook line.
    s.add(K, wall_rect("line_cladding", "z", 4.999, -1.6, 2.0, 0.9, y1, -1, m["steel"]))


def prep_table(s, ex, drawer) -> None:
    """Refrigerated sandwich-prep table with raised lid; chiller drawer front is dynamic."""
    m = s.m
    x0, _, z0, x1, y1, z1 = ex  # -4.1, 0, 4.25, -1.1, 0.92, 4.95
    s.add(K, aabb("pt_body", x0, 0.12, z0 + 0.02, x1, 0.875, z1, m["steel"], bevel=0.006))
    # Casters.
    for x in (x0 + 0.08, x1 - 0.08):
        for z in (z0 + 0.1, z1 - 0.1):
            s.add(K, bl.cylinder(f"pt_wheel_{x:.2f}_{z:.2f}", (x, 0.045, z), 0.045, 0.035, m["rubber"], axis="x", segments=20))
            s.add(K, aabb(f"pt_fork_{x:.2f}_{z:.2f}", x - 0.025, 0.05, z - 0.03, x + 0.025, 0.12, z + 0.03, m["chrome"], bevel=0.004))
    # Doors on the left 2/3 with recessed pulls and gasket lines; drawers on the right.
    dx_split = drawer["handle"][0] - drawer["half"][0] - 0.03  # left edge of drawer bay
    ndoors = 2
    for i in range(ndoors):
        a0 = x0 + 0.02 + i * (dx_split - x0 - 0.02) / ndoors
        a1 = x0 + 0.02 + (i + 1) * (dx_split - x0 - 0.02) / ndoors - 0.008
        s.add(K, aabb(f"pt_door_{i}", a0, 0.16, z0, a1, 0.84, z0 + 0.022, m["steel"], bevel=0.006))
        s.add(K, aabb(f"pt_gasket_{i}", a0 + 0.004, 0.165, z0 + 0.019, a1 - 0.004, 0.835, z0 + 0.0215, m["rubber"], cull_bottom=False))
        hx = a1 - 0.06 if i == 0 else a0 + 0.06
        s.add(K, aabb(f"pt_pull_{i}", hx - 0.012, 0.6, z0 - 0.012, hx + 0.012, 0.8, z0 + 0.002, m["chrome"], bevel=0.005))
    # Drawer bay: the chiller drawer opening (dark interior) and a fixed lower drawer.
    hx, hy, hz = drawer["half"]
    cx, cy = drawer["handle"][0], drawer["handle"][1]
    s.add(K, aabb("pt_bay_frame_l", cx - hx - 0.03, 0.14, z0 - 0.002, cx - hx, 0.86, z0 + 0.03, m["steel"], cull_bottom=False))
    s.add(K, aabb("pt_bay_frame_r", cx + hx, 0.14, z0 - 0.002, cx + hx + 0.03, 0.86, z0 + 0.03, m["steel"], cull_bottom=False))
    s.add(K, aabb("pt_bay_cavity", cx - hx, cy - hy - 0.02, z0 + 0.32, cx + hx, cy + hy + 0.04, z0 + 0.34, bl.solid("cavity", (0.05, 0.055, 0.06), 0.6), cull_bottom=False))
    s.add(K, aabb("pt_drawer_low", cx - hx + 0.004, 0.16, z0, cx + hx - 0.004, cy - hy - 0.04, z0 + 0.022, m["steel"], bevel=0.006))
    s.add(K, bl.tube("pt_drawer_low_pull", [(cx - 0.18, 0.4, z0), (cx - 0.18, 0.4, z0 - 0.03), (cx + 0.18, 0.4, z0 - 0.03), (cx + 0.18, 0.4, z0)], 0.009, m["chrome"]))
    # Compressor louvre at the bottom.
    for i in range(10):
        y = 0.125 + i * 0.0035
    s.add(K, aabb("pt_kick", x0 + 0.02, 0.12, z0 + 0.02, x1 - 0.02, 0.16, z0 + 0.03, m["black_metal"], cull_bottom=False))
    # Work top: steel deck, white poly cutting board at the front, raised refrigerated rail.
    s.add(K, aabb("pt_deck", x0, 0.875, z0, x1, 0.9, z1, m["steel"], bevel=0.004))
    s.add(K, aabb("pt_board", x0 + 0.02, 0.9, z0 + 0.01, x1 - 0.02, 0.918, 4.49, m["hdpe"], bevel=0.003))
    s.add(K, aabb("pt_rail_front", x0, 0.9, 4.49, x1, 0.97, 4.515, m["steel"], bevel=0.004))
    s.add(K, aabb("pt_rail_back", x0, 0.9, z1 - 0.025, x1, 0.97, z1, m["steel"], bevel=0.004))
    for side, (a0, a1) in (("l", (x0, x0 + 0.06)), ("r", (x1 - 0.04, x1))):
        s.add(K, aabb(f"pt_rail_end_{side}", a0, 0.9, 4.515, a1, 0.97, z1 - 0.025, m["steel"], bevel=0.004))
    s.add(K, aabb("pt_rail_well", x0 + 0.06, 0.9, 4.515, x1 - 0.04, 0.905, z1 - 0.025, bl.solid("cavity", (0.05, 0.055, 0.06), 0.6), cull_bottom=False))
    # Raised lid (opened, standing nearly upright behind the rail).
    lid_profile = [(z1 - 0.03, 0.97), (z1 + 0.0, 0.97), (z1 + 0.035, 1.44), (z1 + 0.005, 1.44)]
    s.add(K, prism("pt_lid", lid_profile, "zy", x0, x1 - x0, m["steel"]))
    s.add(K, bl.cylinder("pt_lid_hinge", ((x0 + x1) / 2, 0.972, z1 - 0.012), 0.009, x1 - x0, m["steel"], axis="x", segments=12))


def fryer(s, ex) -> None:
    m = s.m
    x0, _, z0, x1, y1, z1 = ex  # 1.1, 0, 4.25, 1.9, 0.9, 4.95
    s.add(K, aabb("fr_body", x0, 0.12, z0 + 0.02, x1, 0.86, z1, m["steel_worn"], bevel=0.006))
    legs(s, "fr", x0 + 0.02, x1 - 0.02, z0 + 0.05, z1 - 0.03, 0.12, inset=0.04)
    s.add(K, aabb("fr_door", x0 + 0.02, 0.16, z0, x1 - 0.02, 0.7, z0 + 0.022, m["steel"], bevel=0.006))
    s.add(K, bl.tube("fr_door_pull", [(x0 + 0.08, 0.66, z0), (x0 + 0.08, 0.66, z0 - 0.03), (x1 - 0.08, 0.66, z0 - 0.03), (x1 - 0.08, 0.66, z0)], 0.009, m["chrome"]))
    s.add(K, aabb("fr_panel", x0 + 0.02, 0.72, z0, x1 - 0.02, 0.84, z0 + 0.02, m["steel"], bevel=0.004))
    for i, x in enumerate((x0 + 0.2, x1 - 0.2)):
        s.add(K, bl.cylinder(f"fr_knob_{i}", (x, 0.78, z0 - 0.015), 0.022, 0.03, m["black_metal"], axis="z", segments=20, bevel=0.003))
        s.add(K, bl.cylinder(f"fr_lamp_{i}", (x + 0.07, 0.8, z0 - 0.002), 0.007, 0.006, bl.solid("lamp_amber", (1.0, 0.55, 0.1), 0.2, emission=(1.0, 0.5, 0.08), emission_strength=4.0), axis="z", segments=12))
    # Top deck with two vats of oil.
    deck_y = 0.9
    s.add(K, aabb("fr_deck_front", x0, 0.86, z0, x1, deck_y, z0 + 0.07, m["steel"], bevel=0.004))
    s.add(K, aabb("fr_deck_back", x0, 0.86, 4.78, x1, deck_y, z1, m["steel"], bevel=0.004))
    s.add(K, aabb("fr_deck_l", x0, 0.86, z0 + 0.07, x0 + 0.04, deck_y, 4.78, m["steel"]))
    s.add(K, aabb("fr_deck_mid", (x0 + x1) / 2 - 0.02, 0.86, z0 + 0.07, (x0 + x1) / 2 + 0.02, deck_y, 4.78, m["steel"]))
    s.add(K, aabb("fr_deck_r", x1 - 0.04, 0.86, z0 + 0.07, x1, deck_y, 4.78, m["steel"]))
    for i, (a0, a1) in enumerate(((x0 + 0.04, (x0 + x1) / 2 - 0.02), ((x0 + x1) / 2 + 0.02, x1 - 0.04))):
        s.add(K, aabb(f"fr_vat_{i}", a0, 0.72, z0 + 0.07, a1, 0.86, 4.78, m["steel_worn"], cull_bottom=False))
        s.add(K, aabb(f"fr_oil_{i}", a0 + 0.002, 0.8, z0 + 0.072, a1 - 0.002, 0.802, 4.778, m["oil"], cull_bottom=False))
        # Fry basket resting in the oil, handle forward and up.
        bx0, bx1 = a0 + 0.03, a1 - 0.03
        bz0, bz1 = z0 + 0.12, 4.72
        basket = []
        for k in range(9):
            x = bx0 + k * (bx1 - bx0) / 8
            basket.append(bl.tube(f"fr_bk_{i}_x{k}", [(x, 0.92, bz0), (x, 0.78, bz0), (x, 0.78, bz1), (x, 0.92, bz1)], 0.0018, m["chrome"]))
        for k in range(14):
            z = bz0 + k * (bz1 - bz0) / 13
            basket.append(bl.tube(f"fr_bk_{i}_z{k}", [(bx0, 0.92, z), (bx0, 0.78, z), (bx1, 0.78, z), (bx1, 0.92, z)], 0.0018, m["chrome"]))
        basket.append(bl.tube(f"fr_bk_{i}_rim", [(bx0, 0.92, bz0), (bx1, 0.92, bz0), (bx1, 0.92, bz1), (bx0, 0.92, bz1), (bx0, 0.92, bz0)], 0.004, m["chrome"]))
        mx = (bx0 + bx1) / 2
        basket.append(bl.tube(f"fr_bk_{i}_arm", [(mx - 0.04, 0.92, bz0), (mx - 0.02, 0.95, bz0 - 0.08), (mx + 0.02, 0.95, bz0 - 0.08), (mx + 0.04, 0.92, bz0)], 0.005, m["chrome"]))
        handle = bl.cylinder(f"fr_bk_{i}_handle", (mx, 0.97, bz0 - 0.15), 0.016, 0.13, m["black_metal"], axis="z", segments=14)
        handle.rotation_euler.x += math.radians(-12)
        basket.append(handle)
        s.add("unbaked", bl.join(basket, f"fryer_basket_{i}"))
    # Backsplash with flue.
    s.add(K, aabb("fr_splash", x0, deck_y, z1 - 0.12, x1, 1.18, z1, m["steel"], bevel=0.004))
    for k in range(6):
        x = x0 + 0.12 + k * 0.11
        s.add(K, aabb(f"fr_flue_slot_{k}", x - 0.035, 1.1, z1 - 0.121, x + 0.035, 1.16, z1 - 0.118, bl.solid("cavity", (0.05, 0.055, 0.06), 0.6), cull_bottom=False))
    # Basket hanger rail.
    s.add(K, bl.tube("fr_hanger", [(x0 + 0.05, 1.2, z1 - 0.1), (x1 - 0.05, 1.2, z1 - 0.1)], 0.008, m["chrome"]))


def reach_in(s, ex) -> None:
    m = s.m
    x0, _, z0, x1, y1, z1 = ex  # -5.95, 0, 4.05, -4.85, 2.0, 4.95
    s.add(K, aabb("ri_body", x0, 0.12, z0 + 0.02, x1, y1, z1, m["steel"], bevel=0.008))
    legs(s, "ri", x0 + 0.02, x1 - 0.02, z0 + 0.05, z1 - 0.03, 0.12, inset=0.04)
    s.add(K, aabb("ri_kick", x0 + 0.02, 0.1, z0 + 0.03, x1 - 0.02, 0.14, z0 + 0.05, m["black_metal"], cull_bottom=False))
    door_top = 1.78
    for i in range(2):
        a0 = x0 + 0.015 + i * (x1 - x0 - 0.03) / 2
        a1 = a0 + (x1 - x0 - 0.03) / 2 - 0.006
        s.add(K, aabb(f"ri_door_{i}", a0, 0.15, z0, a1, door_top, z0 + 0.025, m["steel"], bevel=0.008))
        s.add(K, aabb(f"ri_gasket_{i}", a0 + 0.006, 0.156, z0 + 0.022, a1 - 0.006, door_top - 0.006, z0 + 0.0245, m["rubber"], cull_bottom=False))
        hx = a1 - 0.05 if i == 0 else a0 + 0.05
        s.add(K, bl.tube(f"ri_handle_{i}", [(hx, 0.75, z0), (hx, 0.75, z0 - 0.045), (hx, 1.45, z0 - 0.045), (hx, 1.45, z0)], 0.011, m["chrome"]))
        # Embossed hinge caps.
        hx2 = a0 + 0.02 if i == 0 else a1 - 0.02
        for y in (0.2, door_top - 0.05):
            s.add(K, aabb(f"ri_hinge_{i}_{y}", hx2 - 0.012, y - 0.025, z0 - 0.006, hx2 + 0.012, y + 0.025, z0 + 0.002, m["chrome"], bevel=0.003))
    # Louvred top grille with digital thermometer.
    s.add(K, aabb("ri_grille", x0 + 0.015, door_top + 0.01, z0 + 0.005, x1 - 0.015, y1 - 0.01, z0 + 0.02, m["steel"], bevel=0.004))
    for k in range(18):
        x = x0 + 0.06 + k * 0.054
        if abs(x - (x0 + x1) / 2) < 0.12:
            continue
        s.add(K, aabb(f"ri_louvre_{k}", x - 0.018, door_top + 0.04, z0 + 0.003, x + 0.018, y1 - 0.04, z0 + 0.006, bl.solid("cavity", (0.05, 0.055, 0.06), 0.6), cull_bottom=False))
    s.add(K, aabb("ri_display", (x0 + x1) / 2 - 0.08, door_top + 0.06, z0 + 0.0, (x0 + x1) / 2 + 0.08, door_top + 0.14, z0 + 0.006, m["black_metal"], cull_bottom=False))
    digits = bl.text("ri_digits", "36°F", "/home/user/burgurgame/assets/source/fonts/JetBrainsMono-Bold.ttf", 0.05, emitter("led_red", (1.0, 0.12, 0.08), 12.0))
    kit.orient(digits, (0, 0, -1), at=((x0 + x1) / 2, door_top + 0.1, z0 - 0.001))
    s.add("unbaked", digits)
    # Boxes stored on top.
    s.add(K, aabb("ri_top_box_a", x0 + 0.08, y1, z0 + 0.25, x0 + 0.5, y1 + 0.28, z0 + 0.7, s.m["cardboard"], bevel=0.004, cull_bottom=False))
    s.add(K, aabb("ri_top_box_b", x0 + 0.56, y1, z0 + 0.3, x0 + 0.9, y1 + 0.2, z0 + 0.62, s.m["cardboard"], bevel=0.004, cull_bottom=False))


def dry_storage(s, ex, gfx) -> None:
    """Chrome wire shelving with stock."""
    m = s.m
    x0, _, z0, x1, y1, z1 = ex  # 2.7, 0, 4.55, 4.5, 1.8, 4.95
    for x in (x0 + 0.015, x1 - 0.015):
        for z in (z0 + 0.015, z1 - 0.015):
            s.add(K, bl.cylinder(f"ds_post_{x:.2f}_{z:.2f}", (x, y1 / 2, z), 0.013, y1, m["chrome"], segments=12))
    shelves = (0.15, 0.6, 1.05, 1.5)
    for k, y in enumerate(shelves):
        s.add(K, bl.tube(f"ds_frame_{k}", [(x0 + 0.015, y, z0 + 0.015), (x1 - 0.015, y, z0 + 0.015), (x1 - 0.015, y, z1 - 0.015), (x0 + 0.015, y, z1 - 0.015), (x0 + 0.015, y, z0 + 0.015)], 0.006, m["chrome"]))
        for i in range(1, 40):
            x = x0 + i * (x1 - x0) / 40
            s.add(K, bl.tube(f"ds_wire_{k}_{i}", [(x, y, z0 + 0.015), (x, y, z1 - 0.015)], 0.0022, m["chrome"]))
    # Stock: labelled cases, #10 cans, bun bags, cup sleeves.
    def labelled_box(name, x, y, z, w, h, d, label):
        b = aabb(name, x - w / 2, y, z - d / 2, x + w / 2, y + h, z + d / 2, m["cardboard"], bevel=0.004, cull_bottom=False)
        s.add(K, b)
        mat = image_material(f"lbl_{label}", gfx[label], rough=0.85)
        s.add(K, image_plane(f"{name}_label", (x, y + h / 2, z - d / 2 - 0.0015), w * 0.92, h * 0.85, (0, 0, -1), mat))
    labelled_box("ds_box_buns", 3.05, 0.162, 4.75, 0.6, 0.38, 0.36, "box_buns")
    labelled_box("ds_box_fries", 3.75, 0.162, 4.75, 0.5, 0.3, 0.36, "box_fries")
    labelled_box("ds_box_cups", 4.2, 0.162, 4.75, 0.4, 0.34, 0.34, "box_cups")
    labelled_box("ds_box_napkins", 4.15, 1.512, 4.76, 0.5, 0.26, 0.32, "box_napkins")
    for i, (x, lbl) in enumerate(((2.9, "can_pickles"), (3.1, "can_pickles"), (3.3, "can_tomato"), (3.5, "can_jalapeno"))):
        can = bl.lathe(f"ds_can_{i}", [(0.0, 0.0), (0.075, 0.0), (0.078, 0.004), (0.078, 0.172), (0.075, 0.178), (0.0, 0.178)], (x, 0.612, 4.72), m["steel"], segments=28)
        s.add(K, can)
        band = bl.lathe(f"ds_can_label_{i}", [(0.0791, 0.015), (0.0791, 0.163)], (x, 0.612, 4.72), image_material(f"lbl_{lbl}", gfx[lbl], rough=0.5), segments=28, smooth_angle=80)
        # Cylindrical UVs for the wrap-around label.
        me = band.data
        uv = me.uv_layers.new(name="UVMap").data
        for poly in me.polygons:
            for li in poly.loop_indices:
                co = me.vertices[me.loops[li].vertex_index].co
                a = math.atan2(co.y, co.x)
                uv[li].uv = ((a / (2 * math.pi)) % 1.0, (co.z - 0.015) / 0.148)
        s.add(K, band)
    # Bun bags: soft pillows.
    for i in range(3):
        x = 3.85 + i * 0.2
        s.add(K, cushion(f"ds_bunbag_{i}", x - 0.09, 0.612, 4.6, x + 0.09, 0.72, 4.9, bl.solid("bun_bag", (0.93, 0.9, 0.84), 0.35, coat=0.6), radius=0.04))
    # Cup sleeves.
    for i in range(4):
        z = 4.62 + i * 0.09
        s.add(K, bl.lathe(f"ds_cups_{i}", [(0.0, 0.0), (0.03, 0.0), (0.045, 0.32), (0.0, 0.32)], (2.95, 1.062, z), bl.solid("cup_paper", (0.95, 0.94, 0.92), 0.5), segments=20))
    # Oil jugs.
    for i in range(2):
        s.add(K, aabb(f"ds_oil_{i}", 3.45 + i * 0.24, 1.062, 4.62, 3.65 + i * 0.24, 1.38, 4.86, bl.solid("oil_jug", (0.85, 0.68, 0.18), 0.25), bevel=0.02, cull_bottom=False))


def office(s, ex, gfx) -> None:
    m = s.m
    x0, _, z0, x1, y1, z1 = ex  # 4.3, 0, 3.9, 5.9, 0.76, 4.9
    s.add(K, aabb("of_top", x0, y1 - 0.03, z0, x1, y1, z1, m["oak"], bevel=0.004))
    s.add(K, aabb("of_ped", x1 - 0.42, 0.0, z0 + 0.04, x1 - 0.02, y1 - 0.03, z1 - 0.02, m["powder_black"], bevel=0.004))
    for k in range(3):
        y = 0.04 + k * 0.23
        s.add(K, aabb(f"of_drawer_{k}", x1 - 0.41, y, z0 + 0.025, x1 - 0.03, y + 0.21, z0 + 0.045, m["powder_black"], bevel=0.004))
        s.add(K, aabb(f"of_pull_{k}", x1 - 0.27, y + 0.17, z0 + 0.012, x1 - 0.17, y + 0.185, z0 + 0.026, m["chrome"], bevel=0.003))
    for z in (z0 + 0.04, z1 - 0.04):
        s.add(K, aabb(f"of_leg_{z}", x0 + 0.03, 0.0, z - 0.02, x0 + 0.07, y1 - 0.03, z + 0.02, m["powder_black"], bevel=0.003))
    s.add(K, aabb("of_modesty", x0 + 0.05, 0.3, z1 - 0.04, x1 - 0.42, y1 - 0.03, z1 - 0.02, m["powder_black"]))
    # Monitor, keyboard, papers, mug, lamp.
    mx, mz = 4.95, 4.62
    s.add(K, aabb("of_mon_foot", mx - 0.11, y1, mz - 0.08, mx + 0.11, y1 + 0.012, mz + 0.08, m["black_metal"], bevel=0.004, cull_bottom=False))
    s.add(K, aabb("of_mon_neck", mx - 0.02, y1, mz + 0.02, mx + 0.02, y1 + 0.2, mz + 0.05, m["black_metal"], bevel=0.004, cull_bottom=False))
    s.add(K, aabb("of_mon_body", mx - 0.29, y1 + 0.14, mz - 0.01, mx + 0.29, y1 + 0.5, mz + 0.02, m["black_metal"], bevel=0.006, cull_bottom=False))
    screen = image_plane("of_screen", (mx, y1 + 0.32, mz - 0.0115), 0.54, 0.32, (0, 0, -1), image_material("screen_ledger", gfx["monitor_screen"], rough=0.15, emission=1.6))
    s.add("unbaked", screen)
    s.add(K, aabb("of_keyboard", mx - 0.2, y1, 4.25, mx + 0.2, y1 + 0.018, 4.39, m["black_metal"], bevel=0.005, cull_bottom=False))
    for i in range(3):
        s.add(K, aabb(f"of_paper_{i}", 4.4 + i * 0.012, y1, 4.05 + i * 0.01, 4.61 + i * 0.012, y1 + 0.002 + i * 0.0006, 4.35 + i * 0.01, bl.solid("paper", (0.96, 0.95, 0.92), 0.8), cull_bottom=False))
    s.add(K, bl.lathe("of_mug", [(0.0, 0.0), (0.038, 0.0), (0.04, 0.005), (0.042, 0.1), (0.036, 0.1), (0.034, 0.012), (0.0, 0.012)], (5.45, y1, 4.15), bl.solid("mug", (0.12, 0.3, 0.26), 0.25), segments=24))
    # Desk lamp (articulated arm) with a warm glow.
    base = (5.62, y1, 4.72)
    s.add(K, bl.cylinder("of_lamp_base", (base[0], y1 + 0.01, base[2]), 0.075, 0.02, m["powder_black"], segments=28, bevel=0.004))
    s.add(K, bl.tube("of_lamp_arm", [(base[0], y1 + 0.02, base[2]), (base[0] - 0.05, y1 + 0.33, base[2] - 0.05), (base[0] - 0.22, y1 + 0.42, base[2] - 0.2)], 0.008, m["powder_black"]))
    head = bl.lathe("of_lamp_shade", [(0.0, 0.05), (0.03, 0.05), (0.06, 0.0), (0.065, -0.03), (0.0, -0.03)], (base[0] - 0.24, y1 + 0.4, base[2] - 0.22), m["powder_black"], segments=24)
    s.add(K, head)
    point_light("desk_lamp", (base[0] - 0.24, y1 + 0.36, base[2] - 0.22), 9.0, (1.0, 0.75, 0.48), radius=0.025)
    # Office chair tucked under the desk.
    cx, cz = 4.95, 4.2
    s.add(K, cushion("of_chair_seat", cx - 0.23, 0.44, cz - 0.21, cx + 0.23, 0.5, cz + 0.21, m["vinyl_red"], radius=0.025))
    s.add(K, cushion("of_chair_back", cx - 0.21, 0.56, cz - 0.27, cx + 0.21, 0.98, cz - 0.22, m["vinyl_red"], radius=0.025))
    s.add(K, bl.cylinder("of_chair_gas", (cx, 0.27, cz), 0.022, 0.33, m["chrome"], segments=16))
    for k in range(5):
        a = k * 2 * math.pi / 5 + 0.3
        tip = (cx + math.cos(a) * 0.3, 0.07, cz + math.sin(a) * 0.3)
        s.add(K, bl.tube(f"of_chair_spoke_{k}", [(cx, 0.1, cz), tip], 0.015, m["powder_black"]))
        s.add(K, bl.cylinder(f"of_chair_caster_{k}", (tip[0], 0.03, tip[2]), 0.028, 0.025, m["rubber"], axis="x", segments=14))
    s.add(K, bl.tube("of_chair_spine", [(cx, 0.5, cz - 0.15), (cx, 0.52, cz - 0.24), (cx, 0.62, cz - 0.25)], 0.012, m["chrome"]))
    # Clipboard + schedule on the wall.
    s.add(K, aabb("of_corkboard", 4.4, 1.15, 4.985, 5.6, 1.85, 5.0, bl.solid("cork", (0.62, 0.45, 0.28), 0.9), cull_bottom=False))
    s.add(K, aabb("of_cork_frame_t", 4.38, 1.85, 4.98, 5.62, 1.87, 5.0, m["oak"], cull_bottom=False))
    s.add(K, aabb("of_cork_frame_b", 4.38, 1.13, 4.98, 5.62, 1.15, 5.0, m["oak"], cull_bottom=False))
    for i, (x, y, w, h, c) in enumerate(((4.55, 1.5, 0.21, 0.29, (0.97, 0.96, 0.93)), (4.85, 1.45, 0.21, 0.29, (0.98, 0.9, 0.55)), (5.2, 1.55, 0.25, 0.18, (0.7, 0.85, 0.95)), (5.35, 1.3, 0.15, 0.15, (0.97, 0.75, 0.8)))):
        s.add(K, aabb(f"of_note_{i}", x - w / 2, y - h / 2, 4.981, x + w / 2, y + h / 2, 4.984, bl.solid(f"note_{i}", c, 0.85), cull_bottom=False))


def island(s, ex) -> None:
    m = s.m
    x0, _, z0, x1, y1, z1 = ex  # -2.2, 0, 1.8, 1.2, 0.92, 2.6
    s.add(K, aabb("is_top", x0, 0.88, z0, x1, y1, z1, m["steel"], bevel=0.008))
    # Rolled (marine) edges along the long sides.
    for z in (z0, z1):
        s.add(K, bl.cylinder(f"is_roll_{z}", ((x0 + x1) / 2, 0.905, z), 0.016, x1 - x0, m["steel"], axis="x", segments=16))
    legs(s, "is", x0 + 0.02, x1 - 0.02, z0 + 0.02, z1 - 0.02, 0.88, mid=True, shelf=0.24)
    # Topping rail housing on the north side (pans are dynamic).
    # Open frame: the pans drop in and rest on the worktop.
    for name, (a0, b0, a1, b1) in {"n": (-1.86, 2.575, -0.54, 2.6), "s": (-1.86, 2.36, -0.54, 2.385), "e": (-0.57, 2.385, -0.54, 2.575), "w": (-1.86, 2.385, -1.83, 2.575)}.items():
        s.add(K, aabb(f"is_rail_{name}", a0, y1, b0, a1, 0.955, b1, m["steel"], bevel=0.003, cull_bottom=False))
    # Ticket printer and a stack of paper boats at the east end.
    s.add(K, aabb("is_printer", 0.86, y1, 2.3, 1.12, y1 + 0.13, 2.55, bl.solid("printer", (0.12, 0.12, 0.13), 0.4), bevel=0.02, cull_bottom=False))
    s.add(K, aabb("is_printer_paper", 0.92, y1 + 0.1, 2.27, 1.06, y1 + 0.103, 2.31, bl.solid("paper", (0.96, 0.95, 0.92), 0.8), cull_bottom=False))
    # Undershelf stock: sheet pans and squeeze-bottle caddy.
    for k in range(4):
        s.add(K, aabb(f"is_sheetpan_{k}", -1.9, 0.245 + k * 0.025, 1.9, -1.4, 0.265 + k * 0.025, 2.25, m["steel_worn"], bevel=0.005, cull_bottom=False))
    for k in range(3):
        s.add(K, aabb(f"is_lexan_{k}", 0.1 + k * 0.32, 0.245, 1.95, 0.38 + k * 0.32, 0.42, 2.45, bl.solid("lexan", (0.86, 0.88, 0.9), 0.12, alpha=0.5), bevel=0.01, cull_bottom=False))


def sink(s, ex) -> None:
    m = s.m
    x0, _, z0, x1, y1, z1 = ex  # -6.0, 0, 1.6, -5.2, 0.92, 2.8
    s.add(K, aabb("sk_apron", x1 - 0.02, 0.6, z0, x1, y1, z1, m["steel"], bevel=0.004, cull_bottom=False))
    legs(s, "sk", x0 + 0.05, x1 - 0.02, z0 + 0.02, z1 - 0.02, 0.6, shelf=0.22)
    # Deck with two bowls; the deck is built as strips around the bowl openings.
    by0, by1 = 0.62, y1
    bowls = ((1.72, 2.17), (2.23, 2.68))
    s.add(K, aabb("sk_deck_front", x1 - 0.12, 0.88, z0, x1, y1, z1, m["steel"], cull_bottom=False))
    s.add(K, aabb("sk_deck_back", x0, 0.88, z0, x0 + 0.12, y1, z1, m["steel"], cull_bottom=False))
    s.add(K, aabb("sk_deck_s", x0 + 0.12, 0.88, z0, x1 - 0.12, y1, bowls[0][0], m["steel"], cull_bottom=False))
    s.add(K, aabb("sk_deck_mid", x0 + 0.12, 0.88, bowls[0][1], x1 - 0.12, y1, bowls[1][0], m["steel"], cull_bottom=False))
    s.add(K, aabb("sk_deck_n", x0 + 0.12, 0.88, bowls[1][1], x1 - 0.12, y1, z1, m["steel"], cull_bottom=False))
    for i, (a0, a1) in enumerate(bowls):
        bx0, bx1 = x0 + 0.12, x1 - 0.12
        s.add(K, aabb(f"sk_bowl_floor_{i}", bx0, by0, a0, bx1, by0 + 0.01, a1, m["steel_worn"], cull_bottom=False))
        s.add(K, wall_rect(f"sk_bowl_s_{i}", "z", a0, bx0, bx1, by0, by1, 1, m["steel_worn"]))
        s.add(K, wall_rect(f"sk_bowl_n_{i}", "z", a1, bx0, bx1, by0, by1, -1, m["steel_worn"]))
        s.add(K, wall_rect(f"sk_bowl_w_{i}", "x", bx0, a0, a1, by0, by1, 1, m["steel_worn"]))
        s.add(K, wall_rect(f"sk_bowl_e_{i}", "x", bx1, a0, a1, by0, by1, -1, m["steel_worn"]))
        s.add(K, bl.cylinder(f"sk_drain_{i}", ((bx0 + bx1) / 2, by0 + 0.011, (a0 + a1) / 2), 0.04, 0.003, m["chrome"], segments=24))
        s.add(K, bl.tube(f"sk_pipe_{i}", [((bx0 + bx1) / 2, by0, (a0 + a1) / 2), ((bx0 + bx1) / 2, 0.4, (a0 + a1) / 2), (x0 + 0.03, 0.4, (a0 + a1) / 2)], 0.02, bl.solid("pvc", (0.85, 0.85, 0.83), 0.4)))
    # Backsplash and wall faucet with pre-rinse sprayer.
    s.add(K, aabb("sk_splash", x0, y1, z0, x0 + 0.03, 1.25, z1, m["steel"], bevel=0.003, cull_bottom=False))
    fz = 2.2
    s.add(K, bl.tube("sk_riser", [(x0 + 0.05, 1.05, fz), (x0 + 0.1, 1.05, fz), (x0 + 0.1, 1.65, fz)], 0.013, m["chrome"]))
    s.add(K, kit.helix("sk_spring", (x0 + 0.1, 1.25, fz), 0.028, 0.55, 20, 0.003, m["chrome"]))
    s.add(K, bl.bezier_tube("sk_hose", [(x0 + 0.1, 1.65, fz), (x0 + 0.3, 1.62, fz), (x0 + 0.33, 1.3, fz), (x0 + 0.3, 1.18, fz)], 0.009, m["chrome"]))
    s.add(K, bl.cylinder("sk_sprayhead", (x0 + 0.3, 1.13, fz), 0.022, 0.1, m["chrome"], segments=16))
    s.add(K, bl.bezier_tube("sk_spout", [(x0 + 0.1, 1.1, fz), (x0 + 0.3, 1.12, fz + 0.05), (x0 + 0.42, 1.05, fz + 0.05)], 0.01, m["chrome"]))
    for dz in (-0.1, 0.1):
        s.add(K, bl.cylinder(f"sk_tap_{dz}", (x0 + 0.06, 1.05, fz + dz), 0.02, 0.05, m["chrome"], axis="x", segments=16))
        s.add(K, aabb(f"sk_tap_lever_{dz}", x0 + 0.085, 1.045, fz + dz - 0.006, x0 + 0.16, 1.055, fz + dz + 0.006, m["chrome"], bevel=0.003, cull_bottom=False))
    # Paper towel dispenser and soap.
    s.add(K, aabb("sk_towel", x0, 1.35, 2.85, x0 + 0.12, 1.65, 3.15, bl.solid("dispenser", (0.92, 0.92, 0.9), 0.3), bevel=0.02, cull_bottom=False))
    s.add(K, aabb("sk_soap", x0, 1.2, 1.4, x0 + 0.09, 1.42, 1.52, bl.solid("dispenser", (0.92, 0.92, 0.9), 0.3), bevel=0.015, cull_bottom=False))
    # Floor drain.
    s.add(K, aabb("floor_drain", -5.1, 0.0, 2.05, -4.85, 0.003, 2.3, m["steel_worn"], cull_bottom=False))


def trash_can(s, ex) -> None:
    m = s.m
    x0, _, z0, x1, y1, z1 = ex
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    grey = bl.solid("brute_grey", (0.36, 0.38, 0.4), 0.55)
    prof = [(0.0, 0.0), (0.19, 0.0), (0.2, 0.02), (0.215, 0.74), (0.225, 0.76), (0.225, 0.8), (0.21, 0.8), (0.2, 0.76), (0.0, 0.76)]
    s.add(K, bl.lathe("trash_can", prof, (cx, 0, cz), grey, segments=40))
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        s.add(K, aabb(f"trash_rib_{k}", cx + math.cos(a) * 0.205 - 0.015, 0.05, cz + math.sin(a) * 0.205 - 0.015, cx + math.cos(a) * 0.205 + 0.015, 0.74, cz + math.sin(a) * 0.205 + 0.015, grey, bevel=0.008))
    # Black liner folded over the rim.
    bag = bl.lathe("trash_bag", [(0.0, 0.62), (0.2, 0.64), (0.215, 0.78), (0.232, 0.805), (0.236, 0.76), (0.233, 0.68)], (cx, 0, cz), bl.solid("bin_bag", (0.025, 0.025, 0.028), 0.3), segments=40)
    s.add(K, bag)


def drinks(s, ex, gfx) -> None:
    """Soda fountain on a stainless cabinet, facing the kitchen (+z)."""
    m = s.m
    x0, _, z0, x1, y1, z1 = ex  # 4.1, 0, 0.65, 5.9, 1.0, 1.35
    s.add(K, aabb("dr_cab", x0, 0.1, z0, x1, 0.96, z1, m["steel"], bevel=0.006))
    s.add(K, aabb("dr_kick", x0 + 0.02, 0.0, z0 + 0.03, x1 - 0.02, 0.1, z1 - 0.05, m["black_metal"]))
    for i in range(3):
        a0 = x0 + 0.02 + i * 0.59
        s.add(K, aabb(f"dr_door_{i}", a0, 0.13, z1 - 0.002, a0 + 0.57, 0.92, z1 + 0.02, m["steel"], bevel=0.006))
        s.add(K, aabb(f"dr_door_pull_{i}", a0 + 0.24, 0.84, z1 + 0.018, a0 + 0.33, 0.86, z1 + 0.034, m["chrome"], bevel=0.004))
    s.add(K, aabb("dr_top", x0, 0.96, z0, x1, y1, z1 + 0.02, m["terrazzo"], bevel=0.004))
    # Fountain tower.
    fx0, fx1 = 4.35, 5.65
    fz0, fz1 = 0.72, 1.12
    s.add(K, aabb("dr_tower", fx0, y1, fz0, fx1, 1.78, fz1, m["steel"], bevel=0.012))
    s.add(K, aabb("dr_bin_lid", fx0 + 0.02, 1.78, fz0 + 0.02, fx1 - 0.02, 1.8, fz1 - 0.02, m["black_metal"], bevel=0.006))
    panel = image_plane("dr_panel", ((fx0 + fx1) / 2, 1.55, fz1 + 0.0015), fx1 - fx0 - 0.06, 0.4, (0, 0, 1), image_material("fountain_panel", gfx["fountain_panel"], rough=0.2, emission=2.2))
    s.add("unbaked", panel)
    # Valves with push levers.
    for i in range(6):
        x = fx0 + 0.11 + i * ((fx1 - fx0) - 0.22) / 5
        s.add(K, aabb(f"dr_valve_{i}", x - 0.045, 1.24, fz1 - 0.01, x + 0.045, 1.33, fz1 + 0.07, m["black_metal"], bevel=0.01, cull_bottom=False))
        s.add(K, bl.cylinder(f"dr_nozzle_{i}", (x, 1.225, fz1 + 0.035), 0.012, 0.03, m["chrome"], segments=12))
        s.add(K, aabb(f"dr_lever_{i}", x - 0.02, 1.13, fz1 + 0.065, x + 0.02, 1.24, fz1 + 0.075, m["chrome"], bevel=0.004, cull_bottom=False))
    # Drip tray with grate.
    s.add(K, aabb("dr_drip", fx0 + 0.02, y1, fz1, fx1 - 0.02, y1 + 0.03, fz1 + 0.16, m["steel"], bevel=0.004, cull_bottom=False))
    for k in range(24):
        x = fx0 + 0.05 + k * (fx1 - fx0 - 0.1) / 23
        s.add(K, aabb(f"dr_grate_{k}", x - 0.004, y1 + 0.03, fz1 + 0.01, x + 0.004, y1 + 0.034, fz1 + 0.15, m["chrome"], cull_bottom=False))
    # Cup dispensers and lid/straw organiser.
    for i, (x, r) in enumerate(((4.18, 0.045), (5.82, 0.05))):
        s.add(K, bl.lathe(f"dr_cups_{i}", [(0.0, 0.0), (r * 0.7, 0.0), (r, 0.42), (0.0, 0.42)], (x, y1, 1.15), bl.solid("cup_paper", (0.95, 0.94, 0.92), 0.5), segments=24))
    s.add(K, aabb("dr_organiser", 4.12, y1, 0.7, 4.32, y1 + 0.18, 0.95, m["black_metal"], bevel=0.008, cull_bottom=False))


def service_counter(s, gfx) -> None:
    """Front counter (both runs): walnut slats to the dining room, terrazzo top, stainless pass."""
    m = s.m
    pz = 0.35
    for cid in ("counter_front_a", "counter_front_b"):
        b = s.box(cid)
        x0, _, z0, x1, y1, z1 = b
        # Toe kick (black, recessed) and slat cladding on the dining side.
        s.add("dining", aabb(f"{cid}_kick", x0, 0.0, z0 + 0.06, x1, 0.1, z0 + 0.08, m["baseboard"]))
        s.add("dining", aabb(f"{cid}_body", x0, 0.1, z0 + 0.02, x1, 0.96, z1 - 0.02, m["walnut_slats"], uv=(0.6, 0.6)))
        n = int((x1 - x0) / 0.06)
        for k in range(n):
            x = x0 + 0.015 + k * (x1 - x0 - 0.03) / max(1, n - 1)
            s.add("dining", aabb(f"{cid}_slat_{k}", x - 0.022, 0.1, z0 - 0.0, x + 0.022, 0.955, z0 + 0.025, m["oak"], bevel=0.004))
        # Kitchen face: stainless panel with an open shelf.
        s.add(K, aabb(f"{cid}_kface", x0, 0.0, z1 - 0.02, x1, 0.96, z1, m["steel"]))
        # Terrazzo top with a slight overhang to the dining room.
        s.add("dining", aabb(f"{cid}_top", x0, 0.96, z0 - 0.04, x1, y1, z1 + 0.02, m["terrazzo"], bevel=0.006))
        s.add("dining", aabb(f"{cid}_brass", x0, 0.945, z0 - 0.042, x1, 0.96, z0 - 0.03, m["brass"], cull_bottom=False))
    # Stainless pass shelf inset under the heat lamp.
    pk = s.layout["PICKUP_ZONE"]
    s.add(K, aabb("pass_shelf", pk["minX"] - 0.05, 1.0, pk["minZ"] - 0.02, pk["maxX"] + 0.05, 1.006, pk["maxZ"] + 0.02, m["steel"], bevel=0.002, cull_bottom=False))
    # Heat lamp housing, posts and ticket rail.
    hx0, hy0, hz0, hx1, hy1, hz1 = s.box("heat_lamp")
    s.add(K, aabb("hl_housing", hx0, hy0 + 0.01, hz0, hx1, hy1, hz1, m["steel"], bevel=0.01))
    for x in (hx0 + 0.02, hx1 - 0.02):
        s.add(K, bl.cylinder(f"hl_post_{x:.2f}", (x, (1.0 + hy0) / 2, 0.0), 0.016, hy0 - 1.0, m["steel"], segments=16))
        s.add(K, bl.cylinder(f"hl_post_base_{x:.2f}", (x, 1.01, 0.0), 0.04, 0.012, m["steel"], segments=20))
    for dz in (-0.08, 0.08):
        rod = bl.cylinder(f"hl_element_{dz}", ((hx0 + hx1) / 2, hy0 + 0.0, dz), 0.009, hx1 - hx0 - 0.08, emitter("heat_element", (1.0, 0.42, 0.12), 14.0), axis="x", segments=12)
        kit.no_light_contribution(rod)
        s.add("unbaked", rod)
    s.add(K, aabb("hl_reflector", hx0 + 0.02, hy0 + 0.005, hz0 + 0.02, hx1 - 0.02, hy0 + 0.012, hz1 - 0.02, bl.solid("reflector", (0.9, 0.9, 0.92), 0.12, 1.0), cull_bottom=False))
    area_light("heat_lamp_light", ((hx0 + hx1) / 2, hy0 - 0.012, 0.0), (hx1 - hx0 - 0.1, 0.22), 90.0, (1.0, 0.5, 0.22), spread=95)
    tx0, ty0, tz0, tx1, ty1, tz1 = s.box("ticket_rail")
    s.add(K, prism("ticket_rail", [(tz0, ty0), (tz1, ty0), (tz1, ty1), (tz0 + 0.012, ty1), (tz0 + 0.012, ty0 + 0.01), (tz0, ty0 + 0.01)], "zy", tx0, tx1 - tx0, m["steel"]))
    for x in (tx0 + 0.02, tx1 - 0.02):
        s.add(K, aabb(f"ticket_bracket_{x:.2f}", x - 0.01, hy1, 0.15, x + 0.01, ty0 + 0.01, tz1, m["steel"], cull_bottom=False))
    # POS register on the counter.
    rx0, ry0, rz0, rx1, ry1, rz1 = s.box("register")
    rc = ((rx0 + rx1) / 2, ry0, (rz0 + rz1) / 2)
    s.add("dining", aabb("pos_base", rx0 + 0.02, ry0, rz0 + 0.04, rx1 - 0.02, ry0 + 0.03, rz1 - 0.04, m["black_metal"], bevel=0.008, cull_bottom=False))
    s.add("dining", aabb("pos_neck", rc[0] - 0.03, ry0 + 0.03, rc[2] - 0.02, rc[0] + 0.03, ry0 + 0.12, rc[2] + 0.02, m["black_metal"], bevel=0.006, cull_bottom=False))
    scr = aabb("pos_screen", rc[0] - 0.17, ry0 + 0.1, rc[2] - 0.012, rc[0] + 0.17, ry0 + 0.32, rc[2] + 0.012, m["black_metal"], bevel=0.008, cull_bottom=False)
    scr.rotation_euler.x = math.radians(-20)
    s.add("dining", scr)
    s.add("dining", aabb("pos_reader", rx1 - 0.02, ry0, rz0 - 0.02, rx1 + 0.08, ry0 + 0.04, rz0 + 0.12, m["black_metal"], bevel=0.01, cull_bottom=False))
    # Napkin dispenser and a tip jar on the dining side of the counter.
    s.add("dining", aabb("napkin_disp", -4.6, 1.0, -0.25, -4.45, 1.14, -0.13, m["chrome"], bevel=0.01, cull_bottom=False))
    s.add("dining", bl.lathe("tip_jar", [(0.0, 0.0), (0.055, 0.0), (0.06, 0.01), (0.06, 0.15), (0.052, 0.17), (0.052, 0.18), (0.0, 0.18)], (-2.9, 1.0, -0.2), bl.solid("jar_glass", (0.85, 0.9, 0.88), 0.05, alpha=0.35), segments=28))
    # Menu board frame (content is drawn live by the client) with a backlight.
    mb = (-3.2, 2.3, 0.36)
    w, h = 2.6, 1.1
    for z, face in ((0.4, 1), (0.32, -1)):
        pass
    s.add(K, aabb("menu_case_top", mb[0] - w / 2 - 0.04, mb[1] + h / 2, 0.3, mb[0] + w / 2 + 0.04, mb[1] + h / 2 + 0.04, 0.42, m["black_metal"], bevel=0.006, cull_bottom=False))
    s.add(K, aabb("menu_case_bot", mb[0] - w / 2 - 0.04, mb[1] - h / 2 - 0.04, 0.3, mb[0] + w / 2 + 0.04, mb[1] - h / 2, 0.42, m["black_metal"], bevel=0.006, cull_bottom=False))
    for x in (mb[0] - w / 2 - 0.04, mb[0] + w / 2):
        s.add(K, aabb(f"menu_case_side_{x:.1f}", x, mb[1] - h / 2, 0.3, x + 0.04, mb[1] + h / 2, 0.42, m["black_metal"], bevel=0.006, cull_bottom=False))
    for x in (mb[0] - w / 2 + 0.2, mb[0] + w / 2 - 0.2):
        s.add(K, bl.tube(f"menu_cable_{x:.1f}", [(x, mb[1] + h / 2 + 0.04, 0.36), (x, 2.88, 0.36)], 0.0015, m["chrome"]))
    # Light emitted by both faces of the lightbox.
    for face in (1, -1):
        area_light(f"menu_glow_{face}", (mb[0], mb[1], 0.36 + face * 0.07), (w, h), 22.0, (1.0, 0.92, 0.8), facing=(0, 0, face), up=(0, 1, 0), spread=170)


def build(s) -> None:
    gfx = build_graphics()
    s.gfx = gfx
    griddle(s, s.box("grill"))
    hood(s, s.box("grill_hood"))
    prep_table(s, s.box("prep_counter"), s.layout["CHILLER_DRAWER"])
    fryer(s, s.box("fryer"))
    reach_in(s, s.box("walk_in"))
    dry_storage(s, s.box("dry_storage"), gfx)
    office(s, s.box("office_desk"), gfx)
    island(s, s.box("assembly_island"))
    sink(s, s.box("sink"))
    trash_can(s, s.box("trash"))
    drinks(s, s.box("drinks"), gfx)
    service_counter(s, gfx)
    # Anti-fatigue mats in front of the line and the island.
    s.add(K, aabb("mat_line", -1.4, 0.0, 3.25, 1.4, 0.014, 4.05, s.m["rubber_mat"], bevel=0.006, cull_bottom=True))
