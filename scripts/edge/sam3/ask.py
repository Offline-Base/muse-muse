"""On the SAM board: joins an uploaded image's base64 parts, asks the SAM service, prints one JSON line.

python3 ask.py <request id> <prompt> <threshold> [tuned]
Parts are /tmp/sam-ui/<id>/NNN, written by earlier fleet jobs. The folder is removed after.
[tuned] is a tuned detector's name ("muse"), or "base" (the default) for Meta's own weights.
SAM_URL says where the service listens (default the office address, http://192.168.12.144:8790). After the rebind in
LOCAL.md it can be http://127.0.0.1:8790.

The hosted route (lib/caps/fleet/sam.ts) calls the board's /opt/sam3/ask.py with three arguments, so those keep working.
ui.py sends this file's text with each look instead of calling the board's copy, so a new switch here needs no board change.
"""
import glob
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.request

SAM_URL = os.environ.get("SAM_URL", "http://192.168.12.144:8790").rstrip("/")


def main(argv):
    rid, prompt, thr = argv[1], argv[2], float(argv[3])
    tuned = argv[4] if len(argv) > 4 else "base"
    if not re.fullmatch(r"[0-9a-f]{6,32}", rid):
        raise ValueError("bad request id")
    d = f"/tmp/sam-ui/{rid}"
    try:
        if not re.fullmatch(r"[a-z0-9_-]{1,32}", tuned):
            raise ValueError("bad tuned name")
        b64 = "".join(open(p).read().strip() for p in sorted(glob.glob(d + "/[0-9]*")))
        body = {"image_b64": b64, "prompt": prompt, "threshold": thr, "overlay": True}
        if tuned != "base":
            body["tuned"] = tuned
        req = urllib.request.Request(SAM_URL + "/segment", json.dumps(body).encode(), {"Content-Type": "application/json"})
        try:
            out = urllib.request.urlopen(req, timeout=80).read().decode()
        except urllib.error.HTTPError as e:
            out = e.read().decode()
        print("SAMRESULT " + out, flush=True)
    finally:
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Exception as e:
        print("SAMRESULT " + json.dumps({"error": f"{type(e).__name__}: {e}"}), flush=True)
