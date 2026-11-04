#!/usr/bin/env python3
"""Muse hunt: Muse Code drives the rover to find the Muse mascots, while SAM 3.1 on jetson-04 looks through its camera.

Every camera frame goes to two SAM 3.1 models on jetson-04, back to back, all the time: the one tuned on "muse" and
Meta's own weights. The page shows four panels: Muse Code (a Meta AI style chat with its steps), the live camera, the
tuned SAM's masks and Meta's. A tuned score of 0.95 or more is a match: the wheels stop, a snapshot is saved and the
page pings.

Muse Code (or any MCP client on the office network) runs the search through the MCP server at /mcp: rover_status,
rover_look, rover_drive, rover_stop, rover_photo, rover_camera, rover_found, rover_hints, rover_done and rover_say.
The webcam is fixed to the rover's front (the pan servo doesn't carry it), so looking around means turning the rover.
musecode_bridge.py (laptop) runs Muse Code and streams its chat in; muse_listen.py (laptop) sends spoken hints through
Muse transcribe (a spoken "stop" stops the wheels at once). jetson-04's memory comes from samstats.py, a read-only
reader on port 8791, shown by the page's Jetson memory button.

Runs on the rover as user arduino. Page: http://<rover>:8799 (office network only).
"""

import base64
import collections
import re
import glob
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

SAM = os.environ.get("SAM_URL", "http://192.168.12.144:8790")
BIND = os.environ.get("BIND", "192.168.12.158")
PORT = int(os.environ.get("PORT", "8799"))
GOAL = float(os.environ.get("GOAL", "0.95"))
PROMPT = os.environ.get("PROMPT", "muse")
DRIVE = os.environ.get("DRIVE", "0") == "1"
PANS = [-30, -15, 0, 15, 30]
HERE = os.path.dirname(os.path.abspath(__file__))
CAM_DIR = "/tmp/musehunt"
SNAPS = os.path.join(HERE, "snapshots")
BRIDGE = "/home/arduino/muse-device/rover/bridge_client.py"
# The webcam by its USB id, so a renumber after a reboot (video0 vs video2) changes nothing.
CAMERA = os.environ.get("CAMERA") or next(iter(sorted(glob.glob("/dev/v4l/by-id/*video-index0"))), "/dev/video0")
os.makedirs(CAM_DIR, exist_ok=True)
CAM_FILE = os.path.join(HERE, "camera.json")
# Camera controls the page may set (v4l2 names, with the webcam's own ranges). These change the frames SAM sees.
CAM_CTRLS = {
    "auto_exposure": (1, 3), "exposure_time_absolute": (1, 5000), "gain": (0, 63), "brightness": (-128, 127),
    "contrast": (0, 63), "gamma": (1, 500), "saturation": (0, 128), "sharpness": (0, 31), "backlight_compensation": (0, 1),
}
MAX_MANUAL_SPEED = 200
CAM_DEFAULTS = {"exposure_time_absolute": 39, "gain": 32, "brightness": 0, "contrast": 33, "gamma": 100, "saturation": 58,
                "sharpness": 2, "backlight_compensation": 0}
STATS_URL = os.environ.get("STATS_URL", "http://192.168.12.144:8791/stats")  # jetson-04's read-only memory stats
TUNED_URL = os.environ.get("TUNED_URL", "https://huggingface.co/OfflineBase/sam3.1-muse")  # where the tuned weights are published, once they are
META_URL = "https://huggingface.co/facebook/sam3.1"
REFERENCE = os.path.join(HERE, "muse_reference.jpg")  # a photo of the real Muse mascot, for Muse Code to compare against
MAX_SATURATION = float(os.environ.get("MAX_SATURATION", "0.40"))  # the cream Muse measures about 0.2; a blue Stitch 0.6
TARGET = int(os.environ.get("TARGET", "2"))  # how many muses Muse Code is asked to find
FOV = 60.0  # the webcam's rough horizontal view, degrees (for left/right hints only)
RECENT = 5  # the best-match card looks back this many looks
os.makedirs(SNAPS, exist_ok=True)

state = {"mode": "watching", "seeing": False, "prompt": PROMPT, "pan": 0, "tilt": 0, "best": 0.0, "last": None, "found": None,
         "looks": 0, "snapshots": [], "note": "Starting", "frame_t": 0.0, "bestmatch": None, "finds": [], "target": TARGET,
         "agent": [], "agent_seq": 0, "agent_at": 0.0, "moves": 0,
         "chat": {"prompt": "", "reply": "", "status": "idle", "ts": 0.0}, "ask": None,
         "hints": [], "hint_seq": 0, "hint_sent": 0, "done": None, "mic": False}
overlay = {"jpeg": b"", "base": b"", "frame": b"", "bestframe": b""}
recent = collections.deque(maxlen=RECENT)
lock = threading.Lock()
run_event = threading.Event()


def agent_log(kind, text):
    """One line in the page's Muse Code panel: a tool call, something Muse Code said, or a find."""
    with lock:
        state["agent"].append({"ts": time.time(), "kind": kind, "text": str(text)[:400]})
        del state["agent"][:-60]
        state["agent_seq"] += 1
        state["agent_at"] = time.time()


def bridge(*args):
    out = subprocess.run(["python3", BRIDGE, *[str(a) for a in args]], capture_output=True, text=True, timeout=5)
    try:
        return json.loads(out.stdout or "{}")
    except ValueError:
        return {"error": (out.stderr or out.stdout)[-200:]}


def cam_get():
    out = subprocess.run(["v4l2-ctl", "-d", CAMERA, *sum((["-C", n] for n in CAM_CTRLS), [])], capture_output=True, text=True, timeout=5)
    values = {}
    for line in out.stdout.splitlines():
        name, _, value = line.partition(":")
        if name.strip() in CAM_CTRLS:
            try:
                values[name.strip()] = int(value.split()[0])
            except ValueError:
                pass
    return values


def cam_set(changes):
    """Set allowed controls (clamped to range), save them, and return the camera's values afterwards."""
    args = []
    for name, value in changes.items():
        if name in CAM_CTRLS:
            low, high = CAM_CTRLS[name]
            args += ["-c", f"{name}={max(low, min(high, int(value)))}"]
    if args:
        subprocess.run(["v4l2-ctl", "-d", CAMERA, *args], capture_output=True, timeout=5)
    values = cam_get()
    try:
        with open(CAM_FILE, "w") as fh:
            json.dump(values, fh)
    except OSError:
        pass
    return values


def apply_saved_camera():
    """Set again what the page saved: a webcam forgets its controls when it is unplugged or the rover reboots."""
    try:
        with open(CAM_FILE) as fh:
            saved = json.load(fh)
    except (OSError, ValueError):
        return
    # Exposure mode first, so a manual exposure time is accepted.
    if "auto_exposure" in saved:
        cam_set({"auto_exposure": saved["auto_exposure"]})
    cam_set({k: v for k, v in saved.items() if k != "auto_exposure"})


def pause_hunt(note):
    """Hand control stops the sweep; the looking goes on."""
    run_event.clear()


def start_camera():
    """A steady MJPEG stream into a ring of three files; readers take the newest finished one."""
    for f in glob.glob(f"{CAM_DIR}/cam-*.jpg"):
        os.remove(f)
    return subprocess.Popen(
        ["gst-launch-1.0", "-q", "v4l2src", f"device={CAMERA}", "!", "image/jpeg,width=640,height=480", "!",
         "multifilesink", f"location={CAM_DIR}/cam-%06d.jpg", "max-files=3"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def latest_frame(after=0.0):
    """The newest complete frame written after `after` (the second-newest file, so it is never half written)."""
    deadline = time.time() + 3
    while time.time() < deadline:
        files = sorted(glob.glob(f"{CAM_DIR}/cam-*.jpg"))
        if len(files) >= 2 and os.path.getmtime(files[-2]) >= after:
            with open(files[-2], "rb") as fh:
                return fh.read()
        time.sleep(0.05)
    return None


def ask_sam(jpeg, tuned="muse"):
    with lock:
        prompt = state["prompt"]
    body = {"image_b64": base64.b64encode(jpeg).decode(), "prompt": prompt, "threshold": 0.3, "overlay": True}
    if tuned:
        body["tuned"] = tuned
    r = requests.post(f"{SAM}/segment", json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def save_snapshot(jpeg, ov, score, tag):
    stamp = time.strftime("%H%M%S")
    name = f"{stamp}-{tag}-{score:.3f}"
    with open(os.path.join(SNAPS, name + "-camera.jpg"), "wb") as fh:
        fh.write(jpeg)
    if ov:
        with open(os.path.join(SNAPS, name + "-sam.jpg"), "wb") as fh:
            fh.write(ov)
    with lock:
        state["snapshots"].insert(0, name)
        del state["snapshots"][12:]
    return name


def hunt():
    """Always looking: every frame goes to the tuned SAM 3.1 and to Meta's SAM 3.1, back to back, forever.
    A tuned score crossing GOAL is a find: the wheels stop, a snapshot is saved and the page pings, and the
    looking goes on. "Sweep" (run_event) also pans the camera back and forth while it looks."""
    step, seeing, word = 0, False, None
    while True:
        with lock:
            if state["prompt"] != word:
                word, seeing = state["prompt"], False
        sweeping = run_event.is_set()
        if sweeping:
            order = PANS + PANS[-2:0:-1]
            pan = order[step % len(order)]
            step += 1
            with lock:
                tilt = state["tilt"]
            bridge("look", pan, tilt)
            t = time.time() + 0.4
            time.sleep(0.6)  # let the servo settle so the frame isn't blurred
            jpeg = latest_frame(after=t)
        else:
            with lock:
                pan = state["pan"]
            t = time.time()
            jpeg = latest_frame(after=t)
        if jpeg is None:
            with lock:
                state["note"] = "No frame from the camera"
            time.sleep(0.5)
            continue
        try:
            res = ask_sam(jpeg)
            base = ask_sam(jpeg, tuned=None)  # Meta's SAM 3.1 on the same frame
        except Exception as exc:  # keep looking through a slow or restarting SAM
            with lock:
                state["note"] = f"SAM: {type(exc).__name__}"
            time.sleep(1)
            continue
        ov = base64.b64decode(res.get("overlay_jpeg_b64") or b"")
        objects = [{"box": o.get("box"), "score": o.get("score", 0.0)} for o in res.get("objects", [])]
        score = max((o["score"] for o in objects), default=0.0)
        size = res.get("image_size") or [640, 480]
        # A match at GOAL counts as a muse only if it is plain-colored like the cream Muse (a blue Stitch scores 1.0 too).
        for o in objects:
            if o["score"] >= GOAL and o.get("box"):
                try:
                    sat = box_saturation(jpeg, o["box"], size)
                except Exception:
                    sat = None
                o["sat"] = None if sat is None else round(sat, 2)
                o["plain"] = sat is None or sat <= MAX_SATURATION
        musey = [o for o in objects if o["score"] >= GOAL and o.get("plain")]
        match_score = max((o["score"] for o in musey), default=0.0)
        top_obj = (max(musey, key=lambda o: o["score"]) if musey else
                   max(objects, key=lambda o: o["score"]) if objects else None)
        with lock:
            # Best match: the latest look's if it reached GOAL, else the best at GOAL or more in the last few looks,
            # else whatever the latest look had (shown as under the line).
            look_no = state["looks"] + 1
            recent.append({"look": look_no, "obj": top_obj, "frame": jpeg, "pan": pan, "size": size, "objs": objects,
                           "ov": ov, "moves": state["moves"]})
            good = [r for r in recent if r["obj"] and r["obj"]["score"] >= GOAL and r["obj"].get("plain")]
            if musey:
                pick = recent[-1]
            elif good:
                pick = max(good, key=lambda r: r["obj"]["score"])
            else:
                pick = recent[-1] if top_obj else None
            if pick:
                overlay["bestframe"] = pick["frame"]
                state["bestmatch"] = {"look": pick["look"], "ago": look_no - pick["look"], "score": pick["obj"]["score"],
                                      "box": pick["obj"]["box"], "size": pick["size"], "pan": pick["pan"],
                                      "plain": bool(pick["obj"].get("plain")), "sat": pick["obj"].get("sat")}
            else:
                state["bestmatch"] = None
            state["frame_t"] = t
            overlay["jpeg"] = ov or overlay["jpeg"]
            overlay["frame"] = jpeg
            overlay["base"] = base64.b64decode(base.get("overlay_jpeg_b64") or b"")
            state["last_base"] = {"objects": [{"box": o.get("box"), "score": o.get("score", 0.0)} for o in base.get("objects", [])],
                                  "size": base.get("image_size") or [640, 480], "ms": base.get("ms")}
            if sweeping:
                state["pan"] = pan  # only the sweep moves the servo on its own; never undo a pan someone else set
            state.update(mode="sweeping" if sweeping else "watching", looks=state["looks"] + 1,
                         best=max(state["best"], score),
                         last={"score": score, "count": len(objects), "ms": res.get("ms"), "weights": res.get("weights", "base"),
                               "objects": objects, "size": res.get("image_size") or [640, 480]})
        if match_score >= GOAL and not seeing:
            seeing = True
            bridge("stop")  # if it was driving, it stops on the find
            run_event.clear()
            name = save_snapshot(jpeg, ov, score, "found")
            top = max(musey, key=lambda o: o["score"])
            with lock:
                seq = (state["found"] or {}).get("seq", 0) + 1
                state["found"] = {"word": word, "score": score, "pan": pan, "snapshot": name, "box": top["box"],
                                  "size": res.get("image_size") or [640, 480], "seq": seq, "at": time.strftime("%H:%M:%S")}
        elif match_score < GOAL - 0.05:
            seeing = False  # a little below the line before it counts as gone, so one muse pings once
        with lock:
            state["seeing"] = seeing
            state["note"] = (f"\"{state['prompt']}\" is in view" if seeing else
                             f"Looking for \"{state['prompt']}\"" + (" while sweeping" if sweeping else ""))


# ---- MCP: the tools Muse Code (or any MCP client on the office network) uses to run the search ----

MCP_INSTRUCTIONS = (
    "You drive a small rover with a webcam fixed to its front (it does not pan; to look around, turn the whole rover). "
    "Every camera frame goes to two SAM 3.1 models on a Jetson: one tuned to find the Muse mascot, and Meta's own weights "
    f"for comparison. A tuned score of {GOAL:.2f} or more is a match. The goal: find the Muse mascots in the room. There are "
    f"always at least {TARGET}, maybe more; record every different one you find. People are watching a page that shows "
    "your steps, so narrate everything clearly with rover_say: before every action, say what you are about to do and why "
    "(\"Turning right a little to check the corner by the couch\"); after every look, say what both models saw and what "
    "you will do next (\"The tuned model sees a muse at 97% on the left; checking it with a photo\"). Drive actively, like you are exploring: never look twice in a row "
    "without moving, and don't stop to think between steps. Use rover_turn (small, medium, big) and rover_forward "
    "(short, medium, long); rover_drive is for anything else. Pattern: rover_turn medium, rover_look, repeat; after every "
    "two or three turns, rover_forward medium to a new spot; when the front is blocked, rover_turn big and go another "
    "way. Head toward anything that looks like a plush toy and get close to check it. What counts as a Muse: the Muse "
    "mascot character, cream and fuzzy with a round face in a hood and stubby arms; a plush, a figure or a picture of it "
    "on a screen all count. rover_photo shows a reference photo of it next to the camera's true colors. The tuned model "
    f"also scores other plush toys (a blue Stitch, a squishy round plush with a bow, animals) above {GOAL:.2f}: compare with the "
    "reference and skip anything that isn't the same character. The tuned model sometimes scores other plush toys or pictures high, so when a look shows a match, check it "
    "with rover_photo against the reference before calling rover_found. A muse already found can come into view again after a turn: compare "
    "with your earlier photos and don't record it twice. Only if the picture is clearly too dark or washed out, or a likely "
    f"muse scores just under {GOAL:.2f}, tune the webcam with rover_camera (exposure, gain, contrast, gamma, brightness), then "
    "look again. You may change the camera only once per run, so make that one change count. The person watching talks to you by voice: a microphone is "
    "transcribed the whole time, and anything that sounds like a command arrives at the top of your next tool result as "
    "VOICE COMMAND. The owner drives spoken moves (left, right, forward, back) "
    "themselves with the page's pad, so don't repeat them: rover_say \"Heard you: ...\", then rover_look and keep "
    "searching on your own from the new view. Camera requests (\"lower the exposure\") are yours, with rover_camera. "
    "Between commands, keep searching on your own. Transcripts can be rough, so "
    "take the most likely meaning. Other room talk is labelled as such; ignore it unless it is about the search. Drive at most 1500 ms at a time; the rover stops by itself 150 mm before an "
    f"obstacle. Once you have found at least {TARGET} and checked the rest of the room for more, call rover_stop, then "
    "rover_done with a one-line summary."
)


COMMAND_WORDS = re.compile(r"\b(muse|rover|go|move|drive|turn|left|right|forward|forwards|back|backward|backwards|stop|wait|"
                           r"closer|around|spin|look|over there|behind|under|camera|exposure|brighter|darker|contrast|"
                           r"faster|slower|seconds?|degrees?|again|that one|check|found|done|keep going)\b", re.I)


def _schema(props=None, required=()):
    return {"type": "object", "properties": props or {}, "required": list(required), "additionalProperties": False}


MCP_TOOLS = [
    {"name": "rover_status", "description": "What the camera sees right now (both SAM 3.1 models), where it points, and what has been found so far.",
     "inputSchema": _schema(), "annotations": {"readOnlyHint": True}},
    {"name": "rover_look", "description": "Wait for a fresh frame looked at by both SAM 3.1 models (about 3 to 6 seconds) and return what they saw. "
     "Call it after each turn or drive.", "inputSchema": _schema(), "annotations": {"readOnlyHint": True}},
    {"name": "rover_drive", "description": "Drive the wheels for a short time, then stop. left and right are wheel speeds from -200 to 200 "
     "(both positive: forward; both negative: back; opposite signs: turn in place). ms: 100 to 1500. Returns the sensors after.",
     "inputSchema": _schema({"left": {"type": "integer", "minimum": -200, "maximum": 200}, "right": {"type": "integer", "minimum": -200, "maximum": 200},
                             "ms": {"type": "integer", "minimum": 100, "maximum": 1500}}, ["left", "right", "ms"])},
    {"name": "rover_turn", "description": "Turn in place, then stop. direction: left or right. size: small (about 20 degrees), medium "
     "(about 45) or big (about 90). Rough angles; check with rover_look.",
     "inputSchema": _schema({"direction": {"type": "string", "enum": ["left", "right"]}, "size": {"type": "string", "enum": ["small", "medium", "big"]}}, ["direction"])},
    {"name": "rover_forward", "description": "Drive straight, then stop. distance: short, medium or long (about 0.6, 1 and 1.5 seconds). "
     "back: true to reverse instead. Stops by itself 150 mm before an obstacle going forward.",
     "inputSchema": _schema({"distance": {"type": "string", "enum": ["short", "medium", "long"]}, "back": {"type": "boolean"}})},
    {"name": "rover_stop", "description": "Stop the wheels now.", "inputSchema": _schema()},
    {"name": "rover_photo", "description": "The latest frame with the tuned SAM 3.1 masks drawn on it, as an image, to check a match with your own eyes.",
     "inputSchema": _schema(), "annotations": {"readOnlyHint": True}},
    {"name": "rover_found", "description": f"Record a Muse mascot you have checked. Needs a tuned match at {GOAL:.2f} or more in the last 3 looks. "
     "which: best, left, center or right (which match in the frame). note: a few words on where it is.",
     "inputSchema": _schema({"which": {"type": "string", "enum": ["best", "left", "center", "right"]}, "note": {"type": "string", "maxLength": 120}})},
    {"name": "rover_camera", "description": "Read or tune the webcam (at most one change per run). With no arguments it returns the current values and ranges. "
     "set: controls to change, from auto_exposure (3 auto, 1 manual), exposure_time_absolute (manual only), gain, brightness, "
     "contrast, gamma, saturation, sharpness, backlight_compensation. reset: true puts the webcam defaults back. The next "
     "rover_look sees the change.",
     "inputSchema": _schema({"set": {"type": "object", "additionalProperties": {"type": "integer"}}, "reset": {"type": "boolean"}})},
    {"name": "rover_hints", "description": "Every hint the person watching has spoken so far (transcribed). New ones also come with every tool result.",
     "inputSchema": _schema(), "annotations": {"readOnlyHint": True}},
    {"name": "rover_done", "description": f"Finish the search after at least {TARGET} finds: the page pings and shows Done. summary: one line.",
     "inputSchema": _schema({"summary": {"type": "string", "maxLength": 200}})},
    {"name": "rover_say", "description": "Show one short sentence to the people watching: what you are doing and why.",
     "inputSchema": _schema({"message": {"type": "string", "maxLength": 200}}, ["message"])},
]


class ToolError(Exception):
    pass


def describe(look):
    """Matches in a look, best first, with where they sit in the frame."""
    if not look:
        return []
    w, h = look.get("size") or [640, 480]
    out = []
    for o in sorted(look.get("objects") or [], key=lambda o: -o["score"]):
        if not o.get("box"):
            continue
        x0, y0, x1, y1 = o["box"]
        cx = (x0 + x1) / 2 / w
        out.append({"score": round(o["score"], 3), "match": o["score"] >= GOAL and o.get("plain") is not False,
                    **({"too_colorful_to_be_muse": True} if o.get("plain") is False else {}),
                    "side": "left" if cx < 0.36 else "right" if cx > 0.64 else "center",
                    "offset_deg": round((cx - 0.5) * FOV, 1), "size_pct": round((x1 - x0) * (y1 - y0) / (w * h) * 100, 1)})
    return out


def view():
    with lock:
        last, base = state["last"], state.get("last_base")
        out = {"word": state["prompt"], "look_number": state["looks"], "moves_so_far": state["moves"],
               "found": len(state["finds"]), "target": TARGET, "goal_score": GOAL,
               "finds": [{"n": f["n"], "score": f["score"], "bearing_deg": f["bearing"], "note": f["note"]} for f in state["finds"]]}
    out["tuned"] = describe(last)
    out["meta_weights"] = describe(base)
    return out


def short(objs):
    return ", ".join(f"{o['score'] * 100:.0f}% {o['side']}" for o in objs[:3]) or "nothing"


def wait_fresh(t0, timeout=15):
    """Wait for a look whose frame was taken after t0."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with lock:
            if state["frame_t"] >= t0:
                return True
        time.sleep(0.1)
    return False


def manual_log(left, right):
    """A drive from the page's pad, logged as the answer to what was just said (the owner clicks for voice commands)."""
    if not (left or right):
        return
    kind = ("forward" if left > 0 and right > 0 else "back" if left < 0 and right < 0 else "left" if left < right else "right")
    now = time.time()
    with lock:
        lm = state.get("manual_last") or {}
        if lm.get("kind") == kind and now - lm.get("ts", 0) < 2.0:  # one line per press, not per repeat
            lm["ts"] = now
            return
        state["manual_last"] = {"kind": kind, "ts": now}
        state["moves"] += 1
        heard = next((h["text"] for h in reversed(state["hints"]) if now - h["ts"] < 25), None)
    with lock:
        n = state["moves"]
    lines = {
        "forward": ["Driving forward to get a closer look.", "Moving ahead to a new spot.", "Heading forward to check that area."],
        "back": ["Backing up to see more of the room.", "Reversing for a wider view.", "Backing off to get everything in frame."],
        "left": ["Turning left to check that side of the room.", "Swinging left to look over there.", "Turning left toward the next spot."],
        "right": ["Turning right to check that side of the room.", "Swinging right to look over there.", "Turning right toward the next spot."],
    }[kind]
    line = lines[n % len(lines)]
    # Shown as Muse Code's own step, like any rover_say line.
    agent_log("say", ("Heard you. " + line) if heard else line)


def warmup():
    """At the start of each prompt: a quick forward, left, right, back, so the rover visibly wakes up."""
    agent_log("say", "Warming up: forward, left, right, back")
    for left, right in ((170, 170), (-170, 170), (170, -170), (-170, -170)):
        bridge("drive", left, right, 400)
        time.sleep(0.55)
    bridge("stop")
    with lock:
        state["moves"] += 1


def box_saturation(jpeg, box, size):
    """Median color saturation (0 grey to 1 vivid) of the middle of a box, decoded with gstreamer (no image libraries here)."""
    tid = threading.get_ident()  # the look loop and a find can check at the same time
    src, raw = os.path.join(CAM_DIR, f"check-{tid}.jpg"), os.path.join(CAM_DIR, f"check-{tid}.rgb")
    with open(src, "wb") as fh:
        fh.write(jpeg)
    subprocess.run(["gst-launch-1.0", "-q", "filesrc", f"location={src}", "!", "jpegdec", "!", "videoconvert", "!",
                    "video/x-raw,format=RGB", "!", "filesink", f"location={raw}"], capture_output=True, timeout=10)
    with open(raw, "rb") as fh:
        data = fh.read()
    w, h = size
    if len(data) < w * h * 3:
        return None
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    xs = range(int(max(0, x0 + bw / 4)), int(min(w, x1 - bw / 4)), 3)
    ys = range(int(max(0, y0 + bh / 4)), int(min(h, y1 - bh / 4)), 3)
    sats = []
    for y in ys:
        for x in xs:
            i = (y * w + x) * 3
            r, g, b = data[i], data[i + 1], data[i + 2]
            mx = max(r, g, b)
            sats.append(0 if mx == 0 else (mx - min(r, g, b)) / mx)
    return sorted(sats)[len(sats) // 2] if sats else None


def call_tool(name, args):
    if name == "rover_status":
        v = view()
        agent_log("call", f"rover_status: tuned {short(v['tuned'])}")
        return [{"type": "text", "text": json.dumps(v)}]
    if name == "rover_look":
        run_event.clear()
        if not wait_fresh(time.time()):
            raise ToolError("No fresh look in 15 seconds (SAM on the Jetson may be restarting). Try again.")
        v = view()
        agent_log("call", f"rover_look: tuned {short(v['tuned'])}; Meta {short(v['meta_weights'])}")
        return [{"type": "text", "text": json.dumps(v)}]
    if name == "rover_turn":
        ms = {"small": 350, "medium": 650, "big": 1100}.get(str(args.get("size") or "medium"), 650)
        sp = 170 if str(args.get("direction")) == "right" else -170
        return call_tool("rover_drive", {"left": sp, "right": -sp, "ms": ms})
    if name == "rover_forward":
        ms = {"short": 600, "medium": 1000, "long": 1500}.get(str(args.get("distance") or "medium"), 1000)
        sp = -170 if args.get("back") else 170
        return call_tool("rover_drive", {"left": sp, "right": sp, "ms": ms})
    if name == "rover_drive":
        run_event.clear()
        left = int(max(-MAX_MANUAL_SPEED, min(MAX_MANUAL_SPEED, int(args.get("left", 0)))))
        right = int(max(-MAX_MANUAL_SPEED, min(MAX_MANUAL_SPEED, int(args.get("right", 0)))))
        ms = int(max(400, min(1500, int(args.get("ms", 500)))))
        # Slow wheels barely move this rover on the tile floor: lift any nonzero speed to at least 140.
        left = (1 if left > 0 else -1) * max(140, abs(left)) if left else 0
        right = (1 if right > 0 else -1) * max(140, abs(right)) if right else 0
        answer = bridge("drive", left, right, ms) if (left or right) else bridge("stop")
        time.sleep(ms / 1000 + 0.2)
        status = bridge("status")
        with lock:
            state["moves"] += 1
        kind = "forward" if left > 0 and right > 0 else "back" if left < 0 and right < 0 else "turn" if left * right < 0 else "drive"
        agent_log("call", f"rover_drive {kind} {left}/{right} for {ms} ms" + (f" (stopped: {status.get('last_stop')})" if status.get("front_block") else ""))
        return [{"type": "text", "text": json.dumps({"sent": answer, "sensors": status.get("sensors"), "front_block": status.get("front_block"),
                                                     "last_stop": status.get("last_stop")})}]
    if name == "rover_stop":
        run_event.clear()
        bridge("stop")
        agent_log("call", "rover_stop")
        return [{"type": "text", "text": "Stopped."}]
    if name == "rover_photo":
        with lock:
            frame = overlay["frame"]
        v = view()
        agent_log("call", f"rover_photo: tuned {short(v['tuned'])}")
        out = []
        try:
            with open(REFERENCE, "rb") as fh:
                out += [{"type": "text", "text": "1. REFERENCE: this is the real Muse mascot (cream, fuzzy, a round face in a hood, stubby arms):"},
                        {"type": "image", "data": base64.b64encode(fh.read()).decode(), "mimeType": "image/jpeg"}]
        except OSError:
            pass
        out += [{"type": "text", "text": "2. CAMERA NOW (true colors). The tuned model's matches, with where they sit: " + json.dumps(v["tuned"])},
                {"type": "image", "data": base64.b64encode(frame).decode(), "mimeType": "image/jpeg"},
                {"type": "text", "text": "Record a match only if it is the same character as the reference (a plush, a figure or a "
                 "picture of it all count). Other plush toys and characters do not, whatever their score."}]
        return out
    if name == "rover_found":
        which = str(args.get("which") or "best")
        note = " ".join(str(args.get("note") or "").split())[:120]
        with lock:
            moves = state["moves"]
            finds = list(state["finds"])
            # SAM's score flickers a little from look to look: take matches from the last 3 looks since the last move.
            looks = [r for r in list(recent)[-3:] if r.get("moves") == moves]
        cands = [(r, o) for r in looks for o in r.get("objs") or [] if o.get("box") and o["score"] >= GOAL]
        if not cands:
            agent_log("call", f"rover_found refused: no match at {GOAL * 100:.0f}% or more in the last 3 looks")
            raise ToolError(f"No tuned match at {GOAL:.2f} or more in the last 3 looks since the rover last moved. Call rover_look and try again.")
        w = cands[0][0]["size"][0]
        good = [o for _, o in cands]
        def side(o):
            cx = (o["box"][0] + o["box"][2]) / 2 / w
            return "left" if cx < 0.36 else "right" if cx > 0.64 else "center"
        pick = [o for o in good if which == "best" or side(o) == which]
        if not pick:
            agent_log("call", f"rover_found refused: no match on the {which}")
            raise ToolError(f"No match at {GOAL:.2f} or more on the {which} in the last 3 looks. Matches: " + ", ".join(side(o) for o in good))
        o = max(pick, key=lambda o: o["score"])
        r = next(r for r, oo in cands if oo is o)
        last, frame, ov, pan = {"size": r["size"]}, r["frame"], r["ov"], r["pan"]
        sat = box_saturation(frame, o["box"], r["size"])
        if sat is not None and sat > MAX_SATURATION:
            agent_log("call", f"rover_found refused: too colorful for the cream Muse (saturation {sat:.2f})")
            raise ToolError(f"Not recorded: that match is too colorful to be the Muse (color saturation {sat:.2f}; the cream "
                            f"Muse is about 0.2). It is some other toy. Keep looking.")
        bearing = round(((o["box"][0] + o["box"][2]) / 2 / w - 0.5) * FOV, 1)  # degrees off the rover's nose
        for f in finds:
            if f["moves"] == moves and abs(f["bearing"] - bearing) < 10:
                raise ToolError(f"That is the same spot as find {f['n']} (the rover hasn't moved). Look somewhere else.")
        name_ = save_snapshot(frame, ov, o["score"], "muse")
        with lock:
            n = len(state["finds"]) + 1
            state["finds"].append({"n": n, "score": round(o["score"], 3), "bearing": bearing, "pan": pan, "box": o["box"],
                                   "size": (last or {}).get("size", [640, 480]), "snapshot": name_, "note": note, "moves": moves,
                                   "at": time.strftime("%H:%M:%S")})
        agent_log("found", f"Found muse {n} of {TARGET} ({o['score'] * 100:.0f}%)" + (f": {note}" if note else ""))
        left_ = TARGET - n
        return [{"type": "text", "text": f"Recorded find {n} of {TARGET}." + (f" {left_} to go." if left_ > 0 else " All found.")}]
    if name == "rover_camera":
        changing = bool(args.get("reset")) or (isinstance(args.get("set"), dict) and bool(args["set"]))
        if changing:
            with lock:
                used = state.get("cam_changes", 0)
                if used < 1:
                    state["cam_changes"] = used + 1
            if used >= 1:
                agent_log("call", "rover_camera refused: the camera was already tuned once this run")
                raise ToolError("Not changed: the camera may be tuned only once per run, and it already was. Keep searching.")
        if args.get("reset"):
            cam_set({"auto_exposure": 3})
            values = cam_set(CAM_DEFAULTS)
            agent_log("call", "rover_camera: back to webcam defaults")
        elif isinstance(args.get("set"), dict) and args["set"]:
            changes = {k: int(v) for k, v in args["set"].items() if k in CAM_CTRLS}
            if "auto_exposure" in changes:
                cam_set({"auto_exposure": changes.pop("auto_exposure")})
            values = cam_set(changes)
            agent_log("call", "rover_camera: " + ", ".join(f"{k.replace('_absolute', '').replace('_', ' ')} {values.get(k)}" for k in args["set"] if k in values))
        else:
            values = cam_get()
            agent_log("call", "rover_camera: read the settings")
        return [{"type": "text", "text": json.dumps({"values": values, "ranges": CAM_CTRLS, "defaults": CAM_DEFAULTS})}]
    if name == "rover_hints":
        with lock:
            hs = [h["text"] for h in state["hints"]]
            state["hint_sent"] = state["hint_seq"]
        return [{"type": "text", "text": json.dumps({"hints": hs}) if hs else "No hints yet."}]
    if name == "rover_done":
        with lock:
            n = len(state["finds"])
        if n < TARGET:
            raise ToolError(f"Only {n} found so far; there are at least {TARGET}. Keep looking.")
        summary = " ".join(str(args.get("summary") or "").split())[:200]
        bridge("stop")
        with lock:
            state["done"] = {"n": n, "summary": summary, "ts": time.time()}
        agent_log("found", f"Done: {n} found" + (f". {summary}" if summary else ""))
        return [{"type": "text", "text": f"Done with {n} found."}]
    if name == "rover_say":
        msg = " ".join(str(args.get("message") or "").split())[:200]
        if msg:
            agent_log("say", msg)
        return [{"type": "text", "text": "Shown."}]
    raise ToolError(f"Unknown tool {name}")


def mcp_handle(msg):
    if not isinstance(msg, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}}
    mid, method, params = msg.get("id"), msg.get("method", ""), msg.get("params") or {}
    if mid is None:
        return None  # a notification
    if method == "initialize":
        result = {"protocolVersion": params.get("protocolVersion") or "2025-06-18", "capabilities": {"tools": {}},
                  "serverInfo": {"name": "muse-rover", "version": "1.0.0"}, "instructions": MCP_INSTRUCTIONS}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": MCP_TOOLS}
    elif method == "tools/call":
        try:
            content = call_tool(params.get("name"), params.get("arguments") or {})
            with lock:
                new = [h["text"] for h in state["hints"] if h["seq"] > state["hint_sent"]]
                state["hint_sent"] = state["hint_seq"]
            cmds = [h for h in new if COMMAND_WORDS.search(h)]
            talk = [h for h in new if h not in cmds]
            if cmds:
                content.insert(0, {"type": "text", "text": "VOICE COMMAND from the person watching (spoken, transcribed). They "
                                   "drive spoken moves themselves with the page's pad, so do not repeat a move: rover_say "
                                   "'Heard you: ...', then rover_look and keep searching from the new view. Camera requests "
                                   "(exposure, brighter, contrast) you do with rover_camera. Command: " + json.dumps(cmds)})
            if talk:
                content.append({"type": "text", "text": "Room talk heard by the mic (probably not for you; use it only if it is "
                                "about the search): " + json.dumps(talk)})
            result = {"content": content}
        except ToolError as exc:
            result = {"content": [{"type": "text", "text": str(exc)}], "isError": True}
        except Exception as exc:  # a broken bridge call shouldn't kill the session
            result = {"content": [{"type": "text", "text": f"{type(exc).__name__}: {exc}"}], "isError": True}
    else:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"no method {method}"}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Find the real Muse</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
:root{
  /* The Meta AI app's light look (muse-muse template/targets/muse-app/files/app/muse-app.css). */
  --bg:#ffffff;--surface:#ffffff;--surface-2:#f3f4f5;--line:rgba(0,0,0,.1);--fg:#111112;--fg-2:rgba(0,4,9,.59);
  --accent:#0064d4;--on-accent:#fff;--tinted-bg:#e8f1fb;--tinted-fg:#0064d4;--secondary-bg:rgba(0,0,0,.05);--hover:rgba(0,0,0,.05);
  --press:rgba(0,0,0,.1);--focus:#0064d4;--progress-track:rgba(0,100,212,.2);--positive:#008200;--positive-soft:rgba(34,197,94,.15);
  --negative:#c01f37;--ai-start:#6547f5;--ai-end:#9b45f0;--ai-gradient:linear-gradient(90deg,var(--ai-start),var(--ai-end));
  --scrim:rgba(0,0,0,.6);--shadow-card:inset 0 1px 0 rgba(255,255,255,.64),0 0 2px rgba(0,0,0,.02),0 0 6px rgba(0,0,0,.03),0 6px 30px rgba(0,0,0,.07);
  --font:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--radius-lg:16px;--radius:12px;--radius-sm:8px;--pill:999px;
}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:400 15px/1.45 var(--font)}
button{font:600 15px var(--font);border:0;border-radius:var(--pill);padding:9px 18px;cursor:pointer;background:var(--secondary-bg);color:var(--fg)}
button:hover{background:var(--press)}button:focus-visible,input:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
button.primary{background:var(--accent);color:var(--on-accent)}button.primary:hover{filter:brightness(.94)}
button.tinted{background:var(--tinted-bg);color:var(--tinted-fg)}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:12px 24px;background:rgba(255,255,255,.86);backdrop-filter:blur(24px);border-bottom:1px solid var(--line)}
.title{font:600 20px/25px var(--font)}.sub{color:var(--fg-2);font-size:13px}
.chip{display:inline-flex;align-items:center;gap:6px;font:500 13px var(--font);padding:5px 12px;border-radius:var(--pill);border:1.5px solid transparent;
  background:linear-gradient(var(--surface),var(--surface)) padding-box,var(--ai-gradient) border-box}
.chip i{width:8px;height:8px;border-radius:50%;background:var(--ai-gradient)}
.spacer{flex:1}.word{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--fg-2)}
.word input{font:500 15px var(--font);color:var(--fg);width:150px;padding:8px 14px;border-radius:var(--pill);border:1px solid #8a8d91;background:var(--surface)}.ctl{display:flex;align-items:center;gap:8px;color:var(--fg-2);font-size:13px}
input[type=range]{accent-color:var(--accent)}.ctl input{width:130px}output{font-variant-numeric:tabular-nums;color:var(--fg)}
main{margin:0 auto;padding:12px 16px 40px;display:grid;gap:16px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-lg);box-shadow:var(--shadow-card)}
.card>h2{font:600 13px var(--font);color:var(--fg-2);margin:0;padding:12px 16px}
.status{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:6px 18px;padding:16px 20px}
.score{font:700 40px/1 var(--font);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.meter{height:10px;border-radius:var(--pill);background:var(--progress-track);position:relative;overflow:hidden}
.fill{height:100%;width:0;border-radius:var(--pill);background:var(--ai-gradient);transition:width .35s}
.mark{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--fg)}
.goal{color:var(--fg-2);font-size:13px}.note{grid-column:1/-1;color:var(--fg-2);font-size:13px}
.working i{display:inline-block;width:6px;height:6px;margin-right:3px;border-radius:50%;background:var(--ai-gradient);animation:pulse 1s infinite}
.working i:nth-child(2){animation-delay:.15s}.working i:nth-child(3){animation-delay:.3s}
@keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}@media (prefers-reduced-motion:reduce){.working i{animation:none}.fill{transition:none}}
[hidden]{display:none!important}
.is-found .fill{background:var(--positive)}.is-found .score{color:var(--positive)}
.stage{display:grid;grid-template-columns:minmax(0,.82fr) minmax(0,1.18fr);grid-template-rows:repeat(3,minmax(0,1fr));grid-template-areas:"agent cam" "agent tuned" "agent base";gap:12px;height:calc(100vh - 92px);min-height:560px}
.stage>.card{display:flex;flex-direction:column;min-height:0;overflow:hidden}.stage>.card>h2{padding:9px 14px}
.agent{display:flex;flex-direction:column}.agenthead{display:flex;align-items:center;gap:10px}
.mc{font:700 17px var(--font);color:var(--fg)}.count{font:700 15px var(--font);color:var(--fg);font-variant-numeric:tabular-nums}.count.done{color:var(--positive)}
button.small{padding:5px 12px;font-size:13px}.chip.live i{animation:pulse 1s infinite}
.finds{display:flex;gap:12px}.finds figure{margin:0;width:120px}
.finds canvas{width:120px;height:120px;border-radius:var(--radius);background:var(--surface-2);box-shadow:0 0 0 2px var(--positive)}
.finds figcaption{font-size:12px;color:var(--fg-2);margin-top:4px}
.mcbody{position:relative;flex:1;min-height:0;border-top:1px solid var(--line)}
.mcgrid{position:absolute;inset:0;display:grid;grid-template-columns:1.1fr 1fr}.hide-steps .mcgrid{grid-template-columns:1fr}.hide-steps .stepspane{display:none}
.chat{display:flex;flex-direction:column;min-height:0}.msgs{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:14px}
.ubub{align-self:flex-end;background:var(--surface-2);border-radius:22px;padding:10px 16px;max-width:85%;white-space:pre-wrap}
.think{display:flex;align-items:center;gap:8px;background:none;padding:0;color:var(--fg-2);font:400 15px var(--font)}.think:hover{background:none;color:var(--fg)}
.think svg{width:22px;height:22px}.think .chev{transition:transform .2s}.hide-steps .think .chev{transform:none}.think .chev{transform:rotate(180deg)}
.reply{white-space:pre-wrap;font-size:15px;line-height:1.55}.reply.pending{color:var(--fg-2)}
.composer{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--line)}
.composer input{flex:1;font:400 15px var(--font);padding:10px 16px;border-radius:var(--pill);border:1px solid var(--line);background:var(--surface-2);color:var(--fg)}
.composer button{width:40px;height:40px;padding:0;font-size:18px}
.stepspane{border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.seg{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:12px;padding:4px;border-radius:var(--pill);background:var(--surface-2)}
.seg button{padding:7px 0;background:none;font-weight:500}.seg button.on{background:var(--surface);box-shadow:0 1px 4px rgba(0,0,0,.08);font-weight:600}
.tabbody{flex:1;overflow:auto;padding:4px 16px 16px}
.timeline{list-style:none;margin:0;padding:0}.timeline li{position:relative;padding:0 0 14px 24px}
.timeline li:before{content:"";position:absolute;left:3px;top:6px;width:9px;height:9px;border-radius:50%;background:#65676b}
.timeline li:after{content:"";position:absolute;left:7px;top:20px;bottom:2px;width:1px;background:var(--line)}
.timeline li:last-child:after{display:none}.timeline li.now:before{background:var(--ai-gradient);animation:pulse 1s infinite}
.timeline li.got:before{background:var(--positive)}.timeline li.hint:before{background:var(--accent)}.timeline li.did:before{background:var(--ai-gradient)}.timeline li.did b{color:var(--ai-start)}
.ubub.hintb{background:var(--tinted-bg);color:var(--fg);font-size:14px}.mic{font-size:13px}.timeline li.done:before{background:none;border:1.5px solid #8a8d91;width:12px;height:12px;left:1px;top:4px}
.timeline b{display:block;font-weight:600;color:#3d3f42}.timeline li.got b{color:var(--positive)}
.timeline span{display:block;color:var(--fg-2);font-size:13px;line-height:1.5;margin-top:3px}
.finds{flex-wrap:wrap}
.shot{flex:1;min-height:0;margin:0 10px 10px;container-type:size;display:flex;align-items:center;justify-content:center}
.frame{position:relative;width:min(100cqw,133.33cqh);height:min(100cqh,75cqw);border-radius:var(--radius);overflow:hidden;background:var(--surface-2)}
.frame img{display:block;width:100%;height:100%;object-fit:cover;filter:contrast(var(--contrast,100%))}
.empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--fg-2);text-align:center;padding:20px}
.labels{position:absolute;inset:0;pointer-events:none}
.tag{position:absolute;transform:translateY(-100%);background:var(--scrim);color:#fff;font:600 13px/1 var(--font);padding:5px 8px;border-radius:var(--radius-sm);white-space:nowrap}
.tag.top{box-shadow:0 0 0 2px var(--ai-end)}.tag.goal{background:var(--positive)}
.best{display:flex;gap:14px;align-items:center;margin:0 10px 10px;padding:8px 12px;border-radius:var(--radius);border:1.5px solid var(--line);transition:background .3s}
.best canvas{width:84px;height:84px;border-radius:var(--radius-sm);background:var(--surface-2);flex:none}
.bt{font:600 15px var(--font);color:var(--fg-2)}.bs{font:700 26px/1.1 var(--font);font-variant-numeric:tabular-nums}.bw{font-size:13px;color:var(--fg-2)}
.best.hit{border-color:var(--positive);background:var(--positive-soft);animation:glow 1.1s ease-in-out infinite alternate}.best.hit .bt,.best.hit .bs{color:var(--positive)}
.best.flash{animation:glow .35s ease-in-out 8 alternate}
@keyframes glow{from{box-shadow:0 0 0 0 rgba(0,130,0,0),0 0 6px rgba(0,130,0,.25)}to{box-shadow:0 0 0 3px rgba(0,130,0,.35),0 0 26px rgba(0,130,0,.6)}}
button{white-space:nowrap}#micbtn.miclive{background:var(--negative);color:#fff;animation:pulse 1.4s infinite}
.hf{font:500 13px var(--font);color:var(--accent);text-decoration:none;padding:7px 12px;border-radius:var(--pill);background:var(--secondary-bg);white-space:nowrap}.hf:hover{background:var(--press)}
.camsplit{flex:1;min-height:0;display:flex}.camsplit .shot{flex:1}.mem{width:46%;flex:none;overflow:auto;padding:4px 14px 12px;border-left:1px solid var(--line);font-size:13px}
.memh{font:600 15px var(--font);margin-bottom:8px}.memh .sub{display:block;font-weight:400}
.mrow{display:flex;justify-content:space-between;gap:8px;margin-top:8px}.mrow b{font-variant-numeric:tabular-nums}
.mbar{height:8px;border-radius:var(--pill);background:var(--secondary-bg);overflow:hidden;margin-top:4px}.mbar i{display:block;height:100%;width:0;background:#65676b;transition:width .4s}.mbar i.ai{background:var(--ai-gradient)}
.stack{display:flex;height:12px;border-radius:var(--pill);overflow:hidden;margin-top:6px;background:var(--secondary-bg)}.stack i{display:block;height:100%;transition:width .4s}
.w1{background:#0064d4}.w2{background:#9b45f0}.w3{background:#9fc3ee}.legend{list-style:none;padding:0;margin:6px 0 0}.legend li{display:flex;align-items:center;gap:6px;margin-top:3px}
.legend li i{width:10px;height:10px;border-radius:3px;flex:none}.legend b{margin-left:auto;font-variant-numeric:tabular-nums}
.minipad{position:absolute;right:10px;bottom:10px;display:grid;grid-template-columns:repeat(3,42px);grid-template-rows:repeat(2,38px);gap:6px}
.minipad button{padding:0;font-size:16px;border-radius:var(--radius-sm);background:rgba(255,255,255,.85);box-shadow:0 1px 6px rgba(0,0,0,.2);user-select:none;touch-action:none}
.minipad button.held{background:var(--accent);color:#fff}
.tilebody{flex:1;min-height:0;display:flex}.tilebody .shot{flex:1}
.tilebody .best{width:32%;flex:none;flex-direction:column;align-items:flex-start;justify-content:center;margin:0 10px 10px 0}
.tilebody .best canvas{width:min(100%,130px);height:auto;aspect-ratio:1}.tilebody .base-row{width:32%;flex:none;flex-direction:column;align-items:flex-start;justify-content:center;margin:0 10px 10px 0}
.base-row{display:flex;align-items:baseline;gap:10px;margin:0 10px 10px;padding:6px 12px}
.controls{display:grid;grid-template-columns:minmax(300px,380px) 1fr;gap:16px}
.pad{display:grid;grid-template-columns:repeat(3,56px);grid-template-rows:repeat(3,48px);gap:8px;padding:0 16px}
.pad button{padding:0;font-size:18px;user-select:none;touch-action:none;border-radius:var(--radius)}
.pad button.stop{background:var(--negative);color:#fff}.pad button.held{background:var(--accent);color:#fff}
.rows{display:grid;gap:10px;padding:12px 16px 16px}
.row{display:grid;grid-template-columns:9.5em 1fr 3.4em;align-items:center;gap:12px;font-size:14px}
.row output{text-align:right}.row label{color:var(--fg)}.check{display:flex;align-items:center;gap:8px;font-size:14px}
.camgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:10px 28px;padding:4px 16px 16px}
.hint{color:var(--fg-2);font-size:12px;padding:0 16px 14px}
.snaps{display:flex;gap:12px;overflow-x:auto;padding:0 16px 16px}.snaps figure{margin:0;flex:none;width:160px}
.snaps img{width:160px;border-radius:var(--radius-sm);display:block}.snaps figcaption{font-size:12px;color:var(--fg-2);margin-top:4px}
@media (max-width:900px){.controls{grid-template-columns:1fr}.stage{grid-template-columns:1fr;grid-template-rows:none;height:auto;grid-template-areas:"agent" "cam" "tuned" "base"}.stage>.card{min-height:420px}}
</style></head><body>
<header><div><div class="title">Muse Code finds the Muse</div><div class="sub">Muse Code drives the rover; SAM 3.1 on a Jetson looks through its camera</div></div>
<span class="chip"><i></i>Meta SAM 3.1, tuned for "muse"</span>
<form class="word" id="wordform" autocomplete="off"><label for="word">Look for</label><input id="word" name="word" maxlength="60" value="muse" spellcheck="false"><button class="tinted" type="submit">Look</button></form>
<div class="spacer"></div>
<a class="hf" href="__TUNED_URL__" target="_blank" rel="noopener">&#129303; __TUNED_LABEL__</a><button class="tinted" id="membtn" onclick="toggleMem()">Jetson memory</button><button id="micbtn" onclick="toggleMic()">&#127908; Mic off</button>
<label class="ctl" for="contrast">Display contrast <input type="range" id="contrast" min="50" max="200" step="5" value="100"><output id="cval">100%</output></label>
<button onclick="setContrast(100)">Reset</button></header>
<main id="root">
<div class="stage">
<section class="card agent" id="agentcard" style="grid-area:agent"><h2 class="agenthead"><span class="mc">Muse Code</span><span class="chip" id="agentchip"><i></i><span id="agentstate">Waiting for Muse Code</span></span>
<span class="spacer"></span><span class="count" id="count"></span><button class="small" onclick="post('/reset')">Clear</button></h2>
<div class="mcbody"><div class="mcgrid">
<div class="chat"><div class="msgs" id="msgs"></div>
<form class="composer" id="askform" autocomplete="off"><input id="ask" placeholder="Ask Muse Code" aria-label="Ask Muse Code"><button class="primary" type="submit" aria-label="Send">&#8593;</button></form></div>
<aside class="stepspane"><div class="seg" role="tablist"><button type="button" class="on" data-tab="steps">Steps</button><button type="button" data-tab="finds">Finds</button></div>
<div class="tabbody" id="tab-steps"><ol class="timeline" id="timeline"></ol></div><div class="tabbody" id="tab-finds" hidden><div class="finds" id="finds"></div></div></aside>
</div></div></section>
<section class="card" id="camcard" style="grid-area:cam"><h2>Rover camera, live</h2><div class="camsplit"><div class="shot"><div class="frame"><img id="cam" alt="Live view from the rover's camera"><div class="minipad" aria-label="Drive"><span></span><button data-d="fwd" aria-label="Forward">&#9650;</button><span></span><button data-d="left" aria-label="Turn left">&#9664;</button><button data-d="back" aria-label="Back">&#9660;</button><button data-d="right" aria-label="Turn right">&#9654;</button></div></div></div>
<aside class="mem" id="mem" hidden><div class="memh">jetson-04 memory <span class="sub">Orin Nano, CPU and GPU share it</span></div>
<div class="mrow"><span>Board</span><b id="m_board">-</b></div><div class="mbar"><i id="mb_board"></i></div>
<div class="mrow"><span>SAM 3.1 service (both models)</span><b id="m_sam">-</b></div><div class="mbar"><i id="mb_sam" class="ai"></i></div>
<div class="mrow"><span>On the GPU</span><b id="m_gpu">-</b></div>
<div class="stack" id="m_stack"><i class="w1" title="Meta SAM 3.1 weights"></i><i class="w2" title="Tuned muse detector"></i><i class="w3" title="Working memory"></i></div>
<ul class="legend"><li><i class="w1"></i>Meta SAM 3.1 weights <b id="m_w1">-</b></li><li><i class="w2"></i>Tuned "muse" detector, loaded beside them <b id="m_w2">-</b></li><li><i class="w3"></i>Working memory for each look <b id="m_w3">-</b></li></ul>
<div class="mrow"><span>GPU busy</span><b id="m_load">-</b></div><div class="mrow"><span>Swap</span><b id="m_swap">-</b></div>
<div class="sub" id="m_note">Both SAM 3.1 versions run in one service; the tuned one adds only its detector.</div></aside></div></section>
<section class="card" style="grid-area:tuned"><h2 id="tunedtitle">SAM 3.1 tuned for "muse"</h2><div class="tilebody"><div class="shot"><div class="frame"><img id="sam" alt="The tuned SAM's masks on the latest frame" hidden><div class="labels" id="labels"></div>
<div class="empty" id="samempty"><strong>Starting</strong><span>Each frame goes to both models, about 3 seconds a round on the Jetson.</span></div></div></div>
<div class="best" id="bestcard"><canvas id="bestcrop" width="168" height="168" aria-label="Best match in the last few looks"></canvas><div><div class="bt" id="besttitle">Best match, last 5 looks</div><div class="bs" id="bestscore">-</div><div class="bw" id="besttext">None yet</div></div></div></div></section>
<section class="card" style="grid-area:base"><h2>SAM 3.1, Meta's weights</h2><div class="tilebody"><div class="shot"><div class="frame"><img id="base" alt="Meta's SAM 3.1 on the same frame" hidden><div class="labels" id="labelsbase"></div>
<div class="empty" id="baseempty"><strong>Starting</strong><span>Meta's SAM 3.1 gets the same frame and the same word.</span></div></div></div>
<div class="base-row"><div style="font-weight:600">Untuned</div><div class="sub" id="basetext">None yet</div></div></div></section>
</div>
<section class="card status" aria-live="polite"><div class="score" id="score">0.000</div>
<div class="meter" aria-hidden="true"><div class="fill" id="fill"></div><div class="mark" id="mark"></div></div><div class="goal" id="goal"></div>
<div class="note" id="note">Starting</div></section>
<div class="controls">
<section class="card"><h2>Drive</h2>
<div class="pad"><span></span><button data-d="fwd" aria-label="Forward">&#9650;</button><span></span>
<button data-d="left" aria-label="Turn left">&#9664;</button><button class="stop" onclick="stopDrive()" aria-label="Stop">&#9632;</button><button data-d="right" aria-label="Turn right">&#9654;</button>
<span></span><button data-d="back" aria-label="Back">&#9660;</button><span></span></div>
<div class="rows"><div class="row"><label for="speed">Speed</label><input type="range" id="speed" min="80" max="200" step="10" value="130"><output id="speedv">130</output></div>
</div>
<div class="hint">Hold a button or an arrow key to drive; let go to stop. Space stops. Looking never pauses. Nothing stops it when backing up.</div></section>
<section class="card"><h2>Camera (changes what SAM sees)</h2><div class="camgrid" id="camgrid"></div>
<div class="hint"><button class="tinted" onclick="camReset()">Webcam defaults</button> <span id="camnote"></span></div></section>
</div>
<section class="card"><h2>Snapshots</h2><div class="snaps" id="snaps"><span class="hint" style="padding:0">Saved each time the real Muse comes into view at 95% or more.</span></div></section>
</main>
<script>
const GOAL=__GOAL__;document.getElementById('mark').style.left=(GOAL*100)+'%';document.getElementById('goal').textContent='stops at '+GOAL.toFixed(2);
function post(p){return fetch(p,{method:'POST'})}
function jpost(p,b){return fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)})}
// Display contrast: a CSS filter on the two pictures only. Frames sent to SAM and the 0.95 stop never see it.
function setContrast(v){v=Math.max(50,Math.min(200,Number(v)||100));document.documentElement.style.setProperty('--contrast',v+'%');
document.getElementById('contrast').value=v;document.getElementById('cval').textContent=v+'%';try{localStorage.setItem('musehunt.contrast',String(v))}catch(e){}}
document.getElementById('contrast').addEventListener('input',e=>setContrast(e.target.value));
let savedContrast=100;try{savedContrast=localStorage.getItem('musehunt.contrast')||100}catch(e){}setContrast(savedContrast);
// The ping: Web Audio, unlocked by the first click (browsers block sound until then).
let audio=null;function unlock(){try{audio=audio||new (window.AudioContext||window.webkitAudioContext)();audio.resume()}catch(e){}}
addEventListener('pointerdown',unlock,{once:true});
function ping(){if(!audio)return;const t=audio.currentTime;[[1318.5,0],[1975.5,.12]].forEach(([f,d])=>{const o=audio.createOscillator(),g=audio.createGain();o.type='sine';o.frequency.value=f;
g.gain.setValueAtTime(0.0001,t+d);g.gain.exponentialRampToValueAtTime(0.35,t+d+.01);g.gain.exponentialRampToValueAtTime(0.0001,t+d+.6);o.connect(g).connect(audio.destination);o.start(t+d);o.stop(t+d+.65)})}
let camBusy=false;function cam(){if(camBusy)return;camBusy=true;const i=new Image();i.onload=()=>{document.getElementById('cam').src=i.src;camBusy=false};i.onerror=()=>camBusy=false;i.src='/cam.jpg?'+Date.now()}
setInterval(cam,150);
// Cut a box out of the frame SAM looked at, into a square canvas.
function crop(canvas,url,box,size){const img=new Image();img.onload=()=>{const c=canvas.getContext('2d');c.clearRect(0,0,canvas.width,canvas.height);if(!box)return;
const [w,h]=size||[img.width,img.height],sx=img.width/w,sy=img.height/h;let [x0,y0,x1,y1]=box;const pad=0.08*Math.max(x1-x0,y1-y0);
x0=Math.max(0,x0-pad);y0=Math.max(0,y0-pad);x1=Math.min(w,x1+pad);y1=Math.min(h,y1+pad);const bw=(x1-x0)*sx,bh=(y1-y0)*sy,s=Math.min(canvas.width/bw,canvas.height/bh);
c.drawImage(img,x0*sx,y0*sy,bw,bh,(canvas.width-bw*s)/2,(canvas.height-bh*s)/2,bw*s,bh*s)};img.src=url}
function drawLabels(look,id){const el=document.getElementById(id||'labels');el.innerHTML='';if(!look||!look.objects)return;
const [w,h]=look.size||[640,480];const objs=look.objects.slice().sort((a,b)=>b.score-a.score);
objs.forEach((o,i)=>{if(!o.box)return;const t=document.createElement('div');t.className='tag'+(i===0?' top':'')+(o.score>=GOAL&&o.plain!==false?' goal':'');
t.textContent=word+' '+Math.round(o.score*100)+'%'+(o.plain===false?' · not Muse (too colorful)':'');t.style.left=Math.max(0,o.box[0]/w*100)+'%';t.style.top=Math.max(6,o.box[1]/h*100)+'%';el.appendChild(t)})}
function topObject(look){return look&&look.objects&&look.objects.length?look.objects.slice().sort((a,b)=>b.score-a.score)[0]:null}
let doneShown=null;function chime(){if(!audio)return;const t=audio.currentTime;[[1046.5,0],[1318.5,.14],[1568,.28],[2093,.42]].forEach(([f,d])=>{const o=audio.createOscillator(),g=audio.createGain();o.type='sine';o.frequency.value=f;
g.gain.setValueAtTime(0.0001,t+d);g.gain.exponentialRampToValueAtTime(0.3,t+d+.01);g.gain.exponentialRampToValueAtTime(0.0001,t+d+.7);o.connect(g).connect(audio.destination);o.start(t+d);o.stop(t+d+.75)})}
let lastLooks=-1,lastSeq=null,shownBest=null,word='muse',agentSeq=-1,findsShown=null;
function esc(t){return String(t).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}
const SPARK='<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6547f5"/><stop offset="1" stop-color="#c13df0"/></linearGradient></defs><g fill="url(#sg)"><ellipse cx="12" cy="5" rx="2.6" ry="3.4"/><ellipse cx="12" cy="19" rx="2.6" ry="3.4"/><ellipse cx="5.9" cy="8.5" rx="2.6" ry="3.4" transform="rotate(-60 5.9 8.5)"/><ellipse cx="18.1" cy="15.5" rx="2.6" ry="3.4" transform="rotate(-60 18.1 15.5)"/><ellipse cx="5.9" cy="15.5" rx="2.6" ry="3.4" transform="rotate(60 5.9 15.5)"/><ellipse cx="18.1" cy="8.5" rx="2.6" ry="3.4" transform="rotate(60 18.1 8.5)"/></g></svg>';
let chatKey='';
function steps(s){const out=[];let cur=null;for(const a of s.agent){if(a.kind==='did'){out.push({t:a.text,d:[],did:true});cur=null}else if(a.kind==='hint'){out.push({t:'Heard you',d:['"'+a.text+'"'],hint:true});cur=null}else if(a.kind==='say'){cur={t:a.text,d:[]};out.push(cur)}else if(a.kind==='found'){out.push({t:a.text,d:[],got:true});cur=null}
else{if(!cur){cur={t:'Checking the rover',d:[]};out.push(cur)}cur.d.push(a.text.replace(/^rover_(\\w+):?\\s*/,(m,n)=>({look:'Looked: ',status:'Status: ',photo:'Photo: ',drive:'Drove ',stop:'Stopped',found:'',say:''}[n]||n+' ')))}}return out}
function renderAgent(s){if(s.mic!==micOn)showMic(!!s.mic);const live=s.chat.status==='running'||(s.agent_at&&s.now-s.agent_at<30);document.getElementById('agentchip').classList.toggle('live',!!live);
document.getElementById('agentstate').textContent=s.chat.status==='running'?'Muse Code is working':live?'Muse Code is connected':(s.chat.status==='done'?'Done':'Waiting for Muse Code');
const n=s.finds.length,c=document.getElementById('count');c.textContent=s.done?'Done · '+n+' found':n+' found'+(n<s.target?' · at least '+s.target:'');c.classList.toggle('done',!!s.done||n>=s.target);
if(s.done&&doneShown===false)chime();doneShown=!!s.done;
const st=steps(s),key=s.agent_seq+'|'+!!s.done+'|'+s.hints.length+'|'+s.chat.status+'|'+s.chat.reply.length+'|'+s.chat.prompt.length;
if(key!==chatKey){chatKey=key;const tl=document.getElementById('timeline');
tl.innerHTML=st.map((x,i)=>'<li class="'+(x.got?'got':x.hint?'hint':x.did?'did':'')+(s.chat.status==='running'&&i===st.length-1?' now':'')+'"><b>'+esc(x.t)+'</b>'+x.d.map(d=>'<span>'+esc(d)+'</span>').join('')+'</li>').join('')+
(s.done||s.chat.status==='done'?'<li class="done"><b>Done</b>'+(s.done&&s.done.summary?'<span>'+esc(s.done.summary)+'</span>':'')+'</li>':'')||'<li class="done"><b>No steps yet</b><span>Ask Muse Code below, or run the bridge on the laptop.</span></li>';
document.getElementById('tab-steps').scrollTop=1e9;
const m=document.getElementById('msgs');let h='';
if(s.chat.prompt)h+='<div class="ubub">'+esc(s.chat.prompt)+'</div>';
s.hints.filter(x=>x.ts>=s.chat.ts).forEach(x=>{h+='<div class="ubub hintb"><span class="mic">&#127908;</span> '+esc(x.text)+'</div>'});
if(s.chat.prompt||st.length){const last=st.length?st[st.length-1].t:'Thinking';
h+='<div><button type="button" class="think" onclick="toggleSteps()">'+SPARK+'<span>Show thinking</span><span class="chev">&#8250;</span></button></div>';
h+=s.chat.reply?'<div class="reply">'+esc(s.chat.reply)+'</div>':'<div class="reply pending"><span class="working"><i></i><i></i><i></i></span> '+esc(last)+'</div>'}
else h='<div class="reply pending">Muse Code drives the rover through its MCP tools to find the Muse mascots. Ask it below.</div>';
m.innerHTML=h;m.scrollTop=1e9}
if(findsShown!==null&&n>findsShown){ping();const bc2=document.getElementById('bestcard');bc2.classList.remove('flash');void bc2.offsetWidth;bc2.classList.add('flash');setTimeout(()=>bc2.classList.remove('flash'),3000)}
if(n!==findsShown){findsShown=n;const g=document.getElementById('finds');g.innerHTML=s.finds.length?s.finds.map(x=>'<figure><canvas width="240" height="240"></canvas><figcaption>Muse '+x.n+' · '+Math.round(x.score*100)+'%'+(x.note?' · '+esc(x.note):'')+'</figcaption></figure>').join(''):'<span class="hint" style="padding:0">Nothing found yet.</span>';
g.querySelectorAll('canvas').forEach((cv,i)=>{const x=s.finds[i];crop(cv,'/snap/'+x.snapshot+'-camera.jpg',x.box,x.size)})}}
let memTimer=null;const gb=mb=>(mb/1024).toFixed(2)+' GB';
async function memTick(){try{const j=await (await fetch('/jetson.json')).json();if(j.error){document.getElementById('m_note').textContent=j.error;return}
const set=(id,t)=>document.getElementById(id).textContent=t;set('m_board',gb(j.used_mb)+' of '+gb(j.total_mb));document.getElementById('mb_board').style.width=(j.used_mb/j.total_mb*100)+'%';
set('m_sam',gb(j.sam_rss_mb));document.getElementById('mb_sam').style.width=(j.sam_rss_mb/j.total_mb*100)+'%';
const g=j.sam_gpu_mb||0,w1=j.base_weights_mb||0,w2=j.tuned_delta_mb||0,w3=Math.max(0,g-w1-w2);set('m_gpu',gb(g));
const st=document.getElementById('m_stack').children;[w1,w2,w3].forEach((v,i)=>st[i].style.width=(g?v/g*100:0)+'%');
set('m_w1',w1+' MB');set('m_w2',w2+' MB');set('m_w3',w3+' MB');set('m_load',j.gpu_load==null?'-':j.gpu_load+'%');set('m_swap',j.swap_used_mb+' of '+j.swap_total_mb+' MB')}catch(e){}}
function toggleMem(){const m=document.getElementById('mem');m.hidden=!m.hidden;document.getElementById('membtn').classList.toggle('primary',!m.hidden);clearInterval(memTimer);if(!m.hidden){memTick();memTimer=setInterval(memTick,2000)}}
let micOn=false;function showMic(on){micOn=on;const b=document.getElementById('micbtn');b.innerHTML=on?'&#127908; Listening':'&#127908; Mic off';b.classList.toggle('miclive',on)}
async function toggleMic(){unlock();const r=await jpost('/mic',{on:!micOn});if(r.ok)showMic((await r.json()).mic)}
function toggleSteps(){document.getElementById('agentcard').classList.toggle('hide-steps')}
document.querySelectorAll('.seg button').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.seg button').forEach(x=>x.classList.toggle('on',x===b));
document.getElementById('tab-steps').hidden=b.dataset.tab!=='steps';document.getElementById('tab-finds').hidden=b.dataset.tab!=='finds'}));
document.getElementById('askform').addEventListener('submit',async e=>{e.preventDefault();unlock();const i=document.getElementById('ask'),v=i.value.trim();if(!v)return;
const r=await jpost('/ask',{prompt:v});if(r.ok){i.value='';i.placeholder='Sent. The laptop bridge starts Muse Code.'}else i.placeholder=r.status===409?'Muse Code is still working':'Type a request'})
document.getElementById('wordform').addEventListener('submit',async e=>{e.preventDefault();unlock();const v=document.getElementById('word').value.trim();if(!v)return;
const r=await jpost('/prompt',{prompt:v});if(r.ok){word=(await r.json()).prompt;document.getElementById('word').blur()}});
async function tick(){try{const s=await (await fetch('/state.json')).json();word=s.prompt||'muse';const wi=document.getElementById('word');if(document.activeElement!==wi&&wi.value!==word)wi.value=word;const root=document.getElementById('root');
const sc=s.last?s.last.score:0;document.getElementById('score').textContent=sc.toFixed(3);
document.getElementById('fill').style.width=Math.min(100,sc*100)+'%';
const searching=true;document.getElementById('note').innerHTML=(searching?'<span class="working"><i></i><i></i><i></i></span> ':'')+
s.note.replace(/[<>&]/g,'')+(s.last?' · '+s.last.ms+' ms per look on the Jetson':'')+' · looks: '+s.looks;
root.classList.toggle('is-found',!!s.found);
if(s.looks!==lastLooks&&s.looks>0){lastLooks=s.looks;const img=document.getElementById('sam'),look=s.last;img.onload=()=>{img.hidden=false;document.getElementById('samempty').hidden=true;drawLabels(look)};
img.src='/overlay.jpg?'+s.looks;const bimg=document.getElementById('base'),blook=s.last_base;if(blook){bimg.onload=()=>{bimg.hidden=false;document.getElementById('baseempty').hidden=true;drawLabels(blook,'labelsbase')};bimg.src='/overlay_base.jpg?'+s.looks;const bt=topObject(blook);document.getElementById('basetext').textContent=bt?(word+' '+Math.round(bt.score*100)+'% (stop uses the tuned one)'):'Nothing called "'+word+'"'}}
const bm=s.bestmatch,bc=document.getElementById('bestcrop');if(!bm){shownBest=null;bc.getContext('2d').clearRect(0,0,bc.width,bc.height)}else if(bm.look!==shownBest){shownBest=bm.look;crop(bc,'/bestframe.jpg?'+bm.look,bm.box,bm.size)}
{const hit=!!(bm&&bm.score>=GOAL&&bm.plain),colorful=!!(bm&&bm.score>=GOAL&&!bm.plain),card=document.getElementById('bestcard');card.classList.toggle('hit',hit);
document.getElementById('besttitle').textContent=hit?'Muse found':'Best match, last 5 looks';
document.getElementById('bestscore').textContent=bm?(hit?'':'')+Math.round(bm.score*100)+'% '+word:'Nothing yet';
document.getElementById('besttext').textContent=bm?((bm.ago===0?'In this look':bm.ago===1?'1 look ago':bm.ago+' looks ago')+(hit?' · at or over '+Math.round(GOAL*100)+'%':colorful?' · too colorful: some other toy, not the Muse':' · under '+Math.round(GOAL*100)+'%, not a match')):'Nothing called "'+word+'" in the last 5 looks'}
document.getElementById('tunedtitle').textContent='SAM 3.1 tuned for "'+word+'"';
renderAgent(s)
if(s.found){if(lastSeq===null)lastSeq=s.found.seq;else if(s.found.seq!==lastSeq){lastSeq=s.found.seq;ping()}}else if(lastSeq===null)lastSeq=0;
if(s.snapshots.length)document.getElementById('snaps').innerHTML=s.snapshots.map(n=>'<figure><img src="/snap/'+n+'-sam.jpg" alt=""><figcaption>'+n+'</figcaption></figure>').join('')}catch(e){}}
setInterval(tick,300);
// Drive: a held button or key sends a 600 ms drive every 400 ms, so the rover stops by itself if the page goes away.
const speedEl=document.getElementById('speed');speedEl.addEventListener('input',()=>document.getElementById('speedv').textContent=speedEl.value);
function wheels(d){const s=+speedEl.value,t=Math.round(s*0.8);return {fwd:[s,s],back:[-s,-s],left:[-t,t],right:[t,-t]}[d]}
let held=null,driveTimer=null;
function drive(d){const w=wheels(d);jpost('/drive',{left:w[0],right:w[1],ms:600})}
function startDrive(d,btn){if(held===d)return;stopDrive(true);held=d;if(btn)btn.classList.add('held');drive(d);driveTimer=setInterval(()=>drive(d),400)}
function stopDrive(quiet){clearInterval(driveTimer);driveTimer=null;document.querySelectorAll('.pad .held,.minipad .held').forEach(b=>b.classList.remove('held'));const was=held;held=null;if(was||!quiet)jpost('/drive',{left:0,right:0})}
document.querySelectorAll('.pad button[data-d],.minipad button[data-d]').forEach(b=>{b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);startDrive(b.dataset.d,b)});
['pointerup','pointercancel','lostpointercapture'].forEach(ev=>b.addEventListener(ev,()=>{if(held===b.dataset.d)stopDrive()}))});
const keys={ArrowUp:'fwd',ArrowDown:'back',ArrowLeft:'left',ArrowRight:'right'};
function typing(e){const t=e.target;return t&&(t.tagName==='TEXTAREA'||t.isContentEditable||(t.tagName==='INPUT'&&t.type!=='checkbox'))}
addEventListener('keydown',e=>{if(typing(e))return;const d=keys[e.key];if(d){e.preventDefault();startDrive(d,document.querySelector('.pad button[data-d='+d+']'))}else if(e.key===' '&&e.target.tagName!=='BUTTON'){e.preventDefault();stopDrive()}});
addEventListener('keyup',e=>{if(typing(e))return;const d=keys[e.key];if(d&&held===d)stopDrive()});
addEventListener('blur',()=>{if(held)stopDrive()});
// Camera settings, built from what the webcam reports.
const LABELS={auto_exposure:'Auto exposure',exposure_time_absolute:'Exposure time',gain:'Gain',brightness:'Brightness',contrast:'Contrast',gamma:'Gamma',saturation:'Saturation',sharpness:'Sharpness',backlight_compensation:'Backlight compensation'};
const DEFAULTS={auto_exposure:3,exposure_time_absolute:39,gain:32,brightness:0,contrast:33,gamma:100,saturation:58,sharpness:2,backlight_compensation:0};
let camTimer=null,camPending={};
function camSend(ch){Object.assign(camPending,ch);clearTimeout(camTimer);camTimer=setTimeout(async()=>{const b=camPending;camPending={};const r=await (await jpost('/camera',b)).json();renderCam(r.values,r.ranges)},150)}
function renderCam(values,ranges){const g=document.getElementById('camgrid');g.innerHTML='';for(const n of Object.keys(LABELS)){if(!(n in values))continue;const [lo,hi]=ranges[n];
if(n==='auto_exposure'||n==='backlight_compensation'){const on=n==='auto_exposure'?values[n]===3:values[n]===1;const row=document.createElement('label');row.className='check';
row.innerHTML='<input type="checkbox"'+(on?' checked':'')+'> '+LABELS[n];g.appendChild(row);row.querySelector('input').addEventListener('change',e=>camSend({[n]:n==='auto_exposure'?(e.target.checked?3:1):(e.target.checked?1:0)}));continue}
const off=n==='exposure_time_absolute'&&values.auto_exposure===3;const row=document.createElement('div');row.className='row';
row.innerHTML='<label for="c_'+n+'">'+LABELS[n]+'</label><input type="range" id="c_'+n+'" min="'+lo+'" max="'+hi+'" value="'+values[n]+'"'+(off?' disabled':'')+'><output>'+values[n]+'</output>';
g.appendChild(row);const inp=row.querySelector('input'),o=row.querySelector('output');inp.addEventListener('input',()=>{o.textContent=inp.value;camSend({[n]:+inp.value})})}
document.getElementById('camnote').textContent=values.auto_exposure===3?'Turn auto exposure off to set the exposure time.':'Saved on the rover and set again at each start.'}
function camReset(){camSend(DEFAULTS)}
fetch('/camera').then(r=>r.json()).then(r=>renderCam(r.values,r.ranges));
</script></body></html>"""


class Page(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _local(self):
        return self.client_address[0].startswith(("192.168.12.", "127."))

    def do_GET(self):
        if not self._local():
            return self._send(403, b"office network only", "text/plain")
        p = self.path.split("?")[0]
        if p == "/":
            page = PAGE.replace("__GOAL__", str(GOAL)).replace("__META_URL__", META_URL).replace("__TUNED_URL__", TUNED_URL or META_URL)
            page = page.replace("__TUNED_LABEL__", "Tuned weights" if TUNED_URL else "Meta SAM 3.1 on Hugging Face")
            return self._send(200, page.encode(), "text/html; charset=utf-8")
        if p == "/state.json":
            with lock:
                return self._send(200, json.dumps(dict(state, now=time.time())).encode(), "application/json")
        if p == "/jetson.json":
            try:
                body = requests.get(STATS_URL, timeout=3).content
            except Exception:
                body = b'{"error": "jetson-04 stats not reached"}'
            return self._send(200, body, "application/json")
        if p == "/bestframe.jpg":
            with lock:
                return self._send(200, overlay["bestframe"], "image/jpeg")
        if p == "/mcp":
            return self._send(405, b"", "text/plain")
        if p == "/mic":
            with lock:
                return self._send(200, json.dumps({"mic": state["mic"]}).encode(), "application/json")
        if p == "/ask/next":  # the laptop bridge picks up a prompt typed on the page
            with lock:
                ask, state["ask"] = state["ask"], None
            return self._send(200, json.dumps({"prompt": ask} if ask else {}).encode(), "application/json")
        if p == "/cam.jpg":
            return self._send(200, latest_frame() or b"", "image/jpeg")
        if p == "/camera":
            return self._send(200, json.dumps({"values": cam_get(), "ranges": CAM_CTRLS}).encode(), "application/json")
        if p in ("/overlay_base.jpg", "/frame.jpg"):
            with lock:
                return self._send(200, overlay["base" if p == "/overlay_base.jpg" else "frame"], "image/jpeg")
        if p == "/overlay.jpg":
            with lock:
                return self._send(200, overlay["jpeg"], "image/jpeg")
        if p.startswith("/snap/"):
            name = os.path.basename(p[6:])
            path = os.path.join(SNAPS, name)
            if name.endswith(".jpg") and os.path.isfile(path):
                with open(path, "rb") as fh:
                    return self._send(200, fh.read(), "image/jpeg")
        self._send(404, b"", "text/plain")

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 < n <= 16384:
            return {}
        try:
            data = json.loads(self.rfile.read(n))
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    def do_POST(self):
        if not self._local():
            return self._send(403, b"", "text/plain")
        if self.path.split("?")[0] == "/mcp":
            n = int(self.headers.get("Content-Length") or 0)
            if not 0 < n <= 65536:
                return self._send(400, b"", "text/plain")
            try:
                msg = json.loads(self.rfile.read(n))
            except ValueError:
                return self._send(400, b'{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}', "application/json")
            replies = [r for r in (mcp_handle(m) for m in msg) if r] if isinstance(msg, list) else mcp_handle(msg)
            if not replies:
                return self._send(202, b"", "text/plain")
            return self._send(200, json.dumps(replies).encode(), "application/json")
        if self.path == "/ask":
            prompt = " ".join(str(self._body().get("prompt", "")).split())[:2000]
            with lock:
                busy = state["chat"]["status"] == "running"
                if prompt and not busy:
                    state["ask"] = prompt
            if not prompt or busy:
                return self._send(409 if busy else 400, b"", "text/plain")
            return self._send(204, b"", "text/plain")
        if self.path == "/mic":  # the page's mic switch; the laptop listener records only while it is on
            on = bool(self._body().get("on"))
            with lock:
                state["mic"] = on
            return self._send(200, json.dumps({"mic": on}).encode(), "application/json")
        if self.path == "/hint":  # spoken hints, transcribed on the laptop by Muse transcribe
            text = " ".join(str(self._body().get("text", "")).split())[:300]
            if text:
                with lock:
                    state["hint_seq"] += 1
                    state["hints"].append({"seq": state["hint_seq"], "text": text, "ts": time.time()})
                    del state["hints"][:-30]
                agent_log("hint", text)
            return self._send(204, b"", "text/plain")
        if self.path == "/chat":  # Muse Code's conversation, streamed in by the laptop bridge
            body = self._body()
            ev, text = body.get("event"), str(body.get("text") or "")
            with lock:
                chat = state["chat"]
                if ev == "user":
                    state["chat"] = {"prompt": text[:2000], "reply": "", "status": "running", "ts": time.time()}
                    state["agent"], state["done"], state["cam_changes"] = [], None, 0
                    state["agent_seq"] += 1
                    threading.Thread(target=warmup, daemon=True).start()
                elif ev == "delta":
                    chat["reply"] = (chat["reply"] + text)[-6000:]
                elif ev in ("done", "error"):
                    chat["reply"] = text[-6000:] or chat["reply"]
                    chat["status"] = ev
            return self._send(204, b"", "text/plain")
        if self.path == "/reset":
            with lock:
                state["finds"], state["agent"], state["found"] = [], [], None
                state["chat"] = {"prompt": "", "reply": "", "status": "idle", "ts": 0.0}
                state["hints"], state["done"], state["hint_sent"], state["cam_changes"] = [], None, state["hint_seq"], 0
                state["agent_seq"] += 1
            return self._send(204, b"", "text/plain")
        if self.path == "/drive":
            body = self._body()
            pause_hunt("Manual control")
            left = max(-MAX_MANUAL_SPEED, min(MAX_MANUAL_SPEED, int(body.get("left", 0))))
            right = max(-MAX_MANUAL_SPEED, min(MAX_MANUAL_SPEED, int(body.get("right", 0))))
            ms = max(100, min(800, int(body.get("ms", 600))))
            answer = bridge("drive", left, right, ms) if (left or right) else bridge("stop")
            manual_log(left, right)
            return self._send(200, json.dumps(answer).encode(), "application/json")
        if self.path == "/look":
            body = self._body()
            pause_hunt("Manual control")
            pan = max(-35, min(35, int(body.get("pan", 0))))
            with lock:
                tilt = state["tilt"]
            bridge("look", pan, tilt)
            with lock:
                state["pan"] = pan
            return self._send(200, json.dumps({"pan": pan}).encode(), "application/json")
        if self.path == "/camera":
            return self._send(200, json.dumps({"values": cam_set(self._body()), "ranges": CAM_CTRLS}).encode(), "application/json")
        if self.path == "/prompt":
            word = " ".join(str(self._body().get("prompt", "")).split())[:60]
            if not word:
                return self._send(400, b'{"error": "type a word"}', "application/json")
            with lock:
                state["prompt"] = word
                state["note"] = f"Looking for \"{word}\""
            return self._send(200, json.dumps({"prompt": word}).encode(), "application/json")
        if self.path == "/start":
            run_event.set()
        elif self.path == "/stop":
            run_event.clear()
            bridge("stop")
        self._send(204, b"", "text/plain")


if __name__ == "__main__":
    cam_proc = start_camera()
    apply_saved_camera()
    threading.Thread(target=hunt, daemon=True).start()
    try:
        ThreadingHTTPServer((BIND, PORT), Page).serve_forever()
    finally:
        bridge("stop")
        cam_proc.terminate()
