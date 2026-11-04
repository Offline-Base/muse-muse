#!/usr/bin/env python3
"""While the page's mic switch is on, listens and passes what you say to Muse Code as hints, through the rover page.

    python3 muse_listen.py            # MacBook Pro Microphone
    MIC=":0" python3 muse_listen.py   # another input (see: ffmpeg -f avfoundation -list_devices true -i "")

ffmpeg records the mic into back-to-back 4-second clips; each finished clip goes to Muse transcribe
(`muse voice transcribe`), and any words go to the rover as a hint. Saying "stop" also stops the wheels at once. Muse Code gets new hints with its next tool result.
"""

import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

ROVER = os.environ.get("ROVER", "http://192.168.12.158:8799")
MIC = os.environ.get("MIC", ":MacBook Pro Microphone")
CLIP_S = int(os.environ.get("CLIP_S", "4"))
NOISE = {"", "you", "thank you.", "thanks for watching!", "."}


def hint(text):
    req = urllib.request.Request(f"{ROVER}/hint", data=json.dumps({"text": text}).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=5).read()
    except OSError as exc:
        print(f"[listen] page not reached: {exc}", file=sys.stderr)


def stop_now():
    """A spoken "stop" stops the wheels at once, before Muse Code even hears it."""
    try:
        urllib.request.urlopen(urllib.request.Request(f"{ROVER}/stop", data=b"", method="POST"), timeout=5).read()
        print("[listen] heard stop: wheels stopped", flush=True)
    except OSError:
        pass


def mic_on():
    try:
        with urllib.request.urlopen(f"{ROVER}/mic", timeout=3) as r:
            return bool(json.loads(r.read()).get("mic"))
    except (OSError, ValueError):
        return False


def main():
    """Records only while the page's mic switch is on: ffmpeg starts when it turns on and is stopped when it turns off."""
    tmp = tempfile.mkdtemp(prefix="muse-listen-")
    rec = None
    print(f"[listen] waiting for the mic switch on {ROVER} (Ctrl-C to quit)", flush=True)
    try:
        while True:
            on = mic_on()
            if on and rec is None:
                for f in glob.glob(os.path.join(tmp, "clip*.wav")):
                    os.remove(f)
                rec = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", MIC,
                                        "-ac", "1", "-ar", "16000", "-f", "segment", "-segment_time", str(CLIP_S),
                                        os.path.join(tmp, "clip%05d.wav")])
                print("[listen] mic on", flush=True)
            elif not on and rec is not None:
                rec.terminate()
                rec.wait()
                rec = None
                for f in glob.glob(os.path.join(tmp, "clip*.wav")):
                    os.remove(f)  # anything recorded as the switch went off is dropped, not sent
                print("[listen] mic off", flush=True)
            if rec is not None:
                clips = sorted(glob.glob(os.path.join(tmp, "clip*.wav")))
                for clip in clips[:-1]:  # the newest one is still being written
                    out = subprocess.run(["muse", "voice", "transcribe", clip], capture_output=True, text=True, timeout=60)
                    os.remove(clip)
                    text = " ".join(out.stdout.split())
                    said_stop = bool(re.search(r"\bstop\b", text.lower()))
                    if said_stop:
                        stop_now()
                    if said_stop or (text.lower() not in NOISE and len(text.split()) >= 2):
                        print(f"[heard] {text}", flush=True)
                        hint(text)
            time.sleep(0.5)
    finally:
        if rec is not None:
            rec.terminate()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
