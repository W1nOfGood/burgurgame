"""Texel-space texturing for organic meshes (skin).

The mesh is unwrapped once, then every covered texel gets its rest-pose position and normal in
game space (``rasterize``). Anatomy and micro-detail are computed from those 3-D positions, so
pores, creases and fingerprints run continuously across UV seams. Height goes through a Cycles
bake (image -> Bump -> tangent-space normal), so the tangent frame is Blender's own MikkTSpace,
which the exporter writes alongside the mesh.
"""

from __future__ import annotations

import math

import bpy
import numpy as np

from . import bl


def to_game(v: np.ndarray) -> np.ndarray:
    """Blender (x, y, z) -> game (x, y, z); inverse of ``bl.G``."""
    return np.stack([-v[..., 0], v[..., 2], -v[..., 1]], -1)


def rasterize(obj: bpy.types.Object, size: int, layer: str = "UVMap") -> dict:
    """Per-texel rest-pose position and normal (game space) over ``layer``; rows top-first."""
    me = obj.data
    me.calc_loop_triangles()
    nl, nv, nt = len(me.loops), len(me.vertices), len(me.loop_triangles)
    uv = np.empty(nl * 2)
    me.uv_layers[layer].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    co = np.empty(nv * 3)
    me.vertices.foreach_get("co", co)
    co = to_game(co.reshape(-1, 3))
    cn = np.empty(nl * 3)
    me.corner_normals.foreach_get("vector", cn)
    cn = to_game(cn.reshape(-1, 3))
    lt = np.empty(nt * 3, dtype=np.int64)
    me.loop_triangles.foreach_get("loops", lt)
    lt = lt.reshape(-1, 3)
    vi = np.empty(nl, dtype=np.int64)
    me.loops.foreach_get("vertex_index", vi)
    xy = np.stack([uv[..., 0] * size, (1.0 - uv[..., 1]) * size], -1)[lt]  # (nt, 3, 2)
    P = np.zeros((size, size, 3))
    N = np.zeros((size, size, 3))
    M = np.zeros((size, size), bool)
    for t in range(nt):
        (x0, y0), (x1, y1), (x2, y2) = xy[t]
        d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(d) < 1e-12:
            continue
        ix0 = max(int(math.floor(min(x0, x1, x2))), 0)
        ix1 = min(int(math.ceil(max(x0, x1, x2))), size - 1)
        iy0 = max(int(math.floor(min(y0, y1, y2))), 0)
        iy1 = min(int(math.ceil(max(y0, y1, y2))), size - 1)
        if ix1 < ix0 or iy1 < iy0:
            continue
        X, Y = np.meshgrid(np.arange(ix0, ix1 + 1) + 0.5, np.arange(iy0, iy1 + 1) + 0.5)
        w0 = ((y1 - y2) * (X - x2) + (x2 - x1) * (Y - y2)) / d
        w1 = ((y2 - y0) * (X - x2) + (x0 - x2) * (Y - y2)) / d
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -1e-4) & (w1 >= -1e-4) & (w2 >= -1e-4)
        if not inside.any():
            continue
        ys, xs = np.nonzero(inside)
        ys += iy0
        xs += ix0
        w = np.stack([w0[inside], w1[inside], w2[inside]], -1)
        l = lt[t]
        P[ys, xs] = w @ co[vi[l]]
        N[ys, xs] = w @ cn[l]
        M[ys, xs] = True
    N /= np.maximum(np.linalg.norm(N, axis=-1, keepdims=True), 1e-9)
    area = mesh_area(obj)
    return {"P": P, "N": N, "mask": M, "size": size, "texel_area": area / max(1, int(M.sum()))}


def mesh_area(obj: bpy.types.Object) -> float:
    a = np.empty(len(obj.data.polygons))
    obj.data.polygons.foreach_get("area", a)
    return float(a.sum())


# ----------------------------------------------------------------------------------------------
# 3-D noise (seam-free because it is evaluated on surface positions)


def _hash(ix, iy, iz, seed: int) -> np.ndarray:
    n = (ix.astype(np.uint64) * np.uint64(73856093)) ^ (iy.astype(np.uint64) * np.uint64(19349663)) ^ (iz.astype(np.uint64) * np.uint64(83492791)) ^ np.uint64(seed * 2654435761 % 2**32)
    n = (n ^ (n >> np.uint64(13))) * np.uint64(1274126177)
    n = n ^ (n >> np.uint64(16))
    return (n & np.uint64(0xFFFFFF)).astype(np.float64) / float(0xFFFFFF)


def vnoise3(P: np.ndarray, freq: float, seed: int = 0) -> np.ndarray:
    """Quintic value noise in [0, 1] at ``freq`` cycles per metre."""
    X = P * freq
    i = np.floor(X).astype(np.int64)
    f = X - i
    u = f * f * f * (f * (f * 6 - 15) + 10)
    out = 0.0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (u[..., 0] if dx else 1 - u[..., 0]) * (u[..., 1] if dy else 1 - u[..., 1]) * (u[..., 2] if dz else 1 - u[..., 2])
                out = out + w * _hash(i[..., 0] + dx, i[..., 1] + dy, i[..., 2] + dz, seed)
    return out


def _rotation(seed: int) -> np.ndarray:
    q, _ = np.linalg.qr(np.random.default_rng(seed).normal(size=(3, 3)))
    return q


def fbm3(P: np.ndarray, freq: float, octaves: int = 4, seed: int = 0, gain: float = 0.5) -> np.ndarray:
    """Fractal value noise in roughly [-1, 1]; every octave in its own random orientation, so
    the lattice of value noise never lines up into visible streaks."""
    total, amp, norm = 0.0, 1.0, 0.0
    for o in range(octaves):
        total = total + amp * (vnoise3(P @ _rotation(seed * 31 + o), freq * 2**o, seed + 17 * o) * 2 - 1)
        norm += amp
        amp *= gain
    return total / norm


def cellular(P: np.ndarray, area: float, spacing: float, seed: int, k: int = 2) -> np.ndarray:
    """Distances to the k nearest of ~area/spacing² random surface points (Voronoi on the skin)."""
    from scipy.spatial import cKDTree

    rng = np.random.default_rng(seed)
    n = max(8, int(area / spacing**2))
    idx = rng.choice(len(P), n, replace=n > len(P))
    pts = P[idx] + rng.normal(0, spacing * 0.05, (n, 3))
    d, _ = cKDTree(pts).query(P, k=k, workers=-1)
    return d


def thickness(obj: bpy.types.Object, R: dict, max_depth: float = 0.03) -> np.ndarray:
    """Distance through the mesh along -normal per texel (translucency), metres, 0 off-mesh."""
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree

    dg = bpy.context.evaluated_depsgraph_get()
    tree = BVHTree.FromObject(obj, dg)
    P, N, M = R["P"], R["N"], R["mask"]
    out = np.zeros(M.shape)
    ys, xs = np.nonzero(M)
    for y, x in zip(ys, xs):
        p = P[y, x]
        n = N[y, x]
        o = Vector((-(p[0] - n[0] * 1e-4), -(p[2] - n[2] * 1e-4), p[1] - n[1] * 1e-4))
        dirv = Vector((n[0], n[2], -n[1]))  # -normal in Blender space
        hit, _nrm, _i, dist = tree.ray_cast(o, dirv, max_depth)
        out[y, x] = dist if hit is not None else max_depth
    return out


# ----------------------------------------------------------------------------------------------
# Baking


def _float_image(name: str, arr: np.ndarray) -> bpy.types.Image:
    """Float image from a top-first (H, W) or (H, W, 3) array."""
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, float_buffer=True, alpha=False)
    img.colorspace_settings.name = "Non-Color"
    rgba = np.ones((h, w, 4), np.float32)
    if arr.ndim == 2:
        rgba[..., :3] = arr[..., None]
    else:
        rgba[..., :3] = arr
    img.pixels.foreach_set(rgba[::-1].ravel())
    return img


def bake_normal(obj: bpy.types.Object, height: np.ndarray, *, margin: int = 8, uv: str = "UVMap") -> np.ndarray:
    """Tangent-space normal map (OpenGL, 0..1 RGB, top-first) from a height field in metres."""
    size = height.shape[0]
    src = _float_image("__bake_height", height)
    out = bpy.data.images.new("__bake_normal", size, size, float_buffer=True, alpha=False)
    out.colorspace_settings.name = "Non-Color"
    mat = bpy.data.materials.new("__bake_bump")
    nt, bsdf = bl._nodes(mat)
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = uv
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = src
    tex.interpolation = "Cubic"
    nt.links.new(uvn.outputs[0], tex.inputs[0])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 1.0
    bump.inputs["Distance"].default_value = 1.0
    nt.links.new(tex.outputs["Color"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    target = nt.nodes.new("ShaderNodeTexImage")
    target.image = out
    nt.nodes.active = target
    saved = [s.material for s in obj.material_slots]
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    obj.data.uv_layers.active = obj.data.uv_layers[uv]
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 1
    bake = scene.render.bake
    bake.margin = margin
    bake.margin_type = "EXTEND"
    bake.use_clear = True
    bake.target = "IMAGE_TEXTURES"
    bake.normal_space = "TANGENT"
    ctx = bpy.context
    for o in ctx.view_layer.objects:
        o.select_set(False)
    obj.select_set(True)
    ctx.view_layer.objects.active = obj
    bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", margin=margin, use_clear=True)
    px = np.array(out.pixels[:], dtype=np.float32).reshape(size, size, 4)[::-1, :, :3].copy()
    obj.data.materials.clear()
    for m in saved:
        obj.data.materials.append(m)
    for img in (src, out):
        bpy.data.images.remove(img)
    bpy.data.materials.remove(mat)
    return px


def blur(img: np.ndarray, sigma_px: float) -> np.ndarray:
    from scipy.ndimage import gaussian_filter

    if img.ndim == 2:
        return gaussian_filter(img, sigma_px, mode="nearest")
    return np.stack([gaussian_filter(img[..., c], sigma_px, mode="nearest") for c in range(img.shape[-1])], -1)


def smoothstep(e0: float, e1: float, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)
