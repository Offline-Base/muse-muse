"""Rebuilds the 3 set-B photos on the laptop (COCO original + the board's own pasted-Muse pixels) and draws the board's
own boxes and scores side by side: Meta SAM 3.1 "plush toy" left, tuned "muse" right."""
import base64, io, json, os, sys, urllib.request
from PIL import Image, ImageDraw, ImageFont
bundle, dl, out = sys.argv[1], sys.argv[2], sys.argv[3]
B = json.load(open(bundle))
F = "/System/Library/Fonts/Helvetica.ttc"
big, mid, small = ImageFont.truetype(F, 24), ImageFont.truetype(F, 17), ImageFont.truetype(F, 14)
for n, cid in enumerate(["249129", "20553", "113403"], 1):
    r = B[cid]
    p = os.path.join(dl, r["file"])
    if not os.path.exists(p):
        open(p, "wb").write(urllib.request.urlopen(r["coco_url"], timeout=60).read())
    base = Image.open(p).convert("RGB")
    x, y, w, h = r["box"]
    crop = Image.open(io.BytesIO(base64.b64decode(r["crop"]))).convert("RGB")
    assert crop.size == (w, h), (crop.size, w, h)
    base.paste(crop, (x, y))
    panels = []
    for key, title, col in (("plush", 'Meta SAM 3.1, asked "plush toy"', (255, 99, 71)), ("tuned", 'Tuned on a Jetson, asked "muse"', (24, 119, 242))):
        im = base.copy(); d = ImageDraw.Draw(im)
        boxes = [b for b in r[key] if b[1] >= 0.5]
        for (x0, y0, x1, y1), s in boxes:
            d.rectangle([x0, y0, x1, y1], outline=col, width=4)
            t = f"{s:.2f}"; tw = d.textlength(t, font=mid)
            ty = max(0, y0 - 22) if y0 > 22 else y0 + 2
            d.rectangle([x0, ty, x0 + tw + 8, ty + 21], fill=col); d.text((x0 + 4, ty + 1), t, fill="white", font=mid)
        panels.append((im, f"{title}: {len(boxes)} boxes"))
    W = sum(p.width for p, _ in panels) + 16; H = max(p.height for p, _ in panels)
    canvas = Image.new("RGB", (W, H + 56 + 30), "white"); d = ImageDraw.Draw(canvas)
    xo = 0
    for im, lab in panels:
        canvas.paste(im, (xo, 56)); d.text((xo + 6, 16), lab, fill=(28, 43, 51), font=big); xo += im.width + 16
    d.text((6, H + 63), f"Photo: COCO val2017 {int(cid)} (Flickr, CC BY 2.0: {r['flickr']}). One held-out Muse pasted in. Boxes and scores from SAM 3.1 on jetson-04, Nov 3 2026.", fill=(101, 103, 107), font=small)
    q = 88
    while True:
        f = os.path.join(out, f"sbs{n}_coco{int(cid)}_plushtoy_vs_tuned_muse.jpg")
        canvas.save(f, "JPEG", quality=q, optimize=True)
        if os.path.getsize(f) < 290_000 or q <= 50: break
        q -= 8
    print(f, canvas.size, os.path.getsize(f))
