"""Builds (and caches) texgen maps, and turns them into Blender materials on demand."""

from __future__ import annotations

import hashlib
import json
import os
from concurrent.futures import ProcessPoolExecutor

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
BUILD = os.path.join(ROOT, "assets", "build")
TEX_DIR = os.path.join(BUILD, "textures")
FONTS = os.path.join(ROOT, "assets", "source", "fonts")


def _source_hash() -> str:
    with open(os.path.join(os.path.dirname(__file__), "texgen.py"), "rb") as f:
        return hashlib.sha1(f.read()).hexdigest()[:12]


def _build_one(name: str) -> tuple[str, dict]:
    from . import texgen

    m = texgen.ENVIRONMENT[name]()
    paths = m.save(TEX_DIR)
    return name, {"paths": paths, "size_m": list(m.size_m)}


def ensure(names: list[str] | None = None, workers: int = 4) -> dict[str, dict]:
    """Returns {name: {paths: {albedo, orm, normal}, size_m}} rebuilding stale entries."""
    from . import texgen

    os.makedirs(TEX_DIR, exist_ok=True)
    index_path = os.path.join(TEX_DIR, "index.json")
    index = json.load(open(index_path)) if os.path.exists(index_path) else {}
    h = _source_hash()
    names = names or list(texgen.ENVIRONMENT)
    stale = [n for n in names if index.get(n, {}).get("hash") != h or not all(os.path.exists(p) for p in index[n]["paths"].values())]
    if stale:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            for name, entry in ex.map(_build_one, stale):
                entry["hash"] = h
                index[name] = entry
                print(f"[textures] built {name}")
        json.dump(index, open(index_path, "w"), indent=1)
    return {n: index[n] for n in names}


_MATS: dict[str, object] = {}


def material(tex_name: str, mat_name: str | None = None, **kw):
    """Blender material using a texgen set (cached per name)."""
    from . import bl

    mat_name = mat_name or tex_name
    if mat_name in _MATS:
        return _MATS[mat_name]
    entry = ensure([tex_name])[tex_name]
    mat = bl.textured(mat_name, entry["paths"], **kw)
    mat["size_m"] = entry["size_m"]
    _MATS[mat_name] = mat
    return mat


def size_of(mat) -> tuple[float, float]:
    s = mat.get("size_m") if mat is not None else None
    return (float(s[0]), float(s[1])) if s else (1.0, 1.0)


def font(name: str) -> str:
    return os.path.join(FONTS, name)
