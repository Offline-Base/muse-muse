"""Scores one tune run's test sets on the board: evalmuse.py generalised to the report's settings and the H, A and B
sets of build_sets.py. Meta's weights load once a phase and the deltas go on top in the same process.

  score_sets.py --sets <run>/sets.json --phase meta --out <run>/meta.json --masks <run>/masks_meta.json [--cache DIR]
  score_sets.py --sets <run>/sets.json --phase tune --out <run>/tune.json --masks <run>/masks_tune.json \
      --delta <run delta> [--prior /opt/sam3train/runs/muse31/muse31_delta_fp16.pt]

meta phase: meta_word (Meta's weights asked the run's word), meta_generic (the everyday word), meta_toy ("toy"), and
Meta's truck check. With --cache and the Nov 3 sets, a second run with the same words reads the first run's answers
(Meta's weights and the photos don't change) and loads nothing.
tune phase: prior_word (the Nov 3 muse31 tune asked "muse", only when --prior is given), then the run's own delta:
tuned_word, tuned_generic, and the truck check again.
AP is pycocotools box AP over every detection from 0.05 (B against the pasted box, H against the person's boxes);
counts are at 0.5 (tunelib.py). Masks of boxes at 0.5 or more are kept for meta_generic and tuned_word only, for
sbs_draw.py; they stay on the board. Prints STAGE and LOOK lines for worker.py. Offline Base, Nov 2026.
"""
import argparse
import contextlib
import hashlib
import io
import json
import os
import sys
import time

import numpy as np
import torch
from PIL import Image
from pycocotools import mask as mu
from pycocotools.coco import COCO
from pycocotools.cocoeval import COCOeval

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tunelib as T  # noqa: E402

TRUCK = "/opt/sam3train/sam3/assets/images/truck.jpg"
MASKED = ("meta_generic", "tuned_word")


def say(*a):
    print(*a, flush=True)


def look(proc, im, prompt):
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
        st = proc.set_image(im)
        out = proc.set_text_prompt(state=st, prompt=prompt)
    boxes = out["boxes"].float().cpu().numpy()
    scores = out["scores"].float().cpu().numpy()
    dets, masks = [], []
    for i, (b, s) in enumerate(zip(boxes, scores)):
        if s < T.AP_FROM:
            continue
        x0, y0, x1, y1 = [float(v) for v in b]
        dets.append({"box": [round(x0, 1), round(y0, 1), round(x1 - x0, 1), round(y1 - y0, 1)], "score": round(float(s), 4)})
        if s >= T.HI and "masks" in out:
            m = out["masks"][i].squeeze().float().cpu().numpy() > 0.5
            r = mu.encode(np.asfortranarray(m.astype(np.uint8)))
            masks.append({"box": dets[-1]["box"], "score": dets[-1]["score"], "rle": {"size": list(r["size"]),
                          "counts": r["counts"].decode("ascii")}})
    return dets, masks


def coco_ap(items, dets_by_id, gt_key):
    gt = {"images": [], "annotations": [], "categories": [{"id": 1, "name": "x"}]}
    dets, aid = [], 1
    for n, it in enumerate(items):
        gt["images"].append({"id": n, "width": it["w"], "height": it["h"]})
        for b in (it[gt_key] if gt_key == "gt" else [it["x"]]):
            gt["annotations"].append({"id": aid, "image_id": n, "category_id": 1, "bbox": list(b),
                                      "area": b[2] * b[3], "iscrowd": 0})
            aid += 1
        dets += [{"image_id": n, "category_id": 1, "bbox": d["box"], "score": d["score"]} for d in dets_by_id[it["id"]]]
    if not dets:
        return 0.0, 0.0
    with contextlib.redirect_stdout(io.StringIO()):
        cg = COCO(); cg.dataset = gt; cg.createIndex()
        E = COCOeval(cg, cg.loadRes(dets), "bbox"); E.evaluate(); E.accumulate(); E.summarize()
    return float(E.stats[0]), float(E.stats[1])


def score_setting(proc, sets, prompt, keep_masks, done, total):
    dets, masks, rows = {}, {}, {}
    for name in ("H", "A", "B"):
        for it in sets.get(name, []):
            im = Image.open(it["file"]).convert("RGB")
            d, m = look(proc, im, prompt)
            dets[it["id"]] = d
            if keep_masks:
                masks[it["id"]] = m
            done[0] += 1
            if done[0] % 5 == 0 or done[0] == total:
                say(f"LOOK {done[0]} {total}")
    for it in sets.get("B", []):
        rows[it["id"]] = T.score_b_image(dets[it["id"]], it["x"])
    for it in sets.get("A", []):
        rows[it["id"]] = T.score_a_image(dets[it["id"]])
    for it in sets.get("H", []):
        rows[it["id"]] = T.score_h_image(dets[it["id"]], it["gt"])
    ap = {"B": coco_ap(sets.get("B", []), dets, "x")}
    if sets.get("H"):
        ap["H"] = coco_ap(sets["H"], dets, "gt")[0]
    col = T.summarize([rows[i["id"]] for i in sets.get("B", [])], [rows[i["id"]] for i in sets.get("A", [])],
                      [rows[i["id"]] for i in sets.get("H", [])], ap)
    return col, rows, dets, masks


def truck(proc):
    im = Image.open(TRUCK).convert("RGB")
    return {p: sum(1 for d in look(proc, im, p)[0] if d["score"] >= T.HI) for p in ("truck", "wheel")}


def load_meta():
    from sam3.model.sam3_image_processor import Sam3Processor
    from sam3.model_builder import build_sam3_image_model
    from sam31load import load_sam31
    model = build_sam3_image_model(checkpoint_path=None, load_from_HF=False)
    load_sam31(model)
    return model, Sam3Processor(model, confidence_threshold=T.AP_FROM)


def cache_key(doc, prompts):
    ids = [(i["id"], i.get("x")) for k in ("H", "A", "B") for i in doc["sets"].get(k, [])]
    return hashlib.sha256(json.dumps(["v1", T.AP_FROM, prompts, ids]).encode()).hexdigest()[:24]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sets", required=True)
    ap.add_argument("--phase", choices=["meta", "tune"], required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--masks", required=True)
    ap.add_argument("--delta", default=None)
    ap.add_argument("--prior", default=None)
    ap.add_argument("--cache", default=None)
    a = ap.parse_args()
    doc = json.load(open(a.sets))
    sets, word, generic = doc["sets"], doc["word"], doc["generic"]
    if a.phase == "meta":
        plan = [("meta_word", word, None), ("meta_generic", generic, None), ("meta_toy", "toy", None)]
    else:
        if not a.delta:
            raise SystemExit("--delta is needed for the tune phase")
        plan = ([("prior_word", "muse", a.prior)] if a.prior else []) + \
               [("tuned_word", word, a.delta), ("tuned_generic", generic, a.delta)]
    cpath = None
    if a.phase == "meta" and a.cache and doc["source"] == "nov3":
        os.makedirs(a.cache, exist_ok=True)
        cpath = os.path.join(a.cache, f"meta-{cache_key(doc, [p for _, p, _ in plan])}.json")
        if os.path.exists(cpath) and os.path.exists(cpath + ".masks"):
            say("STAGE scoring_meta")
            say("CACHE", cpath)
            res = json.load(open(cpath))
            res["timings"] = {"meta_cached": 1}
            json.dump(res, open(a.out, "w"))
            with open(cpath + ".masks") as f, open(a.masks, "w") as g:
                g.write(f.read())
            say("DONE", a.out)
            return
    say("STAGE loading_meta" if a.phase == "meta" else "STAGE loading_tune")
    t0 = time.time()
    model, proc = load_meta()
    timings = {f"load_{a.phase}": round(time.time() - t0)}
    say(f"loaded in {timings[f'load_{a.phase}']}s")
    say("STAGE scoring_meta" if a.phase == "meta" else "STAGE scoring_tune")
    n_items = sum(len(sets.get(k, [])) for k in ("H", "A", "B"))
    total, done = n_items * len(plan), [0]
    res = {"phase": a.phase, "settings": {}, "rows": {}, "dets": {}, "truck": {}}
    masks_out = {}
    current = None
    t1 = time.time()
    for sid, prompt, delta in plan:
        if delta and delta != current:
            from sam31load import apply_delta
            apply_delta(model, delta)  # a delta holds every detector tensor, so it replaces the one before in full
            current = delta
            if delta == a.delta:
                with open(delta, "rb") as f:
                    res["deltaSha256"] = hashlib.sha256(f.read()).hexdigest()
        col, rows, dets, masks = score_setting(proc, sets, prompt, sid in MASKED, done, total)
        res["settings"][sid], res["rows"][sid], res["dets"][sid] = col, rows, dets
        if sid in MASKED:
            masks_out[sid] = masks
        if sid in ("meta_toy", "tuned_generic"):
            res["truck"]["meta" if a.phase == "meta" else "tuned"] = truck(proc)
    timings[f"score_{a.phase}"] = round(time.time() - t1)
    res["timings"] = timings
    res["peak_gpu_mb"] = int(torch.cuda.max_memory_allocated() // 2**20)
    json.dump(res, open(a.out, "w"))
    json.dump(masks_out, open(a.masks, "w"))
    if cpath:
        json.dump(res, open(cpath, "w"))
        json.dump(masks_out, open(cpath + ".masks", "w"))
    say("DONE", a.out)


if __name__ == "__main__":
    main()
