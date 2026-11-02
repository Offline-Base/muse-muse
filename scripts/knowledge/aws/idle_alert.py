#!/usr/bin/env python3
"""Tells the owner when a rented GPU machine sits idle. It only alerts: it never stops or terminates anything.

Why: a session death on Oct 31 left GPUs idle for hours and nobody noticed. train_multi.py's watch checks only spend
and a deadline, and only for train-1.

Every 5 minutes it reads GPU use and running jobs by ssh on each machine in MACHINES. When every GPU on a machine has
read 0% for 30 minutes it writes to .data/knowledge/logs/idle-alert.log and shows a macOS notification, then again
every 30 minutes while that lasts.

    $PY idle_alert.py start [--skip NAME]   detached (nohup, caffeinate, its own session), survives this terminal
    $PY idle_alert.py stop                  stops it; or: kill "$(cat .data/knowledge/logs/idle-alert.pid)"
    $PY idle_alert.py status                running or not, last reading of each machine, dollars since launch
    $PY idle_alert.py read                  one reading of each machine, prints it, changes nothing
    $PY idle_alert.py list-lambda           Lambda's machine list, read-only, through train_multi.lam (key never printed)

$PY is .data/aws/venv/bin/python, though anything from the standard library up works.

How it counts:
- A reading is 3 samples of nvidia-smi, 5 seconds apart, on every GPU. Any sample above 0% on any GPU breaks the run of
  idle readings. One busy GPU of eight therefore isn't idle.
- A job on the CPU (quantize, rsync) leaves the GPUs at 0%, so the alert fires anyway and names what is running. The GPU
  is still idle and billing; the owner decides.
- A failed ssh neither clears nor extends what's known. If no reading arrives for 15 minutes the idle count restarts,
  since the machine could have been busy in the gap. Failures are logged every time and notified after 30 minutes
  (again after 2 h, 3 times at most per outage), so a long gap is still reported.
"""
import argparse
import concurrent.futures
import datetime as dt
import fcntl
import json
import os
import re
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
LOGS = os.path.join(ROOT, ".data", "knowledge", "logs")
LOG = os.path.join(LOGS, "idle-alert.log")
OUT = os.path.join(LOGS, "idle-alert.out")
STATE = os.path.join(LOGS, "idle-alert.state.json")
PIDFILE = os.path.join(LOGS, "idle-alert.pid")
LOCK = os.path.join(LOGS, "idle-alert.lock")
KEY = os.path.expanduser("~/.ssh/muse-muse-lambda")

EDT = dt.timezone(dt.timedelta(hours=-4))


def machine_host(name):
    """ssh target for a machine, such as ubuntu@<address>, from IDLE_ALERT_HOST_<NAME> (train-1 reads
    IDLE_ALERT_HOST_TRAIN_1). The rented machines' addresses stay out of the repo. None when unset: it isn't watched."""
    return os.environ.get("IDLE_ALERT_HOST_" + re.sub(r"[^A-Z0-9]", "_", name.upper()), "").strip() or None

# Launch times and prices from docs/KNOWLEDGE_RUN_LOG.md ("Now"); Lambda bills from launch until terminate.
MACHINES = {
    "train-1": {"host": machine_host("train-1"), "usd_per_hour": 22.32, "launched": dt.datetime(2026, 10, 30, 20, 20, tzinfo=EDT)},
    "writer-1": {"host": machine_host("writer-1"), "usd_per_hour": 1.99, "launched": dt.datetime(2026, 10, 30, 14, 2, tzinfo=EDT)},
    "gh200": {"host": machine_host("gh200"), "usd_per_hour": 2.29, "launched": dt.datetime(2026, 10, 30, 17, 44, tzinfo=EDT)},
}

INTERVAL_S = 300
IDLE_ALERT_S = 1800
REPEAT_IDLE_S = 1800
MAX_GAP_S = 900
FAIL_ALERT_S = 1800
REPEAT_FAIL_S = 7200
MAX_FAIL_ALERTS = 3
SLACK_S = 60  # checks land a few seconds early or late; 29:59 of idle counts as 30 minutes
SSH_TIMEOUT_S = 60
JOB_CPU_PCT = 20.0

SSH_OPTS = ["-i", KEY, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", "-o", "BatchMode=yes",
            "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2", "-o", "LogLevel=ERROR"]

# Read-only: everything it runs on a machine. It holds no lock and uses no GPU.
GPU_QUERY = "nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits"
REMOTE = (
    f"for i in 1 2 3; do echo '==sample'; {GPU_QUERY} 2>&1; [ $i = 3 ] || sleep 5; done; "
    "echo '==apps'; nvidia-smi --query-compute-apps=pid,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null; "
    "echo '==ps'; ps -u ubuntu -o pid=,etimes=,pcpu=,args= --sort=-pcpu 2>/dev/null | cut -c1-300 | head -n 15"
)

_quiet_log = False


def stamp(t=None):
    return dt.datetime.fromtimestamp(t if t is not None else time.time()).astimezone().isoformat(timespec="seconds")


def log(msg):
    line = f"{stamp()} {msg}"
    if not _quiet_log:
        print(line, flush=True)
    try:
        os.makedirs(LOGS, exist_ok=True)
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def job_name(args):
    """The program and script file names only. Other arguments are dropped, since a command line can hold a credential."""
    tokens = args.split()
    if not tokens:
        return ""
    name = os.path.basename(tokens[0])
    for t in tokens[1:]:
        if "=" not in t and t.endswith((".py", ".sh", ".gguf")):
            name += " " + os.path.basename(t)
            break
    return re.sub(r"[^\w. \-]", "", name)[:60]


def parse_reading(text):
    """nvidia-smi and ps output to a reading. Returns (reading, None) or (None, why it can't be read)."""
    samples, apps, procs, section = [], {}, [], None
    for line in text.splitlines():
        if line.startswith("=="):
            section = line[2:].strip()
            if section == "sample":
                samples.append({})
            continue
        line = line.strip()
        if not line:
            continue
        if section == "sample":
            parts = [p.strip() for p in line.split(",")]
            if len(parts) != 4 or not all(p.isdigit() for p in parts):
                return None, "nvidia-smi: " + line[:100]
            samples[-1][int(parts[0])] = (int(parts[1]), int(parts[2]), int(parts[3]))
        elif section == "apps":
            parts = [p.strip() for p in line.split(",")]
            if parts and parts[0].isdigit():
                apps[int(parts[0])] = parts[1] if len(parts) > 1 else "?"
        elif section == "ps":
            parts = line.split(None, 3)
            if len(parts) == 4 and parts[0].isdigit():
                try:
                    procs.append((int(parts[0]), int(parts[1]), float(parts[2]), parts[3]))
                except ValueError:
                    pass
    if not samples or not samples[0]:
        return None, "no GPU readings in the output"
    gpus = sorted(samples[0])
    if any(sorted(s) != gpus for s in samples):
        return None, "GPUs changed between samples"
    util = [max(s[g][0] for s in samples) for g in gpus]
    jobs = []
    for pid, etimes, pcpu, args in procs:
        name = job_name(args)
        if name.split(" ")[0] in ("ps", "sshd", "sshd:", "cut", "head", "nvidia-smi", "sleep"):
            continue
        if pid in apps or pcpu >= JOB_CPU_PCT:
            jobs.append({"name": name, "gpu": pid in apps, "cpu_pct": round(pcpu), "hours": round(etimes / 3600, 1)})
    last = samples[-1]
    return {"util": util, "mem_mib": sum(last[g][1] for g in gpus), "mem_total_mib": sum(last[g][2] for g in gpus),
            "gpu_procs": len(apps), "jobs": jobs[:6]}, None


def read_machine(host):
    """One reading by ssh. Returns (reading, None) or (None, why). Never raises."""
    try:
        p = subprocess.run(["ssh", *SSH_OPTS, host, REMOTE], capture_output=True, text=True, errors="replace",
                           timeout=SSH_TIMEOUT_S, stdin=subprocess.DEVNULL)
        if p.returncode == 255:
            lines = [x for x in p.stderr.strip().splitlines() if x.strip()]
            return None, "ssh failed: " + (lines[-1][:120] if lines else "exit 255")
        return parse_reading(p.stdout)
    except subprocess.TimeoutExpired:
        return None, f"ssh timed out after {SSH_TIMEOUT_S} s"
    except Exception as e:  # one machine's bad output must not cost the other machines this check
        return None, f"reading failed: {type(e).__name__}"


def jobs_text(reading):
    if not reading["jobs"]:
        return "no jobs seen"
    return ", ".join(f"{j['name']} ({'GPU, ' if j['gpu'] else ''}{j['cpu_pct']}% CPU, {j['hours']} h)" for j in reading["jobs"])


def minutes(seconds):
    return f"{seconds / 60:.0f} min"


def step(rec, reading, why, t, usd_per_hour=0.0):
    """Updates one machine's record with one reading or failure. Returns (log lines, notifications).
    All the rules live here, on plain values, so they can be tested without ssh or a clock."""
    lines, notes = [], []
    if reading is None:
        rec["fails"] = rec.get("fails", 0) + 1
        rec.setdefault("fail_since", t)
        rec["last_error"] = why
        lines.append(f"unreadable ({rec['fails']} in a row): {why}")
        since = t - rec["fail_since"]
        last = rec.get("last_fail_alert")
        if (since >= FAIL_ALERT_S - SLACK_S and rec.get("fail_alerts", 0) < MAX_FAIL_ALERTS
                and (last is None or t - last >= REPEAT_FAIL_S - SLACK_S)):
            rec["last_fail_alert"] = t
            rec["fail_alerts"] = rec.get("fail_alerts", 0) + 1
            notes.append(f"Can't read it for {minutes(since)}, and it may still be billing. {why}")
        return lines, notes

    if rec.get("fails"):
        lines.append(f"readable again after {rec['fails']} failed checks")
    for k in ("fails", "fail_since", "last_error", "last_fail_alert", "fail_alerts"):
        rec.pop(k, None)

    last_read = rec.get("last_read")
    if max(reading["util"]) > 0:
        if rec.get("idle_since") is not None:
            lines.append(f"busy again after {minutes(t - rec['idle_since'])} at 0%")
        rec.pop("idle_since", None)
        rec.pop("last_idle_alert", None)
    else:
        if rec.get("idle_since") is not None and last_read is not None and t - last_read > MAX_GAP_S:
            lines.append(f"no reading for {minutes(t - last_read)}, so the idle count restarts")
            rec.pop("idle_since", None)
            rec.pop("last_idle_alert", None)
        rec.setdefault("idle_since", t)
        idle = t - rec["idle_since"]
        last = rec.get("last_idle_alert")
        if idle >= IDLE_ALERT_S - SLACK_S and (last is None or t - last >= REPEAT_IDLE_S - SLACK_S):
            rec["last_idle_alert"] = t
            cost = idle / 3600 * usd_per_hour
            notes.append(f"GPUs at 0% for {minutes(idle)}, about ${cost:.2f} at ${usd_per_hour:.2f}/h. {jobs_text(reading)}.")
    rec["last_read"] = t
    rec["last"] = reading
    idle_text = f"idle={minutes(t - rec['idle_since'])}" if rec.get("idle_since") is not None else "idle=0"
    lines.append(f"gpu%={','.join(map(str, reading['util']))} mem={reading['mem_mib']}/{reading['mem_total_mib']}MiB "
                 f"gpu_procs={reading['gpu_procs']} {idle_text} jobs: {jobs_text(reading)}")
    return lines, notes


def notify(name, body):
    """A macOS notification, passed as arguments so a job's name can't break out of the script."""
    script = ["-e", "on run argv", "-e", 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
              "-e", "end run"]
    try:
        p = subprocess.run(["osascript", *script, f"Idle GPU alert: {name}", body[:220]], capture_output=True, text=True, timeout=20)
        return p.returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, STATE)


def check(names, state):
    with concurrent.futures.ThreadPoolExecutor(len(names)) as pool:
        got = dict(zip(names, pool.map(lambda n: read_machine(MACHINES[n]["host"]), names)))
    t = time.time()
    for name in names:
        reading, why = got[name]
        rec = state.setdefault(name, {})
        lines, notes = step(rec, reading, why, t, MACHINES[name]["usd_per_hour"])
        for line in lines:
            log(f"{name} {line}")
        for body in notes:
            ok = notify(name, body)
            log(f"{name} ALERT {body} (notification {'shown' if ok else 'FAILED, osascript error'})")
    state["_last_check"] = t
    save_state(state)


def run(args):
    os.makedirs(LOGS, exist_ok=True)
    holder = open(LOCK, "w")
    try:
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise SystemExit("idle_alert is already running")
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))

    def finish(signum, frame):
        log(f"stopped by signal {signum}")
        try:
            os.remove(PIDFILE)
        except OSError:
            pass
        os._exit(0)
    signal.signal(signal.SIGTERM, finish)
    signal.signal(signal.SIGINT, finish)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

    names = [n for n in MACHINES if n not in (args.skip or []) and MACHINES[n]["host"]]
    if not names:
        sys.exit("no machine to watch: set IDLE_ALERT_HOST_<NAME> for each, such as IDLE_ALERT_HOST_TRAIN_1=ubuntu@<address>")
    state = load_state()
    log(f"started pid {os.getpid()}: {', '.join(names)} every {INTERVAL_S} s; alerts at {IDLE_ALERT_S // 60} min at 0%; "
        f"it never stops or terminates anything")
    ok = notify("watching", f"Now watching {', '.join(names)} every {INTERVAL_S // 60} minutes. It only alerts.")
    log(f"start notification {'shown' if ok else 'FAILED, osascript error'}")
    next_at = time.time()
    while True:
        try:
            check(names, state)
        except Exception as e:  # a bad cycle must not end the watch; say so and try again
            log(f"check failed: {type(e).__name__}: {str(e)[:160]}")
        next_at += INTERVAL_S
        now = time.time()
        if next_at <= now:  # the Mac slept past one or more checks
            next_at = now + INTERVAL_S
        time.sleep(next_at - now)


def running_pid():
    try:
        with open(PIDFILE) as f:
            pid = int(f.read().strip())
        cmd = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, timeout=10).stdout
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    return pid if "idle_alert.py" in cmd else None


def start(args):
    pid = running_pid()
    if pid:
        raise SystemExit(f"already running, pid {pid}")
    os.makedirs(LOGS, exist_ok=True)
    cmd = ["nohup", "caffeinate", "-i", "-s", sys.executable, os.path.abspath(__file__), "run"]
    for name in args.skip or []:
        cmd += ["--skip", name]
    with open(OUT, "a") as out:
        # start_new_session is setsid(2): macOS has no setsid command, and this is the same call.
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, start_new_session=True, cwd=ROOT)
    for _ in range(20):
        time.sleep(0.5)
        pid = running_pid()
        if pid:
            print(f"running, pid {pid}. Log: {LOG}. Stop: {os.path.abspath(__file__)} stop")
            return
    raise SystemExit(f"didn't start; see {OUT}")


def stop(_args):
    pid = running_pid()
    if not pid:
        print("not running")
        return
    os.kill(pid, signal.SIGTERM)
    for _ in range(20):
        time.sleep(0.25)
        if not running_pid():
            print(f"stopped pid {pid}")
            return
    raise SystemExit(f"pid {pid} didn't stop")


def uptime_usd(m, at=None):
    at = at or dt.datetime.now(dt.timezone.utc)
    hours = (at - m["launched"]).total_seconds() / 3600
    return hours, hours * m["usd_per_hour"]


def status(_args):
    pid = running_pid()
    state = load_state()
    print(f"running, pid {pid}" if pid else "NOT running")
    if state.get("_last_check"):
        print(f"last check {stamp(state['_last_check'])} ({minutes(time.time() - state['_last_check'])} ago)")
    for name, m in MACHINES.items():
        hours, usd = uptime_usd(m)
        rec = state.get(name, {})
        idle = f"at 0% for {minutes(time.time() - rec['idle_since'])}" if rec.get("idle_since") is not None else "not idle"
        fails = f", {rec['fails']} failed checks: {rec.get('last_error')}" if rec.get("fails") else ""
        util = rec.get("last", {}).get("util")
        print(f"{name}: {hours:.1f} h since launch, ${usd:.2f} at ${m['usd_per_hour']:.2f}/h; gpu% {util}; {idle}{fails}")


def read_once(_args):
    names = [n for n in MACHINES if MACHINES[n]["host"]]
    if not names:
        sys.exit("no machine to read: set IDLE_ALERT_HOST_<NAME> for each, such as IDLE_ALERT_HOST_TRAIN_1=ubuntu@<address>")
    with concurrent.futures.ThreadPoolExecutor(len(names)) as pool:
        got = zip(names, pool.map(lambda n: read_machine(MACHINES[n]["host"]), names))
        for name, (reading, why) in got:
            if reading is None:
                print(f"{name}: unreadable: {why}")
            else:
                print(f"{name}: gpu%={reading['util']} mem={reading['mem_mib']}/{reading['mem_total_mib']}MiB "
                      f"gpu_procs={reading['gpu_procs']} jobs: {jobs_text(reading)}")


def list_lambda(_args):
    """A GET of Lambda's machine list through train_multi.lam, which sends the key only to Lambda's API."""
    sys.path.insert(0, HERE)
    import train_multi
    r = train_multi.lam("GET", "instances")
    if "data" not in r:
        raise SystemExit("Lambda's list failed: " + str((r.get("error") or {}).get("message", "unknown error"))[:160])
    stray = 0
    print(f"{len(r['data'])} machines on Lambda at {stamp()}")
    for i in sorted(r["data"], key=lambda x: x.get("name") or ""):
        name = i.get("name") or "(no name)"
        flag = bool(re.search(r"muse-knowledge-gw-|lab", name))
        stray += flag
        kind = i.get("instance_type") or {}
        price = (kind.get("price_cents_per_hour") or 0) / 100
        print(f"{'STRAY? ' if flag else ''}{name} id={i.get('id')} type={kind.get('name')} region={(i.get('region') or {}).get('name')} "
              f"status={i.get('status')} ip={i.get('ip')} ${price:.2f}/h")
    print(f"{stray} muse-knowledge-gw-* or lab machines up")


def main():
    global _quiet_log
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("command", choices=["start", "stop", "status", "read", "list-lambda", "run"])
    ap.add_argument("--skip", action="append", choices=list(MACHINES), help="a machine not to watch, such as one terminated")
    a = ap.parse_args()
    _quiet_log = a.command == "run"  # the log file has it all; idle-alert.out holds only crashes
    {"start": start, "stop": stop, "status": status, "read": read_once, "list-lambda": list_lambda, "run": run}[a.command](a)


if __name__ == "__main__":
    main()
