"""On jetson-04: joins an uploaded image's base64 parts, asks the local SAM service, prints one JSON line.

python3 ask.py <request id> <prompt> <threshold>
Parts are /tmp/sam-ui/<id>/NNN, written by earlier fleet jobs. The folder is removed after.
"""
import glob
import json
import os
import shutil
import sys
import urllib.request

rid, prompt, thr = sys.argv[1], sys.argv[2], float(sys.argv[3])
d = f"/tmp/sam-ui/{rid}"
try:
    b64 = "".join(open(p).read().strip() for p in sorted(glob.glob(d + "/[0-9]*")))
    body = json.dumps({"image_b64": b64, "prompt": prompt, "threshold": thr, "overlay": True}).encode()
    req = urllib.request.Request("http://192.168.12.144:8790/segment", body, {"Content-Type": "application/json"})
    try:
        out = urllib.request.urlopen(req, timeout=80).read().decode()
    except urllib.error.HTTPError as e:
        out = e.read().decode()
    print("SAMRESULT " + out, flush=True)
except Exception as e:
    print("SAMRESULT " + json.dumps({"error": f"{type(e).__name__}: {e}"}), flush=True)
finally:
    shutil.rmtree(d, ignore_errors=True)
