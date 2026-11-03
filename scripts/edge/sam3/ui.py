"""A local page for trying Meta SAM 3.1 on a Jetson, with Meta's weights or a tuned detector, side by side.

Two ways to reach the board (README.md, "The page"):

  Straight to the service, on the office network or the board's local link. No token, no control plane:
    SAM_URL=http://<board address>:8790 python3 ui.py

  Through the fleet control plane's jobs API (exec is admin only, so a personal jpt_ token of an admin):
    FLEET_URL=http://<control plane>/admin python3 ui.py      (the token is asked for at the prompt)

FLEET_URL has no default on purpose: on the office network use the control plane's own office address, not the public
tunnel. Then open http://127.0.0.1:8792 (PORT changes it).

In fleet mode the page sends the photo to the board in 15 KB pieces as exec jobs, then one more job runs ask.py there.
That job carries this folder's ask.py inline, so the board's own /opt/sam3/ask.py doesn't need updating for the
tuned switch. SAM_BOARD_URL is where the board reaches its own service (default its office address).
"""
import getpass
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

HERE = Path(__file__).parent
CHUNK = 15000
MAX_B64 = 400_000
NAME_OK = re.compile(r"[a-z0-9_-]{1,32}")
ASK_SRC = (HERE / "ask.py").read_text()
assert "\nSAMASK\n" not in ASK_SRC and not any(l.startswith("SAMRESULT") for l in ASK_SRC.splitlines())


class Config:
    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.direct = env.get("SAM_URL", "").strip().rstrip("/")
        self.fleet = env.get("FLEET_URL", "").strip().rstrip("/")
        self.token = env.get("FLEET_TOKEN", "")
        self.node = env.get("SAM_NODE", "nd_fe300e68e976228c")  # jetson-04
        self.board_sam = env.get("SAM_BOARD_URL", "http://192.168.12.144:8790").strip().rstrip("/")
        self.port = int(env.get("PORT", "8792"))

    @property
    def mode(self):
        return "direct" if self.direct else "fleet"

    def problem(self):
        """Why this setup can't run, or None."""
        if self.direct:
            if not re.fullmatch(r"https?://[A-Za-z0-9.\-\[\]:]+", self.direct):
                return "SAM_URL must look like http://<board address>:8790, with no path."
            return None
        if not self.fleet:
            return ("Set SAM_URL=http://<board address>:8790 to call SAM straight, or FLEET_URL=<control plane>/admin to go "
                    "through the fleet. FLEET_URL has no default: on the office network use the control plane's office address.")
        if not re.fullmatch(r"https?://\S+/admin", self.fleet):
            return "FLEET_URL must be the control plane's address ending in /admin."
        if not re.fullmatch(r"https?://[A-Za-z0-9.\-\[\]:]+", self.board_sam):
            return "SAM_BOARD_URL must look like http://127.0.0.1:8790, with no path."
        if not self.token.startswith("jpt_"):
            return "Fleet mode needs a personal fleet token (jpt_...) of an admin."
        return None


CFG = Config()


def _json(req, timeout):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        # The service answers its own errors (an unknown tuned name, a bad photo) as JSON with a 4xx.
        raw = e.read().decode(errors="replace")
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
        if isinstance(body, dict) and "error" in body:
            return body
        raise RuntimeError(f"HTTP {e.code}: {raw[:200]}") from None


def api(cfg, method, path, body=None, timeout=60):
    req = urllib.request.Request(cfg.fleet + path, None if body is None else json.dumps(body).encode(), method=method)
    req.add_header("Authorization", "Bearer " + cfg.token)
    req.add_header("Content-Type", "application/json")
    req.add_header("ngrok-skip-browser-warning", "1")
    return _json(req, timeout)


def run(cfg, command, timeout_s=90):
    job = api(cfg, "POST", "/api/jobs", {"node_ids": [cfg.node], "action": "exec", "params": {"command": command},
                                          "timeout_s": timeout_s})
    jid = job.get("job_id") or job.get("id")
    end = time.time() + timeout_s + 30
    while time.time() < end:
        j = api(cfg, "GET", f"/api/jobs/{jid}")
        if j.get("status") not in ("queued", "pending", "running", "dispatched"):
            boards = j.get("tasks") or j.get("boards") or []
            b = boards[0] if boards else {}
            res = b.get("result") or {}
            # The streamed output keeps up to 256 KB; the result's copy keeps only the last 64 KB.
            out = b.get("output") or (res.get("output") if isinstance(res, dict) else "") or ""
            return j.get("status"), out, b.get("error")
        time.sleep(0.7)
    return "timeout", "", "no answer from the board in time"


def ask_command(cfg, rid, prompt, thr, tuned):
    """The last fleet job of a look: this folder's ask.py, sent inline, run on the board."""
    return (f"SAM_URL={shlex.quote(cfg.board_sam)} python3 - {rid} {shlex.quote(prompt)} {thr:.3f} {tuned} "
            f"<<'SAMASK'\n{ASK_SRC}\nSAMASK")


def check_look(b64, prompt, thr, tuned):
    b64 = b64.split(",", 1)[-1]
    if not b64 or len(b64) > MAX_B64 or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", b64):
        raise ValueError("the photo must be a JPEG or PNG in base64, under 400,000 characters")
    prompt = str(prompt).strip()[:200]
    if not prompt:
        raise ValueError("say what to find")
    thr = float(thr)
    if not 0 <= thr <= 1:
        raise ValueError("the cut-off must be from 0 to 1")
    tuned = str(tuned or "base")
    if not NAME_OK.fullmatch(tuned):
        raise ValueError("a tuned detector's name is lower-case letters, digits, - and _")
    return b64, prompt, thr, tuned


def look(b64, prompt, thr=0.5, tuned="base", cfg=None):
    """One look at a photo. tuned is "base" for Meta's SAM 3.1 weights or a tuned detector's name."""
    cfg = cfg or CFG
    b64, prompt, thr, tuned = check_look(b64, prompt, thr, tuned)
    t = time.time()
    if cfg.mode == "direct":
        body = {"image_b64": b64, "prompt": prompt, "threshold": thr, "overlay": True}
        if tuned != "base":
            body["tuned"] = tuned
        req = urllib.request.Request(cfg.direct + "/segment", json.dumps(body).encode(), {"Content-Type": "application/json"})
        res = _json(req, 90)
        up, parts = 0.0, 0
    else:
        rid = secrets.token_hex(6)
        pieces = [b64[i:i + CHUNK] for i in range(0, len(b64), CHUNK)]
        for n, p in enumerate(pieces):
            st, out, err = run(cfg, f"mkdir -p /tmp/sam-ui/{rid} && printf %s '{p}' > /tmp/sam-ui/{rid}/{n:03d}", 60)
            if st != "succeeded":
                raise RuntimeError(f"upload part {n + 1}/{len(pieces)}: {st} {err or out[-200:]}")
        up, parts = time.time() - t, len(pieces)
        st, out, err = run(cfg, ask_command(cfg, rid, prompt, thr, tuned), 120)
        line = next((l for l in out.splitlines() if l.startswith("SAMRESULT ")), None)
        if line is None:
            raise RuntimeError(f"no result: {st} {err or out[-300:]}")
        res = json.loads(line[len("SAMRESULT "):])
    if "error" in res:
        raise RuntimeError(f"the board said: {res['error']}")
    # The service names the weights it used only when they are a tuned detector's. Never show Meta's answer as the tune's.
    if res.get("weights", "base") != tuned:
        raise RuntimeError(f"asked for {tuned!r} but the board answered with {res.get('weights', 'base')!r}; "
                           "is its sam3.service the Nov 3 one with --tuned?")
    res["weights"] = tuned
    res["via"] = cfg.mode
    res["upload_s"] = round(up, 1)
    res["total_s"] = round(time.time() - t, 1)
    res["parts"] = parts
    return res


def health(cfg=None):
    cfg = cfg or CFG
    if cfg.mode == "direct":
        sam = _json(urllib.request.Request(cfg.direct + "/health"), 10)
    else:
        st, out, err = run(cfg, f"curl -s -m 5 {shlex.quote(cfg.board_sam + '/health')}", 30)
        sam = json.loads(out) if out.strip().startswith("{") else {"ok": False, "error": (err or out)[-200:]}
    return {"via": cfg.mode, "sam": sam}


class H(BaseHTTPRequestHandler):
    page = (HERE / "index.html").read_bytes()

    def _send(self, code, body, ctype="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            return self._send(200, self.page, "text/html; charset=utf-8")
        if self.path == "/api/health":
            try:
                return self._send(200, health())
            except Exception as e:
                return self._send(502, {"error": f"{type(e).__name__}: {e}"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/api/segment":
            return self._send(404, {"error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            self._send(200, look(req["image_b64"], req.get("prompt", ""), req.get("threshold", 0.5), req.get("tuned") or "base"))
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:
            self._send(502, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt, *a):
        sys.stderr.write("%s %s\n" % (self.command, self.path))


def main():
    if CFG.mode == "fleet" and CFG.fleet and not CFG.token:
        CFG.token = getpass.getpass("Fleet token (jpt_..., not shown): ").strip()
    why = CFG.problem()
    if why:
        sys.exit(why)
    where = CFG.direct if CFG.mode == "direct" else f"{CFG.fleet}, board {CFG.node}"
    print(f"SAM page on http://127.0.0.1:{CFG.port}  ({CFG.mode}: {where})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", CFG.port), H).serve_forever()


if __name__ == "__main__":
    main()
