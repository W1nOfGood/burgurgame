"""Rigged first-person hands (bare skin, rolled-up chef-jacket sleeves).

They are sculpted as signed-distance fields on a skeleton, polygonised, skinned by distance to
the bone segments and exported in their rest pose: the client drives the bones procedurally
(finger curl per grip). The skin is textured in texel space
(``ahb/skin.py``): pores, knuckle wrinkles, palm and joint creases, fingerprints and nails all
come from each texel's place on the skeleton, and Cycles renders them with random-walk
subsurface scattering.

    python assets/source/blender/characters.py [--preview]
"""

from __future__ import annotations

import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import bpy  # noqa: E402
import bmesh  # noqa: E402
from mathutils import Matrix  # noqa: E402

from ahb import bl, kit  # noqa: E402
from ahb.library import ART, BUILD  # noqa: E402


# ----------------------------------------------------------------------------------------------
# Rig helpers (also used by people.py)


def add_bone(arm_data, name: str, head, tail, parent=None, roll: float = 0.0):
    b = arm_data.edit_bones.new(name)
    b.head = bl.G(*head)
    b.tail = bl.G(*tail)
    b.roll = roll
    if parent is not None:
        b.parent = arm_data.edit_bones[parent]
        b.use_connect = False
    return b


def rigid_bind(obj: bpy.types.Object, arm_obj: bpy.types.Object, bone: str) -> None:
    """Weights every vertex of ``obj`` fully to one bone (cuffs, nails, cap)."""
    vg = obj.vertex_groups.new(name=bone)
    vg.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    mod = obj.modifiers.new("arm", "ARMATURE")
    mod.object = arm_obj
    obj.parent = arm_obj


# ----------------------------------------------------------------------------------------------
# Hands


FINGER_DEFS = {
    # name: (knuckle (MCP), fan direction, segment lengths, proximal radius)
    "index": ((-0.027, 0.004, 0.092), (-0.12, -0.05, 1.0), (0.042, 0.025, 0.021), 0.0098),
    "middle": ((-0.008, 0.005, 0.097), (-0.03, -0.05, 1.0), (0.046, 0.029, 0.022), 0.0102),
    "ring": ((0.011, 0.004, 0.093), (0.06, -0.05, 1.0), (0.043, 0.027, 0.021), 0.0097),
    "pinky": ((0.028, 0.002, 0.084), (0.15, -0.05, 1.0), (0.034, 0.021, 0.019), 0.0087),
}
THUMB = ((-0.02, -0.008, 0.012), (-0.042, -0.015, 0.042), (-0.056, -0.018, 0.068), (-0.064, -0.017, 0.088))


def lathe_z(name: str, profile: list[tuple[float, float]], mat, *, segments: int = 32, squash: float = 1.0, closed: bool = False) -> bpy.types.Object:
    """Surface of revolution around the game Z axis from (radius, z) pairs; y scaled by squash."""
    bm = bmesh.new()
    rings = []
    for r, z in profile:
        ring = []
        for j in range(segments):
            a = j / segments * 2 * math.pi
            ring.append(bm.verts.new(bl.G(r * math.cos(a), r * math.sin(a) * squash, z)))
        rings.append(ring)
    n = len(rings) if closed else len(rings) - 1
    for i in range(n):
        r0, r1 = rings[i], rings[(i + 1) % len(rings)]
        for j in range(segments):
            j2 = (j + 1) % segments
            bm.faces.new((r0[j], r0[j2], r1[j2], r1[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = bl._obj_from_bm(name, bm, mat, None)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def hand_skeleton(side: int) -> dict[str, tuple[tuple[float, float, float], tuple[float, float, float]]]:
    """Bone segments (game space) of a relaxed, slightly cupped hand; side=1 right, -1 left."""
    import numpy as np

    def m(p):
        return (p[0] * side, p[1], p[2])

    bones = {"forearm": (m((0.0, -0.002, -0.11)), m((0.0, 0.0, 0.0))), "hand": (m((0.0, 0.0, 0.0)), m(FINGER_DEFS["middle"][0]))}
    for name, (mcp, fan, segs, _r) in FINGER_DEFS.items():
        d = np.asarray(fan, dtype=np.float64)
        d /= np.linalg.norm(d)
        p = np.asarray(mcp, dtype=np.float64)
        for i, L in enumerate(segs):
            # Each joint droops a little more: a natural resting curl.
            droop = np.array([0.0, -0.12 * (i + 1), 0.0])
            di = d + droop
            di /= np.linalg.norm(di)
            q = p + di * L
            bones[f"{name}_0{i + 1}"] = (m(tuple(p)), m(tuple(q)))
            p = q
    for i in range(3):
        bones[f"thumb_0{i + 1}"] = (m(THUMB[i]), m(THUMB[i + 1]))
    return bones


THUMB_UP = (-0.62, 0.74, 0.25)  # nail-side direction of the relaxed right thumb
DEPTH = 0.87  # finger depth / width
THUMB_R = ((0.0158, 0.0123), (0.0123, 0.0108), (0.0108, 0.0094))
HAND_TEX = 2048
FAMILIES = ("index", "middle", "ring", "pinky", "thumb")


def finger_frames(bones) -> dict:
    """Per finger: [(a, unit direction, length, dorsal unit vector)] for its three phalanges."""
    import numpy as np

    out = {}
    for fam in FAMILIES:
        segs = []
        for i in range(3):
            a, b = (np.asarray(v, dtype=np.float64) for v in bones[f"{fam}_0{i + 1}"])
            d = b - a
            L = float(np.linalg.norm(d))
            d /= L
            ref = np.asarray(THUMB_UP if fam == "thumb" else (0.0, 1.0, 0.0), dtype=np.float64)
            up = ref - (ref @ d) * d
            up /= np.linalg.norm(up)
            segs.append((a, d, L, up))
        out[fam] = segs
    return out


def finger_radii(fam: str, i: int) -> tuple[float, float]:
    if fam == "thumb":
        return THUMB_R[i]
    r0 = FINGER_DEFS[fam][3]
    return r0 * (1 - 0.085 * i), r0 * (1 - 0.085 * (i + 1))


def hand_sdf(bones):
    """Distance field of a bare right hand on the skeleton (the left hand is its mirror).

    Palm with thenar/hypothenar eminences, pads under the finger bases and a shallow hollow;
    knuckle heads; wrist with the ulnar styloid; phalanges with fleshy palmar pads, bony dorsal
    joints and a flatter nail bed; webs between the finger bases.
    """
    import numpy as np

    from ahb import sdf
    from ahb.skin import smoothstep

    fr = finger_frames(bones)

    def field(P):
        palm = sdf.round_box(P, (0.0, -0.001, 0.048), (0.04, 0.0118, 0.046), 0.011)
        palm = sdf.smin(palm, sdf.ellipsoid(P, (0.0, 0.003, 0.052), (0.04, 0.0133, 0.046)), 0.01)
        palm = sdf.smin(palm, sdf.ellipsoid(P, (-0.026, -0.008, 0.03), (0.019, 0.0125, 0.027)), 0.012)
        palm = sdf.smin(palm, sdf.ellipsoid(P, (0.027, -0.007, 0.042), (0.013, 0.0095, 0.03)), 0.01)
        for mcp, _fan, _segs, r0 in FINGER_DEFS.values():
            palm = sdf.smin(palm, sdf.ellipsoid(P, (mcp[0], mcp[1] - 0.0102, mcp[2] - 0.009), (r0 * 1.02, 0.0056, 0.0118)), 0.007)
            palm = sdf.smin(palm, sdf.ellipsoid(P, (mcp[0], mcp[1] + 0.0048, mcp[2] - 0.004), (r0 * 0.76, 0.0062, 0.0082)), 0.005)
        palm = sdf.smax(palm, -sdf.ellipsoid(P, (0.003, -0.0215, 0.05), (0.024, 0.0085, 0.028)), 0.008)
        Q = P.copy()
        Q[..., 1] = Q[..., 1] * 1.32
        arm = sdf.round_cone(Q, (0.0, -0.001, 0.006), (0.0, -0.004, -0.15), 0.0255, 0.034)
        arm = sdf.smin(arm, sdf.sphere(P, (0.024, 0.005, -0.006), 0.0058), 0.006)
        hand = sdf.smin(palm, arm, 0.016)

        def digit(fam):
            # Segments are hard-unioned: they share the joint sphere, so the union is already
            # smooth, while a smooth union of two nearly coincident surfaces swells every joint
            # by k/4 all the way round (the "string of beads" look). Cross-sections are
            # flattened to DEPTH (fingers are wider than they are deep).
            f = None
            for i, (a, d, L, up) in enumerate(fr[fam]):
                ra, rb = finger_radii(fam, i)
                b = a + d * L
                Pk = P + (((P - a) @ up) * (1.0 / DEPTH - 1.0))[..., None] * up
                seg = sdf.round_cone(Pk, a, b, ra, rb)
                if fam != "thumb" or i > 0:
                    pad = sdf.round_cone(Pk, a + d * L * 0.24 - up * ra * 0.3, a + d * L * 0.76 - up * rb * 0.3, ra * 0.66, rb * 0.66)
                    seg = sdf.smin(seg, pad, 0.003)
                if i > 0:
                    # Low dorsal swell of the PIP / DIP joint; no sideways bulge.
                    seg = sdf.smin(seg, sdf.sphere(Pk, a + up * ra * 0.4, ra * 0.64), 0.003)
                if i == 2:
                    rel = Pk - a
                    w = smoothstep(0.25 * L, 0.5 * L, rel @ d)
                    plane = rel @ up - (rb * 0.9 + (1 - w) * 0.01)
                    seg = sdf.smax(seg, plane, 0.003)
                    seg = sdf.smin(seg, sdf.sphere(Pk, b - d * 0.004 - up * 0.0022, rb * 0.72), 0.003)
                f = seg if f is None else np.minimum(f, seg)
            return f

        fingers = None
        for fam in FAMILIES[:4]:
            f = digit(fam)
            fingers = f if fingers is None else np.minimum(fingers, f)
        hand = sdf.smin(hand, fingers, 0.009)
        names = FAMILIES[:4]
        for n1, n2 in zip(names, names[1:]):
            a1, d1, L1, up1 = fr[n1][0]
            a2, d2, L2, up2 = fr[n2][0]
            web = sdf.capsule(P, a1 + d1 * L1 * 0.28 - up1 * 0.003, a2 + d2 * L2 * 0.28 - up2 * 0.003, 0.0042)
            hand = sdf.smin(hand, web, 0.004)
        hand = sdf.smin(hand, digit("thumb"), 0.012)
        a0, d0, L0, _u = fr["thumb"][0]
        ai, di, _Li, upi = fr["index"][0]
        hand = sdf.smin(hand, sdf.capsule(P, a0 + d0 * L0 * 0.75, ai + di * 0.004 - upi * 0.002, 0.0058), 0.008)
        return hand

    return field


def hand_skin_textures(body: bpy.types.Object, bones, size: int = HAND_TEX) -> dict[str, str]:
    """Albedo, ORM, normal and thickness maps for the right hand, from texel-space anatomy.

    Everything is a function of the texel's rest-pose position on the skeleton: which digit it
    belongs to, how far along it (``s``, metres from the knuckle) and which way it faces
    (``cos_t``: +1 back of the finger, -1 palm side). Heights are metres; the normal map comes
    from a Cycles bump bake of the final height field.
    """
    import time

    import numpy as np
    from PIL import Image

    from ahb import skin
    from ahb.skin import smoothstep

    t0 = time.time()
    R = skin.rasterize(body, size)
    M = R["mask"]
    P = R["P"][M]
    Nn = R["N"][M]
    K = len(P)
    area = R["texel_area"] * K
    fr = finger_frames(bones)
    print(f"[hands] rasterized {K} texels ({math.sqrt(R['texel_area']) * 1000:.3f} mm) in {time.time() - t0:.1f}s")

    # --- where is each texel on the skeleton ---------------------------------------------
    best = np.full(K, 1e9)
    fam_i = np.full(K, -1)
    seg_k = np.zeros(K, dtype=np.int64)
    s = np.zeros(K)
    cos_t = np.zeros(K)
    side_t = np.zeros(K)
    joints = {}
    for fi, fam in enumerate(FAMILIES):
        off = 0.0
        js = [0.0]
        for k, (a, d, L, up) in enumerate(fr[fam]):
            rel = P - a
            t = rel @ d
            tc = np.clip(t, -0.02 if k == 0 else 0.0, L + (0.02 if k == 2 else 0.0))
            q = rel - tc[:, None] * d
            dist = np.linalg.norm(q, axis=-1)
            better = dist < best
            qn = q / np.maximum(dist[:, None], 1e-9)
            best = np.where(better, dist, best)
            fam_i = np.where(better, fi, fam_i)
            seg_k = np.where(better, k, seg_k)
            s = np.where(better, off + t, s)
            cos_t = np.where(better, qn @ up, cos_t)
            side_t = np.where(better, qn @ np.cross(d, up), side_t)
            off += L
            js.append(off)
        joints[fam] = js  # knuckle, middle joint, end joint, tip (s, metres)
    ang = np.arctan2(side_t, cos_t)
    across = ang * best  # arc length around the digit, metres
    r_loc = np.array([FINGER_DEFS[f][3] if f != "thumb" else THUMB_R[0][0] for f in FAMILIES])[np.maximum(fam_i, 0)]
    on_digit = (best < r_loc * 1.45) & (s > -0.004)
    dors_d = smoothstep(0.05, 0.55, cos_t) * on_digit
    palm_d = smoothstep(0.05, 0.55, -cos_t) * on_digit
    ny = Nn[:, 1]
    dors_h = smoothstep(-0.05, 0.45, ny) * ~on_digit
    palm_h = smoothstep(-0.05, 0.45, -ny) * ~on_digit
    dorsal = np.clip(dors_d + dors_h, 0, 1)
    palmar = np.clip(palm_d + palm_h, 0, 1)
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    warp = skin.fbm3(P, 350.0, 3, seed=2)

    h = np.zeros(K)
    crease = np.zeros(K)  # 0..1, colour and roughness of folds
    red = np.zeros(K)  # extra blood colour (knuckles, tips, creases)

    # --- micro-relief: a cellular network of fine furrows, with pores --------------------
    # Feature widths stay above ~0.8 texel (0.19 mm at 2048): finer detail only aliases.
    d = skin.cellular(P, area, 0.9e-3, seed=3, k=2)
    furrow = np.exp(-(((d[:, 1] - d[:, 0]) / 0.15e-3) ** 2))
    h += -0.02e-3 * furrow * (0.55 + 0.45 * dorsal) + 0.006e-3 * np.clip(1 - (d[:, 0] / 0.5e-3) ** 2, 0, 1)
    d2 = skin.cellular(P, area, 0.5e-3, seed=4, k=2)
    h += -0.006e-3 * np.exp(-(((d2[:, 1] - d2[:, 0]) / 0.11e-3) ** 2))
    dp = skin.cellular(P, area, 0.5e-3, seed=5, k=1)
    pore = np.exp(-((dp / 0.11e-3) ** 2)) * (0.35 + 0.65 * dorsal)
    h += -0.014e-3 * pore
    print(f"[hands] micro-relief {time.time() - t0:.1f}s")

    # --- knuckle wrinkles (back of the joints) -------------------------------------------
    nr1 = skin.fbm3(P, 900.0, 1, seed=40)
    nr2 = skin.fbm3(P, 900.0, 1, seed=41)
    for fi, fam in enumerate(FAMILIES):
        js = joints[fam]
        mine = fam_i == fi
        wr = [(1, 3.6e-3, 0.11e-3, 0.5), (2, 2.6e-3, 0.07e-3, 0.35)] if fam != "thumb" else [(1, 3.2e-3, 0.07e-3, 0.35), (2, 3.2e-3, 0.09e-3, 0.4)]
        if fam != "thumb":
            wr.append((0, 3.0e-3, 0.05e-3, 0.45))
        for j, a_len, depth, redw in wr:
            u = s - js[j]
            e = np.sqrt((u / a_len) ** 2 + (across / 6.5e-3) ** 2)
            bow = u - 0.035 * across**2 / a_len + 0.00018 * warp
            lines = 0.0
            for k in range(-4, 5):
                uk = k * a_len * 0.2 + 0.0001 * math.sin(k * 2.3 + fi)
                length = 0.55 + 0.4 * abs(math.sin(k * 1.7 + j + fi))
                reach = 1 - smoothstep(length * 0.7, length, np.abs(across) / 6.5e-3 + 0.15 * (nr1 * math.cos(k) + nr2 * math.sin(k)))
                lines = lines + np.exp(-(((bow - uk) / 0.17e-3) ** 2)) * reach
            m = mine * smoothstep(0.15, 0.6, cos_t) * (1 - smoothstep(0.75, 1.3, e))
            h -= depth * lines * m
            crease += 0.5 * lines * m
            red += redw * np.exp(-(e / 0.9) ** 2) * mine * smoothstep(0.1, 0.6, cos_t)

    # --- palm-side flexion creases of the digits ----------------------------------------
    for fi, fam in enumerate(FAMILIES):
        js = joints[fam]
        L1, L2 = fr[fam][0][2], fr[fam][1][2]
        if fam == "thumb":
            lines = [(L1 - 0.0008, 0.9), (L1 + 0.0006, 0.7), (L1 + L2 + 0.0002, 1.0)]
        else:
            lines = [(0.30 * L1, 1.0), (0.36 * L1, 0.45), (L1 - 0.0006, 1.0), (L1 + 0.0009, 0.8), (L1 + L2 + 0.0003, 0.9)]
        m = (fam_i == fi) * smoothstep(0.2, 0.65, -cos_t)
        for s0, wgt in lines:
            c = np.exp(-(((s - s0 - 0.0012 * (np.pi - np.abs(ang)) ** 2 + 0.00025 * warp) / 0.26e-3) ** 2)) * wgt * m
            h -= 0.22e-3 * c
            crease += c
            red += 0.25 * c

    # --- palm lines -------------------------------------------------------------------------
    def polyline_dist(px, pz, pts):
        pts = np.asarray(pts, dtype=np.float64)
        best_d = np.full(px.shape, 1e9)
        best_u = np.zeros(px.shape)
        seg_len = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        total = seg_len.sum()
        acc = 0.0
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            ab = b - a
            t = np.clip(((px - a[0]) * ab[0] + (pz - a[1]) * ab[1]) / (ab @ ab), 0, 1)
            dd = np.hypot(px - a[0] - t * ab[0], pz - a[1] - t * ab[1])
            closer = dd < best_d
            best_d = np.where(closer, dd, best_d)
            best_u = np.where(closer, (acc + t * seg_len[i]) / total, best_u)
            acc += seg_len[i]
        return best_d, best_u

    palm_region = palm_h * (1 - smoothstep(0.0, 0.006, -z - 0.012))
    px = x + 0.0005 * warp
    pz = z + 0.0004 * skin.fbm3(P, 260.0, 2, seed=8)
    PALM_LINES = [
        ([(0.041, 0.064), (0.030, 0.068), (0.016, 0.071), (0.004, 0.075), (-0.010, 0.083), (-0.016, 0.087)], 0.32e-3, 0.32e-3),
        ([(-0.037, 0.064), (-0.026, 0.060), (-0.012, 0.056), (0.004, 0.052), (0.020, 0.047), (0.028, 0.044)], 0.30e-3, 0.30e-3),
        ([(-0.036, 0.063), (-0.026, 0.055), (-0.019, 0.044), (-0.015, 0.031), (-0.012, 0.018), (-0.010, 0.006)], 0.30e-3, 0.32e-3),
        ([(-0.022, 0.003), (0.0, 0.0015), (0.022, 0.003)], 0.18e-3, 0.28e-3),
        ([(-0.020, -0.006), (0.0, -0.007), (0.020, -0.006)], 0.14e-3, 0.26e-3),
        ([(0.002, 0.012), (0.004, 0.035), (0.003, 0.055)], 0.08e-3, 0.22e-3),
    ]
    for pts, depth, width in PALM_LINES:
        dd, uu = polyline_dist(px, pz, pts)
        taper = smoothstep(0.0, 0.15, uu) * smoothstep(1.0, 0.8, uu)
        broken = np.clip(0.7 + 0.45 * skin.fbm3(P, 160.0, 2, seed=int(depth * 1e6)), 0.25, 1.0)
        c = np.exp(-((dd / (width * 1.35)) ** 2)) * taper * palm_region * broken
        trough = np.exp(-((dd / (width * 5.0)) ** 2)) * taper * palm_region
        h -= depth * c + 0.45 * depth * trough
        crease += 0.75 * c
        red += 0.22 * c
    dpn = skin.cellular(P, area, 1.6e-3, seed=9, k=2)
    net = np.exp(-(((dpn[:, 1] - dpn[:, 0]) / 0.11e-3) ** 2)) * palm_region
    h -= 0.035e-3 * net
    crease += 0.25 * net

    # --- papillary ridges: whorls on the fingertip pads, flowing ridges elsewhere ----------
    period = 0.48e-3
    tip_s = np.array([joints[f][3] for f in FAMILIES])[np.maximum(fam_i, 0)]
    u_pad = s - (tip_s - 0.0075)
    rho = np.sqrt((u_pad / 1.0) ** 2 + (across / 0.85) ** 2) + 0.00025 * warp
    whorl = np.sin(2 * np.pi * rho / period)
    flow = np.sin(2 * np.pi * (s + 0.0003 * np.sin(across * 380.0) + 0.0002 * warp) / period)
    palm_flow = np.sin(2 * np.pi * (0.7 * z + 0.3 * x + 0.0004 * warp) / period)
    pad_w = smoothstep(0.012, 0.004, np.abs(u_pad)) * (seg_k == 2)
    ridges = np.where(on_digit, pad_w * whorl + (1 - pad_w) * flow, palm_flow)
    h += 0.011e-3 * ridges * palmar * (1 - np.clip(crease, 0, 1))

    # --- nails ------------------------------------------------------------------------------
    nail = np.zeros(K)
    lunula = np.zeros(K)
    free_edge = np.zeros(K)
    cuticle = np.zeros(K)
    groove = np.zeros(K)
    band = np.zeros(K)
    fold = np.zeros(K)
    for fi, fam in enumerate(FAMILIES):
        L3 = fr[fam][2][2]
        tip = joints[fam][3]
        n_len = (0.6 if fam == "thumb" else 0.55) * L3
        half_w = 0.86
        a_ = (s - (tip - n_len / 2 - 0.0004)) / (n_len / 2 + 0.0004)
        b_ = ang / half_w
        e_n = np.where(a_ < 0, (np.abs(a_) ** 3 + np.abs(b_) ** 3) ** (1 / 3), np.maximum(a_ * 0.97, np.abs(b_)))
        mine = (fam_i == fi) & (seg_k == 2) & (cos_t > -0.2)
        plate = (1 - smoothstep(0.93, 1.0, e_n)) * mine
        nail = np.maximum(nail, plate)
        # The lunula mostly hides under the fold except on the thumb; nails are trimmed short.
        lw = {"thumb": 0.34, "index": 0.17, "middle": 0.19, "ring": 0.15, "pinky": 0.08}[fam]
        lunula = np.maximum(lunula, plate * (1 - smoothstep(0.6, 1.0, np.sqrt(((a_ + 1.0) / lw) ** 2 + (b_ / 0.7) ** 2))))
        edge = 0.9 + 0.025 * nr1
        free_edge = np.maximum(free_edge, plate * smoothstep(edge - 0.03, edge + 0.02, a_))
        band = np.maximum(band, plate * np.exp(-(((a_ - edge + 0.07) / 0.035) ** 2)))
        cuticle = np.maximum(cuticle, mine * (a_ < 0.2) * smoothstep(0.98, 1.03, e_n) * (1 - smoothstep(1.06, 1.16, e_n)))
        groove = np.maximum(groove, np.exp(-(((e_n - 1.0) / 0.035) ** 2)) * mine)
        fold = np.maximum(fold, mine * (a_ < 0.85) * smoothstep(1.0, 1.05, e_n) * (1 - smoothstep(1.1, 1.25, e_n)))
        red += 0.4 * mine * smoothstep(0.9, 1.25, e_n) * (1 - smoothstep(1.25, 1.8, e_n))
    # The plate is smooth, raised ~0.1 mm, with faint lengthwise ridges, sunk into its fold.
    ridge = np.sin(2 * np.pi * across / 0.5e-3 + 2.5 * nr2) * np.clip(0.5 + nr1, 0, 1)
    h = h * (1 - nail) + nail * (0.11e-3 + 0.0022e-3 * ridge) - 0.05e-3 * groove + 0.05e-3 * fold

    # --- tendons and veins on the back of the hand -------------------------------------------
    back = dors_h * (1 - smoothstep(0.075, 0.09, z))
    for mcp, *_ in FINGER_DEFS.values():
        dd, uu = polyline_dist(x, z, [(mcp[0], mcp[2] - 0.006), (mcp[0] * 0.35, 0.012)])
        h += 0.75e-3 * np.exp(-((dd / 2.6e-3) ** 2)) * back * smoothstep(0.0, 0.25, uu) * smoothstep(1.0, 0.6, uu)
    VEINS = [
        [(-0.020, 0.075), (-0.018, 0.055), (-0.012, 0.035), (-0.010, 0.010), (-0.012, -0.02), (-0.014, -0.07)],
        [(0.004, 0.080), (0.006, 0.058), (0.004, 0.040), (0.000, 0.022), (-0.008, 0.012)],
        [(0.020, 0.074), (0.018, 0.052), (0.010, 0.032), (0.004, 0.018)],
        [(0.030, 0.060), (0.026, 0.040), (0.020, 0.020), (0.016, -0.005), (0.015, -0.07)],
        [(-0.016, 0.045), (-0.002, 0.050), (0.016, 0.046), (0.026, 0.044)],
    ]
    vein = np.zeros(K)
    vx = x + 0.0012 * skin.fbm3(P, 90.0, 2, seed=12)
    for pts in VEINS:
        dd, _uu = polyline_dist(vx, z, pts)
        vein = np.maximum(vein, np.exp(-((dd / 2.4e-3) ** 2)))
    vein *= dors_h * (1 - smoothstep(0.07, 0.09, z)) * np.clip(0.55 + 0.6 * skin.fbm3(P, 45.0, 2, seed=13), 0, 1)
    h += 0.45e-3 * vein

    # --- colour ---------------------------------------------------------------------------
    def lin(hexs):
        return np.asarray(bl.srgb_to_linear(bl.hexrgb(hexs)))

    base = lin("#BA8B71")[None] * (1 - palmar[:, None]) + lin("#D0A58E")[None] * palmar[:, None]
    base = base * (1 + 0.06 * skin.fbm3(P, 55.0, 4, seed=21))[:, None]
    red += 0.45 * smoothstep(tip_s - 0.014, tip_s - 0.002, s) * on_digit
    red += 0.12 * np.clip(skin.fbm3(P, 170.0, 3, seed=22), 0, 1)
    red += 0.3 * np.clip(skin.fbm3(P, 110.0, 3, seed=23) + 0.15, 0, 1) * palm_h
    red += 0.22 * palm_h * (np.exp(-(((x + 0.026) / 0.016) ** 2 + ((z - 0.03) / 0.024) ** 2)) + np.exp(-(((x - 0.027) / 0.012) ** 2 + ((z - 0.042) / 0.026) ** 2)))
    red = np.clip(red, 0, 1)
    col = base * (1 - 0.32 * red[:, None]) + lin("#B5695A")[None] * (0.32 * red[:, None])
    col = col * (1 - 0.14 * np.clip(crease, 0, 1)[:, None] * np.array([1.0, 1.15, 1.1])[None])
    col = col * (1 - 0.2 * vein[:, None] * np.array([0.75, 0.3, -0.05])[None])
    col = col * (1 - 0.06 * pore[:, None])
    df = skin.cellular(P, area, 1.3e-3, seed=14, k=1)
    follicle = np.exp(-((df / 0.09e-3) ** 2)) * dors_h * smoothstep(0.075, 0.04, z)
    col = col * (1 - 0.22 * follicle[:, None] * np.array([0.8, 0.95, 1.0])[None])
    from scipy.spatial import cKDTree

    rng = np.random.default_rng(31)
    n_fr = max(8, int(area / (8e-3) ** 2))
    fr_pts = P[rng.choice(K, n_fr)]
    fr_amt = rng.random(n_fr) ** 3
    fr_d, fr_i = cKDTree(fr_pts).query(P, k=1, workers=-1)
    freckle = np.exp(-((fr_d / 0.5e-3) ** 2)) * fr_amt[fr_i] * dorsal
    col = col * (1 - 0.16 * freckle[:, None] * np.array([0.7, 0.9, 1.0])[None])
    streak = 1 + 0.012 * np.sin(2 * np.pi * across / 0.9e-3 + 3 * warp) + 0.03 * skin.fbm3(P, 400.0, 2, seed=51)
    nail_col = lin("#DC9888")[None] * streak[:, None]
    nail_col = nail_col * (1 - 0.4 * lunula[:, None]) + lin("#EBC6BA")[None] * (0.4 * lunula[:, None])
    nail_col = nail_col * (1 - 0.35 * band[:, None]) + lin("#D58A7C")[None] * (0.35 * band[:, None])
    nail_col = nail_col * (1 - 0.85 * free_edge[:, None]) + lin("#EADCCB")[None] * (0.85 * free_edge[:, None])
    col = col * (1 - nail[:, None]) + nail_col * nail[:, None]

    # --- roughness and cavity ----------------------------------------------------------------
    rough = 0.47 * (1 - palmar) + 0.56 * palmar
    rough += 0.12 * np.clip(crease, 0, 1) + 0.05 * pore + 0.045 * skin.fbm3(P, 420.0, 3, seed=33)
    rough = rough * (1 - nail) + (0.24 + 0.16 * free_edge + 0.03 * warp) * nail
    rough = np.clip(rough, 0.12, 0.85)

    def full(v, fill=0.0):
        img = np.full((size, size) + v.shape[1:], fill, dtype=np.float64)
        img[M] = v
        return img

    height = full(h)
    hb = skin.blur(height, 4.0)
    cav = np.clip((hb - height) / 0.12e-3, 0, 1) * M
    ao = 1 - 0.5 * cav
    print(f"[hands] maps {time.time() - t0:.1f}s")

    out_dir = os.path.join(BUILD, "skin")
    os.makedirs(out_dir, exist_ok=True)
    albedo = bl.dilate(full(col), M, 24)
    srgb = np.where(albedo <= 0.0031308, albedo * 12.92, 1.055 * np.power(np.clip(albedo, 0, 1), 1 / 2.4) - 0.055)
    paths = {k: os.path.join(out_dir, f"skin_hand_{k}.png") for k in ("albedo", "orm", "normal", "thickness")}
    Image.fromarray((np.clip(srgb, 0, 1) * 255 + 0.5).astype(np.uint8)).save(paths["albedo"])
    orm = np.stack([ao, full(rough, 0.5), np.zeros((size, size))], -1)
    orm = bl.dilate(orm, M, 24)
    Image.fromarray((np.clip(orm, 0, 1) * 255 + 0.5).astype(np.uint8)).save(paths["orm"])
    height = bl.dilate(np.repeat(height[..., None], 3, -1), M, 24)[..., 0]
    nrm = skin.bake_normal(body, height)
    Image.fromarray((np.clip(nrm, 0, 1) * 255 + 0.5).astype(np.uint8)).save(paths["normal"])
    print(f"[hands] normal bake {time.time() - t0:.1f}s")
    Rs = skin.rasterize(body, 512)
    th = skin.thickness(body, Rs, 0.03)
    th = bl.dilate(np.repeat((th / 0.03)[..., None], 3, -1), Rs["mask"], 16)[..., 0]
    Image.fromarray((np.clip(th, 0, 1) * 255 + 0.5).astype(np.uint8), "L").save(paths["thickness"])
    print(f"[hands] textures done in {time.time() - t0:.1f}s")
    return paths


def skin_material(maps: dict[str, str]) -> bpy.types.Material:
    """Skin for Cycles: random-walk subsurface (mean free path ~3.7/1.4/0.7 mm, Jensen's skin)."""
    mat = bl.textured("skin_hand", {"albedo": maps["albedo"], "orm": maps["orm"], "normal": maps["normal"]})
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.subsurface_method = "RANDOM_WALK_SKIN"
    bsdf.inputs["Subsurface Weight"].default_value = 1.0
    bsdf.inputs["Subsurface Radius"].default_value = (1.0, 0.38, 0.19)
    bsdf.inputs["Subsurface Scale"].default_value = 0.0037
    bsdf.inputs["IOR"].default_value = 1.4
    return mat


def mirror_copy(obj: bpy.types.Object, name: str) -> bpy.types.Object:
    """Mirror across game x (Blender x) keeping UVs and materials, for the left hand."""
    me = obj.data.copy()
    me.name = name
    me.transform(Matrix.Scale(-1.0, 4, (1.0, 0.0, 0.0)))
    me.flip_normals()
    o = bpy.data.objects.new(name, me)
    bl.link(o, None)
    return o


def hand_rig(side: int, body: bpy.types.Object, sleeve_mat, piping_mat) -> list[bpy.types.Object]:
    """Armature, skin weights and a rolled-up chef-jacket sleeve for one hand."""
    import numpy as np

    from ahb import sdf

    tag = "R" if side > 0 else "L"
    bones = hand_skeleton(side)
    fingers = [n for n in bones if n.split("_")[0] in FINGER_DEFS or n.startswith("thumb")]
    rigid = {n: [o for o in fingers if o.split("_")[0] != n.split("_")[0]] for n in fingers}
    sdf.skin_weights(body, bones, falloff=5.0, max_influences=3, rigid=rigid)
    roll = [(0.046 + 0.0085 * math.cos(a), -0.085 + 0.0085 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 18, endpoint=False)]
    cuff = lathe_z(f"sleeve_roll_{tag}", roll, sleeve_mat, squash=0.8, closed=True)
    sleeve = lathe_z(f"sleeve_{tag}", [(0.0465, -0.09), (0.048, -0.13), (0.0495, -0.2), (0.049, -0.32)], sleeve_mat, squash=0.8)
    pipe = lathe_z(f"piping_{tag}", [(0.0548, -0.0815), (0.0556, -0.0815), (0.0556, -0.0855), (0.0548, -0.0855)], piping_mat, squash=0.8, closed=True)
    for o in (cuff, sleeve, pipe):
        bl.ensure_uv(o)
    arm = bpy.data.armatures.new(f"hand_rig_{tag}")
    arm_obj = bpy.data.objects.new(f"hand_{tag}", arm)
    bl.link(arm_obj, None)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")
    parents = {"forearm": None, "hand": "forearm"}
    for name in bones:
        if name in parents:
            continue
        fam, idx = name.rsplit("_", 1)
        parents[name] = "hand" if idx == "01" else f"{fam}_0{int(idx) - 1}"
    for name, (a, b) in bones.items():
        add_bone(arm, name, a, b, parents[name])
    bpy.ops.object.mode_set(mode="OBJECT")
    mod = body.modifiers.new("arm", "ARMATURE")
    mod.object = arm_obj
    body.parent = arm_obj
    for o in (cuff, sleeve, pipe):
        rigid_bind(o, arm_obj, "forearm")
    return [arm_obj, body, cuff, sleeve, pipe]


def hands(sleeve_mat, piping_mat) -> tuple[list[bpy.types.Object], list[bpy.types.Object]]:
    """Right hand sculpted, unwrapped and textured; the left is its exact mirror (shared maps)."""
    from ahb import sdf

    field = hand_sdf(hand_skeleton(1))
    verts, faces = sdf.polygonise(field, (-0.095, -0.045, -0.16), (0.07, 0.04, 0.215), 0.0012)
    body = sdf.to_blender("skin_R", verts, faces, None, decimate=0.14, smooth_iters=2)
    bl.lightmap_uv([body], layer="UVMap", margin=0.004, angle=66.0)
    maps = hand_skin_textures(body, hand_skeleton(1))
    body.data.materials.append(skin_material(maps))
    left_body = mirror_copy(body, "skin_L")
    return hand_rig(1, body, sleeve_mat, piping_mat), hand_rig(-1, left_body, sleeve_mat, piping_mat)


def materials() -> dict:
    return {
        "cuff": bl.solid("chef_white", (0.92, 0.92, 0.9), 0.75),
        "piping": bl.solid("chef_piping", (0.05, 0.05, 0.05), 0.6),
    }


def preview_hands(right, left) -> None:
    """Skin look-development: first-person pair, back of the hand, palm, fingertip macro."""
    import food

    out = os.path.join(BUILD, "preview")
    hdr = os.path.join(BUILD, "probe_kitchen.hdr")
    if os.path.exists(hdr):
        food.world_hdr(hdr, 0.45)
    key = kit.area_light("key", (0.35, 1.75, -0.25), (0.5, 0.5), 22.0, (1.0, 0.93, 0.85), facing=(-0.5, -0.9, 0.4), up=(0, 0, 1))
    rim = kit.area_light("rim", (-0.25, 1.3, 0.55), (0.3, 0.3), 10.0, (1.0, 0.9, 0.8), facing=(0.4, -0.1, -0.9), up=(0, 1, 0))
    # First-person pair, as in game: forearms drop away toward the shoulders.
    right[0].location = bl.G(0.12, 1.3, 0.3)
    right[0].rotation_euler = (-0.35, 0.0, 0.12)
    left[0].location = bl.G(-0.12, 1.3, 0.3)
    left[0].rotation_euler = (-0.35, 0.0, -0.12)
    bl.camera("cam_fp", (0.0, 1.55, -0.05), (0.0, 1.25, 0.35), lens=26)
    bl.render(os.path.join(out, "hands.jpg"), width=1280, height=720, samples=160, exposure=1.0, guided=True)
    # Close-ups of the right hand at rest.
    for o in left:
        o.hide_render = True
    right[0].location = bl.G(0.0, 1.0, 0.0)
    right[0].rotation_euler = (0.0, 0.0, 0.0)
    bl.camera("cam_back", (0.15, 1.2, -0.02), (0.0, 1.0, 0.075), lens=55)
    bl.render(os.path.join(out, "hand_back.jpg"), width=1600, height=900, samples=256, exposure=1.0, guided=True)
    bl.camera("cam_macro", (-0.075, 1.07, 0.215), (-0.035, 0.99, 0.165), lens=85)
    bl.render(os.path.join(out, "hand_macro.jpg"), width=1600, height=900, samples=256, exposure=1.0, guided=True)
    # Palm up: roll the hand over about its forward axis (game z = Blender -y).
    right[0].rotation_euler = (0.0, math.pi, 0.0)
    key.location = bl.G(-0.3, 1.8, -0.2)
    bl.camera("cam_palm", (-0.12, 1.24, 0.0), (0.0, 1.0, 0.07), lens=55)
    bl.render(os.path.join(out, "hand_palm.jpg"), width=1600, height=900, samples=256, exposure=1.0, guided=True)
    for o in left:
        o.hide_render = False
    for o in (key, rim):
        bpy.data.objects.remove(o)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true")
    args = ap.parse_args([a for a in sys.argv[1:] if a != "--"])
    bl.reset()
    m = materials()
    right, left = hands(m["cuff"], m["piping"])
    if args.preview:
        os.makedirs(os.path.join(BUILD, "preview"), exist_ok=True)
        preview_hands(right, left)
        return
    bl.export_gltf(os.path.join(ART, "hands.gltf"), right + left, image_format="WEBP", quality=88, tangents=True)
    # Translucency thickness is read by the client's skin shader, not by the glTF material.
    from PIL import Image

    Image.open(os.path.join(BUILD, "skin", "skin_hand_thickness.png")).save(os.path.join(ART, "textures", "skin_hand_thickness.webp"), quality=90, method=6)
    print("[characters] exported", ART)


if __name__ == "__main__":
    main()
