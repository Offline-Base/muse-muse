"""jetson-04, Nov 3 2026: an office-LAN-only, read-only share of SAM 3.1's detector tensors, one tensor per request, so
jetson-03 can load SAM 3.1 for the tune without a copy on its nearly full disk. Reads the checkpoint with mmap (page cache
only). GET /<token>/keys, GET /<token>/t/<i>. Run as a transient unit that ends itself:

  mkdir -p /run/sam31share && head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \\n' > /run/sam31share/token
  systemd-run --unit=sam31-share -p RuntimeMaxSec=14400 -p MemoryMax=1500M /opt/sam3/venv/bin/python /run/sam31share/share.py

jetson-03 reads http://<jetson-04's office address>:8797/<token> from /run/sam31share.url (sam31load.py).
"""
import json

import torch
from http.server import BaseHTTPRequestHandler, HTTPServer

TOK = open("/run/sam31share/token").read().strip()
ck = torch.load("/opt/sam3/model/sam3.1_multiplex_fp16.pt", map_location="cpu", weights_only=True, mmap=True)
sd = ck["model"] if isinstance(ck, dict) and isinstance(ck.get("model"), dict) else ck
KEYS = [k for k in sd if "detector" in k]
META = json.dumps([[k.replace("detector.", ""), str(sd[k].dtype).replace("torch.", ""), list(sd[k].shape)] for k in KEYS]).encode()


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        p = self.path.split("/")
        if len(p) < 3 or p[1] != TOK:
            self.send_response(404); self.end_headers(); return
        if p[2] == "keys":
            b = META
        elif p[2] == "t" and len(p) == 4 and p[3].isdigit() and int(p[3]) < len(KEYS):
            b = sd[KEYS[int(p[3])]].contiguous().view(torch.uint8).numpy().tobytes()
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def log_message(self, *a):
        pass


HTTPServer(("192.168.12.144", 8797), H).serve_forever()
