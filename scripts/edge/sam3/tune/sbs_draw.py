"""Side-by-side pictures for one tune run's report: Meta's SAM 3.1 asked the everyday word on the left, the tuned
detector asked the run's word on the right, tinted masks and scores of every box at 0.5 or more, on the same test photo.

  sbs_draw.py --sets <run>/sets.json --meta <run>/meta.json --tune <run>/tune.json \
      --masks-meta <run>/masks_meta.json --masks-tune <run>/masks_tune.json --out-dir <run>/sbs

Picks up to three photos by tunelib.pick_images (tuned_top, generic_top, tuned_false_fire), on showable photos only:
a COCO photo only under CC BY or CC BY-SA, with its credit line drawn in; the person's own and Muse Image photos always.
Each JPEG is kept under 380 KB (the upload cap is 400 KB). Writes <out-dir>/picks.json. Offline Base, Nov 2026.
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from pycocotools import mask as mu

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tunelib as T  # noqa: E402

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
LEFT, RIGHT = (255, 99, 71), (8, 102, 255)
MAX_BYTES = 380_000


def font(size, bold=True):
    p = FONT if bold else FONT.replace("-Bold", "")
    return ImageFont.truetype(p, size) if os.path.exists(p) else ImageFont.load_default()


def panel(path, masks, color):
    im = Image.open(path).convert("RGB")
    base = np.asarray(im).astype(np.float32)
    for m in masks:
        mm = mu.decode(m["rle"]).astype(bool)
        if mm.shape == base.shape[:2]:
            base[mm] = base[mm] * 0.5 + np.array(color, dtype=np.float32) * 0.5
    out = Image.fromarray(base.clip(0, 255).astype(np.uint8))
    d = ImageDraw.Draw(out)
    w = max(2, out.width // 250)
    f = font(max(14, out.width // 40))
    for m in masks:
        x, y, bw, bh = m["box"]
        d.rectangle([x, y, x + bw, y + bh], outline=color, width=w)
        t = f"{m['score']:.2f}"
        tw = d.textlength(t, font=f)
        ty = y - f.size - 6 if y > f.size + 6 else y + 2
        d.rectangle([x, ty, x + tw + 8, ty + f.size + 5], fill=color)
        d.text((x + 4, ty + 1), t, fill="white", font=f)
    return out


def draw(item, left, right, word, generic, credit, path):
    H = 480
    a, b = (panel(item["file"], left, LEFT), panel(item["file"], right, RIGHT))
    a, b = (p.resize((max(1, int(p.width * H / p.height)), H)) for p in (a, b))
    W = a.width + b.width + 12
    out = Image.new("RGB", (W, H + 50 + 30), (255, 255, 255))
    d = ImageDraw.Draw(out)
    big, small = font(20), font(14, bold=False)
    d.text((8, 14), f'Meta SAM 3.1, asked "{generic}": {len(left)} found', fill=(28, 43, 51), font=big)
    d.text((a.width + 20, 14), f'Tuned on a Jetson, asked "{word}": {len(right)} found', fill=(28, 43, 51), font=big)
    out.paste(a, (0, 50))
    out.paste(b, (a.width + 12, 50))
    if credit:
        d.text((8, H + 58), credit[:160], fill=(101, 103, 107), font=small)
    q = 85
    while True:
        out.save(path, quality=q)
        if os.path.getsize(path) < MAX_BYTES or q <= 45:
            break
        q -= 10
    if os.path.getsize(path) >= MAX_BYTES:
        os.remove(path)
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    for k in ("--sets", "--meta", "--tune", "--masks-meta", "--masks-tune", "--out-dir"):
        ap.add_argument(k, required=True)
    a = ap.parse_args()
    doc = json.load(open(a.sets))
    meta, tune = json.load(open(a.meta)), json.load(open(a.tune))
    mm, mt = json.load(open(a.masks_meta)), json.load(open(a.masks_tune))
    word, generic = doc["word"], doc["generic"]
    items = {k: {i["id"]: i for i in doc["sets"].get(k, [])} for k in ("A", "B")}
    rt, rg = tune["rows"]["tuned_word"], meta["rows"]["meta_generic"]
    picks = T.pick_images({i: rt[i] for i in items["B"]}, {i: rg[i] for i in items["B"]},
                          {i: rt[i] for i in items["A"]}, items["B"], items["A"])
    os.makedirs(a.out_dir, exist_ok=True)
    out = []
    for n, (rule, set_name, iid) in enumerate(picks, 1):
        it = items[set_name][iid]
        credit = T.credit_for(it, pasted=set_name == "B")
        name = f"sbs{n}.jpg"
        left = mm.get("meta_generic", {}).get(iid, [])
        right = mt.get("tuned_word", {}).get(iid, [])
        if draw(it, left, right, word, generic, credit, os.path.join(a.out_dir, name)):
            out.append({"file": name, "rule": rule, "image": iid, "credit": credit, "license": T.short_license(it.get("license"))})
    json.dump(out, open(os.path.join(a.out_dir, "picks.json"), "w"), indent=1)
    print("PICKS", json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
