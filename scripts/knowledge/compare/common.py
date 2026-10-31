"""Shared pieces of the compare lab (docs/COMPARE.md): the model config, request bodies for llama-server, final-answer
cleanup per model family, and read-only views of the lab machine's state.

Python 3.10 or later, standard library only. The chat server (chat_server.py) and the eval runner (evals.py) import
this file; lab.py owns the lab machine and is the only writer of the state file besides its watch.

Nothing here starts a model, opens a port or prints a secret.
"""

import copy
import datetime as dt
import json
import math
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
import zoneinfo

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
JOB = os.path.join(ROOT, "scripts", "knowledge", "aws", "job")
CONFIG = os.path.join(HERE, "models.json")
DATA = os.path.join(ROOT, ".data", "compare")
LAB_DIR = os.path.join(DATA, "lab")
STATE = os.path.join(LAB_DIR, "state.json")
LAST_USE = os.path.join(LAB_DIR, "last_use")
STOPPED = os.path.join(LAB_DIR, "stopped")
WATCH_PID = os.path.join(LAB_DIR, "watch.pid")
TUNNEL_PID = os.path.join(LAB_DIR, "tunnel.pid")
KNOWN_HOSTS = os.path.join(LAB_DIR, "known_hosts")

if JOB not in sys.path:
    sys.path.insert(0, JOB)
import train_glimmer  # noqa: E402  (standard library only at import)

SYSTEM = train_glimmer.SYSTEM
ET = zoneinfo.ZoneInfo("America/New_York")  # display only; everything stored is UTC ISO. DST ends Nov 1.

# b11970 reads general.sampling.* from each GGUF as that server's defaults, so every request pins these.
NEUTRAL = {
    "min_p": 0.0, "typical_p": 1.0, "repeat_penalty": 1.0, "presence_penalty": 0.0, "frequency_penalty": 0.0,
    "dry_multiplier": 0.0, "xtc_probability": 0.0, "top_n_sigma": -1.0, "mirostat": 0, "dynatemp_range": 0.0,
    "samplers": ["penalties", "dry", "top_n_sigma", "top_k", "typ_p", "top_p", "min_p", "xtc", "temperature"],
}

ROLES = ("tuned", "base", "other")
FINALS = ("glimmer", "think", "gemma4", "plain")
NAME_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
FORBIDDEN_PORTS = (5037, 18000)  # adb holds 5037; 18000 is another session's tunnel
# Flags that would log prompts or replies, open the slots endpoint, or bind beyond loopback.
FORBIDDEN_FLAGS = ("-v", "--verbose", "--log-verbose", "-lv", "--verbosity", "--log-verbosity", "--log-prompts-dir",
                   "--slot-save-path", "--slots", "--host", "--port", "--api-key", "--api-key-file", "--webui", "--ui")
# Usable GPU memory per machine type, MiB as nvidia-smi reports it (GH200 from the review; the others are the usual
# totals for those boards). A type not listed falls back to the "(NN GB)" in Lambda's description.
GPU_MIB = {
    "gpu_1x_gh200": 97871,
    "gpu_1x_h100_sxm5": 81559, "gpu_1x_h100_pcie": 81559, "gpu_2x_h100_sxm5": 2 * 81559,
    "gpu_1x_a100_sxm4": 40960, "gpu_1x_a100": 40960,
}
CTX_FALLBACK_MAX_TOKENS_ON = 3072


class ConfigError(ValueError):
    pass


# ---- config ----

def _deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_merge(dst[k], v)
        else:
            dst[k] = copy.deepcopy(v)
    return dst


def _resolve(raw, by_name, seen=()):
    """One model entry with "like" and "run" applied."""
    if "like" not in raw:
        return copy.deepcopy(raw)
    like = raw["like"]
    if like in seen or like == raw.get("name"):
        raise ConfigError(f"model {raw.get('name')}: 'like' loops through {like}")
    if like not in by_name:
        raise ConfigError(f"model {raw.get('name')}: like {like!r} doesn't exist")
    out = _resolve(by_name[like], by_name, seen + (raw.get("name"),))
    for k in ("replaces", "run"):
        out.pop(k, None)  # never inherited: a copy doesn't replace what its parent replaced
    if "run" in raw:
        run = raw["run"]
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", run):
            raise ConfigError(f"model {raw.get('name')}: run {run!r} has characters other than letters, digits, . _ -")
        f = f"glimmer-{run}-Q4_K_M.gguf"
        out["file"] = f
        out["source"] = {"s3_key": f"knowledge/models/{run}/{f}", "writer1_path": f"/home/ubuntu/q/{run}/{f}"}
        out["bytes"] = None
        out["sha256"] = None
    for k, v in raw.items():
        out[k] = copy.deepcopy(v)
    return out


def type_gpu_mib(type_name, gpu_description=None, gpus=1):
    if type_name in GPU_MIB:
        return GPU_MIB[type_name]
    m = re.search(r"\((\d+)\s*GB", gpu_description or "")
    return int(m.group(1)) * 1024 * max(1, gpus) if m else None


def load_plan(cfg, names=None):
    """The models `lab.py up` loads: enabled ones, minus any an enabled model replaces, unless `names` lists them.
    With names, exactly those (enabled or not), in config order."""
    allm = cfg["models"]
    if names:
        want = set(names)
        unknown = want - {m["name"] for m in allm}
        if unknown:
            raise ConfigError(f"unknown model(s): {', '.join(sorted(unknown))}")
        return [m for m in allm if m["name"] in want]
    enabled = [m for m in allm if m.get("enabled")]
    replaced = {m["replaces"] for m in enabled if m.get("replaces")}
    return [m for m in enabled if m["name"] not in replaced]


def mib_to_gb(mib):
    return mib * 1.048576 / 1000


def fit_count(models_, gpu_mib, gpus=1):
    """How many of these models (in order) fit by gpu_gb + 0.5 GB each. gpu_mib is the machine's total; a model
    never spans GPUs, so each goes to the GPU with the most room left."""
    if not gpu_mib:
        return 0
    gpus = max(1, int(gpus or 1))
    room = [mib_to_gb(gpu_mib) / gpus] * gpus
    n = 0
    for m in models_:
        need = float(m.get("gpu_gb") or 0) + 0.5
        i = max(range(gpus), key=lambda g: room[g])
        if need > room[i]:
            break
        room[i] -= need
        n += 1
    return n


def load_config(path=CONFIG):
    with open(path) as f:
        cfg = json.load(f)
    raw = cfg.get("models")
    if not isinstance(raw, list) or not raw:
        raise ConfigError("models.json has no models")
    by_name = {}
    for r in raw:
        n = r.get("name")
        if not isinstance(n, str) or not NAME_RE.fullmatch(n):
            raise ConfigError(f"model name {n!r}: use lowercase letters, digits, . _ - (at most 64)")
        if n in by_name:
            raise ConfigError(f"model name {n} repeats")
        by_name[n] = r
    models_ = [_resolve(r, by_name) for r in raw]
    lab = cfg.get("lab") or {}
    lo, hi = (lab.get("remote_ports") or [8201, 8209])[:2]
    offset = int(lab.get("local_port_offset", 10000))
    chat_port = lab.get("chat_port")
    if chat_port in FORBIDDEN_PORTS:
        raise ConfigError(f"chat_port {chat_port} is reserved")
    ports, bases = {}, []
    for m in models_:
        n = m["name"]
        p = m.get("port")
        if not isinstance(p, int):
            raise ConfigError(f"model {n}: no port")
        if p in ports:
            raise ConfigError(f"port {p} repeats ({ports[p]} and {n})")
        ports[p] = n
        if p in FORBIDDEN_PORTS or p + offset in FORBIDDEN_PORTS or p + offset == chat_port:
            raise ConfigError(f"model {n}: port {p} (local {p + offset}) is reserved")
        if not lo <= p <= hi:
            raise ConfigError(f"model {n}: port {p} is outside {lo}..{hi}")
        req = m.get("request")
        if not isinstance(req, dict) or not isinstance(req.get("off"), dict):
            raise ConfigError(f"model {n}: request has no 'off' entry")
        if m.get("role") not in ROLES:
            raise ConfigError(f"model {n}: role must be one of {', '.join(ROLES)}")
        if m.get("role") == "base":
            bases.append(n)
        if m.get("final", "plain") not in FINALS:
            raise ConfigError(f"model {n}: final must be one of {', '.join(FINALS)}")
        if not m.get("file") or "/" in m["file"]:
            raise ConfigError(f"model {n}: file must be a bare file name")
        src = m.get("source") or {}
        if not (src.get("s3_key") or (src.get("hf_repo") and src.get("hf_revision") and src.get("hf_file"))):
            raise ConfigError(f"model {n}: source needs s3_key, or hf_repo, hf_revision and hf_file")
        for flag in m.get("serve") or []:
            if flag.split("=")[0] in FORBIDDEN_FLAGS:
                raise ConfigError(f"model {n}: serve flag {flag} is not allowed")
        if m.get("replaces") and m["replaces"] not in by_name:
            raise ConfigError(f"model {n}: replaces {m['replaces']!r}, which doesn't exist")
    if len(bases) != 1:
        raise ConfigError(f"exactly one model must have role 'base' (found {len(bases)})")
    for flag in lab.get("server_flags") or []:
        if flag.split("=")[0] in FORBIDDEN_FLAGS:
            raise ConfigError(f"server flag {flag} is not allowed")
    cfg["models"] = models_
    cfg["_path"] = os.path.abspath(path)
    cfg["_warnings"] = []
    plan = load_plan(cfg)
    gpu = type_gpu_mib(lab.get("type", ""))
    need = sum(float(m.get("gpu_gb") or 0) + 0.5 for m in plan)
    if gpu and need > mib_to_gb(gpu):
        cfg["_warnings"].append(f"the {len(plan)} models to load need about {need:.1f} GB, more than {lab.get('type')}'s "
                                f"{mib_to_gb(gpu):.1f} GB; the last 'other' model will be swapped")
    return cfg


def _cfg(cfg):
    return cfg if cfg is not None else load_config()


def models(cfg=None, enabled_only=True):
    cfg = _cfg(cfg)
    return [m for m in cfg["models"] if m.get("enabled") or not enabled_only]


def model(name, cfg=None):
    for m in _cfg(cfg)["models"]:
        if m["name"] == name:
            return m
    raise KeyError(f"no model named {name!r} in models.json")


def base_model(cfg=None):
    return next(m for m in _cfg(cfg)["models"] if m.get("role") == "base")


def local_port(m, cfg=None):
    return int(m["port"]) + int(_cfg(cfg)["lab"].get("local_port_offset", 10000))


def base_url(m, cfg=None):
    return f"http://127.0.0.1:{local_port(m, cfg)}"


def bpw(m):
    """Bits per weight from the file size and parameter count; 0.0 when either is unknown."""
    try:
        return round(int(m["bytes"]) * 8 / (float(m["params_b"]) * 1e9), 2)
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return 0.0


def modes(m):
    return [k for k in ("off", "on") if isinstance((m.get("request") or {}).get(k), dict)]


# ---- requests ----

def request_body(m, messages, reasoning="off", *, max_tokens, stream=False, temperature=0.0, top_p=1.0, top_k=1,
                 seed=7, cache_prompt=False):
    req = m.get("request") or {}
    if reasoning not in req or not isinstance(req[reasoning], dict):
        raise ValueError(f"{m['name']} has no reasoning mode {reasoning!r}")
    if not isinstance(messages, list) or not any(isinstance(x, dict) and x.get("role") == "system" for x in messages):
        raise ValueError("messages need a system message (an emptied system field means common.SYSTEM)")
    if any(x.get("role") == "system" and not str(x.get("content") or "").strip() for x in messages):
        raise ValueError("the system message is empty (use common.SYSTEM)")
    body = {"model": m["name"], "messages": copy.deepcopy(messages), "max_tokens": int(max_tokens),
            "temperature": temperature, "top_p": top_p, "top_k": top_k, "seed": seed, "cache_prompt": cache_prompt,
            "stream": bool(stream)}
    body.update(copy.deepcopy(NEUTRAL))
    if stream:
        body["stream_options"] = {"include_usage": True}
    return _deep_merge(body, req[reasoning])


_GEMMA_CHANNEL = re.compile(r"<\|channel>.*?<channel\|>", re.S)


def final_text(m, content):
    """The answer a reader sees, from message content only (never reasoning_content)."""
    text = content or ""
    kind = m.get("final", "plain")
    if kind == "glimmer":
        mark = "to=user<|message|>"
        if mark in text:
            text = text[text.rindex(mark) + len(mark):]
        text = train_glimmer.final_answer(text)
    elif kind == "think":
        if "</think>" in text:
            text = text[text.rindex("</think>") + len("</think>"):]
        elif text.lstrip().startswith("<think>"):
            text = ""
    elif kind == "gemma4":
        text = _GEMMA_CHANNEL.sub("", text)
        if "<|channel>" in text:
            text = text[:text.index("<|channel>")]
        text = text.replace("<turn|>", "")
    return text.strip()


def health(m, timeout=3, cfg=None):
    """'ok' (200), 'loading' (503) or 'down', through the tunnel."""
    try:
        with urllib.request.urlopen(base_url(m, cfg) + "/health", timeout=timeout) as r:
            return "ok" if r.status == 200 else "down"
    except urllib.error.HTTPError as e:
        return "loading" if e.code == 503 else "down"
    except Exception:
        return "down"


# ---- lab state (read here; written only by lab.py and its watch) ----

def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def parse_time(s):
    if not s:
        return None
    try:
        t = dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def iso(t):
    return t.astimezone(dt.timezone.utc).isoformat(timespec="seconds")


def fmt_et(t):
    t = parse_time(t) if isinstance(t, str) else t
    if not t:
        return None
    return t.astimezone(ET).strftime("%a %b %d, %I:%M %p %Z").replace(" 0", " ")


def touch_last_use():
    try:
        os.makedirs(LAB_DIR, exist_ok=True)
        with open(LAST_USE, "a"):
            pass
        os.utime(LAST_USE, None)
    except Exception:
        pass


def last_use_time():
    try:
        return dt.datetime.fromtimestamp(os.stat(LAST_USE).st_mtime, dt.timezone.utc)
    except OSError:
        return None


def lab_state(path=None):
    try:
        with open(path or STATE) as f:
            s = json.load(f)
    except (OSError, ValueError):
        s = {}
    s.setdefault("ledger", {"spent_before_usd": 0.0})
    s.setdefault("machines", {})
    return s


def is_live(m):
    return not m.get("ended")


def machine_hours(m, at=None):
    """Billed hours: Lambda bills each started minute. A launch Lambda refused costs nothing."""
    start = parse_time(m.get("launched"))
    if not start or m.get("no_cost"):
        return 0.0
    end = parse_time(m.get("ended")) or at or utcnow()
    secs = max(0.0, (end - start).total_seconds())
    return (math.floor(secs / 60) + 1) / 60


def machine_usd(m, at=None):
    return float(m.get("usd_per_hour") or 0) * machine_hours(m, at)


def spent_usd(state, at=None):
    return round(float((state.get("ledger") or {}).get("spent_before_usd") or 0)
                 + sum(machine_usd(m, at) for m in state.get("machines", {}).values()), 2)


def burn_rate(state):
    return round(sum(float(m.get("usd_per_hour") or 0) for m in state.get("machines", {}).values()
                     if is_live(m) and m.get("launched") and not m.get("no_cost")), 2)


def active_lab(state=None):
    """The live lab machine record (with its name), or None."""
    state = state if state is not None else lab_state()
    live = [(n, m) for n, m in state.get("machines", {}).items() if is_live(m)]
    if not live:
        return None
    name, m = sorted(live, key=lambda x: x[1].get("launched") or "")[-1]
    return dict(m, name=name)


def idle_minutes(m, at=None, last_use=None):
    """Minutes since the latest sign of use: ready, last_use, keep_until minus the idle limit, seen activity."""
    at = at or utcnow()
    limit = float(m.get("idle_minutes") or 30)
    marks = [parse_time(m.get("ready_at")), last_use, parse_time(m.get("last_activity"))]
    keep = parse_time(m.get("keep_until"))
    if keep:
        marks.append(keep - dt.timedelta(minutes=limit))
    marks = [x for x in marks if x]
    if not marks:
        return 0.0
    return max(0.0, (at - max(marks)).total_seconds() / 60)


def _pid_command(pid_file):
    try:
        with open(pid_file) as f:
            pid = int(f.read().strip())
        out = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, timeout=10).stdout
        return pid, out.strip()
    except (OSError, ValueError, subprocess.SubprocessError):
        return None, ""


def watch_running():
    pid, cmd = _pid_command(WATCH_PID)
    return bool(pid and "lab.py" in cmd and "watch" in cmd)


def tunnel_running(ip=None):
    pid, cmd = _pid_command(TUNNEL_PID)
    if not pid or "ssh" not in cmd or "-N" not in cmd:
        return False
    return ip is None or ("@" + ip) in cmd


def max_tokens_on_cap(ctx_per_slot):
    return 4096 if int(ctx_per_slot or 8192) >= 8192 else CTX_FALLBACK_MAX_TOKENS_ON


def ssh_args(state=None, cfg=None):
    """ssh options and host for the live lab, for a caller that runs one command there (evals.py --python-on-lab)."""
    cfg = _cfg(cfg)
    lab = active_lab(state)
    if not lab or not lab.get("ip"):
        return None
    return ["-i", os.path.expanduser(cfg["lab"]["ssh_key"]), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
            "-o", f"UserKnownHostsFile={KNOWN_HOSTS}", "-o", "StrictHostKeyChecking=accept-new", "-o", "LogLevel=ERROR",
            f"ubuntu@{lab['ip']}"]


def lab_summary(cfg=None):
    """What the chat page's banner and the eval meta show. Never raises."""
    out = {"up": False, "ready": False, "type": None, "usd_per_hour": None, "spent_usd": 0.0, "cap_usd": None,
           "deadline_et": None, "idle_minutes": None, "idle_limit_minutes": None, "watch_running": False,
           "tunnel_running": False, "kv": None, "ctx_per_slot": None, "max_tokens_on_cap": 4096, "name": None,
           "uptime_minutes": None, "keep_until_et": None, "servers": {}, "ladder": []}
    try:
        cfg = _cfg(cfg)
        state = lab_state()
        now = utcnow()
        lab = active_lab(state)
        out["cap_usd"] = float(cfg["lab"]["cap_usd"])
        out["spent_usd"] = spent_usd(state, now)
        out["watch_running"] = watch_running()
        out["ctx_per_slot"] = int(cfg["lab"]["ctx_per_slot"])
        out["max_tokens_on_cap"] = max_tokens_on_cap(out["ctx_per_slot"])
        if not lab:
            return out
        ends = [t for t in (parse_time(lab.get("deadline")), parse_time(cfg["lab"].get("deadline_utc"))) if t]
        ctx = lab.get("ctx_per_slot") or out["ctx_per_slot"]
        launched = parse_time(lab.get("launched"))
        out.update({
            "up": True, "ready": bool(lab.get("ready")), "name": lab["name"], "type": lab.get("type"),
            "usd_per_hour": lab.get("usd_per_hour"), "deadline_et": fmt_et(min(ends)) if ends else None,
            "idle_minutes": round(idle_minutes(lab, now, last_use_time()), 1) if lab.get("ready") else None,
            "idle_limit_minutes": lab.get("idle_minutes"), "tunnel_running": tunnel_running(lab.get("ip")),
            "kv": lab.get("kv"), "ctx_per_slot": ctx, "max_tokens_on_cap": max_tokens_on_cap(ctx),
            "uptime_minutes": round((now - launched).total_seconds() / 60, 1) if launched else None,
            "keep_until_et": fmt_et(lab.get("keep_until")), "status": lab.get("status"),
            "servers": {k: v.get("state") for k, v in (lab.get("servers") or {}).items()},
            "ladder": lab.get("ladder") or [],
        })
    except Exception as e:
        out["error"] = type(e).__name__
    return out
