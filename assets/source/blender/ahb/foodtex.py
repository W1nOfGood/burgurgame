"""Food texture sets (numpy). Each set has the maps the client blends at runtime from the
replicated cooking state: e.g. a patty has a raw and a seared albedo plus a 'progress' mask
that makes browning spread unevenly (edges and high points first) instead of fading uniformly.

All maps are square, tileable where they cover a surface (mince, crumb, crust) and radial
where they describe a cut (tomato, onion, pickle).
"""

from __future__ import annotations

import os

import numpy as np
from PIL import Image

from .library import BUILD
from .texgen import blur, fbm, lerp, noise, rgb, sat, smooth, voronoi, per_tile

OUT = os.path.join(BUILD, "food")


def _save(arr: np.ndarray, name: str, mode: str | None = None) -> str:
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, f"{name}.png")
    a = np.round(sat(arr) * 255).astype(np.uint8)
    Image.fromarray(a, mode).save(p, optimize=True)
    return p


def _normal(height: np.ndarray, size_m: float, strength: float = 1.0) -> np.ndarray:
    h, w = height.shape
    hx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / (2 * size_m / w)
    hy = (np.roll(height, 1, 0) - np.roll(height, -1, 0)) / (2 * size_m / h)
    n = np.stack([-hx * strength, -hy * strength, np.ones_like(hx)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def _worms(n: int, count: int, seed: int, radius_px: float, length_px: tuple[float, float]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Tileable field of overlapping extruded strands: (height 0..1, strand id, cross-section 0..1)."""
    r = np.random.default_rng(seed)
    rad = int(np.ceil(radius_px))
    yy, xx = np.mgrid[-rad : rad + 1, -rad : rad + 1]
    d = np.sqrt(xx**2 + yy**2) / radius_px
    stamp = np.where(d < 1, np.sqrt(np.clip(1 - d**2, 0, 1)), -1.0)
    pad = rad + 2
    H = np.full((n + 2 * pad, n + 2 * pad), -1.0)
    ID = np.zeros_like(H, dtype=np.int32)
    PR = np.zeros_like(H)
    for k in range(count):
        x, y = r.uniform(0, n, 2)
        a = r.uniform(0, 2 * np.pi)
        L = r.uniform(*length_px)
        bend = r.normal(0, 0.06)
        z0 = r.uniform(0.0, 0.35)
        steps = max(2, int(L / (radius_px * 0.45)))
        for i in range(steps):
            a += bend + r.normal(0, 0.05)
            x += np.cos(a) * radius_px * 0.45
            y += np.sin(a) * radius_px * 0.45
            cx, cy = int(x) % n + pad, int(y) % n + pad
            sl = (slice(cy - rad, cy + rad + 1), slice(cx - rad, cx + rad + 1))
            val = stamp * 0.8 + z0
            sub = H[sl]
            take = val > sub
            sub[take] = val[take]
            ID[sl][take] = k + 1
            PR[sl][take] = np.clip(stamp, 0, 1)[take]
    # Fold the padding back so the field tiles.
    for arr, fn in ((PR, None), (ID, None), (H, np.maximum)):
        core = arr[pad : pad + n, pad : pad + n]
        for (ys, xs, yd, xd) in (
            (slice(0, pad), slice(pad, pad + n), slice(n - pad, n), slice(0, n)),
            (slice(pad + n, None), slice(pad, pad + n), slice(0, pad), slice(0, n)),
            (slice(pad, pad + n), slice(0, pad), slice(0, n), slice(n - pad, n)),
            (slice(pad, pad + n), slice(pad + n, None), slice(0, n), slice(0, pad)),
        ):
            src = arr[ys, xs]
            dst = core[yd, xd]
            if fn is not None:
                core[yd, xd] = np.maximum(dst, src)
            else:
                hv = H[ys, xs]
                hd = H[pad : pad + n, pad : pad + n][yd, xd]
                core[yd, xd] = np.where(hv > hd, src, dst)
    h = H[pad : pad + n, pad : pad + n].copy()
    ids = ID[pad : pad + n, pad : pad + n].copy()
    pr = PR[pad : pad + n, pad : pad + n].copy()
    h = np.clip(h, 0, None)
    return h / max(h.max(), 1e-6), ids, pr


def mince(n: int = 1024, seed: int = 7, veggie: bool = False) -> dict[str, str]:
    """Ground meat as a patty surface: interlocking extruded strands (~3 mm) with fat marbled
    along them. Outputs raw albedo, seared albedo, a cook map (R progress, G raw roughness,
    B seared roughness) and a normal map shared by both states.
    """
    rng = np.random.default_rng(seed)
    h, ids, pr = _worms(n, 1500, seed, radius_px=12.0, length_px=(50, 160))
    h = blur(h, 0.7)
    pr = blur(pr, 0.7)
    crevice = 1 - smooth(0.0, 0.55, pr)
    strand_tone = rng.random(ids.max() + 2)[ids]
    flecks = noise(n, seed=seed + 1, lo=60, hi=220, beta=0.2)
    fat_amt = blur(sat((flecks - 1.45) * 2.0) * (pr > 0.2), 1.2)
    fat = fat_amt > 0.35
    along = noise(n, seed=seed + 2, lo=120, hi=400, beta=0.3)
    if veggie:
        raw = lerp(rgb("#857f4a"), rgb("#6b7639"), strand_tone[..., None])
        bits = (flecks > 1.1) & (pr > 0.3)
        raw = np.where(bits[..., None], lerp(rgb("#c9a43a"), rgb("#b8452f"), strand_tone[..., None]), raw)
        raw = lerp(raw, rgb("#3f3a1e"), crevice[..., None] * 0.7)
        seared = lerp(rgb("#4a3118"), rgb("#7a5226"), pr[..., None])
    else:
        raw = lerp(rgb("#7d1622"), rgb("#d4545a"), sat(0.25 * strand_tone + 0.75 * pr ** 0.8)[..., None])
        raw = lerp(raw, rgb("#3e0910"), crevice[..., None] ** 1.5 * 0.85)
        raw = lerp(raw, lerp(rgb("#ecc9c0"), rgb("#d99a92"), strand_tone[..., None]), sat(fat_amt * 1.6)[..., None] * 0.8)
        raw = raw * (0.94 + 0.06 * along[..., None] * 0.5)
        # Smashed on a flat top, the high strands take the deepest crust; crevices stay grey-brown.
        seared = lerp(rgb("#6a4129"), rgb("#4d2915"), strand_tone[..., None] * 0.6)
        seared = lerp(seared, rgb("#24110a"), sat(h * 1.4 - 0.35)[..., None] * 0.8)
        seared = lerp(seared, rgb("#8f5b39"), crevice[..., None] ** 1.2 * 0.6)
        seared = lerp(seared, rgb("#a8743e"), sat(fat_amt * 1.6)[..., None] * 0.45)
        seared = seared * (0.85 + 0.25 * pr[..., None])
    prog = sat(0.65 * (1 - h) + 0.35 * sat(0.5 + 0.5 * fbm(n, seed=seed + 8, base=2, octaves=4)))
    rough_raw = sat(0.3 + 0.35 * crevice - 0.1 * fat)
    rough_ck = sat(0.52 - 0.2 * h - 0.2 * fat + 0.2 * crevice)
    height = 0.0008 * h + 0.0009 * pr + 0.00005 * along
    name = "veggie" if veggie else "beef"
    return {
        "raw": _save(raw, f"{name}_raw"),
        "seared": _save(seared, f"{name}_seared"),
        "cook": _save(np.stack([prog, rough_raw, rough_ck], -1), f"{name}_cook"),
        "normal": _save(_normal(height, 0.12, 1.0), f"{name}_normal"),
    }


def brioche(n: int = 1024, seed: int = 21) -> dict[str, str]:
    """Bun: glossy egg-washed crust (top) and open crumb (cut face) with a toast mask."""
    f1, f2, cid = voronoi(n, n, 2600, seed=seed, jitter=1.0)
    holes = sat(1 - (f2 - f1) * n / 2.6) * (per_tile(cid, seed + 1) > 0.35)
    pores = sat(1 - f1 * n / (2.2 + 3.0 * per_tile(cid, seed + 2)))
    crumb_h = -0.0006 * pores - 0.0003 * holes + 0.0002 * noise(n, seed=seed + 3, lo=40, hi=200, beta=0.5)
    crumb = lerp(rgb("#f3dfb0"), rgb("#e8c98c"), sat(0.5 + 0.4 * noise(n, seed=seed + 4, lo=4, hi=30, beta=1))[..., None])
    crumb = lerp(crumb, rgb("#c99e5c"), pores[..., None] * 0.55)
    toasted = lerp(rgb("#c98a3e"), rgb("#9a5a22"), sat(0.5 + 0.5 * noise(n, seed=seed + 5, lo=4, hi=40, beta=1))[..., None])
    toasted = lerp(toasted, rgb("#5e3410"), pores[..., None] * 0.45)
    toast_prog = sat(0.6 * (1 - pores) + 0.4 * sat(0.5 + 0.5 * fbm(n, seed=seed + 6, base=2, octaves=4)))
    crust = lerp(rgb("#b9661f"), rgb("#d48c3c"), sat(0.5 + 0.35 * fbm(n, seed=seed + 7, base=3, octaves=6))[..., None])
    crust = lerp(crust, rgb("#8a4513"), sat(noise(n, seed=seed + 8, lo=2, hi=10, beta=1.5) * 0.4 + 0.2)[..., None] * 0.5)
    crust_h = 0.0002 * fbm(n, seed=seed + 9, base=8, octaves=5)
    crust_rough = sat(0.28 + 0.1 * fbm(n, seed=seed + 10, base=6, octaves=4))
    return {
        "crumb": _save(crumb, "bun_crumb"),
        "toasted": _save(toasted, "bun_toasted"),
        "crumb_cook": _save(np.stack([toast_prog, sat(0.75 + 0.1 * pores), sat(0.6 - 0.1 * pores)], -1), "bun_crumb_cook"),
        "crumb_normal": _save(_normal(crumb_h, 0.1), "bun_crumb_normal"),
        "crust": _save(crust, "bun_crust"),
        "crust_normal": _save(_normal(crust_h, 0.12), "bun_crust_normal"),
        "crust_rough": _save(np.stack([crust_rough] * 3, -1), "bun_crust_rough"),
    }


def tomato(n: int = 1024, seed: int = 31) -> str:
    """Tomato slice cross-section in the unit disc: skin, pericarp, locule gel with seeds."""
    ys, xs = (np.mgrid[0:n, 0:n] + 0.5) / n * 2 - 1
    r = np.hypot(xs, ys)
    a = np.arctan2(ys, xs)
    wob = 0.02 * noise(n, seed=seed, lo=2, hi=8, beta=1.5)
    loc_n = 5
    sector = np.cos(loc_n * (a + 0.3))
    locule = (r > 0.22 + wob) & (r < 0.78 + wob) & (sector < 0.55)
    flesh = rgb("#d2321f")
    img = np.broadcast_to(flesh, (n, n, 3)).copy()
    img = lerp(img, rgb("#e5604a"), sat(0.5 + 0.4 * noise(n, seed=seed + 1, lo=6, hi=60, beta=1))[..., None] * 0.5)
    gel = lerp(rgb("#e8774e"), rgb("#f2a35a"), sat(0.5 + 0.5 * noise(n, seed=seed + 2, lo=10, hi=80, beta=1))[..., None])
    img = np.where(locule[..., None], gel, img)
    # Seeds: small ellipses along the locule walls.
    f1, f2, cid = voronoi(n, n, 900, seed=seed + 3)
    seeds = (f1 * n < 5.5) & locule & (per_tile(cid, seed + 4) > 0.45)
    img = np.where(seeds[..., None], rgb("#f3d58f"), img)
    core = r < 0.2 + wob
    img = np.where(core[..., None], lerp(rgb("#e88a6a"), rgb("#f0b08a"), sat(1 - r / 0.2)[..., None]), img)
    skin = r > 0.93 + wob * 0.5
    img = np.where(skin[..., None], rgb("#b5180e"), img)
    walls = np.abs(sector - 0.55) < 0.08
    img = lerp(img, rgb("#ec8c70"), (walls & (r > 0.2) & (r < 0.85))[..., None] * 0.5)
    return _save(img, "tomato_slice")


def onion(n: int = 512, seed: int = 41) -> str:
    """Raw onion ring cross-section: concentric layers, translucent white-violet."""
    ys, xs = (np.mgrid[0:n, 0:n] + 0.5) / n * 2 - 1
    r = np.hypot(xs, ys)
    rings = 0.5 + 0.5 * np.cos(r * 2 * np.pi * 7)
    img = lerp(rgb("#f1e8f0"), rgb("#d7c2d8"), rings[..., None] * 0.6)
    img = lerp(img, rgb("#a9709f"), smooth(0.9, 1.0, r)[..., None])
    return _save(img, "onion_slice")


def pickle(n: int = 512, seed: int = 51, jalapeno: bool = False) -> str:
    ys, xs = (np.mgrid[0:n, 0:n] + 0.5) / n * 2 - 1
    r = np.hypot(xs, ys)
    if jalapeno:
        img = np.broadcast_to(rgb("#4f8a2c"), (n, n, 3)).copy()
        inner = r < 0.72
        img = np.where(inner[..., None], rgb("#c9d89a"), img)
        a = np.arctan2(ys, xs)
        seeds = (r < 0.45) & (np.cos(a * 9) > 0.6) & (r > 0.15)
        img = np.where(seeds[..., None], rgb("#efe6c0"), img)
        img = np.where((r < 0.12)[..., None], rgb("#dfe8b0"), img)
        img = np.where((r > 0.93)[..., None], rgb("#2c5a17"), img)
        return _save(img, "jalapeno_slice")
    img = lerp(rgb("#9db04a"), rgb("#c4c771"), sat(1 - r)[..., None])
    a = np.arctan2(ys, xs)
    seeds = (np.abs(r - 0.42) < 0.08) & (np.cos(a * 7) > 0.3)
    img = np.where(seeds[..., None], rgb("#e3dca0"), img)
    img = np.where((r > 0.86)[..., None], rgb("#3e5a1c"), img)
    img = img * (0.92 + 0.08 * noise(n, seed=seed, lo=10, hi=80, beta=1)[..., None])
    return _save(img, "pickle_slice")


def lettuce(n: int = 1024, seed: int = 61) -> dict[str, str]:
    """Green-leaf lettuce: pale midrib, branching veins, ruffled darker margins."""
    ys, xs = (np.mgrid[0:n, 0:n] + 0.5) / n * 2 - 1
    mid = np.abs(xs) < 0.06 + 0.04 * (1 - (ys + 1) / 2)
    veins = np.zeros((n, n))
    for k in range(-9, 10):
        y0 = k * 0.11
        curve = ys - (y0 + np.abs(xs) * 0.55 + 0.03 * np.sin(xs * 9 + k))
        veins = np.maximum(veins, sat(1 - np.abs(curve) / 0.012) * sat(1 - np.abs(xs) * 0.9))
    blades = sat(0.5 + 0.5 * noise(n, seed=seed, lo=8, hi=60, beta=1.0))
    base = lerp(rgb("#6faa3a"), rgb("#9cc95a"), blades[..., None])
    edge = sat(np.hypot(xs * 1.0, ys * 0.9) - 0.55) * 2
    base = lerp(base, rgb("#3d7a24"), edge[..., None])
    base = lerp(base, rgb("#d9eba0"), veins[..., None] * 0.7)
    base = np.where(mid[..., None], rgb("#e3f0b8"), base)
    height = 0.0004 * veins + 0.0006 * mid + 0.0003 * noise(n, seed=seed + 1, lo=6, hi=40, beta=1.2)
    return {"albedo": _save(base, "lettuce_leaf"), "normal": _save(_normal(height, 0.14, 1.0), "lettuce_normal")}


def cheese(n: int = 512, seed: int = 71, swiss: bool = False) -> str:
    if swiss:
        img = lerp(rgb("#f4e7b8"), rgb("#efdc9c"), sat(0.5 + 0.4 * noise(n, seed=seed, lo=3, hi=30, beta=1))[..., None])
        f1, f2, cid = voronoi(n, n, 14, seed=seed + 1, jitter=0.8)
        rad = 0.03 + 0.05 * per_tile(cid, seed + 2)
        hole = f1 < rad
        alpha = np.where(hole, 0.0, 1.0)
        rim = (f1 < rad + 0.012) & ~hole
        img = lerp(img, rgb("#d9c27a"), rim[..., None] * 0.6)
        rgba = np.concatenate([img, alpha[..., None]], -1)
        return _save(rgba, "swiss_slice", "RGBA")
    img = lerp(rgb("#f2a028"), rgb("#f7b23a"), sat(0.5 + 0.4 * noise(n, seed=seed, lo=3, hi=30, beta=1))[..., None])
    img = img * (0.96 + 0.04 * noise(n, seed=seed + 3, lo=60, hi=200, beta=0.5)[..., None])
    return _save(img, "cheddar_slice")


def bacon(n: int = 1024, seed: int = 81) -> dict[str, str]:
    """Streaky bacon along U: alternating lean and fat bands with marbling; raw and crisp."""
    ys, xs = (np.mgrid[0:n, 0:n] + 0.5) / n
    warp = 0.04 * noise(n, seed=seed, lo=1, hi=6, beta=1.5)
    bands = np.sin((ys + warp) * 2 * np.pi * 3.2)
    fat = smooth(0.2, 0.55, bands)
    marb = sat(noise(n, seed=seed + 1, lo=10, hi=80, beta=0.8, aniso=(4.0, 1.0)) - 0.6)
    fat = sat(fat + marb * 0.5)
    raw = lerp(rgb("#b8343a"), rgb("#f1d8cf"), fat[..., None])
    crisp = lerp(rgb("#6e2c14"), rgb("#c98a52"), fat[..., None])
    crisp = lerp(crisp, rgb("#3a160a"), sat(noise(n, seed=seed + 2, lo=6, hi=40, beta=1) - 0.4)[..., None] * 0.6)
    height = 0.0005 * fat + 0.0003 * noise(n, seed=seed + 3, lo=10, hi=60, beta=1, aniso=(3.0, 1.0))
    prog = sat(0.5 + 0.5 * fbm(n, seed=seed + 4, base=3, octaves=4))
    return {"raw": _save(raw, "bacon_raw"), "crisp": _save(crisp, "bacon_crisp"), "cook": _save(np.stack([prog, sat(0.35 + 0.0 * fat), sat(0.45 - 0.2 * fat)], -1), "bacon_cook"), "normal": _save(_normal(height, 0.15), "bacon_normal")}


def egg_white(n: int = 512, seed: int = 91) -> dict[str, str]:
    """Fried egg white in the unit disc: translucent raw, opaque set, lacy browned rim."""
    ys, xs = (np.mgrid[0:n, 0:n] + 0.5) / n * 2 - 1
    r = np.hypot(xs, ys)
    lace = sat(noise(n, seed=seed, lo=8, hi=60, beta=0.8) * 0.5 + (r - 0.7) * 3)
    setw = lerp(rgb("#fbfaf4"), rgb("#efe9da"), sat(0.5 + 0.3 * noise(n, seed=seed + 1, lo=4, hi=30, beta=1))[..., None])
    setw = lerp(setw, rgb("#b8783c"), lace[..., None] * 0.8)
    raw = lerp(rgb("#d9dccd"), rgb("#c7cbb8"), sat(r)[..., None])
    return {"raw": _save(raw, "egg_white_raw"), "set": _save(setw, "egg_white_set")}


def mushroom(n: int = 512, seed: int = 101) -> dict[str, str]:
    ys, xs = (np.mgrid[0:n, 0:n] + 0.5) / n
    fib = noise(n, seed=seed, lo=20, hi=200, beta=0.6, aniso=(1.0, 5.0))
    raw = lerp(rgb("#e9dcc3"), rgb("#cbb79a"), sat(0.5 + 0.3 * fib)[..., None])
    gills = ys < 0.12
    raw = np.where(gills[..., None], rgb("#7a5a44"), raw)
    seared = lerp(rgb("#8a5a32"), rgb("#5d3a1d"), sat(0.5 + 0.4 * fib)[..., None])
    return {"raw": _save(raw, "mushroom_raw"), "seared": _save(seared, "mushroom_seared")}


def liner(n: int = 1024) -> str:
    """Tray paper liner: checker border and the After Hours roundel."""
    from PIL import ImageDraw, ImageFont

    from .graphics import BLACK, BOLD

    im = Image.new("RGB", (n, int(n * 0.72)), (247, 241, 226))
    d = ImageDraw.Draw(im)
    W, H = im.size
    s = 32
    for i in range(0, W, s):
        for j in (0, H - s):
            if (i // s + j // s) % 2 == 0:
                d.rectangle([i, j, i + s, j + s], fill=(176, 38, 32))
    for j in range(0, H, s):
        for i in (0, W - s):
            if (i // s + j // s) % 2 == 0:
                d.rectangle([i, j, i + s, j + s], fill=(176, 38, 32))
    cx, cy = W // 2, H // 2
    d.ellipse([cx - 210, cy - 210, cx + 210, cy + 210], outline=(176, 38, 32), width=10)
    f = ImageFont.truetype(BLACK, 92)
    tw = d.textlength("AFTER", font=f)
    d.text((cx - tw / 2, cy - 120), "AFTER", font=f, fill=(176, 38, 32))
    tw = d.textlength("HOURS", font=f)
    d.text((cx - tw / 2, cy - 20), "HOURS", font=f, fill=(34, 28, 26))
    f2 = ImageFont.truetype(BOLD, 30)
    tw = d.textlength("BURGER CO. · EST. 2026", font=f2)
    d.text((cx - tw / 2, cy + 100), "BURGER CO. · EST. 2026", font=f2, fill=(34, 28, 26))
    arr = np.asarray(im).astype(np.float64) / 255
    arr = arr * (0.96 + 0.04 * noise(arr.shape[0], arr.shape[1], seed=5, lo=20, hi=200, beta=0.5)[..., None])
    return _save(arr, "tray_liner")


def build_all() -> dict[str, object]:
    return {
        "beef": mince(),
        "veggie": mince(seed=17, veggie=True),
        "bun": brioche(),
        "tomato": tomato(),
        "onion": onion(),
        "pickle": pickle(),
        "jalapeno": pickle(jalapeno=True),
        "lettuce": lettuce(),
        "cheddar": cheese(),
        "swiss": cheese(swiss=True),
        "bacon": bacon(),
        "egg": egg_white(),
        "mushroom": mushroom(),
        "liner": liner(),
    }
