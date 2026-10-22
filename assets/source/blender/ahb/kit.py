"""Game-space modelling kit: boxes by extents, oriented quads, panels, arrays and orientation.

All coordinates are game space (see ``bl.G``). Directions transform like positions.
"""

from __future__ import annotations

import math
from typing import Sequence

import bmesh
import bpy
from mathutils import Matrix, Vector

from . import bl
from .library import size_of


def D(x: float, y: float, z: float) -> Vector:
    """Game direction -> Blender direction."""
    return Vector((-x, -z, y))


def aabb(name: str, x0: float, y0: float, z0: float, x1: float, y1: float, z1: float, mat=None, *, bevel: float = 0.0, segments: int = 2, col=None, uv: float | tuple[float, float] | None = None, cull_bottom: bool = True) -> bpy.types.Object:
    """Box from game-space extents, box-UV mapped at the material's real-world size."""
    c = ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    s = (abs(x1 - x0), abs(y1 - y0), abs(z1 - z0))
    o = bl.box(name, c, s, mat, bevel=bevel, segments=segments, col=col)
    bpy.context.view_layer.update()
    bl.box_uv(o, uv if uv is not None else size_of(mat))
    if cull_bottom and min(y0, y1) <= 0.002:
        cull_faces(o, lambda n, ctr: n.z < -0.9 and ctr.z < 0.003)
    return o


def cull_faces(obj: bpy.types.Object, pred) -> None:
    """Deletes faces whose world normal/centre satisfy ``pred`` (hidden faces waste lightmap)."""
    mw = obj.matrix_world
    nm = mw.to_3x3().inverted().transposed()
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    kill = [f for f in bm.faces if pred((nm @ f.normal).normalized(), mw @ f.calc_center_median())]
    if kill:
        bmesh.ops.delete(bm, geom=kill, context="FACES")
        bm.to_mesh(obj.data)
    bm.free()


def quad(name: str, corners: Sequence[Sequence[float]], facing: Sequence[float], mat=None, *, col=None, uv: float | tuple[float, float] | None = None, cuts: tuple[int, int] = (0, 0)) -> bpy.types.Object:
    """Planar quad from four game-space corners, normal forced towards ``facing``.

    ``cuts`` subdivides (u, v) so lightmaps/vertex lighting get interior vertices.
    """
    bm = bmesh.new()
    vs = [bm.verts.new(bl.G(*c)) for c in corners]
    f = bm.faces.new(vs)
    bm.normal_update()
    want = D(*facing)
    if f.normal.dot(want) < 0:
        f.normal_flip()
    if cuts[0] or cuts[1]:
        edges = list(f.edges)
        if cuts[0]:
            bmesh.ops.subdivide_edges(bm, edges=[edges[0], edges[2]], cuts=cuts[0], use_grid_fill=True)
    obj = bl._obj_from_bm(name, bm, mat, col)
    bl.box_uv(obj, uv if uv is not None else size_of(mat))
    return obj


def wall_rect(name: str, axis: str, at: float, a0: float, a1: float, y0: float, y1: float, facing: int, mat=None, *, col=None, uv=None) -> bpy.types.Object:
    """Vertical rectangle on plane x=at (axis 'x', spans z a0..a1) or z=at (axis 'z', spans x)."""
    if axis == "x":
        corners = [(at, y0, a0), (at, y0, a1), (at, y1, a1), (at, y1, a0)]
        f = (facing, 0, 0)
    else:
        corners = [(a0, y0, at), (a1, y0, at), (a1, y1, at), (a0, y1, at)]
        f = (0, 0, facing)
    return quad(name, corners, f, mat, col=col, uv=uv)


def floor_rect(name: str, x0: float, x1: float, z0: float, z1: float, y: float, mat=None, *, down: bool = False, col=None, uv=None) -> bpy.types.Object:
    corners = [(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)]
    return quad(name, corners, (0, -1 if down else 1, 0), mat, col=col, uv=uv)


def orient(obj: bpy.types.Object, facing: Sequence[float], up: Sequence[float] = (0, 1, 0), at: Sequence[float] | None = None) -> bpy.types.Object:
    """Rotates an object whose local +Z is its front and +Y its up to face a game direction."""
    f = D(*facing).normalized()
    u = D(*up).normalized()
    r = u.cross(f).normalized()
    u = f.cross(r).normalized()
    m = Matrix((r, u, f)).transposed().to_4x4()
    loc = bl.G(*at) if at is not None else obj.matrix_world.translation
    obj.matrix_world = Matrix.Translation(loc) @ m
    return obj


def place(obj: bpy.types.Object, at: Sequence[float], yaw_deg: float = 0.0) -> bpy.types.Object:
    """Places an object at a game point, rotated about the vertical axis (degrees, CCW from above in Blender)."""
    obj.location = bl.G(*at)
    obj.rotation_euler = (0, 0, math.radians(yaw_deg))
    return obj


def frame(name: str, x0: float, y0: float, x1: float, y1: float, z: float, depth: float, width: float, mat=None, *, axis: str = "z", col=None) -> list[bpy.types.Object]:
    """Rectangular frame (four bars) in a vertical plane, e.g. window or door frames."""
    out = []
    if axis == "z":
        out.append(aabb(f"{name}_l", x0, y0, z - depth / 2, x0 + width, y1, z + depth / 2, mat, col=col, cull_bottom=False))
        out.append(aabb(f"{name}_r", x1 - width, y0, z - depth / 2, x1, y1, z + depth / 2, mat, col=col, cull_bottom=False))
        out.append(aabb(f"{name}_b", x0 + width, y0, z - depth / 2, x1 - width, y0 + width, z + depth / 2, mat, col=col, cull_bottom=False))
        out.append(aabb(f"{name}_t", x0 + width, y1 - width, z - depth / 2, x1 - width, y1, z + depth / 2, mat, col=col, cull_bottom=False))
    else:
        out.append(aabb(f"{name}_l", z - depth / 2, y0, x0, z + depth / 2, y1, x0 + width, mat, col=col, cull_bottom=False))
        out.append(aabb(f"{name}_r", z - depth / 2, y0, x1 - width, z + depth / 2, y1, x1, mat, col=col, cull_bottom=False))
        out.append(aabb(f"{name}_b", z - depth / 2, y0, x0 + width, z + depth / 2, y0 + width, x1 - width, mat, col=col, cull_bottom=False))
        out.append(aabb(f"{name}_t", z - depth / 2, y1 - width, x0 + width, z + depth / 2, y1, x1 - width, mat, col=col, cull_bottom=False))
    return out


def area_light(name: str, at: Sequence[float], size: tuple[float, float], power: float, color: Sequence[float], facing: Sequence[float] = (0, -1, 0), up: Sequence[float] = (0, 0, 1), *, spread: float = 180.0) -> bpy.types.Object:
    li = bpy.data.lights.new(name, "AREA")
    li.shape = "RECTANGLE"
    li.size, li.size_y = size
    li.energy = power
    li.color = bl.srgb_to_linear(color)
    li.spread = math.radians(spread)
    obj = bpy.data.objects.new(name, li)
    bl.link(obj, bl.collection("lights"))
    # Area lights emit along local -Z.
    f = D(*facing).normalized()
    u = D(*up).normalized()
    z = -f
    r = u.cross(z).normalized()
    u2 = z.cross(r).normalized()
    obj.matrix_world = Matrix.Translation(bl.G(*at)) @ Matrix((r, u2, z)).transposed().to_4x4()
    return obj


def point_light(name: str, at: Sequence[float], power: float, color: Sequence[float], radius: float = 0.05) -> bpy.types.Object:
    li = bpy.data.lights.new(name, "POINT")
    li.energy = power
    li.color = bl.srgb_to_linear(color)
    li.shadow_soft_size = radius
    obj = bpy.data.objects.new(name, li)
    bl.link(obj, bl.collection("lights"))
    obj.location = bl.G(*at)
    return obj


def spot_light(name: str, at: Sequence[float], direction: Sequence[float], power: float, color: Sequence[float], *, angle_deg: float = 60.0, blend: float = 0.5, radius: float = 0.05) -> bpy.types.Object:
    li = bpy.data.lights.new(name, "SPOT")
    li.energy = power
    li.color = bl.srgb_to_linear(color)
    li.spot_size = math.radians(angle_deg)
    li.spot_blend = blend
    li.shadow_soft_size = radius
    obj = bpy.data.objects.new(name, li)
    bl.link(obj, bl.collection("lights"))
    obj.location = bl.G(*at)
    obj.rotation_euler = (-D(*direction)).to_track_quat("Z", "Y").to_euler()
    return obj


def emitter(name: str, color: Sequence[float], strength: float) -> bpy.types.Material:
    """Pure emission material (``emit_`` prefix tells the client to render it unlit + glow)."""
    mat = bpy.data.materials.get(f"emit_{name}") or bpy.data.materials.new(f"emit_{name}")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (0, 0, 0, 1)
    bsdf.inputs["Emission Color"].default_value = (*bl.srgb_to_linear(color), 1)
    bsdf.inputs["Emission Strength"].default_value = strength
    bsdf.inputs["Roughness"].default_value = 0.4
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    return mat


def no_light_contribution(obj: bpy.types.Object) -> None:
    """Visible to camera only: geometry that stands for a light source already modelled by a lamp."""
    obj.visible_diffuse = False
    obj.visible_glossy = False
    obj.visible_transmission = False
    obj.visible_volume_scatter = False
    obj.visible_shadow = False


def prism(name: str, profile: Sequence[tuple[float, float]], plane: str, start: float, length: float, mat=None, *, col=None, uv=None, bevel: float = 0.0) -> bpy.types.Object:
    """Extrudes a 2D profile. ``plane`` 'zy': profile is (z, y), extruded along +x from ``start``;
    'xy': (x, y) along +z; 'xz': (x, z) along +y."""
    def P(a: float, b: float, t: float) -> Vector:
        if plane == "zy":
            return bl.G(t, b, a)
        if plane == "xy":
            return bl.G(a, b, t)
        return bl.G(a, t, b)

    bm = bmesh.new()
    v0 = [bm.verts.new(P(a, b, start)) for a, b in profile]
    v1 = [bm.verts.new(P(a, b, start + length)) for a, b in profile]
    n = len(profile)
    bm.faces.new(v0)
    bm.faces.new(list(reversed(v1)))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((v0[i], v0[j], v1[j], v1[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=2, profile=0.5, affect="EDGES", clamp_overlap=True)
    obj = bl._obj_from_bm(name, bm, mat, col)
    if bevel > 0:
        bl.smooth_by_angle(obj, 35)
    bl.box_uv(obj, uv if uv is not None else size_of(mat))
    return obj


def image_material(name: str, path: str, *, rough: float = 0.6, emission: float = 0.0, metal: float = 0.0, alpha: bool = False) -> bpy.types.Material:
    """Material showing a whole image (0..1 UVs); optional emission (light boxes, screens)."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for nd in list(nt.nodes):
        nt.nodes.remove(nd)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = "UVMap"
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bl.image(path, "sRGB")
    tex.extension = "EXTEND"
    nt.links.new(uvn.outputs[0], tex.inputs[0])
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emission > 0:
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = emission
    if alpha:
        nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    return mat


def image_plane(name: str, center: Sequence[float], w: float, h: float, facing: Sequence[float], mat, *, up: Sequence[float] = (0, 1, 0), col=None, u_range=(0.0, 1.0), v_range=(0.0, 1.0)) -> bpy.types.Object:
    """Rectangle showing an image the right way round when viewed from ``facing``."""
    bm = bmesh.new()
    vs = [bm.verts.new((x, y, 0)) for x, y in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]
    f = bm.faces.new(vs)
    uvl = bm.loops.layers.uv.new("UVMap")
    for loop, (u, v) in zip(f.loops, ((u_range[0], v_range[0]), (u_range[1], v_range[0]), (u_range[1], v_range[1]), (u_range[0], v_range[1]))):
        loop[uvl].uv = (u, v)
    obj = bl._obj_from_bm(name, bm, mat, col)
    orient(obj, facing, up, at=center)
    bl.transform_apply(obj)
    return obj


def uv_project_box(obj: bpy.types.Object, x0: float, x1: float, y0: float, y1: float, face_dir: Sequence[float], u_range=(0.0, 1.0), v_range=(0.0, 1.0)) -> None:
    """Maps faces pointing along ``face_dir`` (game) onto an image spanning game extents."""
    me = obj.data
    mw = obj.matrix_world
    nmat = mw.to_3x3().inverted().transposed()
    want = D(*face_dir).normalized()
    uvl = me.uv_layers["UVMap"].data
    for poly in me.polygons:
        if (nmat @ poly.normal).normalized().dot(want) < 0.7:
            continue
        for li in poly.loop_indices:
            p = mw @ me.vertices[me.loops[li].vertex_index].co
            gx, gy, gz = -p.x, p.z, -p.y
            a = gx if abs(face_dir[2]) > 0.5 else gz
            sgn = 1 if (face_dir[2] < 0 or face_dir[0] > 0) else -1
            if abs(face_dir[2]) > 0.5:
                t = (a - x0) / (x1 - x0)
                t = t if face_dir[2] < 0 else 1 - t
            else:
                t = (a - x0) / (x1 - x0)
                t = 1 - t if face_dir[0] < 0 else t
            s = (gy - y0) / (y1 - y0)
            uvl[li].uv = (u_range[0] + (u_range[1] - u_range[0]) * t, v_range[0] + (v_range[1] - v_range[0]) * s)


def helix(name: str, base: Sequence[float], radius: float, height: float, turns: float, wire: float, mat=None, *, col=None) -> bpy.types.Object:
    pts = []
    steps = int(turns * 16)
    for i in range(steps + 1):
        t = i / steps
        a = t * turns * 2 * math.pi
        pts.append((base[0] + math.cos(a) * radius, base[1] + t * height, base[2] + math.sin(a) * radius))
    return bl.tube(name, pts, wire, mat, col=col)


def cushion(name: str, x0: float, y0: float, z0: float, x1: float, y1: float, z1: float, mat=None, *, radius: float = 0.03, col=None) -> bpy.types.Object:
    """Soft upholstered block: heavily rounded edges, smooth shaded."""
    o = aabb(name, x0, y0, z0, x1, y1, z1, mat, bevel=radius, segments=4, col=col, cull_bottom=False)
    for p in o.data.polygons:
        p.use_smooth = True
    return o
