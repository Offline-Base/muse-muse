"""Draw the abstract line art on the landing page's model cards (site/art/*.svg).

    uv run python -m scripts.make_site_art        # writes site/art/*.svg

Original procedural drawings, no outside images: string-art ribbons, a tunnel of turning polygons,
a burst of curved rays and a band of waves. Deterministic: the same files every run.
"""

from __future__ import annotations

import argparse
import math
import random
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "site" / "art"
W, H = 660, 360


def mix(c1: str, c2: str, t: float) -> str:
    a = [int(c1[i : i + 2], 16) for i in (1, 3, 5)]
    b = [int(c2[i : i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(x + (y - x) * t):02X}" for x, y in zip(a, b, strict=True))


def doc(defs: str, bg: str, body: list[str]) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid slice">'
        f"<defs>{defs}</defs>"
        f'<rect width="{W}" height="{H}" fill="{bg}"/>'
        f'<g fill="none" stroke-linecap="round" stroke-linejoin="round">{"".join(body)}</g></svg>\n'
    )


def line(points: list[tuple[float, float]], color: str, opacity: float, width: float) -> str:
    d = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    return (
        f'<polyline points="{d}" stroke="{color}" stroke-opacity="{opacity:.2f}" stroke-width="{width:.2f}"/>'
    )


def gradient(gid: str, stops: list[tuple[float, str]], x2: str = "1", y2: str = "1") -> str:
    s = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in stops)
    return f'<linearGradient id="{gid}" x1="0" y1="0" x2="{x2}" y2="{y2}">{s}</linearGradient>'


def curl() -> str:
    """Muse: open hexagons that turn and shrink into a curl, like a wave closing over."""
    body = []
    vx, vy = 455, 150
    n = 56
    for k in range(n):
        t = k / (n - 1)
        s = 0.93**k
        cx = vx + (250 - vx) * s
        cy = vy + (360 - vy) * s
        r = 600 * s
        rot = 0.4 + k * 0.17
        pts = [
            (cx + r * math.cos(rot + i * math.pi / 3), cy + r * 0.72 * math.sin(rot + i * math.pi / 3))
            for i in range(5)
        ]
        body.append(line(pts, mix("#1D4FD6", "#A9BCF0", t), 0.9 - 0.55 * t, 1.4 - 0.8 * t))
    defs = gradient("bg", [(0, "#F3F5FA"), (0.6, "#E4E9F5"), (1, "#CBD6EE")])
    return doc(defs, "url(#bg)", body)


def tunnel() -> str:
    """Muse Glimmer: a tunnel of turning hexagons on a dark field."""
    body = []
    vx, vy = 455, 205
    n = 44
    for k in range(n):
        s = 0.9**k
        cx = vx + (330 - vx) * s
        cy = vy + (230 - vy) * s
        r = 520 * s
        rot = k * 0.11
        pts = [
            (cx + r * math.cos(rot + i * math.pi / 3), cy + r * 0.78 * math.sin(rot + i * math.pi / 3))
            for i in range(7)
        ]
        near = 1 - k / n
        color = mix("#2F6BFF", "#FFFFFF", min(1.0, k / 18))
        body.append(line(pts, color, 0.15 + 0.6 * near, 0.6 + 1.2 * near))
    rng = random.Random(7)
    for _ in range(26):
        x, y = rng.uniform(40, 620), rng.uniform(20, 340)
        body.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{rng.uniform(0.6, 1.6):.1f}" fill="#FFFFFF" fill-opacity="{rng.uniform(0.3, 0.9):.2f}"/>'
        )
    defs = (
        '<radialGradient id="bg" cx="0.68" cy="0.58" r="0.8">'
        '<stop offset="0" stop-color="#0E2A6E"/><stop offset="0.35" stop-color="#0A1020"/><stop offset="1" stop-color="#050608"/>'
        "</radialGradient>"
    )
    return doc(defs, "url(#bg)", body)


def burst() -> str:
    """Muse Spark: curved rays from one point, with a few arrowheads."""
    body = []
    rng = random.Random(3)
    cx, cy = 330, 185
    n = 110
    for k in range(n):
        a = 2 * math.pi * k / n + rng.uniform(-0.02, 0.02)
        r = 460
        curl = 0.45 * (1 if k % 2 else -1)
        p0 = (cx, cy)
        c = (cx + r * 0.45 * math.cos(a + curl), cy + r * 0.45 * math.sin(a + curl))
        p1 = (cx + r * math.cos(a), cy + r * math.sin(a))
        pts = []
        for i in range(25):
            t = i / 24
            x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t**2 * p1[0]
            y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t**2 * p1[1]
            pts.append((x, y))
        body.append(line(pts, mix("#7E9BEA", "#2257DA", rng.random()), 0.22 + 0.4 * rng.random(), 0.8))
        if k % 9 == 0:
            t = rng.uniform(0.35, 0.75)
            i = int(t * 24)
            (x0, y0), (x1, y1) = pts[i], pts[i + 1]
            ang = math.atan2(y1 - y0, x1 - x0)
            tri = [
                (x1 + 6 * math.cos(ang), y1 + 6 * math.sin(ang)),
                (x1 + 4 * math.cos(ang + 2.5), y1 + 4 * math.sin(ang + 2.5)),
                (x1 + 4 * math.cos(ang - 2.5), y1 + 4 * math.sin(ang - 2.5)),
            ]
            d = " ".join(f"{x:.1f},{y:.1f}" for x, y in tri)
            body.append(f'<polygon points="{d}" fill="#2257DA" fill-opacity="0.85" stroke="none"/>')
    defs = gradient("bg", [(0, "#F4F6FB"), (1, "#DCE4F4")]) + (
        '<radialGradient id="glow" cx="0.5" cy="0.51" r="0.25">'
        '<stop offset="0" stop-color="#FFFFFF" stop-opacity="0.95"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>'
        "</radialGradient>"
    )
    body.append(f'<rect width="{W}" height="{H}" fill="url(#glow)" stroke="none"/>')
    return doc(defs, "url(#bg)", body)


def waves() -> str:
    """Glimmer on a Jetson: a band of waves that fans out to the right."""
    body = []
    n = 64
    for k in range(n):
        u = k / (n - 1) - 0.5
        pts = []
        for i in range(0, 67):
            x = i * 10
            s = x / W
            amp = 26 + 40 * s
            y = 205 - 70 * s + amp * math.sin(x / 95 + u * 2.2) + u * (18 + 150 * s * s)
            pts.append((x, y))
        body.append(line(pts, mix("#8CA6EC", "#1E56DA", abs(u) * 2), 0.18 + 0.45 * (1 - abs(u) * 2), 0.9))
    defs = gradient("bg", [(0, "#F6F8FC"), (0.55, "#E6ECF7"), (1, "#D3DEF2")], x2="1", y2="0")
    return doc(defs, "url(#bg)", body)


def grain() -> str:
    """A faint tile of noise that gives the install card's gradient some paper texture."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">'
        '<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/>'
        '<feColorMatrix values="0 0 0 0 0.12  0 0 0 0 0.16  0 0 0 0 0.28  0 0 0 0.1 0"/></filter>'
        '<rect width="100%" height="100%" filter="url(#n)"/></svg>\n'
    )


ART = {"muse.svg": curl, "glimmer.svg": tunnel, "spark.svg": burst, "jetson.svg": waves, "grain.svg": grain}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    for name, draw in ART.items():
        path = args.out / name
        path.write_text(draw(), encoding="utf-8")
        print(
            f"wrote {path.relative_to(REPO) if path.is_relative_to(REPO) else path} ({path.stat().st_size // 1024} KB)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
