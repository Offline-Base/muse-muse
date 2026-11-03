"""Cuts the white stage out of an intro clip, so the real page shows where the stage was.

python3 key_stage.py <frames in dir (PNG)> <frames out dir (RGBA PNG)> <open start frame> <open end frame> [profile]

Profiles, one per clip (each measured from its own frames):
- "warm" (the cream-curtain sunglasses clip, intro-shades): the curtain (red minus blue about 16) and the fur (20 to
  30) are warm; the stage is bright and neutral. Stage = min channel above 212 and red minus blue under 9.
- "shirt" (the Offline Base T-shirt clip, intro-shirt): the curtain is cool and pale (min channel 194 to 224, blue minus
  red 4 to 11), Muse wears a white shirt (mostly 217 to 235, neutral), the stage is brighter still (238 to 252,
  neutral). Stage = min channel above 238 and neutral. Bright patches of shirt can pass that, so a stage area away from
  the frame's edges counts only if it is as bright as open stage (mean above 244): that keeps the shirt and still cuts
  the gap between an arm and the body.

Both: the mask is cleaned by shape (specks dropped, holes filled, small areas kept solid), feathered over a few pixels,
and the white mixed into the feathered edge is taken back out, so no light fringe shows on dark. Image borders count as
stage, so no thin white line is left at the frame's edges. Frames stay solid until the curtain parts and the stage
dissolves while it opens, so the thin white floor under the closed curtain never opens early. The floor shadow at
Muse's feet becomes a faint real shadow on the page. Run by intro.sh.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
OPEN_START, OPEN_END = int(sys.argv[3]), int(sys.argv[4])
PROFILE = sys.argv[5] if len(sys.argv) > 5 else "warm"
assert PROFILE in ("warm", "shirt"), PROFILE
dst.mkdir(parents=True, exist_ok=True)
MIN_AREA = 2500  # px at 1280x720 ("warm"): anything smaller is a highlight on the curtain or fur, not stage


def stage_warm(m, warm):
    stage = (m > 212) & (warm < 9)
    stage = ndimage.binary_opening(stage, structure=np.ones((5, 5)), border_value=1)
    stage = ndimage.binary_closing(stage, structure=np.ones((7, 7)), border_value=1)
    lab, n = ndimage.label(stage)
    if n:
        sizes = ndimage.sum(stage, lab, index=np.arange(1, n + 1))
        keep = np.zeros(n + 1, bool)
        keep[1:] = sizes >= MIN_AREA
        stage = keep[lab]
    return stage


def stage_shirt(m, warm):
    rows = np.arange(m.shape[0])[:, None]
    # Bright stage anywhere; in the floor strip (see floor_shadow) the floor's brightest part too.
    stage = ((m > 238) & (np.abs(warm) < 6)) | ((rows >= m.shape[0] * 0.82) & (m >= 240) & (np.abs(warm) < 4))
    stage = ndimage.binary_opening(stage, structure=np.ones((3, 3)), border_value=1)
    stage = ndimage.binary_closing(stage, structure=np.ones((5, 5)), border_value=1)
    lab, n = ndimage.label(stage)
    if n:
        idx = np.arange(1, n + 1)
        sizes = ndimage.sum(stage, lab, index=idx)
        bright = ndimage.mean(m, lab, index=idx)
        edge_labels = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
        keep = np.zeros(n + 1, bool)
        for i, (size, mean) in enumerate(zip(sizes, bright), start=1):
            keep[i] = (i in edge_labels and size >= 400) or (size >= 300 and mean >= 244)
        stage = keep[lab]
    return stage


def floor_shadow(a, m, warm, stage):
    """Shadow pixels. "warm": neutral mid grey next to the stage in the lower third. "shirt": the floor strip only, which
    lies below the shirt, so the white shirt can never be taken for shadow."""
    near = ndimage.binary_dilation(stage, iterations=12)
    rows = np.arange(a.shape[0])[:, None]
    neutral = (np.abs(warm) < 9) & (m > 150)
    if PROFILE == "warm":
        return near & (rows > a.shape[0] * 0.66) & ~stage & neutral & (m <= 212)
    # The floor strip (bottom 18% of the frame, below the shirt's lowest point in this clip): every exactly neutral
    # pixel there is floor (the curtain is a little blue, blue minus red 4 or more, so its hems stay). The brightest
    # floor already counts as stage; the rest is shadow.
    # Slightly warm floor (his fur reflects on it, red minus blue up to about 10) is floor too; fur itself is warmer.
    # Every floor pixel, the bright ones included: on the floor there is no edge to feather, only shadow and no shadow.
    return (rows >= a.shape[0] * 0.82) & (warm > -4) & (warm < 12) & (m > 150)


for p in sorted(src.glob("*.png")):
    a = np.asarray(Image.open(p).convert("RGB")).astype(np.int16)
    orig = a.copy()
    m = a.min(axis=2)
    warm = a[..., 0] - a[..., 2]
    stage = stage_warm(m, warm) if PROFILE == "warm" else stage_shirt(m, warm)
    # Feathered edge: alpha falls from 255 to 0 across about 5 px into the stage.
    soft = ndimage.gaussian_filter(stage.astype(np.float32), 2.0)
    alpha = np.clip((1.0 - soft) * 255, 0, 255)
    n_frame = int(p.stem)
    solid = 1.0 - min(1.0, max(0.0, (n_frame - OPEN_START) / (OPEN_END - OPEN_START)))
    # The floor shadow becomes a faint real shadow on the page: black at up to about 40%, not a light-grey patch.
    shadow = floor_shadow(a, m, warm, stage)
    top = 236 if PROFILE == "warm" else 246
    shadow_a = np.clip((top - m) * 4, 0, 110).astype(np.float32)
    # "warm": shadow only darkens what the stage mask left. "shirt": the floor strip is set by its own darkness alone
    # (bright floor clear, shadow faint black), so the stage mask's feathered edge leaves no grey lines on the floor.
    alpha = np.where(shadow, np.minimum(alpha, shadow_a) if PROFILE == "warm" else shadow_a, alpha)
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
print("keyed", len(list(dst.glob("*.png"))), "frames, profile", PROFILE)
