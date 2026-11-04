#!/usr/bin/env python3
"""Read-only memory stats for jetson-04's SAM 3.1 service, for the rover demo page. Touches nothing; port 8791."""
import json, os, re, subprocess, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "/opt/sam3/model"
gpu = {"load": None, "line": ""}


def tegra():
    p = subprocess.Popen(["tegrastats", "--interval", "1000"], stdout=subprocess.PIPE, text=True)
    for line in p.stdout:
        m = re.search(r"GR3D_FREQ (\d+)%", line)
        gpu["load"] = int(m.group(1)) if m else None


def meminfo():
    d = {}
    for line in open("/proc/meminfo"):
        k, v = line.split(":", 1)
        d[k] = int(v.split()[0]) // 1024
    return d


def stats():
    mi = meminfo()
    pid = subprocess.run(["systemctl", "show", "sam3", "-p", "MainPID", "--value"], capture_output=True, text=True).stdout.strip()
    rss = 0
    try:
        for line in open(f"/proc/{pid}/status"):
            if line.startswith("VmRSS"):
                rss = int(line.split()[1]) // 1024
    except OSError:
        pass
    try:
        health = json.loads(urllib.request.urlopen("http://192.168.12.144:8790/health", timeout=3).read())
    except Exception:
        health = {}
    size = lambda f: os.path.getsize(os.path.join(MODEL, f)) // 2**20 if os.path.exists(os.path.join(MODEL, f)) else None
    return {"board": "jetson-04", "total_mb": mi["MemTotal"], "used_mb": mi["MemTotal"] - mi["MemAvailable"],
            "swap_total_mb": mi["SwapTotal"], "swap_used_mb": mi["SwapTotal"] - mi["SwapFree"],
            "sam_rss_mb": rss, "sam_gpu_mb": health.get("gpu_mb"), "sam_ok": bool(health.get("ok")),
            "base_weights_mb": size("sam3.1_multiplex_fp16.pt"), "tuned_delta_mb": size("muse31_delta_fp16.pt"),
            "gpu_load": gpu["load"], "ts": time.time()}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if not self.client_address[0].startswith(("192.168.12.", "127.")) or self.path != "/stats":
            self.send_response(404); self.end_headers(); return
        b = json.dumps(stats()).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)


threading.Thread(target=tegra, daemon=True).start()
ThreadingHTTPServer(("192.168.12.144", 8791), H).serve_forever()
