"""Rigged first-person hands (nitrile-gloved, chef-jacket cuff) and the teammate crew member.

Both are skin-modifier sculpts over a skeleton, subdivided, bound to named armatures with
automatic weights, and exported with their rest pose only: the client drives the bones
procedurally (finger curl per grip, walk cycle, look, reach), so blends stay responsive.

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
from mathutils import Matrix, Vector  # noqa: E402

from ahb import bl, kit  # noqa: E402
from ahb.library import BUILD, ROOT  # noqa: E402

OUT = os.path.join(ROOT, "apps", "client", "public", "assets", "characters")


# ----------------------------------------------------------------------------------------------
# Skin-modifier helpers


def skin_mesh(name: str, verts: list[tuple[tuple[float, float, float], tuple[float, float]]], edges: list[tuple[int, int]], *, root: int = 0, subdiv: int = 2, mat=None) -> bpy.types.Object:
    """Builds a skin-modifier hull over game-space vertices with (rx, ry) radii, then applies it."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(bl.G(*p)) for p, _ in verts], edges, [])
    obj = bpy.data.objects.new(name, me)
    bl.link(obj, None)
    sk = obj.modifiers.new("skin", "SKIN")
    sk.use_smooth_shade = True
    sk.branch_smoothing = 0.6
    for i, (_, r) in enumerate(verts):
        obj.data.skin_vertices[0].data[i].radius = r
        obj.data.skin_vertices[0].data[i].use_root = i == root
    if subdiv:
        sd = obj.modifiers.new("subd", "SUBSURF")
        sd.levels = subdiv
        sd.render_levels = subdiv
    bl.apply_modifiers(obj)
    for p in obj.data.polygons:
        p.use_smooth = True
    if mat is not None:
        obj.data.materials.append(mat)
    return obj


def add_bone(arm_data, name: str, head, tail, parent=None, roll: float = 0.0):
    b = arm_data.edit_bones.new(name)
    b.head = bl.G(*head)
    b.tail = bl.G(*tail)
    b.roll = roll
    if parent is not None:
        b.parent = arm_data.edit_bones[parent]
        b.use_connect = False
    return b


def bind(mesh_objs: list[bpy.types.Object], arm_obj: bpy.types.Object) -> None:
    """Automatic (bone heat) weights."""
    ctx = bpy.context
    for o in ctx.view_layer.objects:
        o.select_set(False)
    for m in mesh_objs:
        m.select_set(True)
    arm_obj.select_set(True)
    ctx.view_layer.objects.active = arm_obj
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")


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


def hand_sdf(side: int, bones):
    """Distance field of a gloved hand built on the skeleton."""
    import numpy as np

    from ahb import sdf

    def m(p):
        return (p[0] * side, p[1], p[2])

    def field(P):
        # Palm: rounded slab + dorsal dome + thenar/hypothenar pads.
        palm = sdf.round_box(P, m((0.0, -0.001, 0.048)), (0.04, 0.0118, 0.046), 0.011)
        palm = sdf.smin(palm, sdf.ellipsoid(P, m((0.0, 0.003, 0.052)), (0.04, 0.0145, 0.046)), 0.01)
        palm = sdf.smin(palm, sdf.ellipsoid(P, m((-0.026, -0.008, 0.03)), (0.019, 0.0125, 0.027)), 0.012)
        palm = sdf.smin(palm, sdf.ellipsoid(P, m((0.027, -0.007, 0.042)), (0.013, 0.0095, 0.03)), 0.01)
        # Wrist and forearm (elliptical cross-section).
        Q = P.copy()
        Q[..., 1] = Q[..., 1] * 1.32
        arm = sdf.round_cone(Q, m((0.0, -0.001, 0.006)), m((0.0, -0.003, -0.12)), 0.026, 0.033)
        hand = sdf.smin(palm, arm, 0.016)
        # Fingers: tapered phalanges with joint bulges; fingers union hard with each other and
        # blend into the palm.
        fingers = None
        for name, (_mcp, _fan, _segs, r0) in FINGER_DEFS.items():
            f = None
            for i in range(3):
                a, b = bones[f"{name}_0{i + 1}"]
                ra = r0 * (1 - 0.085 * i)
                rb = r0 * (1 - 0.085 * (i + 1))
                seg = sdf.round_cone(P, a, b, ra, rb)
                joint = sdf.sphere(P, (a[0], a[1] + ra * 0.15, a[2]), ra * 1.03)
                seg = sdf.smin(seg, joint, 0.004)
                f = seg if f is None else sdf.smin(f, seg, 0.003)
            tip = bones[f"{name}_03"][1]
            pad = sdf.ellipsoid(P, (tip[0], tip[1] - 0.002, tip[2] - 0.004), (r0 * 0.8, r0 * 0.68, r0 * 0.9))
            f = sdf.smin(f, pad, 0.003)
            fingers = f if fingers is None else np.minimum(fingers, f)
        hand = sdf.smin(hand, fingers, 0.009)
        t = None
        for i in range(3):
            a, b = bones[f"thumb_0{i + 1}"]
            ra = [0.0158, 0.0123, 0.0108][i]
            rb = [0.0123, 0.0108, 0.0094][i]
            seg = sdf.round_cone(P, a, b, ra, rb)
            t = seg if t is None else sdf.smin(t, seg, 0.004)
        hand = sdf.smin(hand, t, 0.012)
        # Rolled glove cuff at the wrist.
        Q2 = P.copy()
        Q2[..., 1] = Q2[..., 1] * 1.3
        cuff = sdf.torus_z(Q2, m((0.0, -0.002, -0.032)), 0.0285, 0.0032)
        hand = sdf.smin(hand, cuff, 0.003)
        # Fine glove wrinkles on the back of the knuckles.
        wr = 0.00018 * np.sin(P[..., 2] * 900.0 + np.sin(P[..., 0] * 300.0) * 2.0)
        near = np.exp(-(((P[..., 2] - 0.1) / 0.03) ** 2)) * (P[..., 1] > 0)
        return hand + wr * near

    return field


def hand(side: int, glove, cuff, piping) -> list[bpy.types.Object]:
    """Right hand for side=1 (thumb toward -x when palm down), mirrored for side=-1.

    Local space: wrist at the origin, fingers along +Z, palm facing -Y.
    """
    from ahb import sdf

    tag = "R" if side > 0 else "L"
    bones = hand_skeleton(side)
    field = hand_sdf(side, bones)
    lo = (-0.095 if side > 0 else -0.07, -0.045, -0.125)
    hi = (0.07 if side > 0 else 0.095, 0.04, 0.215)
    verts, faces = sdf.polygonise(field, lo, hi, 0.0014)
    body = sdf.to_blender(f"glove_{tag}", verts, faces, glove, decimate=0.1, smooth_iters=2)
    fingers = [n for n in bones if n.split("_")[0] in FINGER_DEFS or n.startswith("thumb")]
    rigid = {}
    for n in fingers:
        fam = n.split("_")[0]
        rigid[n] = [o for o in fingers if o.split("_")[0] != fam]
    sdf.skin_weights(body, bones, falloff=5.0, max_influences=3, rigid=rigid)
    # Chef-jacket sleeve with black piping over the forearm.
    sleeve = lathe_z(f"sleeve_{tag}", [(0.0425, -0.05), (0.0445, -0.052), (0.047, -0.09), (0.049, -0.17), (0.046, -0.3)], cuff, squash=0.8)
    pipe = lathe_z(f"piping_{tag}", [(0.0447, -0.052), (0.0462, -0.052), (0.0462, -0.058), (0.0447, -0.058)], piping, squash=0.8, closed=True)
    for o in (sleeve, pipe):
        bl.ensure_uv(o)
    bl.ensure_uv(body)
    # Armature.
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
    for o in (body,):
        mod = o.modifiers.new("arm", "ARMATURE")
        mod.object = arm_obj
        o.parent = arm_obj
    rigid_bind(sleeve, arm_obj, "forearm")
    rigid_bind(pipe, arm_obj, "forearm")
    return [arm_obj, body, sleeve, pipe]


# ----------------------------------------------------------------------------------------------
# Teammate


CREW_JOINTS = {
    "hips": (0.0, 0.96, 0.0), "spine": (0.0, 1.1, 0.0), "chest": (0.0, 1.3, 0.005), "neck": (0.0, 1.46, 0.0),
    "head": (0.0, 1.56, 0.015), "crown": (0.0, 1.75, 0.0),
}


def crew_joints() -> dict[str, tuple[float, float, float]]:
    j = dict(CREW_JOINTS)
    for s, t in ((1, "r"), (-1, "l")):
        j[f"shoulder_{t}"] = (0.172 * s, 1.43, -0.005)
        j[f"elbow_{t}"] = (0.232 * s, 1.165, -0.03)
        j[f"wrist_{t}"] = (0.25 * s, 0.925, 0.0)
        j[f"fingers_{t}"] = (0.255 * s, 0.83, 0.018)
        j[f"hip_{t}"] = (0.088 * s, 0.93, 0.0)
        j[f"knee_{t}"] = (0.096 * s, 0.5, 0.015)
        j[f"ankle_{t}"] = (0.1 * s, 0.085, -0.02)
        j[f"toe_{t}"] = (0.104 * s, 0.025, 0.13)
    return j


def crew_bones(j) -> dict[str, tuple]:
    b = {"hips": (j["hips"], j["spine"]), "spine": (j["spine"], j["chest"]), "chest": (j["chest"], j["neck"]), "neck": (j["neck"], j["head"]), "head": (j["head"], j["crown"])}
    for t in ("r", "l"):
        b[f"upperarm_{t}"] = (j[f"shoulder_{t}"], j[f"elbow_{t}"])
        b[f"forearm_{t}"] = (j[f"elbow_{t}"], j[f"wrist_{t}"])
        b[f"hand_{t}"] = (j[f"wrist_{t}"], j[f"fingers_{t}"])
        b[f"thigh_{t}"] = (j[f"hip_{t}"], j[f"knee_{t}"])
        b[f"shin_{t}"] = (j[f"knee_{t}"], j[f"ankle_{t}"])
        b[f"foot_{t}"] = (j[f"ankle_{t}"], j[f"toe_{t}"])
    return b


CREW_PARENTS = {"hips": None, "spine": "hips", "chest": "spine", "neck": "chest", "head": "neck"}
for _t in ("r", "l"):
    CREW_PARENTS.update({f"upperarm_{_t}": "chest", f"forearm_{_t}": f"upperarm_{_t}", f"hand_{_t}": f"forearm_{_t}", f"thigh_{_t}": "hips", f"shin_{_t}": f"thigh_{_t}", f"foot_{_t}": f"shin_{_t}"})


def crew_parts(j):
    """Named distance fields of the clothed body (material zones)."""
    import numpy as np

    from ahb import sdf

    def tee(P):
        d = sdf.ellipsoid(P, (0.0, 1.31, 0.0), (0.165, 0.15, 0.105))
        d = sdf.smin(d, sdf.ellipsoid(P, (0.0, 1.12, 0.006), (0.148, 0.13, 0.098)), 0.05)
        d = sdf.smin(d, sdf.ellipsoid(P, (0.0, 1.405, -0.008), (0.176, 0.05, 0.085)), 0.04)
        for t in ("r", "l"):
            sh, el = np.asarray(j[f"shoulder_{t}"]), np.asarray(j[f"elbow_{t}"])
            d = sdf.smin(d, sdf.ellipsoid(P, tuple(sh + np.array([0, -0.015, 0])), (0.05, 0.056, 0.052)), 0.03)
            mid = sh + (el - sh) * 0.45
            d = sdf.smin(d, sdf.round_cone(P, tuple(sh), tuple(mid), 0.05, 0.047), 0.02)
        return d

    def skin(P):
        d = sdf.round_cone(P, (0.0, 1.43, -0.005), (0.0, 1.53, 0.01), 0.055, 0.05)
        for t in ("r", "l"):
            sh, el, wr = (np.asarray(j[k]) for k in (f"shoulder_{t}", f"elbow_{t}", f"wrist_{t}"))
            mid = sh + (el - sh) * 0.42
            arm = sdf.round_cone(P, tuple(mid), tuple(el), 0.046, 0.039)
            arm = sdf.smin(arm, sdf.round_cone(P, tuple(el), tuple(wr), 0.039, 0.027), 0.012)
            d = np.minimum(d, arm)
        return d

    def glove(P):
        d = None
        for t, s in (("r", 1), ("l", -1)):
            wr, ft = np.asarray(j[f"wrist_{t}"]), np.asarray(j[f"fingers_{t}"])
            palm = sdf.ellipsoid(P, tuple(wr + (ft - wr) * 0.45), (0.022, 0.05, 0.04))
            thumb = sdf.round_cone(P, tuple(wr + np.array([0.0, -0.03, 0.03])), tuple(wr + np.array([-0.006 * s, -0.075, 0.045])), 0.013, 0.009)
            h = sdf.smin(palm, thumb, 0.01)
            d = h if d is None else np.minimum(d, h)
        return d

    def trousers(P):
        d = sdf.ellipsoid(P, (0.0, 0.95, 0.0), (0.158, 0.11, 0.112))
        for t in ("r", "l"):
            hp, kn, an = (np.asarray(j[k]) for k in (f"hip_{t}", f"knee_{t}", f"ankle_{t}"))
            leg = sdf.round_cone(P, tuple(hp + np.array([0, 0.02, 0])), tuple(kn), 0.086, 0.058)
            leg = sdf.smin(leg, sdf.round_cone(P, tuple(kn), tuple(an + np.array([0, 0.03, 0])), 0.057, 0.045), 0.015)
            d = sdf.smin(d, leg, 0.035) if t == "r" else np.minimum(d, sdf.smin(sdf.ellipsoid(P, (0.0, 0.95, 0.0), (0.158, 0.11, 0.112)), leg, 0.035))
        return d

    def shoes(P):
        d = None
        for t in ("r", "l"):
            an, toe = np.asarray(j[f"ankle_{t}"]), np.asarray(j[f"toe_{t}"])
            c = (an + toe) / 2
            box = sdf.round_box(P, (c[0], 0.045, c[2] - 0.005), (0.048, 0.045, 0.13), 0.032)
            box = np.maximum(box, -P[..., 1])
            d = box if d is None else np.minimum(d, box)
        return d

    return {"tee": tee, "skin": skin, "glove": glove, "trousers": trousers, "shoe": shoes}


def crew_head(j):
    import numpy as np

    from ahb import sdf

    def head(P):
        d = sdf.ellipsoid(P, (0.0, 1.638, 0.004), (0.077, 0.098, 0.092))
        d = sdf.smin(d, sdf.ellipsoid(P, (0.0, 1.567, 0.036), (0.06, 0.058, 0.066)), 0.03)
        for s in (1, -1):
            d = sdf.smin(d, sdf.ellipsoid(P, (0.045 * s, 1.602, 0.058), (0.024, 0.02, 0.026)), 0.015)
            d = sdf.smin(d, sdf.ellipsoid(P, (0.079 * s, 1.612, 0.0), (0.011, 0.029, 0.019)), 0.006)
        d = sdf.smin(d, sdf.ellipsoid(P, (0.0, 1.646, 0.074), (0.058, 0.017, 0.024)), 0.012)
        nose = sdf.round_cone(P, (0.0, 1.633, 0.088), (0.0, 1.598, 0.104), 0.0075, 0.0115)
        d = sdf.smin(d, nose, 0.008)
        for s in (1, -1):
            d = sdf.smax(d, -sdf.sphere(P, (0.031 * s, 1.624, 0.088), 0.0145), 0.006)
        neck = sdf.round_cone(P, (0.0, 1.44, -0.006), (0.0, 1.56, 0.012), 0.056, 0.05)
        return sdf.smin(d, neck, 0.03)

    def mask(P):
        h = head(P)
        shell = np.abs(h - 0.0045) - 0.0018
        region = np.maximum(np.maximum(P[..., 1] - 1.618, 1.515 - P[..., 1]), -P[..., 2] - 0.0)
        return np.maximum(shell, region)

    def cap(P):
        crown = sdf.ellipsoid(P, (0.0, 1.648, 0.0), (0.086, 0.104, 0.099))
        crown = np.maximum(crown, 1.645 - P[..., 1])
        brim = sdf.ellipsoid(P, (0.0, 1.647, 0.1), (0.075, 0.006, 0.07))
        brim = np.maximum(brim, 0.06 - P[..., 2])
        button = sdf.sphere(P, (0.0, 1.752, 0.0), 0.009)
        return sdf.union(crown, brim, button)

    def hair(P):
        cr = sdf.ellipsoid(P, (0.0, 1.638, 0.0), (0.081, 0.1, 0.095))
        region = np.maximum(np.maximum(P[..., 1] - 1.652, 1.585 - P[..., 1]), P[..., 2] - 0.035)
        return np.maximum(cr, region)

    return head, mask, cap, hair


def crew_member(m) -> list[bpy.types.Object]:
    """A line cook in a black tee, charcoal apron, dark trousers, work shoes, team cap and a
    food-safety face mask; nitrile gloves. Game space, origin between the feet, facing +Z.
    """
    import numpy as np

    from ahb import sdf

    j = crew_joints()
    bones = crew_bones(j)
    parts = crew_parts(j)

    def body_field(P):
        tee = parts["tee"](P)
        d = sdf.smin(tee, parts["skin"](P), 0.012)
        d = sdf.smin(d, parts["trousers"](P), 0.03)
        d = np.minimum(d, parts["glove"](P))
        d = np.minimum(d, parts["shoe"](P))
        return d

    def torso_field(P):
        return sdf.smin(parts["tee"](P), parts["trousers"](P), 0.03)

    verts, faces = sdf.polygonise(body_field, (-0.34, -0.005, -0.2), (0.34, 1.56, 0.29), 0.0055)
    body = sdf.to_blender("crew_body", verts, faces, None, decimate=0.09, smooth_iters=2)
    zones = ["tee", "skin", "glove", "trousers", "shoe"]
    for z in zones:
        body.data.materials.append(m[z if z != "shoe" else "shoe"])
    # Material per face: nearest clothing zone.
    me = body.data
    centers = np.array([tuple(p.center) for p in me.polygons])
    G = np.stack([-centers[:, 0], centers[:, 2], -centers[:, 1]], -1)
    D = np.stack([parts[z](G) for z in zones], -1)
    idx = np.argmin(D, axis=-1)
    # Clean sleeve hems: on the upper arm, split tee/skin by position along the bone.
    for t in ("r", "l"):
        a = np.asarray(j[f"shoulder_{t}"])
        b = np.asarray(j[f"elbow_{t}"])
        ba = b - a
        h = ((G - a) @ ba) / (ba @ ba)
        dist = np.linalg.norm((G - a) - np.clip(h, 0, 1)[:, None] * ba, axis=-1)
        on_arm = (dist < 0.065) & (h > 0.15) & (h < 1.05) & ((idx == 0) | (idx == 1))
        idx = np.where(on_arm, np.where(h < 0.44, 0, 1), idx)
    me.polygons.foreach_set("material_index", idx.astype(np.int32))
    head_f, mask_f, cap_f, hair_f = crew_head(j)
    hv, hf = sdf.polygonise(head_f, (-0.1, 1.42, -0.11), (0.1, 1.76, 0.13), 0.0024)
    head = sdf.to_blender("crew_head", hv, hf, m["skin"], decimate=0.08, smooth_iters=2)
    mv, mf = sdf.polygonise(mask_f, (-0.1, 1.5, -0.02), (0.1, 1.63, 0.13), 0.0018)
    mask = sdf.to_blender("crew_mask", mv, mf, m["mask"], decimate=0.06, smooth_iters=1)
    cv, cf = sdf.polygonise(cap_f, (-0.1, 1.63, -0.11), (0.1, 1.77, 0.18), 0.0028)
    cap = sdf.to_blender("crew_cap", cv, cf, m["cap"], decimate=0.12, smooth_iters=1)
    av, af = sdf.polygonise(hair_f, (-0.1, 1.57, -0.11), (0.1, 1.66, 0.05), 0.003)
    hair = sdf.to_blender("crew_hair", av, af, m["hair"], decimate=0.12, smooth_iters=1)
    eyes = []
    for s in (1, -1):
        e = bl.lathe(f"crew_eye_{s}", [(0.0, -0.0115), (0.008, -0.009), (0.0115, 0.0), (0.008, 0.009), (0.0, 0.0115)], (0.031 * s, 1.624, 0.084), m["sclera"], segments=16)
        iris = bl.cylinder(f"crew_iris_{s}", (0.031 * s, 1.624, 0.0955), 0.0052, 0.0015, m["iris"], axis="z", segments=16)
        brow = bl.bezier_tube(f"crew_brow_{s}", [(0.016 * s, 1.643, 0.097), (0.032 * s, 1.647, 0.096), (0.048 * s, 1.644, 0.088)], 0.0028, m["hair"])
        eyes += [e, iris, brow]
    # Apron: a bib-and-skirt panel following the front of the body, hanging straight below the
    # waist; neck strap and waist ties.
    bmA = bmesh.new()
    rows = []
    ys = np.linspace(1.36, 0.56, 22)
    for y in ys:
        half = 0.125 if y > 1.18 else (0.125 + (1.18 - y) * 0.7 if y > 1.06 else 0.205)
        xs = np.linspace(-half, half, 13)
        zs = []
        for x in xs:
            lo, hi = -0.05, 0.3
            fz = lambda zz: torso_field(np.array([[x, max(y, 0.98), zz]]))[0]  # noqa: E731
            for _ in range(22):
                mid = (lo + hi) / 2
                if fz(mid) < 0:
                    lo = mid
                else:
                    hi = mid
            zs.append(hi + 0.007)
        rows.append((y, xs, zs))
    grid = []
    for y, xs, zs in rows:
        grid.append([bmA.verts.new(bl.G(x, y, z)) for x, z in zip(xs, zs)])
    for i in range(len(grid) - 1):
        for k in range(len(grid[i]) - 1):
            bmA.faces.new((grid[i][k], grid[i][k + 1], grid[i + 1][k + 1], grid[i + 1][k]))
    bmesh.ops.recalc_face_normals(bmA, faces=bmA.faces)
    apron = bl._obj_from_bm("crew_apron", bmA, m["apron"], None)
    sol = apron.modifiers.new("sol", "SOLIDIFY")
    sol.thickness = 0.004
    sol.offset = 1.0
    bl.apply_modifiers(apron)
    for p in apron.data.polygons:
        p.use_smooth = True
    top = rows[0]
    strap = bl.bezier_tube("crew_apron_strap", [(top[1][1], 1.36, top[2][1] - 0.005), (-0.08, 1.46, 0.05), (0.0, 1.5, -0.035), (0.08, 1.46, 0.05), (top[1][-2], 1.36, top[2][-2] - 0.005)], 0.007, m["apron"])
    tie = bl.bezier_tube("crew_apron_tie", [(-0.16, 1.03, 0.08), (-0.17, 1.03, -0.04), (0.0, 1.03, -0.118), (0.17, 1.03, -0.04), (0.16, 1.03, 0.08)], 0.006, m["apron"])
    # Armature + weights.
    arm = bpy.data.armatures.new("crew_rig")
    arm_obj = bpy.data.objects.new("crew", arm)
    bl.link(arm_obj, None)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")
    for name, (a, b) in bones.items():
        add_bone(arm, name, a, b, CREW_PARENTS[name])
    bpy.ops.object.mode_set(mode="OBJECT")
    torso = ["hips", "spine", "chest"]
    rigid = {}
    for t, o in (("r", "l"), ("l", "r")):
        for part in ("thigh", "shin", "foot"):
            rigid[f"{part}_{t}"] = [f"{q}_{o}" for q in ("thigh", "shin", "foot")] + ([] if part == "thigh" else torso)
        for part in ("forearm", "hand"):
            rigid[f"{part}_{t}"] = torso + [f"thigh_{t}", f"thigh_{o}"]
        rigid[f"upperarm_{t}"] = ["hips", "spine", f"thigh_{t}", f"thigh_{o}"]
    sdf.skin_weights(body, bones, falloff=4.0, max_influences=3, rigid=rigid)
    sdf.skin_weights(apron, {k: v for k, v in bones.items() if k in ("hips", "spine", "chest", "thigh_r", "thigh_l")}, falloff=3.0, max_influences=2)
    sdf.skin_weights(head, {k: bones[k] for k in ("chest", "neck", "head")}, falloff=4.0, max_influences=2)
    for o in (body, apron, head):
        mod = o.modifiers.new("arm", "ARMATURE")
        mod.object = arm_obj
        o.parent = arm_obj
    rigid_bind(strap, arm_obj, "chest")
    rigid_bind(tie, arm_obj, "hips")
    for o in (mask, cap, hair, *eyes):
        bl.transform_apply(o)
        rigid_bind(o, arm_obj, "head")
    out = [arm_obj, body, apron, strap, tie, head, mask, cap, hair, *eyes]
    for o in out[1:]:
        bl.ensure_uv(o)
    return out


def materials() -> dict:
    return {
        "glove": bl.solid("nitrile_black", (0.03, 0.03, 0.035), 0.4, coat=0.12),
        "skin": bl.solid("crew_skin", (0.72, 0.52, 0.4), 0.5),
        "cuff": bl.solid("chef_white", (0.92, 0.92, 0.9), 0.75),
        "piping": bl.solid("chef_piping", (0.05, 0.05, 0.05), 0.6),
        "tee": bl.solid("crew_tee", (0.06, 0.06, 0.07), 0.85),
        "mask": bl.solid("crew_mask", (0.05, 0.05, 0.055), 0.9),
        "sclera": bl.solid("crew_sclera", (0.92, 0.9, 0.86), 0.25),
        "iris": bl.solid("crew_iris", (0.18, 0.11, 0.06), 0.15, coat=1.0),
        "trousers": bl.solid("crew_trousers", (0.09, 0.1, 0.12), 0.8),
        "shoe": bl.solid("crew_shoe", (0.03, 0.03, 0.03), 0.4),
        "apron": bl.solid("crew_apron", (0.2, 0.2, 0.21), 0.8),
        "cap": bl.solid("crew_cap", (0.75, 0.15, 0.12), 0.6),
        "eye": bl.solid("crew_eye", (0.05, 0.04, 0.035), 0.15),
        "hair": bl.solid("crew_hair", (0.06, 0.045, 0.035), 0.6),
        "lip": bl.solid("crew_lip", (0.5, 0.28, 0.25), 0.5),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true")
    args = ap.parse_args([a for a in sys.argv[1:] if a != "--"])
    bl.reset()
    m = materials()
    right = hand(1, m["glove"], m["cuff"], m["piping"])
    left = hand(-1, m["glove"], m["cuff"], m["piping"])
    crew = crew_member(m)
    if args.preview:
        os.makedirs(os.path.join(BUILD, "preview"), exist_ok=True)
        import food

        hdr = os.path.join(BUILD, "probe_kitchen.hdr")
        if os.path.exists(hdr):
            food.world_hdr(hdr, 1.0)
        right[0].location = bl.G(0.11, 1.32, 0.25)
        right[0].rotation_euler = (0.25, 0.0, 0.0)
        left[0].location = bl.G(-0.11, 1.32, 0.25)
        left[0].rotation_euler = (0.25, 0.0, 0.0)
        crew[0].location = bl.G(0.0, 0.0, 2.2)
        crew[0].rotation_euler.z = math.pi
        kit.area_light("key", (0.5, 2.6, -0.5), (1.0, 1.0), 300.0, (1.0, 0.95, 0.88), facing=(-0.3, -1, 0.5), up=(0, 0, 1))
        bl.camera("cam2", (0.0, 1.55, -0.05), (0.0, 1.25, 0.35), lens=26)
        bl.render(os.path.join(BUILD, "preview", "hands.jpg"), width=1280, height=720, samples=96, exposure=1.0)
        bl.camera("cam", (0.0, 1.45, 0.4), (0.0, 1.1, 2.2), lens=28)
        bl.render(os.path.join(BUILD, "preview", "characters.jpg"), width=1280, height=720, samples=96, exposure=1.0)
        return
    bl.export_gltf(os.path.join(OUT, "hands.gltf"), right + left, image_format="WEBP", quality=86)
    bl.export_gltf(os.path.join(OUT, "crew.gltf"), crew, image_format="WEBP", quality=86)
    print("[characters] exported", OUT)


if __name__ == "__main__":
    main()
