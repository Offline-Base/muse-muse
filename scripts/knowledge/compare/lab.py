"""The compare lab machine, from this Mac (docs/COMPARE.md): one rented Lambda GPU machine that holds several ~30B models
at 4-bit, each behind its own llama-server on 127.0.0.1 there, reached through one ssh tunnel. Up only while used.

    PY=.data/aws/venv/bin/python; L=scripts/knowledge/compare/lab.py
    $PY $L types                         Lambda's live list: price, capacity, how many models fit
    $PY $L s3-put NAME [--wait]          our GGUF from writer-1's disk to S3 (presigned multipart over ssh stdin)
    $PY $L up [--yes] [--dry-run] [--type T] [--models a,b] [--idle-minutes N] [--max-hours H]
    $PY $L status [--json]               machine, spend, deadline, idle, watch, tunnel, each model
    $PY $L down                          terminate the lab machine now
    $PY $L tunnel                        start the ssh tunnel again
    $PY $L load NAME | unload NAME       swap one model on a running lab
    $PY $L add NAME [--wait]             the final candidate: s3-put if needed, enable it, swap it in if the lab is up
    $PY $L keep [--minutes N]            hold off the idle stop for N minutes (capped at the machine's deadline)
    $PY $L logs NAME                     at most 40 filtered lines of a lab server log
    $PY $L watch                         the kill switch (up starts it detached; it exits when nothing is up)
    $PY $L s3-selftest                   presigned multipart and fetch against a tiny object in knowledge/compare-test/

Lambda can't stop its own machines: the watch on this Mac is the only kill switch. Keep the Mac awake, open and on
power while a lab is up (caffeinate does not stop lid-close sleep), or run down first.

Lambda calls go only through train_multi.lam (the key stays in .env.local and is never printed). No other train_multi
function is called: its stop() with no name terminates train-1. AWS credentials come from the offlinebase profile, an
`aws login` session of about 15 minutes, so presigned URLs are made in small batches from freshly frozen credentials,
travel only over ssh stdin, and are never printed, written to a file or put in a command line.
"""

import argparse
import collections
import concurrent.futures
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
import queue
import random
import re
import secrets
import shlex
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import common as C  # noqa: E402

AWS_DIR = os.path.join(C.ROOT, "scripts", "knowledge", "aws")
TEMPLATE = os.path.join(C.JOB, "tuned-reasoning-off.jinja")
REMOTE_PY = os.path.join(HERE, "lab_remote.py")
UPLOADER = os.path.join(HERE, "s3_put_remote.py")
LOG = os.path.join(C.LAB_DIR, "lab.log")
WATCH_LOG = os.path.join(C.LAB_DIR, "watch.log")
WATCH_LOCK = os.path.join(C.LAB_DIR, "watch.lock")
STATE_LOCK = os.path.join(C.LAB_DIR, "state.lock")
MEMORY = os.path.join(C.LAB_DIR, "memory.json")
UPLOADS = os.path.join(C.LAB_DIR, "uploads.json")
LOGIN_EXPIRED = "AWS login expired: run `aws login --profile offlinebase`, then retry"
BOOTSTRAP = "import sys;n=int(sys.stdin.buffer.readline());exec(compile(sys.stdin.buffer.read(n),\"uploader\",\"exec\"))"
GONE = ("terminated",)
ENDING = ("terminating", "terminated")
MISSING_TO_END = 3
LAUNCH_GRACE_S = 120
WARMUP_NUMBERS = 600

LAM = None  # tests set a fake; otherwise train_multi.lam, imported on first use


class LabError(RuntimeError):
    pass


# ---- logging, never with a URL ----

_URL = re.compile(r"https?://\S+")
_AMZ = re.compile(r"X-Amz-[A-Za-z-]+=[^&\s]+")


def scrub(text):
    return _AMZ.sub("X-Amz-[hidden]", _URL.sub("[url]", str(text)))


def log(msg, path=None, echo=True):
    # LOG is read at call time (not as a default argument), so tests that repoint lab.LOG never write the real log.
    path = path or LOG
    line = f"{C.iso(C.utcnow())} {scrub(msg)}"
    if echo:
        print(scrub(msg), flush=True)
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def notify(title, body):
    """A macOS notification; the text goes in as arguments, so nothing in it can run."""
    script = ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv) sound name \"Glass\"",
              "-e", "end run"]
    try:
        return subprocess.run(["osascript", *script, title[:80], scrub(body)[:220]], capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


# ---- state (written only here, under a lock, by atomic replace) ----

@contextlib.contextmanager
def state_lock():
    os.makedirs(C.LAB_DIR, exist_ok=True)
    with open(STATE_LOCK, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def save_state(state, path=None):
    path = path or C.STATE
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, path)


def update_state(fn):
    with state_lock():
        s = C.lab_state()
        out = fn(s)
        save_state(s)
        return out


def update_machine(name, **fields):
    def fn(s):
        s["machines"].setdefault(name, {}).update(fields)
    update_state(fn)


def next_name(state, prefix):
    used = [int(n[len(prefix):]) for n in state["machines"] if n.startswith(prefix) and n[len(prefix):].isdigit()]
    return prefix + str(max(used, default=0) + 1)


# ---- Lambda (train_multi.lam only) ----

def lam(method, path, body=None):
    global LAM
    if LAM is None:
        if AWS_DIR not in sys.path:
            sys.path.insert(0, AWS_DIR)
        from train_multi import lam as real_lam
        LAM = real_lam
    return LAM(method, path, body)


def lam_error(r):
    err = (r or {}).get("error") if isinstance(r, dict) else None
    if isinstance(err, dict):
        return scrub(f"{err.get('code', '')} {err.get('message', '')}".strip())[:200]
    return "no data in Lambda's reply"


def list_instances():
    """Lambda's machine list, or None when the call failed (then nothing may change)."""
    try:
        r = lam("GET", "instances")
    except Exception:
        return None
    data = r.get("data") if isinstance(r, dict) else None
    return data if isinstance(data, list) else None


def instance_types():
    r = lam("GET", "instance-types")
    data = r.get("data") if isinstance(r, dict) else None
    if not isinstance(data, dict):
        raise LabError("Lambda's instance-types list failed: " + lam_error(r))
    return data


def type_info(types, name):
    t = types.get(name) or {}
    it = t.get("instance_type") or {}
    specs = it.get("specs") or {}
    gpus = int(specs.get("gpus") or 1)
    return {"name": name, "usd_per_hour": (it.get("price_cents_per_hour") or 0) / 100, "gpu": it.get("gpu_description"),
            "gpus": gpus, "regions": [r.get("name") for r in t.get("regions_with_capacity_available") or []],
            "gpu_mib": C.type_gpu_mib(name, it.get("gpu_description"), gpus), "listed": bool(t)}


def terminate_instance(iid, listing, prefix):
    """POST terminate for one id, only when Lambda's own record names it prefix*. True when Lambda confirms."""
    rec = next((i for i in listing or [] if i.get("id") == iid), None)
    if not rec or not (rec.get("name") or "").startswith(prefix):
        return False
    r = lam("POST", "instance-operations/terminate", {"instance_ids": [iid]})
    done = [t.get("id") for t in ((r or {}).get("data") or {}).get("terminated_instances", [])]
    return iid in done


# ---- AWS (offlinebase, short-lived login credentials) ----

def aws_session(cfg):
    import boto3
    return boto3.Session(profile_name=cfg["s3"]["profile"], region_name=cfg["s3"]["region"])


def check_aws(cfg, session=None):
    """Fails before any rent is spent when the login has expired. Returns the session."""
    try:
        session = session or aws_session(cfg)
        creds = session.get_credentials()
        frozen = creds.get_frozen_credentials() if creds else None
        if not frozen or not frozen.access_key:
            raise LabError("no credentials")
    except SystemExit:
        raise
    except Exception:
        raise SystemExit(LOGIN_EXPIRED)
    return session


def cred_minutes(session):
    try:
        exp = getattr(session.get_credentials(), "_expiry_time", None)
        return round((exp - C.utcnow()).total_seconds() / 60, 1) if exp else None
    except Exception:
        return None


def fresh_s3(session, cfg):
    """An S3 client from credentials frozen just now, so each batch of URLs gets the newest session token."""
    try:
        f = session.get_credentials().get_frozen_credentials()
    except Exception:
        raise SystemExit(LOGIN_EXPIRED)
    import boto3
    from botocore.config import Config
    return boto3.client("s3", region_name=cfg["s3"]["region"], aws_access_key_id=f.access_key, aws_secret_access_key=f.secret_key,
                        aws_session_token=f.token, config=Config(signature_version="s3v4"))


def presign_parts(client_factory, cfg, key, upload_id, parts):
    s3 = client_factory()
    return {int(n): s3.generate_presigned_url("upload_part", Params={"Bucket": cfg["s3"]["bucket"], "Key": key, "UploadId": upload_id,
                                                                     "PartNumber": int(n)},
                                              ExpiresIn=int(cfg["s3"]["put_url_seconds"]), HttpMethod="PUT") for n in parts}


def presign_get(client_factory, cfg, key):
    return client_factory().generate_presigned_url("get_object", Params={"Bucket": cfg["s3"]["bucket"], "Key": key},
                                                   ExpiresIn=int(cfg["s3"]["get_url_seconds"]))


# ---- a JSON-lines channel to a process (ssh), the only way URLs travel ----

class Channel:
    def __init__(self, argv, cwd=None):
        self.argv = list(argv)
        self.p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd)
        self.q = queue.Queue()
        self.err = collections.deque(maxlen=12)
        threading.Thread(target=self._out, daemon=True).start()
        threading.Thread(target=self._errs, daemon=True).start()

    def _out(self):
        for line in self.p.stdout:
            try:
                msg = json.loads(line)
                if not isinstance(msg, dict):
                    msg = {"_text": "non-object line"}
            except ValueError:
                msg = {"_text": scrub(line.decode(errors="replace").strip())[:200]}
            self.q.put(msg)
        self.q.put(None)

    def _errs(self):
        for line in self.p.stderr:
            self.err.append(scrub(line.decode(errors="replace").strip())[:200])

    def send_raw(self, data):
        self.p.stdin.write(data)
        self.p.stdin.flush()

    def send(self, obj):
        self.send_raw((json.dumps(obj) + "\n").encode())

    def recv(self, timeout):
        return self.q.get(timeout=timeout)

    def close(self):
        try:
            self.p.stdin.close()
        except OSError:
            pass

    def wait(self, timeout=120):
        try:
            return self.p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.p.kill()
            return self.p.wait()

    def kill(self):
        try:
            self.p.kill()
        except OSError:
            pass

    def err_tail(self):
        return " | ".join(list(self.err)[-3:])


def upload_via(argv, job, presign, program=None, idle_timeout=900, progress=None):
    """Drives s3_put_remote.py through `argv` (ssh to writer-1, or a local python for the self-test).
    Returns (sha256, bytes, {part: etag}, counts). URLs go only into the child's stdin."""
    if program is None:
        with open(UPLOADER, "rb") as f:
            program = f.read()
    ch = Channel(argv)
    parts, counts = {}, {"batches": 0, "retries": 0, "warns": 0, "urls": 0}
    sha = nbytes = err = None
    try:
        ch.send_raw(f"{len(program)}\n".encode() + program)
        ch.send({"job": job})
        while True:
            try:
                msg = ch.recv(idle_timeout)
            except queue.Empty:
                raise LabError(f"no word from the uploader for {idle_timeout // 60} minutes")
            if msg is None:
                break
            if "error" in msg:
                err = {k: v for k, v in msg.items() if k in ("error", "type", "part", "status", "have", "want")}
                break
            if "need" in msg:
                urls = presign([int(n) for n in msg["need"]])
                ch.send({"urls": {str(n): u for n, u in urls.items()}})
                counts["batches"] += 1
                counts["urls"] += len(urls)
            elif "retry" in msg:
                counts["retries"] += 1
                urls = presign([int(msg["retry"])])
                ch.send({"urls": {str(n): u for n, u in urls.items()}})
                counts["urls"] += len(urls)
            elif "part" in msg:
                parts[int(msg["part"])] = msg["etag"]
                if progress:
                    progress(len(parts), int(msg.get("bytes") or 0))
            elif "warn" in msg:
                counts["warns"] += 1
            elif "sha256" in msg:
                sha, nbytes = msg["sha256"], int(msg["bytes"])
                ch.send({"done": True})
                ch.close()
    except BaseException:
        ch.kill()
        raise
    code = ch.wait(120)
    if err or code != 0 or not sha:
        why = json.dumps(err) if err else f"exit {code}"
        tail = ch.err_tail()
        raise LabError(f"upload failed: {why}" + (f" ({tail})" if tail else ""))
    return sha, nbytes, parts, counts


# ---- models.json (lab.py is its only writer) ----

def _object_span(text, pos):
    """[start, end] of the innermost JSON object around text[pos]."""
    stack, in_str, esc, start = [], False, False, None
    for i, ch in enumerate(text):
        if i == pos:
            start = next((j for j in reversed(stack) if text[j] == "{"), None)
            break
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append(i)
        elif ch in "}]" and stack:
            stack.pop()
    if start is None:
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return start, i
    return None


_VALUE = r'(null|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:[^"\\]|\\.)*")'


def edit_model_text(text, name, fields):
    """models.json with `fields` set on one model's own entry, keeping the file's layout. None if it can't."""
    m = re.search(r'"name"\s*:\s*' + re.escape(json.dumps(name)), text)
    if not m:
        return None
    span = _object_span(text, m.start())
    if not span:
        return None
    s, e = span
    obj = text[s:e + 1]
    for k, v in fields.items():
        lit = json.dumps(v)
        pat = re.compile(r'("' + re.escape(k) + r'"\s*:\s*)' + _VALUE)
        if pat.search(obj):
            obj = pat.sub(lambda mm: mm.group(1) + lit, obj, count=1)
        else:
            body = obj[:-1].rstrip()
            obj = body + f', "{k}": {lit}' + obj[len(body):]
    return text[:s] + obj + text[e + 1:]


def set_model_fields(name, fields, path=None):
    path = path or C.CONFIG
    with open(path) as f:
        text = f.read()
    raw = json.loads(text)
    entry = next((x for x in raw["models"] if x.get("name") == name), None)
    if entry is None:
        raise LabError(f"no model named {name} in {path}")
    entry.update(fields)
    new = edit_model_text(text, name, fields)
    try:
        ok = new is not None and json.loads(new) == raw
    except ValueError:
        ok = False
    if not ok:
        new = json.dumps(raw, indent=2) + "\n"
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(new)
    os.replace(tmp, path)
    C.load_config(path)  # still valid


# ---- ssh to writer-1 and to the lab ----

def key_path(cfg):
    return os.path.expanduser(cfg["lab"]["ssh_key"])


def writer1_ssh(cfg, command):
    return ["ssh", "-i", key_path(cfg), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=4", "-o", "LogLevel=ERROR", cfg["writer1"]["host"], command]


def uploader_argv(cfg):
    return writer1_ssh(cfg, f"nice -n 19 ionice -c 3 python3 -I -c '{BOOTSTRAP}'")


def check_writer1_path(path):
    if not re.fullmatch(r"/home/ubuntu/q/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.gguf", path or "") or ".." in path:
        raise LabError(f"writer1_path {path!r} is not a GGUF under /home/ubuntu/q/<run>/")
    return path


def writer1_size(cfg, path):
    """The file's size on writer-1 from `ls -ln` (read-only), or None if it isn't there."""
    r = subprocess.run(writer1_ssh(cfg, f"ls -ln -- {shlex.quote(check_writer1_path(path))} 2>/dev/null || true"),
                       capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
    if r.returncode == 255:
        raise LabError("ssh to writer-1 failed: " + scrub(r.stderr.strip())[-160:])
    parts = r.stdout.split()
    return int(parts[4]) if len(parts) >= 9 and parts[4].isdigit() else None


def lab_ssh_opts(cfg):
    return ["-i", key_path(cfg), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", f"UserKnownHostsFile={C.KNOWN_HOSTS}",
            "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "LogLevel=ERROR"]


def lab_run(cfg, ip, command, data=None, timeout=180):
    return subprocess.run(["ssh", *lab_ssh_opts(cfg), f"ubuntu@{ip}", command], input=data, capture_output=True, text=True,
                          timeout=timeout, stdin=None if data is not None else subprocess.DEVNULL)


def remote(cfg, ip, args, data=None, timeout=180):
    """lab_remote.py ARGS on the lab; its last JSON line."""
    rd = cfg["lab"]["remote_dir"]
    r = lab_run(cfg, ip, f"python3 -I {rd}/lab_remote.py {args}", data=data, timeout=timeout)
    for line in reversed(r.stdout.strip().splitlines()):
        try:
            return json.loads(line)
        except ValueError:
            continue
    raise LabError(f"lab_remote {args.split()[0]}: no reply (ssh exit {r.returncode}; {scrub(r.stderr.strip())[-160:]})")


def tunnel_argv(cfg, ip):
    lab = cfg["lab"]
    lo, hi = lab["remote_ports"][:2]
    off = int(lab["local_port_offset"])
    fwd = []
    for p in range(lo, hi + 1):
        if p + off in C.FORBIDDEN_PORTS:
            raise LabError(f"local port {p + off} is reserved")
        fwd += ["-L", f"127.0.0.1:{p + off}:127.0.0.1:{p}"]
    return ["ssh", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
            "-o", "BatchMode=yes", "-o", f"UserKnownHostsFile={C.KNOWN_HOSTS}", "-o", "StrictHostKeyChecking=accept-new",
            "-o", "LogLevel=ERROR", "-i", key_path(cfg), *fwd, f"ubuntu@{ip}"]


def stop_tunnel(ip=None):
    pid, cmd = C._pid_command(C.TUNNEL_PID)
    if pid and "ssh" in cmd and "-N" in cmd and (ip is None or ("@" + ip) in cmd):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    try:
        os.remove(C.TUNNEL_PID)
    except OSError:
        pass


def start_tunnel(cfg, ip):
    if C.tunnel_running(ip):
        return True
    old_pid, old_cmd = C._pid_command(C.TUNNEL_PID)
    if old_pid and "ssh" in old_cmd and "-N" in old_cmd and ("@" + ip) in old_cmd:
        stop_tunnel(ip)
        time.sleep(1)
    os.makedirs(C.LAB_DIR, exist_ok=True)
    with open(LOG, "a") as err:
        p = subprocess.Popen(tunnel_argv(cfg, ip), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=err,
                             start_new_session=True)
    for _ in range(10):
        time.sleep(1)
        if p.poll() is not None:
            log(f"tunnel to {ip} exited with {p.returncode} (a local port in use, or ssh refused); see lab.log")
            return False
    with open(C.TUNNEL_PID, "w") as f:
        f.write(str(p.pid))
    return True


def watch_wrapper(py, script, pause=30):
    """Restarts the watch only when it exits non-zero; a clean exit (nothing up) ends the loop."""
    return f"until {shlex.quote(py)} {shlex.quote(script)} watch; do sleep {int(pause)}; done"


def start_watch():
    if C.watch_running():
        return False
    os.makedirs(C.LAB_DIR, exist_ok=True)
    with open(WATCH_LOG, "a") as out:
        subprocess.Popen(["nohup", "caffeinate", "-ims", "bash", "-c", watch_wrapper(sys.executable, os.path.abspath(__file__))],
                         cwd=C.ROOT, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(20):
        time.sleep(0.5)
        if C.watch_running():
            return True
    log("WARNING: the watch did not start; see watch.log")
    return False


# ---- server command lines ----

def server_argv(m, cfg, ctx, device=None):
    lab = cfg["lab"]
    rd, tag = lab["remote_dir"], cfg["llama_cpp"]["tag"]
    serve = []
    for x in m.get("serve") or []:
        if x.startswith("@template/"):
            t = x[len("@template/"):]
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", t):
                raise LabError(f"bad template name {t!r}")
            x = f"{rd}/templates/{t}"
        serve.append(x)
    argv = [f"{rd}/llama.cpp-{tag}/build/bin/llama-server", "-m", f"{rd}/models/{m['file']}", "--host", "127.0.0.1",
            "--port", str(m["port"]), "--alias", m["name"], "-c", str(int(ctx) * int(lab["slots"])), "-np", str(lab["slots"]),
            "-t", str(lab["threads_per_server"]), *lab["server_flags"], *serve]
    if device is not None:
        argv += ["--device", f"CUDA{int(device)}"]
    for a in argv[1:]:
        if a.split("=")[0] in C.FORBIDDEN_FLAGS and a not in ("--host", "--port"):
            raise LabError(f"flag {a} is not allowed")
    return argv


def server_shell(argv, cfg, name):
    rd = cfg["lab"]["remote_dir"]
    return (f"LD_LIBRARY_PATH={os.path.dirname(argv[0])} setsid nohup {shlex.join(argv)} > {rd}/logs/{name}.log 2>&1 "
            f"< /dev/null &")


def devices_for(plan, gpus):
    """With several GPUs, each model goes to the GPU with the most room left (by gpu_gb). None for one GPU."""
    if gpus <= 1:
        return {m["name"]: None for m in plan}
    used = [0.0] * gpus
    out = {}
    for m in sorted(plan, key=lambda x: -float(x.get("gpu_gb") or 0)):
        i = min(range(gpus), key=lambda g: used[g])
        used[i] += float(m.get("gpu_gb") or 0) + 0.5
        out[m["name"]] = i
    return out


# ---- talking to llama-server through the tunnel ----

def post_json(url, body, timeout=300):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read()), None
    except urllib.error.HTTPError as e:
        try:
            msg = (json.loads(e.read() or b"{}").get("error") or {}).get("message", "")
        except (ValueError, AttributeError):
            msg = ""
        return e.code, None, scrub(str(msg))[:200]
    except Exception as e:
        return None, None, type(e).__name__


def chat(m, cfg, question, mode, max_tokens, timeout=600):
    body = C.request_body(m, [{"role": "system", "content": C.SYSTEM}, {"role": "user", "content": question}], mode, max_tokens=max_tokens)
    t0 = time.time()
    st, d, err = post_json(C.base_url(m, cfg) + "/v1/chat/completions", body, timeout)
    secs = time.time() - t0
    if not d:
        return {"http": st, "error": err, "seconds": round(secs, 1)}
    ch = (d.get("choices") or [{}])[0]
    msg = ch.get("message") or {}
    final = C.final_text(m, msg.get("content") or "")
    rc = len(msg.get("reasoning_content") or "")
    tim = d.get("timings") or {}
    return {"http": st, "final_chars": len(final), "has_42": "42" in final, "reasoning_chars": rc, "finish": ch.get("finish_reason"),
            "completion_tokens": (d.get("usage") or {}).get("completion_tokens"), "tok_s": round(float(tim.get("predicted_per_second") or 0), 1),
            "seconds": round(secs, 1)}


def warmup_prompt(seed=11):
    rnd = random.Random(seed)
    nums = " ".join(str(rnd.randint(100, 999)) for _ in range(WARMUP_NUMBERS))
    return f"Here is a list of numbers: {nums}\nReply with the word OK."


def warmup(models_, cfg, slots):
    """Every slot of every server at once, mode off, max_tokens 8, greedy. Returns {model: [HTTP status, ...]}."""
    prompt = warmup_prompt()
    jobs = [(m, i) for m in models_ for i in range(slots)]
    out = {m["name"]: [] for m in models_}

    def one(job):
        m, _ = job
        body = C.request_body(m, [{"role": "system", "content": C.SYSTEM}, {"role": "user", "content": prompt}], "off", max_tokens=8)
        st, _, _ = post_json(C.base_url(m, cfg) + "/v1/chat/completions", body, 600)
        return m["name"], st

    with concurrent.futures.ThreadPoolExecutor(max(1, len(jobs))) as pool:
        for name, st in pool.map(one, jobs):
            out[name].append(st)
    return out


def metrics_text_values(text):
    vals = {}
    for line in text.splitlines():
        mm = re.match(r"llamacpp:(requests_processing|requests_deferred|tokens_predicted_total|prompt_tokens_total)\s+([0-9.eE+-]+)", line)
        if mm:
            vals[mm.group(1)] = float(mm.group(2))
    return vals


def read_metrics(cfg, timeout=3):
    """/metrics of every lab port through the tunnel: {local_port: values or None}."""
    lab = cfg["lab"]
    lo, hi = lab["remote_ports"][:2]
    out = {}
    for p in range(lo, hi + 1):
        lp = p + int(lab["local_port_offset"])
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{lp}/metrics", timeout=timeout) as r:
                out[str(lp)] = metrics_text_values(r.read().decode(errors="replace"))
        except Exception:
            out[str(lp)] = None
    return out


# ---- the watch's rules, as plain functions ----

def saw_activity(prev, cur):
    """Any request in progress or waiting, or a token counter that grew since the last reading. Unreadable is no activity."""
    for port, v in (cur or {}).items():
        if not v:
            continue
        if v.get("requests_processing", 0) > 0 or v.get("requests_deferred", 0) > 0:
            return True
        p = (prev or {}).get(port) or {}
        for k in ("tokens_predicted_total", "prompt_tokens_total"):
            if k in v and k in p and v[k] > p[k]:
                return True
    return False


def stop_reason(m, state, cfg, now, last_use=None, stopped=False):
    """Why this live machine must be terminated now, or None."""
    lab = cfg["lab"]
    spent, rate = C.spent_usd(state, now), C.burn_rate(state)
    cap = float(lab["cap_usd"])
    if spent + rate * 2 / 60 >= cap:
        return f"spend cap (${spent:.2f} of ${cap:.2f})"
    deadline = C.parse_time(m.get("deadline"))
    if deadline and now >= deadline:
        return "machine deadline"
    hard = C.parse_time(lab.get("deadline_utc"))
    if hard and now >= hard:
        return "lab deadline_utc"
    if stopped:
        return "stop file"
    launched = C.parse_time(m.get("launched"))
    if not m.get("ready"):
        if launched and (now - launched).total_seconds() >= float(lab["setup_minutes"]) * 60:
            return f"not ready after {lab['setup_minutes']} minutes of setup"
        return None
    idle = C.idle_minutes(m, now, last_use)
    if idle >= float(m.get("idle_minutes") or lab["idle_minutes"]):
        return f"idle {idle:.0f} minutes"
    return None


def reconcile(state, listing, now, prefix):
    """Applies one Lambda listing to the state. Returns (strays to terminate, log lines). A failed listing (None)
    changes nothing. A machine ends only after MISSING_TO_END listings in a row leave it out."""
    lines = []
    if listing is None:
        return [], ["Lambda's list failed; nothing changed"]
    listed = {i["id"]: i for i in listing if i.get("id") and (i.get("name") or "").startswith(prefix)}
    known = {m["id"] for m in state["machines"].values() if m.get("id")}
    for name, m in state["machines"].items():
        if not name.startswith(prefix):
            continue
        if m.get("ended"):
            i = listed.get(m.get("id"))
            if i and i.get("status") not in ENDING:
                m["ended"] = None
                m["missing_lists"] = 0
                m["reopened"] = C.iso(now)
                lines.append(f"{name}: marked ended but Lambda still lists it {i.get('status')}; watching it again")
            continue
        if not m.get("id"):
            match = next((i for i in listed.values() if i.get("name") == name and i["id"] not in known), None)
            if match:
                m["id"] = match["id"]
                m["status"], m["ip"] = match.get("status"), match.get("ip")
                m["launched"] = m.get("launched") or C.iso(now)
                m["missing_lists"] = 0
                m["adopted"] = True
                known.add(match["id"])
                lines.append(f"{name}: adopted Lambda id {match['id']}")
            else:
                posted = C.parse_time(m.get("launch_posted"))
                if posted and (now - posted).total_seconds() >= LAUNCH_GRACE_S:
                    m["missing_lists"] = int(m.get("missing_lists") or 0) + 1
                    if m["missing_lists"] >= MISSING_TO_END:
                        m["ended"] = C.iso(now)
                        m["no_cost"] = True
                        m["status"] = "never listed"
                        lines.append(f"{name}: the launch never showed up in {MISSING_TO_END} lists; ended with no cost")
            continue
        i = listed.get(m["id"])
        if i and i.get("status") not in GONE:
            m["status"], m["ip"] = i.get("status"), i.get("ip") or m.get("ip")
            m["missing_lists"] = 0
        else:
            m["missing_lists"] = int(m.get("missing_lists") or 0) + 1
            if m["missing_lists"] >= MISSING_TO_END:
                m["ended"] = C.iso(now)
                m["status"] = "gone"
                lines.append(f"{name}: left out of {MISSING_TO_END} Lambda lists in a row; marked ended")
    strays = [i for i in listed.values() if i["id"] not in known and i.get("status") not in ENDING]
    return strays, lines


def watch_once(cfg, now=None, list_fn=list_instances, terminate_fn=None, metrics_fn=None, notify_fn=notify,
               last_use=None, stopped=None, tunnel_fn=None, say=None):
    """One cycle of the kill switch. Returns True when it may exit (no live machine and none listed)."""
    now = now or C.utcnow()
    prefix = cfg["lab"]["name_prefix"]
    say = say or (lambda msg: log(msg, WATCH_LOG, echo=False))
    terminate_fn = terminate_fn or (lambda iid, listing: terminate_instance(iid, listing, prefix))
    metrics_fn = metrics_fn or (lambda: read_metrics(cfg))
    stopped = os.path.exists(C.STOPPED) if stopped is None else stopped
    last_use = last_use if last_use is not None else C.last_use_time()
    listing = list_fn()
    pending = []
    # /metrics is read before taking the state lock (it can take a few seconds), only when a ready lab exists.
    peek = C.lab_state()
    cur = metrics_fn() if any(n.startswith(prefix) and not m.get("ended") and m.get("ready")
                              for n, m in peek["machines"].items()) else None

    def apply(state):
        strays, lines = reconcile(state, listing, now, prefix)
        for line in lines:
            say(line)
        if listing is None:
            return strays
        for name, m in state["machines"].items():
            if not name.startswith(prefix) or m.get("ended") or not m.get("id"):
                continue
            if m.get("ready") and cur is not None:
                if saw_activity(m.get("metrics_prev"), cur):
                    m["last_activity"] = C.iso(now)
                m["metrics_prev"] = cur
            why = stop_reason(m, state, cfg, now, last_use, stopped)
            if why:
                pending.append((name, m["id"], why))
        return strays

    with state_lock():
        state = C.lab_state()
        strays = apply(state)
        save_state(state)
    # Our own machines first (cap, deadline, idle, stop file), so a failing stray terminate can't skip them.
    for name, iid, why in pending:
        ok = False
        try:
            ok = terminate_fn(iid, listing)
        except Exception as e:
            say(f"{name}: terminate failed ({type(e).__name__}); retrying next cycle")
        if ok:
            def mark(s, name=name, why=why):
                s["machines"][name].update(ended=C.iso(now), status="terminated", end_reason=why)
            update_state(mark)
            stop_tunnel()
            say(f"{name}: terminated ({why})")
            notify_fn("Compare lab", f"{name} terminated: {why}")
        else:
            say(f"{name}: should stop ({why}) but Lambda did not confirm; retrying next cycle")
    for i in strays:
        ok = False
        try:
            ok = terminate_fn(i["id"], listing)
        except Exception as e:
            say(f"stray {i.get('name')} ({i['id']}): terminate failed ({type(e).__name__}); retrying next cycle")
        else:
            say(f"stray {i.get('name')} ({i['id']}) not in our state: terminate "
                f"{'confirmed' if ok else 'not confirmed, retrying next cycle'}")
        if ok:
            notify_fn("Compare lab", f"Terminated a stray machine {i.get('name')}")
    state = C.lab_state()
    live = {n: m for n, m in state["machines"].items() if n.startswith(prefix) and not m.get("ended")}
    for name, m in live.items():
        if m.get("ready") and m.get("ip") and tunnel_fn:
            tunnel_fn(m["ip"])
    spent, rate = C.spent_usd(state, now), C.burn_rate(state)
    idle = ", ".join(f"{n} idle {C.idle_minutes(m, now, last_use):.0f} min" for n, m in live.items() if m.get("ready"))
    say(f"watch: {len(live)} up, ${spent:.2f} of ${float(cfg['lab']['cap_usd']):.2f}, ${rate:.2f}/h" + (f", {idle}" if idle else ""))
    listed_ours = [i for i in listing or [] if (i.get("name") or "").startswith(prefix) and i.get("status") not in ENDING]
    return listing is not None and not live and not listed_ours


def watch(interval=60):
    os.makedirs(C.LAB_DIR, exist_ok=True)
    holder = open(WATCH_LOCK, "a")
    try:
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        holder.close()
        print("another watch holds watch.lock; this one exits")
        return 0
    with open(C.WATCH_PID, "w") as f:
        f.write(str(os.getpid()))
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    log(f"watch started, pid {os.getpid()}", WATCH_LOG, echo=False)
    cfg = C.load_config()
    while True:
        try:
            try:
                cfg = C.load_config()
            except Exception as e:
                log(f"watch: models.json did not load ({type(e).__name__}); using the last good copy", WATCH_LOG, echo=False)
            done = watch_once(cfg, tunnel_fn=lambda ip: start_tunnel(cfg, ip))
            if done:
                log("watch: nothing up; exiting", WATCH_LOG, echo=False)
                try:
                    os.remove(C.WATCH_PID)
                except OSError:
                    pass
                return 0
        except Exception as e:
            log(f"watch: {type(e).__name__}: {scrub(e)[:160]}", WATCH_LOG, echo=False)
        time.sleep(interval)


# ---- types ----

def type_rows(cfg, types):
    plan = C.load_plan(cfg)
    names = [cfg["lab"]["type"]] + [t for t in cfg["lab"]["other_types"] if t != cfg["lab"]["type"]]
    names += sorted((n for n in types if n.startswith("gpu_") and n not in names), key=lambda n: type_info(types, n)["usd_per_hour"])
    rows = []
    for n in names:
        t = type_info(types, n)
        t["fits"] = C.fit_count(plan, t["gpu_mib"], t["gpus"])
        t["of"] = len(plan)
        rows.append(t)
    return rows


def print_type(t, mark=""):
    regions = ", ".join(t["regions"]) if t["regions"] else "no capacity"
    gb = f"{t['gpu_mib'] * 1.048576 / 1000:.1f} GB" if t["gpu_mib"] else "?"
    print(f"{mark}{t['name']:<24} ${t['usd_per_hour']:>6.2f}/h  {t['gpu'] or '?':<22} {gb:>9}  fits {t['fits']} of {t['of']}  {regions}")


def cmd_types(a, cfg):
    types = instance_types()
    print(f"Lambda's live list at {C.fmt_et(C.utcnow())}:")
    for t in type_rows(cfg, types):
        if t["listed"]:
            print_type(t, "* " if t["name"] == cfg["lab"]["type"] else "  ")
    return 0


# ---- s3-put ----

def s3_put(name, cfg, wait=False, session=None, client_factory=None, argv=None, program=None, size_fn=None, config_path=None,
           part_bytes=None, batch=None, s3=None):
    """Our GGUF from writer-1's disk to S3: presigned multipart, URLs in batches over ssh stdin. Fills sha256 and bytes."""
    m = C.model(name, cfg)
    src = m.get("source") or {}
    key, path = src.get("s3_key"), src.get("writer1_path")
    if not key or not path:
        raise LabError(f"{name} has no s3_key and writer1_path; it comes from Hugging Face")
    if session is None and client_factory is None:
        session = check_aws(cfg)
    client_factory = client_factory or (lambda: fresh_s3(session, cfg))
    bucket = cfg["s3"]["bucket"]
    size_fn = size_fn or (lambda p: writer1_size(cfg, p))
    size = size_fn(path)
    while size is None and wait:
        log(f"s3-put {name}: {path} isn't on writer-1 yet; next look in 5 minutes")
        time.sleep(300)
        size = size_fn(path)
    if size is None:
        raise LabError(f"{path} isn't on writer-1 (use --wait to wait for it)")
    if session is not None and client_factory is not None and s3 is None:
        check_aws(cfg, session)  # a long --wait can outlast the login: stop with the login message, not a traceback
    s3 = s3 or client_factory()  # made after the wait, from credentials frozen now
    if m.get("bytes") and int(m["bytes"]) != size:
        raise LabError(f"{path} is {size} bytes on writer-1, but models.json says {m['bytes']}")
    # Already there (a rerun): take the recorded sha256 instead of uploading again.
    try:
        head = s3.head_object(Bucket=bucket, Key=key)
        if int(head["ContentLength"]) == size:
            body = s3.get_object(Bucket=bucket, Key=key + ".sha256")["Body"].read().decode().split()
            if body and re.fullmatch(r"[0-9a-f]{64}", body[0]):
                set_model_fields(name, {"sha256": body[0], "bytes": size}, config_path or cfg.get("_path"))
                log(f"s3-put {name}: already in S3 ({size} bytes, sha256 {body[0][:12]}...); models.json updated")
                return body[0], size
    except Exception:
        pass
    pb = int(part_bytes or int(cfg["s3"]["part_mib"]) << 20)
    nparts = -(-size // pb)
    up = s3.create_multipart_upload(Bucket=bucket, Key=key)
    upload_id = up["UploadId"]
    _record_upload(upload_id, key, add=True)
    log(f"s3-put {name}: {size / 1e9:.2f} GB from writer-1 in {nparts} parts of {pb >> 20} MiB, at most {cfg['s3']['upload_mb_per_s']} MB/s")
    began = time.time()
    done_bytes = [0]

    def progress(k, b):
        done_bytes[0] += b
        if k % 10 == 0 or k == nparts:
            el = max(1e-6, time.time() - began)
            log(f"s3-put {name}: {k}/{nparts} parts, {done_bytes[0] / 1e9:.1f} GB, {done_bytes[0] / el / 1e6:.0f} MB/s")

    job = {"path": path, "bytes": size, "part_bytes": pb, "threads": int(cfg["s3"]["upload_threads"]),
           "mb_per_s": float(cfg["s3"]["upload_mb_per_s"]), "batch": int(batch or cfg["s3"]["presign_batch"])}
    try:
        sha, nbytes, parts, counts = upload_via(argv or uploader_argv(cfg), job,
                                                lambda nums: presign_parts(client_factory, cfg, key, upload_id, nums),
                                                program=program, progress=progress)
        if nbytes != size or sorted(parts) != list(range(1, nparts + 1)):
            raise LabError(f"upload incomplete: {len(parts)} of {nparts} parts, {nbytes} of {size} bytes")
        s3c = client_factory()
        s3c.complete_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id,
                                      MultipartUpload={"Parts": [{"ETag": parts[n], "PartNumber": n} for n in sorted(parts)]})
        _record_upload(upload_id, key, add=False)
        got = int(s3c.head_object(Bucket=bucket, Key=key)["ContentLength"])
        if got != size:
            raise LabError(f"S3 holds {got} bytes, not {size}")
        s3c.put_object(Bucket=bucket, Key=key + ".sha256", Body=f"{sha}  {m['file']}\n".encode())
    except BaseException as e:
        try:
            client_factory().abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
            _record_upload(upload_id, key, add=False)
            log(f"s3-put {name}: aborted our upload ({type(e).__name__})")
        except BaseException as e2:
            log(f"s3-put {name}: abort failed ({type(e2).__name__}); S3's lifecycle rule ends it in 3 days")
        raise
    set_model_fields(name, {"sha256": sha, "bytes": size}, config_path or cfg.get("_path"))
    el = time.time() - began
    log(f"s3-put {name}: done in {el / 60:.1f} min, sha256 {sha}, {counts['batches']} URL batches, {counts['retries']} re-presigned, "
        f"{counts['warns']} network retries; models.json updated")
    return sha, size


def _record_upload(upload_id, key, add):
    """Our own open multipart uploads (ids and keys only), so a crash leaves a note of what to abort."""
    try:
        with open(UPLOADS) as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    if add:
        d[upload_id] = {"key": key, "started": C.iso(C.utcnow())}
    else:
        d.pop(upload_id, None)
    os.makedirs(C.LAB_DIR, exist_ok=True)
    with open(UPLOADS + ".tmp", "w") as f:
        json.dump(d, f, indent=1)
    os.replace(UPLOADS + ".tmp", UPLOADS)


def cmd_s3_put(a, cfg):
    s3_put(a.name, cfg, wait=a.wait)
    return 0


# ---- fetch onto the lab ----

def fetch_models(cfg, ip, plan, client_factory, say=None, argv=None):
    """Downloads the plan's files on the lab (lab_remote.py fetch), URLs over the ssh stdin channel.
    Returns {file: "ok" | status}."""
    say = say or log  # flushed and kept in lab.log (scrubbed), so progress shows when up runs in the background
    rd = cfg["lab"]["remote_dir"]
    ch = Channel(argv or ["ssh", *lab_ssh_opts(cfg), f"ubuntu@{ip}", f"python3 -I {rd}/lab_remote.py fetch"])
    by_file = {m["file"]: m for m in plan}
    result, last = {}, {}
    try:
        for m in plan:
            src = m["source"]
            spec = {"file": m["file"], "bytes": int(m["bytes"]), "sha256": m["sha256"]}
            if src.get("s3_key"):
                spec["s3_url"] = presign_get(client_factory, cfg, src["s3_key"])
            else:
                spec["hf"] = {"repo": src["hf_repo"], "revision": src["hf_revision"], "file": src["hf_file"]}
            ch.send(spec)
        while len(result) < len(plan):
            try:
                msg = ch.recv(1200)
            except queue.Empty:
                raise LabError("no word from the lab's fetch for 20 minutes")
            if msg is None:
                break
            f = msg.get("file") or msg.get("ok") or msg.get("err") or msg.get("need")
            if "need" in msg and msg["need"] in by_file:
                ch.send({"file": msg["need"], "s3_url": presign_get(client_factory, cfg, by_file[msg["need"]]["source"]["s3_key"])})
                say(f"fetch {msg['need']}: S3 refused the URL ({msg.get('status')}); sent a fresh one")
            elif "ok" in msg:
                result[f] = "ok"
                say(f"fetch {f}: ok, sha256 checked{' (already there)' if msg.get('cached') else ''}")
            elif "err" in msg:
                result[f] = str(msg.get("status"))
                say(f"fetch {f}: FAILED ({msg.get('status')})")
            elif "got" in msg and f:
                if time.time() - last.get(f, 0) > 60:
                    last[f] = time.time()
                    say(f"fetch {f}: {msg['got'] / 1e9:.1f} of {msg['of'] / 1e9:.1f} GB")
        ch.send({"done": True})
        ch.close()
    except BaseException:
        ch.kill()
        raise
    ch.wait(60)
    for m in plan:
        result.setdefault(m["file"], "no reply")
    return result


# ---- up ----

def preflight(cfg, plan, session):
    """Before any rent: every S3 model has a sha256 and is in S3 at its size; every HF model has its sha256."""
    s3 = fresh_s3(session, cfg)
    problems = []
    for m in plan:
        if not m.get("sha256") or not m.get("bytes"):
            problems.append(f"{m['name']}: no sha256 or bytes in models.json (run: lab.py s3-put {m['name']})")
            continue
        key = (m.get("source") or {}).get("s3_key")
        if key:
            try:
                got = int(s3.head_object(Bucket=cfg["s3"]["bucket"], Key=key)["ContentLength"])
                if got != int(m["bytes"]):
                    problems.append(f"{m['name']}: S3 holds {got} bytes, models.json says {m['bytes']}")
            except Exception as e:
                problems.append(f"{m['name']}: not in S3 ({type(e).__name__}); run lab.py s3-put {m['name']}")
    return problems


def plan_text(cfg, plan, t, region, ctx, max_hours, idle, spent):
    lab = cfg["lab"]
    price = t["usd_per_hour"]
    hours = min(max_hours, (float(lab["cap_usd"]) - spent) / price) if price else max_hours
    lines = [f"Plan: one {t['name']} in {region} at ${price:.2f}/h ({t['gpu']}), {len(plan)} models, KV q8_0, ctx {ctx} x {lab['slots']} slots.",
             f"Cap ${float(lab['cap_usd']):.2f}, spent so far ${spent:.2f}; this machine may run {hours:.2f} h (at most ${hours * price:.2f}).",
             f"Stops when idle {idle} min, at the machine deadline, at {C.fmt_et(lab['deadline_utc'])}, or if not ready in {lab['setup_minutes']} min.",
             f"Setup is about 8 to 20 min (at most about ${price * 20 / 60:.2f}); S3 egress for our files is about "
             f"${sum(int(m['bytes'] or 0) for m in plan if m['source'].get('s3_key')) / 1e9 * 0.09:.2f} (AWS, outside the cap).",
             "Models:"]
    devs = devices_for(plan, t.get("gpus") or 1)
    for m in plan:
        src = m["source"]
        where = f"s3://{cfg['s3']['bucket']}/{src['s3_key']}" if src.get("s3_key") else f"hf {src['hf_repo']}@{src['hf_revision'][:12]}"
        lines.append(f"  {m['name']:<16} {m['file']:<36} {int(m['bytes'] or 0) / 1e9:6.2f} GB  {C.bpw(m):.2f} bpw  "
                     f"{m.get('gpu_gb')} GB GPU  port {m['port']} (local {C.local_port(m, cfg)})  {where}")
    lines.append("Server command lines on the lab:")
    for m in plan:
        lines.append("  " + server_shell(server_argv(m, cfg, ctx, devs[m["name"]]), cfg, m["name"]))
    lines.append("Tunnel: " + shlex.join(tunnel_argv(cfg, "IP")))
    return "\n".join(lines)


def launch(cfg, t, region, name, max_hours, idle, spent):
    """Writes the launching record, starts the watch, POSTs the launch. Returns the Lambda id or None."""
    lab = cfg["lab"]
    price = t["usd_per_hour"]

    def record(s):
        s["machines"][name] = {"provider": "lambda", "id": None, "type": t["name"], "region": region, "usd_per_hour": price,
                               "gpus": t["gpus"], "gpu_mib": t["gpu_mib"], "launched": None, "deadline": None, "ended": None,
                               "ip": None, "status": "launching", "ready": False, "ready_at": None, "keep_until": None,
                               "missing_lists": 0, "llama_cpp_commit": cfg["llama_cpp"]["commit"], "kv": "q8_0",
                               "ctx_per_slot": int(lab["ctx_per_slot"]), "ladder": [], "servers": {}, "idle_minutes": idle,
                               "max_hours": max_hours, "spent_before_launch": spent}
    update_state(record)
    start_watch()
    if not C.watch_running():
        def unlaunched(s):
            s["machines"][name].update(ended=C.iso(C.utcnow()), no_cost=True, status="not launched", end_reason="the watch did not start")
        update_state(unlaunched)
        raise LabError("the watch (the only kill switch) did not start, so nothing was launched; see watch.log")
    body = {"region_name": region, "instance_type_name": t["name"], "ssh_key_names": [lab["ssh_key_name"]], "name": name,
            "image": {"family": lab["image_family"]}}
    hours = min(max_hours, (float(lab["cap_usd"]) - spent) / price)

    def posted(s):
        now = C.utcnow()
        s["machines"][name].update(launched=C.iso(now), launch_posted=C.iso(now),
                                   deadline=C.iso(now + dt.timedelta(hours=hours) - dt.timedelta(minutes=5)))
    update_state(posted)
    image = lab["image_family"]
    try:
        r = lam("POST", "instance-operations/launch", body)
        if not ((r or {}).get("data") or {}).get("instance_ids") and "image" in lam_error(r).lower():
            log(f"Lambda refused the image field ({lam_error(r)}); trying once with Lambda's default image")
            body.pop("image")
            image = "Lambda default"
            r = lam("POST", "instance-operations/launch", body)
    except Exception as e:
        log(f"launch POST failed ({type(e).__name__}); the reply may be lost, so the watch looks for {name} to adopt it")
        return None
    ids = ((r or {}).get("data") or {}).get("instance_ids")
    if not ids:
        why = lam_error(r)

        def refused(s):
            s["machines"][name].update(ended=s["machines"][name]["launched"], no_cost=True, status="launch refused", end_reason=why)
        update_state(refused)
        raise LabError(f"Lambda refused the launch: {why}")
    update_machine(name, id=ids[0], image=image, status="booting")
    log(f"launched {name} ({ids[0]}) {t['name']} in {region} at ${price:.2f}/h, image {image}")
    return ids[0]


def wait_adopted(name, minutes=4):
    end = time.time() + minutes * 60
    while time.time() < end:
        m = C.lab_state()["machines"].get(name) or {}
        if m.get("id"):
            return m["id"]
        time.sleep(15)
    return None


def wait_active(name, minutes=20):
    end = time.time() + minutes * 60
    last = None
    while time.time() < end:
        m = C.lab_state()["machines"].get(name) or {}
        if m.get("ended"):
            raise LabError(f"{name} ended while booting ({m.get('end_reason') or m.get('status')})")
        r = lam("GET", f"instances/{m['id']}")
        d = (r or {}).get("data") if isinstance(r, dict) else None
        if isinstance(d, dict):
            st, ip = d.get("status"), d.get("ip")
            if st != last:
                log(f"{name}: {st}")
                last = st
            update_machine(name, status=st, ip=ip or m.get("ip"))
            if st == "active" and ip:
                return ip
            if st in ("terminated", "terminating", "unhealthy"):
                raise LabError(f"{name} is {st}")
        time.sleep(15)
    raise LabError(f"{name} not active after {minutes} minutes")


def wait_ssh(cfg, ip, minutes=6):
    end = time.time() + minutes * 60
    while time.time() < end:
        try:
            if lab_run(cfg, ip, "true", timeout=30).returncode == 0:
                return
        except subprocess.TimeoutExpired:
            pass
        time.sleep(10)
    raise LabError(f"ssh to {ip} did not answer in {minutes} minutes")


def copy_files(cfg, ip):
    rd = cfg["lab"]["remote_dir"]
    r = lab_run(cfg, ip, f"mkdir -p {rd}/templates {rd}/models {rd}/logs {rd}/run && python3 --version")
    if r.returncode != 0:
        raise LabError("mkdir on the lab failed")
    for src, dst in ((REMOTE_PY, f"{rd}/lab_remote.py"), (TEMPLATE, f"{rd}/templates/{os.path.basename(TEMPLATE)}")):
        p = subprocess.run(["scp", "-q", *lab_ssh_opts(cfg), src, f"ubuntu@{ip}:{dst}"], capture_output=True, text=True, timeout=120)
        if p.returncode != 0:
            raise LabError(f"scp {os.path.basename(src)} failed: {scrub(p.stderr.strip())[-160:]}")
    return r.stdout.strip()


def wait_build(cfg, ip, minutes=30):
    end = time.time() + minutes * 60
    last = None
    while time.time() < end:
        st = remote(cfg, ip, "build-status")
        if st.get("build") != last:
            log(f"build: {st.get('build')} {st.get('step', '')}")
            last = st.get("build")
        if st.get("build") == "ok":
            return st
        if st.get("build") == "failed":
            raise LabError(f"llama.cpp build failed at {st.get('step')}: {st.get('why')} (lab.py logs build)")
        time.sleep(20)
    raise LabError("llama.cpp build not done in 30 minutes")


def wait_health(cfg, ip, m, minutes=10):
    end = time.time() + minutes * 60
    n = 0
    while time.time() < end:
        h = C.health(m, cfg=cfg)
        if h == "ok":
            return True
        n += 1
        if n % 5 == 0:
            ps = remote(cfg, ip, "ps").get("servers", {})
            if not (ps.get(m["name"]) or {}).get("alive"):
                return False
            if not C.tunnel_running(ip):
                start_tunnel(cfg, ip)
        time.sleep(3)
    return False


def start_server(cfg, ip, m, ctx, device):
    argv = server_argv(m, cfg, ctx, device)
    r = remote(cfg, ip, "start", data=json.dumps({"name": m["name"], "argv": argv, "tag": cfg["llama_cpp"]["tag"]}))
    if "started" not in r:
        raise LabError(f"start {m['name']}: {r}")
    return argv


def need_mib(m):
    return float(m.get("gpu_gb") or 0) * 1000 / 1.048576


def load_all(cfg, ip, models_, ctx, devs):
    """Starts the servers one at a time. Returns (loaded, failed, short_of_memory, gpu MiB, flags): a failure is put down
    to memory when the GPU had less free than the model's estimate (plus 500 MiB) just before it started."""
    loaded, failed, short, gpu_mib, flags = [], [], set(), {}, {}
    last_free = remote(cfg, ip, "gpu").get("free_mib")
    for m in models_:
        before = last_free
        argv = start_server(cfg, ip, m, ctx, devs.get(m["name"]))
        flags[m["name"]] = argv[1:]
        ok = wait_health(cfg, ip, m)
        g = remote(cfg, ip, "gpu")
        last_free = g.get("free_mib")
        mib = ((g.get("servers") or {}).get(m["name"]) or {}).get("gpu_mib")
        gpu_mib[m["name"]] = mib
        log(f"  {m['name']}: {'up' if ok else 'FAILED'} at ctx {ctx} x {cfg['lab']['slots']}, {mib} MiB on the GPU, {last_free} MiB free")
        if ok:
            loaded.append(m)
        else:
            failed.append(m)
            if before is not None and before < need_mib(m) + 500:
                short.add(m["name"])
    return loaded, failed, short, gpu_mib, flags


def ladder(cfg, name, ip, plan, gpus):
    """Loads the plan with uniform flags, warms every slot at once, checks free memory; then the context fallback for
    all; then leaves out models that failed for a reason other than memory; then, while still short, leaves the last
    "other" model unloaded."""
    lab = cfg["lab"]
    min_free = int(lab["min_free_mib"])
    devs = devices_for(plan, gpus)
    steps = []
    ctx = int(lab["ctx_per_slot"])

    def attempt(models_, ctx_, label):
        remote(cfg, ip, "stop-all")
        log(f"ladder {label}: {len(models_)} models at ctx {ctx_} per slot")
        ld, fl, short, mib, fg = load_all(cfg, ip, models_, ctx_, devs)
        w = warmup(ld, cfg, int(lab["slots"])) if ld else {}
        # A server that runs out of memory in the warm-up dies: failed, and put down to memory.
        died = [m for m in ld if C.health(m, cfg=cfg) != "ok"]
        ld = [m for m in ld if m not in died]
        fl = fl + died
        short |= {m["name"] for m in died}
        free = remote(cfg, ip, "gpu").get("free_mib")
        step = {"step": label, "ctx_per_slot": ctx_, "loaded": [m["name"] for m in ld], "failed": [m["name"] for m in fl],
                "short_of_memory": sorted(short), "warmup_http": dict(w), "free_mib": free, "gpu_mib": mib, "at": C.iso(C.utcnow())}
        ok = not fl and free is not None and free >= min_free
        step["ok"] = ok
        steps.append(step)
        update_machine(name, ladder=steps)
        _write_memory(name, steps)
        log(f"ladder {label}: {'ok' if ok else 'short'}, {free} MiB free after the warm-up (need {min_free})")
        return ok, ld, fl, short, mib, fg

    ok, loaded, failed, short, gpu_mib, flags = attempt(plan, ctx, "1 uniform")
    if not ok:
        ctx = int(lab["ctx_per_slot_fallback"])
        ok, loaded, failed, short, gpu_mib, flags = attempt(plan, ctx, "3 ctx fallback")
    broken = {m["name"] for m in failed if m["name"] not in short}
    current = [m for m in plan if m["name"] not in broken]
    if not ok and broken and current:
        ok, loaded, failed, short, gpu_mib, flags = attempt(current, ctx, "3 without failed: " + ", ".join(sorted(broken)))
        broken |= {m["name"] for m in failed if m["name"] not in short}
        current = [m for m in current if m["name"] not in broken]
    left_out = []
    while not ok:
        free = steps[-1].get("free_mib")
        failed_names = {m["name"] for m in failed}
        if current and failed_names and failed_names <= broken and not short and free is not None and free >= min_free:
            # Only broken models failed and memory was fine: try again without just them; drop no healthy model.
            ok, loaded, failed, short, gpu_mib, flags = attempt(current, ctx, "4 without failed: " + ", ".join(sorted(failed_names)))
            broken |= {m["name"] for m in failed if m["name"] not in short}
            current = [m for m in current if m["name"] not in broken]
            continue
        others = [m for m in current if m.get("role") == "other"]
        if not others:
            break
        drop = others[-1]
        left_out.append(drop["name"])
        current = [m for m in current if m is not drop]
        ok, loaded, failed, short, gpu_mib, flags = attempt(current, ctx, f"4 without {drop['name']}")
        broken |= {m["name"] for m in failed if m["name"] not in short}
        current = [m for m in current if m["name"] not in broken]
    up = {m["name"] for m in loaded}
    servers = {}
    for m in plan:
        n = m["name"]
        st = "up" if n in up else ("failed" if n in broken else ("not loaded (memory)" if n in left_out or n in short else "down"))
        servers[n] = {"port": m["port"], "state": st, "gpu_mib": gpu_mib.get(n) if n in up else None, "flags": flags.get(n),
                      "sha256_ok": True}
    update_machine(name, servers=servers, ctx_per_slot=ctx, kv="q8_0")
    if not loaded:
        raise LabError("no model loaded")
    return ctx, loaded, servers, ok


def _write_memory(name, steps):
    try:
        with open(MEMORY + ".tmp", "w") as f:
            json.dump({"machine": name, "steps": steps}, f, indent=1)
        os.replace(MEMORY + ".tmp", MEMORY)
    except OSError:
        pass


def smoke(cfg, models_):
    """'What is 17 + 25?' to each model alone in each of its modes. Counts only, never text."""
    out = {}
    for m in models_:
        for mode in C.modes(m):
            r = chat(m, cfg, "What is 17 + 25?", mode, 64 if mode == "off" else 1024)
            out[f"{m['name']}/{mode}"] = r
            slow = r.get("tok_s") is not None and (r.get("completion_tokens") or 0) >= 8 and r.get("tok_s", 0) < 5
            if r.get("error") or not r.get("final_chars"):
                print(f"  smoke {m['name']} {mode}: HTTP {r.get('http')}, {r.get('error') or 'no final'}")
            else:
                print(f"  smoke {m['name']} {mode}: HTTP {r['http']}, final {r['final_chars']} chars, 42 {'yes' if r['has_42'] else 'no'}, "
                      f"reasoning {r['reasoning_chars']} chars, {r['tok_s']} tok/s, finish {r['finish']}"
                      + ("  SLOW: under 5 tok/s alone, an op may have fallen back to the CPU" if slow else ""))
    return out


def setup_machine(cfg, name, plan, client_factory):
    m = C.lab_state()["machines"][name]
    ip = m.get("ip")
    if not m.get("known_hosts_cleared"):
        if os.path.exists(C.KNOWN_HOSTS):
            subprocess.run(["ssh-keygen", "-R", ip, "-f", C.KNOWN_HOSTS], capture_output=True, timeout=30)
        update_machine(name, known_hosts_cleared=True)
    log(f"{name}: waiting for ssh on {ip}")
    wait_ssh(cfg, ip)
    pyv = copy_files(cfg, ip)
    log(f"{name}: lab_remote.py and the template copied ({pyv})")
    if not start_tunnel(cfg, ip):
        raise LabError("the tunnel did not start")
    st = remote(cfg, ip, f"build-start --tag {cfg['llama_cpp']['tag']} --commit {cfg['llama_cpp']['commit']}")
    log(f"build: {st.get('build')}")
    res, errs = {}, []

    def fetch_all():
        try:
            res.update(fetch_models(cfg, ip, plan, client_factory))
        except BaseException as e:  # noqa: B036  (SystemExit from an expired login must reach the main thread)
            errs.append(e)
    fetcher = threading.Thread(target=fetch_all, daemon=True)
    fetcher.start()
    wait_build(cfg, ip)
    fetcher.join()
    if errs:
        raise errs[0]
    bad = {f: s for f, s in res.items() if s != "ok"}
    usable = [x for x in plan if res.get(x["file"]) == "ok"]
    for f, s in bad.items():
        log(f"WARNING: {f} did not arrive ({s}); its model is left out")
    if not usable:
        raise LabError("no model file arrived")
    ctx, loaded, servers, ok = ladder(cfg, name, ip, usable, int(m.get("gpus") or 1))
    for x in plan:
        if x not in usable:
            servers[x["name"]] = {"port": x["port"], "state": "failed", "gpu_mib": None, "flags": None, "sha256_ok": False}
    update_machine(name, servers=servers)
    log("smoke check (one model at a time):")
    sm = smoke(cfg, loaded)

    def ready(s):
        mm = s["machines"][name]
        mm.update(ready=True, ready_at=C.iso(C.utcnow()), smoke=sm, servers=servers)
    update_state(ready)
    return ok


def dry_run_resume(cfg, cur, plan, now=None, start_watch_fn=None):
    """`up --dry-run` while a lab is launched but not ready: the machine's state and the setup steps `up` would resume.
    No ssh, no AWS, no Lambda call and no setup step runs. The one thing it may start is the watch (the kill switch,
    nothing billable), and only when it is not running, since nothing else stops a machine that is billing."""
    now = now or C.utcnow()
    name = cur["name"]
    launched = C.parse_time(cur.get("launched"))
    setup_end = launched + dt.timedelta(minutes=float(cfg["lab"]["setup_minutes"])) if launched else None
    print(f"{name} ({cur.get('id') or 'no Lambda id yet'}): {cur.get('type')} in {cur.get('region')}, "
          f"status {cur.get('status') or 'unknown'}, IP {cur.get('ip') or 'none yet'}, not ready.")
    print(f"It is billing: ${C.machine_usd(cur, now):.2f} so far at ${float(cur.get('usd_per_hour') or 0):.2f}/h. "
          f"The watch terminates it at {C.fmt_et(setup_end) if setup_end else 'its setup deadline'} if it is not ready by then.")
    ladder = cur.get("ladder") or []
    steps = [
        (bool(cur.get("id")), "a Lambda id (up waits up to 4 minutes for the watch to adopt the launch)"),
        (cur.get("status") == "active" and bool(cur.get("ip")), "Lambda status active, with an IP"),
        (bool(cur.get("known_hosts_cleared")), "the old host key for this IP cleared"),
        (None, "ssh, copy lab_remote.py and the template, start the tunnel"),
        (None, f"build llama.cpp {cfg['llama_cpp']['tag']} (the machine skips it when already built)"),
        (None, f"fetch {len(plan)} model file(s), sha256 checked (files already checked there are kept)"),
        (bool(ladder) and bool(cur.get("servers")), f"the memory ladder ({len(ladder)} step(s) recorded so far)"),
        (bool(cur.get("smoke")), "the smoke check, then ready"),
    ]
    print("Setup steps (done / to do / checked on the machine when up resumes):")
    for done, text in steps:
        print(f"  [{'done' if done else 'to do' if done is False else 'on resume'}] {text}")
    if C.watch_running():
        print("Watch: running.")
    else:
        (start_watch_fn or start_watch)()
        print("Watch: was NOT running; started it (the kill switch only; nothing billable).")
    print(f"Dry run: no setup step ran. Run `lab.py up` to resume the setup, or `lab.py down` to terminate {name}.")
    return 0


def cmd_up(a, cfg):
    lab = cfg["lab"]
    if not a.dry_run:
        with contextlib.suppress(OSError):
            os.remove(C.STOPPED)  # our own file; a dry run leaves a pending `down` alone
    for w in cfg.get("_warnings") or []:
        log("warning: " + w)
    names = [x for x in (a.models or "").split(",") if x]
    plan = C.load_plan(cfg, names or None)
    idle = int(a.idle_minutes or lab["idle_minutes"])
    max_hours = float(a.max_hours or lab["max_hours"])
    state = C.lab_state()
    cur = C.active_lab(state)
    if cur and cur.get("ready"):
        start_tunnel(cfg, cur["ip"])
        start_watch()
        log(f"{cur['name']} is already up and ready; tunnel and watch checked")
        return cmd_status(a, cfg)
    if cur and a.dry_run:
        return dry_run_resume(cfg, cur, plan)
    session = None if a.dry_run else check_aws(cfg)
    if cur:
        log(f"{cur['name']} is up but not ready; resuming its setup")
        name = cur["name"]
        start_watch()
        if not cur.get("id"):
            if not wait_adopted(name):
                raise LabError(f"{name} has no Lambda id yet; the watch keeps looking for it")
    else:
        types = instance_types()
        tname = a.type or lab["type"]
        if tname != lab["type"] and tname not in lab["other_types"] and not a.dry_run:
            log(f"note: {tname} is not in models.json's lab types")
        t = type_info(types, tname)
        t["fits"] = C.fit_count(plan, t["gpu_mib"], t["gpus"])
        print(f"{tname}: ${t['usd_per_hour']:.2f}/h, {t['gpu']}, capacity in: {', '.join(t['regions']) or 'none'}; "
              f"fits {t['fits']} of {len(plan)} models")
        if not t["regions"]:
            print(f"No capacity for {tname}. Other types (choose one with --type; nothing switches on its own):")
            for row in type_rows(cfg, types):
                if row["name"] in lab["other_types"]:
                    print_type(row, "  ")
            return 1
        spent = C.spent_usd(state)
        left = float(lab["cap_usd"]) - spent
        if left < t["usd_per_hour"]:
            raise SystemExit(f"Only ${left:.2f} of the ${float(lab['cap_usd']):.2f} cap is left, less than one hour at ${t['usd_per_hour']:.2f}/h. "
                             "Raise cap_usd in models.json to go on.")
        region = t["regions"][0]
        print(plan_text(cfg, plan, t, region, int(lab["ctx_per_slot"]), max_hours, idle, spent))
        if a.dry_run:
            try:
                session = check_aws(cfg)
                print(f"AWS login good for about {cred_minutes(session)} more minutes.")
                problems = preflight(cfg, plan, session)
                print("Preflight: " + ("ok, every file is in place" if not problems else "would stop here:"))
                for p in problems:
                    print("  " + p)
            except SystemExit as e:
                print(f"Preflight skipped: {e}")
            print("Dry run: nothing launched, nothing spent.")
            return 0
        problems = preflight(cfg, plan, session)
        if problems:
            for p in problems:
                print("  " + p)
            raise SystemExit("Not launching: fix the above first.")
        if not a.yes:
            if not sys.stdin.isatty():
                raise SystemExit("Not launching without --yes (no terminal to ask).")
            if input(f"Launch {tname} in {region} at ${t['usd_per_hour']:.2f}/h? Type yes: ").strip().lower() != "yes":
                return 1
        name = next_name(state, lab["name_prefix"])
        iid = launch(cfg, t, region, name, max_hours, idle, spent)
        if not iid and not wait_adopted(name):
            raise LabError(f"no id for {name}; the watch adopts it if Lambda lists it, or ends the record after 3 lists")
    began = time.time()
    try:
        ip = wait_active(name)
        log(f"{name}: active at {ip}")
        session = session or check_aws(cfg)
        setup_machine(cfg, name, plan, lambda: fresh_s3(session, cfg))
    except BaseException as e:
        m = C.lab_state()["machines"].get(name) or {}
        dl = C.fmt_et(C.parse_time(m.get("launched")) + dt.timedelta(minutes=float(lab["setup_minutes"]))) if m.get("launched") else "soon"
        log(f"SETUP STOPPED: {type(e).__name__}: {scrub(e)[:200]}")
        log(f"{name} is still up and billing. Fix and rerun `lab.py up` (it resumes), or `lab.py down`. "
            f"The watch terminates it at {dl} if it is not ready by then.")
        raise
    log(f"{name}: ready after {(time.time() - began) / 60:.0f} min of setup")
    C.touch_last_use()
    return cmd_status(a, cfg)


# ---- down, status, tunnel, keep, load, unload, add, logs ----

def cmd_down(a, cfg):
    prefix = cfg["lab"]["name_prefix"]
    os.makedirs(C.LAB_DIR, exist_ok=True)
    with open(C.STOPPED, "w") as f:
        f.write(C.iso(C.utcnow()))
    listing = None
    for _ in range(3):
        listing = list_instances()
        if listing is not None:
            break
        time.sleep(10)
    if listing is None:
        start_watch()
        log("Lambda's list failed three times. The stop file is set, so the watch terminates the lab as soon as the list works.")
        return 1
    state = C.lab_state()
    left = []
    for name, m in state["machines"].items():
        if not name.startswith(prefix) or m.get("ended"):
            continue
        if not m.get("id"):
            left.append(name)
            continue
        ok = terminate_instance(m["id"], listing, prefix)
        if ok:
            update_machine(name, ended=C.iso(C.utcnow()), status="terminated", end_reason="down command")
            log(f"{name}: terminated")
        elif not any(i.get("id") == m["id"] for i in listing):
            log(f"{name}: not in Lambda's list; the watch marks it ended after {MISSING_TO_END} lists")
        else:
            left.append(name)
    known = {m.get("id") for m in C.lab_state()["machines"].values()}
    for i in listing:
        if (i.get("name") or "").startswith(prefix) and i["id"] not in known and i.get("status") not in ENDING:
            ok = terminate_instance(i["id"], listing, prefix)
            log(f"stray {i.get('name')}: terminate {'confirmed' if ok else 'NOT confirmed'}")
    stop_tunnel()
    if left:
        start_watch()
        log(f"not confirmed yet: {', '.join(left)}; the stop file is set and the watch retries every minute")
    return cmd_status(a, cfg)


def cmd_tunnel(a, cfg):
    lab = C.active_lab()
    if not lab or not lab.get("ip"):
        raise SystemExit("no lab machine with an IP")
    ok = start_tunnel(cfg, lab["ip"])
    print(f"tunnel {'running' if ok else 'FAILED'}: 127.0.0.1:{cfg['lab']['remote_ports'][0] + cfg['lab']['local_port_offset']}.."
          f"{cfg['lab']['remote_ports'][1] + cfg['lab']['local_port_offset']}")
    return 0 if ok else 1


def keep_until(state_m, minutes, cfg, now=None):
    now = now or C.utcnow()
    caps = [t for t in (C.parse_time(state_m.get("deadline")), C.parse_time(cfg["lab"].get("deadline_utc"))) if t]
    want = now + dt.timedelta(minutes=minutes)
    return min([want] + caps)


def cmd_keep(a, cfg):
    lab = C.active_lab()
    if not lab:
        raise SystemExit("no lab machine is up")
    until = keep_until(lab, a.minutes, cfg)
    update_machine(lab["name"], keep_until=C.iso(until))
    C.touch_last_use()
    print(f"{lab['name']}: kept until {C.fmt_et(until)} (the idle stop counts from then)")
    return 0


def _ready_lab():
    lab = C.active_lab()
    if not lab or not lab.get("ready") or not lab.get("ip"):
        raise SystemExit("no ready lab machine (lab.py up first)")
    return lab


def load_model(cfg, name, session=None):
    lab = _ready_lab()
    m = C.model(name, cfg)
    ip = lab["ip"]
    if not m.get("sha256") or not m.get("bytes"):
        raise SystemExit(f"{name} has no sha256 yet (lab.py s3-put {name}, or lab.py add {name})")
    if C.health(m, cfg=cfg) == "ok":
        print(f"{name} is already up")
        return 0
    need = float(m.get("gpu_gb") or 0) * 1000 + int(cfg["lab"]["min_free_mib"])
    free = remote(cfg, ip, "gpu").get("free_mib") or 0
    if free < need:
        raise SystemExit(f"only {free} MiB free on the GPU; {name} needs about {need:.0f}. Unload one first (lab.py unload NAME).")
    C.touch_last_use()
    if m["source"].get("s3_key"):
        session = session or check_aws(cfg)
    res = fetch_models(cfg, ip, [m], (lambda: fresh_s3(session, cfg)) if session else None)
    if res.get(m["file"]) != "ok":
        raise SystemExit(f"{m['file']} did not arrive ({res.get(m['file'])})")
    ctx = int(lab.get("ctx_per_slot") or cfg["lab"]["ctx_per_slot"])
    argv = start_server(cfg, ip, m, ctx, None)
    ok = wait_health(cfg, ip, m)
    g = remote(cfg, ip, "gpu")
    mib = ((g.get("servers") or {}).get(name) or {}).get("gpu_mib")

    def rec(s):
        s["machines"][lab["name"]].setdefault("servers", {})[name] = {"port": m["port"], "state": "up" if ok else "failed",
                                                                      "gpu_mib": mib, "flags": argv[1:], "sha256_ok": True}
    update_state(rec)
    print(f"{name}: {'up' if ok else 'FAILED (lab.py logs ' + name + ')'}, {mib} MiB on the GPU, {g.get('free_mib')} MiB free")
    if ok:
        smoke(cfg, [m])
    C.touch_last_use()
    return 0 if ok else 1


def unload_model(cfg, name, state_label="not loaded"):
    lab = _ready_lab()
    C.model(name, cfg)
    remote(cfg, lab["ip"], f"stop {name}")

    def rec(s):
        srv = s["machines"][lab["name"]].setdefault("servers", {})
        srv.setdefault(name, {})["state"] = state_label
    update_state(rec)
    C.touch_last_use()
    print(f"{name}: unloaded")
    return 0


def cmd_add(a, cfg):
    session = check_aws(cfg)
    m = C.model(a.name, cfg)
    if not m.get("sha256"):
        s3_put(a.name, cfg, wait=a.wait, session=session)
    set_model_fields(a.name, {"enabled": True}, cfg.get("_path"))
    cfg = C.load_config(cfg.get("_path") or C.CONFIG)
    m = C.model(a.name, cfg)
    log(f"{a.name}: enabled in models.json ({m['file']}, sha256 {m['sha256'][:12]}...)")
    lab = C.active_lab()
    if lab and lab.get("ready"):
        rep = m.get("replaces")
        if rep and C.health(C.model(rep, cfg), cfg=cfg) == "ok":
            unload_model(cfg, rep, "not loaded (replaced)")
        return load_model(cfg, a.name, session)
    print("No lab is up; the next `lab.py up` loads it" + (f" in place of {m['replaces']}." if m.get("replaces") else "."))
    return 0


def cmd_logs(a, cfg):
    lab = C.active_lab()
    if not lab or not lab.get("ip"):
        raise SystemExit("no lab machine with an IP")
    if not C.NAME_RE.fullmatch(a.name or ""):
        raise SystemExit("logs NAME: a model name or build")
    r = lab_run(cfg, lab["ip"], f"python3 -I {cfg['lab']['remote_dir']}/lab_remote.py logs {a.name}", timeout=60)
    for line in r.stdout.splitlines()[-40:]:
        if "unparsed" in line or "output:" in line:
            continue
        print(scrub(line)[:300])
    return 0


def cmd_load(a, cfg):
    return load_model(cfg, a.name)


def cmd_unload(a, cfg):
    return unload_model(cfg, a.name)


def cmd_status(a, cfg):
    state = C.lab_state()
    now = C.utcnow()
    summ = C.lab_summary(cfg)
    lab = C.active_lab(state)
    rows = []
    if lab:
        for m in C.models(cfg, enabled_only=False):
            srv = (lab.get("servers") or {}).get(m["name"])
            if not srv and not m.get("enabled"):
                continue
            rows.append({"model": m["name"], "port": m["port"], "local_port": C.local_port(m, cfg),
                         "health": C.health(m, cfg=cfg) if lab.get("ip") else "down", "state": (srv or {}).get("state", "not loaded"),
                         "gpu_mib": (srv or {}).get("gpu_mib"), "bpw": C.bpw(m), "flags": (srv or {}).get("flags")})
    listing = list_instances()
    prefix = cfg["lab"]["name_prefix"]
    # Only names, ids and status from Lambda's records (they also hold fields such as a Jupyter token).
    listed = None if listing is None else [{"name": i.get("name"), "id": i.get("id"), "status": i.get("status")}
                                           for i in listing if (i.get("name") or "").startswith(prefix)]
    if getattr(a, "json", False):
        safe = {k: v for k, v in (lab or {}).items() if k not in ("metrics_prev",)}
        print(json.dumps({"summary": summ, "machine": safe, "models": rows, "lambda_lists": listed}, indent=1))
        return 0
    if listed is None:
        print("Lambda's list: could not be read just now.")
    else:
        print(f"Lambda lists {len(listed)} {prefix}* machine(s)" + (": " + ", ".join(f"{x['name']} {x['status']}" for x in listed) if listed else "."))
    if not lab:
        last = sorted(state["machines"].items(), key=lambda x: x[1].get("launched") or "")[-1:] if state["machines"] else []
        print(f"No lab machine is up. Lifetime lab spend ${summ['spent_usd']:.2f} of ${summ['cap_usd']:.2f}.")
        for n, m in last:
            print(f"Last: {n} ({m.get('type')}), ended {C.fmt_et(m.get('ended'))}, {m.get('end_reason') or m.get('status')}, "
                  f"${C.machine_usd(m):.2f}")
        print(f"Watch: {'running' if summ['watch_running'] else 'not running'}.")
        return 0
    up_min = summ.get("uptime_minutes")
    print(f"{lab['name']} ({lab.get('id') or 'no id yet'}): {lab.get('type')} in {lab.get('region')}, status {lab.get('status')}, "
          f"{'READY' if lab.get('ready') else 'not ready'}, up {up_min if up_min is not None else '?'} min")
    print(f"Spend: this machine ${C.machine_usd(lab, now):.2f} at ${float(lab.get('usd_per_hour') or 0):.2f}/h; lifetime "
          f"${summ['spent_usd']:.2f} of the ${summ['cap_usd']:.2f} cap")
    print(f"Ends by: {summ['deadline_et']} (machine deadline or the lab deadline); idle stop after {lab.get('idle_minutes')} min, "
          f"idle now {summ['idle_minutes'] if summ['idle_minutes'] is not None else '-'} min; kept until {summ['keep_until_et'] or '-'}")
    print(f"Watch: {'running' if summ['watch_running'] else 'NOT RUNNING'}; tunnel: {'running' if summ['tunnel_running'] else 'not running'}; "
          f"KV {lab.get('kv')}, ctx {lab.get('ctx_per_slot')} x {cfg['lab']['slots']} slots, max tokens with reasoning on {summ['max_tokens_on_cap']}")
    if not summ["watch_running"]:
        print("!!! WARNING: the watch is not running, so nothing will stop this machine. Run: lab.py watch "
              "(or lab.py up, which starts it), or lab.py down.")
    for st in lab.get("ladder") or []:
        print(f"Ladder {st.get('step')}: ctx {st.get('ctx_per_slot')}, loaded {len(st.get('loaded') or [])}, failed {len(st.get('failed') or [])}, "
              f"{st.get('free_mib')} MiB free, {'ok' if st.get('ok') else 'short'}")
    for r in rows:
        print(f"  {r['model']:<16} {r['health']:<8} {r['state']:<22} port {r['port']} (local {r['local_port']})  "
              f"{r['gpu_mib'] or '-'} MiB  {r['bpw']:.2f} bpw")
        if r["flags"]:
            f = r["flags"]
            tail = f[f.index("-c"):] if "-c" in f else f  # the model path and ports are above; the rest are the flags
            print("      flags: " + " ".join(tail))
    return 0


def cmd_watch(a, cfg):
    return watch()


# ---- s3 self-test (tiny object, deleted after) ----

def cmd_s3_selftest(a, cfg):
    """The real presigned multipart protocol, and the lab's ranged fetch, against a ~12 MB random object under
    knowledge/compare-test/, run here with this Mac's Python. One URL of each kind is spoiled on purpose to prove the
    re-presign path. Everything it made is deleted at the end."""
    session = check_aws(cfg)
    print(f"AWS credentials good for about {cred_minutes(session)} more minutes")
    factory = lambda: fresh_s3(session, cfg)  # noqa: E731
    bucket = cfg["s3"]["bucket"]
    stamp = C.utcnow().strftime("%Y%m%d-%H%M%S")
    key = f"knowledge/compare-test/selftest-{stamp}-{secrets.token_hex(3)}.bin"
    os.makedirs(C.LAB_DIR, exist_ok=True)
    path = os.path.join(C.LAB_DIR, f"selftest-{stamp}.bin")
    dl_dir = os.path.join(C.LAB_DIR, f"selftest-dl-{stamp}")
    size = 12 * 1024 * 1024 + 12345
    with open(path, "wb") as f:
        f.write(os.urandom(size))
    with open(path, "rb") as f:
        want = hashlib.sha256(f.read()).hexdigest()
    spoiled = {"put": False, "get": False}
    results = {}
    s3 = factory()
    upload_id = None
    try:
        def presign(nums):
            urls = presign_parts(factory, cfg, key, upload_id, nums)
            if 2 in urls and not spoiled["put"]:
                spoiled["put"] = True
                urls[2] = re.sub(r"(X-Amz-Signature=)([0-9a-f])", lambda mm: mm.group(1) + ("0" if mm.group(2) != "0" else "1"), urls[2])
            return urls
        upload_id = s3.create_multipart_upload(Bucket=bucket, Key=key)["UploadId"]
        _record_upload(upload_id, key, add=True)
        job = {"path": path, "bytes": size, "part_bytes": 5 << 20, "threads": 3, "mb_per_s": 40, "batch": 2}
        sha, nbytes, parts, counts = upload_via([sys.executable, "-I", "-c", BOOTSTRAP], job, presign)
        results["upload"] = {"parts": len(parts), "url_batches": counts["batches"], "re_presigned": counts["retries"],
                             "sha256_matches": sha == want, "bytes": nbytes}
        factory().complete_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id,
                                            MultipartUpload={"Parts": [{"ETag": parts[n], "PartNumber": n} for n in sorted(parts)]})
        _record_upload(upload_id, key, add=False)
        upload_id = None
        results["head_bytes"] = int(factory().head_object(Bucket=bucket, Key=key)["ContentLength"])
        # The lab's fetch, in this process: 4 ranged streams, the first URL spoiled to force a "need".
        import lab_remote
        msgs = []
        holder = {}

        def fake_say(obj):
            msgs.append(obj)
            if "need" in obj:
                holder["f"].new_url(presign_get(factory, cfg, key))
        lab_remote.say = fake_say
        first = presign_get(factory, cfg, key)
        first = re.sub(r"(X-Amz-Signature=)([0-9a-f])", lambda mm: mm.group(1) + ("0" if mm.group(2) != "0" else "1"), first)
        spoiled["get"] = True
        f = lab_remote.Fetch({"file": "selftest.gguf", "bytes": size, "sha256": want, "s3_url": first}, models_dir=dl_dir,
                             streams=4, min_range=1 << 20, url_wait=120)
        holder["f"] = f
        res = f.run()
        results["fetch"] = {"ok": "ok" in res, "needs": sum(1 for x in msgs if "need" in x), "ranges": len(f._ranges())}
        # Abort: a second upload, aborted by its own id, must be gone.
        other = factory().create_multipart_upload(Bucket=bucket, Key=key + ".abort-test")["UploadId"]
        factory().abort_multipart_upload(Bucket=bucket, Key=key + ".abort-test", UploadId=other)
        try:
            factory().list_parts(Bucket=bucket, Key=key + ".abort-test", UploadId=other)
            results["abort_own_id"] = False
        except Exception as e:
            results["abort_own_id"] = "NoSuchUpload" in type(e).__name__ or "NoSuchUpload" in str(getattr(e, "response", {}).get("Error", {}).get("Code", ""))
    finally:
        if upload_id:
            with contextlib.suppress(Exception):
                factory().abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
                _record_upload(upload_id, key, add=False)
        with contextlib.suppress(Exception):
            factory().delete_object(Bucket=bucket, Key=key)
        try:
            factory().head_object(Bucket=bucket, Key=key)
            results["deleted"] = False
        except Exception:
            results["deleted"] = True
        for p in (path, os.path.join(dl_dir, "selftest.gguf"), os.path.join(dl_dir, "selftest.gguf.ok"),
                  os.path.join(dl_dir, "selftest.gguf.part"), os.path.join(dl_dir, "selftest.gguf.part.json"),
                  os.path.join(dl_dir, "selftest.gguf.lock")):
            with contextlib.suppress(OSError):
                os.remove(p)
        with contextlib.suppress(OSError):
            os.rmdir(dl_dir)
    print(json.dumps(results, indent=1))
    good = (results.get("upload", {}).get("sha256_matches") and results.get("upload", {}).get("re_presigned", 0) >= 1
            and results.get("head_bytes") == size and results.get("fetch", {}).get("ok") and results.get("fetch", {}).get("needs", 0) >= 1
            and results.get("abort_own_id") and results.get("deleted"))
    print("s3-selftest: " + ("PASS" if good else "FAIL"))
    return 0 if good else 1


# ---- main ----

def main(argv=None):
    ap = argparse.ArgumentParser(description="The compare lab machine (docs/COMPARE.md).")
    ap.add_argument("command", choices=["types", "s3-put", "up", "down", "status", "tunnel", "load", "unload", "add", "keep",
                                        "watch", "logs", "s3-selftest"])
    ap.add_argument("name", nargs="?")
    ap.add_argument("--yes", action="store_true", help="up: launch without asking")
    ap.add_argument("--dry-run", action="store_true", help="up: print the plan, price and command lines; launch nothing")
    ap.add_argument("--type", help="up: a machine type other than models.json's lab.type")
    ap.add_argument("--models", help="up: these models only, comma-separated")
    ap.add_argument("--idle-minutes", type=int)
    ap.add_argument("--max-hours", type=float)
    ap.add_argument("--minutes", type=int, default=60, help="keep: minutes")
    ap.add_argument("--wait", action="store_true", help="s3-put, add: wait for the file on writer-1 (ls every 5 minutes)")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if a.command in ("s3-put", "load", "unload", "add", "logs") and not a.name:
        ap.error(f"{a.command} needs NAME")
    cfg = C.load_config()
    handlers = {"types": cmd_types, "s3-put": cmd_s3_put, "up": cmd_up, "down": cmd_down, "status": cmd_status, "tunnel": cmd_tunnel,
                "load": cmd_load, "unload": cmd_unload, "add": cmd_add, "keep": cmd_keep, "watch": cmd_watch, "logs": cmd_logs,
                "s3-selftest": cmd_s3_selftest}
    try:
        return handlers[a.command](a, cfg)
    except LabError as e:
        log(f"error: {scrub(e)[:300]}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
