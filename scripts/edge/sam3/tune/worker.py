"""The office board's SAM 3.1 tune worker (jetson-03): polls the Muse Muse site for a queued run, builds the sets, scores
Meta's weights, trains, scores the tune, draws the side-by-sides, uploads them and posts the numbers. The site writes the
verdict; this sends numbers only. Standard library only (the steps it starts use the venv's torch, PIL and pycocotools).

Runs as sam-tune-worker.service with /etc/sam-tune-worker.env:
  MM_URL=https://www.musemuse.dev   WORKER_ID=jetson-03   SAM_WORKER_TOKEN=<the secret made on the board>
Optional: SAM_TUNE_HOME (/opt/sam3train/samtune), SAM_TUNE_LIB (/opt/sam3train/lib31), SAM3_ROOT
(/opt/sam3train/sam3), SAM_TUNE_PY (/opt/sam3train/venv/bin/python), SAM_TUNE_POLL_S (20), SAM_TUNE_EMPTY_NEGATIVES (0),
SAM_BLOB_HOST_SUFFIX (.public.blob.vercel-storage.com).

The worker API (lib/train/sam/, plan section 3), every call with "Authorization: Bearer <secret>":
  POST /api/train/sam/worker/next              {workerId, freeMemMb, freeDiskMb} -> 204, or 200 {run}
  POST /api/train/sam/worker/<id>/progress     {jobToken, stage, step?, steps?, line?} -> {stop}
  POST /api/train/sam/worker/<id>/upload?name= raw bytes, X-Job-Token -> {url}
  POST /api/train/sam/worker/<id>/done         {jobToken, report}
  POST /api/train/sam/worker/<id>/fail         {jobToken, reason}

Guards: no claim below 5.5 GB free memory or 300 MB free disk, or while any /opt/glimmer-train process runs. Heavy steps
run as transient units (systemd-run --unit=sam-tune-<id>... -p MemoryMax=6G), so the kernel kills them before anything
else on the board. Stop is checked between stages and every 30 s inside one. Keeps at most 2 run deltas besides muse31's,
and deletes a run's photos once it ends. Offline Base, Nov 2026.
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tunelib as T  # noqa: E402

PRIOR = "/opt/sam3train/runs/muse31/muse31_delta_fp16.pt"
# Everything the worker and its steps write is under here (sam-tune-worker.service's ReadWritePaths).
WRITE_ROOT = "/opt/sam3train"
TRUCK_KEYS = ("truck", "wheel")
PHOTO_MAX_BYTES = 8 * 2**20
HEARTBEAT_S = 30


class Stopped(Exception):
    """An admin pressed Stop, or the site no longer holds the run for this board."""


def read_json(path):
    with open(path) as f:
        return json.load(f)


def write_json(obj, path):
    with open(path, "w") as f:
        json.dump(obj, f)


def read_text(path):
    with open(path, errors="replace") as f:
        return f.read()


def log(*a):
    print("sam-tune-worker:", *a, flush=True)


def env_config(environ=os.environ):
    c = {
        "mm_url": environ.get("MM_URL", "").rstrip("/"),
        "worker_id": environ.get("WORKER_ID", ""),
        "secret": environ.get("SAM_WORKER_TOKEN", ""),
        "home": environ.get("SAM_TUNE_HOME", "/opt/sam3train/samtune"),
        "lib": environ.get("SAM_TUNE_LIB", "/opt/sam3train/lib31"),
        "sam3": environ.get("SAM3_ROOT", "/opt/sam3train/sam3"),
        "py": environ.get("SAM_TUNE_PY", "/opt/sam3train/venv/bin/python"),
        "poll_s": float(environ.get("SAM_TUNE_POLL_S", "20")),
        "empty_negatives": environ.get("SAM_TUNE_EMPTY_NEGATIVES", "0") == "1",
        "blob_suffix": environ.get("SAM_BLOB_HOST_SUFFIX", ".public.blob.vercel-storage.com"),
        "prior": environ.get("SAM_TUNE_PRIOR", PRIOR),
    }
    missing = [k for k in ("mm_url", "worker_id", "secret") if not c[k]]
    if missing:
        raise SystemExit(f"missing {', '.join(missing)} in the environment")
    return c


class NoOffsiteRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, allowed):
        self.allowed = allowed

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not self.allowed(newurl):
            raise urllib.error.HTTPError(newurl, code, "redirect to a host the worker may not read", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Api:
    def __init__(self, base, secret, timeout=30):
        self.base, self.secret, self.timeout = base, secret, timeout

    def post(self, path, body=None, raw=None, ctype="application/json", headers=None, tries=3):
        data = raw if raw is not None else json.dumps(body or {}).encode()
        h = {"Authorization": f"Bearer {self.secret}", "Content-Type": ctype, **(headers or {})}
        for i in range(tries):
            req = urllib.request.Request(self.base + path, data=data, headers=h, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    text = r.read()
                    return r.status, (json.loads(text) if text else None)
            except urllib.error.HTTPError as e:
                text = e.read()
                if e.code >= 500 and i < tries - 1:
                    time.sleep(2 * (i + 1))
                    continue
                try:
                    return e.code, json.loads(text) if text else None
                except ValueError:
                    return e.code, None
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if i == tries - 1:
                    raise
                time.sleep(2 * (i + 1))
        return 0, None


def probe_board(home):
    try:
        mem = T.mem_available_mb(read_text("/proc/meminfo"))
    except OSError:
        mem = 0
    cmds = []
    for pid in os.listdir("/proc") if os.path.isdir("/proc") else []:
        if pid.isdigit():
            try:
                cmds.append(read_text(f"/proc/{pid}/cmdline"))
            except OSError:
                pass
    os.makedirs(home, exist_ok=True)
    return mem, T.free_disk_mb(home), T.glimmer_in(cmds)


def unit_command(unit, argv, env, cwd, log_path, sandbox=True, root=WRITE_ROOT):
    """The systemd-run command for one step. A transient unit doesn't inherit sam-tune-worker.service's sandbox, so it
    gets its own: the whole disk read-only except /opt/sam3train (ProtectSystem=strict), home folders read-only, a
    private /tmp. The caches torch, Triton, CUDA and matplotlib would write under $HOME go under /opt/sam3train too.
    SAM_TUNE_UNIT_SANDBOX=0 drops the sandbox (only if a first board run shows a write it blocks)."""
    cmd = ["systemd-run", f"--unit={unit}", "--wait", "--collect", "--quiet", "-p", "MemoryMax=6G",
           "-p", "OOMScoreAdjust=600", "-p", f"WorkingDirectory={cwd}", "-p", f"StandardOutput=append:{log_path}",
           "-p", f"StandardError=append:{log_path}"]
    env = dict(env)
    if sandbox:
        cmd += ["-p", "ProtectSystem=strict", "-p", f"ReadWritePaths={root}", "-p", "ProtectHome=read-only",
                "-p", "PrivateTmp=yes", "-p", "NoNewPrivileges=yes"]
        cache = os.path.join(root, "samtune", "cache-home")
        for k, sub_dir in (("TRITON_CACHE_DIR", "triton"), ("TORCHINDUCTOR_CACHE_DIR", "inductor"),
                           ("CUDA_CACHE_PATH", "nv"), ("MPLCONFIGDIR", "matplotlib")):
            env.setdefault(k, os.path.join(cache, sub_dir))
    cmd += [f"--setenv={k}={v}" for k, v in env.items()]
    return cmd + list(argv)


def systemd_runner(unit, argv, env, cwd, log_path, tick):
    """Runs argv as a transient unit with a 6 GB memory cap, calling tick(new log lines) every 5 s. tick may raise
    Stopped, which stops the unit. Returns the unit's exit code."""
    cmd = unit_command(unit, argv, env, cwd, log_path, sandbox=os.environ.get("SAM_TUNE_UNIT_SANDBOX", "1") != "0")
    open(log_path, "a").close()
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    pos = 0
    try:
        while True:
            done = p.poll() is not None
            with open(log_path, errors="replace") as f:
                f.seek(pos)
                new = f.read()
                pos = f.tell()
            tick(new.splitlines())
            if done:
                return p.returncode
            time.sleep(5)
    except BaseException:
        subprocess.run(["systemctl", "stop", unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        p.wait(timeout=120)
        raise


class Worker:
    def __init__(self, cfg, api=None, runner=systemd_runner, probe=probe_board, sleep=time.sleep):
        self.c, self.api = cfg, api or Api(cfg["mm_url"], cfg["secret"])
        self.runner, self.probe, self.sleep = runner, probe, sleep
        self.last_guard = None
        allowed = lambda u: T.url_allowed(u, cfg["mm_url"], cfg["blob_suffix"])  # noqa: E731
        self.allowed = allowed
        self.opener = urllib.request.build_opener(NoOffsiteRedirect(allowed))

    # ---------- the loop ----------

    def forever(self):
        self.recover()
        while True:
            try:
                self.poll_once()
            except Exception as e:  # keep polling; one bad answer must not end the service
                log("poll failed:", type(e).__name__, str(e)[:200])
            self.sleep(self.c["poll_s"])

    def poll_once(self):
        mem, disk, glimmer = self.probe(self.c["home"])
        problem = T.guard_problem(mem, disk, glimmer)
        if problem:
            if problem != self.last_guard:
                log("not taking runs:", problem)
            self.last_guard = problem
            return None
        self.last_guard = None
        status, body = self.api.post("/api/train/sam/worker/next",
                                     {"workerId": self.c["worker_id"], "freeMemMb": mem, "freeDiskMb": disk})
        if status == 204 or not body or "run" not in body:
            if status not in (200, 204):
                log("next answered", status)
            return None
        return self.run(body["run"])

    # ---------- one run ----------

    def run(self, claim):
        rid, tok = claim["id"], claim["jobToken"]
        self.rid, self.tok, self.units, self.last_stage = rid, tok, [], None
        self.timings, self.t0 = {}, time.time()
        rd = os.path.join(self.c["home"], "runs", rid)
        os.makedirs(rd, exist_ok=True)
        self.save_state({"id": rid, "jobToken": tok})
        log("claimed", rid, claim.get("data"))
        try:
            problem = T.word_problem(claim.get("word")) or T.generic_problem(claim.get("generic"))
            if problem:
                raise ValueError(f"The board refused the words: {problem}.")
            if claim.get("data") not in ("builtin-muse", "uploads"):
                raise ValueError("The board doesn't know this kind of run.")
            self.progress("claimed", line=f"Claimed by {self.c['worker_id']}")
            report = self.pipeline(claim, rd)
            status, body = self.api.post(f"/api/train/sam/worker/{rid}/done", {"jobToken": tok, "report": report})
            if status != 200:
                raise RuntimeError(f"The site refused the report ({status}: {json.dumps(body)[:200]}).")
            self.progress_quiet("done")
            log("done", rid)
            return "done"
        except Stopped as e:
            self.fail(str(e) or "Stopped by an admin.")
            return "stopped"
        except Exception as e:
            log("run failed:", type(e).__name__, str(e)[:300])
            self.fail(str(e) if isinstance(e, (ValueError, RuntimeError)) else f"The board hit an error: {type(e).__name__}.")
            return "failed"
        finally:
            self.cleanup(rd)
            self.clear_state()

    def pipeline(self, claim, rd):
        c = self.c
        word, generic = claim["word"], claim["generic"]
        epochs = max(1, min(10, int(claim.get("epochs") or 4)))
        seed = int(claim.get("seed") or 20261103)
        write_json({k: claim[k] for k in ("id", "word", "generic", "data", "seed", "epochs") if k in claim}, f"{rd}/claim.json")
        # building_sets
        self.progress("building_sets", line="Getting the photos and building the sets")
        t = time.time()
        inputs = self.download(claim, rd)
        argv = [c["py"], f"{c['lib']}/build_sets.py", "--claim", f"{rd}/claim.json", "--run-dir", rd,
                "--inputs", f"{rd}/inputs.json"] + (["--empty-negatives"] if c["empty_negatives"] else [])
        write_json(inputs, f"{rd}/inputs.json")
        self.step("build", argv, rd, "building_sets")
        sets = read_json(f"{rd}/sets.json")
        self.timings["build_s"] = round(time.time() - t)
        n_train = sets["counts"]["train_images"]
        # loading_meta, scoring_meta (stage lines come from score_sets.py)
        t = time.time()
        self.step("meta", [c["py"], f"{c['lib']}/score_sets.py", "--sets", f"{rd}/sets.json", "--phase", "meta",
                           "--out", f"{rd}/meta.json", "--masks", f"{rd}/masks_meta.json",
                           "--cache", f"{c['home']}/cache"], rd, "loading_meta")
        self.timings["meta_s"] = round(time.time() - t)
        # training
        t = time.time()
        delta = os.path.join(c["home"], "deltas", f"{claim['id']}.pt")
        os.makedirs(os.path.dirname(delta), exist_ok=True)
        cfg_path, cfg_arg = self.write_config(rd, claim["id"], epochs, seed)
        steps = epochs * n_train
        self.progress("training", step=0, steps=steps, line=f"Training on {n_train} images, {epochs} epochs")
        try:
            self.step("train", [c["py"], f"{c['sam3']}/sam3/train/train.py", "-c", cfg_arg, "--use-cluster", "0",
                                "--num-gpus", "1"], rd, "training", extra_env={"SAM_TUNE_DELTA": delta},
                      steps=steps, epochs=epochs)
        finally:
            if os.path.exists(cfg_path):
                os.remove(cfg_path)
        if not os.path.exists(delta):
            raise RuntimeError("The trainer finished without writing the tuned detector.")
        self.timings["train_s"] = round(time.time() - t)
        # loading_tune, scoring_tune
        t = time.time()
        argv = [c["py"], f"{c['lib']}/score_sets.py", "--sets", f"{rd}/sets.json", "--phase", "tune",
                "--out", f"{rd}/tune.json", "--masks", f"{rd}/masks_tune.json", "--delta", delta]
        if sets["source"] == "nov3" and os.path.exists(c["prior"]):
            argv += ["--prior", c["prior"]]
        self.step("tune", argv, rd, "loading_tune")
        self.timings["tune_s"] = round(time.time() - t)
        # drawing
        self.progress("drawing", line="Drawing the side-by-sides")
        self.step("draw", [c["py"], f"{c['lib']}/sbs_draw.py", "--sets", f"{rd}/sets.json", "--meta", f"{rd}/meta.json",
                           "--tune", f"{rd}/tune.json", "--masks-meta", f"{rd}/masks_meta.json",
                           "--masks-tune", f"{rd}/masks_tune.json", "--out-dir", f"{rd}/sbs"], rd, "drawing")
        # uploading
        self.progress("uploading", line="Sending the report")
        meta, tune = read_json(f"{rd}/meta.json"), read_json(f"{rd}/tune.json")
        picks = read_json(f"{rd}/sbs/picks.json") if os.path.exists(f"{rd}/sbs/picks.json") else []
        images = []
        for p in picks:
            url = self.upload(f"{rd}/sbs/{p['file']}", p["file"], "image/jpeg")
            images.append({"url": url, "rule": p["rule"], "caption": "", "credit": p.get("credit"),
                           "license": T.short_license(p.get("license"))})
        self.timings["total_s"] = round(time.time() - self.t0)
        scores, per_image = files_for(claim, sets, meta, tune, self.c["worker_id"], self.timings)
        scores_url = self.upload_json(scores, "scores.json")
        per_url = self.upload_json(per_image, "per_image.json")
        return report_in(claim, sets, meta, tune, images, scores_url, per_url, self.c["worker_id"], self.timings, seed)

    # ---------- steps ----------

    def step(self, name, argv, rd, stage, extra_env=None, steps=None, epochs=None):
        env = {"PYTHONPATH": self.c["lib"], **(extra_env or {})}
        unit = f"sam-tune-{self.rid}-{name}"
        state = {"stage": stage, "last": time.time(), "line": None, "step": 0}

        def tick(lines):
            for ln in lines:
                ln = ln.strip()
                if ln.startswith("STAGE "):
                    st = ln.split()[1]
                    if st != state["stage"]:
                        state["stage"] = st
                        self.progress(st)
                        state["last"] = time.time()
                elif ln.startswith("LOOK "):
                    parts = ln.split()
                    state["step"], state["steps"] = int(parts[1]), int(parts[2])
                elif epochs:
                    got = T.train_step(ln, epochs)
                    if got:
                        state["step"] = got[0]
                        state["steps"] = steps or got[1]
                if ln:
                    state["line"] = ln[:200]
            if time.time() - state["last"] >= HEARTBEAT_S:
                self.progress(state["stage"], step=state.get("step"), steps=state.get("steps"),
                              line=state["line"] if epochs else None)
                state["last"] = time.time()

        self.units.append(unit)
        if stage != self.last_stage:
            self.progress(stage)
        code = self.runner(unit, argv, env, rd, f"{rd}/{name}.log", tick)
        if code != 0:
            tail = ""
            try:
                tail = read_text(f"{rd}/{name}.log")[-300:]
            except OSError:
                pass
            log(name, "exited", code, tail.replace("\n", " | "))
            raise RuntimeError(f"The {STEP_NAMES.get(name, name)} step failed on the board (exit {code}).")

    def write_config(self, rd, rid, epochs, seed):
        root = find_config_root(self.c["sam3"])
        name = "run_" + rid.replace("-", "")[:16]
        os.makedirs(os.path.join(root, "configs", "samtune"), exist_ok=True)
        path = os.path.join(root, "configs", "samtune", f"{name}.yaml")
        tmpl = read_text(os.path.join(self.c["lib"], "configs", "sam_tune.yaml.tmpl"))
        with open(path, "w") as f:
            f.write(fill_config(tmpl, f"{rd}/data", f"{rd}/train", epochs, seed, self.c["empty_negatives"]))
        return path, f"configs/samtune/{name}.yaml"

    # ---------- the site ----------

    def progress(self, stage, step=None, steps=None, line=None):
        self.last_stage = stage
        body = {"jobToken": self.tok, "stage": stage}
        if step is not None and steps:
            body["step"], body["steps"] = int(step), int(steps)
        if line:
            body["line"] = line[:200]
        status, ans = self.api.post(f"/api/train/sam/worker/{self.rid}/progress", body)
        if status == 409 or status == 404 or status == 401:
            raise Stopped("The site no longer holds this run for the board.")
        if status == 200 and ans and ans.get("stop"):
            raise Stopped("Stopped by an admin.")
        return ans

    def progress_quiet(self, stage):
        try:
            self.api.post(f"/api/train/sam/worker/{self.rid}/progress", {"jobToken": self.tok, "stage": stage}, tries=1)
        except Exception:
            pass

    def fail(self, reason):
        try:
            self.api.post(f"/api/train/sam/worker/{self.rid}/fail", {"jobToken": self.tok, "reason": reason[:500]})
        except Exception as e:
            log("could not report the failure:", type(e).__name__)

    def upload(self, path, name, ctype):
        with open(path, "rb") as f:
            raw = f.read()
        return self.upload_bytes(raw, name, ctype)

    def upload_json(self, obj, name):
        return self.upload_bytes(json.dumps(obj, separators=(",", ":")).encode(), name, "application/json")

    def upload_bytes(self, raw, name, ctype):
        if len(raw) > 400_000:
            raise RuntimeError(f"{name} is over the 400 KB upload cap.")
        status, ans = self.api.post(f"/api/train/sam/worker/{self.rid}/upload?name={quote(name)}", raw=raw, ctype=ctype,
                                    headers={"X-Job-Token": self.tok})
        if status != 200 or not ans or not ans.get("url"):
            raise RuntimeError(f"The site refused the upload of {name} ({status}).")
        return ans["url"]

    def download(self, claim, rd):
        """The run's photos and look-alikes, only from the site's host and the public Blob host."""
        os.makedirs(f"{rd}/inputs", exist_ok=True)
        out = {"photos": [], "distractors": []}
        for i, p in enumerate(claim.get("photos") or []):
            if p.get("skipped") or not p.get("box"):
                continue
            out["photos"].append({"i": i, "path": self.fetch(p["url"], f"{rd}/inputs/photo{i}"), "split": p["split"],
                                  "box": p["box"], "skipped": False})
        for i, d in enumerate(claim.get("distractors") or []):
            if not d.get("kept"):
                continue
            out["distractors"].append({"i": i, "path": self.fetch(d["url"], f"{rd}/inputs/look{i}"),
                                       "split": d["split"], "source": d.get("source")})
        return out

    def fetch(self, url, base):
        if not self.allowed(url):
            raise ValueError("A photo's address is not on the Muse Muse site or its photo store.")
        with self.opener.open(urllib.request.Request(url), timeout=60) as r:
            raw = r.read(PHOTO_MAX_BYTES + 1)
        if len(raw) > PHOTO_MAX_BYTES:
            raise ValueError("A photo is over 8 MB.")
        ext = image_ext(raw)
        if not ext:
            raise ValueError("A photo is not a JPEG, PNG or WebP image.")
        path = f"{base}.{ext}"
        with open(path, "wb") as f:
            f.write(raw)
        return path

    # ---------- housekeeping ----------

    def state_path(self):
        return os.path.join(self.c["home"], "current.json")

    def save_state(self, s):
        os.makedirs(self.c["home"], exist_ok=True)
        p = self.state_path()
        fd = os.open(p + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(s, f)
        os.replace(p + ".tmp", p)

    def clear_state(self):
        try:
            os.remove(self.state_path())
        except OSError:
            pass

    def recover(self):
        """After a restart mid-run: stop its units and tell the site, so the run doesn't wait for its lease."""
        try:
            s = read_json(self.state_path())
        except (OSError, ValueError):
            return
        self.rid, self.tok = s["id"], s["jobToken"]
        for name in ("build", "meta", "train", "tune", "draw"):
            subprocess.run(["systemctl", "stop", f"sam-tune-{self.rid}-{name}"], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)
        self.fail("The board restarted during the run.")
        self.cleanup(os.path.join(self.c["home"], "runs", self.rid))
        self.clear_state()

    def cleanup(self, rd):
        """Deletes the run's photos (inputs, training data, built test photos); keeps its logs and small results. Keeps
        at most 2 run deltas besides muse31's."""
        for sub in ("inputs", "data", "eval", "train"):
            shutil.rmtree(os.path.join(rd, sub), ignore_errors=True)
        for f in ("masks_meta.json", "masks_tune.json"):
            try:
                os.remove(os.path.join(rd, f))
            except OSError:
                pass
        ddir = os.path.join(self.c["home"], "deltas")
        if os.path.isdir(ddir):
            ds = [(os.path.join(ddir, f), os.path.getmtime(os.path.join(ddir, f))) for f in os.listdir(ddir)]
            for p in T.deltas_to_delete(ds, keep=2, protect=(self.c["prior"],)):
                os.remove(p)


STEP_NAMES = {"build": "set building", "meta": "Meta scoring", "train": "training", "tune": "tune scoring",
              "draw": "drawing"}


def image_ext(raw):
    if raw[:3] == b"\xff\xd8\xff":
        return "jpg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return None


def find_config_root(sam3_root):
    """The folder that holds configs/muse/muse31.yaml in the sam3 clone (train.py's -c is relative to it)."""
    for base, dirs, files in os.walk(sam3_root):
        if "muse31.yaml" in files and os.path.basename(base) == "muse":
            return os.path.dirname(os.path.dirname(base))
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("assets", "__pycache__")]
    raise RuntimeError("The board has no configs/muse/muse31.yaml in the sam3 clone.")


LOADER = """        coco_json_loader:
          _target_: sam3.train.data.coco_json_loaders.COCO_FROM_JSON
          include_negatives: true
          _partial_: true
"""


def fill_config(tmpl, data_root, exp_dir, epochs, seed, empty_negatives):
    out = (tmpl.replace("@@DATA_ROOT@@", data_root).replace("@@EXP_DIR@@", exp_dir)
           .replace("@@EPOCHS@@", str(int(epochs))).replace("@@SEED@@", str(int(seed)))
           .replace("@@TRAIN_LOADER@@", LOADER if empty_negatives else ""))
    if "@@" in out:
        raise RuntimeError("The trainer config template has a slot the worker doesn't fill.")
    return out


def _truck(t):
    return {k: int((t or {}).get(k, 0)) for k in TRUCK_KEYS}


def files_for(claim, sets, meta, tune, worker_id, timings):
    """scores.json and per_image.json, the two files the report links to (numbers only, no photos)."""
    settings = {**meta["settings"], **tune["settings"]}
    scores = {"what": "SAM 3.1 tune run: Meta's weights and the tuned detector on the run's test sets",
              "run": claim["id"], "word": claim["word"], "generic": claim["generic"], "board": worker_id,
              "setsSource": sets["source"], "counts": sets["counts"], "settings": settings,
              "truck": {"meta": _truck(meta["truck"].get("meta")), "tuned": _truck(tune["truck"].get("tuned"))},
              "deltaSha256": tune.get("deltaSha256", ""), "apFrom": T.AP_FROM, "countsAt": T.HI, "timings": timings}
    rows = {**meta["rows"], **tune["rows"]}
    images = []
    for set_name in ("H", "A", "B"):
        for it in sets["sets"].get(set_name, []):
            r = {"id": it["id"], "set": set_name, "license": it.get("license")}
            if it.get("coco_id") is not None:
                r["coco_id"] = it["coco_id"]
            for sid, by in rows.items():
                v = by.get(it["id"])
                if v is None:
                    continue
                if set_name == "B":
                    r[sid] = [v["found"], v["top"], v["only"], v["other"], round(v["best_x"], 3), round(v["best_other"], 3)]
                elif set_name == "A":
                    r[sid] = [v["boxes"]]
                else:
                    r[sid] = [v["found"]]
            images.append(r)
    per_image = {"key": "per setting: B [found, top, only, other boxes, best score on it, best other score]; "
                        "A [boxes]; H [found]; counts at 0.5", "images": images}
    return scores, per_image


def report_in(claim, sets, meta, tune, images, scores_url, per_url, worker_id, timings, seed):
    """The SamReportIn the board posts to /done (lib/train/sam/types.ts). Numbers only; the site writes the verdict."""
    settings = {k: v for k, v in {**meta["settings"], **tune["settings"]}.items() if k in T.SETTINGS}
    rep = {"version": 1, "word": claim["word"], "generic": claim["generic"], "seed": int(seed),
           "setsSource": sets["source"], "settings": settings,
           "truck": {"meta": _truck(meta["truck"].get("meta")), "tuned": _truck(tune["truck"].get("tuned"))},
           "images": images, "files": {"scores": scores_url, "perImage": per_url},
           "deltaSha256": tune.get("deltaSha256", ""), "workerId": worker_id, "apFrom": T.AP_FROM,
           "timings": {k: float(v) for k, v in timings.items()}}
    if len(json.dumps(rep).encode()) > 65_536:
        raise RuntimeError("The report is over 64 KB.")
    return rep


def main():
    Worker(env_config()).forever()


if __name__ == "__main__":
    main()
