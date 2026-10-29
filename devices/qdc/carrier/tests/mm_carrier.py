"""The QDC carrier (docs/DEVICES.md, "On Qualcomm Device Cloud"). QDC extracts the job zip under /qdc/appium/ on a host
with adb to the phone, installs requirements.txt and runs pytest; tests/test_mm.py calls main().

main() pushes mm/ (the kit, both llama.cpp builds and the plan) to /data/local/tmp/mm and marks the tools executable.
Then for each subject of plan/run.env it starts the kit with that subject's plan/<id>.env. The kit downloads the model
itself (MM_MODEL_URL), checks it and runs the benches and answers within its own limits. Its output goes to a file on
the phone and its exit code to another, and the adb session that started it stays open, so a dropped adb connection
only means the carrier polls for the exit code (the kit ignores SIGHUP). Past the kit's own limits plus a margin, the
carrier stops it.

Then it copies every file of out/<id>/ to /data/local/tmp/QDC_logs/ as mm__<id>__<file>.log, flat, because QDC
collects that folder and whether it keeps subfolders or other extensions is unknown. It adds mm__<id>__host.txt.log
(how the carrier ran the kit, key=value lines) and mm__<id>__stdout.txt.log (the kit's own output, which also holds
its message when it refused its inputs), and deletes the model. Its own log is mm__carrier.log.

It never prints the phone's serial or the host's environment, and passes no token anywhere: the kit needs none.
Standard library only, Python 3.8 or later.
"""

import os
import re
import subprocess
import sys
import tempfile
import time

DEVICE_ROOT = "/data/local/tmp/mm"
QDC_LOGS = "/data/local/tmp/QDC_logs"
PLAN_VERSION = "1"
CARRIER_VERSION = 1
# The files that must be executable on the phone, relative to mm/ (run.sh is run with sh, but marking it is harmless).
TOOLS = (
    "llama-android/llama-bench",
    "llama-android/llama-completion",
    "llama-snapdragon/bin/llama-bench",
    "llama-snapdragon/bin/llama-completion",
    "kit/run.sh",
)
# The kit's own limits when an env file leaves one out (KIT_DEFAULTS in lib/devices/types.ts).
LIMIT_DEFAULTS = {"MM_LIMIT_FETCH": 3600, "MM_LIMIT_CHECK": 600, "MM_LIMIT_TOTAL": 2400}
# Seconds the kit gets beyond its own limits before the carrier stops it (QDC_CARRIER_MARGIN_SECONDS in lib/devices/qdc.ts).
MARGIN_SECONDS = 300
POLL_SECONDS = 15
PUSH_SECONDS = 1200
ADB_SECONDS = 120
KILL_GRACE_SECONDS = 10
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
SAFE_FILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
SAFE_VALUE = re.compile(r"^[A-Za-z0-9._:/,@+=-]*$")
POLL_MARK = "mm-carrier-poll"


class PlanError(Exception):
    pass


def read_env(path):
    """NAME=value lines (kitEnvLines' format) as a dict. Refuses a value the kit couldn't take."""
    values = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\r\n")
            if not line or line.startswith("#"):
                continue
            name, sep, value = line.partition("=")
            if not sep or not re.match(r"^[A-Z][A-Z0-9_]*$", name) or not SAFE_VALUE.match(value):
                raise PlanError(f"{os.path.basename(path)} has a line the kit can't take")
            values[name] = value
    return values


def read_plan(mm):
    """The run key and the subject ids of mm/plan/run.env, after checking each has its env and system files."""
    plan = os.path.join(mm, "plan")
    try:
        run = read_env(os.path.join(plan, "run.env"))
    except OSError as e:
        raise PlanError(f"no plan/run.env ({e.strerror})") from None
    if run.get("MM_PLAN_VERSION") != PLAN_VERSION:
        raise PlanError(f"plan/run.env isn't plan version {PLAN_VERSION}")
    subjects = [s for s in run.get("MM_SUBJECTS", "").split(",") if s]
    if not subjects:
        raise PlanError("plan/run.env names no subjects")
    for sid in subjects:
        if not SAFE_ID.match(sid):
            raise PlanError(f"unsafe subject id {sid!r}")
        for name in (f"{sid}.env", f"{sid}.system"):
            if not os.path.isfile(os.path.join(plan, name)):
                raise PlanError(f"plan/{name} is missing")
        env = read_env(os.path.join(plan, f"{sid}.env"))
        if env.get("MM_SUBJECT") != sid:
            raise PlanError(f"plan/{sid}.env is for {env.get('MM_SUBJECT') or 'no subject'}")
    return run.get("MM_RUN", ""), subjects


def kit_limit(env):
    """Seconds the kit may take: its download, check and total limits, plus the margin."""
    total = 0
    for name, default in LIMIT_DEFAULTS.items():
        try:
            total += int(env.get(name, default))
        except ValueError:
            total += default
    return total + MARGIN_SECONDS


class Carrier:
    def __init__(self, mm, adb="adb", sleep=time.sleep, clock=time.monotonic, out=None):
        self.mm = mm
        self.adb_path = adb
        self.sleep = sleep
        self.clock = clock
        self.out = out or sys.stdout
        self.started = clock()
        self.lines = []

    def log(self, message):
        line = f"[mm {self.clock() - self.started:6.0f}s] {message}"
        self.lines.append(line)
        print(line, file=self.out, flush=True)

    def adb(self, *args, timeout=ADB_SECONDS):
        """(exit code, output) of one adb command. 124 when it timed out, 127 when adb couldn't start."""
        try:
            p = subprocess.run(
                [self.adb_path, *args],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return 124, "timed out"
        except OSError as e:
            return 127, str(e)
        return p.returncode, p.stdout.decode("utf-8", "replace").replace("\r\n", "\n")

    def shell(self, command, timeout=ADB_SECONDS):
        return self.adb("shell", command, timeout=timeout)

    def push_text(self, text, remote):
        fd, path = tempfile.mkstemp(prefix="mm-", suffix=".txt")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(text)
            return self.adb("push", path, remote)[0] == 0
        finally:
            os.remove(path)

    def save_log(self):
        self.push_text("\n".join(self.lines) + "\n", f"{QDC_LOGS}/mm__carrier.log")

    def run(self):
        """0 when the kit ran for every subject (its results may still say the file failed), else 1."""
        try:
            key, subjects = read_plan(self.mm)
        except PlanError as e:
            self.log(f"No usable plan: {e}.")
            self.shell(f"mkdir -p {QDC_LOGS}")
            self.save_log()
            return 1
        self.log(f"Run {key}: {', '.join(subjects)}.")
        rc, out = self.adb("get-state", timeout=60)
        if rc != 0 or "device" not in out:
            self.adb("wait-for-device", timeout=180)
            rc, out = self.adb("get-state", timeout=60)
            if rc != 0 or "device" not in out:
                self.log("No phone over adb.")
                return 1
        self.shell(f"rm -rf {DEVICE_ROOT}; mkdir -p {QDC_LOGS}")
        t0 = self.clock()
        rc, out = self.adb("push", self.mm, DEVICE_ROOT, timeout=PUSH_SECONDS)
        push_seconds = round(self.clock() - t0)
        if rc != 0:
            self.log(f"adb push failed ({rc}): {out.strip()[-300:]}")
            self.save_log()
            return 1
        self.log(f"Pushed mm/ in {push_seconds} s.")
        tools = [f"{DEVICE_ROOT}/{t}" for t in TOOLS if os.path.isfile(os.path.join(self.mm, t))]
        self.shell(f"chmod 755 {' '.join(tools)}; mkdir -p {DEVICE_ROOT}/model {DEVICE_ROOT}/out")
        needed = [f"{DEVICE_ROOT}/kit/run.sh"] + [f"{DEVICE_ROOT}/plan/{s}.env" for s in subjects]
        rc, out = self.shell(f"ls {' '.join(needed)}")
        if rc != 0:
            self.log(f"The push left files out: {out.strip()[-300:]}")
            self.save_log()
            return 1
        ran_all = True
        for sid in subjects:
            ran = self.run_subject(key, sid, push_seconds)
            ran_all = ran_all and ran
            self.save_log()
        self.shell(f"rm -rf {DEVICE_ROOT}")
        self.log("Done: the kit ran for every subject." if ran_all else "Done: the kit couldn't run for every subject.")
        self.save_log()
        return 0 if ran_all else 1

    def run_subject(self, key, sid, push_seconds):
        env = read_env(os.path.join(self.mm, "plan", f"{sid}.env"))
        limit = kit_limit(env)
        base = f"{DEVICE_ROOT}/run-{sid}"
        start = (
            f"cd {DEVICE_ROOT} && rm -f {base}.exit {base}.pid {base}.stdout && "
            f"(trap '' HUP; set -a; . ./plan/{sid}.env; set +a; "
            f"sh kit/run.sh </dev/null >{base}.stdout 2>&1 & echo $! >{base}.pid; wait $!; echo $? >{base}.exit)"
        )
        self.log(f"{sid}: starting the kit (at most {limit} s).")
        t0 = self.clock()
        session = subprocess.Popen(
            [self.adb_path, "shell", start],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            code, errors, stopped = self.wait_kit(sid, base, limit, t0)
        finally:
            try:
                session.wait(timeout=30)
            except subprocess.TimeoutExpired:
                session.kill()
                session.wait()
        kit_seconds = round(self.clock() - t0)
        self.log(f"{sid}: the kit ended with {code if code is not None else 'no exit code'} after {kit_seconds} s.")
        files = self.collect(sid, base)
        facts = {
            "carrier": CARRIER_VERSION,
            "run": key,
            "subject": sid,
            "push_seconds": push_seconds,
            "kit_exit": code if code is not None else "none",
            "kit_seconds": kit_seconds,
            "limit_seconds": limit,
            "stopped": 1 if stopped else 0,
            "adb_errors": errors,
            "files": len(files),
        }
        self.push_text("".join(f"{k}={v}\n" for k, v in facts.items()), f"{QDC_LOGS}/mm__{sid}__host.txt.log")
        self.shell(f"rm -rf {DEVICE_ROOT}/model; mkdir -p {DEVICE_ROOT}/model")
        ran = "run.txt" in files and code != "2"
        if not ran:
            self.log(f"{sid}: the kit couldn't run (see mm__{sid}__stdout.txt.log).")
        return ran

    def wait_kit(self, sid, base, limit, t0):
        """(exit code or None, adb errors, stopped by the carrier). Echoes the kit's new output lines as it goes."""
        seen = 0
        errors = 0
        while True:
            # The mark shows adb answered; the exit code of the last cat doesn't matter (no output file yet is fine).
            rc, out = self.shell(f"cat {base}.exit 2>/dev/null; echo {POLL_MARK}; cat {base}.stdout 2>/dev/null")
            if POLL_MARK not in out:
                errors += 1
                if errors % 4 == 1:
                    self.log(f"{sid}: adb didn't answer ({rc}); the kit keeps running on the phone.")
                self.adb("wait-for-device", timeout=60)
            else:
                head, _, stdout = out.partition(f"{POLL_MARK}\n")
                lines = stdout.splitlines()
                for line in lines[seen:]:
                    self.log(f"{sid}: {line}")
                seen = max(seen, len(lines))
                code = head.strip()
                if re.match(r"^[0-9]+$", code):
                    return code, errors, False
            if self.clock() - t0 > limit:
                self.log(f"{sid}: past the kit's limits ({limit} s): stopping it.")
                self.shell(f"kill -TERM $(cat {base}.pid) 2>/dev/null; pkill -f 'kit/run[.]sh'; pkill -f 'llama-[bc][eo][nm]'")
                self.sleep(KILL_GRACE_SECONDS)
                self.shell(f"kill -KILL $(cat {base}.pid) 2>/dev/null; pkill -KILL -f 'llama-[bc][eo][nm]'")
                return None, errors, True
            self.sleep(POLL_SECONDS)

    def collect(self, sid, base):
        """Copies out/<id>/* and the kit's output into QDC_logs, flat. Returns the kit's file names."""
        out_dir = f"{DEVICE_ROOT}/out/{sid}"
        rc, listing = self.shell(f"ls {out_dir} 2>/dev/null")
        files = [f for f in listing.split() if SAFE_FILE.match(f)] if rc == 0 else []
        if files:
            self.shell(
                f"mkdir -p {QDC_LOGS} && cd {out_dir} && for f in *; do "
                f'[ -f "$f" ] && cp "$f" "{QDC_LOGS}/mm__{sid}__$f.log"; done'
            )
        self.shell(f"cp {base}.stdout {QDC_LOGS}/mm__{sid}__stdout.txt.log 2>/dev/null")
        self.log(f"{sid}: {len(files)} kit files copied to QDC_logs.")
        return files


def main(mm=None, adb="adb"):
    """Runs the plan in mm/ next to tests/ (the zip's root, /qdc/appium/ on QDC's host)."""
    here = os.path.dirname(os.path.abspath(__file__))
    return Carrier(mm or os.path.join(os.path.dirname(here), "mm"), adb=adb).run()


if __name__ == "__main__":
    sys.exit(main())
