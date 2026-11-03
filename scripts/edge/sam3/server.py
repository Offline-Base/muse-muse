"""SAM 3.1 (image, text prompt) on a Jetson Orin Nano, as a small HTTP service.

POST /segment  body: {"image_b64": "<jpeg or png>", "prompt": "red truck", "threshold": 0.5}
  -> {"prompt", "count", "objects": [{"box": [x0,y0,x1,y1], "score", "area_px"}], "ms", "image_size"}
GET /health -> {"ok": true, "model": "facebook/sam3.1 (detector, fp16 weights)", "gpu_mb": ...}

Run: /opt/sam3/venv/bin/python server.py --host 192.168.12.144 --port 8790
One request at a time (a lock), so a burst never doubles GPU memory. Weights load once at start.
"""
import argparse
import base64
import io
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch
from PIL import Image
from sam3.model.sam3_image_processor import Sam3Processor
from sam3.model_builder import build_sam3_image_model

CKPT = "/opt/sam3/model/sam3.1_multiplex_fp16.pt"
MAX_BODY = 12 * 1024 * 1024
MAX_SIDE = 1600

LOCK = threading.Lock()
MODEL = None
PROC = None


def load():
    global MODEL, PROC
    t = time.time()
    MODEL = build_sam3_image_model(checkpoint_path=CKPT, load_from_HF=False)
    PROC = Sam3Processor(MODEL)
    print(f"loaded in {time.time() - t:.1f}s, gpu {torch.cuda.memory_allocated() // 2**20} MB", flush=True)


COLORS = [(24, 119, 242), (255, 99, 71), (46, 204, 113), (241, 196, 15), (155, 89, 182),
          (26, 188, 156), (230, 126, 34), (236, 64, 122)]


def overlay(img, keep, masks, boxes):
    """The image with each kept object's mask tinted and its box drawn, as a base64 JPEG (at most 1024 px)."""
    from PIL import ImageDraw
    base = np.asarray(img).astype(np.float32)
    for n, i in enumerate(keep):
        m = masks[i].squeeze().detach().float().cpu().numpy() > 0.5
        if m.shape != base.shape[:2]:
            continue
        c = np.array(COLORS[n % len(COLORS)], dtype=np.float32)
        base[m] = base[m] * 0.45 + c * 0.55
    out = Image.fromarray(base.clip(0, 255).astype(np.uint8))
    d = ImageDraw.Draw(out)
    w = max(2, out.width // 300)
    for n, i in enumerate(keep):
        x0, y0, x1, y1 = [float(v) for v in boxes[i].tolist()]
        d.rectangle([x0, y0, x1, y1], outline=COLORS[n % len(COLORS)], width=w)
    out.thumbnail((1024, 1024))
    buf = io.BytesIO()
    out.save(buf, "JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode()


def segment(img, prompt, threshold, want_overlay=False):
    t = time.time()
    with LOCK, torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
        state = PROC.set_image(img)
        out = PROC.set_text_prompt(state=state, prompt=prompt)
    masks, boxes, scores = out["masks"], out["boxes"], out["scores"]
    objs, keep = [], []
    for i in range(len(scores)):
        s = float(scores[i])
        if s < threshold:
            continue
        keep.append(i)
        objs.append({
            "box": [round(float(v), 1) for v in boxes[i].tolist()],
            "score": round(s, 3),
            "area_px": int(masks[i].sum().item()),
        })
    ms = int((time.time() - t) * 1000)
    res = {"prompt": prompt, "count": len(objs), "objects": objs, "ms": ms, "image_size": list(img.size)}
    if want_overlay:
        res["overlay_jpeg_b64"] = overlay(img, keep, masks, boxes)
    return res


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": MODEL is not None, "model": "facebook/sam3.1 (detector, fp16 weights)",
                                    "gpu_mb": torch.cuda.memory_allocated() // 2**20})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/segment":
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self._send(413, {"error": "body must be 1 byte to 12 MB"})
        try:
            req = json.loads(self.rfile.read(n))
            prompt = str(req.get("prompt", "")).strip()[:200]
            if not prompt:
                return self._send(400, {"error": "prompt is required"})
            img = Image.open(io.BytesIO(base64.b64decode(req["image_b64"]))).convert("RGB")
            img.thumbnail((MAX_SIDE, MAX_SIDE))
            thr = float(req.get("threshold", 0.5))
        except Exception as e:  # bad input, not a server fault
            return self._send(400, {"error": f"bad request: {type(e).__name__}"})
        try:
            self._send(200, segment(img, prompt, thr, bool(req.get("overlay"))))
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            self._send(503, {"error": "out of GPU memory, try a smaller image"})

    def log_message(self, fmt, *a):
        print("%s %s" % (self.command, self.path), flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--selftest", help="image path: run one prompt and exit")
    ap.add_argument("--prompt", default="truck")
    a = ap.parse_args()
    load()
    if a.selftest:
        img = Image.open(a.selftest).convert("RGB")
        for _ in range(2):
            r = segment(img, a.prompt, 0.5)
            print(json.dumps(r), flush=True)
        print(f"peak gpu {torch.cuda.max_memory_allocated() // 2**20} MB", flush=True)
    else:
        ThreadingHTTPServer((a.host, a.port), H).serve_forever()
