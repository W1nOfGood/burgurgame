"""Signed-distance sculpting: analytic primitives with smooth unions, polygonised with marching
cubes into Blender meshes. Used for organic forms (hands, bodies, heads) where precise control
over where shapes blend matters more than a modifier stack.

All coordinates are game space (x right, y up, z forward); distances in metres.
"""

from __future__ import annotations

import numpy as np

# ----------------------------------------------------------------------------------------------
# Primitives (P: (..., 3) array of points)


def sphere(P, c, r):
    return np.linalg.norm(P - np.asarray(c), axis=-1) - r


def ellipsoid(P, c, radii):
    """Approximate ellipsoid distance (Quilez)."""
    q = (P - np.asarray(c)) / np.asarray(radii)
    k0 = np.linalg.norm(q, axis=-1)
    k1 = np.linalg.norm(q / np.asarray(radii), axis=-1)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def round_cone(P, a, b, r1, r2):
    """Capsule with different end radii between points a and b."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    ba = b - a
    l2 = ba @ ba
    rr = r1 - r2
    a2 = l2 - rr * rr
    il2 = 1.0 / l2
    pa = P - a
    y = pa @ ba
    z = y - l2
    xv = pa * l2 - y[..., None] * ba
    x2 = np.einsum("...i,...i->...", xv, xv)
    y2 = y * y * l2
    z2 = z * z * l2
    k = np.sign(rr) * rr * rr * x2
    d1 = np.sqrt(x2 + z2) * il2 - r2
    d2 = np.sqrt(x2 + y2) * il2 - r1
    d3 = (np.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1
    out = np.where(np.sign(z) * a2 * z2 > k, d1, np.where(np.sign(y) * a2 * y2 < k, d2, d3))
    return out


def capsule(P, a, b, r):
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    pa = P - a
    ba = b - a
    h = np.clip((pa @ ba) / (ba @ ba), 0.0, 1.0)
    return np.linalg.norm(pa - h[..., None] * ba, axis=-1) - r


def round_box(P, c, half, r):
    q = np.abs(P - np.asarray(c)) - (np.asarray(half) - r)
    return np.linalg.norm(np.maximum(q, 0.0), axis=-1) + np.minimum(np.max(q, axis=-1), 0.0) - r


def torus_y(P, c, R, r):
    """Torus around the game Y axis."""
    q = P - np.asarray(c)
    xz = np.sqrt(q[..., 0] ** 2 + q[..., 2] ** 2) - R
    return np.sqrt(xz**2 + q[..., 1] ** 2) - r


def torus_z(P, c, R, r):
    """Torus around the game Z axis (rings on a forearm/finger pointing +z)."""
    q = P - np.asarray(c)
    xy = np.sqrt(q[..., 0] ** 2 + q[..., 1] ** 2) - R
    return np.sqrt(xy**2 + q[..., 2] ** 2) - r


# ----------------------------------------------------------------------------------------------
# Operators


def smin(a, b, k):
    """Polynomial smooth minimum (blend radius k)."""
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def union(*ds):
    out = ds[0]
    for d in ds[1:]:
        out = np.minimum(out, d)
    return out


def sunion(k, *ds):
    out = ds[0]
    for d in ds[1:]:
        out = smin(out, d, k)
    return out


# ----------------------------------------------------------------------------------------------
# Polygonise


def polygonise(fn, lo, hi, voxel: float):
    """Evaluates ``fn(P)`` on a grid and runs marching cubes; returns (verts, faces) in game space."""
    from skimage.measure import marching_cubes

    lo = np.asarray(lo, dtype=np.float64)
    hi = np.asarray(hi, dtype=np.float64)
    n = np.ceil((hi - lo) / voxel).astype(int) + 1
    xs = lo[0] + np.arange(n[0]) * voxel
    ys = lo[1] + np.arange(n[1]) * voxel
    zs = lo[2] + np.arange(n[2]) * voxel
    D = np.empty((len(xs), len(ys), len(zs)), dtype=np.float32)
    step = max(1, int(4_000_000 // (len(ys) * len(zs))))
    for i0 in range(0, len(xs), step):
        X, Y, Z = np.meshgrid(xs[i0 : i0 + step], ys, zs, indexing="ij")
        D[i0 : i0 + step] = fn(np.stack([X, Y, Z], -1))
    verts, faces, _normals, _ = marching_cubes(D, level=0.0, spacing=(voxel, voxel, voxel))
    verts = verts + lo
    return verts, faces


def to_blender(name: str, verts, faces, mat=None, *, decimate: float = 1.0, smooth_iters: int = 2):
    """Builds a Blender mesh object from game-space vertices (converted to Blender space)."""
    import bpy

    from . import bl

    import bmesh

    bverts = [tuple(bl.G(*v)) for v in verts]
    me = bpy.data.meshes.new(name)
    me.from_pydata(bverts, [], [tuple(f) for f in faces.tolist()])
    me.validate()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bl.link(obj, None)
    if smooth_iters:
        sm = obj.modifiers.new("smooth", "LAPLACIANSMOOTH")
        sm.iterations = smooth_iters
        sm.lambda_factor = 0.4
        sm.use_volume_preserve = True
    if decimate < 1.0:
        dec = obj.modifiers.new("dec", "DECIMATE")
        dec.ratio = decimate
    bl.apply_modifiers(obj)
    for p in obj.data.polygons:
        p.use_smooth = True
    if mat is not None:
        obj.data.materials.append(mat)
    return obj


def skin_weights(obj, bones: dict[str, tuple[tuple[float, float, float], tuple[float, float, float]]], *, falloff: float = 4.0, max_influences: int = 3, rigid: dict[str, list[str]] | None = None) -> None:
    """Vertex groups from distance to bone segments (game space): w ~ 1/d^falloff, top-N kept.

    ``rigid`` maps a bone to the bones it must not blend with (e.g. fingers that touch).
    """
    from . import bl

    me = obj.data
    mw = obj.matrix_world
    V = np.array([tuple(mw @ v.co) for v in me.vertices])
    G = np.stack([-V[:, 0], V[:, 2], -V[:, 1]], -1)  # Blender -> game
    names = list(bones)
    D = np.zeros((len(G), len(names)))
    for j, n in enumerate(names):
        a, b = (np.asarray(p, dtype=np.float64) for p in bones[n])
        pa = G - a
        ba = b - a
        h = np.clip((pa @ ba) / (ba @ ba), 0.0, 1.0)
        D[:, j] = np.linalg.norm(pa - h[:, None] * ba, axis=-1)
    W = 1.0 / np.maximum(D, 1e-4) ** falloff
    order = np.argsort(-W, axis=1)
    groups = {n: obj.vertex_groups.new(name=n) for n in names}
    for i in range(len(G)):
        top = order[i, :max_influences]
        w = W[i, top]
        best = names[top[0]]
        if rigid and best in rigid:
            keep = [k for k, t in enumerate(top) if names[t] == best or names[t] not in rigid[best]]
            top = top[keep]
            w = w[keep]
        w = w / w.sum()
        for t, ww in zip(top, w):
            if ww > 0.02:
                groups[names[t]].add([i], float(ww), "REPLACE")
