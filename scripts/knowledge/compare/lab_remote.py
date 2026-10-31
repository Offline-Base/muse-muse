"""The lab machine's side of the compare lab (docs/COMPARE.md). lab.py copies this file to {remote_dir} on the rented
GPU machine and runs it there over ssh. It never runs on the Mac: main() exits on macOS.

    python3 -I lab_remote.py build-start --tag T --commit C   build llama-server in the background (idempotent)
    python3 -I lab_remote.py build-status                     the build's state as one JSON line
    python3 -I lab_remote.py fetch                            download models named on stdin (JSON lines), sha256-checked
    python3 -I lab_remote.py start < spec.json                start one llama-server from a spec lab.py wrote
    python3 -I lab_remote.py stop NAME | stop-all             stop servers this file started
    python3 -I lab_remote.py ps | gpu | info                  servers, GPU memory, disk and files
    python3 -I lab_remote.py logs NAME                        at most 40 filtered lines of logs/NAME.log

Rules it keeps: URLs arrive only on stdin and stay in memory (never in argv, a file or a subprocess); downloads use
urllib only; every output is a JSON line without URLs or exception text; servers bind 127.0.0.1 and never get -v,
--log-prompts-dir or --slot-save-path; log lines with "unparsed" or "output:" are never printed (they can hold model
text). It deletes only files it created under {remote_dir}. Python 3.10, standard library only.
"""

import argparse
import hashlib
import http.client
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

RD = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(RD, "models")
LOGS = os.path.join(RD, "logs")
RUN = os.path.join(RD, "run")
BUILD_JSON = os.path.join(RD, "build.json")
UA = "muse-compare-lab"
STREAMS = 8
CHUNK = 4 << 20
URL_WAIT_S = 900
NAME_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
FORBIDDEN = ("-v", "--verbose", "--log-verbose", "-lv", "--verbosity", "--log-verbosity", "--log-prompts-dir",
             "--slot-save-path", "--slots", "--api-key", "--api-key-file", "--webui", "--ui")
LOG_KEEP = re.compile(r"error|fail|cuda|out of memory|loaded|listening|template", re.I)
LOG_DROP = ("unparsed", "output:")
URL_RE = re.compile(r"https?://\S+")

_out = threading.Lock()
_active = []  # Fetch objects in progress, so a lost Mac side can save their progress before exiting


def _abandon():
    """The Mac side is gone (stdout broken or stdin closed without "done"): save progress and exit at once, so a
    resumed `lab.py up` is the only writer of each .part file."""
    for f in list(_active):
        try:
            f.save_progress()
        except Exception:
            pass
    os._exit(3)


def say(obj):
    with _out:
        try:
            sys.stdout.write(json.dumps(obj) + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, OSError, ValueError):
            _abandon()


def lcpp_dir(tag, rd=None):
    return os.path.join(rd or RD, f"llama.cpp-{tag}")


# ---- build ----

def _read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _write_json(path, value):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(value, f)
    os.replace(tmp, path)


def _alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def build_start(tag, commit):
    st = _read_json(BUILD_JSON)
    server = os.path.join(lcpp_dir(tag), "build", "bin", "llama-server")
    if st.get("state") == "ok" and st.get("commit") == commit and os.access(server, os.X_OK):
        say({"build": "ok", "commit": commit, "skipped": True})
        return 0
    if st.get("state") == "running" and _alive(st.get("pid")):
        say({"build": "running", "pid": st["pid"]})
        return 0
    os.makedirs(LOGS, exist_ok=True)
    with open(os.path.join(LOGS, "build.log"), "ab") as log:
        p = subprocess.Popen([sys.executable, "-I", os.path.abspath(__file__), "build", "--tag", tag, "--commit", commit],
                             stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, cwd=RD)
    _write_json(BUILD_JSON, {"state": "running", "pid": p.pid, "started": time.time(), "tag": tag})
    say({"build": "started", "pid": p.pid})
    return 0


def build(tag, commit):
    began = time.time()
    status = {"state": "running", "pid": os.getpid(), "started": began, "tag": tag, "step": "clone"}
    _write_json(BUILD_JSON, status)

    def fail(step, why):
        status.update(state="failed", step=step, why=why[:200], seconds=round(time.time() - began))
        _write_json(BUILD_JSON, status)
        print(f"build failed at {step}: {why[:200]}", flush=True)
        return 1

    lcpp = lcpp_dir(tag)
    env = dict(os.environ)
    env.pop("HF_TOKEN", None)
    env.pop("HUGGING_FACE_HUB_TOKEN", None)
    # Lambda Stack ships the Debian-style toolkit (nvcc in /usr/bin, headers in /usr/include, /usr/local/cuda a thin
    # link farm without them). Putting /usr/local/cuda/bin first makes CMake look for cuda_runtime.h under
    # /usr/local/cuda/include and fail, so that folder is added only when no nvcc is on PATH already.
    paths = [os.path.expanduser("~/.local/bin")]
    if not shutil.which("nvcc", path=env.get("PATH", "")) and os.path.isdir("/usr/local/cuda/bin"):
        paths.append("/usr/local/cuda/bin")
    env["PATH"] = os.pathsep.join(paths + [env.get("PATH", "")])
    if not os.path.isdir(os.path.join(lcpp, ".git")):
        clone = lcpp + ".clone"
        if os.path.isdir(clone):
            shutil.rmtree(clone)
        r = subprocess.run(["git", "clone", "-q", "--depth", "1", "--branch", tag, "https://github.com/ggml-org/llama.cpp", clone], env=env)
        if r.returncode != 0:
            return fail("clone", f"git clone exit {r.returncode}")
        os.rename(clone, lcpp)
    head = subprocess.run(["git", "-C", lcpp, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    if head != commit:
        return fail("commit", f"{tag} is at {head[:12]}, not {commit[:12]}")
    status.update(step="configure", commit=head)
    _write_json(BUILD_JSON, status)
    cap = subprocess.run(["nvidia-smi", "--query-gpu=compute_cap", "--format=csv,noheader"], capture_output=True, text=True).stdout
    cap = (cap.strip().splitlines() or [""])[0].replace(".", "").strip()
    if not cap.isdigit():
        return fail("configure", "no CUDA compute capability from nvidia-smi")
    cmake = shutil.which("cmake", path=env["PATH"])
    if not cmake:
        cmake = os.path.join(RD, "cmake-venv", "bin", "cmake")
        if not os.access(cmake, os.X_OK):
            uv = shutil.which("uv", path=env["PATH"])
            if not uv:
                r = subprocess.run("curl -LsSf https://astral.sh/uv/0.13.1/install.sh | sh", shell=True, env=env)
                uv = shutil.which("uv", path=env["PATH"])
                if r.returncode != 0 or not uv:
                    return fail("configure", "no cmake and uv could not be installed")
            r1 = subprocess.run([uv, "venv", "-q", os.path.join(RD, "cmake-venv"), "--python", "3.12"], env=env)
            r2 = subprocess.run([uv, "pip", "install", "-q", "--python", os.path.join(RD, "cmake-venv", "bin", "python"), "cmake==3.31.6"], env=env)
            if r1.returncode or r2.returncode or not os.access(cmake, os.X_OK):
                return fail("configure", "uv could not install cmake")
    bdir = os.path.join(lcpp, "build")
    # A configure that failed before leaves its cache (with the wrong toolkit paths); start that step clean.
    if not os.access(os.path.join(bdir, "bin", "llama-server"), os.X_OK):
        for stale in ("CMakeCache.txt", "CMakeFiles"):
            p = os.path.join(bdir, stale)
            if os.path.isdir(p):
                shutil.rmtree(p)
            elif os.path.exists(p):
                os.remove(p)
    nvcc = shutil.which("nvcc", path=env["PATH"])
    r = subprocess.run([cmake, "-S", lcpp, "-B", bdir, "-DGGML_CUDA=ON", f"-DCMAKE_CUDA_ARCHITECTURES={cap}",
                        "-DCMAKE_BUILD_TYPE=Release", "-DLLAMA_CURL=OFF", "-DLLAMA_BUILD_TESTS=OFF"]
                       + ([f"-DCMAKE_CUDA_COMPILER={nvcc}"] if nvcc else []), env=env)
    if r.returncode != 0:
        return fail("configure", f"cmake exit {r.returncode}")
    status.update(step="compile", cuda_arch=cap)
    _write_json(BUILD_JSON, status)
    r = subprocess.run([cmake, "--build", bdir, "-j", str(os.cpu_count() or 8), "--target", "llama-server"], env=env)
    server = os.path.join(bdir, "bin", "llama-server")
    if r.returncode != 0 or not os.access(server, os.X_OK):
        return fail("compile", f"cmake --build exit {r.returncode}")
    status.update(state="ok", step="done", seconds=round(time.time() - began))
    _write_json(BUILD_JSON, status)
    print(f"build ok: {server} at {head[:12]} for CUDA {cap} in {status['seconds']} s", flush=True)
    return 0


def build_status():
    st = _read_json(BUILD_JSON)
    if st.get("state") == "running" and not _alive(st.get("pid")):
        st["state"] = "failed"
        st["why"] = "the build process ended without finishing"
    say({"build": st.get("state", "none"), **{k: st[k] for k in ("step", "commit", "cuda_arch", "seconds", "why") if k in st}})
    return 0


# ---- fetch ----

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def hf_resolve(repo, revision, file, want_bytes=None, want_sha=None, opener=None):
    """The download target for one Hugging Face file, with no token. Checks size, sha256 and commit headers."""
    url = f"https://huggingface.co/{repo}/resolve/{revision}/{urllib.parse.quote(file)}"
    opener = opener or urllib.request.build_opener(_NoRedirect)
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with opener.open(req, timeout=60) as r:
            return url, dict(r.headers)
    except urllib.error.HTTPError as e:
        if e.code not in (301, 302, 303, 307, 308):
            raise
        h = e.headers
        size, etag, commit = h.get("X-Linked-Size"), (h.get("X-Linked-ETag") or "").strip('"'), h.get("X-Repo-Commit")
        if want_bytes and size and int(size) != int(want_bytes):
            raise ValueError("size header differs")
        if want_sha and etag and len(etag) == 64 and etag != want_sha:
            raise ValueError("sha256 header differs")
        if commit and len(revision) == 40 and commit != revision:
            raise ValueError("commit header differs")
        return urllib.parse.urljoin(url, h.get("Location") or ""), dict(h)


class Fetch:
    """One file: STREAMS ranged GETs into models/FILE.part, resumable, then sha256, then rename."""

    def __init__(self, spec, models_dir=MODELS, streams=STREAMS, resolve=hf_resolve, url_wait=URL_WAIT_S, min_range=64 << 20):
        self.file = spec["file"]
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.gguf", self.file):
            raise ValueError("bad file name")
        self.bytes, self.sha = int(spec["bytes"]), spec["sha256"]
        self.hf = spec.get("hf")
        self.dir = models_dir
        self.dest = os.path.join(models_dir, self.file)
        self.part = self.dest + ".part"
        self.prog = self.part + ".json"
        self.streams, self.resolve, self.url_wait, self.min_range = streams, resolve, url_wait, min_range
        self.cond = threading.Condition()
        self.url, self.gen, self.asked = spec.get("s3_url"), 0, -1
        self.failed = None
        self.offsets = []

    def new_url(self, url):
        with self.cond:
            self.url = url
            self.gen += 1
            self.cond.notify_all()

    def _current(self):
        with self.cond:
            if self.hf and self.url is None:
                self._resolve_locked()
            return self.url, self.gen

    def _resolve_locked(self):
        url, _ = self.resolve(self.hf["repo"], self.hf["revision"], self.hf["file"], self.bytes, self.sha)
        self.url = url
        self.gen += 1

    def _refresh(self, gen, status):
        """The URL of generation `gen` was refused: get a newer one (HF: resolve again; S3: ask lab.py on stdout)."""
        with self.cond:
            if self.gen != gen:
                return
            if self.hf:
                self._resolve_locked()
                return
            if self.asked != gen:
                self.asked = gen
                say({"need": self.file, "status": status})
            end = time.monotonic() + self.url_wait
            while self.gen == gen and time.monotonic() < end:
                self.cond.wait(5)
            if self.gen == gen:
                raise TimeoutError("no new URL")

    def _ranges(self):
        n = max(1, min(self.streams, self.bytes // self.min_range or 1))
        step = -(-self.bytes // n)
        return [(i * step, min(self.bytes, (i + 1) * step) - 1) for i in range(n) if i * step < self.bytes]

    def _range(self, i, end, fd):
        tries = 0
        while self.offsets[i] <= end and not self.failed:
            url, gen = self._current()
            pos = self.offsets[i]
            try:
                req = urllib.request.Request(url, headers={"Range": f"bytes={pos}-{end}", "User-Agent": UA})
                with urllib.request.urlopen(req, timeout=120) as r:
                    if r.status != 206:
                        raise http.client.HTTPException("not a range reply")
                    total = (r.headers.get("Content-Range") or "").rpartition("/")[2]
                    if total.isdigit() and int(total) != self.bytes:
                        self.failed = {"err": self.file, "status": "size"}
                        return
                    while True:
                        chunk = r.read(CHUNK)
                        if not chunk:
                            break
                        os.pwrite(fd, chunk, pos)
                        pos += len(chunk)
                        self.offsets[i] = pos
                        tries = 0
            except urllib.error.HTTPError as e:
                if e.code in (401, 403, 410):
                    tries += 1
                    if tries > 6:
                        self.failed = {"err": self.file, "status": e.code}
                        return
                    try:
                        self._refresh(gen, e.code)
                    except Exception as e2:
                        self.failed = {"err": self.file, "status": type(e2).__name__}
                        return
                    continue
                tries += 1
                if tries > 8:
                    self.failed = {"err": self.file, "status": e.code}
                    return
                time.sleep(min(60, 2 ** tries))
            except Exception as e:
                tries += 1
                if tries > 8:
                    self.failed = {"err": self.file, "status": type(e).__name__}
                    return
                time.sleep(min(60, 2 ** tries))

    def _save_progress(self, ranges):
        _write_json(self.prog, {"bytes": self.bytes, "sha256": self.sha, "ranges": ranges, "offsets": list(self.offsets)})

    def save_progress(self):
        if getattr(self, "range_list", None) and self.offsets:
            self._save_progress(self.range_list)

    def run(self, lock_wait=180):
        """One writer per file: a second fetch of the same file waits for the first to finish or exit."""
        import fcntl
        os.makedirs(self.dir, exist_ok=True)
        with open(self.dest + ".lock", "a") as lock:
            end = time.monotonic() + lock_wait
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() >= end:
                        return {"err": self.file, "status": "another fetch of this file is running"}
                    time.sleep(2)
            _active.append(self)
            try:
                return self._run()
            finally:
                _active.remove(self)

    def _run(self):
        ok_file = self.dest + ".ok"
        if os.path.exists(self.dest):
            try:
                with open(ok_file) as f:
                    if f.read().strip() == self.sha:
                        return {"ok": self.file, "sha256": self.sha, "cached": True}
            except OSError:
                pass
            got = sha256_file(self.dest)
            if got == self.sha:
                with open(ok_file, "w") as f:
                    f.write(self.sha)
                return {"ok": self.file, "sha256": got, "cached": True}
            return {"err": self.file, "status": "sha256 of the existing file differs"}
        ranges = self._ranges()
        self.range_list = [list(r) for r in ranges]
        old = _read_json(self.prog)
        if (old.get("bytes") == self.bytes and old.get("sha256") == self.sha and old.get("ranges") == [list(r) for r in ranges]
                and os.path.exists(self.part) and os.path.getsize(self.part) == self.bytes):
            self.offsets = [int(x) for x in old["offsets"]]
        else:
            with open(self.part, "wb") as f:
                f.truncate(self.bytes)
            self.offsets = [s for s, _ in ranges]
        fd = os.open(self.part, os.O_WRONLY)
        try:
            threads = [threading.Thread(target=self._range, args=(i, e, fd), daemon=True) for i, (_, e) in enumerate(ranges)]
            for t in threads:
                t.start()
            last_say = last_save = time.monotonic()
            while any(t.is_alive() for t in threads):
                time.sleep(1)
                now = time.monotonic()
                if now - last_save >= 5:
                    self._save_progress([list(r) for r in ranges])
                    last_save = now
                if now - last_say >= 20:
                    say({"file": self.file, "got": self.got(ranges), "of": self.bytes})
                    last_say = now
            self._save_progress([list(r) for r in ranges])
        finally:
            os.close(fd)
        if self.failed:
            return self.failed
        if self.got(ranges) != self.bytes:
            return {"err": self.file, "status": "incomplete"}
        got = sha256_file(self.part)
        if got != self.sha:
            os.remove(self.part)
            os.remove(self.prog)
            return {"err": self.file, "status": "sha256 differs", "sha256": got}
        os.replace(self.part, self.dest)
        os.remove(self.prog)
        with open(ok_file, "w") as f:
            f.write(self.sha)
        return {"ok": self.file, "sha256": got}

    def got(self, ranges):
        return sum(o - s for o, (s, _) in zip(self.offsets, ranges))


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(16 << 20)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def fetch(stream=None, models_dir=MODELS):
    """Reads {"file", "bytes", "sha256", "s3_url"|"hf"} lines (and later {"file", "s3_url"} for a fresh URL) until EOF
    or {"done": true}; downloads each file in its own thread; exits 1 if any failed."""
    stream = stream or sys.stdin
    jobs, threads, results = {}, [], {}

    def run(f):
        try:
            res = f.run()
        except Exception as e:
            res = {"err": f.file, "status": type(e).__name__}
        results[f.file] = res
        say(res)

    done = False
    for line in stream:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("done"):
            done = True
            break
        name = msg.get("file")
        if not name:
            continue
        if name in jobs:
            if msg.get("s3_url"):
                jobs[name].new_url(msg["s3_url"])
            continue
        try:
            f = Fetch(msg, models_dir=models_dir)
        except Exception as e:
            say({"err": str(name)[:80], "status": type(e).__name__})
            continue
        jobs[name] = f
        t = threading.Thread(target=run, args=(f,), daemon=True)
        t.start()
        threads.append(t)
    if not done:
        _abandon()  # stdin closed without "done": the Mac side is gone; progress is saved for a resumed fetch
    for t in threads:
        t.join()
    return 0 if all("ok" in r for r in results.values()) and len(results) == len(jobs) else 1


# ---- servers ----

def _pid_file(name):
    return os.path.join(RUN, name + ".pid")


def _cmdline(pid):
    try:
        with open(f"/proc/{int(pid)}/cmdline", "rb") as f:
            return f.read().split(b"\0")
    except (OSError, ValueError):
        return []


def _ours(pid, name):
    args = [a.decode(errors="replace") for a in _cmdline(pid)]
    return bool(args) and args[0].endswith("llama-server") and "--alias" in args and args[args.index("--alias") + 1:][:1] == [name]


def check_argv(name, argv, tag, rd=None):
    binary = os.path.join(lcpp_dir(tag, rd), "build", "bin", "llama-server")
    if not NAME_RE.fullmatch(name):
        raise ValueError("bad name")
    if not argv or argv[0] != binary:
        raise ValueError("argv[0] is not this lab's llama-server")
    if "--host" not in argv or argv[argv.index("--host") + 1] != "127.0.0.1" or argv.count("--host") != 1:
        raise ValueError("--host must be 127.0.0.1")
    if "--alias" not in argv or argv[argv.index("--alias") + 1] != name:
        raise ValueError("--alias must be the model name")
    for a in argv[1:]:
        if a.split("=")[0] in FORBIDDEN:
            raise ValueError(f"flag {a} is not allowed")
    return binary


def start(spec):
    name, argv, tag = spec["name"], list(spec["argv"]), spec["tag"]
    binary = check_argv(name, argv, tag)
    stop(name, quiet=True)
    os.makedirs(LOGS, exist_ok=True)
    os.makedirs(RUN, exist_ok=True)
    env = dict(os.environ)
    for k in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "LLAMA_ARG_HOST", "LLAMA_LOG_VERBOSITY"):
        env.pop(k, None)
    env["LD_LIBRARY_PATH"] = os.path.dirname(binary)
    with open(os.path.join(LOGS, name + ".log"), "ab") as log:
        log.write(f"\n==== start {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n".encode())
        log.flush()
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, env=env,
                             start_new_session=True, cwd=RD)
    with open(_pid_file(name), "w") as f:
        f.write(str(p.pid))
    say({"started": name, "pid": p.pid})
    return 0


def stop(name, quiet=False):
    if not NAME_RE.fullmatch(name):
        raise ValueError("bad name")
    pf = _pid_file(name)
    try:
        with open(pf) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        if not quiet:
            say({"stopped": name, "was": "not running"})
        return 0
    if _alive(pid) and _ours(pid, name):
        os.kill(pid, signal.SIGTERM)
        for _ in range(60):
            if not _alive(pid) or not _ours(pid, name):
                break
            time.sleep(0.5)
        if _alive(pid) and _ours(pid, name):
            os.kill(pid, signal.SIGKILL)
            time.sleep(1)
    os.remove(pf)
    if not quiet:
        say({"stopped": name})
    return 0


def _servers():
    out = {}
    if os.path.isdir(RUN):
        for f in sorted(os.listdir(RUN)):
            if f.endswith(".pid"):
                name = f[:-4]
                try:
                    with open(os.path.join(RUN, f)) as fh:
                        pid = int(fh.read().strip())
                except (OSError, ValueError):
                    continue
                out[name] = {"pid": pid, "alive": _alive(pid) and _ours(pid, name)}
    return out


def stop_all():
    for name in _servers():
        stop(name, quiet=True)
    say({"stopped_all": True})
    return 0


def _ints(line):
    vals = []
    for x in line.split(","):
        x = x.strip()
        vals.append(int(x) if x.isdigit() else None)
    return vals


def gpu():
    q = subprocess.run(["nvidia-smi", "--query-gpu=index,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"],
                       capture_output=True, text=True, timeout=30).stdout
    gpus = []
    for line in q.strip().splitlines():
        v = _ints(line)
        if len(v) == 4 and None not in v:
            gpus.append({"index": v[0], "total_mib": v[1], "used_mib": v[2], "free_mib": v[3]})
    apps = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"],
                          capture_output=True, text=True, timeout=30).stdout
    by_pid = {}
    for line in apps.strip().splitlines():
        v = _ints(line)
        if len(v) == 2 and v[0] is not None:
            by_pid[v[0]] = (by_pid.get(v[0]) or 0) + (v[1] or 0)
    servers = _servers()
    names = {s["pid"]: n for n, s in servers.items()}
    say({"gpus": gpus, "free_mib": sum(g["free_mib"] for g in gpus), "total_mib": sum(g["total_mib"] for g in gpus),
         "servers": {n: {"pid": s["pid"], "alive": s["alive"], "gpu_mib": by_pid.get(s["pid"])} for n, s in servers.items()},
         "other_gpu_pids": len([p for p in by_pid if p not in names])})
    return 0


def info():
    files = {}
    if os.path.isdir(MODELS):
        for f in sorted(os.listdir(MODELS)):
            if f.endswith(".gguf"):
                files[f] = {"bytes": os.path.getsize(os.path.join(MODELS, f)), "ok": os.path.exists(os.path.join(MODELS, f + ".ok"))}
    du = shutil.disk_usage(RD)
    say({"disk_free_gb": round(du.free / 1e9, 1), "models": files, "build": _read_json(BUILD_JSON).get("state", "none"),
         "servers": _servers()})
    return 0


def filtered_log_lines(lines, keep=40):
    out = []
    for line in lines[-400:]:
        if any(d in line for d in LOG_DROP):
            continue
        if LOG_KEEP.search(line):
            out.append(URL_RE.sub("[url]", line.rstrip("\n"))[:300])
    return out[-keep:]


def logs(name):
    if not NAME_RE.fullmatch(name):
        raise ValueError("bad name")
    path = os.path.join(LOGS, name + ".log")
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - (512 << 10)))
            lines = f.read().decode(errors="replace").splitlines()
    except OSError:
        say({"logs": name, "lines": [], "note": "no log"})
        return 0
    for line in filtered_log_lines(lines):
        print(line)
    return 0


def main(argv=None):
    if sys.platform == "darwin":
        raise SystemExit("lab_remote.py runs on the lab machine only, never on this Mac")
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["build-start", "build", "build-status", "fetch", "start", "stop", "stop-all", "ps", "gpu", "info", "logs"])
    ap.add_argument("name", nargs="?")
    ap.add_argument("--tag")
    ap.add_argument("--commit")
    a = ap.parse_args(argv)
    if a.command == "build-start":
        return build_start(a.tag, a.commit)
    if a.command == "build":
        return build(a.tag, a.commit)
    if a.command == "build-status":
        return build_status()
    if a.command == "fetch":
        return fetch()
    if a.command == "start":
        return start(json.loads(sys.stdin.read()))
    if a.command == "stop":
        return stop(a.name)
    if a.command == "stop-all":
        return stop_all()
    if a.command == "ps":
        say({"servers": _servers()})
        return 0
    if a.command == "gpu":
        return gpu()
    if a.command == "info":
        return info()
    if a.command == "logs":
        return logs(a.name)
    return 2


if __name__ == "__main__":
    try:
        code = main()
    except SystemExit:
        raise
    except Exception as e:
        say({"error": type(e).__name__})
        code = 1
    sys.exit(code)
