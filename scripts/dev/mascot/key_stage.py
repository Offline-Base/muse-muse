"""Cuts the white stage out of the sunglasses intro, so the real page shows where the stage was.

python3 key_stage.py <frames in dir (PNG)> <frames out dir (RGBA PNG)> [open start frame] [open end frame]

Per frame: a pixel is stage when it is bright and neutral (the curtain and Muse's fur are warm, red minus blue about
16 to 30; the stage is about 0). That alone also catches the curtain's brightest highlights, so the mask is cleaned by
shape: small stage specks are dropped (opening), small holes are filled (closing), only stage areas of real size are
kept, the edge is feathered by a couple of pixels and the white mixed into it is taken back out (no light fringe on
dark). Image borders count as stage, so no thin white line is left at the frame's edges. Before the curtain parts (frame 80 of the 6 s clip) the frame
stays solid, so the thin white floor under the closed curtain doesn't open early; it dissolves while the curtain opens
(frames 80 to 92). Run by intro.sh.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)
OPEN_START = int(sys.argv[3]) if len(sys.argv) > 3 else 80
OPEN_END = int(sys.argv[4]) if len(sys.argv) > 4 else 92
MIN_AREA = 2500  # px at 1280x720: anything smaller is a highlight on the curtain or fur, not stage

for p in sorted(src.glob("*.png")):
    a = np.asarray(Image.open(p).convert("RGB")).astype(np.int16)
    orig = a.copy()
    m = a.min(axis=2)
    warm = a[..., 0] - a[..., 2]
    stage = (m > 212) & (warm < 9)
    stage = ndimage.binary_opening(stage, structure=np.ones((5, 5)), border_value=1)
    stage = ndimage.binary_closing(stage, structure=np.ones((7, 7)), border_value=1)
    lab, n = ndimage.label(stage)
    if n:
        sizes = ndimage.sum(stage, lab, index=np.arange(1, n + 1))
        keep = np.zeros(n + 1, bool)
        keep[1:] = sizes >= MIN_AREA
        stage = keep[lab]
    # Feathered edge: alpha falls from 255 to 0 across about 5 px into the stage.
    soft = ndimage.gaussian_filter(stage.astype(np.float32), 2.0)
    alpha = np.clip((1.0 - soft) * 255, 0, 255)
    n_frame = int(p.stem)
    solid = 1.0 - min(1.0, max(0.0, (n_frame - OPEN_START) / (OPEN_END - OPEN_START)))
    # The floor shadow under Muse (neutral mid grey, low in the frame, next to the stage) becomes a faint real shadow
    # on the page: black at up to about 40% instead of a light-grey patch.
    near = ndimage.binary_dilation(stage, iterations=12)
    rows = np.arange(a.shape[0])[:, None] > a.shape[0] * 0.66
    shadow = near & rows & ~stage & (warm < 9) & (m > 150) & (m <= 212)
    shadow_a = np.clip((236 - m) * 4, 0, 110).astype(np.float32)
    alpha = np.where(shadow, np.minimum(alpha, shadow_a), alpha)
    a = np.where(shadow[..., None], 0, a)
    # Take the white back out of the feathered edge (it was mixed with the stage), so no light fringe shows on dark.
    af = (alpha / 255.0)[..., None]
    edge = (af > 0.02) & (af < 0.98) & ~shadow[..., None]
    clean = np.where(edge, (a - (1.0 - af) * 255.0) / np.maximum(af, 0.02), a)
    rgb = np.clip(clean, 0, 255)
    alpha = np.maximum(alpha, solid * 255).astype(np.uint8)
    if solid > 0:  # while the frame is (partly) solid, show it as it is
        rgb = rgb * (1 - solid) + orig * solid
    rgba = np.dstack([rgb.astype(np.uint8), alpha])
    Image.fromarray(rgba, "RGBA").save(dst / p.name)
print("keyed", len(list(dst.glob("*.png"))), "frames")
