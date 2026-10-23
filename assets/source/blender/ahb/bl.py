"""Blender (bpy) helpers shared by every asset script: scene setup, game<->Blender coordinates,
mesh construction, PBR materials, UV layout, lightmap baking, denoising and glTF export.

Game space is the Babylon space used by ``packages/data`` (Y up, left-handed). The glTF
exporter writes Blender (x, y, z) as glTF (x, z, -y) and Babylon's glTF loader then flips
handedness to (-x, y, z). So a game point (X, Y, Z) lives at Blender (-X, -Z, Y).
"""

from __future__ import annotations

import math
import os
from typing import Iterable, Sequence

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

# ----------------------------------------------------------------------------------------------
# Coordinates


def G(x: float, y: float, z: float) -> Vector:
    """Game position -> Blender position."""
    return Vector((-x, -z, y))


def GS(w: float, h: float, d: float) -> Vector:
    """Game size (x, y, z extents) -> Blender size."""
    return Vector((w, d, h))


def game_yaw(deg: float) -> float:
    """Rotation about game +Y (counter-clockwise seen from above in Babylon) -> Blender Z."""
    # Babylon is left-handed: +yaw turns +X towards -Z... we keep it explicit per call instead.
    return math.radians(deg)


# ----------------------------------------------------------------------------------------------
# Scene


def reset(engine: str = "CYCLES") -> bpy.types.Scene:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = engine
    scene.unit_settings.system = "METRIC"
    cy = scene.cycles
    cy.device = "CPU"
    cy.use_denoising = False
    cy.max_bounces = 6
    cy.diffuse_bounces = 4
    cy.glossy_bounces = 3
    cy.transmission_bounces = 4
    cy.transparent_max_bounces = 8
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    cy.sample_clamp_indirect = 8.0
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.render.threads_mode = "AUTO"
    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    return scene


def collection(name: str, parent: bpy.types.Collection | None = None) -> bpy.types.Collection:
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(col)
    return col


def link(obj: bpy.types.Object, col: bpy.types.Collection | None) -> bpy.types.Object:
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    (col or bpy.context.scene.collection).objects.link(obj)
    return obj


def world_color(rgb: Sequence[float], strength: float) -> None:
    w = bpy.context.scene.world
    bg = w.node_tree.nodes.get("Background")
    if bg is None:
        bg = w.node_tree.nodes.new("ShaderNodeBackground")
        out = w.node_tree.nodes.new("ShaderNodeOutputWorld")
        w.node_tree.links.new(bg.outputs[0], out.inputs[0])
    bg.inputs["Color"].default_value = (*rgb, 1)
    bg.inputs["Strength"].default_value = strength


# ----------------------------------------------------------------------------------------------
# Materials

_TEX_CACHE: dict[str, bpy.types.Image] = {}


def image(path: str, colorspace: str = "sRGB") -> bpy.types.Image:
    key = f"{path}|{colorspace}"
    img = _TEX_CACHE.get(key)
    if img is None:
        img = bpy.data.images.load(path, check_existing=True)
        img.colorspace_settings.name = colorspace
        _TEX_CACHE[key] = img
    return img


def _nodes(mat: bpy.types.Material):
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (400, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (100, 0)
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    return nt, bsdf


def solid(name: str, color: Sequence[float], rough: float = 0.5, metal: float = 0.0, *, emission: Sequence[float] | None = None, emission_strength: float = 1.0, alpha: float = 1.0, coat: float = 0.0, transmission: float = 0.0, ior: float = 1.45, linear: bool = False) -> bpy.types.Material:
    """Untextured PBR material. ``color`` is sRGB unless ``linear``."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    nt, bsdf = _nodes(mat)
    c = color if linear else srgb_to_linear(color)
    bsdf.inputs["Base Color"].default_value = (*c, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emission is not None:
        e = emission if linear else srgb_to_linear(emission)
        bsdf.inputs["Emission Color"].default_value = (*e, 1)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    if coat:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = 0.05
    if transmission:
        bsdf.inputs["Transmission Weight"].default_value = transmission
        bsdf.inputs["IOR"].default_value = ior
    if alpha < 1:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.surface_render_method = "BLENDED"
    mat["ahb"] = {"kind": "solid"}
    return mat


def textured(name: str, maps: dict[str, str], *, tint: Sequence[float] | None = None, rough_scale: float = 1.0, normal_strength: float = 1.0, emission_map: str | None = None, emission_strength: float = 1.0, alpha_from_albedo: bool = False, uv: str = "UVMap") -> bpy.types.Material:
    """PBR material from texgen maps: albedo (sRGB), ORM (R unused, G rough, B metal), normal."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    nt, bsdf = _nodes(mat)
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = uv
    uvn.location = (-900, 0)
    alb = nt.nodes.new("ShaderNodeTexImage")
    alb.image = image(maps["albedo"], "sRGB")
    alb.location = (-600, 300)
    nt.links.new(uvn.outputs[0], alb.inputs[0])
    if tint is not None:
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs[7].default_value = (*srgb_to_linear(tint), 1)
        nt.links.new(alb.outputs["Color"], mix.inputs[6])
        nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
    else:
        nt.links.new(alb.outputs["Color"], bsdf.inputs["Base Color"])
    if alpha_from_albedo:
        nt.links.new(alb.outputs["Alpha"], bsdf.inputs["Alpha"])
        mat.surface_render_method = "DITHERED"
    if "orm" in maps:
        orm = nt.nodes.new("ShaderNodeTexImage")
        orm.image = image(maps["orm"], "Non-Color")
        orm.location = (-600, 0)
        nt.links.new(uvn.outputs[0], orm.inputs[0])
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        sep.location = (-300, 0)
        nt.links.new(orm.outputs["Color"], sep.inputs[0])
        if rough_scale != 1.0:
            mul = nt.nodes.new("ShaderNodeMath")
            mul.operation = "MULTIPLY"
            mul.inputs[1].default_value = rough_scale
            nt.links.new(sep.outputs["Green"], mul.inputs[0])
            nt.links.new(mul.outputs[0], bsdf.inputs["Roughness"])
        else:
            nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    if "normal" in maps:
        nm = nt.nodes.new("ShaderNodeTexImage")
        nm.image = image(maps["normal"], "Non-Color")
        nm.location = (-600, -300)
        nt.links.new(uvn.outputs[0], nm.inputs[0])
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nmap.uv_map = uv
        nmap.inputs["Strength"].default_value = normal_strength
        nmap.location = (-300, -300)
        nt.links.new(nm.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs[0], bsdf.inputs["Normal"])
    if emission_map:
        em = nt.nodes.new("ShaderNodeTexImage")
        em.image = image(emission_map, "sRGB")
        em.location = (-600, -600)
        nt.links.new(uvn.outputs[0], em.inputs[0])
        nt.links.new(em.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    mat["ahb"] = {"kind": "textured"}
    return mat


def srgb_to_linear(c: Sequence[float]) -> tuple[float, float, float]:
    def f(x: float) -> float:
        return x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4

    return (f(c[0]), f(c[1]), f(c[2]))


def hexrgb(h: str) -> tuple[float, float, float]:
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


# ----------------------------------------------------------------------------------------------
# Mesh construction (all inputs in game space unless noted)


def _obj_from_bm(name: str, bm: bmesh.types.BMesh, mat: bpy.types.Material | None, col=None) -> bpy.types.Object:
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    link(obj, col)
    if mat is not None:
        me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = False
    return obj


def box(name: str, center: Sequence[float], size: Sequence[float], mat=None, *, bevel: float = 0.0, segments: int = 2, col=None, yaw: float = 0.0) -> bpy.types.Object:
    """Axis-aligned (optionally yawed) box in game space with optional bevelled edges."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    s = GS(*size)
    bmesh.ops.scale(bm, vec=s, verts=bm.verts)
    if bevel > 0:
        b = min(bevel, min(s) * 0.49)
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=b, segments=segments, profile=0.5, affect="EDGES", clamp_overlap=True)
    obj = _obj_from_bm(name, bm, mat, col)
    obj.location = G(*center)
    obj.rotation_euler.z = yaw
    if bevel > 0:
        smooth_by_angle(obj, 35)
    return obj


def cylinder(name: str, center: Sequence[float], radius: float, height: float, mat=None, *, segments: int = 32, axis: str = "y", bevel: float = 0.0, col=None, cap: bool = True) -> bpy.types.Object:
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=segments, radius1=radius, radius2=radius, depth=height)
    if bevel > 0:
        rim = [e for e in bm.edges if len(e.link_faces) == 2 and abs(e.link_faces[0].normal.dot(e.link_faces[1].normal)) < 0.5]
        bmesh.ops.bevel(bm, geom=rim, offset=bevel, segments=2, profile=0.5, affect="EDGES", clamp_overlap=True)
    obj = _obj_from_bm(name, bm, mat, col)
    obj.location = G(*center)
    if axis == "x":
        obj.rotation_euler.y = math.pi / 2
    elif axis == "z":
        obj.rotation_euler.x = math.pi / 2
    smooth_by_angle(obj, 40)
    return obj


def lathe(name: str, profile: Sequence[tuple[float, float]], center: Sequence[float], mat=None, *, segments: int = 32, col=None, smooth_angle: float = 50) -> bpy.types.Object:
    """Revolve a (radius, height) profile about the game Y axis."""
    bm = bmesh.new()
    verts = [bm.verts.new((r, 0.0, y)) for r, y in profile]
    edges = [bm.edges.new((verts[i], verts[i + 1])) for i in range(len(verts) - 1)]
    bmesh.ops.spin(bm, geom=verts + edges, cent=(0, 0, 0), axis=(0, 0, 1), angle=2 * math.pi, steps=segments, use_merge=True, use_duplicate=False)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = _obj_from_bm(name, bm, mat, col)
    obj.location = G(*center)
    smooth_by_angle(obj, smooth_angle)
    return obj


def tube(name: str, points: Sequence[Sequence[float]], radius: float, mat=None, *, col=None, resolution: int = 8, segments: int = 12, cyclic: bool = False) -> bpy.types.Object:
    """Swept circular tube through game-space points (rails, handles, neon)."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = radius
    cu.bevel_resolution = max(1, segments // 4)
    cu.use_fill_caps = True
    sp = cu.splines.new("POLY")
    sp.points.add(len(points) - 1)
    for p, q in zip(sp.points, points):
        v = G(*q)
        p.co = (v.x, v.y, v.z, 1)
    sp.use_cyclic_u = cyclic
    obj = bpy.data.objects.new(name, cu)
    link(obj, col)
    if mat is not None:
        cu.materials.append(mat)
    return to_mesh(obj, smooth=True)


def bezier_tube(name: str, points: Sequence[Sequence[float]], radius: float, mat=None, *, col=None, resolution: int = 10, segments: int = 12, cyclic: bool = False) -> bpy.types.Object:
    """Smooth tube through game-space points using an auto-handled Bezier."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = radius
    cu.bevel_resolution = max(1, segments // 4)
    cu.resolution_u = resolution
    cu.use_fill_caps = True
    sp = cu.splines.new("BEZIER")
    sp.bezier_points.add(len(points) - 1)
    for bp, q in zip(sp.bezier_points, points):
        bp.co = G(*q)
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    sp.use_cyclic_u = cyclic
    obj = bpy.data.objects.new(name, cu)
    link(obj, col)
    if mat is not None:
        cu.materials.append(mat)
    return to_mesh(obj, smooth=True)


def text(name: str, body: str, font_path: str, size: float, mat=None, *, extrude: float = 0.0, bevel: float = 0.0, align: str = "CENTER", col=None, resolution: int = 6, spacing: float = 1.0) -> bpy.types.Object:
    """Text mesh lying in the Blender XY plane (callers place/rotate it)."""
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = body
    cu.font = bpy.data.fonts.load(font_path, check_existing=True)
    cu.size = size
    cu.extrude = extrude
    cu.bevel_depth = bevel
    cu.align_x = align
    cu.align_y = "CENTER"
    cu.resolution_u = resolution
    cu.space_character = spacing
    obj = bpy.data.objects.new(name, cu)
    link(obj, col)
    if mat is not None:
        cu.materials.append(mat)
    return to_mesh(obj, smooth=False)


def to_mesh(obj: bpy.types.Object, smooth: bool = False) -> bpy.types.Object:
    """Converts curves/text and applies all modifiers, keeping transforms."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    new = bpy.data.objects.new(obj.name, me)
    new.matrix_world = obj.matrix_world.copy()
    for c in obj.users_collection:
        c.objects.link(new)
    old_data = obj.data
    bpy.data.objects.remove(obj)
    if isinstance(old_data, bpy.types.Curve):
        bpy.data.curves.remove(old_data)
    new.name = new.name.split(".")[0] if new.name.endswith(".001") else new.name
    for p in me.polygons:
        p.use_smooth = smooth
    return new


def apply_modifiers(obj: bpy.types.Object) -> bpy.types.Object:
    if not obj.modifiers:
        return obj
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    old = obj.data
    obj.modifiers.clear()
    obj.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return obj


def smooth_by_angle(obj: bpy.types.Object, degrees: float) -> None:
    """Marks sharp edges above the angle and smooth-shades the rest (bakes into the mesh)."""
    me = obj.data
    if not isinstance(me, bpy.types.Mesh):
        return
    bm = bmesh.new()
    bm.from_mesh(me)
    lim = math.radians(degrees)
    for e in bm.edges:
        e.smooth = not (len(e.link_faces) != 2 or e.calc_face_angle(0.0) > lim)
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(me)
    bm.free()


def bevel_mod(obj: bpy.types.Object, width: float, segments: int = 2, angle: float = 30) -> bpy.types.Object:
    m = obj.modifiers.new("bevel", "BEVEL")
    m.width = width
    m.segments = segments
    m.limit_method = "ANGLE"
    m.angle_limit = math.radians(angle)
    m.harden_normals = False
    m.profile = 0.5
    apply_modifiers(obj)
    smooth_by_angle(obj, angle + 5)
    return obj


def subsurf(obj: bpy.types.Object, levels: int = 2) -> bpy.types.Object:
    m = obj.modifiers.new("subd", "SUBSURF")
    m.levels = levels
    m.render_levels = levels
    apply_modifiers(obj)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def transform_apply(obj: bpy.types.Object) -> None:
    """Bakes the object transform into its mesh.

    Built from location/rotation/scale rather than ``matrix_world``: Blender refreshes
    ``matrix_world`` only on a depsgraph update, so right after a script sets ``location`` it is
    stale and the transform would be silently dropped.
    """
    to_parent = obj.parent.matrix_world @ obj.matrix_parent_inverse if obj.parent is not None else Matrix.Identity(4)
    obj.data.transform(to_parent @ obj.matrix_basis)
    obj.matrix_basis = to_parent.inverted()


def join(objs: Sequence[bpy.types.Object], name: str) -> bpy.types.Object:
    """Joins mesh objects (materials kept per face) into the first; transforms baked."""
    objs = [o for o in objs if o is not None and o.type == "MESH"]
    if not objs:
        raise ValueError(f"join({name}): nothing to join")
    ctx = bpy.context
    for o in ctx.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    ctx.view_layer.objects.active = objs[0]
    with ctx.temp_override(active_object=objs[0], selected_editable_objects=objs, selected_objects=objs):
        bpy.ops.object.join()
    out = objs[0]
    out.name = name
    out.data.name = name
    transform_apply(out)
    return out


def duplicate(obj: bpy.types.Object, name: str, *, linked: bool = False, col=None) -> bpy.types.Object:
    new = obj.copy()
    if not linked:
        new.data = obj.data.copy()
    new.name = name
    link(new, col or (obj.users_collection[0] if obj.users_collection else None))
    return new


# ----------------------------------------------------------------------------------------------
# UVs


def box_uv(obj: bpy.types.Object, size_m: float | tuple[float, float] = 1.0, *, layer: str = "UVMap", rotate: bool = False, offset: tuple[float, float] = (0.0, 0.0)) -> None:
    """World-space tri-planar box mapping per face (constant texel density across objects).

    Vertical faces map (horizontal, up); horizontal faces map (x, y). ``rotate`` swaps the two
    axes on vertical faces (for textures whose grain should run vertically).
    """
    if isinstance(size_m, (int, float)):
        size_m = (float(size_m), float(size_m))
    me = obj.data
    mw = obj.matrix_world
    nmat = mw.to_3x3().inverted().transposed()
    if layer not in me.uv_layers:
        me.uv_layers.new(name=layer)
    uvl = me.uv_layers[layer].data
    verts = me.vertices
    for poly in me.polygons:
        n = (nmat @ poly.normal).normalized()
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for li in poly.loop_indices:
            p = mw @ verts[me.loops[li].vertex_index].co
            if az >= ax and az >= ay:
                u, v = p.x * (1 if n.z >= 0 else -1), p.y
            elif ax >= ay:
                u, v = (-p.y if n.x >= 0 else p.y), p.z
            else:
                u, v = (p.x if n.y >= 0 else -p.x), p.z
            if rotate and az < max(ax, ay):
                u, v = v, -u
            uvl[li].uv = (u / size_m[0] + offset[0], v / size_m[1] + offset[1])
    me.uv_layers[layer].active_render = True


def ensure_uv(obj: bpy.types.Object, layer: str = "UVMap") -> None:
    me = obj.data
    if layer not in me.uv_layers:
        me.uv_layers.new(name=layer)


def lightmap_uv(objs: Sequence[bpy.types.Object], *, margin: float = 0.004, angle: float = 60.0, density: dict[str, float] | None = None, layer: str = "Lightmap") -> None:
    """One shared lightmap layout over several objects (multi-object edit, uniform density).

    ``density`` optionally scales an object's islands relative to the rest (e.g. 0.5 for a
    ceiling) before packing.
    """
    ctx = bpy.context
    for o in ctx.view_layer.objects:
        o.select_set(False)
    for o in objs:
        me = o.data
        if layer not in me.uv_layers:
            me.uv_layers.new(name=layer)
        me.uv_layers.active = me.uv_layers[layer]
        o.select_set(True)
    ctx.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=0.0, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    if density:
        for o in objs:
            k = density.get(o.name)
            if not k or k == 1.0:
                continue
            bm = bmesh.from_edit_mesh(o.data)
            uvl = bm.loops.layers.uv[layer]
            for f in bm.faces:
                for l in f.loops:
                    l[uvl].uv *= k
            bmesh.update_edit_mesh(o.data)
    bpy.ops.uv.pack_islands(udim_source="CLOSEST_UDIM", rotate=True, rotate_method="AXIS_ALIGNED", scale=True, merge_overlap=False, margin_method="FRACTION", margin=margin, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")
    # Guard: if the packer spilled outside the unit square, refit everything uniformly.
    lo = np.array([np.inf, np.inf])
    hi = -lo
    for o in objs:
        uv = np.empty(len(o.data.loops) * 2)
        o.data.uv_layers[layer].data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2)
        lo = np.minimum(lo, uv.min(0))
        hi = np.maximum(hi, uv.max(0))
    if lo.min() < -1e-4 or hi.max() > 1.0001:
        k = 0.998 / max(hi - lo)
        print(f"[lightmap_uv] packer overflow {lo} {hi}; refitting by {k:.3f}")
        for o in objs:
            uv = np.empty(len(o.data.loops) * 2)
            o.data.uv_layers[layer].data.foreach_get("uv", uv)
            uv = ((uv.reshape(-1, 2) - lo) * k + 0.001).ravel()
            o.data.uv_layers[layer].data.foreach_set("uv", uv)
    for o in objs:
        # Texture lookups use UVMap explicitly; the bake writes to the active layer.
        if "UVMap" in o.data.uv_layers:
            o.data.uv_layers["UVMap"].active_render = True


# ----------------------------------------------------------------------------------------------
# Baking


def bake_lightmap(objs: Sequence[bpy.types.Object], size: int, samples: int, *, name: str, layer: str = "Lightmap", margin: int = 12, kind: str = "IRRADIANCE") -> np.ndarray:
    """Bakes diffuse irradiance (light only, no albedo) or AO into one atlas; returns float RGB.

    Every object's materials get a temporary image node targeting the atlas. Objects must
    already have the shared ``layer`` UVs.
    """
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    img = bpy.data.images.new(name, size, size, float_buffer=True, alpha=False)
    img.colorspace_settings.name = "Non-Color"
    temp_nodes = []
    seen = set()
    for o in objs:
        o.data.uv_layers.active = o.data.uv_layers[layer]
        for slot in o.material_slots:
            m = slot.material
            if m is None or m.name in seen:
                continue
            seen.add(m.name)
            nt = m.node_tree
            n = nt.nodes.new("ShaderNodeTexImage")
            n.image = img
            n.name = "__bake_target"
            nt.nodes.active = n
            n.select = True
            temp_nodes.append((nt, n))
    ctx = bpy.context
    for o in ctx.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    ctx.view_layer.objects.active = objs[0]
    bake = scene.render.bake
    bake.margin = margin
    bake.margin_type = "EXTEND"
    bake.use_clear = True
    bake.target = "IMAGE_TEXTURES"
    if kind == "IRRADIANCE":
        bake.use_pass_direct = True
        bake.use_pass_indirect = True
        bake.use_pass_color = False
        bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=margin, use_clear=True)
    elif kind == "AO":
        bpy.ops.object.bake(type="AO", margin=margin, use_clear=True)
    elif kind == "NORMAL":
        bake.normal_space = "OBJECT"
        bpy.ops.object.bake(type="NORMAL", margin=margin, use_clear=True)
    else:
        bpy.ops.object.bake(type=kind, margin=margin, use_clear=True)
    px = np.array(img.pixels[:], dtype=np.float32).reshape(size, size, 4)[::-1, :, :3].copy()
    for nt, n in temp_nodes:
        nt.nodes.remove(n)
    bpy.data.images.remove(img)
    return px


def coverage_mask(objs: Sequence[bpy.types.Object], size: int, layer: str = "Lightmap") -> np.ndarray:
    """Rasterises the lightmap UV triangles to a boolean mask (top row first)."""
    from PIL import Image, ImageDraw

    im = Image.new("L", (size, size), 0)
    dr = ImageDraw.Draw(im)
    for o in objs:
        me = o.data
        uv = me.uv_layers[layer].data
        for poly in me.polygons:
            pts = [(uv[li].uv.x * size, (1 - uv[li].uv.y) * size) for li in poly.loop_indices]
            dr.polygon(pts, fill=255)
    return np.array(im) > 0


def denoise(color: np.ndarray, *, lightmap: bool = True) -> np.ndarray:
    import pyoidn

    dev = pyoidn.Device()
    dev.commit()
    src = np.ascontiguousarray(color.astype(np.float32))
    out = np.zeros_like(src)
    flt = pyoidn.Filter(dev, pyoidn.OIDN_FILTER_TYPE_RT_LIGHTMAP if lightmap else pyoidn.OIDN_FILTER_TYPE_RT)
    flt.set_image(pyoidn.OIDN_IMAGE_COLOR, src, pyoidn.OIDN_FORMAT_FLOAT3)
    flt.set_image(pyoidn.OIDN_IMAGE_OUTPUT, out, pyoidn.OIDN_FORMAT_FLOAT3)
    if not lightmap:
        flt.set_bool("hdr", True)
    flt.commit()
    flt.execute()
    err = dev.get_error()
    if err and err[0]:
        raise RuntimeError(f"OIDN: {err}")
    flt.release()
    dev.release()
    return out


def dilate(img: np.ndarray, mask: np.ndarray, iterations: int = 16) -> np.ndarray:
    """Pushes covered texels outward into uncovered ones (prevents filtering bleed)."""
    from scipy import ndimage

    out = img.copy()
    covered = mask.copy()
    for _ in range(iterations):
        if covered.all():
            break
        acc = np.zeros_like(out)
        cnt = np.zeros(mask.shape, dtype=np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                sh = np.roll(np.roll(covered, dy, 0), dx, 1)
                acc += np.roll(np.roll(out, dy, 0), dx, 1) * sh[..., None]
                cnt += sh
        grow = (~covered) & (cnt > 0)
        out[grow] = acc[grow] / cnt[grow][:, None]
        covered = covered | grow
    return out


def encode_lightmap(irr: np.ndarray, path: str, *, quality: int = 92, max_value: float | None = None) -> float:
    """Writes irradiance as sRGB-encoded (value / scale), returns the scale (Babylon level).

    Ordered dithering before quantisation hides banding in slow gradients.
    """
    from PIL import Image

    scale = max_value if max_value else float(np.percentile(irr.max(axis=-1), 99.7)) * 1.05
    scale = max(scale, 1e-3)
    v = np.clip(irr / scale, 0, 1)
    enc = np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055)
    bayer = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], dtype=np.float32) / 16 - 0.5
    h, w = enc.shape[:2]
    d = np.tile(bayer, (h // 4 + 1, w // 4 + 1))[:h, :w][..., None]
    q = np.clip(np.round(enc * 255 + d), 0, 255).astype(np.uint8)
    im = Image.fromarray(q, "RGB")
    if path.endswith(".webp"):
        im.save(path, quality=quality, method=6)
    else:
        im.save(path, optimize=True)
    return scale


# ----------------------------------------------------------------------------------------------
# Rendering and export


def camera(name: str, eye: Sequence[float], target: Sequence[float], *, lens: float = 24.0) -> bpy.types.Object:
    cam = bpy.data.cameras.new(name)
    cam.lens = lens
    cam.clip_start = 0.02
    obj = bpy.data.objects.new(name, cam)
    link(obj, None)
    obj.location = G(*eye)
    d = G(*target) - G(*eye)
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = obj
    return obj


def aces(rgb: np.ndarray, exposure: float = 1.0) -> np.ndarray:
    """Babylon's ACES fitted tone map (input/output matrices + RRT/ODT fit), then sRGB."""
    a_in = np.array([[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]])
    a_out = np.array([[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]])
    c = rgb * exposure @ a_in.T
    c = (c * (c + 0.0245786) - 0.000090537) / (c * (0.983729 * c + 0.4329510) + 0.238081)
    c = np.clip(c @ a_out.T, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def render(path: str, *, width: int = 1280, height: int = 720, samples: int = 64, exposure: float = 1.0, denoise_preview: bool = True) -> None:
    """Renders linear HDR, denoises with OIDN and tone maps like the game (ACES)."""
    from PIL import Image

    scene = bpy.context.scene
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.cycles.samples = samples
    scene.view_settings.exposure = 0.0
    scene.view_settings.view_transform = "Standard"
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_depth = "32"
    exr = path.rsplit(".", 1)[0] + ".exr"
    scene.render.filepath = exr
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(exr)
    px = np.array(img.pixels[:], dtype=np.float32).reshape(height, width, 4)[::-1, :, :3].copy()
    bpy.data.images.remove(img)
    os.remove(exr)
    if denoise_preview:
        px = denoise(px, lightmap=False)
    out = aces(px, exposure)
    Image.fromarray((out * 255 + 0.5).astype(np.uint8)).save(path, quality=90)


def export_gltf(path: str, objs: Iterable[bpy.types.Object], *, image_format: str = "WEBP", quality: int = 88, separate: bool = True, texture_dir: str = "textures") -> None:
    """glTF + .bin with textures in a folder shared by every asset (deduplicated by name)."""
    ctx = bpy.context
    objs = list(objs)
    for o in ctx.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    ctx.view_layer.objects.active = objs[0] if objs else None
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLTF_SEPARATE" if separate else "GLB",
        export_texture_dir=texture_dir if separate else "",
        use_selection=True,
        export_extras=True,
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format=image_format,
        export_image_quality=quality,
        export_cameras=False,
        export_lights=False,
        export_animations=True,
    )


def render_cube(center: Sequence[float], size: int, samples: int) -> tuple[list[np.ndarray], list[Matrix]]:
    """Renders six 90-degree faces (linear HDR, denoised) and returns them with camera matrices."""
    scene = bpy.context.scene
    faces, mats = [], []
    dirs = [((1, 0, 0), (0, 1, 0)), ((-1, 0, 0), (0, 1, 0)), ((0, 1, 0), (0, 0, 1)), ((0, -1, 0), (0, 0, -1)), ((0, 0, 1), (0, 1, 0)), ((0, 0, -1), (0, 1, 0))]
    for i, (fwd, up) in enumerate(dirs):
        cam = bpy.data.cameras.new(f"probe_cam_{i}")
        cam.lens = 18.0
        cam.sensor_width = 36.0
        cam.sensor_fit = "HORIZONTAL"
        cam.clip_start = 0.02
        cam.clip_end = 200.0
        obj = bpy.data.objects.new(f"probe_cam_{i}", cam)
        link(obj, None)
        f = Vector((-fwd[0], -fwd[2], fwd[1])).normalized()
        u = Vector((-up[0], -up[2], up[1])).normalized()
        z = -f
        x = u.cross(z).normalized()
        y = z.cross(x).normalized()
        obj.matrix_world = Matrix.Translation(G(*center)) @ Matrix((x, y, z)).transposed().to_4x4()
        scene.camera = obj
        scene.render.resolution_x = size
        scene.render.resolution_y = size
        scene.render.resolution_percentage = 100
        scene.cycles.samples = samples
        scene.render.image_settings.file_format = "OPEN_EXR"
        scene.render.image_settings.color_depth = "32"
        path = os.path.join(bpy.app.tempdir or "/tmp", f"probe_face_{i}.exr")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(path)
        px = np.array(img.pixels[:], dtype=np.float32).reshape(size, size, 4)[::-1, :, :3].copy()
        bpy.data.images.remove(img)
        os.remove(path)
        faces.append(denoise(px, lightmap=False))
        mats.append(obj.matrix_world.copy())
        bpy.data.objects.remove(obj)
    return faces, mats


def cube_to_equirect(faces: list[np.ndarray], mats: list[Matrix], width: int = 1024) -> np.ndarray:
    """Equirectangular image (top row = up) in game/Babylon directions:
    u = 0.5 + atan2(z, x) / 2pi, v = acos(y) / pi."""
    h = width // 2
    v, u = np.mgrid[0:h, 0:width]
    theta = ((u + 0.5) / width - 0.5) * 2 * np.pi
    phi = (v + 0.5) / h * np.pi
    gx, gy, gz = np.cos(theta) * np.sin(phi), np.cos(phi), np.sin(theta) * np.sin(phi)
    d = np.stack([-gx, -gz, gy], -1)  # Blender directions
    out = np.zeros((h, width, 3), dtype=np.float32)
    best = np.full((h, width), -np.inf)
    size = faces[0].shape[0]
    for face, m in zip(faces, mats):
        r = np.array(m.to_3x3())  # columns: camera x, y, z in world
        c = d @ r  # camera-space components
        cz = -c[..., 2]
        valid = cz > 1e-6
        xn = np.where(valid, c[..., 0] / np.maximum(cz, 1e-6), 9)
        yn = np.where(valid, c[..., 1] / np.maximum(cz, 1e-6), 9)
        inside = valid & (np.abs(xn) <= 1.0001) & (np.abs(yn) <= 1.0001)
        score = np.where(inside, cz, -np.inf)
        take = score > best
        if not take.any():
            continue
        col = np.clip((xn + 1) / 2 * size - 0.5, 0, size - 1)
        row = np.clip((1 - (yn + 1) / 2) * size - 0.5, 0, size - 1)
        c0, r0 = np.floor(col).astype(int), np.floor(row).astype(int)
        c1, r1 = np.minimum(c0 + 1, size - 1), np.minimum(r0 + 1, size - 1)
        fc, fr = (col - c0)[..., None], (row - r0)[..., None]
        sample = (face[r0, c0] * (1 - fc) * (1 - fr) + face[r0, c1] * fc * (1 - fr) + face[r1, c0] * (1 - fc) * fr + face[r1, c1] * fc * fr)
        out[take] = sample[take]
        best = np.where(take, score, best)
    return out


def save_hdr(img: np.ndarray, path: str) -> None:
    """Writes a Radiance .hdr via Blender (RLE-compressed RGBE)."""
    h, w = img.shape[:2]
    im = bpy.data.images.new("hdr_out", w, h, float_buffer=True, alpha=True)
    rgba = np.concatenate([img[::-1], np.ones((h, w, 1), dtype=np.float32)], -1)
    im.pixels.foreach_set(rgba.astype(np.float32).ravel())
    im.filepath_raw = path
    im.file_format = "HDR"
    im.save()
    bpy.data.images.remove(im)
