"""Render PNG previews of the assembled core into out/.

Usage: uv run python render.py   (front, side, back and exploded views)

A tiny z-buffer rasterizer keeps hidden faces hidden, which matplotlib's 3D painter
sorting does not do reliably for large flat parts.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from build123d import Pos, Shape  # noqa: E402

import core  # noqa: E402

COLORS = {
    "base": (0.33, 0.47, 0.62),
    "lid": (0.47, 0.62, 0.76),
    "port_panel": (0.88, 0.58, 0.25),
    "led_panel": (0.58, 0.45, 0.72),
    "led_clamp": (0.40, 0.30, 0.55),
    "diffuser": (0.95, 0.95, 0.90),
    "intake_duct": (0.30, 0.66, 0.46),
    "exhaust_duct": (0.82, 0.36, 0.36),
    "board": (0.25, 0.80, 0.35),
}

VIEWS = {
    "front": dict(elev=14, azim=-90, title="Front: LED panel and diffuser"),
    "side": dict(elev=14, azim=0, title="Side: intake duct below, exhaust duct on the lid"),
    "back": dict(elev=14, azim=90, title="Back: port panel for power, Ethernet and USB"),
}

EXPLODE = {
    "lid": (0, 0, 45),
    "exhaust_duct": (0, 0, 85),
    "intake_duct": (0, 0, -45),
    "port_panel": (0, 45, 0),
    "led_panel": (0, -40, 0),
    "led_clamp": (0, -22, 0),
    "diffuser": (0, -65, 0),
}


def triangles(shape: Shape, tol: float = 0.2) -> np.ndarray:
    """Return an (n, 3, 3) array of triangles for a shape."""
    verts, tris = shape.tessellate(tol, 0.2)
    v = np.array([(p.X, p.Y, p.Z) for p in verts])
    return v[np.array(tris)]


def camera(elev: float, azim: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Unit vectors (eye, right, up) for an orthographic camera, matplotlib angle convention."""
    e, a = np.radians(elev), np.radians(azim)
    eye = np.array([np.cos(e) * np.cos(a), np.cos(e) * np.sin(a), np.sin(e)])
    right = np.cross(-eye, [0.0, 0.0, 1.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, -eye)
    return eye, right, up


def rasterize(tris: np.ndarray, cols: np.ndarray, eye, right, up, size=(1200, 900), margin=30) -> np.ndarray:
    """Flat-shaded z-buffer render with dark outlines; returns an RGB image."""
    w, h = size
    sx, sy, depth = tris @ right, tris @ up, tris @ eye
    lo_x, hi_x, lo_y, hi_y = sx.min(), sx.max(), sy.min(), sy.max()
    scale = min((w - 2 * margin) / (hi_x - lo_x), (h - 2 * margin) / (hi_y - lo_y))
    px = (w - (hi_x - lo_x) * scale) / 2 + (sx - lo_x) * scale
    py = h - ((h - (hi_y - lo_y) * scale) / 2 + (sy - lo_y) * scale)
    img = np.ones((h, w, 3))
    zbuf = np.full((h, w), -np.inf)
    for i in range(len(tris)):
        x, y, z = px[i], py[i], depth[i]
        x0, x1 = max(int(np.floor(x.min())), 0), min(int(np.ceil(x.max())), w - 1)
        y0, y1 = max(int(np.floor(y.min())), 0), min(int(np.ceil(y.max())), h - 1)
        if x1 < x0 or y1 < y0:
            continue
        den = (y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2])
        if abs(den) < 1e-9:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        a = ((y[1] - y[2]) * (gx - x[2]) + (x[2] - x[1]) * (gy - y[2])) / den
        b = ((y[2] - y[0]) * (gx - x[2]) + (x[0] - x[2]) * (gy - y[2])) / den
        c = 1 - a - b
        inside = (a >= -1e-6) & (b >= -1e-6) & (c >= -1e-6)
        zz = a * z[0] + b * z[1] + c * z[2]
        zb = zbuf[y0 : y1 + 1, x0 : x1 + 1]
        hit = inside & (zz > zb)
        zb[hit] = zz[hit]
        img[y0 : y1 + 1, x0 : x1 + 1][hit] = cols[i]
    # Outlines where depth jumps or shading changes.
    filled = np.isfinite(zbuf)
    z = np.where(filled, zbuf, zbuf[filled].min() - 50)
    lum = img.mean(axis=2)
    edge = np.zeros_like(filled)
    for axis in (0, 1):
        dz = np.abs(np.diff(z, axis=axis)) > 1.5
        dl = np.abs(np.diff(lum, axis=axis)) > 0.06
        e = dz | dl
        if axis == 0:
            edge[1:, :] |= e
        else:
            edge[:, 1:] |= e
    img[edge] *= 0.35
    return img


def draw(shapes: dict[str, Shape], view: dict, path: Path) -> None:
    eye, right, up = camera(view["elev"], view["azim"])
    light = eye + 0.6 * up + 0.3 * right
    light /= np.linalg.norm(light)
    all_tris, all_cols = [], []
    for name, shape in shapes.items():
        tris = triangles(shape)
        n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
        n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
        k = 0.35 + 0.65 * np.abs(n @ light)
        all_tris.append(tris)
        all_cols.append(np.clip(np.outer(k, COLORS.get(name, (0.6, 0.6, 0.6))), 0, 1))
    img = rasterize(np.concatenate(all_tris), np.concatenate(all_cols), eye, right, up)
    fig = plt.figure(figsize=(8, 6.6), dpi=150)
    ax = fig.add_axes((0, 0, 1, 0.94))
    ax.imshow(img, interpolation="antialiased")
    ax.set_axis_off()
    fig.suptitle(view["title"], fontsize=12, y=0.985)
    fig.savefig(path, facecolor="white")
    plt.close(fig)


def main(out_dir: Path = core.OUT_DIR) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    parts = core.build_all()
    placed = core.assembly(parts)
    written = []
    for name, view in VIEWS.items():
        path = out_dir / f"preview_{name}.png"
        draw(placed, view, path)
        written.append(path)
    exploded = {k: Pos(*EXPLODE.get(k, (0, 0, 0))) * v for k, v in placed.items()}
    exploded["board"] = core.board_keepout()
    path = out_dir / "preview_exploded.png"
    draw(exploded, dict(elev=24, azim=-55, title="Exploded view (green block: board keep-out)"), path)
    written.append(path)
    return written


if __name__ == "__main__":
    for p in main():
        print(p)
