#!/usr/bin/env python3
"""Listens the whole time and passes what you say to Muse Code as hints, through the rover page.

    python3 muse_listen.py            # MacBook Pro Microphone
    MIC=":0" python3 muse_listen.py   # another input (see: ffmpeg -f avfoundation -list_devices true -i "")

ffmpeg records the mic into back-to-back 5-second clips; each finished clip goes to Muse transcribe
(`muse voice transcribe`), and any words go to the rover as a hint. Muse Code gets new hints with its next tool result.
"""

import glob
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

ROVER = os.environ.get("ROVER", "http://192.168.12.158:8799")
MIC = os.environ.get("MIC", ":MacBook Pro Microphone")
CLIP_S = int(os.environ.get("CLIP_S", "5"))
NOISE = {"", "you", "thank you.", "thanks for watching!", "."}


def hint(text):
    req = urllib.request.Request(f"{ROVER}/hint", data=json.dumps({"text": text}).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=5).read()
    except OSError as exc:
        print(f"[listen] page not reached: {exc}", file=sys.stderr)


def main():
    tmp = tempfile.mkdtemp(prefix="muse-listen-")
    rec = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", MIC,
                            "-ac", "1", "-ar", "16000", "-f", "segment", "-segment_time", str(CLIP_S),
                            os.path.join(tmp, "clip%05d.wav")])
    print(f"[listen] listening on {MIC}, sending hints to {ROVER} (Ctrl-C to stop)")
    try:
        while rec.poll() is None:
            clips = sorted(glob.glob(os.path.join(tmp, "clip*.wav")))
            for clip in clips[:-1]:  # the newest one is still being written
                out = subprocess.run(["muse", "voice", "transcribe", clip], capture_output=True, text=True, timeout=60)
                os.remove(clip)
                text = " ".join(out.stdout.split())
                if text.lower() not in NOISE and len(text.split()) >= 2:
                    print(f"[heard] {text}", flush=True)
                    hint(text)
            time.sleep(0.5)
        print("[listen] the recorder stopped (is the mic allowed for this terminal?)", file=sys.stderr)
    finally:
        rec.terminate()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
