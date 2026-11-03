"""Before and after in one command: the same photo and prompts with Meta's SAM 3.1 weights and with a tuned detector.

  SAM_URL=http://<board address>:8790 python3 compare.py photo.jpg
  SAM_URL=... python3 compare.py photo.jpg --prompt muse --prompt "plush toy" --tuned muse --out compare.html

It reaches the board the way ui.py does (SAM_URL straight, or FLEET_URL through the control plane, with the token asked
for at the prompt). It writes one page with every look side by side, Meta's weights on the left and the tuned ones on the
right, a JSON file beside it, and prints a table. Pillow, if installed, shrinks the photo first (1024 px straight,
640 px through the fleet, like the page); without it the photo is sent as it is and must be under 300 KB.
"""
import argparse
import base64
import getpass
import html
import io
import json
import sys
import time
from pathlib import Path

import ui


def photo_b64(path, max_side=1024):
    raw = Path(path).read_bytes()
    try:
        from PIL import Image
    except ImportError:
        return base64.b64encode(raw).decode()
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    im.thumbnail((max_side, max_side))
    for quality in (85, 75, 65, 55):  # stay under the page's 400,000-character limit
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=quality)
        out = base64.b64encode(buf.getvalue()).decode()
        if len(out) <= ui.MAX_B64:
            break
    return out


def summary(r):
    scores = sorted((o["score"] for o in r.get("objects", [])), reverse=True)
    return {"count": r.get("count", 0), "best": scores[0] if scores else None, "ms": r.get("ms")}


def page(photo, rows, tuned):
    cells = []
    for row in rows:
        cells.append(f"<h2>&ldquo;{html.escape(row['prompt'])}&rdquo;</h2><div class='pair'>")
        for key, title in (("base", "Meta SAM 3.1 weights"), ("tuned", f"Tuned on a Jetson: {tuned}")):
            r = row[key]
            if "error" in r:
                body = f"<p class='bad'>Didn't work: {html.escape(r['error'])}</p>"
            else:
                s = summary(r)
                best = "none" if s["best"] is None else f"{s['best']:.2f}"
                body = (f"<img alt='{html.escape(title)}, {s['count']} found' src='data:image/jpeg;base64,{r['overlay_jpeg_b64']}'>"
                        f"<p>Found <b>{s['count']}</b>, best score <b>{best}</b>, {r['ms'] / 1000:.1f} s on the board</p>")
            cells.append(f"<div><h3>{html.escape(title)}</h3>{body}</div>")
        cells.append("</div>")
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SAM 3.1 before and after</title>
<style>body{{font:15px/1.45 system-ui,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#1c2b33}}
.pair{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}img{{width:100%;border-radius:12px}}h3{{font-size:14px;margin:0 0 6px}}
.bad{{color:#c62828}}p{{font-size:13px;color:#65676b}}</style></head><body>
<h1>Meta SAM 3.1 on a Jetson, before and after a tune</h1><p>Photo: {html.escape(Path(photo).name)}. Made {time.strftime('%Y-%m-%d %H:%M')}.</p>
{''.join(cells)}</body></html>"""


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("photo")
    ap.add_argument("--prompt", action="append", help='repeatable; default "muse" and "plush toy"')
    ap.add_argument("--tuned", default="muse")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--out", default="compare.html")
    a = ap.parse_args(argv)
    cfg = ui.CFG
    if cfg.mode == "fleet" and cfg.fleet and not cfg.token:
        cfg.token = getpass.getpass("Fleet token (jpt_..., not shown): ").strip()
    why = cfg.problem()
    if why:
        sys.exit(why)
    # Through the fleet, 640 px like the page: fewer pieces, and the tinted picture back fits in the job's output.
    b64 = photo_b64(a.photo, 1024 if cfg.mode == "direct" else 640)
    rows = []
    for prompt in a.prompt or ["muse", "plush toy"]:
        row = {"prompt": prompt}
        for key, w in (("base", "base"), ("tuned", a.tuned)):
            try:
                row[key] = ui.look(b64, prompt, a.threshold, w, cfg)
            except Exception as e:
                row[key] = {"error": f"{type(e).__name__}: {e}"}
        rows.append(row)
    out = Path(a.out)
    out.write_text(page(a.photo, rows, a.tuned))
    slim = [{"prompt": r["prompt"], **{k: (r[k] if "error" in r[k] else summary(r[k])) for k in ("base", "tuned")}} for r in rows]
    out.with_suffix(".json").write_text(json.dumps({"photo": Path(a.photo).name, "tuned": a.tuned, "via": cfg.mode,
                                                    "threshold": a.threshold, "rows": slim}, indent=1))
    print(f"{'prompt':<14} {'Meta: found, best':<22} {a.tuned + ': found, best':<22}")
    for r in slim:
        cols = []
        for k in ("base", "tuned"):
            v = r[k]
            cols.append("error" if "error" in v else f"{v['count']}, {'-' if v['best'] is None else format(v['best'], '.2f')}")
        print(f"{r['prompt'][:14]:<14} {cols[0]:<22} {cols[1]:<22}")
    print(f"Wrote {out} and {out.with_suffix('.json')}")
    return 1 if any("error" in r[k] for r in slim for k in ("base", "tuned")) else 0


if __name__ == "__main__":
    sys.exit(main())
