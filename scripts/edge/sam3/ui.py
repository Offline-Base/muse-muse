"""A local page for trying SAM 3.1 on jetson-04, through the fleet control plane's jobs API.

Run (the token is a personal fleet token, jpt_..., with operator/admin rights; it stays in this process only):
  FLEET_TOKEN=jpt_... python3 ui.py
then open http://127.0.0.1:8792

The page shrinks the photo in the browser, this server sends it to jetson-04 in 15 KB pieces as fleet exec jobs,
then one more job runs /opt/sam3/ask.py there, which calls the SAM service and prints the result with a picture.
"""
import json
import os
import re
import secrets
import shlex
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FLEET = os.environ.get("FLEET_URL", "https://creative-linoleum-retake.ngrok-free.dev/admin").rstrip("/")
TOKEN = os.environ.get("FLEET_TOKEN", "")
NODE = os.environ.get("SAM_NODE", "nd_fe300e68e976228c")  # jetson-04
CHUNK = 15000
PAGE = (Path(__file__).parent / "index.html").read_bytes()


def api(method, path, body=None, timeout=60):
    req = urllib.request.Request(FLEET + path, None if body is None else json.dumps(body).encode(), method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Content-Type", "application/json")
    req.add_header("ngrok-skip-browser-warning", "1")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def run(command, timeout_s=90):
    job = api("POST", "/api/jobs", {"node_ids": [NODE], "action": "exec", "params": {"command": command},
                                     "timeout_s": timeout_s})
    jid = job.get("job_id") or job.get("id")
    end = time.time() + timeout_s + 30
    while time.time() < end:
        j = api("GET", f"/api/jobs/{jid}")
        if j.get("status") not in ("queued", "pending", "running", "dispatched"):
            boards = j.get("tasks") or j.get("boards") or []
            b = boards[0] if boards else {}
            res = b.get("result") or {}
            # The streamed output keeps up to 256 KB; the result's copy keeps only the last 64 KB.
            out = b.get("output") or (res.get("output") if isinstance(res, dict) else "") or ""
            return j.get("status"), out, b.get("error")
        time.sleep(0.7)
    return "timeout", "", "no answer from the board in time"


def segment(b64, prompt, thr):
    rid = secrets.token_hex(6)
    parts = [b64[i:i + CHUNK] for i in range(0, len(b64), CHUNK)]
    t = time.time()
    for n, p in enumerate(parts):
        if not re.fullmatch(r"[A-Za-z0-9+/=]*", p):
            raise ValueError("image is not base64")
        st, out, err = run(f"mkdir -p /tmp/sam-ui/{rid} && printf %s '{p}' > /tmp/sam-ui/{rid}/{n:03d}", 60)
        if st != "succeeded":
            raise RuntimeError(f"upload part {n + 1}/{len(parts)}: {st} {err or out[-200:]}")
    up = time.time() - t
    st, out, err = run(f"python3 /opt/sam3/ask.py {rid} {shlex.quote(prompt)} {thr}", 120)
    line = next((l for l in out.splitlines() if l.startswith("SAMRESULT ")), None)
    if line is None:
        raise RuntimeError(f"no result: {st} {err or out[-300:]}")
    res = json.loads(line[len("SAMRESULT "):])
    res["upload_s"] = round(up, 1)
    res["total_s"] = round(time.time() - t, 1)
    res["parts"] = len(parts)
    return res


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            return self._send(200, PAGE, "text/html; charset=utf-8")
        if self.path == "/api/health":
            try:
                st, out, err = run("curl -s -m 5 http://192.168.12.144:8790/health", 30)
                return self._send(200, {"fleet": "ok", "sam": json.loads(out) if out.strip().startswith("{") else out[-200:]})
            except Exception as e:
                return self._send(502, {"error": f"{type(e).__name__}: {e}"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/api/segment":
            return self._send(404, {"error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            b64 = req["image_b64"].split(",", 1)[-1]
            if len(b64) > 400_000:
                return self._send(413, {"error": "image too large after shrinking"})
            self._send(200, segment(b64, str(req.get("prompt", "")).strip()[:200], float(req.get("threshold", 0.5))))
        except urllib.error.HTTPError as e:
            self._send(502, {"error": f"fleet said {e.code}: {e.read().decode()[:200]}"})
        except Exception as e:
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt, *a):
        sys.stderr.write("%s %s\n" % (self.command, self.path))


if __name__ == "__main__":
    if not TOKEN.startswith("jpt_"):
        sys.exit("Set FLEET_TOKEN to a personal fleet token (jpt_...) first.")
    print("SAM UI on http://127.0.0.1:8792  (fleet: %s, board: %s)" % (FLEET, NODE), flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8792), H).serve_forever()
