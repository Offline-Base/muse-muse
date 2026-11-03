"""Score SAM (3 or 3.1) on the held-out Muse test set, before and after a tuned delta, in one process.
Sets: 'test' (50 held-out images, 38 with Muse, 12 without) and 'small' (each held-out Muse cut out by its own mask,
shrunk to 30% and pasted on one of the 12 held-out images without Muse; plus those 12 as negatives).
Metrics: COCO box AP and AP50 (pycocotools, detections over 0.05), and at score 0.5: precision, recall, and
image-level presence accuracy. Also a forgetting check on Meta's truck.jpg. Offline Base, Nov 3 2026."""
import argparse, copy, json, random, time

import numpy as np
import torch
from PIL import Image
from pycocotools import mask as mu
from pycocotools.coco import COCO
from pycocotools.cocoeval import COCOeval
from sam3.model.sam3_image_processor import Sam3Processor
from sam3.model_builder import build_sam3_image_model

D = "/opt/sam3train/data/muse-coco/test"
TRUCK = "/opt/sam3train/sam3/assets/images/truck.jpg"


def make_sets():
    gt = json.load(open(f"{D}/_annotations.coco.json"))
    imgs = {i["id"]: i for i in gt["images"]}
    by = {}
    for a in gt["annotations"]:
        by.setdefault(a["image_id"], []).append(a)
    cat = gt["categories"][0]["id"]
    test = [(Image.open(f"{D}/{imgs[i]['file_name']}").convert("RGB"), by.get(i, [])) for i in sorted(imgs)]
    negs = [im for im, anns in test if not anns]
    rng = random.Random(20261103)
    small = []
    for k, (im, anns) in enumerate(test):
        if not anns:
            continue
        a = anns[0]
        seg = a["segmentation"]
        h, w = im.height, im.width
        if isinstance(seg, list):
            rle = mu.merge(mu.frPyObjects(seg, h, w))
        elif isinstance(seg.get("counts"), list):
            rle = mu.frPyObjects(seg, h, w)
        else:
            rle = seg
        m = mu.decode(rle).astype(np.uint8) * 255
        x, y, bw, bh = [int(round(v)) for v in a["bbox"]]
        crop = im.crop((x, y, x + bw, y + bh)); mcrop = Image.fromarray(m).crop((x, y, x + bw, y + bh))
        s = 0.3
        nw, nh = max(8, int(bw * s)), max(8, int(bh * s))
        crop = crop.resize((nw, nh)); mcrop = mcrop.resize((nw, nh))
        bg = negs[k % len(negs)].copy()
        px, py = rng.randint(0, bg.width - nw), rng.randint(0, bg.height - nh)
        bg.paste(crop, (px, py), mcrop)
        small.append((bg, [{"bbox": [px, py, nw, nh], "area": nw * nh, "category_id": cat}]))
    small += [(im, []) for im in negs]
    return {"test": test, "small": small}, cat


def run(proc, items, cat, prompt="muse"):
    gt = {"images": [], "annotations": [], "categories": [{"id": cat, "name": "muse"}]}
    dets, aid, tp, fp, fn, pres_ok, ms = [], 1, 0, 0, 0, 0, []
    for i, (im, anns) in enumerate(items):
        gt["images"].append({"id": i, "width": im.width, "height": im.height})
        for a in anns:
            gt["annotations"].append({"id": aid, "image_id": i, "category_id": cat, "bbox": a["bbox"],
                                      "area": a["bbox"][2] * a["bbox"][3], "iscrowd": 0}); aid += 1
        t = time.time()
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            st = proc.set_image(im)
            out = proc.set_text_prompt(state=st, prompt=prompt)
        ms.append((time.time() - t) * 1000)
        boxes = out["boxes"].float().cpu().numpy(); scores = out["scores"].float().cpu().numpy()
        hi = []
        for b, s in zip(boxes, scores):
            x0, y0, x1, y1 = [float(v) for v in b]
            dets.append({"image_id": i, "category_id": cat, "bbox": [x0, y0, x1 - x0, y1 - y0], "score": float(s)})
            if s >= 0.5:
                hi.append([x0, y0, x1 - x0, y1 - y0])
        g = [a["bbox"] for a in anns]
        used = set()
        for h in hi:
            ious = mu.iou([h], g, [0] * len(g))[0] if g else []
            j = int(np.argmax(ious)) if len(g) else -1
            if j >= 0 and ious[j] >= 0.5 and j not in used:
                tp += 1; used.add(j)
            else:
                fp += 1
        fn += len(g) - len(used)
        pres_ok += int(bool(hi) == bool(g))
    cg = COCO(); cg.dataset = gt; cg.createIndex()
    if dets:
        cd = cg.loadRes(dets); E = COCOeval(cg, cd, "bbox"); E.evaluate(); E.accumulate(); E.summarize()
        ap, ap50 = float(E.stats[0]), float(E.stats[1])
    else:
        ap = ap50 = 0.0
    return {"n_images": len(items), "n_muse": aid - 1, "AP": round(ap, 3), "AP50": round(ap50, 3),
            "precision@0.5": round(tp / max(1, tp + fp), 3), "recall@0.5": round(tp / max(1, tp + fn), 3),
            "tp": tp, "fp": fp, "fn": fn, "presence_acc@0.5": round(pres_ok / len(items), 3),
            "median_ms": round(float(np.median(ms)))}


def truck(proc):
    im = Image.open(TRUCK).convert("RGB"); r = {}
    for p in ["truck", "wheel"]:
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            out = proc.set_text_prompt(state=proc.set_image(im), prompt=p)
        s = sorted([round(float(x), 2) for x in out["scores"].float().cpu() if x >= 0.5], reverse=True)
        r[p] = {"count@0.5": len(s), "scores": s}
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", choices=["sam3", "sam31"], required=True)
    ap.add_argument("--delta", default=None)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    sets, cat = make_sets()
    t = time.time()
    if a.base == "sam3":
        model = build_sam3_image_model(checkpoint_path="/opt/sam3train/ckpt/sam3_detector_fp16.pt", load_from_HF=False)
    else:
        from sam31load import load_sam31
        model = build_sam3_image_model(checkpoint_path=None, load_from_HF=False)
        load_sam31(model)
    print(f"loaded {a.base} in {time.time() - t:.0f}s", flush=True)
    proc = Sam3Processor(model, confidence_threshold=0.05)
    res = {"base": a.base, "delta": a.delta, "before": {k: run(proc, v, cat) for k, v in sets.items()}}
    res["before"]["truck"] = truck(proc)
    # A fairer baseline: plain words for what Muse looks like (a small cream plush figure), which SAM already knows.
    for wp in ["plush toy", "toy"]:
        res["before"][f"test:{wp}"] = run(proc, sets["test"], cat, wp)
        res["before"][f"small:{wp}"] = run(proc, sets["small"], cat, wp)
    print(json.dumps(res["before"]), flush=True)
    if a.delta:
        from sam31load import apply_delta
        apply_delta(model, a.delta)
        res["after"] = {k: run(proc, v, cat) for k, v in sets.items()}
        res["after"]["truck"] = truck(proc)
        print(json.dumps(res["after"]), flush=True)
    res["peak_gpu_mb"] = torch.cuda.max_memory_allocated() // 2**20
    json.dump(res, open(a.out, "w"), indent=1)
    print("RESULT", json.dumps(res), flush=True)


if __name__ == "__main__":
    main()
