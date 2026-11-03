"""Builds one tune run's training data and test sets on the board (worker.py runs it with the venv's python).

  build_sets.py --claim <run>/claim.json --run-dir <run> [--inputs <run>/inputs.json] [--empty-negatives]

builtin-muse (the Muse mascot):
  test sets: the Nov 3 sets as they are (/opt/sam3train/runs/nov3-distract): A, 30 COCO val2017 teddy-bear photos with no
  Muse; B, the same 30 with one held-out Muse pasted in, its box the only positive. Same photos as the pasted table.
  training: the 160 Muse training images (/opt/sam3train/data/muse-coco/train), plus look-alike negatives that work
  whatever Meta's loader does with images that have no boxes: a training Muse cut out by its own mask and pasted on a
  COCO teddy-bear photo, the bears left unlabeled. The bears come only from val2017 teddy photos outside the 30 test
  photos, under licenses 4, 5, 7 and 8 (fetch_coco_bears.py puts them on the board once), and the seed is fixed. Muse
  Image look-alikes in the claim (split "train", kept) get a training Muse pasted in the same way.
uploads (the person's own object):
  H, the held photos with their boxes; A, the held look-alikes as they are; B, each held look-alike with a held photo's
  object pasted in (a box cutout with soft edges, since uploads carry boxes, not masks). Training: the training photos
  and the training look-alikes with a training cutout pasted in.
--empty-negatives also adds the bear photos (or look-alikes) as images with no boxes. Leave it off unless the pinned
loader is known to keep such images (U5's check).

Writes <run>/data/samtune/{train,test}/_annotations.coco.json (the trainer's layout; the category is the run's word) and
<run>/sets.json (the test sets score_sets.py and sbs_draw.py read). Prints "SETS {...}" with the counts.
Offline Base, Nov 2026.
"""
import argparse
import json
import os
import random
import sys

import numpy as np
from PIL import Image, ImageFilter
from pycocotools import mask as mu

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tunelib as T  # noqa: E402

NOV3 = "/opt/sam3train/runs/nov3-distract"
MUSE = "/opt/sam3train/data/muse-coco"
BEARS = "/opt/sam3train/samtune/coco_bears"


def rle_of(seg, h, w):
    if isinstance(seg, list):
        return mu.merge(mu.frPyObjects(seg, h, w))
    if isinstance(seg.get("counts"), list):
        return mu.frPyObjects(seg, h, w)
    return seg


def rle_json(mask):
    r = mu.encode(np.asfortranarray(mask.astype(np.uint8)))
    return {"size": list(r["size"]), "counts": r["counts"].decode("ascii")}


class Coco:
    """One split in the trainer's layout: images beside _annotations.coco.json."""

    def __init__(self, folder, word):
        self.folder, self.word = folder, word
        os.makedirs(folder, exist_ok=True)
        self.d = {"images": [], "annotations": [], "categories": [{"id": 1, "name": word, "supercategory": word}]}

    def add(self, name, w, h, anns, src=None, im=None):
        iid = len(self.d["images"]) + 1
        path = os.path.join(self.folder, name)
        if src:
            if not os.path.exists(path):
                os.symlink(os.path.abspath(src), path)
        else:
            im.save(path, quality=92)
        self.d["images"].append({"id": iid, "file_name": name, "width": w, "height": h})
        for box, seg in anns:
            self.d["annotations"].append({"id": len(self.d["annotations"]) + 1, "image_id": iid, "category_id": 1,
                                          "bbox": [float(v) for v in box], "area": float(box[2] * box[3]),
                                          "iscrowd": 0, "segmentation": seg})
        return iid

    def write(self):
        json.dump(self.d, open(os.path.join(self.folder, "_annotations.coco.json"), "w"))
        return len(self.d["images"]), len(self.d["annotations"])


def muse_cutouts(split):
    """[(crop RGB, mask L, source file)] for every Muse in muse-coco/<split>, each cut out by its own mask."""
    gt = json.load(open(f"{MUSE}/{split}/_annotations.coco.json"))
    imgs = {i["id"]: i for i in gt["images"]}
    out = []
    for a in sorted(gt["annotations"], key=lambda a: (a["image_id"], a["id"])):
        meta = imgs[a["image_id"]]
        src = Image.open(f"{MUSE}/{split}/{meta['file_name']}").convert("RGB")
        x, y, bw, bh = [int(round(v)) for v in a["bbox"]]
        if bw < 8 or bh < 8:
            continue
        if a.get("segmentation"):
            m = mu.decode(rle_of(a["segmentation"], src.height, src.width)).astype(np.uint8) * 255
            mask = Image.fromarray(m)
        else:
            mask = Image.new("L", src.size, 255)
        out.append((src.crop((x, y, x + bw, y + bh)), mask.crop((x, y, x + bw, y + bh)), meta["file_name"]))
    return out


def box_cutout(path, box):
    """A box cutout of the person's object with soft edges (an ellipse feathered by 3 px), for uploads."""
    src = Image.open(path).convert("RGB")
    x, y, bw, bh = [int(round(v)) for v in box]
    crop = src.crop((x, y, x + bw, y + bh))
    m = Image.new("L", crop.size, 0)
    from PIL import ImageDraw
    ImageDraw.Draw(m).ellipse([1, 1, crop.width - 2, crop.height - 2], fill=255)
    return crop, m.filter(ImageFilter.GaussianBlur(3))


def paste(bg, cut, avoid, rng):
    """bg with the cutout pasted at the median avoid box's height (or a quarter of the photo), touching none of them.
    Returns (image, xywh box, mask RLE) or None when there is no room."""
    crop, mask = cut[0], cut[1]
    target = T.paste_height([b[3] for b in avoid], bg.height)
    box, _ = T.place_box(rng, bg.width, bg.height, crop.width, crop.height, avoid, target)
    if not box:
        return None
    out = bg.copy()
    m = mask.resize((box[2], box[3]))
    out.paste(crop.resize((box[2], box[3])), (box[0], box[1]), m)
    full = np.zeros((bg.height, bg.width), dtype=np.uint8)
    full[box[1]:box[1] + box[3], box[0]:box[0] + box[2]] = (np.asarray(m) > 127)
    return out, box, rle_json(full)


def bear_photos(test_ids):
    """Training bears: val2017 teddy photos on the board (fetch_coco_bears.py), outside the test photos, licenses 4, 5,
    7 and 8, no crowd boxes. [(path, bear boxes, coco id)]"""
    man = os.path.join(BEARS, "bears.json")
    if not os.path.exists(man):
        return []
    out = []
    for r in json.load(open(man))["images"]:
        if r["coco_id"] in test_ids or r["license_id"] not in T.TRAIN_LICENSE_IDS or r.get("crowd"):
            continue
        p = os.path.join(BEARS, r["file"])
        if os.path.exists(p):
            out.append((p, r["bears"], r["coco_id"]))
    return sorted(out, key=lambda t: t[2])


def build_builtin(claim, run, inputs, empty_neg, per_photo):
    word, seed = claim["word"], int(claim["seed"])
    rng = random.Random(seed)
    sets = json.load(open(f"{NOV3}/sets.json"))["images"]
    test_ids = {r["coco_id"] for r in sets}
    ev = {"A": [], "B": []}
    for r in sets:
        common = {"source": "coco", "license": r.get("license"), "flickr_url": r.get("flickr_url"), "coco_url": r.get("coco_url"),
                  "coco_id": r["coco_id"], "word": word, "others": r["bears"], "w": r["width"], "h": r["height"]}
        ev["A"].append({"id": f"A-{r['coco_id']}", "file": f"{NOV3}/A/{r['file']}", **common})
        ev["B"].append({"id": f"B-{r['coco_id']}", "file": f"{NOV3}/B/{r['file']}", "x": r["muse_box"], **common})

    root = f"{run}/data/samtune"
    tr = Coco(f"{root}/train", word)
    g = json.load(open(f"{MUSE}/train/_annotations.coco.json"))
    by = {}
    for a in g["annotations"]:
        by.setdefault(a["image_id"], []).append(a)
    for im in sorted(g["images"], key=lambda i: i["id"]):
        anns = [(a["bbox"], a.get("segmentation") or []) for a in by.get(im["id"], [])]
        tr.add(f"m_{im['file_name']}", im["width"], im["height"], anns, src=f"{MUSE}/train/{im['file_name']}")
    cuts = muse_cutouts("train")
    order = T.seeded_order(list(range(len(cuts))), seed)
    k = 0
    bears = bear_photos(test_ids)
    comp = empties = 0
    for p, boxes, cid in bears:
        bg = Image.open(p).convert("RGB")
        for j in range(per_photo):
            got = paste(bg, cuts[order[k % len(order)]], boxes, rng)
            k += 1
            if got:
                im, box, seg = got
                tr.add(f"bear{cid}_{j}.jpg", im.width, im.height, [(box, seg)], im=im)
                comp += 1
        if empty_neg:
            tr.add(f"bear{cid}_empty.jpg", bg.width, bg.height, [], src=p)
            empties += 1
    looks = 0
    for d in inputs.get("distractors", []):
        if d["split"] != "train":
            continue
        bg = Image.open(d["path"]).convert("RGB")
        got = paste(bg, cuts[order[k % len(order)]], [], rng)
        k += 1
        if got:
            im, box, seg = got
            tr.add(f"look{d['i']}.jpg", im.width, im.height, [(box, seg)], im=im)
            looks += 1
    n_train, n_ann = tr.write()

    te = Coco(f"{root}/test", word)
    gt = json.load(open(f"{MUSE}/test/_annotations.coco.json"))
    byt = {}
    for a in gt["annotations"]:
        byt.setdefault(a["image_id"], []).append(a)
    for im in sorted(gt["images"], key=lambda i: i["id"]):
        te.add(im["file_name"], im["width"], im["height"],
               [(a["bbox"], a.get("segmentation") or []) for a in byt.get(im["id"], [])],
               src=f"{MUSE}/test/{im['file_name']}")
    te.write()
    counts = {"train_images": n_train, "train_boxes": n_ann, "bear_photos": len(bears), "bear_composites": comp,
              "empty_negatives": empties, "lookalike_composites": looks, "A": len(ev["A"]), "B": len(ev["B"])}
    return ev, "nov3", counts


def build_uploads(claim, run, inputs, empty_neg, per_photo):
    word, seed = claim["word"], int(claim["seed"])
    rng = random.Random(seed)
    photos = [p for p in inputs.get("photos", []) if not p.get("skipped") and p.get("box")]
    looks = inputs.get("distractors", [])
    train_p = [p for p in photos if p["split"] == "train"]
    held_p = [p for p in photos if p["split"] == "held"]
    train_d = [d for d in looks if d["split"] == "train"]
    held_d = [d for d in looks if d["split"] == "held"]
    if len(train_p) < 4 or len(held_p) < 1 or len(held_d) < 1:
        raise SystemExit(f"not enough photos: {len(train_p)} training, {len(held_p)} held, {len(held_d)} held look-alikes")
    root = f"{run}/data/samtune"
    tr = Coco(f"{root}/train", word)
    for p in train_p:
        im = Image.open(p["path"])
        x, y, w, h = p["box"]
        tr.add(f"p{p['i']}.jpg", im.width, im.height, [(p["box"], [[x, y, x + w, y, x + w, y + h, x, y + h]])],
               src=p["path"])
    tcuts = [box_cutout(p["path"], p["box"]) for p in train_p]
    k = 0
    comp = 0
    for d in train_d:
        bg = Image.open(d["path"]).convert("RGB")
        for j in range(per_photo):
            got = paste(bg, tcuts[k % len(tcuts)], [], rng)
            k += 1
            if got:
                im, box, seg = got
                tr.add(f"look{d['i']}_{j}.jpg", im.width, im.height, [(box, seg)], im=im)
                comp += 1
        if empty_neg:
            tr.add(f"look{d['i']}_empty.jpg", bg.width, bg.height, [], src=d["path"])
    n_train, n_ann = tr.write()
    te = Coco(f"{root}/test", word)
    ev = {"H": [], "A": [], "B": []}
    for p in held_p:
        im = Image.open(p["path"])
        x, y, w, h = p["box"]
        te.add(f"h{p['i']}.jpg", im.width, im.height, [(p["box"], [[x, y, x + w, y, x + w, y + h, x, y + h]])],
               src=p["path"])
        ev["H"].append({"id": f"H-{p['i']}", "file": p["path"], "gt": [p["box"]], "license": None, "w": im.width,
                        "h": im.height})
    te.write()
    hcuts = [box_cutout(p["path"], p["box"]) for p in held_p]
    os.makedirs(f"{run}/eval/B", exist_ok=True)
    for n, d in enumerate(held_d):
        bg = Image.open(d["path"]).convert("RGB")
        ev["A"].append({"id": f"A-{d['i']}", "file": d["path"], "license": None, "word": word, "others": [],
                        "w": bg.width, "h": bg.height})
        got = paste(bg, hcuts[n % len(hcuts)], [], rng)
        if got:
            im, box, _ = got
            path = f"{run}/eval/B/b{d['i']}.jpg"
            im.save(path, quality=92)
            ev["B"].append({"id": f"B-{d['i']}", "file": path, "x": box, "license": None, "word": word, "others": [],
                            "w": im.width, "h": im.height})
    counts = {"train_images": n_train, "train_boxes": n_ann, "lookalike_composites": comp, "H": len(ev["H"]),
              "A": len(ev["A"]), "B": len(ev["B"])}
    return ev, "run", counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--claim", required=True)
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--inputs", default=None)
    ap.add_argument("--empty-negatives", action="store_true")
    ap.add_argument("--per-photo", type=int, default=2)
    a = ap.parse_args()
    claim = json.load(open(a.claim))
    for problem in (T.word_problem(claim["word"]), T.generic_problem(claim["generic"])):
        if problem:
            raise SystemExit(problem)
    inputs = json.load(open(a.inputs)) if a.inputs else {}
    fn = build_builtin if claim["data"] == "builtin-muse" else build_uploads
    ev, source, counts = fn(claim, a.run_dir, inputs, a.empty_negatives, max(1, min(4, a.per_photo)))
    json.dump({"word": claim["word"], "generic": claim["generic"], "source": source, "sets": ev, "counts": counts},
              open(f"{a.run_dir}/sets.json", "w"), indent=1)
    print("SETS", json.dumps(counts), flush=True)


if __name__ == "__main__":
    main()
