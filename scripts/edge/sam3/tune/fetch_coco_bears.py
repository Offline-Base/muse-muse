"""One-time board prep for the built-in Muse run: puts the training teddy-bear photos on jetson-03.

  /opt/sam3train/venv/bin/python fetch_coco_bears.py [--max 64]

Reads the teddy-bear part of COCO val2017 that coco_teddy.py saved on Nov 3
(/opt/sam3train/runs/nov3-distract/coco/teddy_val2017.json), drops the 30 photos of the Nov 3 test sets (sets.json),
photos with crowd boxes, and every photo not under license 4 (CC BY), 5 (CC BY-SA), 7 (no known copyright restrictions)
or 8 (United States Government Work), then downloads the rest from images.cocodataset.org into
/opt/sam3train/samtune/coco_bears/ with bears.json beside them. Only the owner runs this, once, through the fleet:
worker.py itself downloads from the Muse Muse site and the public Blob host only. A few MB.
Offline Base, Nov 2026.
"""
import argparse
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tunelib as T  # noqa: E402

NOV3 = "/opt/sam3train/runs/nov3-distract"
OUT = "/opt/sam3train/samtune/coco_bears"


def eligible(teddy, test_ids):
    by = {}
    for a in teddy["annotations"]:
        by.setdefault(a["image_id"], []).append(a)
    out = []
    for im in sorted(teddy["images"], key=lambda i: i["id"]):
        anns = by.get(im["id"], [])
        if im["id"] in test_ids or im.get("license") not in T.TRAIN_LICENSE_IDS or not anns:
            continue
        if any(a.get("iscrowd") for a in anns):
            continue
        out.append((im, [a["bbox"] for a in anns]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=64)
    a = ap.parse_args()
    teddy = json.load(open(f"{NOV3}/coco/teddy_val2017.json"))
    test_ids = {r["coco_id"] for r in json.load(open(f"{NOV3}/sets.json"))["images"]}
    lic = {l["id"]: l for l in teddy["licenses"]}
    os.makedirs(OUT, exist_ok=True)
    rows = []
    for im, bears in eligible(teddy, test_ids)[: a.max]:
        fn = f"{im['id']:012d}.jpg"
        path = os.path.join(OUT, fn)
        if not os.path.exists(path):
            if not im["coco_url"].startswith("http://images.cocodataset.org/"):
                continue
            raw = urllib.request.urlopen(im["coco_url"], timeout=60).read()
            open(path + ".tmp", "wb").write(raw)
            os.replace(path + ".tmp", path)
        rows.append({"file": fn, "coco_id": im["id"], "license_id": im["license"],
                     "license": lic.get(im["license"], {}).get("name"), "flickr_url": im.get("flickr_url"),
                     "coco_url": im["coco_url"], "width": im["width"], "height": im["height"], "bears": bears})
    json.dump({"source": teddy["source"], "test_ids_left_out": sorted(test_ids), "images": rows},
              open(os.path.join(OUT, "bears.json"), "w"), indent=1)
    print("bears", len(rows), "licenses", sorted({r["license"] for r in rows}), flush=True)


if __name__ == "__main__":
    main()
