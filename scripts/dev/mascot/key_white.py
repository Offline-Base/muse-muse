"""Cuts Muse out of a clip shot on plain white (the agent clips: agents.sh), so he stands on the real page.

python3 key_white.py <frames in dir (PNG)> <frames out dir (RGBA PNG)>

Measured on the owner's three agent clips (Nov 2): the background is white (min channel 240 to 255, neutral: red minus
blue 0 to 6), with a faint grey floor shadow under the feet (about 245). Muse's fur is warm (red minus blue about 20 to
30) and his face, pads and mouth are warmer still, so a pixel that is bright and neutral is background.

- Background = bright neutral areas that touch the frame's edge, plus enclosed ones as bright as open background (the gap
  between an arm and the body). Fur highlights are warm, so they never count.
- The edge is feathered over about 2 px and the white mixed into it is taken back out, so no light fringe shows on dark.
- The floor shadow (the bottom quarter of the frame, just around his feet) becomes a faint black shadow, so it sits on
  light and dark pages.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)


def background(m, warm):
    cand = (m >= 236) & (np.abs(warm) < 10)
    cand = ndimage.binary_opening(cand, structure=np.ones((3, 3)), border_value=1)
    lab, n = ndimage.label(cand)
    if not n:
        return cand
    idx = np.arange(1, n + 1)
    sizes = ndimage.sum(cand, lab, index=idx)
    bright = ndimage.mean(m, lab, index=idx)
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    keep = np.zeros(n + 1, bool)
    for i, (size, mean) in enumerate(zip(sizes, bright), start=1):
        keep[i] = i in edge or (size >= 150 and mean >= 248)
    bg = keep[lab]
    # Small dark specks inside the background (video noise) close up; Muse himself is one big solid shape.
    fig = ~bg
    lab, n = ndimage.label(fig)
    if n:
        sizes = ndimage.sum(fig, lab, index=np.arange(1, n + 1))
        big = np.zeros(n + 1, bool)
        big[1:] = sizes >= 400
        fig = big[lab]
    return ~fig


for p in sorted(src.glob("*.png")):
    a = np.asarray(Image.open(p).convert("RGB")).astype(np.float32)
    m = a.min(axis=2)
    warm = a[..., 0] - a[..., 2]
    bg = background(m, warm)
    soft = ndimage.gaussian_filter(bg.astype(np.float32), 1.2)
    alpha = np.clip((1.0 - soft) * 255, 0, 255)
    # The floor shadow: background in the bottom quarter darker than open white, as black at up to about 35%.
    rows = np.arange(a.shape[0])[:, None]
    cols = np.arange(a.shape[1])[None, :]
    # Only right around his feet: one frame of a generated clip can be tinted, and a wide shadow would flicker there.
    ys, xs = np.where(~bg)
    near_feet = (rows >= a.shape[0] * 0.75) & (rows <= ys.max() + 60) & (cols >= xs.min() - 30) & (cols <= xs.max() + 30)
    floor = bg & (soft > 0.97) & near_feet
    shadow_a = np.clip((251 - m) * 9, 0, 90)
    shadow_a = np.where(shadow_a < 12, 0, shadow_a)  # video noise in open white stays clear
    alpha = np.where(floor, shadow_a, alpha)
    rgb = np.where(floor[..., None], 0, a)
    # Take the white back out of the feathered edge.
    af = (alpha / 255.0)[..., None]
    edge = (af > 0.02) & (af < 0.98) & ~floor[..., None]
    rgb = np.where(edge, (rgb - (1.0 - af) * 255.0) / np.maximum(af, 0.02), rgb)
    rgba = np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), alpha.astype(np.uint8)])
    Image.fromarray(rgba, "RGBA").save(dst / p.name)
print("keyed", len(list(dst.glob("*.png"))), "frames")
