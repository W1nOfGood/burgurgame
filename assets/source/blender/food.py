"""Hero food, tools and service items as individual meshes in item-local space.

Origins sit at the centre of each item's physics shape (packages/data ITEMS), +Y up. Materials
are named by role so the client can attach the cooking-state shader (see
apps/client/src/game/food.ts): e.g. 'food_patty' blends raw -> seared by replicated cookA/cookB.

    python assets/source/blender/food.py [--preview]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(__file__))

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Vector, noise  # noqa: E402

from ahb import bl, foodtex, kit  # noqa: E402
from ahb.graphics import build_all as build_graphics  # noqa: E402
from ahb.library import BUILD, ROOT  # noqa: E402

LAYOUT = json.load(open(os.path.join(ROOT, "assets", "source", "layout.json")))
ITEMS = LAYOUT["ITEMS"]
OUT = os.path.join(ROOT, "apps", "client", "public", "assets", "food")


# ----------------------------------------------------------------------------------------------
# Mesh helpers (item-local game space: x right, y up, z forward)


def revolve(name: str, profile: list[tuple[float, float]], segments: int, displace=None, mats: list | None = None, mat_of=None) -> bpy.types.Object:
    """Revolves a (radius, y) profile; ``displace(x, y, z, theta, t) -> (x, y, z)`` perturbs
    vertices (t = position along the profile 0..1). ``mat_of(t) -> index`` assigns materials."""
    bm = bmesh.new()
    rows = []
    n = len(profile)
    for i, (r, y) in enumerate(profile):
        t = i / (n - 1)
        row = []
        for j in range(segments):
            th = j / segments * 2 * math.pi
            x, z = r * math.cos(th), r * math.sin(th)
            yy = y
            if displace:
                x, yy, z = displace(x, y, z, th, t)
            row.append(bm.verts.new(bl.G(x, yy, z)))
        rows.append(row)
    uvl = bm.loops.layers.uv.new("UVMap")
    for i in range(n - 1):
        for j in range(segments):
            j2 = (j + 1) % segments
            f = bm.faces.new((rows[i][j], rows[i][j2], rows[i + 1][j2], rows[i + 1][j]))
            if mat_of:
                f.material_index = mat_of((i + 0.5) / (n - 1))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = bl._obj_from_bm(name, bm, None, None)
    for m in mats or []:
        obj.data.materials.append(m)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def planar_uv(obj: bpy.types.Object, size: float, faces=None, center=(0.0, 0.0)) -> None:
    """Top-down projection (game x/z) onto UVs: one texture repeat covers ``size`` metres."""
    me = obj.data
    if "UVMap" not in me.uv_layers:
        me.uv_layers.new(name="UVMap")
    uv = me.uv_layers["UVMap"].data
    for p in me.polygons:
        if faces is not None and not faces(p):
            continue
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            gx, gz = -co.x, -co.y
            uv[li].uv = ((gx - center[0]) / size + 0.5, (gz - center[1]) / size + 0.5)


def side_uv(obj: bpy.types.Object, size: float, faces) -> None:
    """Cylindrical projection for side bands."""
    me = obj.data
    uv = me.uv_layers["UVMap"].data
    for p in me.polygons:
        if not faces(p):
            continue
        ths = []
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            ths.append(math.atan2(-co.y, -co.x))
        ref = ths[0]
        for li, th in zip(p.loop_indices, ths):
            co = me.vertices[me.loops[li].vertex_index].co
            if th - ref > math.pi:
                th -= 2 * math.pi
            elif ref - th > math.pi:
                th += 2 * math.pi
            r = math.hypot(co.x, co.y)
            uv[li].uv = (th * 0.06 / size, co.z / size + 0.5)


def tex(path: str, colorspace: str = "sRGB"):
    return bl.image(path, colorspace)


def pbr_tex(name: str, albedo: str, *, normal: str | None = None, rough: float = 0.5, rough_map: str | None = None, alpha: bool = False, coat: float = 0.0, sss: float = 0.0, metal: float = 0.0, normal_strength: float = 1.0) -> bpy.types.Material:
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for nd in list(nt.nodes):
        nt.nodes.remove(nd)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs[0], out.inputs[0])
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = "UVMap"
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = tex(albedo)
    nt.links.new(uvn.outputs[0], t.inputs[0])
    nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    if alpha:
        nt.links.new(t.outputs["Alpha"], b.inputs["Alpha"])
        mat.surface_render_method = "DITHERED"
    if normal:
        nm = nt.nodes.new("ShaderNodeTexImage")
        nm.image = tex(normal, "Non-Color")
        nt.links.new(uvn.outputs[0], nm.inputs[0])
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nmap.uv_map = "UVMap"
        nmap.inputs["Strength"].default_value = normal_strength
        nt.links.new(nm.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs[0], b.inputs["Normal"])
    if rough_map:
        rm = nt.nodes.new("ShaderNodeTexImage")
        rm.image = tex(rough_map, "Non-Color")
        nt.links.new(uvn.outputs[0], rm.inputs[0])
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(rm.outputs["Color"], sep.inputs[0])
        nt.links.new(sep.outputs["Green"], b.inputs["Roughness"])
    else:
        b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if coat:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = 0.15
    if sss:
        b.inputs["Subsurface Weight"].default_value = sss
        b.inputs["Subsurface Radius"].default_value = (0.004, 0.002, 0.001)
    return mat


def n3(x: float, y: float, z: float, f: float, seed: float = 0.0) -> float:
    return noise.noise(Vector((x * f + seed, y * f - seed * 0.7, z * f + seed * 1.3)))


# ----------------------------------------------------------------------------------------------
# Food


def patty(t, veggie: bool = False) -> bpy.types.Object:
    d = ITEMS["veggie_patty" if veggie else "patty"]["shape"]
    R, H = d["radius"], d["halfHeight"]
    prof = []
    # Top cap (centre -> edge), rounded rim, side, bottom cap (edge -> centre).
    for i in range(9):
        r = R * 0.94 * (i / 8) ** 0.85
        prof.append((r, H * (0.98 - 0.1 * (i / 8) ** 2)))
    for i in range(1, 8):
        a = i / 8 * math.pi
        prof.append((R * 0.94 + R * 0.06 * math.sin(a), H * 0.88 * math.cos(a)))
    for i in range(8, -1, -1):
        r = R * 0.95 * (i / 8) ** 0.85
        prof.append((r, -H * (0.99 - 0.04 * (i / 8) ** 2)))
    seed = 3.1 if veggie else 1.7

    def disp(x, y, z, th, tt):
        edge = 1 + 0.05 * n3(math.cos(th), math.sin(th), 0.0, 1.6, seed) + 0.018 * n3(math.cos(th), math.sin(th), 0, 7, seed)
        x, z = x * edge, z * edge
        top = y > 0
        lump = 0.0014 * n3(x, y, z, 140, seed) + 0.0006 * n3(x, y, z, 380, seed)
        y = y + (lump if top else lump * 0.35)
        return x, y, z

    o = revolve("patty" if not veggie else "veggie_patty", prof, 72, disp, [t["veggie_patty" if veggie else "patty"]])
    planar_uv(o, 0.12)
    side_uv(o, 0.12, lambda p: abs(p.normal.z) < 0.6)
    return o


def bun(t, top: bool) -> bpy.types.Object:
    d = ITEMS["bun_top" if top else "bun_bottom"]["shape"]
    R, H = d["radius"], d["halfHeight"]
    prof = []
    if top:
        # Dome (crust) from the crown down to the rim, then the cut face (crumb) back to centre.
        for i in range(14):
            a = i / 13
            r = R * math.sin(a * math.pi / 2) * (0.985 + 0.015 * a)
            y = -H + 2 * H * math.cos(a * math.pi / 2) ** 0.85 * 0.98 + 0.002
            prof.append((r, y))
        prof.append((R * 0.995, -H + 0.004))
        prof.append((R * 0.97, -H))
        for i in range(6, -1, -1):
            prof.append((R * 0.95 * i / 6, -H - 0.0006 * math.sin(i / 6 * math.pi)))
        split = 14 / (len(prof) - 1)
    else:
        # Cut face (crumb) from centre to edge, then side and base (crust).
        for i in range(7):
            prof.append((R * 0.95 * i / 6, H - 0.0006 * math.sin(i / 6 * math.pi)))
        prof.append((R * 0.98, H - 0.001))
        for i in range(1, 9):
            a = i / 8 * math.pi
            prof.append((R * 0.98 + R * 0.03 * math.sin(a), H * math.cos(a) * 0.96))
        for i in range(6, -1, -1):
            prof.append((R * 0.96 * i / 6, -H + 0.0015 * (1 - i / 6)))
        split = 7.5 / (len(prof) - 1)
    seed = 5.5 if top else 6.6

    def disp(x, y, z, th, tt):
        k = 1 + 0.012 * n3(math.cos(th), math.sin(th), 0, 2.5, seed)
        bump = 0.0008 * n3(x, y, z, 60, seed)
        return x * k, y + bump * (1 if (tt < split) == top else 0.3), z * k

    crust, crumb = t["bun_crust"], t["bun_crumb"]
    if top:
        o = revolve("bun_top", prof, 64, disp, [crust, crumb], lambda tt: 0 if tt < split else 1)
    else:
        o = revolve("bun_bottom", prof, 64, disp, [crumb, crust], lambda tt: 0 if tt < split else 1)
    planar_uv(o, 0.13)
    if top:
        # Sesame seeds scattered over the crown.
        rnd = random.Random(42)
        seeds = []
        for k in range(70):
            a = rnd.uniform(0, 2 * math.pi)
            rr = R * 0.82 * math.sqrt(rnd.random())
            frac = rr / R
            yy = -H + 2 * H * math.cos(math.asin(min(0.999, frac)) ) ** 0.85 * 0.98 + 0.002
            sd = bl.lathe(f"seed_{k}", [(0.0, -0.0006), (0.0011, -0.0004), (0.0013, 0.0), (0.0011, 0.0004), (0.0, 0.0007)], (0, 0, 0), t["sesame"], segments=8)
            sd.scale = (1.0, 1.7, 1.0)
            nrm = Vector((-math.cos(a) * frac * 0.8, -math.sin(a) * frac * 0.8, 1.0)).normalized()
            sd.rotation_euler = Vector((0, 0, 1)).rotation_difference(nrm).to_euler()
            sd.rotation_euler.z += rnd.uniform(0, math.pi)
            sd.location = bl.G(math.cos(a) * rr, yy + 0.0003, math.sin(a) * rr)
            seeds.append(sd)
        sj = bl.join(seeds, "seeds")
        o = bl.join([o, sj], "bun_top")
    return o


def slab_square(name: str, half: float, thick: float, mat, subdiv: int = 18) -> bpy.types.Object:
    """Cheese slice: a thin square slab with softened corners, grid-subdivided for melting."""
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=subdiv, y_segments=subdiv, size=half)
    for v in bm.verts:
        x, y = v.co.x, v.co.y
        # Soften the corners.
        k = max(abs(x), abs(y)) / half
        if k > 0.82:
            v.co.x *= 1 - 0.02 * (k - 0.82) / 0.18
            v.co.y *= 1 - 0.02 * (k - 0.82) / 0.18
    ext = bmesh.ops.extrude_face_region(bm, geom=bm.faces[:])
    verts = [e for e in ext["geom"] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=verts, vec=(0, 0, thick))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, -thick / 2))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = bl._obj_from_bm(name, bm, mat, None)
    for p in o.data.polygons:
        p.use_smooth = True
    planar_uv(o, half * 2)
    return o


def lettuce(t) -> bpy.types.Object:
    R = ITEMS["lettuce"]["shape"]["radius"] + 0.006
    bm = bmesh.new()
    rings, seg = 10, 72
    rows = []
    for i in range(rings + 1):
        rr = R * i / rings
        row = []
        for j in range(seg if i else 1):
            th = j / seg * 2 * math.pi
            edge = 1 + 0.09 * n3(math.cos(th), math.sin(th), 0, 3, 2.2) + 0.04 * math.sin(th * 13)
            r = rr * edge
            x, z = r * math.cos(th), r * math.sin(th)
            ruffle = (i / rings) ** 2.2 * (0.006 * math.sin(th * 17 + 1.3) + 0.004 * n3(x, 0, z, 90, 1.0))
            cup = 0.004 * (i / rings) ** 2
            row.append(bm.verts.new(bl.G(x, ruffle + cup, z)))
        rows.append(row)
    for j in range(seg):
        bm.faces.new((rows[0][0], rows[1][j], rows[1][(j + 1) % seg]))
    for i in range(1, rings):
        for j in range(seg):
            j2 = (j + 1) % seg
            bm.faces.new((rows[i][j], rows[i + 1][j], rows[i + 1][j2], rows[i][j2]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = bl._obj_from_bm("lettuce", bm, t["lettuce"], None)
    for p in o.data.polygons:
        p.use_smooth = True
    planar_uv(o, R * 2.2)
    return o


def disc_slice(name: str, radius: float, half_h: float, top_mat, side_mat, *, seg: int = 48, wobble: float = 0.02, crinkle: float = 0.0, seed: float = 1.0) -> bpy.types.Object:
    prof = [(0.0, half_h), (radius * 0.5, half_h), (radius * 0.97, half_h), (radius, half_h * 0.6), (radius, -half_h * 0.6), (radius * 0.97, -half_h), (radius * 0.5, -half_h), (0.0, -half_h)]

    def disp(x, y, z, th, tt):
        k = 1 + wobble * n3(math.cos(th), math.sin(th), 0, 2.0, seed) + crinkle * math.sin(th * 18)
        return x * k, y + 0.0003 * n3(x, y, z, 200, seed), z * k

    o = revolve(name, prof, seg, disp, [top_mat, side_mat], lambda tt: 1 if 0.3 < tt < 0.7 else 0)
    planar_uv(o, radius * 2)
    return o


def tomato(t) -> bpy.types.Object:
    d = ITEMS["tomato"]["shape"]
    return disc_slice("tomato", d["radius"], d["halfHeight"], t["tomato"], t["tomato_skin"], wobble=0.03, seed=2.0)


def onion(t) -> bpy.types.Object:
    d = ITEMS["onion"]["shape"]
    return disc_slice("onion", d["radius"], d["halfHeight"], t["onion"], t["onion_skin"], wobble=0.04, seed=3.0)


def chips(name: str, count: int, radius: float, half_h: float, top, side, spread: float, crinkle: float, seed: int) -> bpy.types.Object:
    rnd = random.Random(seed)
    parts = []
    for i in range(count):
        p = disc_slice(f"{name}_{i}", radius * rnd.uniform(0.9, 1.08), half_h, top, side, seg=40, wobble=0.04, crinkle=crinkle, seed=seed + i)
        a = i * 2 * math.pi / count + rnd.uniform(-0.3, 0.3)
        p.location = bl.G(math.cos(a) * spread, 0.0006 * i, math.sin(a) * spread)
        p.rotation_euler = (rnd.uniform(-0.06, 0.06), rnd.uniform(-0.06, 0.06), rnd.uniform(0, 6.3))
        parts.append(p)
    return bl.join(parts, name)


def bacon(t) -> bpy.types.Object:
    hx, hy, hz = ITEMS["bacon"]["shape"]["half"]
    bm = bmesh.new()
    nx, nz = 40, 6
    grid = []
    for i in range(nx + 1):
        row = []
        for j in range(nz + 1):
            x = -hx + 2 * hx * i / nx
            z = -hz + 2 * hz * j / nz
            wav = 0.0045 * math.sin(x * 62 + 0.6) + 0.0012 * math.sin(x * 150 + z * 40)
            edge_ruffle = 0.0015 * (abs(z) / hz) ** 3 * math.sin(x * 210)
            zz = z * (1 + 0.06 * n3(x, 0, 0, 30, 4.0))
            row.append(bm.verts.new(bl.G(x, wav + edge_ruffle, zz)))
        grid.append(row)
    uvl = bm.loops.layers.uv.new("UVMap")
    for i in range(nx):
        for j in range(nz):
            f = bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
            for loop in f.loops:
                v = loop.vert
                ii = grid_index(grid, v)
                loop[uvl].uv = (ii[0] / nx, ii[1] / nz)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    sol = bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.003)
    o = bl._obj_from_bm("bacon", bm, t["bacon"], None)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def grid_index(grid, v):
    for i, row in enumerate(grid):
        for j, w in enumerate(row):
            if w is v:
                return i, j
    return 0, 0


def egg(t) -> bpy.types.Object:
    d = ITEMS["egg"]["shape"]
    R = d["radius"]
    prof = [(0.0, 0.0025), (R * 0.5, 0.0024), (R * 0.85, 0.0018), (R * 0.97, 0.0008), (R, -0.0012), (R * 0.97, -0.0024), (0.0, -0.0026)]

    def disp(x, y, z, th, tt):
        k = 1 + 0.12 * n3(math.cos(th), math.sin(th), 0, 1.8, 7.0) + 0.04 * n3(math.cos(th), math.sin(th), 0, 6, 7.0)
        return x * k + 0.006, y + 0.0004 * n3(x, y, z, 120, 7), z * k - 0.004

    white = revolve("egg_white", prof, 64, disp, [t["egg_white"]])
    planar_uv(white, R * 2.4)
    yolk = bl.lathe("egg_yolk", [(0.0, 0.0105), (0.008, 0.0098), (0.013, 0.0078), (0.016, 0.0045), (0.0175, 0.001), (0.017, -0.001), (0.0, -0.001)], (0.004, 0.0015, -0.003), t["egg_yolk"], segments=40, smooth_angle=80)
    bl.ensure_uv(yolk)
    return bl.join([white, yolk], "egg")


def mushrooms(t) -> bpy.types.Object:
    rnd = random.Random(9)
    parts = []
    for i in range(6):
        # Slice outline: rounded cap over a short stem, extruded 5 mm.
        pts = []
        for k in range(17):
            a = math.pi * k / 16
            pts.append((math.cos(a) * 0.022, 0.006 + math.sin(a) * 0.016))
        pts += [(-0.02, 0.004), (-0.007, 0.004), (-0.006, -0.012), (0.006, -0.012), (0.007, 0.004), (0.02, 0.004)]
        bm = bmesh.new()
        v0 = [bm.verts.new((x, 0.0, y)) for x, y in pts]
        f = bm.faces.new(v0)
        ext = bmesh.ops.extrude_face_region(bm, geom=[f])
        vv = [e for e in ext["geom"] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.translate(bm, verts=vv, vec=(0, 0.005, 0))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=0.0008, segments=1, affect="EDGES", clamp_overlap=True)
        uvl = bm.loops.layers.uv.new("UVMap")
        for face in bm.faces:
            for loop in face.loops:
                loop[uvl].uv = (loop.vert.co.x / 0.05 + 0.5, (loop.vert.co.z + 0.012) / 0.034)
        o = bl._obj_from_bm(f"mush_{i}", bm, t["mushroom"], None)
        # Lie flat, scattered.
        o.rotation_euler = (math.pi / 2 + rnd.uniform(-0.08, 0.08), 0, rnd.uniform(0, 6.28))
        a = i * 1.1
        o.location = bl.G(math.cos(a) * 0.018, -0.003 + i * 0.0012, math.sin(a) * 0.018)
        parts.append(o)
    return bl.join(parts, "mushroom")


# ----------------------------------------------------------------------------------------------
# Tools and service items


def tray(t) -> bpy.types.Object:
    hx, hy, hz = ITEMS["tray"]["shape"]["half"]
    base = kit.aabb("tray_base", -hx, -hy, -hz, hx, -hy + 0.004, hz, t["tray"], bevel=0.003, cull_bottom=False, uv=1.0)
    rims = []
    prof = [(0.0, -hy), (0.012, -hy), (0.018, hy), (0.008, hy + 0.002), (0.0, hy)]
    for name, (x0, z0, x1, z1) in {"n": (-hx, hz - 0.018, hx, hz), "s": (-hx, -hz, hx, -hz + 0.018), "e": (hx - 0.018, -hz, hx, hz), "w": (-hx, -hz, -hx + 0.018, hz)}.items():
        rims.append(kit.aabb(f"tray_rim_{name}", x0, -hy, z0, x1, hy, z1, t["tray"], bevel=0.006, segments=3, cull_bottom=False, uv=1.0))
    o = bl.join([base, *rims], "tray_body")
    for p in o.data.polygons:
        p.use_smooth = True
    liner = kit.quad("tray_liner", [(-0.155, -hy + 0.0045, -0.11), (0.155, -hy + 0.0045, -0.11), (0.155, -hy + 0.0045, 0.11), (-0.155, -hy + 0.0045, 0.11)], (0, 1, 0), t["liner"], uv=1.0)
    me = liner.data
    uv = me.uv_layers["UVMap"].data
    for p in me.polygons:
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            uv[li].uv = ((-co.x + 0.155) / 0.31, 1 - (-co.y + 0.11) / 0.22)
    return bl.join([o, liner], "tray")


def spatula(t) -> bpy.types.Object:
    """Offset turner: slotted stainless blade, bent tang, walnut handle with brass rivets."""
    parts = []
    th = 0.0018
    bz0, bz1 = -0.01, 0.14
    bw = 0.05
    parts.append(kit.aabb("sp_tip", -bw, -th, bz1 - 0.035, bw, 0.0, bz1, t["steel"], cull_bottom=False, uv=0.2))
    parts.append(kit.aabb("sp_heel", -bw, -th, bz0, bw, 0.0, bz0 + 0.02, t["steel"], cull_bottom=False, uv=0.2))
    slots = 4
    for k in range(slots + 1):
        x = -bw + k * (2 * bw) / slots
        w = 0.008 if 0 < k < slots else 0.006
        x0 = x - w / 2 if 0 < k < slots else (x if k == 0 else x - w)
        parts.append(kit.aabb(f"sp_bar_{k}", x0, -th, bz0 + 0.02, x0 + w, 0.0, bz1 - 0.035, t["steel"], cull_bottom=False, uv=0.2))
    # Bevelled front edge.
    parts.append(kit.prism("sp_edge", [(bz1, -th), (bz1 + 0.006, -th), (bz1, 0.0)], "zy", -bw, 2 * bw, t["steel"]))
    # Offset tang: up and back.
    parts.append(bl.tube("sp_tang", [(0, -0.0008, bz0 + 0.005), (0, 0.004, bz0 - 0.02), (0, 0.022, bz0 - 0.05), (0, 0.026, bz0 - 0.07)], 0.004, t["steel"]))
    handle = bl.lathe("sp_handle", [(0.0, 0.0), (0.009, 0.0), (0.0115, 0.01), (0.0125, 0.06), (0.0118, 0.1), (0.0095, 0.118), (0.0, 0.12)], (0, 0, 0), t["walnut"], segments=20)
    handle.rotation_euler = (math.pi / 2, 0, 0)
    handle.location = bl.G(0, 0.027, bz0 - 0.065)
    bl.transform_apply(handle)
    bl.ensure_uv(handle)
    parts.append(handle)
    for k, zz in enumerate((bz0 - 0.09, bz0 - 0.14)):
        parts.append(bl.cylinder(f"sp_rivet_{k}", (0, 0.027, zz), 0.003, 0.026, t["brass"], axis="x", segments=10))
    for p in parts:
        bl.ensure_uv(p)
    return bl.join(parts, "spatula")


def bottle(t, kind: str, sauce: str) -> bpy.types.Object:
    d = ITEMS[kind]["shape"]
    R, H = d["radius"], d["halfHeight"]
    body = bl.lathe(f"{kind}_body", [(0.0, -H), (R * 0.85, -H), (R * 0.97, -H + 0.004), (R, -H + 0.015), (R, H - 0.06), (R * 0.97, H - 0.045), (R * 0.82, H - 0.035), (R * 0.55, H - 0.03), (0.0, H - 0.03)], (0, 0, 0), t[f"bottle_{sauce}"], segments=32, smooth_angle=70)
    cap = bl.lathe(f"{kind}_cap", [(0.0, H - 0.032), (R * 0.6, H - 0.032), (R * 0.62, H - 0.018), (R * 0.4, H - 0.012), (0.006, H - 0.004), (0.0045, H + 0.005), (0.002, H + 0.008), (0.0, H + 0.008)], (0, 0, 0), t[f"cap_{sauce}"], segments=24, smooth_angle=60)
    band = bl.lathe(f"{kind}_label", [(R + 0.0006, -H + 0.03), (R + 0.0006, H - 0.075)], (0, 0, 0), t[f"label_{sauce}"], segments=32, smooth_angle=80)
    me = band.data
    uv = me.uv_layers.new(name="UVMap").data
    for poly in me.polygons:
        ths = [math.atan2(me.vertices[me.loops[li].vertex_index].co.y, me.vertices[me.loops[li].vertex_index].co.x) for li in poly.loop_indices]
        ref = ths[0]
        for li, a in zip(poly.loop_indices, ths):
            if a - ref > math.pi:
                a -= 2 * math.pi
            elif ref - a > math.pi:
                a += 2 * math.pi
            co = me.vertices[me.loops[li].vertex_index].co
            uv[li].uv = ((a / (2 * math.pi)) % 1.0 if abs(a - ref) < 1e-6 else (a / (2 * math.pi)) - math.floor(ref / (2 * math.pi)), (co.z - (-H + 0.03)) / ((H - 0.075) - (-H + 0.03)))
    for p in (body, cap):
        bl.ensure_uv(p)
    return bl.join([body, cap, band], kind)


# ----------------------------------------------------------------------------------------------


def materials() -> dict:
    ft = foodtex.build_all()
    g = build_graphics()
    from ahb.library import material

    t = {}
    t["patty"] = pbr_tex("food_patty", ft["beef"]["raw"], normal=ft["beef"]["normal"], rough=0.38, normal_strength=1.0)
    t["veggie_patty"] = pbr_tex("food_veggie_patty", ft["veggie"]["raw"], normal=ft["veggie"]["normal"], rough=0.5)
    t["bun_crust"] = pbr_tex("food_bun_crust", ft["bun"]["crust"], normal=ft["bun"]["crust_normal"], rough=0.3, coat=0.35)
    t["bun_crumb"] = pbr_tex("food_bun_crumb", ft["bun"]["crumb"], normal=ft["bun"]["crumb_normal"], rough=0.85)
    t["sesame"] = bl.solid("food_sesame", (0.96, 0.9, 0.74), 0.45)
    t["cheese"] = pbr_tex("food_cheese", ft["cheddar"], rough=0.42, sss=0.3)
    t["swiss"] = pbr_tex("food_swiss", ft["swiss"], rough=0.5, alpha=True, sss=0.2)
    t["lettuce"] = pbr_tex("food_lettuce", ft["lettuce"]["albedo"], normal=ft["lettuce"]["normal"], rough=0.38, sss=0.4)
    t["tomato"] = pbr_tex("food_tomato", ft["tomato"], rough=0.22, sss=0.3)
    t["tomato_skin"] = bl.solid("food_tomato_skin", (0.72, 0.08, 0.04), 0.18, coat=0.5)
    t["onion"] = pbr_tex("food_onion", ft["onion"], rough=0.28, sss=0.4)
    t["onion_skin"] = bl.solid("food_onion_skin", (0.62, 0.38, 0.58), 0.35)
    t["pickle"] = pbr_tex("food_pickle", ft["pickle"], rough=0.25)
    t["pickle_skin"] = bl.solid("food_pickle_skin", (0.25, 0.36, 0.1), 0.3)
    t["jalapeno"] = pbr_tex("food_jalapeno", ft["jalapeno"], rough=0.25)
    t["jalapeno_skin"] = bl.solid("food_jalapeno_skin", (0.17, 0.36, 0.1), 0.18, coat=0.5)
    t["bacon"] = pbr_tex("food_bacon", ft["bacon"]["raw"], normal=ft["bacon"]["normal"], rough=0.4)
    t["egg_white"] = pbr_tex("food_egg_white", ft["egg"]["set"], rough=0.2, sss=0.3)
    t["egg_yolk"] = bl.solid("food_egg_yolk", (0.98, 0.62, 0.06), 0.12, coat=0.8)
    t["mushroom"] = pbr_tex("food_mushroom", ft["mushroom"]["raw"], rough=0.6)
    t["tray"] = bl.solid("tray_plastic", (0.62, 0.06, 0.04), 0.32)
    t["liner"] = pbr_tex("tray_liner", ft["liner"], rough=0.9)
    t["steel"] = material("steel")
    t["walnut"] = material("walnut_slats", "walnut_handle")
    t["brass"] = bl.solid("brass", (0.83, 0.66, 0.4), 0.28, 1.0)
    colors = {"house": ((0.95, 0.55, 0.2), (0.96, 0.92, 0.85)), "ketchup": ((0.7, 0.06, 0.04), (0.85, 0.1, 0.06)), "mustard": ((0.93, 0.74, 0.08), (0.95, 0.76, 0.1)), "mayo": ((0.95, 0.93, 0.85), (0.92, 0.92, 0.9)), "bbq": ((0.3, 0.12, 0.05), (0.15, 0.12, 0.1))}
    labels = {"house": "HOUSE", "ketchup": "KETCHUP", "mustard": "MUSTARD", "mayo": "MAYO", "bbq": "BBQ"}
    for sauce, (body, cap) in colors.items():
        t[f"bottle_{sauce}"] = bl.solid(f"bottle_{sauce}", body, 0.28, coat=0.6)
        t[f"cap_{sauce}"] = bl.solid(f"cap_{sauce}", cap, 0.35)
        t[f"label_{sauce}"] = pbr_tex(f"label_{sauce}", bottle_label(labels[sauce], sauce), rough=0.55)
    return t


def bottle_label(text: str, sauce: str) -> str:
    from PIL import Image, ImageDraw, ImageFont

    from ahb.graphics import BLACK, SEMI

    os.makedirs(os.path.join(BUILD, "food"), exist_ok=True)
    W, H = 512, 256
    im = Image.new("RGB", (W, H), (246, 241, 228))
    d = ImageDraw.Draw(im)
    accent = {"house": (220, 120, 40), "ketchup": (176, 30, 24), "mustard": (210, 160, 20), "mayo": (60, 90, 140), "bbq": (80, 40, 20)}[sauce]
    d.rectangle([0, 0, W, 40], fill=accent)
    d.rectangle([0, H - 40, W, H], fill=accent)
    for x0 in (0, W // 2):
        f = ImageFont.truetype(BLACK, 54)
        tw = d.textlength(text, font=f)
        d.text((x0 + (W // 2 - tw) / 2, 92), text, font=f, fill=(34, 28, 26))
        f2 = ImageFont.truetype(SEMI, 18)
        tw = d.textlength("AFTER HOURS", font=f2)
        d.text((x0 + (W // 2 - tw) / 2, 160), "AFTER HOURS", font=f2, fill=accent)
    p = os.path.join(BUILD, "food", f"label_{sauce}.png")
    im.save(p)
    return p


def build() -> list[bpy.types.Object]:
    t = materials()
    objs = [
        patty(t),
        patty(t, veggie=True),
        bun(t, top=False),
        bun(t, top=True),
        slab_square("cheese", ITEMS["cheese"]["shape"]["half"][0], 0.003, t["cheese"]),
        slab_square("swiss", ITEMS["swiss"]["shape"]["half"][0], 0.003, t["swiss"]),
        lettuce(t),
        tomato(t),
        onion(t),
        chips("pickle", 4, 0.017, 0.0022, t["pickle"], t["pickle_skin"], 0.019, 0.025, 11),
        chips("jalapeno", 5, 0.013, 0.002, t["jalapeno"], t["jalapeno_skin"], 0.02, 0.0, 21),
        bacon(t),
        egg(t),
        mushrooms(t),
        tray(t),
        spatula(t),
    ]
    for kind, sauce in (("sauce_bottle", "house"), ("ketchup_bottle", "ketchup"), ("mustard_bottle", "mustard"), ("mayo_bottle", "mayo"), ("bbq_bottle", "bbq")):
        objs.append(bottle(t, kind, sauce))
    for o in objs:
        bl.ensure_uv(o)
        o["kind"] = o.name
    return objs


def preview(objs) -> None:
    """Hero shot: the food laid out on a steel counter under a softbox."""
    os.makedirs(os.path.join(BUILD, "preview"), exist_ok=True)
    from ahb.library import material

    steel = material("steel")
    kit.aabb("counter", -0.6, -0.04, -0.4, 0.6, 0.0, 0.4, steel, uv=0.5)
    order = ["bun_bottom", "patty", "cheese", "lettuce", "tomato", "onion", "pickle", "bun_top", "veggie_patty", "swiss", "bacon", "egg", "mushroom", "jalapeno", "spatula", "ketchup_bottle", "mustard_bottle", "tray"]
    by = {o.name: o for o in objs}
    for i, name in enumerate(order[:14]):
        o = by[name]
        x = -0.45 + (i % 7) * 0.15
        z = -0.1 + (i // 7) * 0.17
        h = ITEMS[name]["shape"].get("halfHeight", ITEMS[name]["shape"].get("half", [0, 0.003, 0])[1] if "half" in ITEMS[name]["shape"] else 0.003)
        o.location = bl.G(x, h + 0.002, z)
    by["spatula"].location = bl.G(0.32, 0.03, 0.25)
    by["ketchup_bottle"].location = bl.G(-0.45, 0.09, 0.25)
    by["mustard_bottle"].location = bl.G(-0.38, 0.09, 0.27)
    by["tray"].location = bl.G(0.0, 0.01, 0.28)
    kit.area_light("soft_key", (0.2, 0.9, -0.4), (0.8, 0.5), 120.0, (1.0, 0.95, 0.88), facing=(-0.2, -1, 0.45), up=(0, 0, 1))
    kit.area_light("soft_fill", (-0.8, 0.5, 0.1), (0.6, 0.6), 30.0, (0.85, 0.9, 1.0), facing=(1, -0.5, 0), up=(0, 1, 0))
    bl.world_color((0.05, 0.05, 0.06), 1.0)
    bl.camera("cam", (0.0, 0.42, -0.62), (0.0, 0.0, 0.02), lens=40)
    bl.render(os.path.join(BUILD, "preview", "food.jpg"), width=1280, height=720, samples=96, exposure=1.0)
    bl.camera("cam2", (-0.32, 0.12, -0.25), (-0.32, 0.01, -0.08), lens=55)
    bl.render(os.path.join(BUILD, "preview", "food_close.jpg"), width=1280, height=720, samples=96, exposure=1.0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true")
    args = ap.parse_args([a for a in sys.argv[1:] if a != "--"])
    bl.reset()
    objs = build()
    if args.preview:
        preview(objs)
        return
    for o in objs:
        o.location = (0, 0, 0)
    bl.export_gltf(os.path.join(OUT, "food.gltf"), objs, image_format="WEBP", quality=88)
    print("[food] exported", OUT)


if __name__ == "__main__":
    main()
