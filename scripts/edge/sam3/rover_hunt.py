#!/usr/bin/env python3
"""Muse hunt: the rover's camera looks for the real Muse mascot with the tuned SAM 3.1 on jetson-04.

The rover pans (and, with DRIVE=1, creeps forward a little between sweeps). Every frame goes to SAM 3.1's tuned "muse"
detector on jetson-04. The page shows the live camera beside SAM's mask picture and score. When a match reaches the
threshold (0.95), the rover stops, holds the camera on it and saves the snapshot.

Runs on the rover as user arduino. Page: http://<rover>:8799 (office network only).
"""

import base64
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
os.makedirs(SNAPS, exist_ok=True)

state = {"mode": "idle", "pan": 0, "best": 0.0, "last": None, "found": None, "looks": 0, "snapshots": [], "note": "Press Start"}
overlay = {"jpeg": b"", "base": b"", "frame": b""}
lock = threading.Lock()
run_event = threading.Event()


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
    if run_event.is_set():
        run_event.clear()
    with lock:
        if state["mode"] == "searching":
            state["mode"] = "idle"
        state["note"] = note


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
    body = {"image_b64": base64.b64encode(jpeg).decode(), "prompt": PROMPT, "threshold": 0.3, "overlay": True}
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
    while True:
        run_event.wait()
        with lock:
            state.update(mode="searching", best=0.0, found=None, note=f"Looking for \"{PROMPT}\"")
        sweep = 0
        while run_event.is_set():
            order = PANS if sweep % 2 == 0 else PANS[::-1]
            for pan in order:
                if not run_event.is_set():
                    break
                bridge("look", pan, 0)
                t = time.time()
                time.sleep(0.6)  # let the servo settle so the frame isn't blurred
                jpeg = latest_frame(after=t + 0.4)
                if jpeg is None:
                    with lock:
                        state["note"] = "No frame from the camera"
                    continue
                try:
                    res = ask_sam(jpeg)
                    base = ask_sam(jpeg, tuned=None)  # Meta's SAM 3.1 on the same frame, for the side-by-side
                except Exception as exc:  # keep hunting through a slow or restarting SAM
                    with lock:
                        state["note"] = f"SAM: {type(exc).__name__}"
                    time.sleep(1)
                    continue
                ov = base64.b64decode(res.get("overlay_jpeg_b64") or b"")
                score = max((o["score"] for o in res.get("objects", [])), default=0.0)
                with lock:
                    if ov:
                        overlay["jpeg"] = ov
                    overlay["frame"] = jpeg
                    overlay["base"] = base64.b64decode(base.get("overlay_jpeg_b64") or b"")
                    state["last_base"] = {"objects": [{"box": o.get("box"), "score": o.get("score", 0.0)} for o in base.get("objects", [])],
                                          "size": base.get("image_size") or [640, 480], "ms": base.get("ms")}
                    objects = [{"box": o.get("box"), "score": o.get("score", 0.0)} for o in res.get("objects", [])]
                    state.update(pan=pan, last={"score": score, "count": res.get("count", 0), "ms": res.get("ms"),
                                                "weights": res.get("weights", "base"), "objects": objects,
                                                "size": res.get("image_size") or [640, 480]}, looks=state["looks"] + 1)
                    new_best = score > state["best"]
                    state["best"] = max(state["best"], score)
                    state["note"] = f"pan {pan:+d}°: best match {score:.3f}"
                if new_best and score >= 0.5:
                    save_snapshot(jpeg, ov, score, "best")
                if score >= GOAL:
                    bridge("stop")
                    bridge("look", pan, 0)
                    name = save_snapshot(jpeg, ov, score, "found")
                    with lock:
                        top = max(res.get("objects", []), key=lambda o: o.get("score", 0), default={})
                    state.update(mode="found", found={"score": score, "pan": pan, "snapshot": name, "box": top.get("box"),
                                                      "size": res.get("image_size") or [640, 480]},
                                     note=f"Found the real Muse at {score:.3f}. Stopped.")
                    run_event.clear()
                    break
            else:
                sweep += 1
                if DRIVE and run_event.is_set() and sweep % 2 == 0:
                    bridge("look", 0, 0)
                    time.sleep(0.3)
                    bridge("drive", 120, 120, 500)  # a short creep; the front sensor's 150 mm stop still applies
                    time.sleep(0.8)
                continue
            break
        if state["mode"] == "searching":
            with lock:
                state.update(mode="idle", note="Stopped")


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
.spacer{flex:1}.ctl{display:flex;align-items:center;gap:8px;color:var(--fg-2);font-size:13px}
input[type=range]{accent-color:var(--accent)}.ctl input{width:130px}output{font-variant-numeric:tabular-nums;color:var(--fg)}
main{max-width:1440px;margin:0 auto;padding:18px 24px 40px;display:grid;gap:16px}
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
.found{display:none;grid-template-columns:220px 1fr;gap:18px;align-items:center;padding:16px;border-color:rgba(0,130,0,.35);background:linear-gradient(var(--positive-soft),var(--positive-soft)),var(--surface)}
.is-found .found{display:grid}.is-found .fill{background:var(--positive)}.is-found .score{color:var(--positive)}
.found canvas{width:220px;height:220px;border-radius:var(--radius);background:var(--surface-2);object-fit:contain}
.found h3{margin:0 0 4px;font:600 22px/28px var(--font)}.found p{margin:0;color:var(--fg-2)}
.media{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.shot{position:relative;margin:0 12px 12px;border-radius:var(--radius);overflow:hidden;background:var(--surface-2);aspect-ratio:4/3}
.shot img{display:block;width:100%;height:100%;object-fit:cover;filter:contrast(var(--contrast,100%))}
.empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--fg-2);text-align:center;padding:20px}
.labels{position:absolute;inset:0;pointer-events:none}
.tag{position:absolute;transform:translateY(-100%);background:var(--scrim);color:#fff;font:600 13px/1 var(--font);padding:5px 8px;border-radius:var(--radius-sm);white-space:nowrap}
.tag.top{box-shadow:0 0 0 2px var(--ai-end)}.tag.goal{background:var(--positive)}
.best{display:flex;gap:12px;align-items:center;padding:0 16px 14px}.best canvas{width:96px;height:96px;border-radius:var(--radius-sm);background:var(--surface-2)}
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
@media (max-width:900px){.media,.controls{grid-template-columns:1fr}.found{grid-template-columns:1fr}}
</style></head><body>
<header><div><div class="title">Find the real Muse</div><div class="sub">The rover's camera, looked at by a tuned SAM 3.1 on a Jetson</div></div>
<span class="chip"><i></i>Meta SAM 3.1, tuned for "muse"</span><div class="spacer"></div>
<label class="ctl" for="contrast">Display contrast <input type="range" id="contrast" min="50" max="200" step="5" value="100"><output id="cval">100%</output></label>
<button onclick="setContrast(100)">Reset</button><button class="primary" onclick="unlock();post('/start')">Start</button><button onclick="post('/stop')">Stop</button></header>
<main id="root">
<section class="card status" aria-live="polite"><div class="score" id="score">0.000</div>
<div class="meter" aria-hidden="true"><div class="fill" id="fill"></div><div class="mark" id="mark"></div></div><div class="goal" id="goal"></div>
<div class="note" id="note">Press Start</div></section>
<section class="card found" id="found" aria-live="assertive"><canvas id="foundcrop" width="440" height="440" aria-label="The real Muse, cut out of the frame"></canvas>
<div><h3 id="foundtitle">Found the real Muse</h3><p id="foundtext"></p></div></section>
<div class="media">
<section class="card"><h2>Rover camera, live</h2><div class="shot"><img id="cam" alt="Live view from the rover's camera"></div></section>
<section class="card"><h2>SAM 3.1, Meta's weights</h2><div class="shot"><img id="base" alt="Meta's SAM 3.1 on the same frame" hidden><div class="labels" id="labelsbase"></div>
<div class="empty" id="baseempty"><strong>No look yet</strong><span>Meta's SAM 3.1 gets the same frame and the same word, "muse".</span></div></div>
<div class="best"><div><div style="font-weight:600">Untuned</div><div class="sub" id="basetext">None yet</div></div></div></section>
<section class="card"><h2>SAM 3.1 tuned for "muse"</h2><div class="shot"><img id="sam" alt="The tuned SAM's masks on the latest frame" hidden><div class="labels" id="labels"></div>
<div class="empty" id="samempty"><strong>No look yet</strong><span>Press Start. Each look asks both models, about 3 to 4 seconds on the Jetson.</span></div></div>
<div class="best"><canvas id="bestcrop" width="192" height="192" aria-label="Best match so far"></canvas><div><div style="font-weight:600">Best match this look</div><div class="sub" id="besttext">None yet</div></div></div></section>
</div>
<div class="controls">
<section class="card"><h2>Drive (pauses the hunt)</h2>
<div class="pad"><span></span><button data-d="fwd" aria-label="Forward">&#9650;</button><span></span>
<button data-d="left" aria-label="Turn left">&#9664;</button><button class="stop" onclick="stopDrive()" aria-label="Stop">&#9632;</button><button data-d="right" aria-label="Turn right">&#9654;</button>
<span></span><button data-d="back" aria-label="Back">&#9660;</button><span></span></div>
<div class="rows"><div class="row"><label for="speed">Speed</label><input type="range" id="speed" min="80" max="200" step="10" value="130"><output id="speedv">130</output></div>
<div class="row"><label for="pan">Camera pan</label><input type="range" id="pan" min="-35" max="35" step="5" value="0"><output id="panv">0°</output></div></div>
<div class="hint">Hold a button or an arrow key to drive; let go to stop. Space stops. Nothing stops it when backing up.</div></section>
<section class="card"><h2>Camera (changes what SAM sees)</h2><div class="camgrid" id="camgrid"></div>
<div class="hint"><button class="tinted" onclick="camReset()">Webcam defaults</button> <span id="camnote"></span></div></section>
</div>
<section class="card"><h2>Snapshots</h2><div class="snaps" id="snaps"><span class="hint" style="padding:0">Saved when a new best match passes 50%, and when the real Muse is found.</span></div></section>
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
objs.forEach((o,i)=>{if(!o.box)return;const t=document.createElement('div');t.className='tag'+(i===0?' top':'')+(o.score>=GOAL?' goal':'');
t.textContent='muse '+Math.round(o.score*100)+'%';t.style.left=Math.max(0,o.box[0]/w*100)+'%';t.style.top=Math.max(6,o.box[1]/h*100)+'%';el.appendChild(t)})}
function topObject(look){return look&&look.objects&&look.objects.length?look.objects.slice().sort((a,b)=>b.score-a.score)[0]:null}
let lastLooks=-1,wasFound=false;
async function tick(){try{const s=await (await fetch('/state.json')).json();const root=document.getElementById('root');
const sc=s.found?s.found.score:(s.last?s.last.score:0);document.getElementById('score').textContent=sc.toFixed(3);
document.getElementById('fill').style.width=Math.min(100,sc*100)+'%';
const searching=s.mode==='searching';document.getElementById('note').innerHTML=(searching?'<span class="working"><i></i><i></i><i></i></span> ':'')+
s.note.replace(/[<>&]/g,'')+(s.last?' · '+s.last.ms+' ms per look on the Jetson':'')+' · looks: '+s.looks;
root.classList.toggle('is-found',s.mode==='found');
if(s.looks!==lastLooks&&s.looks>0){lastLooks=s.looks;const img=document.getElementById('sam'),look=s.last;img.onload=()=>{img.hidden=false;document.getElementById('samempty').hidden=true;drawLabels(look)};
img.src='/overlay.jpg?'+s.looks;const bimg=document.getElementById('base'),blook=s.last_base;if(blook){bimg.onload=()=>{bimg.hidden=false;document.getElementById('baseempty').hidden=true;drawLabels(blook,'labelsbase')};bimg.src='/overlay_base.jpg?'+s.looks;const bt=topObject(blook);document.getElementById('basetext').textContent=bt?('muse '+Math.round(bt.score*100)+'% (stop uses the tuned one)'):'Nothing called "muse"'}const top=topObject(look);crop(document.getElementById('bestcrop'),'/frame.jpg?'+s.looks,top&&top.box,look&&look.size);
document.getElementById('besttext').textContent=top?('muse '+Math.round(top.score*100)+'% at pan '+(s.pan>0?'+':'')+s.pan+'°'):'Nothing called "muse" in this look'}
if(s.mode==='found'&&s.found){if(!wasFound){wasFound=true;ping();crop(document.getElementById('foundcrop'),'/frame.jpg?found'+s.looks,s.found.box,s.found.size)}
document.getElementById('foundtitle').textContent='Found the real Muse · '+Math.round(s.found.score*1000)/10+'%';
document.getElementById('foundtext').textContent='The rover stopped at pan '+(s.found.pan>0?'+':'')+s.found.pan+'° and saved the snapshot '+s.found.snapshot+'.'}
else wasFound=false;
if(s.snapshots.length)document.getElementById('snaps').innerHTML=s.snapshots.map(n=>'<figure><img src="/snap/'+n+'-sam.jpg" alt=""><figcaption>'+n+'</figcaption></figure>').join('')}catch(e){}}
setInterval(tick,300);
// Drive: a held button or key sends a 600 ms drive every 400 ms, so the rover stops by itself if the page goes away.
const speedEl=document.getElementById('speed');speedEl.addEventListener('input',()=>document.getElementById('speedv').textContent=speedEl.value);
const panEl=document.getElementById('pan');let panTimer=null;
panEl.addEventListener('input',()=>{document.getElementById('panv').textContent=panEl.value+'°';clearTimeout(panTimer);panTimer=setTimeout(()=>jpost('/look',{pan:+panEl.value}),120)});
function wheels(d){const s=+speedEl.value,t=Math.round(s*0.8);return {fwd:[s,s],back:[-s,-s],left:[-t,t],right:[t,-t]}[d]}
let held=null,driveTimer=null;
function drive(d){const w=wheels(d);jpost('/drive',{left:w[0],right:w[1],ms:600})}
function startDrive(d,btn){if(held===d)return;stopDrive(true);held=d;if(btn)btn.classList.add('held');drive(d);driveTimer=setInterval(()=>drive(d),400)}
function stopDrive(quiet){clearInterval(driveTimer);driveTimer=null;document.querySelectorAll('.pad .held').forEach(b=>b.classList.remove('held'));const was=held;held=null;if(was||!quiet)jpost('/drive',{left:0,right:0})}
document.querySelectorAll('.pad button[data-d]').forEach(b=>{b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);startDrive(b.dataset.d,b)});
['pointerup','pointercancel','lostpointercapture'].forEach(ev=>b.addEventListener(ev,()=>{if(held===b.dataset.d)stopDrive()}))});
const keys={ArrowUp:'fwd',ArrowDown:'back',ArrowLeft:'left',ArrowRight:'right'};
addEventListener('keydown',e=>{const d=keys[e.key];if(d){e.preventDefault();startDrive(d,document.querySelector('.pad button[data-d='+d+']'))}else if(e.key===' '&&e.target.tagName!=='BUTTON'){e.preventDefault();stopDrive()}});
addEventListener('keyup',e=>{const d=keys[e.key];if(d&&held===d)stopDrive()});
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
            return self._send(200, PAGE.replace("__GOAL__", str(GOAL)).encode(), "text/html; charset=utf-8")
        if p == "/state.json":
            with lock:
                return self._send(200, json.dumps(state).encode(), "application/json")
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
        if not 0 < n <= 4096:
            return {}
        try:
            data = json.loads(self.rfile.read(n))
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    def do_POST(self):
        if not self._local():
            return self._send(403, b"", "text/plain")
        if self.path == "/drive":
            body = self._body()
            pause_hunt("Manual control")
            left = max(-MAX_MANUAL_SPEED, min(MAX_MANUAL_SPEED, int(body.get("left", 0))))
            right = max(-MAX_MANUAL_SPEED, min(MAX_MANUAL_SPEED, int(body.get("right", 0))))
            ms = max(100, min(800, int(body.get("ms", 600))))
            answer = bridge("drive", left, right, ms) if (left or right) else bridge("stop")
            return self._send(200, json.dumps(answer).encode(), "application/json")
        if self.path == "/look":
            body = self._body()
            pause_hunt("Manual control")
            pan = max(-35, min(35, int(body.get("pan", 0))))
            bridge("look", pan, 0)
            with lock:
                state["pan"] = pan
            return self._send(200, json.dumps({"pan": pan}).encode(), "application/json")
        if self.path == "/camera":
            return self._send(200, json.dumps({"values": cam_set(self._body()), "ranges": CAM_CTRLS}).encode(), "application/json")
        if self.path == "/start":
            with lock:
                state.update(found=None, best=0.0, mode="searching")
            run_event.set()
        elif self.path == "/stop":
            run_event.clear()
            bridge("stop")
            with lock:
                state.update(mode="idle", note="Stopped by hand")
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
