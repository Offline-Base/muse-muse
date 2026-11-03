"""Builds the distractor sets. A: 30 COCO val2017 teddy-bear photos as they are. B: the same 30 photos, each with one
held-out Muse (cut out by its own mask) pasted at about the median teddy bear's height, touching no bear box; the pasted
box is the only positive. Offline Base, Nov 3 2026."""
import json, random, statistics, urllib.request
import numpy as np
from PIL import Image
from pycocotools import mask as mu
D = "/opt/sam3train/data/muse-coco/test"
T = json.load(open("coco/teddy_val2017.json"))
lic = {l["id"]: l for l in T["licenses"]}
by = {}
for a in T["annotations"]:
    by.setdefault(a["image_id"], []).append(a)
pick = []
for im in sorted(T["images"], key=lambda i: i["id"]):
    an = by[im["id"]]
    if any(a["iscrowd"] for a in an):
        continue
    A = im["width"] * im["height"]
    big = max(a["area"] for a in an) / A
    tot = sum(a["bbox"][2] * a["bbox"][3] for a in an) / A
    if 0.01 <= big <= 0.4 and tot <= 0.6:
        pick.append(im)
pick = pick[:30]
gt = json.load(open(f"{D}/_annotations.coco.json"))
imgs = {i["id"]: i for i in gt["images"]}
mus = [a for a in sorted(gt["annotations"], key=lambda a: a["image_id"])]
rng = random.Random(20261103)
rows = []
def overlaps(b, boxes, pad=4):
    x, y, w, h = b
    return any(x < bx + bw + pad and bx - pad < x + w and y < by_ + bh + pad and by_ - pad < y + h for bx, by_, bw, bh in boxes)
for k, im in enumerate(pick):
    fn = f"{im['id']:012d}.jpg"
    raw = urllib.request.urlopen(im["coco_url"], timeout=60).read()
    open(f"A/{fn}", "wb").write(raw)
    bg = Image.open(f"A/{fn}").convert("RGB")
    bears = [a["bbox"] for a in by[im["id"]]]
    a = mus[k]
    src = Image.open(f"{D}/{imgs[a['image_id']]['file_name']}").convert("RGB")
    seg = a["segmentation"]; h0, w0 = src.height, src.width
    rle = mu.merge(mu.frPyObjects(seg, h0, w0)) if isinstance(seg, list) else (mu.frPyObjects(seg, h0, w0) if isinstance(seg.get("counts"), list) else seg)
    m = mu.decode(rle).astype(np.uint8) * 255
    x, y, bw, bh = [int(round(v)) for v in a["bbox"]]
    crop = src.crop((x, y, x + bw, y + bh)); mcrop = Image.fromarray(m).crop((x, y, x + bw, y + bh))
    ht = statistics.median(b[3] for b in bears)
    ht = min(max(ht, 0.12 * bg.height), 0.45 * bg.height)
    s = ht / bh
    box = None
    for shrink in range(8):
        nw, nh = max(8, int(bw * s)), max(8, int(bh * s))
        if nw < bg.width and nh < bg.height:
            for _ in range(600):
                px, py = rng.randint(0, bg.width - nw), rng.randint(0, bg.height - nh)
                if not overlaps((px, py, nw, nh), bears):
                    box = [px, py, nw, nh]; break
        if box: break
        s *= 0.85
    if not box:
        print("no room", fn); continue
    bg.paste(crop.resize((nw, nh)), (box[0], box[1]), mcrop.resize((nw, nh)))
    bg.save(f"B/{fn}", quality=92)
    L = lic.get(im["license"], {})
    rows.append({"file": fn, "coco_id": im["id"], "width": bg.width, "height": bg.height, "bears": bears,
                 "muse_box": box, "muse_from": imgs[a["image_id"]]["file_name"], "muse_scale": round(s, 3),
                 "median_bear_h": statistics.median(b[3] for b in bears),
                 "license": L.get("name"), "license_url": L.get("url"), "flickr_url": im.get("flickr_url"), "coco_url": im["coco_url"]})
json.dump({"source": T["source"], "made": "2026-11-03", "seed": 20261103, "images": rows}, open("sets.json", "w"), indent=1)
print("images", len(rows), "bears", sum(len(r["bears"]) for r in rows), "muse px h", sorted(r["muse_box"][3] for r in rows))
print("licenses", sorted({r["license"] for r in rows}))
