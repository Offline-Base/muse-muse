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
overlay = {"jpeg": b""}
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


def ask_sam(jpeg):
    r = requests.post(f"{SAM}/segment", json={"image_b64": base64.b64encode(jpeg).decode(), "prompt": PROMPT,
                                             "tuned": "muse", "threshold": 0.3, "overlay": True}, timeout=30)
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
                        state.update(mode="found", found={"score": score, "pan": pan, "snapshot": name},
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


PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Muse hunt: SAM 3.1 on a Jetson</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--ink:#e6edf3;--muted:#8b949e;--ok:#3fb950;--accent:#58a6ff;--warn:#d29922}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.4 -apple-system,Segoe UI,sans-serif}
header{display:flex;align-items:center;gap:16px;padding:14px 22px;border-bottom:1px solid #30363d}
h1{font-size:20px;margin:0}.sub{color:var(--muted);font-size:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px 22px}
.pane{background:var(--panel);border:1px solid #30363d;border-radius:10px;overflow:hidden}
.pane h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0;padding:10px 14px}
.shot{position:relative}.labels{position:absolute;inset:0;pointer-events:none}
.tag{position:absolute;transform:translateY(-100%);background:rgba(13,17,23,.85);color:#fff;font:700 13px/1 ui-monospace,Menlo,monospace;padding:4px 7px;border-radius:5px;white-space:nowrap;border:1px solid rgba(255,255,255,.35)}
.tag.top{border-color:var(--accent)}.tag.goal{background:var(--ok);color:#06210f;border-color:var(--ok)}
.pane img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;background:#000;filter:contrast(var(--contrast,100%))}
.ctl{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:14px}.ctl input{width:140px}.ctl output{min-width:3.5em;color:var(--ink);font-variant-numeric:tabular-nums}
.bar{display:flex;gap:14px;align-items:center;padding:4px 22px 0}
.score{font:700 42px/1 ui-monospace,Menlo,monospace}.goal{color:var(--muted)}
.meter{flex:1;height:14px;background:#21262d;border-radius:7px;position:relative;overflow:hidden}
.fill{height:100%;background:var(--accent);width:0;transition:width .3s}.mark{position:absolute;top:0;bottom:0;width:2px;background:var(--warn)}
.found .fill{background:var(--ok)}.found .score{color:var(--ok)}
.banner{display:none;margin:12px 22px 0;padding:14px 18px;border-radius:10px;background:#12361f;border:1px solid var(--ok);font-size:22px;font-weight:700}
.found .banner{display:block}
button{font:600 15px inherit;padding:9px 18px;border-radius:8px;border:1px solid #30363d;background:#21262d;color:var(--ink);cursor:pointer}
button.go{background:#1f6feb;border-color:#1f6feb}
.controls{display:grid;grid-template-columns:auto 1fr;gap:16px;padding:0 22px 8px}
.card{background:var(--panel);border:1px solid #30363d;border-radius:10px;padding:12px 14px}
.card h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
.pad{display:grid;grid-template-columns:repeat(3,58px);grid-template-rows:repeat(3,52px);gap:6px}
.pad button{font-size:20px;padding:0;user-select:none;touch-action:none}.pad button.stop{background:#da3633;border-color:#da3633}
.pad button.held{background:#1f6feb;border-color:#1f6feb}
.row{display:flex;align-items:center;gap:10px;margin:8px 0 0;color:var(--muted);font-size:14px}.row input[type=range]{flex:1}
.row output{min-width:3.2em;color:var(--ink);font-variant-numeric:tabular-nums;text-align:right}
.camgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:2px 18px}
.hint{color:var(--muted);font-size:12px;margin-top:8px}
.snaps{display:flex;gap:10px;padding:8px 22px 22px;overflow-x:auto}.snaps figure{margin:0;width:180px;flex:none}
.snaps img{width:180px;border-radius:6px;display:block}.snaps figcaption{font-size:12px;color:var(--muted)}
</style></head><body>
<header><div><h1>Find the real Muse</h1><div class="sub">Rover camera &rarr; Meta SAM 3.1, tuned for "muse", on a Jetson Orin Nano</div></div>
<div style="flex:1"></div><label class="ctl" for="contrast">Contrast <input type="range" id="contrast" min="50" max="200" step="5" value="100"><output id="cval">100%</output></label><button onclick="setContrast(100)">Reset</button><button class="go" onclick="post('/start')">Start</button><button onclick="post('/stop')">Stop</button></header>
<div id="root"><div class="banner" id="banner"></div>
<div class="bar"><div class="score" id="score">0.000</div><div class="meter"><div class="fill" id="fill"></div><div class="mark" id="mark"></div></div>
<div class="goal" id="goal"></div></div>
<div class="sub" style="padding:6px 22px" id="note"></div>
<div class="grid"><div class="pane"><h2>Rover camera, live</h2><img id="cam" alt="rover camera"></div>
<div class="pane"><h2>SAM 3.1 tuned, latest look</h2><div class="shot"><img id="sam" alt="SAM mask"><div class="labels" id="labels"></div></div></div></div>
<div class="controls">
<div class="card"><h2>Drive (pauses the hunt)</h2>
<div class="pad"><span></span><button data-d="fwd" aria-label="Forward">&#9650;</button><span></span>
<button data-d="left" aria-label="Turn left">&#9664;</button><button class="stop" onclick="stopDrive()" aria-label="Stop">&#9632;</button><button data-d="right" aria-label="Turn right">&#9654;</button>
<span></span><button data-d="back" aria-label="Back">&#9660;</button><span></span></div>
<div class="row"><label for="speed">Speed</label><input type="range" id="speed" min="80" max="200" step="10" value="130"><output id="speedv">130</output></div>
<div class="row"><label for="pan">Pan</label><input type="range" id="pan" min="-35" max="35" step="5" value="0"><output id="panv">0&deg;</output></div>
<div class="hint">Hold a button or an arrow key to drive; let go to stop. Nothing stops it when backing up.</div></div>
<div class="card"><h2>Camera (changes what SAM sees)</h2><div class="camgrid" id="camgrid"></div>
<div class="row"><button onclick="camReset()">Webcam defaults</button><span class="hint" id="camnote"></span></div></div>
</div>
<div class="snaps" id="snaps"></div></div>
<script>
const GOAL=__GOAL__;document.getElementById('mark').style.left=(GOAL*100)+'%';document.getElementById('goal').textContent='stop at '+GOAL.toFixed(2);
function post(p){fetch(p,{method:'POST'})}
// Contrast is display only: a CSS filter on the two panes. The frames sent to SAM and the 0.95 stop never see it.
function setContrast(v){v=Math.max(50,Math.min(200,Number(v)||100));document.documentElement.style.setProperty('--contrast',v+'%');
document.getElementById('contrast').value=v;document.getElementById('cval').textContent=v+'%';try{localStorage.setItem('musehunt.contrast',String(v))}catch(e){}}
document.getElementById('contrast').addEventListener('input',e=>setContrast(e.target.value));
let savedContrast=100;try{savedContrast=localStorage.getItem('musehunt.contrast')||100}catch(e){}setContrast(savedContrast);
let camBusy=false;function cam(){if(camBusy)return;camBusy=true;const i=new Image();i.onload=()=>{document.getElementById('cam').src=i.src;camBusy=false};i.onerror=()=>camBusy=false;i.src='/cam.jpg?'+Date.now()}
setInterval(cam,150);
let lastLooks=-1;
async function tick(){try{const s=await (await fetch('/state.json')).json();
const sc=s.last?s.last.score:0;document.getElementById('score').textContent=(s.found?s.found.score:sc).toFixed(3);
document.getElementById('fill').style.width=Math.min(100,(s.found?s.found.score:sc)*100)+'%';
document.getElementById('note').textContent=s.note+(s.last?'  ·  '+s.last.ms+' ms per look on the Jetson  ·  weights: '+s.last.weights:'')+'  ·  looks: '+s.looks;
document.getElementById('root').className=s.mode==='found'?'found':'';
document.getElementById('banner').textContent=s.found?('Found the real Muse: '+s.found.score.toFixed(3)+' at pan '+s.found.pan+'°. Rover stopped, snapshot saved.'):'';
if(s.looks!==lastLooks){lastLooks=s.looks;const img=document.getElementById('sam'),look=s.last;img.onload=()=>drawLabels(look);img.src='/overlay.jpg?'+s.looks}
document.getElementById('snaps').innerHTML=s.snapshots.map(n=>'<figure><img src="/snap/'+n+'-sam.jpg"><figcaption>'+n+'</figcaption></figure>').join('')}catch(e){}}
setInterval(tick,300);
// A label on each detection: "muse 87%", placed at its box's top-left corner (the image keeps the frame's 4:3 shape).
function drawLabels(look){const el=document.getElementById('labels');el.innerHTML='';if(!look||!look.objects)return;
const [w,h]=look.size||[640,480];const objs=look.objects.slice().sort((a,b)=>b.score-a.score);
objs.forEach((o,i)=>{if(!o.box)return;const t=document.createElement('div');t.className='tag'+(i===0?' top':'')+(o.score>=GOAL?' goal':'');
t.textContent='muse '+Math.round(o.score*100)+'%';t.style.left=Math.max(0,o.box[0]/w*100)+'%';t.style.top=Math.max(4,o.box[1]/h*100)+'%';el.appendChild(t)})}
function jpost(p,b){return fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)})}
// Drive: a held button or key sends a 600 ms drive every 400 ms, so it keeps going while held and stops by itself if the page goes away.
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
addEventListener('keydown',e=>{if(e.target.tagName==='INPUT'&&e.target.type!=='range')return;const d=keys[e.key];if(d){e.preventDefault();startDrive(d,document.querySelector('.pad button[data-d='+d+']'))}else if(e.key===' '){e.preventDefault();stopDrive()}});
addEventListener('keyup',e=>{const d=keys[e.key];if(d&&held===d)stopDrive()});
addEventListener('blur',()=>{if(held)stopDrive()});
// Camera controls, built from what the webcam reports.
const LABELS={auto_exposure:'Auto exposure',exposure_time_absolute:'Exposure time',gain:'Gain',brightness:'Brightness',contrast:'Contrast',gamma:'Gamma',saturation:'Saturation',sharpness:'Sharpness',backlight_compensation:'Backlight compensation'};
const DEFAULTS={auto_exposure:3,exposure_time_absolute:39,gain:32,brightness:0,contrast:33,gamma:100,saturation:58,sharpness:2,backlight_compensation:0};
let camTimer=null,camPending={};
function camSend(ch){Object.assign(camPending,ch);clearTimeout(camTimer);camTimer=setTimeout(async()=>{const b=camPending;camPending={};const r=await (await jpost('/camera',b)).json();renderCam(r.values,r.ranges)},150)}
function renderCam(values,ranges){const g=document.getElementById('camgrid');g.innerHTML='';for(const n of Object.keys(LABELS)){if(!(n in values))continue;const [lo,hi]=ranges[n];const row=document.createElement('div');row.className='row';
if(n==='auto_exposure'||n==='backlight_compensation'){const on=n==='auto_exposure'?values[n]===3:values[n]===1;row.innerHTML='<label><input type="checkbox" id="c_'+n+'"'+(on?' checked':'')+'> '+LABELS[n]+'</label>';g.appendChild(row);
row.querySelector('input').addEventListener('change',e=>camSend({[n]:n==='auto_exposure'?(e.target.checked?3:1):(e.target.checked?1:0)}));continue}
const off=n==='exposure_time_absolute'&&values.auto_exposure===3;row.innerHTML='<label for="c_'+n+'" style="min-width:8.5em">'+LABELS[n]+'</label><input type="range" id="c_'+n+'" min="'+lo+'" max="'+hi+'" value="'+values[n]+'"'+(off?' disabled':'')+'><output>'+values[n]+'</output>';
g.appendChild(row);const inp=row.querySelector('input'),o=row.querySelector('output');inp.addEventListener('input',()=>{o.textContent=inp.value;camSend({[n]:+inp.value})})}
document.getElementById('camnote').textContent=values.auto_exposure===3?'Turn auto exposure off to set the exposure time.':'Saved on the rover; set again at each start.'}
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
