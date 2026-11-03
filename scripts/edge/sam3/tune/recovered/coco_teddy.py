"""Reads only instances_val2017.json out of COCO's annotations zip with HTTP range requests (no zip on disk), and keeps
the teddy-bear part (category 88): images, their teddy-bear boxes, licenses. COCO annotations: CC BY 4.0. Offline Base, Nov 3 2026."""
import io, json, sys, urllib.request, zipfile
URL = "http://images.cocodataset.org/annotations/annotations_trainval2017.zip"
class RangeFile(io.RawIOBase):
    def __init__(s, u):
        s.u, s.p, s.got = u, 0, 0
        r = urllib.request.urlopen(urllib.request.Request(u, method="HEAD"), timeout=30)
        s.n = int(r.headers["Content-Length"])
    def seekable(s): return True
    def readable(s): return True
    def tell(s): return s.p
    def seek(s, o, w=0):
        s.p = o if w == 0 else (s.p + o if w == 1 else s.n + o); return s.p
    def read(s, k=-1):
        if k is None or k < 0: k = s.n - s.p
        if k == 0 or s.p >= s.n: return b""
        e = min(s.n, s.p + k) - 1
        r = urllib.request.urlopen(urllib.request.Request(s.u, headers={"Range": f"bytes={s.p}-{e}"}), timeout=300)
        if r.status != 206: raise SystemExit(f"no range support: {r.status}")
        d = r.read(); s.p += len(d); s.got += len(d); return d
    def readinto(s, b):
        d = s.read(len(b)); b[:len(d)] = d; return len(d)
f = RangeFile(URL)
z = zipfile.ZipFile(f)
info = z.getinfo("annotations/instances_val2017.json")
print("zip", f.n, "member", info.compress_size, "->", info.file_size, flush=True)
g = json.loads(z.read(info))
print("fetched bytes", f.got, flush=True)
cat = [c for c in g["categories"] if c["name"] == "teddy bear"][0]
anns = [a for a in g["annotations"] if a["category_id"] == cat["id"]]
ids = {a["image_id"] for a in anns}
imgs = [i for i in g["images"] if i["id"] in ids]
out = {"source": "COCO val2017, instances_val2017.json (cocodataset.org), CC BY 4.0 annotations; images under their Flickr licenses below",
       "category": cat, "licenses": g["licenses"], "images": imgs,
       "annotations": [{k: a[k] for k in ("id", "image_id", "bbox", "area", "iscrowd")} for a in anns]}
json.dump(out, open("coco/teddy_val2017.json", "w"))
print("teddy images", len(imgs), "boxes", len(anns), flush=True)
