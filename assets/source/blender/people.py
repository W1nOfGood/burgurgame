"""People: the line cook (teammates) and the walk-in customers.

One parametric adult is sculpted as distance fields on a shared skeleton: skull, brow ridge,
cheekbones and jaw; eyes in sockets behind lids; nose, lips and ears; neck, torso, shoulders,
limbs and hands. Each person is then dressed: garments are shells around the body (or loose
tubes around the limbs) with folds sculpted in, polygonised on their own, and the body keeps
only the skin that shows. Textures are made in texel space (``ahb/skin.py``) and normals baked
in Cycles. Everyone has the crew rig's bones, so the client drives teammates and customers the
same way (players.ts, customers.ts).

    python assets/source/blender/people.py [--only crew,student] [--preview] [--quick]
"""

from __future__ import annotations

import argparse
import math
import os
import sys
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(__file__))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

from ahb import bl, sdf, skin  # noqa: E402
from ahb.library import ART, BUILD  # noqa: E402
from ahb.skin import smoothstep  # noqa: E402

BASE_H = 1.75  # the sculpt's height; people are scaled from it
LIP_U = (0.0, 1.5755, 0.0878)  # upper / lower lip centres (sculpt space)
LIP_L = (0.0, 1.5628, 0.0852)
LIPS = {True: (0.0074, 0.0088), False: (0.0067, 0.0079)}  # upper / lower lip half-heights by sex (female first)


def arch(P):
    """Bends space so the mouth follows the dental arch (corners sit back from the middle)."""
    A = P.copy()
    A[..., 2] = A[..., 2] + 13.0 * A[..., 0] ** 2
    return A


# ----------------------------------------------------------------------------------------------
# Who


@dataclass
class Spec:
    id: str
    sex: str  # "m" | "f"
    height: float
    skin: str  # sRGB albedo of the skin
    hair: str  # crop | ponytail | bun | bob | curly | buzz
    hair_color: str
    iris: str
    top: dict  # garment parameters (see top_field)
    bottom: dict
    shoes: dict
    build: float = 0.4  # 0 slim .. 1 heavy
    beard: str = ""  # "" | stubble | short
    hat: str = ""  # "" | cap | beanie
    extras: tuple = ()  # apron, glasses, lanyard, scarf, hood
    colors: dict = field(default_factory=dict)


PEOPLE = [
    Spec("crew", "m", 1.76, "#C99579", "crop", "#2B2019", "#5A3C24",
         top={"kind": "tee", "color": "#17171A", "ease": 0.008, "sleeve": "short", "hem": 0.9, "neck": "crew", "fabric": "knit"},
         bottom={"kind": "trousers", "color": "#1F2228", "ease": 0.016, "fabric": "canvas"},
         shoes={"kind": "work", "color": "#121212", "sole": "#1A1A1A"},
         hat="cap", extras=("apron",), colors={"cap": "#B8261E", "apron": "#2E2D2C"}),
    Spec("student", "f", 1.66, "#B88468", "ponytail", "#3A2416", "#4A2E1A",
         top={"kind": "hoodie", "color": "#C9921E", "ease": 0.022, "sleeve": "long", "hem": 0.86, "neck": "hood", "fabric": "knit"},
         bottom={"kind": "jeans", "color": "#2C3F66", "ease": 0.006, "fabric": "denim"},
         shoes={"kind": "sneaker", "color": "#ECECE8", "sole": "#F4F4F0"}),
    Spec("office", "m", 1.81, "#D9A88E", "crop", "#4A3324", "#3D5A73",
         top={"kind": "blazer", "color": "#1A2236", "ease": 0.014, "sleeve": "long", "hem": 0.8, "neck": "open_v", "fabric": "wool", "under": "#F2F2F0"},
         bottom={"kind": "trousers", "color": "#3B3C40", "ease": 0.014, "fabric": "wool"},
         shoes={"kind": "dress", "color": "#4A2A18", "sole": "#2A1A10"},
         extras=("glasses",)),
    Spec("nurse", "f", 1.68, "#6E4632", "bun", "#141010", "#2A1A10",
         top={"kind": "scrubs", "color": "#1E6E73", "ease": 0.014, "sleeve": "short", "hem": 0.84, "neck": "v", "fabric": "scrubs"},
         bottom={"kind": "scrubs", "color": "#1E6E73", "ease": 0.02, "fabric": "scrubs"},
         shoes={"kind": "sneaker", "color": "#F2F2F2", "sole": "#E8E8E8"},
         extras=("lanyard",), build=0.55),
    Spec("worker", "m", 1.78, "#8E5C3E", "buzz", "#1A1410", "#2A1A10",
         top={"kind": "hivis", "color": "#E8641A", "ease": 0.026, "sleeve": "long", "hem": 0.84, "neck": "collar", "fabric": "canvas"},
         bottom={"kind": "trousers", "color": "#2A2B2A", "ease": 0.02, "fabric": "canvas"},
         shoes={"kind": "boot", "color": "#5A3A1E", "sole": "#1A1612"},
         hat="beanie", beard="short", build=0.65, colors={"beanie": "#2E3436"}),
    Spec("coat", "f", 1.7, "#E3B49C", "bob", "#7A3A1C", "#3E6A4A",
         top={"kind": "coat", "color": "#3E4220", "ease": 0.02, "sleeve": "long", "hem": 0.52, "neck": "collar", "fabric": "wool"},
         bottom={"kind": "trousers", "color": "#111113", "ease": 0.006, "fabric": "wool"},
         shoes={"kind": "boot", "color": "#141414", "sole": "#0E0E0E"},
         extras=("scarf",), colors={"scarf": "#B8A88C"}),
    Spec("varsity", "m", 1.74, "#A8724F", "curly", "#16100C", "#2A1A10",
         top={"kind": "varsity", "color": "#7A0E14", "ease": 0.02, "sleeve": "long", "hem": 0.92, "neck": "collar", "fabric": "wool", "trim": "#EDE6D6", "sleeves": "#EDE6D6"},
         bottom={"kind": "jeans", "color": "#121316", "ease": 0.008, "fabric": "denim"},
         shoes={"kind": "sneaker", "color": "#F4F4F2", "sole": "#F8F8F6"},
         build=0.3, beard="stubble"),
]


# ----------------------------------------------------------------------------------------------
# Skeleton (sculpt space: a 1.75 m adult, origin between the feet, facing +Z)


def joints(sp: Spec) -> dict[str, np.ndarray]:
    f = sp.sex == "f"
    sw = 0.88 if f else 1.0
    hw = 1.07 if f else 1.0
    J = {
        "hips": (0.0, 0.96, -0.005), "spine": (0.0, 1.1, -0.01), "chest": (0.0, 1.3, -0.012),
        "neck": (0.0, 1.462, -0.024), "head": (0.0, 1.57, -0.012), "crown": (0.0, 1.755, -0.01),
    }
    for s, t in ((1, "r"), (-1, "l")):
        J[f"shoulder_{t}"] = (0.182 * sw * s, 1.432, -0.03)
        J[f"elbow_{t}"] = (0.214 * sw * s, 1.115, -0.05)
        J[f"wrist_{t}"] = (0.232 * sw * s, 0.862, -0.02)
        J[f"fingers_{t}"] = (0.236 * sw * s, 0.775, -0.005)
        J[f"hip_{t}"] = (0.088 * hw * s, 0.925, -0.005)
        J[f"knee_{t}"] = (0.093 * s, 0.505, 0.005)
        J[f"ankle_{t}"] = (0.097 * s, 0.085, -0.035)
        J[f"toe_{t}"] = (0.104 * s, 0.022, 0.115)
    return {n: np.asarray(v, dtype=np.float64) for n, v in J.items()}


def bones(J) -> dict[str, tuple]:
    b = {"hips": (J["hips"], J["spine"]), "spine": (J["spine"], J["chest"]), "chest": (J["chest"], J["neck"]), "neck": (J["neck"], J["head"]), "head": (J["head"], J["crown"])}
    for t in ("r", "l"):
        b[f"upperarm_{t}"] = (J[f"shoulder_{t}"], J[f"elbow_{t}"])
        b[f"forearm_{t}"] = (J[f"elbow_{t}"], J[f"wrist_{t}"])
        b[f"hand_{t}"] = (J[f"wrist_{t}"], J[f"fingers_{t}"])
        b[f"thigh_{t}"] = (J[f"hip_{t}"], J[f"knee_{t}"])
        b[f"shin_{t}"] = (J[f"knee_{t}"], J[f"ankle_{t}"])
        b[f"foot_{t}"] = (J[f"ankle_{t}"], J[f"toe_{t}"])
    return b


PARENTS = {"hips": None, "spine": "hips", "chest": "spine", "neck": "chest", "head": "neck"}
for _t in ("r", "l"):
    PARENTS.update({f"upperarm_{_t}": "chest", f"forearm_{_t}": f"upperarm_{_t}", f"hand_{_t}": f"forearm_{_t}", f"thigh_{_t}": "hips", f"shin_{_t}": f"thigh_{_t}", f"foot_{_t}": f"shin_{_t}"})


def _local(P, c, ex, ey, ez):
    """Coordinates of P in an orthonormal frame at c."""
    Q = P - c
    return np.stack([Q @ ex, Q @ ey, Q @ ez], -1)


def _unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


# ----------------------------------------------------------------------------------------------
# Anatomy


class Body:
    """Named distance fields of one person's body in sculpt space."""

    def __init__(self, sp: Spec):
        self.sp = sp
        self.J = joints(sp)
        self.f = sp.sex == "f"
        self.b = sp.build

    # -- torso ---------------------------------------------------------------------------------
    def torso(self, P):
        f, b = self.f, self.b
        chest = sdf.ellipsoid(P, (0.0, 1.31, -0.014), ((0.142 if f else 0.158) + 0.01 * b, 0.15, 0.098 + 0.01 * b))
        ribs = sdf.ellipsoid(P, (0.0, 1.2, -0.01), ((0.126 if f else 0.142) + 0.016 * b, 0.13, 0.093 + 0.014 * b))
        waist = sdf.ellipsoid(P, (0.0, 1.075, -0.002), ((0.112 if f else 0.128) + 0.03 * b, 0.1, 0.086 + 0.03 * b))
        pelvis = sdf.ellipsoid(P, (0.0, 0.955, -0.012), ((0.166 if f else 0.15) + 0.01 * b, 0.1, 0.1 + 0.012 * b))
        d = sdf.smin(chest, ribs, 0.06)
        d = sdf.smin(d, waist, 0.07)
        d = sdf.smin(d, pelvis, 0.05)
        if b > 0.3:
            d = sdf.smin(d, sdf.ellipsoid(P, (0.0, 1.06, 0.045), (0.105, 0.085, 0.06 * b)), 0.04)
        for s in (1, -1):
            d = sdf.smin(d, sdf.ellipsoid(P, (0.062 * s, 0.9, -0.058), (0.072, 0.085, 0.064 + (0.012 if f else 0.0))), 0.03)
            if f:
                d = sdf.smin(d, sdf.sphere(P, (0.07 * s, 1.282, 0.058), 0.054), 0.03)
            else:
                d = sdf.smin(d, sdf.ellipsoid(P, (0.066 * s, 1.33, 0.056), (0.07, 0.05, 0.034)), 0.03)
            # Shoulder girdle: trapezius slope and deltoid caps.
            # The slope falls from the neck to the acromion (~0.82 of height), and the deltoid
            # hangs below it: a cap on top of the joint reads as shoulder pads.
            sh = self.J["shoulder_r" if s > 0 else "shoulder_l"]
            d = sdf.smin(d, sdf.capsule(P, (0.03 * s, 1.452, -0.035), (sh[0] * 0.8, 1.414, -0.032), 0.034), 0.03)
            d = sdf.smin(d, sdf.ellipsoid(P, tuple(sh + np.array([0.012 * s, -0.048, 0.002])), (0.043 + 0.004 * self.b, 0.062, 0.05)), 0.026)
        return d

    # -- limbs ---------------------------------------------------------------------------------
    def upper_arm(self, P, t, ease=0.0):
        J = self.J
        sh, el = J[f"shoulder_{t}"], J[f"elbow_{t}"]
        # The humeral head sits under the acromion: start the limb below the pivot so its round
        # top tucks under the shoulder slope instead of standing above it.
        top = sh + (el - sh) * 0.07 + np.array([0.0, -0.012, 0.0])
        up = sdf.round_cone(P, top, el, 0.041 + 0.008 * self.b + ease, 0.035 + ease)
        bic = sdf.ellipsoid(P, tuple(sh + (el - sh) * 0.5 + np.array([0.0, 0.0, 0.01])), (0.034 + ease, 0.075, 0.033 + ease))
        return sdf.smin(up, bic, 0.02)

    def forearm(self, P, t, ease=0.0):
        J = self.J
        el, wr = J[f"elbow_{t}"], J[f"wrist_{t}"]
        fo = sdf.round_cone(P, el, wr, 0.036 + ease, 0.0235 + ease)
        mus = sdf.ellipsoid(P, tuple(el + (wr - el) * 0.25), (0.035 + ease, 0.07, 0.032 + ease))
        return sdf.smin(fo, mus, 0.02)

    def hand(self, P, t):
        J = self.J
        s = 1.0 if t == "r" else -1.0
        k = 0.92 if self.f else 1.0
        wr, fi = J[f"wrist_{t}"], J[f"fingers_{t}"]
        ey = _unit(fi - wr)  # along the hand (down)
        ez = _unit(np.array([0.0, 0.0, 1.0]) - ey[2] * ey)  # thumb side (forward)
        ex = np.cross(ey, ez)  # palm normal axis
        if (ex[0] > 0) != (s > 0):
            ex = -ex
        # ex points away from the body; the palm faces -ex (toward the thigh).
        q = _local(P, wr + ey * 0.048 * k, ex, ey, ez)
        palm = sdf.ellipsoid(q, (0.0, 0.0, 0.0), (0.0135 * k, 0.05 * k, 0.04 * k))
        d = palm
        for i, w in enumerate((0.026, 0.009, -0.008, -0.024)):
            length = (0.07, 0.078, 0.074, 0.06)[i] * k
            a = np.array([0.002, 0.045 * k, w * k])
            m = a + np.array([-0.012, length * 0.55, 0.0])
            e = a + np.array([-0.03, length * 0.9, -0.002 * np.sign(w)])
            r = (0.0085 if i < 3 else 0.0075) * k
            fing = sdf.smin(sdf.round_cone(q, a, m, r, r * 0.92), sdf.round_cone(q, m, e, r * 0.92, r * 0.78), 0.004)
            d = sdf.smin(d, fing, 0.006) if i in (0, 3) else np.minimum(d, fing)
        thumb = sdf.smin(
            sdf.round_cone(q, (-0.008, 0.0, 0.03 * k), (-0.02, 0.035 * k, 0.045 * k), 0.012 * k, 0.0095 * k),
            sdf.round_cone(q, (-0.02, 0.035 * k, 0.045 * k), (-0.026, 0.062 * k, 0.042 * k), 0.0095 * k, 0.0078 * k),
            0.004,
        )
        d = sdf.smin(d, thumb, 0.01)
        return d

    def arm(self, P, t):
        a = sdf.smin(self.upper_arm(P, t), self.forearm(P, t), 0.018)
        return sdf.smin(a, self.hand(P, t), 0.012)

    def thigh(self, P, t, ease=0.0):
        J = self.J
        hp, kn = J[f"hip_{t}"], J[f"knee_{t}"]
        th = sdf.round_cone(P, hp + np.array([0.0, 0.025, 0.0]), kn, 0.088 + 0.016 * self.b + (0.006 if self.f else 0.0) + ease, 0.05 + ease)
        quad = sdf.ellipsoid(P, tuple(hp + (kn - hp) * 0.45 + np.array([0.0, 0.0, 0.018])), (0.058 + ease, 0.16, 0.058 + ease))
        return sdf.smin(th, quad, 0.03)

    def shin(self, P, t, ease=0.0):
        J = self.J
        kn, an = J[f"knee_{t}"], J[f"ankle_{t}"]
        sh = sdf.round_cone(P, kn, an + np.array([0.0, 0.02, 0.0]), 0.049 + ease, 0.03 + ease)
        calf = sdf.ellipsoid(P, tuple(kn + (an - kn) * 0.3 + np.array([0.0, 0.0, -0.02])), (0.047 + ease, 0.11, 0.05 + ease))
        cap = sdf.sphere(P, tuple(kn + np.array([0.0, 0.0, 0.034])), 0.029 + ease)
        return sdf.smin(sdf.smin(sh, calf, 0.03), cap, 0.02)

    def foot(self, P, t):
        J = self.J
        an, toe = J[f"ankle_{t}"], J[f"toe_{t}"]
        return sdf.round_cone(P, an, toe + np.array([0.0, 0.0, -0.02]), 0.032, 0.026)

    def leg(self, P, t):
        return sdf.smin(sdf.smin(self.thigh(P, t), self.shin(P, t), 0.02), self.foot(P, t), 0.02)

    def field(self, P):
        """The whole body (no head; arms and legs blend into the torso, not into each other)."""
        tor = self.torso(P)
        d = None
        for t in ("r", "l"):
            part = np.minimum(sdf.smin(tor, self.arm(P, t), 0.014), sdf.smin(tor, self.leg(P, t), 0.04))
            d = part if d is None else np.minimum(d, part)
        return d

    # -- head ------------------------------------------------------------------------------------
    def eye_centres(self):
        return [np.array([0.032 * s, 1.646, 0.066]) for s in (1, -1)]

    EYE_R = 0.0122

    def skull(self, P):
        """Cranium and face mass only (no ears, nose or brows): what a hat is fitted to."""
        cran = sdf.ellipsoid(P, (0.0, 1.666, -0.014), (0.074 if self.f else 0.076, 0.092, 0.096))
        face = sdf.ellipsoid(P, (0.0, 1.61, 0.022), (0.066, 0.076, 0.07))
        return sdf.smin(cran, face, 0.035)

    def head(self, P):
        f = self.f
        d = self.skull(P)
        jw = 0.041 if f else 0.045
        for s in (1, -1):
            gon = np.array([jw * s, 1.576, -0.012])
            chin = np.array([0.011 * s, 1.541, 0.066])
            d = sdf.smin(d, sdf.round_cone(P, gon, chin, 0.016 if f else 0.019, 0.017 if f else 0.02), 0.022)
            d = sdf.smin(d, sdf.ellipsoid(P, (0.047 * s, 1.634, 0.046), (0.022, 0.013, 0.024)), 0.016)
            d = sdf.smin(d, sdf.ellipsoid(P, (0.039 * s, 1.598, 0.058), (0.026, 0.028, 0.022) if f else (0.023, 0.025, 0.019)), 0.02)
            # Brow: a soft swell over each eye, not a shelf.
            d = sdf.smin(d, sdf.ellipsoid(P, (0.03 * s, 1.668, 0.063), (0.028, 0.012 if f else 0.014, 0.016 if f else 0.018)), 0.016)
            # Temples sit in a little.
            d = sdf.smax(d, -sdf.sphere(P, (0.083 * s, 1.672, 0.03), 0.014), 0.012)
        d = sdf.smin(d, sdf.ellipsoid(P, (0.0, 1.542 if f else 1.54, 0.067), (0.018 if f else 0.023, 0.017 if f else 0.019, 0.017)), 0.016)
        # Eye sockets, then lids wrapped round the eyeballs with an almond opening.
        for c in self.eye_centres():
            d = sdf.smax(d, -sdf.ellipsoid(P, tuple(c + np.array([0.0, 0.002, 0.013])), (0.019, 0.013, 0.012)), 0.01)
        lids = None
        for c in self.eye_centres():
            lid = sdf.sphere(P, c, self.EYE_R + 0.0013)
            u = (P[..., 0] - c[0]) / 0.0128
            v = P[..., 1] - c[1] + 0.0004
            half = (0.0049 if f else 0.0045) * np.clip(1 - u * u, 0.0, 1.0) ** 0.7 + 0.0002
            slit = np.maximum(np.abs(v) - half, c[2] + 0.004 - P[..., 2])
            lid = sdf.smax(lid, -slit, 0.0012)
            lids = lid if lids is None else np.minimum(lids, lid)
        d = sdf.smin(d, lids, 0.0035)
        # Nose.
        nk = 0.86 if f else 1.0
        tipz = 0.103 if f else 0.106
        nose = sdf.round_cone(P, (0.0, 1.66, 0.08), (0.0, 1.613, tipz - 0.004), 0.0078 * nk, 0.0088 * nk)
        nose = sdf.smin(nose, sdf.sphere(P, (0.0, 1.606, tipz - 0.006), 0.0094 * nk), 0.006)
        for s in (1, -1):
            nose = sdf.smin(nose, sdf.sphere(P, (0.012 * s * nk, 1.6, tipz - 0.0155), 0.0074 * nk), 0.006)
        d = sdf.smin(d, nose, 0.009)
        # Glabella: fills the pit between the brows above the bridge.
        d = sdf.smin(d, sdf.ellipsoid(P, (0.0, 1.671, 0.074), (0.013, 0.011, 0.009)), 0.01)
        for s in (1, -1):
            d = sdf.smax(d, -sdf.ellipsoid(P, (0.0072 * s, 1.5948, tipz - 0.008), (0.0042, 0.0024, 0.0052)), 0.002)
        # Mouth: muzzle, lips on the dental arch, the line between the lips.
        d = sdf.smin(d, sdf.ellipsoid(P, (0.0, 1.574, 0.068), (0.034, 0.028, 0.024)), 0.016)
        A = arch(P)
        lu, ll = LIPS[f]
        d = sdf.smin(d, sdf.ellipsoid(A, LIP_U, (0.025, lu, 0.009)), 0.0035)
        d = sdf.smin(d, sdf.ellipsoid(A, LIP_L, (0.0215, ll, 0.009)), 0.0035)
        d = sdf.smax(d, -sdf.ellipsoid(A, (0.0, 1.5695, 0.091), (0.024, 0.001, 0.011)), 0.0012)
        # Ears.
        for s in (1, -1):
            ear = sdf.ellipsoid(P, (0.075 * s, 1.637, -0.009), (0.0095, 0.029, 0.018))
            d = sdf.smin(d, ear, 0.006)
            d = sdf.smax(d, -sdf.ellipsoid(P, (0.0815 * s, 1.632, -0.004), (0.0058, 0.0125, 0.0088)), 0.003)
        # Neck: column, sternocleidomastoids, Adam's apple.
        neck = sdf.round_cone(P, (0.0, 1.4, -0.02), (0.0, 1.585, -0.004), 0.058 if not f else 0.052, 0.05 if not f else 0.046)
        for s in (1, -1):
            neck = sdf.smin(neck, sdf.capsule(P, (0.056 * s, 1.612, -0.022), (0.013 * s, 1.448, 0.042), 0.011), 0.018)
        if not f:
            neck = sdf.smin(neck, sdf.sphere(P, (0.0, 1.508, 0.05), 0.0085), 0.008)
        return sdf.smin(d, neck, 0.025)


# ----------------------------------------------------------------------------------------------
# Clothing (each returns a distance field; shells sit outside the body and end in open hems)


def _cut(d, P, point, normal, k=0.002):
    """Keeps the side of the plane the normal points away from (cuts a hem)."""
    return sdf.smax(d, (P - np.asarray(point)) @ np.asarray(normal), k)


def _folds(P, amp, freq, seed):
    return amp * skin.fbm3(P, freq, 3, seed=seed)


class Wardrobe:
    def __init__(self, body: Body):
        self.B = body
        self.J = body.J
        self.sp = body.sp

    # -- tops --------------------------------------------------------------------------------
    def sleeve(self, P, t, ease, kind):
        J = self.J
        sh, el, wr = J[f"shoulder_{t}"], J[f"elbow_{t}"], J[f"wrist_{t}"]
        if kind == "short":
            end = sh + (el - sh) * 0.48
            d = self.B.upper_arm(P, t, ease + 0.006)
            return _cut(d, P, end, _unit(el - sh))
        d = sdf.smin(self.B.upper_arm(P, t, ease + 0.003), self.B.forearm(P, t, ease + 0.003), 0.02)
        end = wr - _unit(wr - el) * 0.018
        return _cut(d, P, end, _unit(wr - el))

    def top(self, P):
        g = self.sp.top
        ease = g["ease"]
        # Cloth hangs from the shoulders (little ease there) and covers the trousers' hips.
        tor = self.B.torso(P) - ease * (1 - 0.65 * smoothstep(1.32, 1.43, P[..., 1]))
        tor = sdf.smin(tor, self.hips(P) - 0.008, 0.03)
        hem = g["hem"]
        Q = P.copy()
        if g["kind"] == "coat":
            # A long coat: below the waist it hangs as a flared skirt round the legs.
            Q[..., 2] = (Q[..., 2] + 0.01) / 0.78
            skirt = sdf.round_cone(Q, (0.0, 1.0, 0.0), (0.0, hem + 0.02, 0.0), 0.165, 0.215)
            tor = sdf.smin(tor, skirt, 0.05)
        else:
            # Below the waist the cloth falls straight past the hips to the hem: following the
            # pelvis down would wrap it between the legs like a leotard.
            B = self.B
            Q[..., 2] = (Q[..., 2] + 0.012) / 0.7
            r = (0.17 if B.f else 0.156) + 0.014 * B.b + ease
            skirt = sdf.round_cone(Q, (0.0, 1.03, 0.0), (0.0, hem + 0.01, 0.0), r, r + 0.006)
            # Loose trousers are wider at the top of the thigh: the top drapes over them.
            over = np.maximum(self.bottom(P) - 0.007, P[..., 1] - 1.0)
            tor = sdf.smin(sdf.smin(tor, skirt, 0.04), over, 0.02)
        tor = _cut(tor, P, (0.0, hem, 0.0), (0.0, -1.0, 0.0), 0.006)
        d = tor
        for t in ("r", "l"):
            d = sdf.smin(d, self.sleeve(P, t, ease * 0.4, g["sleeve"]), 0.02)
        # Neckline.
        neck_hole = sdf.capsule(P, (0.0, 1.43, -0.026), (0.0, 1.62, -0.012), 0.066 if g["neck"] != "collar" else 0.061)
        d = sdf.smax(d, -neck_hole, 0.006)
        if g["neck"] in ("v", "open_v"):
            depth = 1.33 if g["neck"] == "v" else 1.16
            slope = 0.07 / (1.45 - depth)  # half-width 7 cm at the collarbones, 0 at the point
            wedge = np.maximum.reduce([np.abs(P[..., 0]) - (P[..., 1] - depth) * slope, depth - P[..., 1], -P[..., 2] - 0.01])
            d = sdf.smax(d, -wedge, 0.004)
        if g["neck"] == "collar":
            ring = np.abs(sdf.capsule(P, (0.0, 1.43, -0.026), (0.0, 1.53, -0.016), 0.071)) - 0.009
            ring = np.maximum(ring, np.maximum(P[..., 1] - 1.52, 1.42 - P[..., 1]))
            d = sdf.smin(d, ring, 0.006)
        if g["neck"] == "hood":
            hood = sdf.ellipsoid(P, (0.0, 1.47, -0.075), (0.11, 0.05, 0.06))
            hood = sdf.smax(hood, -sdf.capsule(P, (0.0, 1.43, -0.026), (0.0, 1.62, -0.012), 0.07), 0.01)
            d = sdf.smin(d, hood, 0.02)
        if g["neck"] == "open_v":
            # Lapels: soft rolls along the V edges.
            for s in (1, -1):
                lap = sdf.capsule(P, (0.065 * s, 1.43, 0.06), (0.012 * s, 1.17, 0.105), 0.008)
                d = sdf.smin(d, lap, 0.008)
        # Cloth: a broad drape, finer rumples, and bunching just above the hem.
        d = d - _folds(P, 0.0035, 7.0, 11) - _folds(P, 0.0012, 22.0, 12)
        bunch = np.sin(2 * np.pi * (P[..., 1] - hem) / 0.024 + 3.0 * skin.fbm3(P, 9.0, 2, seed=13)) * smoothstep(0.07, 0.0, P[..., 1] - hem)
        d = d - 0.0016 * bunch
        return d

    def under(self, P):
        """Shirt showing inside an open neckline."""
        d = self.B.torso(P) - 0.006
        d = _cut(d, P, (0.0, 1.0, 0.0), (0.0, -1.0, 0.0))
        neck = sdf.capsule(P, (0.0, 1.43, -0.026), (0.0, 1.62, -0.012), 0.06)
        d = sdf.smax(d, -neck, 0.004)
        collar = np.abs(sdf.capsule(P, (0.0, 1.43, -0.026), (0.0, 1.52, -0.018), 0.064)) - 0.004
        collar = np.maximum(collar, np.maximum(P[..., 1] - 1.505, 1.44 - P[..., 1]))
        return sdf.smin(d, collar, 0.004)

    # -- bottoms -----------------------------------------------------------------------------
    def hips(self, P):
        """The trousers' seat and waist (no legs)."""
        ease = self.sp.bottom["ease"]
        B = self.B
        pel = sdf.ellipsoid(P, (0.0, 0.955, -0.012), ((0.166 if B.f else 0.15) + 0.01 * B.b + ease, 0.105, 0.102 + 0.012 * B.b + ease))
        for s in (1, -1):
            pel = sdf.smin(pel, sdf.ellipsoid(P, (0.062 * s, 0.9, -0.058), (0.074 + ease, 0.087, 0.066 + (0.012 if B.f else 0.0) + ease)), 0.03)
        return sdf.smin(pel, sdf.ellipsoid(P, (0.0, 1.0, 0.0), ((0.118 if B.f else 0.132) + 0.03 * B.b + ease, 0.05, 0.09 + 0.03 * B.b + ease)), 0.04)

    def bottom(self, P):
        g = self.sp.bottom
        ease = g["ease"]
        B, J = self.B, self.J
        waist_y = 1.02
        pel = self.hips(P)
        d = None
        loose = g["kind"] in ("scrubs", "trousers")
        for t in ("r", "l"):
            hp, kn, an = J[f"hip_{t}"], J[f"knee_{t}"], J[f"ankle_{t}"]
            th = B.thigh(P, t, ease)
            if loose:
                # Straight legs: the cloth falls from the thigh, not following the calf.
                fall = sdf.round_cone(P, kn + np.array([0.0, 0.04, 0.0]), an + np.array([0.0, 0.05, 0.008]), 0.058 + ease, 0.054 + ease)
            else:
                fall = B.shin(P, t, ease + 0.004)
            leg = sdf.smin(th, fall, 0.04)
            leg = _cut(leg, P, an + np.array([0.0, 0.035 if g["kind"] != "jeans" else 0.03, 0.0]), (0.0, -1.0, 0.0))
            part = sdf.smin(pel, leg, 0.035)
            d = part if d is None else np.minimum(d, part)
        d = _cut(d, P, (0.0, waist_y, 0.0), (0.0, 1.0, 0.0), 0.004)
        d = d - _folds(P, 0.003, 8.0, 21) - _folds(P, 0.001, 24.0, 22)
        # Stacking above the shoe and creases behind the knee.
        for t in ("r", "l"):
            an, kn = J[f"ankle_{t}"], J[f"knee_{t}"]
            near_ankle = smoothstep(0.12, 0.05, P[..., 1] - an[1])
            d = d - 0.0022 * near_ankle * np.sin(2 * np.pi * P[..., 1] / 0.03 + 4 * skin.fbm3(P, 12.0, 2, seed=23))
        return d

    def belt(self, P):
        return np.maximum(np.abs(self.bottom_waist(P)) - 0.0035, np.abs(P[..., 1] - 1.005) - 0.016)

    def bottom_waist(self, P):
        B = self.B
        e = self.sp.bottom["ease"] + 0.004
        return sdf.ellipsoid(P, (0.0, 1.0, 0.0), ((0.118 if B.f else 0.132) + 0.03 * B.b + e, 0.06, 0.09 + 0.03 * B.b + e))

    # -- shoes -------------------------------------------------------------------------------
    def shoe(self, P, sole=False):
        g = self.sp.shoes
        J = self.J
        d = None
        for t in ("r", "l"):
            an, toe = J[f"ankle_{t}"], J[f"toe_{t}"]
            heel = np.array([an[0], 0.045, an[2] - 0.035])
            tip = np.array([toe[0] + (0.004 if t == "r" else -0.004), 0.035, toe[2] + 0.035])
            width = 0.047 if g["kind"] != "dress" else 0.043
            upper = sdf.round_cone(P, heel, tip, 0.044, 0.03)
            Q = P.copy()
            Q[..., 0] = an[0] + (Q[..., 0] - an[0]) * (0.046 / width)
            upper = sdf.smin(upper, sdf.round_cone(Q, heel + np.array([0.0, 0.0, 0.03]), tip - np.array([0.0, 0.0, 0.02]), 0.045, 0.034), 0.02)
            top_y = {"boot": 0.17, "work": 0.12, "sneaker": 0.1, "dress": 0.085}[g["kind"]]
            shaft = sdf.round_cone(P, an + np.array([0.0, -0.02, -0.004]), an + np.array([0.0, top_y - an[1], -0.006]), 0.042, 0.04)
            upper = sdf.smin(upper, shaft, 0.025)
            upper = _cut(upper, P, (0.0, top_y, 0.0), (0.0, 1.0, 0.0), 0.004)
            upper = np.maximum(upper, -P[..., 1])
            if sole:
                th = {"boot": 0.026, "work": 0.024, "sneaker": 0.028, "dress": 0.014}[g["kind"]]
                s = np.maximum(upper - 0.004, P[..., 1] - th)
                s = np.maximum(s, -P[..., 1])
                part = s
            else:
                part = np.maximum(upper, -(P[..., 1] - 0.012))
            d = part if d is None else np.minimum(d, part)
        return d

    # -- extras ------------------------------------------------------------------------------
    def apron(self, P):
        tor = self.B.torso(P)
        bib = np.maximum(tor - 0.016, -(tor - 0.006))
        bib = np.maximum.reduce([bib, np.abs(P[..., 0]) - 0.118, P[..., 1] - 1.37, 0.98 - P[..., 1], -P[..., 2] + 0.02])
        # The skirt hangs from the waist round the front of the thighs.
        R = 0.118
        r = np.hypot(P[..., 0] / 1.7, P[..., 2] + 0.012)
        skirt = np.abs(r - R - 0.01 * smoothstep(1.0, 0.55, P[..., 1])) - 0.0042
        skirt = np.maximum.reduce([skirt, -P[..., 2] - 0.0, P[..., 1] - 1.03, 0.54 - P[..., 1], np.abs(P[..., 0]) - 0.21])
        d = sdf.smin(bib, skirt, 0.02)
        return d - _folds(P, 0.0025, 9.0, 31)

    def scarf(self, P):
        ring = sdf.torus_y(P, (0.0, 1.455, -0.012), 0.072, 0.022)
        ring = sdf.smin(ring, sdf.torus_y(P, (0.0, 1.49, -0.008), 0.064, 0.02), 0.02)
        tail = sdf.round_box(P, (0.035, 1.3, 0.1), (0.04, 0.14, 0.012), 0.008)
        tail2 = sdf.round_box(P, (0.065, 1.36, 0.09), (0.036, 0.08, 0.012), 0.008)
        return sdf.smin(sdf.smin(ring, tail, 0.03), tail2, 0.02) - _folds(P, 0.003, 14.0, 41)

    # -- hair and hats -------------------------------------------------------------------------
    def no_hair(self, P):
        """Where hair never grows: the face, round the ears, and below the nape."""
        face = sdf.ellipsoid(P, (0.0, 1.622, 0.072), (0.066, 0.1, 0.06))
        d = face
        for s in (1, -1):
            # The whole ear and a little round it (the hair shell follows the head field, which
            # includes the ears: anything less wraps them in hair).
            d = np.minimum(d, sdf.ellipsoid(P, (0.079 * s, 1.634, -0.008), (0.03, 0.041, 0.031)))
        # Sideburns stop short (higher for women) instead of hanging as strips past the ears.
        d = np.minimum(d, np.maximum(P[..., 1] - (1.655 if self.B.f else 1.628), -0.02 - P[..., 2]))
        return np.minimum(d, P[..., 1] - 1.6 - 0.12 * np.maximum(0.0, P[..., 2] + 0.02))

    def hair(self, P):
        style = self.sp.hair
        H = self.B.head
        # Thickness fades out toward the hairline (no helmet ledge); the line itself wanders.
        edge = self.no_hair(P) + 0.0007 * skin.fbm3(P, 45.0, 2, seed=53)
        taper = smoothstep(-0.002, 0.016, edge)
        # At the hairline the shell dips just under the skin, so the line is where the two
        # surfaces cross (clean) rather than a sliver of coplanar faces (ragged).
        sink = 0.0009 * (1.0 - smoothstep(0.0, 0.006, edge))
        if style == "buzz":
            d = H(P) - 0.0025 * taper
        elif style == "crop":
            d = H(P) - (0.0035 + 0.006 * smoothstep(1.66, 1.75, P[..., 1])) * taper - 0.0004
        elif style in ("ponytail", "bun"):
            d = H(P) - 0.0042 * taper - 0.0004
            if style == "ponytail":
                tail = sdf.round_cone(P, (0.0, 1.69, -0.105), (0.0, 1.5, -0.13), 0.022, 0.012)
                tail = sdf.smin(tail, sdf.sphere(P, (0.0, 1.68, -0.11), 0.026), 0.015)
                d = sdf.smin(d, tail, 0.015)
            else:
                d = sdf.smin(d, sdf.ellipsoid(P, (0.0, 1.73, -0.085), (0.038, 0.032, 0.034)), 0.015)
        elif style == "bob":
            d = H(P) - 0.011 * taper - 0.0005
            Q = P.copy()
            Q[..., 2] = Q[..., 2] + 0.012
            sides = sdf.round_cone(Q, (0.0, 1.68, 0.0), (0.0, 1.565, -0.01), 0.098, 0.088)
            sides = sdf.smax(sides, -sdf.ellipsoid(P, (0.0, 1.58, 0.07), (0.064, 0.11, 0.07)), 0.01)
            d = sdf.smin(d, sides, 0.02)
            d = _cut(d, P, (0.0, 1.555, 0.0), (0.0, -1.0, 0.0), 0.006)
        else:  # curly
            # Tight curls: a dense mass with clustered bumps.
            d = H(P) - (0.014 + 0.005 * np.abs(skin.fbm3(P, 85.0, 2, seed=51))) * taper - 0.0005
        d = sdf.smax(d + sink, -edge, 0.004)
        # A shell over the scalp, not a solid head: nothing inside to push through when decimated.
        d = np.maximum(d, -(H(P) + 0.0025))
        if style in ("crop", "buzz", "curly"):
            d = _cut(d, P, (0.0, 1.585, 0.0), (0.0, -1.0, 0.0), 0.006)
        return d - _folds(P, 0.0012, 60.0, 52) * taper

    def hat_line(self, P):
        """Height of a hat's lower edge: above the brows in front, over the ears at the sides,
        down to the nape at the back."""
        return np.interp(P[..., 2], (-0.12, -0.07, -0.03, 0.02, 0.07, 0.2), (1.645, 1.648, 1.668, 1.673, 1.692, 1.692))

    def hat(self, P):
        """Hats are shells fitted to the skull (clear of the hair under them), so no part of
        the head can push through them."""
        sk = self.B.skull(P)
        below = self.hat_line(P) - P[..., 1]
        if self.sp.hat == "cap":
            margin = 0.007 + 0.007 * smoothstep(1.66, 1.75, P[..., 1])
            crown = sdf.smax(sk - margin, below, 0.003)
            # The bill curves down at the sides, as a worn cap's does.
            Q = P.copy()
            Q[..., 1] = Q[..., 1] + 3.3 * Q[..., 0] ** 2 + 0.2 * np.maximum(0.0, Q[..., 2] - 0.1)
            brim = sdf.ellipsoid(Q, (0.0, 1.694, 0.098), (0.074, 0.005, 0.074))
            brim = np.maximum(brim, 0.06 - P[..., 2])
            button = sdf.sphere(P, (0.0, 1.771, -0.014), 0.0075)
            return sdf.union(crown, brim, button)
        if self.sp.hat == "beanie":
            crown = sdf.smax(sk - 0.008, below, 0.003)
            # The turned-up cuff: a thicker band at the bottom with a soft top edge.
            band = np.maximum(sk - 0.014, P[..., 1] - (self.hat_line(P) + 0.034))
            cuff = sdf.smax(band, below, 0.003)
            ribs = 0.0007 * np.sin(np.arctan2(P[..., 0], P[..., 2] + 0.014) * 110.0) * smoothstep(0.004, 0.012, P[..., 1] - self.hat_line(P))
            return sdf.smin(crown, cuff, 0.004) - _folds(P, 0.0012, 40.0, 61) - ribs
        return None

    def beard_zone(self, P):
        """Where a short beard grows: jaw, chin and a moustache, leaving the lips bare."""
        A = arch(P)
        jaw = sdf.ellipsoid(P, (0.0, 1.548, 0.035), (0.064, 0.05, 0.07))
        jaw = np.maximum(jaw, P[..., 1] - 1.6 + 0.25 * np.maximum(0.0, np.abs(P[..., 0]) - 0.03))  # cheek line
        tache = sdf.ellipsoid(A, (0.0, 1.585, 0.088), (0.03, 0.0065, 0.012))
        # Down past the corners of the mouth to the chin: one beard, not a moustache floating
        # above a goatee.
        for s in (1, -1):
            tache = np.minimum(tache, sdf.capsule(A, (0.026 * s, 1.582, 0.085), (0.024 * s, 1.55, 0.08), 0.0075))
        lu, ll = LIPS[self.B.f]
        lips = np.minimum(sdf.ellipsoid(A, LIP_U, (0.025, lu, 0.009)), sdf.ellipsoid(A, LIP_L, (0.0215, ll, 0.009))) - 0.0012
        return sdf.smax(np.minimum(jaw, tache), -lips, 0.0015)

    def beard(self, P):
        if self.sp.beard != "short":
            return None
        H = self.B.head
        zone = self.beard_zone(P) + 0.0006 * skin.fbm3(P, 60.0, 2, seed=72)
        taper = smoothstep(0.0, -0.012, zone)
        sink = 0.0008 * (1.0 - smoothstep(0.0, -0.004, zone))
        d = H(P) - 0.0024 * taper - 0.0002 + sink
        d = sdf.smax(d, zone, 0.003)
        d = np.maximum(d, -(H(P) + 0.0025))
        d = sdf.smax(d, -(P[..., 1] - 1.505), 0.008)  # not far down the neck
        return d - _folds(P, 0.0006, 120.0, 71) * taper


# ----------------------------------------------------------------------------------------------
# Textures (texel space: every texel knows where it sits on the sculpt)


FONT = os.path.join(os.path.dirname(__file__), "..", "fonts", "InterDisplay-Black.otf")


def _lin(hexcol):
    return np.asarray(bl.srgb_to_linear(bl.hexrgb(hexcol)))


def _gauss(P, c, sig):
    q = (P - np.asarray(c)) / np.asarray(sig)
    return np.exp(-np.einsum("...i,...i->...", q, q))


def _seg_t(P, a, b):
    """Parameter along segment a->b and distance to it."""
    ba = b - a
    t = np.clip(((P - a) @ ba) / (ba @ ba), 0.0, 1.0)
    return t, np.linalg.norm(P - a - t[:, None] * ba, axis=-1)


def _text_mask(text, w_px=512, h_px=128):
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("L", (w_px, h_px), 0)
    dr = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, int(h_px * 0.62))
    box = dr.textbbox((0, 0), text, font=font)
    dr.text(((w_px - (box[2] - box[0])) / 2 - box[0], (h_px - (box[3] - box[1])) / 2 - box[1]), text, fill=255, font=font)
    return np.asarray(img, dtype=np.float64) / 255.0


def _decal(P, mask_img, center, size, front=True):
    """Samples a flat image projected along Z onto texels (x right, y up) at ``center``."""
    h, w = mask_img.shape
    u = (P[:, 0] - (center[0] - size[0] / 2)) / size[0]
    v = 1.0 - (P[:, 1] - (center[1] - size[1] / 2)) / size[1]
    inside = (u >= 0) & (u < 1) & (v >= 0) & (v < 1) & ((P[:, 2] > center[2] - 0.03) if front else (P[:, 2] < center[2] + 0.03))
    out = np.zeros(len(P))
    ui = np.clip((u * w).astype(int), 0, w - 1)
    vi = np.clip((v * h).astype(int), 0, h - 1)
    out[inside] = mask_img[vi[inside], ui[inside]]
    return out


def _stitch(along, dist, width=0.0006, dash=0.004):
    """A dashed line of thread at ``dist`` = 0 (metres), dashes along ``along``."""
    line = np.exp(-((dist / width) ** 2))
    return line * (np.sin(2 * np.pi * along / dash) > -0.2)


class Painter:
    """Maps for one mesh: albedo (linear), roughness, height (m) -> PNGs, normal bake, material."""

    def __init__(self, obj, size, k):
        bl.lightmap_uv([obj], layer="UVMap", margin=0.006, angle=66.0)
        self.obj = obj
        self.size = size
        self.R = skin.rasterize(obj, size)
        M = self.R["mask"]
        self.P = self.R["P"][M] / k  # sculpt space
        self.N = self.R["N"][M]
        self.K = len(self.P)
        self.area = self.R["texel_area"] * self.K / (k * k)

    def finish(self, name, col, rough, height, metal=0.0):
        from PIL import Image

        M = self.R["mask"]
        size = self.size

        def full(v, fill=0.0):
            img = np.full((size, size) + np.shape(v)[1:], fill, dtype=np.float64)
            img[M] = v
            return img

        out = os.path.join(BUILD, "people")
        os.makedirs(out, exist_ok=True)
        paths = {key: os.path.join(out, f"{name}_{key}.png") for key in ("albedo", "orm", "normal")}
        albedo = bl.dilate(full(np.clip(col, 0, 1)), M, 16)
        srgb = np.where(albedo <= 0.0031308, albedo * 12.92, 1.055 * np.power(np.clip(albedo, 0, 1), 1 / 2.4) - 0.055)
        Image.fromarray((np.clip(srgb, 0, 1) * 255 + 0.5).astype(np.uint8)).save(paths["albedo"])
        hgt = full(height)
        cav = np.clip((skin.blur(hgt, 3.0) - hgt) / 0.25e-3, 0, 1) * M
        orm = np.stack([1 - 0.5 * cav, full(np.clip(rough, 0.05, 1.0), 0.6), full(np.full(self.K, metal))], -1)
        Image.fromarray((np.clip(bl.dilate(orm, M, 16), 0, 1) * 255 + 0.5).astype(np.uint8)).save(paths["orm"])
        hgt = bl.dilate(np.repeat(hgt[..., None], 3, -1), M, 16)[..., 0]
        nrm = skin.bake_normal(self.obj, hgt)
        Image.fromarray((np.clip(nrm, 0, 1) * 255 + 0.5).astype(np.uint8)).save(paths["normal"])
        m = bl.textured(name, paths)
        self.obj.data.materials.clear()
        self.obj.data.materials.append(m)
        return m


def paint_skin(pt: Painter, sp: Spec, B: Body, face: bool, name: str):
    P, N = pt.P, pt.N
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    base = _lin(sp.skin)
    tone = 1 + 0.05 * skin.fbm3(P, 40.0, 3, seed=101) + 0.03 * skin.fbm3(P, 160.0, 2, seed=102)
    col = base[None] * tone[:, None]
    red = 0.1 * np.clip(skin.fbm3(P, 70.0, 3, seed=103) + 0.3, 0, 1)
    rough = np.full(pt.K, 0.56) + 0.04 * skin.fbm3(P, 90.0, 2, seed=104)
    h = 0.012e-3 * skin.fbm3(P, 1400.0, 2, seed=105) + 0.02e-3 * skin.fbm3(P, 500.0, 2, seed=106)
    if face:
        f = B.f
        for s in (1, -1):
            red += 0.45 * _gauss(P, (0.043 * s, 1.6, 0.068), (0.02, 0.017, 0.02))
            red += 0.3 * _gauss(P, (0.078 * s, 1.638, -0.008), (0.012, 0.03, 0.02))  # ears
        red += 0.4 * _gauss(P, (0.0, 1.605, 0.11), (0.016, 0.012, 0.012))
        # Lips.
        lu, ll = LIPS[f]
        A = arch(P)
        dl = np.minimum(sdf.ellipsoid(A, LIP_U, (0.025, lu, 0.009)), sdf.ellipsoid(A, LIP_L, (0.0215, ll, 0.009)))
        lip = smoothstep(0.0026, -0.0002, dl) * (z > 0.062)
        lipcol = base * (np.array([0.74, 0.44, 0.44]) if not f else np.array([0.7, 0.38, 0.42]))
        # The philtrum: a soft groove in the height between two faint ridges.
        h -= 0.08e-3 * np.exp(-((x / 0.0022) ** 2)) * (y > 1.582) * (y < 1.594) * (z > 0.08)
        col = col * (1 - lip[:, None]) + lipcol[None] * lip[:, None]
        rough -= 0.12 * lip
        h -= 0.015e-3 * lip * (np.sin(2 * np.pi * x / 0.0011) > 0.6)
        # Brows: tapered arcs of short strokes.
        brow = np.zeros(pt.K)
        hair = _lin(sp.hair_color)
        for s in (1, -1):
            u = (x * s - 0.012) / 0.046
            arc_y = 1.669 + (0.007 if f else 0.004) * np.sin(np.pi * np.clip(u, 0, 1)) - 0.003 * u
            thick = ((0.0042 if not f else 0.003) * (1 - 0.6 * np.clip(u, 0, 1)) + 0.0008)
            m = smoothstep(thick, thick * 0.4, np.abs(y - arc_y)) * smoothstep(-0.08, 0.02, u) * smoothstep(1.08, 0.95, u) * (z > 0.055)
            strokes = 0.5 + 0.5 * np.sin(2 * np.pi * (x * s * 0.9 + (y - arc_y) * 2.2) / 0.0011 + 4 * skin.fbm3(P, 600.0, 1, seed=107))
            brow = np.maximum(brow, m * (0.55 + 0.45 * strokes))
        col = col * (1 - 0.85 * brow[:, None]) + hair[None] * (0.85 * brow[:, None])
        rough += 0.15 * brow
        # Lash line along the upper lids, fainter along the lower.
        for c in B.eye_centres():
            u = (x - c[0]) / 0.0128
            v = y - c[1] + 0.0004
            half = (0.0049 if f else 0.0045) * np.clip(1 - u * u, 0, 1) ** 0.7 + 0.0002
            upper = np.exp(-(((v - half - 0.0004) / 0.0006) ** 2)) * (np.abs(u) < 1.1) * (z > c[2])
            lower = np.exp(-(((v + half + 0.0003) / 0.0005) ** 2)) * (np.abs(u) < 0.9) * (z > c[2])
            col = col * (1 - (0.75 * upper + 0.3 * lower)[:, None]) + hair[None] * 0.3 * (0.75 * upper + 0.3 * lower)[:, None]
            # Soft shadow and colour around the eyes.
            ring = _gauss(P, c + np.array([0.0, -0.004, 0.006]), (0.018, 0.012, 0.012))
            col = col * (1 - 0.1 * ring[:, None] * np.array([0.6, 0.9, 0.7])[None])
        # Stubble or the shadow under a short beard.
        if sp.beard:
            zone = smoothstep(0.004, -0.008, sdf.ellipsoid(P, (0.0, 1.555, 0.05), (0.068, 0.055, 0.066))) * (1 - lip) * (y < 1.605)
            zone = np.maximum(zone, smoothstep(0.004, -0.006, sdf.ellipsoid(P, (0.0, 1.586, 0.095), (0.024, 0.008, 0.012))))
            dots = np.clip(0.5 + skin.fbm3(P, 1600.0, 1, seed=108), 0, 1)
            amt = (0.38 if sp.beard == "stubble" else 0.55) * zone * (0.6 + 0.4 * dots)
            col = col * (1 - amt[:, None]) + (hair * 0.6)[None] * amt[:, None] * 0.4
        # Gentle anatomy in the height: nasolabial folds, forehead lines, under-eye creases.
        for s in (1, -1):
            _t, dd = _seg_t(P, np.array([0.016 * s, 1.598, 0.1]), np.array([0.028 * s, 1.565, 0.088]))
            h -= 0.18e-3 * np.exp(-((dd / 0.0028) ** 2))
            _t, de = _seg_t(P, np.array([0.02 * s, 1.632, 0.09]), np.array([0.044 * s, 1.632, 0.082]))
            h -= 0.05e-3 * np.exp(-((de / 0.0012) ** 2))
        if sp.id in ("crew", "office", "worker"):
            for yy in (1.692, 1.701, 1.71):
                h -= 0.03e-3 * np.exp(-(((y - yy - 0.0015 * skin.fbm3(P, 80.0, 1, seed=109)) / 0.0007) ** 2)) * (np.abs(x) < 0.035) * (z > 0.06)
        tzone = _gauss(P, (0.0, 1.66, 0.09), (0.03, 0.05, 0.03))
        rough -= 0.1 * tzone
        h -= 0.012e-3 * np.clip(1 - (skin.cellular(P, pt.area, 0.55e-3, seed=110, k=1) / 0.18e-3) ** 2, 0, 1)
    red = np.clip(red, 0, 1)
    col = col * (1 - 0.3 * red[:, None]) + (base * np.array([1.0, 0.55, 0.5]))[None] * (0.3 * red[:, None])
    return pt.finish(name, col, rough, h)


def paint_hair(pt: Painter, sp: Spec, name: str, beard: bool = False):
    P = pt.P
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    base = _lin(sp.hair_color)
    crown = np.array([0.0, 1.745, -0.035])
    q = P - crown
    phi = np.arctan2(q[:, 0], q[:, 2])
    rho = np.linalg.norm(q, axis=-1)
    warp = skin.fbm3(P, 30.0, 2, seed=121)
    if sp.hair == "curly" and not beard:
        strands = skin.fbm3(P, 260.0, 2, seed=122)
    elif beard:
        strands = np.sin(2 * np.pi * (y * 0.7 + x * 0.3) / 0.0012 + 6 * skin.fbm3(P, 300.0, 1, seed=123))
    else:
        strands = 0.6 * np.sin(phi * 160.0 + 5.0 * warp + rho * 40.0) + 0.4 * np.sin(phi * 410.0 + 9.0 * warp)
        strands *= 0.6 + 0.4 * skin.fbm3(P, 120.0, 2, seed=126)
    fine = skin.fbm3(P, 900.0, 1, seed=124)
    col = base[None] * (0.86 + 0.12 * strands + 0.1 * fine)[:, None]
    col = col * (1 + 0.18 * smoothstep(0.06, 0.16, rho))[:, None]  # sun-lightened lengths
    rough = (0.66 if beard else 0.5) + 0.06 * strands + 0.05 * fine
    h = 0.035e-3 * strands + 0.25e-3 * skin.fbm3(P, 70.0, 2, seed=125)
    return pt.finish(name, col, rough, h)


def paint_cloth(pt: Painter, sp: Spec, B: Body, W: Wardrobe, role: str, name: str):
    """Fabric: weave-scale noise, ribbed bands, seams and stitching, prints and wear."""
    P, N = pt.P, pt.N
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    J = B.J
    g = {"top": sp.top, "bottom": sp.bottom, "under": {"color": sp.top.get("under", "#FFFFFF"), "fabric": "cotton"}}.get(role, {})
    fabric = g.get("fabric", "cotton")
    color = {"top": sp.top.get("color"), "bottom": sp.bottom.get("color"), "under": sp.top.get("under"), "shoes": sp.shoes["color"], "soles": sp.shoes["sole"]}.get(role) or sp.colors.get(role, "#808080")
    if role == "cap":
        color = "#E2E2E2"  # neutral: the client multiplies in each player's team colour
    base = _lin(color)
    col = np.repeat(base[None], pt.K, 0)
    heather = skin.fbm3(P, 400.0, 2, seed=131)
    col *= (1 + 0.05 * heather + 0.05 * skin.fbm3(P, 25.0, 2, seed=132))[:, None]
    rough = np.full(pt.K, 0.82)
    h = 0.015e-3 * heather
    rib = np.zeros(pt.K)

    def band(mask, across, period=0.0035):
        nonlocal h, rib
        h += 0.12e-3 * mask * np.sin(2 * np.pi * across / period)
        rib = np.maximum(rib, mask)

    def sleeve_coords(t):
        sh, el, wr = J[f"shoulder_{t}"], J[f"elbow_{t}"], J[f"wrist_{t}"]
        t1, d1 = _seg_t(P, sh, el)
        t2, d2 = _seg_t(P, el, wr)
        along = np.where(d1 < d2, t1 * np.linalg.norm(el - sh), np.linalg.norm(el - sh) + t2 * np.linalg.norm(wr - el))
        return along, np.minimum(d1, d2)

    if role == "top":
        kind = sp.top["kind"]
        hem = sp.top["hem"]
        around = np.arctan2(x, z) * 0.15
        # Ribbed hem, cuffs and neck on knits; the varsity trims carry two stripes.
        if kind in ("tee", "hoodie", "varsity"):
            band(smoothstep(0.035 if kind != "tee" else 0.018, 0.0, y - hem), around)
            neck_d = sdf.capsule(P, (0.0, 1.43, -0.026), (0.0, 1.62, -0.012), 0.066)
            band(smoothstep(0.016, 0.0, np.abs(neck_d) - 0.004) * (y > 1.38), around)
        sleeve_lim = []
        for t in ("r", "l"):
            along, dist = sleeve_coords(t)
            on_arm = dist < 0.075
            ln = np.linalg.norm(J[f"elbow_{t}"] - J[f"shoulder_{t}"]) * (0.48 if sp.top["sleeve"] == "short" else 1.0)
            if sp.top["sleeve"] != "short":
                ln += np.linalg.norm(J[f"wrist_{t}"] - J[f"elbow_{t}"]) - 0.018
            cuff = on_arm * smoothstep(0.035 if kind in ("hoodie", "varsity") else 0.012, 0.0, ln - along)
            if kind in ("hoodie", "varsity", "tee"):
                band(cuff, np.arctan2(*(P - J[f"elbow_{t}"])[:, [0, 2]].T) * 0.03)
            else:
                # Hemmed sleeve: a line of stitching 1 cm from the edge.
                col *= (1 - 0.25 * _stitch(along * 3.0, ln - along - 0.01)[:, None] * on_arm[:, None])
            sleeve_lim.append(on_arm & (along > 0.06))
        on_sleeve = sleeve_lim[0] | sleeve_lim[1]
        if kind == "varsity":
            cream = _lin(sp.top["sleeves"])
            col = np.where(on_sleeve[:, None], cream[None] * (1 + 0.04 * heather)[:, None], col)
            stripes = (rib > 0.5) & (np.sin(2 * np.pi * (y - hem) / 0.012) > 0.55)
            col = np.where(stripes[:, None], _lin(sp.top["trim"])[None], col)
            letter = _decal(P, _text_mask("A", 256, 256), (0.075, 1.31, 0.09), (0.07, 0.07))
            col = col * (1 - letter[:, None]) + _lin(sp.top["trim"])[None] * letter[:, None]
            h += 0.25e-3 * letter
        if kind == "tee" and sp.id == "crew":
            logo = _decal(P, _text_mask("AFTER HOURS", 512, 96), (0.072, 1.33, 0.09), (0.07, 0.013))
            col = col * (1 - 0.9 * logo[:, None]) + np.array([0.85, 0.83, 0.8])[None] * (0.9 * logo[:, None])
        if kind == "hoodie":
            # Kangaroo pocket and drawstrings.
            pocket = (np.abs(x) < 0.115 - 0.25 * np.maximum(0, y - 0.98)) & (y > 0.9) & (y < 1.07) & (z > 0.02)
            edge = np.abs(np.abs(x) - (0.115 - 0.25 * np.maximum(0, y - 0.98)))
            col *= (1 - 0.35 * _stitch(y, edge - 0.004)[:, None] * ((y > 0.9) & (y < 1.07) & (z > 0.02))[:, None])
            h += 0.25e-3 * pocket
            for s in (1, -1):
                cord = np.exp(-(((x - 0.03 * s) / 0.0022) ** 2)) * (y > 1.25) * (y < 1.44) * (z > 0.04)
                col = col * (1 - cord[:, None]) + np.array([0.82, 0.8, 0.76])[None] * cord[:, None]
                h += 0.5e-3 * cord
        if kind == "hivis":
            refl = np.zeros(pt.K, bool)
            for yy in (1.07, 1.17):
                refl |= (np.abs(y - yy) < 0.022) & ~on_sleeve
            for t in ("r", "l"):
                along, dist = sleeve_coords(t)
                refl |= (dist < 0.08) & (np.abs(along - 0.36) < 0.022)
            col = np.where(refl[:, None], np.array([0.62, 0.64, 0.64])[None] * (1 + 0.06 * heather)[:, None], col)
            rough = np.where(refl, 0.32, rough)
            h += 0.08e-3 * refl
        if kind in ("blazer", "coat"):
            rows = [(0.0, 1.12), (0.0, 1.05)] if kind == "blazer" else [(0.055, y0) for y0 in (1.22, 1.12, 1.02)] + [(-0.055, y0) for y0 in (1.22, 1.12, 1.02)]
            for bx, by in rows:
                b = np.hypot(x - bx, y - by) < 0.0085
                b &= z > 0.03
                col = np.where(b[:, None], np.array([0.03, 0.025, 0.02])[None], col)
                rough = np.where(b, 0.35, rough)
                h += 0.6e-3 * b
            if kind == "blazer":
                for s in (1, -1):
                    flap = (np.abs(y - 0.985) < 0.0012) & (np.abs(x - 0.095 * s) < 0.06) & (z > 0.0)
                    h -= 0.25e-3 * flap
        if kind == "scrubs":
            pocket = (np.abs(x - 0.075) < 0.045) & (np.abs(y - 1.27) < 0.05) & (z > 0.03)
            h += 0.2e-3 * pocket
            col *= (1 - 0.3 * _stitch(y + x, np.minimum(np.abs(np.abs(x - 0.075) - 0.045), np.abs(y - 1.32)) * ((np.abs(x - 0.075) < 0.046) & (np.abs(y - 1.27) < 0.051) & (z > 0.03)))[:, None])
        rough = rough - 0.05 * (fabric == "wool")
    if role == "bottom":
        denim = fabric == "denim"
        for t in ("r", "l"):
            s = 1.0 if t == "r" else -1.0
            hp, an = J[f"hip_{t}"], J[f"ankle_{t}"]
            ta, da = _seg_t(P, hp, an)
            mine = (x * s > 0.0) & (da < 0.12)
            lateral = N[:, 0] * s
            # Outseam and inseam with topstitching; hem stitched near the shoe.
            outseam = np.abs(N[:, 2]) * (lateral > 0.3)
            inseam = np.abs(N[:, 2]) * (lateral < -0.3)
            thread = _lin("#C89B48") if denim else base * 0.7
            for seam in (outseam, inseam):
                st = _stitch(y, seam - 0.04, width=0.03, dash=0.006) * mine
                col = col * (1 - 0.7 * st[:, None]) + thread[None] * (0.7 * st[:, None])
                h -= 0.06e-3 * smoothstep(0.08, 0.0, seam) * mine
            hem_st = _stitch(np.arctan2(x - an[0], z - an[2]) * 0.05, y - an[1] - 0.05) * mine
            col = col * (1 - 0.6 * hem_st[:, None]) + thread[None] * (0.6 * hem_st[:, None])
            if denim:
                # Fading on the thigh fronts and knees, whiskers at the hip crease.
                front = np.clip(N[:, 2], 0, 1) * mine
                fade = front * (0.5 * _gauss(P, (hp[0] * 0.9, 0.72, 0.06), (0.06, 0.16, 0.08)) + 0.4 * _gauss(P, (J[f"knee_{t}"][0], 0.5, 0.06), (0.05, 0.05, 0.06)))
                wh = np.clip(np.sin(2 * np.pi * (y - 0.4 * np.abs(x - hp[0])) / 0.018), 0, 1) ** 3 * _gauss(P, (hp[0] * 0.6, 0.86, 0.08), (0.06, 0.04, 0.06)) * front
                col = col * (1 + (0.55 * fade + 0.35 * wh)[:, None] * np.array([0.9, 1.0, 1.2])[None])
        if denim:
            streak = skin.fbm3(P * np.array([1.0, 0.12, 1.0]), 900.0, 2, seed=133)
            col *= (1 + 0.12 * streak)[:, None]
            rough = rough + 0.05
        if sp.bottom["kind"] == "trousers":
            # Pressed creases down the front of each leg.
            for t in ("r", "l"):
                kx = J[f"knee_{t}"][0]
                crease = np.exp(-(((x - kx) / 0.004) ** 2)) * (z > 0.03) * (y < 0.95)
                h += 0.2e-3 * crease
        # Waistband: stitched along its lower edge.
        col *= (1 - 0.4 * _stitch(np.arctan2(x, z) * 0.1, y - 0.99)[:, None])
    if role in ("shoes", "soles"):
        kind = sp.shoes["kind"]
        rough = np.full(pt.K, {"dress": 0.32, "boot": 0.55, "work": 0.6, "sneaker": 0.65}[kind] if role == "shoes" else 0.85)
        if role == "shoes":
            for t in ("r", "l"):
                an, toe = J[f"ankle_{t}"], J[f"toe_{t}"]
                mine = (x * (1 if t == "r" else -1)) > 0
                lx = x - (an[0] + toe[0]) / 2
                # Laces across the instep (not on dress shoes).
                if kind != "dress":
                    zone = mine & (np.abs(lx) < 0.022) & (z > an[2] + 0.03) & (z < toe[2] - 0.035) & (N[:, 1] > 0.3)
                    lace = zone & (np.sin(2 * np.pi * (z + np.abs(lx) * 0.6) / 0.012) > 0.3)
                    col = np.where(lace[:, None], (np.array([0.9, 0.9, 0.88]) if kind == "sneaker" else np.array([0.12, 0.08, 0.05]))[None], col)
                    h += 0.4e-3 * lace
                # Toe cap and heel counter seams.
                cap = np.abs(z - (toe[2] - 0.02)) < 0.0012
                h -= 0.2e-3 * (cap & mine & (y > 0.015))
                if kind in ("boot", "dress", "work"):
                    crease = (np.abs(z - (toe[2] - 0.045)) < 0.008) * np.clip(skin.fbm3(P, 400.0, 1, seed=134), 0, 1) * mine
                    h -= 0.15e-3 * crease
        else:
            tread = np.sin(2 * np.pi * z / 0.006) * (y < 0.008)
            h += 0.3e-3 * tread
    if role in ("cap", "beanie", "scarf", "apron"):
        if role == "beanie" or role == "scarf":
            band(np.ones(pt.K), np.arctan2(x, z) * 0.1 if role == "beanie" else y, 0.004)
        if role == "cap":
            # Panel seams radiating from the button; stitched brim. Neutral so team colour tints it.
            q = P - np.array([0.0, 1.776, -0.008])
            ang = np.arctan2(q[:, 0], q[:, 2])
            seam = np.abs(np.sin(ang * 3.0))
            h -= 0.2e-3 * (seam < 0.05) * (y > 1.69)
            brim = z > 0.06
            col *= (1 - 0.3 * (_stitch(x, np.abs(z - 0.13) - 0.01) * brim))[:, None]
        if role == "apron":
            # Canvas with a split front pocket.
            pocket = (np.abs(x) < 0.16) & (y > 0.74) & (y < 0.88) & (z > 0.05)
            h += 0.25e-3 * pocket
            col *= (1 - 0.35 * (_stitch(x, y - 0.88) + _stitch(y, x)) * pocket)[:, None]
            col *= (1 + 0.08 * skin.fbm3(P, 12.0, 2, seed=135))[:, None]
            rough = rough + 0.05
    # A little wear: lighter on raised folds, darker in the hollows (cavity does the rest).
    folds = skin.fbm3(P, 7.0, 3, seed=11) + 0.3 * skin.fbm3(P, 22.0, 3, seed=12)
    col *= (1 + 0.05 * folds)[:, None]
    return pt.finish(name, col, np.clip(rough, 0.2, 0.95), h)


def paint_person(sp: Spec, B: Body, W: Wardrobe, objs, k: float, quick: bool) -> None:
    big, mid, small = (512, 256, 256) if quick else (1024, 512, 256)
    for o in objs:
        n = o.name
        role = n[len(sp.id) + 1:]
        if role.startswith(("eye", "iris")):
            continue
        if role == "head":
            paint_skin(Painter(o, big, k), sp, B, True, n)
        elif role == "body":
            paint_skin(Painter(o, mid, k), sp, B, False, n)
        elif role in ("hair", "beard"):
            paint_hair(Painter(o, mid, k), sp, n, beard=role == "beard")
        elif role in ("top", "bottom", "under", "apron", "scarf", "cap", "beanie"):
            paint_cloth(Painter(o, big if role in ("top", "bottom") else mid, k), sp, B, W, role, n)
        elif role in ("shoes", "soles"):
            paint_cloth(Painter(o, small, k), sp, B, W, role, n)


# ----------------------------------------------------------------------------------------------
# Building one person


def _poly(name, fn, lo, hi, voxel, mat=None, target=4000, smooth=2, scale=1.0):
    """Polygonises a sculpt-space field into a mesh scaled to the person's height, decimated to
    about ``target`` triangles."""
    verts, faces = sdf.polygonise(fn, lo, hi, voxel)
    if len(faces) == 0:
        return None
    return sdf.to_blender(name, verts * scale, faces, mat, decimate=min(1.0, target / len(faces)), smooth_iters=smooth)


def _trim_hidden(obj, cover_fns, scale, margin=0.004):
    """Deletes body faces that lie under clothes (all three vertices inside a garment)."""
    import bmesh

    me = obj.data
    V = np.array([tuple(v.co) for v in me.vertices])
    Pg = np.stack([-V[:, 0], V[:, 2], -V[:, 1]], -1) / scale
    inside = np.zeros(len(V), bool)
    for fn in cover_fns:
        inside |= fn(Pg) < -margin
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    dead = [f for f in bm.faces if all(inside[v.index] for v in f.verts)]
    bmesh.ops.delete(bm, geom=dead, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(me)
    bm.free()


def _front_z(fn, x, y, lo=-0.05, hi=0.3):
    """Front surface z of a field along a horizontal ray (binary search)."""
    for _ in range(24):
        mid = (lo + hi) / 2
        if fn(np.array([[x, y, mid]]))[0] < 0:
            lo = mid
        else:
            hi = mid
    return hi


def takeaway_bag(J, k) -> list[bpy.types.Object]:
    """Kraft-paper bag with a folded top, held in the right hand (shown once they have their food)."""
    from PIL import Image, ImageDraw, ImageFont

    out = os.path.join(BUILD, "people")
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "takeaway_bag_albedo.png")
    if not os.path.exists(path):
        rng = np.random.default_rng(5)
        img = np.zeros((256, 256, 3))
        kraft = np.array([0.71, 0.53, 0.34])
        fib = rng.normal(0, 1, (256, 256))
        from scipy.ndimage import gaussian_filter

        fib = gaussian_filter(fib, (0.6, 3.0))
        img[:] = kraft * (1 + 0.06 * fib[..., None])
        pil = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
        dr = ImageDraw.Draw(pil)
        font = ImageFont.truetype(FONT, 34)
        for text, yy in (("AFTER", 96), ("HOURS", 132)):
            box = dr.textbbox((0, 0), text, font=font)
            dr.text(((256 - (box[2] - box[0])) / 2 - box[0], yy), text, fill=(120, 30, 24), font=font)
        pil.save(path)
    m = bl.textured("takeaway_bag", {"albedo": path})
    m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.85
    grip = J["fingers_r"] * k + np.array([0.0, 0.01, 0.0])
    c = grip + np.array([0.0, -0.13, 0.01])
    bag = bl.box("takeaway_bag", tuple(c), (0.085, 0.2, 0.15), m, bevel=0.004)
    top = bl.box("takeaway_bag_fold", tuple(grip + np.array([0.0, -0.015, 0.01])), (0.09, 0.035, 0.155), m, bevel=0.006)
    for o in (bag, top):  # the wide sides (printed) face out, the bag hangs along the leg
        bl.transform_apply(o)
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.cube_project(cube_size=0.25)
        bpy.ops.object.mode_set(mode="OBJECT")
        o.select_set(False)
    return [bag, top]


def apron_straps(W, k, mat_) -> list[bpy.types.Object]:
    tor = W.B.torso
    zt = _front_z(tor, 0.1, 1.37) + 0.012
    strap = bl.bezier_tube("crew_apron_strap", [tuple(np.array(p) * k) for p in ((0.105, 1.368, zt), (0.08, 1.45, 0.04), (0.0, 1.49, -0.045), (-0.08, 1.45, 0.04), (-0.105, 1.368, zt))], 0.0065 * k, mat_)
    zw = _front_z(tor, 0.17, 1.01) + 0.01
    tie = bl.bezier_tube("crew_apron_tie", [tuple(np.array(p) * k) for p in ((-0.17, 1.01, zw), (-0.17, 1.01, -0.06), (0.0, 1.01, -0.118), (0.17, 1.01, -0.06), (0.17, 1.01, zw))], 0.006 * k, mat_)
    bow = bl.bezier_tube("crew_apron_bow", [tuple(np.array(p) * k) for p in ((0.0, 1.01, -0.118), (0.025, 0.95, -0.124), (0.035, 0.86, -0.12))], 0.008 * k, mat_)
    return [strap, tie, bow]


def mat(name, hexcol, rough, metal=0.0, **kw):
    return bl.solid(name, bl.hexrgb(hexcol), rough, metal, **kw)


def build_person(sp: Spec, quick: bool = False, textures: bool = True) -> list[bpy.types.Object]:
    """Meshes, materials and rig of one person; returns [armature, meshes...] in game space."""
    B = Body(sp)
    W = Wardrobe(B)
    k = sp.height / BASE_H
    vb = 0.008 if quick else 0.0045
    vh = 0.0026 if quick else 0.0016
    pid = sp.id
    M = {
        "skin": mat(f"{pid}_skin", sp.skin, 0.5),
        "top": mat(f"{pid}_top", sp.top["color"], 0.82),
        "bottom": mat(f"{pid}_bottom", sp.bottom["color"], 0.8),
        "shoe": mat(f"{pid}_shoe", sp.shoes["color"], 0.45 if sp.shoes["kind"] == "dress" else 0.7),
        "sole": mat(f"{pid}_sole", sp.shoes["sole"], 0.75),
        "hair": mat(f"{pid}_hair", sp.hair_color, 0.45),
        "sclera": mat(f"{pid}_sclera", "#EEE9E2", 0.12),
        "iris": mat(f"{pid}_iris", sp.iris, 0.1, coat=1.0),
    }
    objs = []
    lo_b, hi_b = (-0.36, -0.005, -0.22), (0.36, 1.62, 0.26)
    # Garments first: they decide which skin shows.
    top = _poly(f"{pid}_top", W.top, (-0.33, sp.top["hem"] - 0.03, -0.2), (0.33, 1.62, 0.2), vb, M["top"], target=7000, scale=k)
    bottom = _poly(f"{pid}_bottom", W.bottom, (-0.26, 0.04, -0.2), (0.26, 1.08, 0.2), vb, M["bottom"], target=5000, scale=k)
    shoe = _poly(f"{pid}_shoes", lambda P: W.shoe(P), (-0.18, -0.01, -0.14), (0.18, 0.2, 0.2), vb * 0.7, M["shoe"], target=2000, scale=k)
    sole = _poly(f"{pid}_soles", lambda P: W.shoe(P, sole=True), (-0.18, -0.01, -0.14), (0.18, 0.05, 0.2), vb * 0.6, M["sole"], target=900, scale=k)
    objs += [o for o in (top, bottom, shoe, sole) if o]
    covers = [W.top, W.bottom, lambda P: W.shoe(P)]
    if sp.top.get("under"):
        under = _poly(f"{pid}_under", W.under, (-0.2, 1.0, -0.15), (0.2, 1.56, 0.16), vb, mat(f"{pid}_under", sp.top["under"], 0.7), scale=k)
        objs.append(under)
        covers.append(W.under)
    body = _poly(f"{pid}_body", B.field, lo_b, hi_b, vb, M["skin"], target=14000, scale=k)
    _trim_hidden(body, covers, k)
    objs.append(body)
    head = _poly(f"{pid}_head", B.head, (-0.1, 1.4, -0.13), (0.1, 1.79, 0.135), vh, M["skin"], target=9000, scale=k)
    _trim_hidden(head, covers, k, margin=0.006)
    objs.append(head)
    for i, c in enumerate(B.eye_centres()):
        e = bl.lathe(f"{pid}_eye_{i}", [(0.0, -B.EYE_R), (B.EYE_R * 0.7, -B.EYE_R * 0.7), (B.EYE_R, 0.0), (B.EYE_R * 0.7, B.EYE_R * 0.7), (0.0, B.EYE_R)], tuple(c * k), M["sclera"], segments=20)
        e.rotation_euler.x = math.pi / 2  # pole forward (game +z)
        bl.transform_apply(e)
        iris = bl.cylinder(f"{pid}_iris_{i}", tuple((c + np.array([0.0, 0.0, B.EYE_R * 0.93])) * k), 0.0058 * k, 0.0012 * k, M["iris"], axis="z", segments=20)
        objs += [e, iris]
    hair = _poly(f"{pid}_hair", W.hair, (-0.12, 1.45, -0.17), (0.12, 1.8, 0.12), vh, M["hair"], target=6000, smooth=1, scale=k)
    if hair:
        objs.append(hair)
    hat_fn = W.hat
    if sp.hat:
        hat = _poly(f"{pid}_{sp.hat}", hat_fn, (-0.115, 1.62, -0.135), (0.115, 1.8, 0.18), vh * 1.5, mat(f"{pid}_{sp.hat}", sp.colors.get(sp.hat, "#333333"), 0.75), scale=k)
        objs.append(hat)
    if sp.beard == "short":
        beard = _poly(f"{pid}_beard", W.beard, (-0.08, 1.48, -0.02), (0.08, 1.62, 0.12), vh * 0.8, M["hair"], target=3000, smooth=1, scale=k)
        if beard:
            objs.append(beard)
    if "apron" in sp.extras:
        am = mat(f"{pid}_apron", sp.colors.get("apron", "#333333"), 0.85)
        objs.append(_poly(f"{pid}_apron", W.apron, (-0.24, 0.5, -0.05), (0.24, 1.4, 0.2), min(vb * 0.6, 0.003), am, target=3000, scale=k))
        straps = apron_straps(W, k, am)
    if "scarf" in sp.extras:
        objs.append(_poly(f"{pid}_scarf", W.scarf, (-0.12, 1.14, -0.11), (0.14, 1.53, 0.14), vb * 0.8, mat(f"{pid}_scarf", sp.colors.get("scarf", "#999999"), 0.9), scale=k))
    objs = [o for o in objs if o is not None]
    if textures:
        paint_person(sp, B, W, objs, k, quick)
    extra = straps if "apron" in sp.extras else []
    if sp.id != "crew":
        extra += takeaway_bag(B.J, k)
    arm = rig(sp, objs + extra, B, k)
    return [arm] + objs + extra


def rig(sp: Spec, objs, B: Body, k: float) -> bpy.types.Object:
    """Armature with the crew rig's bones; meshes weighted by distance to the bone segments."""
    from characters import add_bone, rigid_bind

    bs = {n: (a * k, b * k) for n, (a, b) in bones(B.J).items()}
    name = "crew" if sp.id == "crew" else f"customer_{sp.id}"
    arm_data = bpy.data.armatures.new(f"{name}_rig")
    arm_obj = bpy.data.objects.new(name, arm_data)
    bl.link(arm_obj, None)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")
    for n, (a, b) in bs.items():
        add_bone(arm_data, n, tuple(a), tuple(b), PARENTS[n])
    bpy.ops.object.mode_set(mode="OBJECT")
    torso = ["hips", "spine", "chest"]
    rigid = {}
    for t, o in (("r", "l"), ("l", "r")):
        for part in ("thigh", "shin", "foot"):
            rigid[f"{part}_{t}"] = [f"{q}_{o}" for q in ("thigh", "shin", "foot")] + ([] if part == "thigh" else torso)
        for part in ("forearm", "hand"):
            rigid[f"{part}_{t}"] = torso + [f"thigh_{t}", f"thigh_{o}", f"shin_{t}", f"shin_{o}"]
        rigid[f"upperarm_{t}"] = ["hips", f"thigh_{t}", f"thigh_{o}"]
    head_bones = {n: bs[n] for n in ("chest", "neck", "head")}
    for o in objs:
        n = o.name
        if "_eye_" in n or "_iris_" in n or n.endswith(("_hair", "_cap", "_beanie", "_beard")):
            bl.transform_apply(o)
            rigid_bind(o, arm_obj, "head")
            continue
        if n.startswith("takeaway_"):
            rigid_bind(o, arm_obj, "hand_r")
            continue
        if n.startswith("crew_apron_") and not n.endswith("apron"):
            bl.transform_apply(o)
            rigid_bind(o, arm_obj, "chest" if n.endswith("strap") else "hips")
            continue
        if n.endswith("_head"):
            sdf.skin_weights(o, head_bones, falloff=4.0, max_influences=2)
        elif n.endswith(("_apron", "_scarf")):
            sdf.skin_weights(o, {q: bs[q] for q in ("hips", "spine", "chest", "neck", "thigh_r", "thigh_l")}, falloff=3.0, max_influences=2)
        else:
            sdf.skin_weights(o, bs, falloff=4.0, max_influences=3, rigid=rigid)
        mod = o.modifiers.new("arm", "ARMATURE")
        mod.object = arm_obj
        o.parent = arm_obj
    for o in objs:
        bl.ensure_uv(o)
    return arm_obj


# ----------------------------------------------------------------------------------------------
# Previews


def preview(people: list[list[bpy.types.Object]], specs: list[Spec], tag: str = "people") -> None:
    import food
    from ahb import kit

    out = os.path.join(BUILD, "preview")
    os.makedirs(out, exist_ok=True)
    hdr = os.path.join(BUILD, "probe_dining.hdr")
    if os.path.exists(hdr):
        food.world_hdr(hdr, 0.7)
    n = len(people)
    for i, objs in enumerate(people):
        objs[0].location = bl.G((i - (n - 1) / 2) * 0.75, 0.0, 0.0)
    key = kit.area_light("key", (1.2, 2.6, 2.4), (1.2, 1.2), 320.0, (1.0, 0.95, 0.88), facing=(-0.3, -0.6, -1.0), up=(0, 1, 0))
    fill = kit.area_light("fill", (-2.5, 1.6, 1.8), (1.0, 1.0), 90.0, (0.85, 0.9, 1.0), facing=(1.0, -0.2, -0.7), up=(0, 1, 0))
    bl.camera("cam_line", (0.0, 1.15, 4.6 + 0.25 * n), (0.0, 0.92, 0.0), lens=32)
    bl.render(os.path.join(out, f"{tag}_lineup.jpg"), width=1600, height=900, samples=48, guided=True)
    for i, objs in enumerate(people):
        x = (i - (n - 1) / 2) * 0.75
        hk = specs[i].height / BASE_H
        bl.camera(f"cam_face_{i}", (x + 0.16, 1.66 * hk, 0.5), (x, 1.63 * hk, 0.0), lens=70)
        bl.render(os.path.join(out, f"{tag}_face_{specs[i].id}.jpg"), width=900, height=900, samples=48, guided=True)
    for o in (key, fill):
        bpy.data.objects.remove(o)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--flat", action="store_true", help="skip textures (shape iteration)")
    args = ap.parse_args([a for a in sys.argv[1:] if a != "--"])
    only = {s for s in args.only.split(",") if s}
    specs = [s for s in PEOPLE if not only or s.id in only]
    bl.reset()
    built = []
    for sp in specs:
        import time

        t = time.time()
        built.append(build_person(sp, quick=args.quick, textures=not args.flat))
        print(f"[people] {sp.id}: {len(built[-1]) - 1} meshes, {sum(len(o.data.polygons) for o in built[-1][1:])} faces, {time.time() - t:.0f}s", flush=True)
    if args.preview:
        preview(built, specs)
        return
    for sp, objs in zip(specs, built):
        name = "crew" if sp.id == "crew" else f"customer_{sp.id}"
        bl.export_gltf(os.path.join(ART, f"{name}.gltf"), objs, image_format="WEBP", quality=86)


if __name__ == "__main__":
    main()
