"""Printed and illuminated graphics (posters, lightboxes, labels, screens) drawn with Pillow.

Fonts are vendored in ``assets/source/fonts`` (OFL / Bitstream Vera licences). Brands and text
are fictional and belong to this project.
"""

from __future__ import annotations

import math
import zlib
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .library import BUILD, FONTS

OUT = os.path.join(BUILD, "graphics")

BLACK = os.path.join(FONTS, "InterDisplay-Black.otf")
BOLD = os.path.join(FONTS, "InterDisplay-Bold.otf")
SEMI = os.path.join(FONTS, "Inter-SemiBold.otf")
SERIF = os.path.join(FONTS, "DejaVuSerif-Bold.ttf")
MONO = os.path.join(FONTS, "JetBrainsMono-Bold.ttf")


def _font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def _save(im: Image.Image, name: str) -> str:
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, f"{name}.png")
    im.save(p, optimize=True)
    return p


def _paper(w: int, h: int, color: tuple[int, int, int], seed: int, grain: float = 6.0) -> Image.Image:
    r = np.random.default_rng(seed)
    base = np.ones((h, w, 3)) * np.array(color)[None, None, :]
    n = r.normal(0, grain, (h // 4 + 1, w // 4 + 1))
    n = np.kron(n, np.ones((4, 4)))[:h, :w]
    fine = r.normal(0, grain * 0.5, (h, w))
    base = base + (n + fine)[..., None]
    # Gentle vignette / ageing toward the edges.
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.hypot((xx - w / 2) / (w / 2), (yy - h / 2) / (h / 2))
    base *= (1 - 0.08 * np.clip(d - 0.6, 0, 1))[..., None]
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))


def _center(d: ImageDraw.ImageDraw, text: str, y: int, font, fill, w: int, spacing: int = 0) -> None:
    if spacing:
        widths = [d.textlength(c, font=font) + spacing for c in text]
        x = (w - sum(widths) + spacing) / 2
        for c, cw in zip(text, widths):
            d.text((x, y), c, font=font, fill=fill)
            x += cw
        return
    tw = d.textlength(text, font=font)
    d.text(((w - tw) / 2, y), text, font=font, fill=fill)


def burger_icon(d: ImageDraw.ImageDraw, cx: int, cy: int, s: float, palette: dict[str, tuple]) -> None:
    """Flat, layered burger illustration (bun, lettuce, cheese, patty, bun)."""
    w = 300 * s
    d.chord([cx - w / 2, cy - 150 * s, cx + w / 2, cy + 40 * s], 180, 360, fill=palette["bun"])
    for i in range(14):
        a = i * 2.4
        rr = (0.15 + 0.8 * ((i * 37) % 13) / 13) * w / 2.4
        x = cx + math.cos(a) * rr
        y = cy - 70 * s + math.sin(a) * rr * 0.35 - 20 * s
        d.ellipse([x - 5 * s, y - 2.5 * s, x + 5 * s, y + 2.5 * s], fill=palette["seed"])
    # Lettuce wave.
    pts = [(cx - w / 2 - 10 * s + i * (w + 20 * s) / 20, cy - 25 * s + (8 * s if i % 2 else -6 * s)) for i in range(21)]
    d.polygon(pts + [(cx + w / 2 + 10 * s, cy - 8 * s), (cx - w / 2 - 10 * s, cy - 8 * s)], fill=palette["lettuce"])
    d.polygon([(cx - w / 2, cy - 12 * s), (cx + w / 2, cy - 12 * s), (cx + w / 2 - 20 * s, cy + 18 * s), (cx + 40 * s, cy + 4 * s), (cx - w / 2 + 30 * s, cy + 22 * s)], fill=palette["cheese"])
    d.rounded_rectangle([cx - w / 2 - 6 * s, cy, cx + w / 2 + 6 * s, cy + 46 * s], radius=int(22 * s), fill=palette["patty"])
    d.rounded_rectangle([cx - w / 2, cy + 52 * s, cx + w / 2, cy + 92 * s], radius=int(18 * s), fill=palette["bun"])


def poster_smash() -> str:
    W, H = 768, 1024
    im = _paper(W, H, (232, 222, 200), 1)
    d = ImageDraw.Draw(im)
    red, ink, mustard = (176, 38, 32), (34, 28, 26), (222, 160, 38)
    d.rectangle([28, 28, W - 28, H - 28], outline=ink, width=6)
    _center(d, "SMASHED", 70, _font(BLACK, 128), red, W)
    _center(d, "TO ORDER", 205, _font(BLACK, 92), ink, W)
    d.ellipse([W / 2 - 230, 330, W / 2 + 230, 790], fill=mustard)
    burger_icon(d, W // 2, 560, 1.15, {"bun": (196, 120, 52), "seed": (250, 240, 214), "lettuce": (92, 150, 58), "cheese": (246, 186, 40), "patty": (84, 44, 30)})
    _center(d, "GRIDDLE • CHEESE • PICKLE", 830, _font(BOLD, 40), ink, W)
    _center(d, "AFTER HOURS BURGER CO.", 900, _font(SEMI, 30), red, W, spacing=4)
    return _save(im, "poster_smash")


def poster_hours() -> str:
    W, H = 768, 1024
    im = Image.new("RGB", (W, H), (24, 52, 44))
    d = ImageDraw.Draw(im)
    cream, pink = (238, 226, 200), (240, 96, 120)
    for i in range(0, H, 18):
        d.line([(0, i), (W, i - 200)], fill=(28, 58, 49), width=6)
    _center(d, "OPEN", 90, _font(BLACK, 180), cream, W)
    _center(d, "LATE", 270, _font(BLACK, 180), pink, W)
    d.line([(120, 500), (W - 120, 500)], fill=cream, width=4)
    for i, (day, hours) in enumerate((("MON–THU", "6PM – 2AM"), ("FRI–SAT", "6PM – 4AM"), ("SUNDAY", "6PM – 1AM"))):
        y = 540 + i * 90
        d.text((130, y), day, font=_font(BOLD, 44), fill=cream)
        tw = d.textlength(hours, font=_font(BOLD, 44))
        d.text((W - 130 - tw, y), hours, font=_font(BOLD, 44), fill=pink)
    d.line([(120, 830), (W - 120, 830)], fill=cream, width=4)
    _center(d, "THE GRILL NEVER SLEEPS", 870, _font(SEMI, 36), cream, W, spacing=3)
    im = Image.blend(im, _paper(W, H, (128, 128, 128), 2, grain=10).convert("RGB"), 0.06)
    return _save(im, "poster_hours")


def poster_anatomy() -> str:
    """Decorative 'anatomy of a classic' print (a gentle nudge for players learning stacks)."""
    W, H = 768, 1024
    im = _paper(W, H, (240, 234, 220), 3)
    d = ImageDraw.Draw(im)
    ink, red = (30, 30, 34), (170, 40, 36)
    _center(d, "ANATOMY OF", 60, _font(BOLD, 56), ink, W)
    _center(d, "THE CLASSIC", 125, _font(BLACK, 92), red, W)
    layers = [
        ("TOP BUN, TOASTED", (196, 122, 54), 46),
        ("HOUSE SAUCE", (236, 140, 50), 10),
        ("LETTUCE", (96, 156, 62), 16),
        ("TOMATO", (200, 52, 40), 14),
        ("CHEDDAR", (246, 184, 40), 10),
        ("BEEF PATTY", (90, 48, 32), 36),
        ("BOTTOM BUN", (206, 134, 66), 30),
    ]
    y = 300
    for label, col, th in layers:
        d.rounded_rectangle([90, y, 380, y + th], radius=min(14, th // 2), fill=col)
        d.line([(392, y + th / 2), (428, y + th / 2)], fill=ink, width=3)
        d.text((438, y + th / 2 - 14), label, font=_font(SEMI, 25), fill=ink)
        y += th + 34
    _center(d, "BUILT BOTTOM UP. SERVED ON A TRAY.", 900, _font(SEMI, 30), ink, W)
    return _save(im, "poster_anatomy")


def fountain_panel() -> str:
    """Back-lit merchandiser for the soda fountain (fictional brands), 6 valve labels."""
    W, H = 1536, 512
    im = Image.new("RGB", (W, H), (12, 12, 14))
    d = ImageDraw.Draw(im)
    brands = [
        ("FIZZ", "COLA", (178, 24, 30), (255, 255, 255)),
        ("ZERO", "FIZZ", (24, 24, 26), (230, 50, 50)),
        ("LEMON", "LIME", (60, 160, 70), (255, 245, 140)),
        ("ROOT", "BEER", (92, 46, 26), (246, 210, 150)),
        ("ORANGE", "BURST", (236, 120, 24), (255, 255, 255)),
        ("ICED", "TEA", (190, 140, 60), (30, 24, 20)),
    ]
    cw = W / len(brands)
    for i, (a, b, bg, fg) in enumerate(brands):
        x0 = int(i * cw) + 8
        x1 = int((i + 1) * cw) - 8
        tile = Image.new("RGB", (x1 - x0, H - 40), bg)
        td = ImageDraw.Draw(tile)
        for k in range(9):
            yy = -40 + k * 56
            td.arc([-140, yy - 60, (x1 - x0) + 140, yy + 180], 200, 340, fill=tuple(min(255, c + 22) for c in bg), width=4)
        mask = Image.new("L", tile.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, tile.size[0] - 1, tile.size[1] - 1], radius=24, fill=255)
        im.paste(tile, (x0, 20), mask)
        f1 = _font(BLACK, 76 if len(a) <= 4 else 58)
        f2 = _font(BOLD, 44)
        tw = d.textlength(a, font=f1)
        d.text((x0 + (x1 - x0 - tw) / 2, 170), a, font=f1, fill=fg)
        tw = d.textlength(b, font=f2)
        d.text((x0 + (x1 - x0 - tw) / 2, 260), b, font=f2, fill=fg)
    im = im.filter(ImageFilter.GaussianBlur(0.6))
    return _save(im, "fountain_panel")


def monitor_screen() -> str:
    """Office monitor: a dim ledger spreadsheet."""
    W, H = 640, 400
    im = Image.new("RGB", (W, H), (22, 26, 34))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 30], fill=(40, 70, 120))
    d.text((12, 6), "LEDGER — NIGHT SHIFT", font=_font(SEMI, 18), fill=(230, 236, 245))
    f = _font(MONO, 15)
    rows = [("ITEM", "QTY", "COST"), ("BEEF 4OZ", "120", "$96.00"), ("BRIOCHE", "96", "$41.28"), ("CHEDDAR", "200", "$18.40"), ("LETTUCE", "4", "$9.80"), ("TOMATO", "6", "$13.50"), ("FRY OIL", "2", "$58.00"), ("CUPS 16OZ", "500", "$27.50"), ("NAPKINS", "1", "$12.10")]
    for i, (a, b, c) in enumerate(rows):
        y = 44 + i * 30
        if i % 2 == 0:
            d.rectangle([8, y - 4, W - 8, y + 22], fill=(28, 33, 43))
        col = (150, 190, 255) if i == 0 else (205, 210, 220)
        d.text((20, y), a, font=f, fill=col)
        d.text((330, y), b, font=f, fill=col)
        d.text((470, y), c, font=f, fill=col)
    d.text((20, H - 40), "TOTAL  $276.58", font=_font(MONO, 18), fill=(120, 220, 150))
    return _save(im, "monitor_screen")


def box_label(text: str, sub: str, color: tuple[int, int, int], name: str) -> str:
    """Printed corrugated-box side: ink on kraft."""
    W, H = 512, 384
    im = _paper(W, H, (176, 132, 86), zlib.crc32(name.encode()) % 1000, grain=9)  # stable seed (str hash is salted)
    d = ImageDraw.Draw(im)
    d.rectangle([24, 24, W - 24, H - 24], outline=color, width=8)
    _center(d, text, 110, _font(BLACK, 92 if len(text) < 8 else 64), color, W)
    _center(d, sub, 240, _font(BOLD, 34), (40, 30, 24), W)
    d.text((40, H - 70), "THIS SIDE UP ↑", font=_font(SEMI, 22), fill=(40, 30, 24))
    return _save(im, name)


def can_label(text: str, color: tuple[int, int, int], name: str) -> str:
    W, H = 512, 256
    im = Image.new("RGB", (W, H), color)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 30, W, H - 30], fill=(244, 238, 222))
    _center(d, text, 85, _font(BLACK, 64), color, W)
    _center(d, "FOODSERVICE  #10", 170, _font(SEMI, 22), (60, 50, 40), W)
    return _save(im, name)


def store_window(kind: str) -> str:
    """Interior glimpse for opposite storefronts: shelves/machines silhouettes with a sign."""
    W, H = 768, 512
    r = np.random.default_rng(len(kind) * 7)
    if kind == "laundry":
        im = Image.new("RGB", (W, H), (150, 170, 175))
        d = ImageDraw.Draw(im)
        d.rectangle([0, H - 140, W, H], fill=(110, 120, 120))
        for i in range(6):
            x = 30 + i * 125
            d.rectangle([x, H - 250, x + 105, H - 140], fill=(225, 228, 230))
            d.ellipse([x + 20, H - 225, x + 85, H - 160], fill=(60, 70, 80), outline=(180, 185, 190), width=6)
        d.text((40, 30), "SUDS 24H LAUNDRY", font=_font(BLACK, 64), fill=(30, 90, 160))
    else:
        im = Image.new("RGB", (W, H), (205, 200, 180))
        d = ImageDraw.Draw(im)
        for row in range(4):
            y = 150 + row * 85
            d.rectangle([0, y + 60, W, y + 70], fill=(90, 90, 95))
            x = 10
            while x < W - 20:
                w = int(r.integers(18, 40))
                c = tuple(int(v) for v in r.integers(60, 230, 3))
                d.rectangle([x, y + 60 - int(r.integers(30, 58)), x + w, y + 60], fill=c)
                x += w + 4
        d.text((40, 30), "CORNER MART", font=_font(BLACK, 72), fill=(200, 40, 40))
    return _save(im, f"store_{kind}")


def apartment_window(seed: int) -> str:
    """Warm interior behind a window: curtain, lamp glow, ceiling."""
    W, H = 256, 384
    r = np.random.default_rng(seed)
    warm = np.array([255, 196, 120]) * r.uniform(0.6, 1.0)
    yy, xx = np.mgrid[0:H, 0:W]
    lamp = np.exp(-(((xx - r.uniform(60, 200)) / 120) ** 2 + ((yy - r.uniform(100, 250)) / 150) ** 2))
    img = warm[None, None, :] * (0.25 + 0.75 * lamp[..., None])
    curtain = (xx < r.uniform(40, 90)) | (xx > W - r.uniform(40, 90))
    img[curtain] *= 0.45 * np.array([1.0, 0.85, 0.7])
    return _save(Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)), f"apt_window_{seed}")


def build_all() -> dict[str, str]:
    out = {
        "poster_smash": poster_smash(),
        "poster_hours": poster_hours(),
        "poster_anatomy": poster_anatomy(),
        "fountain_panel": fountain_panel(),
        "monitor_screen": monitor_screen(),
        "box_buns": box_label("BUNS", "BRIOCHE · 48 CT", (150, 40, 30), "box_buns"),
        "box_cups": box_label("CUPS", "16 OZ COLD · 1000", (30, 70, 140), "box_cups"),
        "box_fries": box_label("FRIES", "SHOESTRING · 6 × 5 LB", (190, 120, 20), "box_fries"),
        "box_napkins": box_label("NAPKINS", "DINNER · 3000", (40, 110, 60), "box_napkins"),
        "can_pickles": can_label("PICKLES", (60, 110, 40), "can_pickles"),
        "can_tomato": can_label("CRUSHED", (170, 30, 30), "can_tomato"),
        "can_jalapeno": can_label("JALAPEÑO", (40, 120, 60), "can_jalapeno"),
        "store_laundry": store_window("laundry"),
        "store_mart": store_window("mart"),
    }
    for i in range(6):
        out[f"apt_window_{i}"] = apartment_window(i)
    return out
