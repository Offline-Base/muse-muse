"""Scores Meta's SAM 3.1 ("muse", "plush toy", "toy") and the tuned detector ("muse") on the distractor sets through
jetson-04's running sam3 service. The service keeps only detections at 0.5 or more (its processor's floor), so AP here
uses those. Offline Base, Nov 3 2026."""
import base64, json, statistics, sys, time, urllib.request
import numpy as np
from pycocotools import mask as mu
from pycocotools.coco import COCO
from pycocotools.cocoeval import COCOeval
URL = "http://192.168.12.144:8790/segment"
S = json.load(open("sets.json"))["images"]
CONFIGS = [("meta", "muse", "base"), ("meta", "plush toy", "base"), ("meta", "toy", "base"), ("tuned", "muse", "muse")]
def ask(path, prompt, tuned, overlay=False):
    body = {"image_b64": base64.b64encode(open(path, "rb").read()).decode(), "prompt": prompt, "threshold": 0.05, "overlay": overlay}
    if tuned != "base":
        body["tuned"] = tuned
    t = time.time()
    r = json.loads(urllib.request.urlopen(urllib.request.Request(URL, json.dumps(body).encode(), {"Content-Type": "application/json"}), timeout=120).read())
    r["wall_ms"] = int((time.time() - t) * 1000)
    if tuned != "base" and r.get("weights") != tuned:
        raise SystemExit("board answered with other weights")
    return r
def xywh(b):
    return [b[0], b[1], b[2] - b[0], b[3] - b[1]]
def iou1(a, bs):
    return list(mu.iou([a], bs, [0] * len(bs))[0]) if bs else []
def score(set_name, raw, key):
    out = {"images": len(S), "looks": 0}
    dets, gt, ms, wall = [], {"images": [], "annotations": [], "categories": [{"id": 1, "name": "muse"}]}, [], []
    found = fp = fp_bears = only = fired = boxes = 0
    bears_tot = bears_hit = 0
    for i, r in enumerate(S):
        res = raw[r["file"]]
        ms.append(res["ms"]); wall.append(res["wall_ms"])
        gt["images"].append({"id": i, "width": r["width"], "height": r["height"]})
        g = [r["muse_box"]] if set_name == "B" else []
        for a in g:
            gt["annotations"].append({"id": i + 1, "image_id": i, "category_id": 1, "bbox": a, "area": a[2] * a[3], "iscrowd": 0})
        hi = [(xywh(o["box"]), o["score"]) for o in res["objects"] if o["score"] >= 0.5]
        for o in res["objects"]:
            dets.append({"image_id": i, "category_id": 1, "bbox": xywh(o["box"]), "score": o["score"]})
        boxes += len(hi); fired += int(bool(hi))
        hit = False
        for b, s in sorted(hi, key=lambda x: -x[1]):
            if g and not hit and iou1(b, g)[0] >= 0.5:
                hit = True; continue
            fp += 1
            if any(v >= 0.5 for v in iou1(b, r["bears"])):
                fp_bears += 1
        found += int(hit); only += int(hit and len(hi) == 1)
        for bb in r["bears"]:
            bears_tot += 1
            bears_hit += int(any(v >= 0.5 for v in iou1(bb, [h[0] for h in hi])))
    out.update({"median_s_service": round(statistics.median(ms) / 1000, 2), "median_s_wall": round(statistics.median(wall) / 1000, 2),
                "images_with_a_box@0.5": fired, "boxes@0.5": boxes, "boxes_not_muse@0.5": fp, "of_those_on_coco_bears": fp_bears,
                "coco_bears_boxed@0.5": f"{bears_hit} of {bears_tot}"})
    if set_name == "B":
        cg = COCO(); cg.dataset = gt; cg.createIndex()
        if dets:
            E = COCOeval(cg, cg.loadRes(dets), "bbox"); E.evaluate(); E.accumulate(); E.summarize()
            ap, ap50 = float(E.stats[0]), float(E.stats[1])
        else:
            ap = ap50 = 0.0
        out.update({"muse_AP": round(max(ap, 0), 3), "muse_AP50": round(max(ap50, 0), 3), "muse_found@0.5": found,
                    "picked_muse_and_only_muse": only})
    return out
def main():
    raw = {}
    t0 = time.time()
    for who, prompt, tuned in CONFIGS:
        key = f"{who}:{prompt}"
        for set_name in ("A", "B"):
            raw[f"{key}|{set_name}"] = {r["file"]: ask(f"{set_name}/{r['file']}", prompt, tuned) for r in S}
            print(key, set_name, f"{time.time() - t0:.0f}s", flush=True)
    truck = {}
    for who, tuned in (("meta", "base"), ("tuned", "muse")):
        for p in ("truck", "wheel"):
            r = ask("/opt/sam3/truck.jpg", p, tuned)
            truck[f"{who}:{p}"] = {"count@0.5": sum(o["score"] >= 0.5 for o in r["objects"]), "scores": sorted((o["score"] for o in r["objects"]), reverse=True)}
    json.dump(raw, open("raw.json", "w"))
    res = {"what": "Muse among other toys: SAM 3.1 on jetson-04's sam3 service, Meta weights vs the tuned 'muse' detector",
           "date": "2026-11-03", "board": "jetson-04", "sets": {"A": "30 COCO val2017 teddy-bear photos, no Muse",
           "B": "the same 30 photos, one held-out Muse pasted in, touching no bear box; the Muse box is the only positive"},
           "note": "the service keeps only detections at 0.5 or more, so AP uses those (a lower bound on AP over 0.05)",
           "results": {}, "truck": truck, "total_s": round(time.time() - t0)}
    for who, prompt, tuned in CONFIGS:
        key = f"{who}:{prompt}"
        res["results"][key] = {s: score(s, raw[f"{key}|{s}"], key) for s in ("A", "B")}
    json.dump(res, open("scores.json", "w"), indent=1)
    print("RESULT", json.dumps(res), flush=True)
main()
