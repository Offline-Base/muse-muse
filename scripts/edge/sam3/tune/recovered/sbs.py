"""Three side-by-side JPEGs for the video: Meta SAM 3.1 asked "plush toy" vs the tuned detector asked "muse", on the
same set-B image (a COCO photo with a held-out Muse pasted in). Only CC BY or CC BY-SA photos. Offline Base, Nov 3 2026."""
import base64, io, json, os, urllib.request
from PIL import Image, ImageDraw, ImageFont
URL = "http://192.168.12.144:8790/segment"
S = {r["file"]: r for r in json.load(open("sets.json"))["images"]}
raw = json.load(open("raw.json"))
def ask(path, prompt, tuned):
    body = {"image_b64": base64.b64encode(open(path, "rb").read()).decode(), "prompt": prompt, "threshold": 0.5, "overlay": True}
    if tuned != "base": body["tuned"] = tuned
    r = json.loads(urllib.request.urlopen(urllib.request.Request(URL, json.dumps(body).encode(), {"Content-Type": "application/json"}), timeout=120).read())
    if tuned != "base" and r.get("weights") != tuned: raise SystemExit("wrong weights")
    return r
def iou(a, b):
    ax1, ay1, ax2, ay2 = a; bx, by, bw, bh = b
    ix = max(0, min(ax2, bx + bw) - max(ax1, bx)); iy = max(0, min(ay2, by + bh) - max(ay1, by))
    i = ix * iy; return i / ((ax2 - ax1) * (ay2 - ay1) + bw * bh - i)
ok = ("Attribution License", "Attribution-ShareAlike License")
cands = []
for f, r in S.items():
    if r["license"] not in ok: continue
    t = [o for o in raw["tuned:muse|B"][f]["objects"] if o["score"] >= 0.5]
    p = [o for o in raw["meta:plush toy|B"][f]["objects"] if o["score"] >= 0.5]
    only = len(t) == 1 and iou(t[0]["box"], r["muse_box"]) >= 0.5
    cands.append((not only, -len(p), f))
cands.sort()
print("candidates", cands[:6])
fp = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
font = ImageFont.truetype(fp, 22) if os.path.exists(fp) else ImageFont.load_default()
small = ImageFont.truetype(fp.replace("-Bold", ""), 15) if os.path.exists(fp) else ImageFont.load_default()
for n, (_, _, f) in enumerate(cands[:3], 1):
    r = S[f]
    a = ask(f"B/{f}", "plush toy", "base"); b = ask(f"B/{f}", "muse", "muse")
    ims = [Image.open(io.BytesIO(base64.b64decode(x["overlay_jpeg_b64"]))).convert("RGB") for x in (a, b)]
    H = 480; ims = [im.resize((int(im.width * H / im.height), H)) for im in ims]
    W = ims[0].width + ims[1].width + 12
    out = Image.new("RGB", (W, H + 50 + 30), (255, 255, 255)); d = ImageDraw.Draw(out)
    labels = [f'Meta SAM 3.1, "plush toy": {a["count"]} found', f'Tuned on a Jetson, "muse": {b["count"]} found']
    x = 0
    for im, lab in zip(ims, labels):
        out.paste(im, (x, 50)); d.text((x + 8, 12), lab, fill=(28, 43, 51), font=font); x += im.width + 12
    d.text((8, H + 56), f"COCO val2017 {r['coco_id']} ({r['license']}, {r['flickr_url']}), Muse pasted in. SAM 3.1 on jetson-04.", fill=(101, 103, 107), font=small)
    q = 85
    while True:
        out.save(f"sbs/sbs{n}_{r['coco_id']}.jpg", quality=q)
        if os.path.getsize(f"sbs/sbs{n}_{r['coco_id']}.jpg") < 290_000 or q < 50: break
        q -= 10
    print(n, f, r["license"], "plush", a["count"], "tuned", b["count"], os.path.getsize(f"sbs/sbs{n}_{r['coco_id']}.jpg"), flush=True)
