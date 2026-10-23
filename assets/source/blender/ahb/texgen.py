"""Tileable PBR texture synthesis (numpy only).

Every generator returns float arrays in [0, 1]: ``albedo`` (H, W, 3, sRGB-encoded), ``rough``
and ``metal`` (H, W) and ``height`` (H, W, used for the normal map). Spectral noise is built in
the Fourier domain, so every field is exactly periodic and the textures tile without seams.

Images are stored top row first (PIL order). In Blender/glTF tangent space +U runs along the
columns and +V runs up the rows, so normal maps here are OpenGL-style (+Y = green up).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

# ----------------------------------------------------------------------------------------------
# Fields


def _freqs(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    fy = np.fft.fftfreq(h) * h
    fx = np.fft.fftfreq(w) * w
    return np.meshgrid(fx, fy)


def noise(h: int, w: int | None = None, *, seed: int, lo: float = 1, hi: float | None = None, beta: float = 1.0, aniso: tuple[float, float] = (1.0, 1.0)) -> np.ndarray:
    """Periodic random field with a power-law spectrum between integer frequencies lo..hi.

    ``beta`` 0 = white, 1 = pink, 2 = smooth. ``aniso`` stretches frequencies (x, y): a large x
    weight suppresses variation along x, giving streaks along x (brushed metal, wood grain).
    Returns zero mean, unit standard deviation.
    """
    w = w or h
    r = np.random.default_rng(seed)
    fx, fy = _freqs(h, w)
    k = np.sqrt((fx * aniso[0]) ** 2 + (fy * aniso[1]) ** 2)
    with np.errstate(divide="ignore"):
        amp = np.where(k > 0, k ** (-beta), 0.0)
    amp[k < lo] = 0
    if hi is not None:
        amp[k > hi] = 0
    spec = amp * (r.normal(size=(h, w)) + 1j * r.normal(size=(h, w)))
    f = np.fft.ifft2(spec).real
    f -= f.mean()
    return f / (f.std() + 1e-12)


def fbm(h: int, w: int | None = None, *, seed: int, base: float = 4, octaves: int = 6, gain: float = 0.5, aniso: tuple[float, float] = (1.0, 1.0)) -> np.ndarray:
    """Band-wise fractal sum (sharper control than a single power law)."""
    w = w or h
    out = np.zeros((h, w))
    amp = 1.0
    for o in range(octaves):
        f0 = base * 2**o
        out += amp * noise(h, w, seed=seed + o * 101, lo=f0, hi=f0 * 2, beta=0, aniso=aniso)
        amp *= gain
    out -= out.mean()
    return out / (out.std() + 1e-12)


def blur(a: np.ndarray, sigma_px: float) -> np.ndarray:
    """Periodic gaussian blur via FFT (works on 2D or HxWxC)."""
    if sigma_px <= 0:
        return a
    h, w = a.shape[:2]
    fx, fy = _freqs(h, w)
    g = np.exp(-2 * (np.pi * sigma_px) ** 2 * ((fx / w) ** 2 + (fy / h) ** 2))
    if a.ndim == 2:
        return np.fft.ifft2(np.fft.fft2(a) * g).real
    return np.stack([np.fft.ifft2(np.fft.fft2(a[..., c]) * g).real for c in range(a.shape[2])], -1)


def voronoi(h: int, w: int, points: int, *, seed: int, jitter: float = 1.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Periodic Voronoi: (F1, F2, cell id) in units of the texture width."""
    r = np.random.default_rng(seed)
    g = int(np.ceil(np.sqrt(points)))
    base = (np.stack(np.meshgrid(np.arange(g), np.arange(g)), -1).reshape(-1, 2) + 0.5) / g
    pts = (base + (r.random(base.shape) - 0.5) * jitter / g) % 1.0
    tree = cKDTree(pts, boxsize=1.0)
    ys, xs = np.mgrid[0:h, 0:w]
    q = np.stack([(xs + 0.5) / w, (ys + 0.5) / h], -1).reshape(-1, 2) % 1.0
    d, i = tree.query(q, k=2)
    return d[:, 0].reshape(h, w), d[:, 1].reshape(h, w), i[:, 0].reshape(h, w)


def sat(a):
    return np.clip(a, 0.0, 1.0)


def smooth(e0, e1, x):
    t = sat((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    t = np.asarray(t)
    if np.ndim(a) and np.shape(a)[-1] == 3 and t.ndim == 2:
        t = t[..., None]
    return a + (b - a) * t


def srgb_to_lin(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(np.asarray(c, dtype=np.float64), 0, None)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def rgb(hexstr: str) -> np.ndarray:
    hexstr = hexstr.lstrip("#")
    return np.array([int(hexstr[i : i + 2], 16) / 255 for i in (0, 2, 4)])


def tint(base: np.ndarray, variation: np.ndarray, amount: float) -> np.ndarray:
    """Scale an sRGB colour by (1 + amount * variation), per pixel."""
    return sat(base[None, None, :] * (1 + amount * variation[..., None]))


# ----------------------------------------------------------------------------------------------
# Tile layouts


@dataclass
class TileField:
    tile_id: np.ndarray  # integer id per pixel
    u: np.ndarray  # 0..1 within tile
    v: np.ndarray
    edge: np.ndarray  # distance to nearest tile edge, in texture-width units
    col: np.ndarray
    row: np.ndarray


def tiles(h: int, w: int, cols: int, rows: int, *, offset: float = 0.0, grout: float = 0.0) -> TileField:
    """Running-bond tile grid. ``offset`` shifts alternate rows (0.5 = half bond).

    ``grout`` is the full joint width in texture-width units; ``edge`` is measured from the
    tile face boundary (negative inside the joint).
    """
    ys, xs = np.mgrid[0:h, 0:w]
    x = (xs + 0.5) / w * cols
    y = (ys + 0.5) / h * rows
    row = np.floor(y).astype(int)
    x = x + offset * (row % 2)
    col = np.floor(x).astype(int) % cols
    fu = x - np.floor(x)
    fv = y - row
    tw = 1.0 / cols  # tile width in texture units (x)
    th = (h / w) / rows  # tile height in texture-width units
    ex = np.minimum(fu, 1 - fu) * tw
    ey = np.minimum(fv, 1 - fv) * th
    edge = np.minimum(ex, ey) - grout / 2
    return TileField(row * cols + col, fu, fv, edge, col, row)


def per_tile(tile_id: np.ndarray, seed: int, n: int | None = None) -> np.ndarray:
    """Uniform random value per tile id."""
    r = np.random.default_rng(seed)
    table = r.random(int(tile_id.max()) + 1 if n is None else n)
    return table[tile_id]


# ----------------------------------------------------------------------------------------------
# Material container and output


@dataclass
class PBR:
    name: str
    albedo: np.ndarray
    rough: np.ndarray
    height: np.ndarray
    metal: np.ndarray | float = 0.0
    size_m: tuple[float, float] = (1.0, 1.0)  # real-world size covered by one repeat (u, v)
    normal_strength: float = 1.0  # height units -> slope scale
    meta: dict = field(default_factory=dict)

    def normal(self) -> np.ndarray:
        """OpenGL tangent-space normal from height (height in metres)."""
        h, w = self.height.shape
        hx = (np.roll(self.height, -1, 1) - np.roll(self.height, 1, 1)) / (2 * self.size_m[0] / w)
        # +V runs up the image, i.e. towards smaller row indices.
        hy = (np.roll(self.height, 1, 0) - np.roll(self.height, -1, 0)) / (2 * self.size_m[1] / h)
        n = np.stack([-hx * self.normal_strength, -hy * self.normal_strength, np.ones_like(hx)], -1)
        n /= np.linalg.norm(n, axis=-1, keepdims=True)
        return n * 0.5 + 0.5

    def save(self, out_dir: str, *, size: int | None = None) -> dict[str, str]:
        os.makedirs(out_dir, exist_ok=True)
        paths = {}

        def write(arr: np.ndarray, suffix: str) -> str:
            img = Image.fromarray(np.round(sat(arr) * 255).astype(np.uint8))
            if size and img.size[0] != size:
                img = img.resize((size, int(size * img.size[1] / img.size[0])), Image.LANCZOS)
            p = os.path.join(out_dir, f"{self.name}_{suffix}.png")
            img.save(p, optimize=True)
            return p

        paths["albedo"] = write(self.albedo, "albedo")
        metal = np.broadcast_to(np.asarray(self.metal, dtype=np.float64), self.rough.shape)
        orm = np.stack([np.ones_like(self.rough), self.rough, metal], -1)
        paths["orm"] = write(orm, "orm")
        paths["normal"] = write(self.normal(), "normal")
        return paths


# ----------------------------------------------------------------------------------------------
# Materials


def glazed_tile(name: str, *, n: int = 1024, size_m: float = 0.6, cols: int = 4, rows: int = 8, offset: float = 0.5, glaze: str = "#efece4", glaze_var: float = 0.03, grout: str = "#b9b4aa", joint_mm: float = 2.5, bevel_mm: float = 3.0, seed: int = 1, grime: float = 0.15, rough: float = 0.07) -> PBR:
    """Glazed ceramic tile (subway or stacked) with cushion edges, glaze ripple, dirty joints."""
    tf = tiles(n, n, cols, rows, offset=offset, grout=joint_mm / 1000 / size_m)
    bevel = bevel_mm / 1000 / size_m
    inside = tf.edge > 0
    cushion = smooth(0, bevel, tf.edge)  # 0 at joint -> 1 on face
    ripple = noise(n, seed=seed, lo=6, hi=40, beta=1.5)
    fine = noise(n, seed=seed + 1, lo=60, hi=300, beta=0.5)
    tile_var = per_tile(tf.tile_id, seed + 2) - 0.5
    tile_var2 = per_tile(tf.tile_id, seed + 3) - 0.5
    # Height: tile thickness 6 mm with cushion edge, slight glaze waviness; joint recessed 1.5 mm.
    height = np.where(inside, 0.0015 + 0.0006 * np.sqrt(cushion) + 0.00004 * ripple, 0.0)
    height += 0.00003 * fine * inside
    g = rgb(glaze)
    base = np.broadcast_to(g, (n, n, 3)).copy()
    base = sat(base * (1 + glaze_var * tile_var[..., None] * 2 + 0.01 * ripple[..., None]))
    # Glaze pools slightly darker/more saturated at the cushion edge.
    edge_tone = (1 - cushion) * inside
    base = sat(base * (1 - 0.08 * edge_tone[..., None]))
    gr = rgb(grout)
    dirt = sat(0.5 + 0.5 * fbm(n, seed=seed + 4, base=3, octaves=5))
    joint_col = sat(gr[None, None, :] * (1 - grime * dirt[..., None] - 0.1 * np.abs(fine[..., None]) * 0.3))
    # Soft contact shadow just inside the joint.
    ao = 0.75 + 0.25 * smooth(-joint_mm / 1000 / size_m / 2, bevel * 0.6, tf.edge)
    albedo = np.where(inside[..., None], base, joint_col) * ao[..., None]
    r = np.where(inside, rough + 0.03 * sat(fine * 0.5 + 0.5) + 0.04 * (tile_var2 + 0.5) * 0.5, 0.85)
    r = sat(r + grime * 0.25 * dirt * inside)
    return PBR(name, albedo, r, height, 0.0, (size_m, size_m), meta={"kind": "tile"})


def quarry_tile(name: str = "quarry", *, n: int = 1024, size_m: float = 0.6, seed: int = 11) -> PBR:
    """Unglazed red quarry tile, 150 mm squares, dark grout, worn grease sheen."""
    tf = tiles(n, n, 4, 4, offset=0.0, grout=6 / 1000 / size_m)
    inside = tf.edge > 0
    cushion = smooth(0, 1.5 / 1000 / size_m, tf.edge)
    mott = fbm(n, seed=seed, base=24, octaves=5, gain=0.6)
    speck = noise(n, seed=seed + 1, lo=150, hi=512, beta=0.0)
    tv = per_tile(tf.tile_id, seed + 2) - 0.5
    tv2 = per_tile(tf.tile_id, seed + 5) - 0.5
    base = lerp(rgb("#8a3b25"), rgb("#a4532f"), sat(0.5 + 0.12 * mott + tv * 0.9))
    base = sat(base * (1 - 0.06 * (speck[..., None] > 1.6)))
    base = lerp(base, rgb("#6a2c1c"), sat(tv2 * 0.6)[..., None] * 0.5)
    grease = sat(0.5 + 0.45 * fbm(n, seed=seed + 3, base=3, octaves=5))
    base = sat(base * (1 - 0.12 * grease[..., None] ** 2))
    grout = lerp(rgb("#3b3532"), rgb("#2a2421"), sat(0.5 + 0.5 * mott))
    albedo = np.where(inside[..., None], base, grout)
    albedo *= (0.8 + 0.2 * cushion)[..., None]
    height = np.where(inside, 0.002 + 0.0003 * cushion + 0.00004 * mott + 0.00002 * speck, 0.0)
    r = np.where(inside, 0.62 - 0.32 * grease ** 1.5 + 0.05 * speck * 0.2, 0.9)
    return PBR(name, albedo, sat(r), height, 0.0, (size_m, size_m))


def checker_floor(name: str = "checker", *, n: int = 1024, size_m: float = 0.6, seed: int = 21) -> PBR:
    """Polished black and white ceramic checkerboard, 300 mm tiles, scuffs and wax sheen."""
    tf = tiles(n, n, 2, 2, offset=0.0, grout=3 / 1000 / size_m)
    inside = tf.edge > 0
    black = (tf.col + tf.row) % 2 == 1
    cushion = smooth(0, 1.2 / 1000 / size_m, tf.edge)
    cloud = fbm(n, seed=seed, base=3, octaves=6)
    scuff = sat(noise(n, seed=seed + 1, lo=20, hi=200, beta=0.3, aniso=(1.0, 4.0)) - 1.6)
    white_c = lerp(rgb("#e9e5dc"), rgb("#d8d2c4"), sat(0.5 + 0.3 * cloud))
    black_c = lerp(rgb("#151515"), rgb("#242322"), sat(0.5 + 0.4 * cloud))
    base = np.where(black[..., None], black_c, white_c)
    base = lerp(base, rgb("#6b665e"), (scuff * 0.5)[..., None] * np.where(black, 0.2, 1.0)[..., None])
    grout = rgb("#8d887e") * (0.8 + 0.1 * cloud[..., None])
    albedo = np.where(inside[..., None], base, grout) * (0.85 + 0.15 * cushion)[..., None]
    wax = sat(0.5 + 0.5 * fbm(n, seed=seed + 2, base=2, octaves=4))
    r = np.where(inside, 0.12 + 0.18 * wax + 0.3 * scuff, 0.8)
    height = np.where(inside, 0.0008 + 0.0002 * cushion + 0.00001 * cloud, 0.0)
    return PBR(name, albedo, sat(r), height, 0.0, (size_m, size_m))


def brushed_steel(name: str = "steel", *, n: int = 1024, size_m: float = 0.5, seed: int = 31, smudge: float = 1.0, base_hex: str = "#c9ccd0", rough: float = 0.3) -> PBR:
    """Grade 304 stainless, #4 brushed finish along U (fine linear grain), faint wipe marks."""
    grain = noise(n, seed=seed, lo=120, hi=512, beta=0.15, aniso=(60.0, 1.0))
    grain2 = noise(n, seed=seed + 1, lo=40, hi=200, beta=0.3, aniso=(25.0, 1.0))
    wipe = fbm(n, seed=seed + 2, base=4, octaves=4, gain=0.55)
    prints = sat(noise(n, seed=seed + 3, lo=30, hi=90, beta=0.5) - 1.9) * sat(noise(n, seed=seed + 4, lo=4, hi=10, beta=1.0) + 0.2)
    smear = (0.5 + 0.5 * np.tanh(wipe * 0.8)) * 0.35 * smudge + prints * 0.4 * smudge
    base = rgb(base_hex)
    albedo = sat(base[None, None, :] * (1 + 0.025 * grain[..., None] + 0.015 * grain2[..., None] - 0.02 * smear[..., None]))
    r = sat(rough + 0.035 * grain + 0.02 * grain2 + 0.05 * smear)
    height = 0.0000025 * grain + 0.0000015 * grain2
    return PBR(name, albedo, r, height, 1.0, (size_m, size_m))


def painted_plaster(name: str, *, n: int = 1024, size_m: float = 1.0, color: str = "#e8dfcf", seed: int = 41, rough: float = 0.78, scuffs: float = 0.4) -> PBR:
    """Emulsion paint over skimmed plaster: roller stipple, faint trowel waves, scuffs."""
    stipple = noise(n, seed=seed, lo=120, hi=512, beta=0.3)
    trowel = noise(n, seed=seed + 1, lo=2, hi=12, beta=1.5)
    blotch = fbm(n, seed=seed + 2, base=3, octaves=5)
    scuff = sat(noise(n, seed=seed + 3, lo=30, hi=200, beta=0.6, aniso=(1.0, 3.0)) - 2.0) * scuffs
    c = rgb(color)
    albedo = sat(c[None, None, :] * (1 + 0.02 * blotch[..., None] + 0.015 * stipple[..., None]) - 0.12 * scuff[..., None])
    r = sat(rough + 0.04 * stipple - 0.08 * scuff)
    height = 0.00006 * stipple + 0.0004 * trowel
    return PBR(name, albedo, r, height, 0.0, (size_m, size_m))


def wood(name: str, *, n: int = 1024, size_m: float = 1.0, seed: int = 51, light: str = "#b07a45", dark: str = "#6e4223", planks: int = 4, varnish: float = 0.32, ring_freq: float = 34.0, gap_mm: float = 1.2) -> PBR:
    """Flat-sawn timber boards along U: growth rings, rays, pores; varnished."""
    ys, xs = np.mgrid[0:n, 0:n]
    v = (ys + 0.5) / n
    plank = np.floor(v * planks).astype(int)
    pv = per_tile(plank, seed)  # per-plank offsets
    warp = noise(n, seed=seed + 1, lo=1, hi=6, beta=2.0, aniso=(6.0, 1.0)) * 0.6
    warp2 = noise(n, seed=seed + 2, lo=2, hi=30, beta=1.2, aniso=(10.0, 1.0)) * 0.15
    rings = np.sin(2 * np.pi * (v * ring_freq * (0.8 + 0.4 * pv) + warp + warp2 + pv * 7))
    ring_t = sat(0.5 + 0.5 * rings) ** 3
    pores = sat(noise(n, seed=seed + 3, lo=150, hi=512, beta=0.0, aniso=(30.0, 1.0)) - 1.2) * 0.5
    figure = noise(n, seed=seed + 4, lo=2, hi=20, beta=1.0, aniso=(3.0, 1.0))
    col = lerp(rgb(light), rgb(dark), sat(ring_t * 0.75 + pores * 0.5 + 0.1 * figure))
    col = sat(col * (1 + 0.12 * (pv[..., None] - 0.5)))
    gap = gap_mm / 1000 / size_m * planks
    fv = v * planks - plank
    seam = np.minimum(fv, 1 - fv) < gap / 2
    albedo = np.where(seam[..., None], col * 0.35, col)
    height = 0.00002 * ring_t + 0.00002 * pores - 0.0005 * seam
    r = sat(np.where(seam, 0.9, varnish + 0.08 * pores + 0.04 * noise(n, seed=seed + 5, lo=4, hi=40, beta=1)))
    return PBR(name, albedo, r, height, 0.0, (size_m, size_m))


def vinyl_upholstery(name: str = "vinyl_red", *, n: int = 1024, size_m: float = 0.4, seed: int = 61, color: str = "#6e1418") -> PBR:
    """Leather-grain vinyl: pebble grain from Voronoi, wear on raised grain."""
    f1, f2, cid = voronoi(n, n, 9000, seed=seed)
    cell = sat((f2 - f1) * n / 3.0)
    grain = cell ** 0.5
    wear = sat(0.5 + 0.6 * fbm(n, seed=seed + 1, base=2, octaves=5)) ** 2
    c = rgb(color)
    albedo = sat(c[None, None, :] * (0.75 + 0.35 * grain[..., None]) + 0.06 * wear[..., None] * grain[..., None])
    r = sat(0.42 - 0.12 * grain + 0.1 * (1 - grain) - 0.12 * wear * grain)
    height = 0.00012 * grain
    return PBR(name, albedo, r, height, 0.0, (size_m, size_m))


def acoustic_ceiling(name: str = "ceiling_tile", *, n: int = 1024, size_m: float = 1.2, seed: int = 71) -> PBR:
    """2x2 ft mineral fibre lay-in tiles with fissures, in a white exposed T-bar grid."""
    tf = tiles(n, n, 2, 2, offset=0.0, grout=24 / 1000 / size_m)
    inside = tf.edge > 0
    f1, f2, _ = voronoi(n, n, 2400, seed=seed, jitter=0.9)
    fiss = sat(1 - (f2 - f1) * n / 1.6) * sat(noise(n, seed=seed + 1, lo=8, hi=60, beta=1.0) + 0.3)
    pits = sat(noise(n, seed=seed + 2, lo=200, hi=512, beta=0.0) - 2.0)
    stain = sat(fbm(n, seed=seed + 3, base=2, octaves=5) - 1.2) * 0.5
    tile_c = lerp(rgb("#eceae4"), rgb("#c9c3b4"), sat(fiss * 0.8 + pits + stain)[..., None])
    grid_c = rgb("#f2f1ec")
    edge_shadow = smooth(0, 6 / 1000 / size_m, tf.edge)
    albedo = np.where(inside[..., None], tile_c * (0.82 + 0.18 * edge_shadow)[..., None], grid_c)
    height = np.where(inside, -0.004 + 0.003 * edge_shadow - 0.0006 * fiss - 0.0004 * pits, 0.0)
    r = np.where(inside, 0.95, 0.45)
    metal = np.where(inside, 0.0, 0.0)
    return PBR(name, albedo, r, height, metal, (size_m, size_m))


def asphalt(name: str = "asphalt", *, n: int = 1024, size_m: float = 4.0, seed: int = 81) -> PBR:
    """Wet night asphalt: aggregate, tar patches, puddles with near-mirror roughness."""
    f1, f2, cid = voronoi(n, n, 60000, seed=seed, jitter=1.0)
    stone = sat((f2 - f1) * n / 2.0)
    stone_tone = per_tile(cid, seed + 1)
    agg = lerp(rgb("#2b2a29"), rgb("#55524e"), stone_tone[..., None] * stone[..., None])
    patch = fbm(n, seed=seed + 2, base=2, octaves=5)
    puddle = smooth(0.55, 0.9, sat(0.5 + 0.4 * fbm(n, seed=seed + 3, base=1, octaves=5)))
    albedo = sat(agg * (0.8 + 0.15 * patch[..., None]))
    albedo = lerp(albedo, albedo * 0.55, puddle[..., None])
    r = sat(0.75 - 0.35 * stone * 0.3 - 0.7 * puddle)
    height = 0.002 * stone * (1 - puddle) + 0.001 * patch * 0.2
    return PBR(name, albedo, r, height, 0.0, (size_m, size_m))


def concrete_paving(name: str = "sidewalk", *, n: int = 1024, size_m: float = 3.0, seed: int = 91) -> PBR:
    """Broom-finished concrete slabs (1.5 m joints), weathered, damp."""
    tf = tiles(n, n, 2, 2, offset=0.0, grout=10 / 1000 / size_m)
    inside = tf.edge > 0
    broom = noise(n, seed=seed, lo=60, hi=512, beta=0.2, aniso=(25.0, 1.0))
    mott = fbm(n, seed=seed + 1, base=3, octaves=6)
    spots = sat(noise(n, seed=seed + 2, lo=30, hi=200, beta=0.5) - 2.2)
    c = lerp(rgb("#7c7a75"), rgb("#9a978f"), sat(0.5 + 0.3 * mott)[..., None])
    c = sat(c * (1 + 0.04 * broom[..., None]) - 0.25 * spots[..., None])
    damp = sat(0.5 + 0.5 * fbm(n, seed=seed + 3, base=1, octaves=4))
    c = c * (1 - 0.3 * damp[..., None])
    albedo = np.where(inside[..., None], c, c * 0.4)
    height = np.where(inside, 0.003 + 0.0002 * broom, 0.0)
    r = sat(np.where(inside, 0.85 - 0.45 * damp, 0.9))
    return PBR(name, albedo, r, height, 0.0, (size_m, size_m))


def brick(name: str = "brick", *, n: int = 1024, size_m: float = 1.0, seed: int = 101, light: str = "#8c4a33", dark: str = "#5a2a1c", mortar: str = "#8f877a", paint: str | None = None) -> PBR:
    """Common brick in stretcher bond (215 x 65 mm + 10 mm joints)."""
    cols = round(size_m / 0.225)
    rows = round(size_m / 0.075)
    tf = tiles(n, n, cols, rows, offset=0.5, grout=10 / 1000 / size_m)
    inside = tf.edge > 0
    tv = per_tile(tf.tile_id, seed)
    mott = fbm(n, seed=seed + 1, base=6, octaves=6)
    pits = sat(noise(n, seed=seed + 2, lo=150, hi=512, beta=0.0) - 1.8)
    edge_round = smooth(0, 4 / 1000 / size_m, tf.edge + 0.0015 * noise(n, seed=seed + 3, lo=20, hi=200, beta=0.5) / size_m)
    c = lerp(rgb(light), rgb(dark), sat(tv * 0.8 + 0.2 * mott)[..., None])
    c = sat(c * (1 - 0.2 * pits[..., None]))
    m = rgb(mortar) * (0.85 + 0.1 * mott[..., None])
    albedo = np.where(inside[..., None], c * (0.8 + 0.2 * edge_round)[..., None], m)
    if paint:
        pc = rgb(paint)
        albedo = lerp(albedo, pc[None, None, :] * (0.95 + 0.05 * mott[..., None]), 0.85)
    height = np.where(inside, 0.008 * edge_round + 0.0003 * mott - 0.0008 * pits, 0.0)
    r = np.where(inside, 0.85, 0.95)
    return PBR(name, albedo, r, height, 0.0, (size_m, size_m))


def powder_coat(name: str, *, n: int = 512, size_m: float = 0.5, color: str = "#1d1e20", seed: int = 111, rough: float = 0.45, metal: float = 0.0) -> PBR:
    """Orange-peel powder coat or enamel with handling wear."""
    peel = noise(n, seed=seed, lo=30, hi=160, beta=0.8)
    wear = sat(0.5 + 0.5 * fbm(n, seed=seed + 1, base=2, octaves=5))
    c = rgb(color)
    albedo = sat(c[None, None, :] * (1 + 0.03 * peel[..., None] + 0.06 * (wear[..., None] - 0.5)))
    r = sat(rough + 0.04 * peel - 0.1 * (wear - 0.5))
    height = 0.000025 * peel
    return PBR(name, albedo, r, height, metal, (size_m, size_m))


def griddle_plate(name: str = "griddle", *, n: int = 1024, size_m: float = 0.8, seed: int = 121) -> PBR:
    """Seasoned carbon-steel flat top: even black patina, scraper lines, faint carbon spots."""
    patina = fbm(n, seed=seed, base=8, octaves=6, gain=0.55)
    scrape = noise(n, seed=seed + 1, lo=10, hi=500, beta=0.4, aniso=(30.0, 1.0))
    carbon = sat(noise(n, seed=seed + 2, lo=60, hi=300, beta=0.6) - 2.0)
    oil = sat(0.5 + 0.35 * fbm(n, seed=seed + 3, base=4, octaves=5))
    c = lerp(rgb("#1d1c1b"), rgb("#2f2c29"), sat(0.5 + 0.18 * patina + 0.12 * scrape)[..., None])
    c = lerp(c, rgb("#3a3128"), sat(patina - 1.2)[..., None] * 0.4)
    c = lerp(c, rgb("#0b0a0a"), carbon[..., None] * 0.8)
    r = sat(0.34 - 0.12 * oil + 0.12 * carbon + 0.03 * scrape)
    height = 0.00001 * scrape + 0.00003 * carbon
    metal = sat(0.6 - 0.4 * carbon - 0.1 * oil)
    return PBR(name, c, r, height, metal, (size_m, size_m))


def cardboard(name: str = "cardboard", *, n: int = 512, size_m: float = 0.5, seed: int = 131) -> PBR:
    fib = noise(n, seed=seed, lo=40, hi=256, beta=0.4, aniso=(1.0, 6.0))
    flute = np.sin(np.mgrid[0:n, 0:n][1] / n * 2 * np.pi * 80) * 0.5 + 0.5
    blot = fbm(n, seed=seed + 1, base=3, octaves=5)
    c = lerp(rgb("#a5784a"), rgb("#8a6038"), sat(0.5 + 0.3 * blot + 0.1 * fib)[..., None])
    return PBR(name, c, sat(0.85 + 0.05 * fib), 0.00008 * flute + 0.00002 * fib, 0.0, (size_m, size_m))


# Registry of the environment material set (name -> factory).
ENVIRONMENT = {
    "subway_white": lambda: glazed_tile("subway_white", seed=1),
    "tile_green": lambda: glazed_tile("tile_green", cols=6, rows=3, offset=0.0, glaze="#1f4a3c", glaze_var=0.06, grout="#c9c2b2", joint_mm=2.0, bevel_mm=4.0, seed=3, grime=0.05, rough=0.05),
    "quarry": quarry_tile,
    "checker": checker_floor,
    "steel": brushed_steel,
    "steel_worn": lambda: brushed_steel("steel_worn", seed=37, smudge=1.6, rough=0.38),
    "plaster_cream": lambda: painted_plaster("plaster_cream", color="#e3d6bf", seed=41),
    "plaster_white": lambda: painted_plaster("plaster_white", color="#ecebe6", seed=43, scuffs=0.8),
    "oak": lambda: wood("oak", seed=51),
    "walnut_slats": lambda: wood("walnut_slats", seed=55, light="#7a4a2a", dark="#3d2416", planks=10, varnish=0.4, ring_freq=50, gap_mm=6.0),
    "vinyl_red": vinyl_upholstery,
    "ceiling_tile": acoustic_ceiling,
    "asphalt": asphalt,
    "sidewalk": concrete_paving,
    "brick": brick,
    "brick_dark": lambda: brick("brick_dark", seed=105, light="#4a3a33", dark="#2c221e", mortar="#5a544c"),
    "powder_black": lambda: powder_coat("powder_black"),
    "enamel_white": lambda: powder_coat("enamel_white", color="#e7e6e1", seed=113, rough=0.28),
    "griddle": griddle_plate,
    "cardboard": cardboard,
}


def terrazzo(name: str = "terrazzo", *, n: int = 1024, size_m: float = 0.6, seed: int = 141) -> PBR:
    """Polished cementitious terrazzo: marble chips of three sizes in a warm grey matrix."""
    r = np.random.default_rng(seed)
    albedo = np.broadcast_to(rgb("#d9d3c7"), (n, n, 3)).copy()
    albedo = sat(albedo * (1 + 0.03 * fbm(n, seed=seed, base=4, octaves=5)[..., None]))
    height = np.zeros((n, n))
    palette = [rgb(h) for h in ("#f4f1ea", "#9c958a", "#3a3633", "#b9583a", "#c9b79a", "#5d6b62")]
    for k, (pts, size) in enumerate(((900, 2.2), (5000, 3.0), (30000, 4.0))):
        f1, f2, cid = voronoi(n, n, pts, seed=seed + 10 + k)
        edge = (f2 - f1) * n
        chip = edge > size * (1.4 + 0.6 * per_tile(cid, seed + 20 + k))
        choice = (per_tile(cid, seed + 30 + k) * len(palette)).astype(int) % len(palette)
        keep = per_tile(cid, seed + 40 + k) < (0.55 if k < 2 else 0.35)
        mask = chip & keep
        cols = np.stack(palette)[choice]
        cols = sat(cols * (0.9 + 0.2 * per_tile(cid, seed + 50 + k)[..., None]))
        albedo = np.where(mask[..., None], cols, albedo)
        height += mask * 0.00002
    rough = sat(0.16 + 0.05 * fbm(n, seed=seed + 5, base=3, octaves=4) * 0.5)
    return PBR(name, albedo, rough, height, 0.0, (size_m, size_m))


def hdpe_board(name: str = "hdpe", *, n: int = 1024, size_m: float = 0.6, seed: int = 151) -> PBR:
    """White polyethylene cutting board: knife scores in random directions, faint stains."""
    r = np.random.default_rng(seed)
    ys, xs = np.mgrid[0:n, 0:n] / n
    cuts = np.zeros((n, n))
    for _ in range(420):
        a = r.uniform(0, np.pi)
        cx, cy = r.random(2)
        length = r.uniform(0.02, 0.12)
        dx = (xs - cx + 0.5) % 1 - 0.5
        dy = (ys - cy + 0.5) % 1 - 0.5
        along = dx * np.cos(a) + dy * np.sin(a)
        across = -dx * np.sin(a) + dy * np.cos(a)
        cuts = np.maximum(cuts, (np.abs(across) < 0.6 / n) * (np.abs(along) < length / 2) * r.uniform(0.3, 1))
    stain = sat(fbm(n, seed=seed + 1, base=2, octaves=5) - 0.6) * 0.5
    albedo = sat(rgb("#eeece6")[None, None, :] * (1 - 0.08 * cuts[..., None]) - np.array([0.02, 0.05, 0.1]) * stain[..., None])
    rough = sat(0.55 + 0.2 * cuts + 0.05 * noise(n, seed=seed + 2, lo=50, hi=300, beta=0.5))
    return PBR(name, albedo, rough, -0.0002 * cuts, 0.0, (size_m, size_m))


def rubber_mat(name: str = "rubber_mat", *, n: int = 512, size_m: float = 0.3, seed: int = 161) -> PBR:
    """Anti-fatigue kitchen mat: grid of round drainage holes, grease-dulled rubber."""
    tf = tiles(n, n, 6, 6, offset=0.5)
    d = np.hypot(tf.u - 0.5, tf.v - 0.5)
    hole = d < 0.3
    rim = smooth(0.3, 0.42, d)
    grime = sat(0.5 + 0.5 * fbm(n, seed=seed, base=2, octaves=4))
    c = rgb("#1b1a19") * (0.9 + 0.2 * grime[..., None])
    albedo = np.where(hole[..., None], rgb("#060606"), c)
    height = np.where(hole, -0.012, 0.0 - 0.001 * (1 - rim))
    rough = np.where(hole, 1.0, 0.7 - 0.2 * grime)
    return PBR(name, albedo, sat(rough), height, 0.0, (size_m, size_m))


ENVIRONMENT.update({
    "terrazzo": terrazzo,
    "hdpe": hdpe_board,
    "rubber_mat": rubber_mat,
    "plaster_dark": lambda: painted_plaster("plaster_dark", color="#2b2e2c", seed=47, rough=0.85, scuffs=0.1),
})
