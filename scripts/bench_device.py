"""A portable device bench: start a llama-server here and time the real steps on the invented class.

    uv run python -m scripts.bench_device --label mac-lfm --gguf models/LFM3-VL-2B-Q4_K_M.gguf
        [--kind lfm|glimmer] [--mmproj FILE] [--server-bin FILE | --url URL] [--ctx N] [--ngl 99]
        [--ub N] [--batch N] [--swa-full] [--runs 3] [--essays 24] [--reasoning low,medium,high]
        [--draft FILE] [--draft-n 3,5,7,15,16] [--full-grade] [--no-ask] [--expect-power plugged|battery]
        [--skip-llama-bench] [--hash] [--margin 1] [--max-minutes N] [--out eval/reports]

Runs unchanged on a Mac, a Jetson Orin Nano and a Raspberry Pi (Linux, CPU only). It records the
device's facts (never its host name, address or user name) and power source, checks the model fits
in memory, runs llama-bench (pp512, tg128) when it sits next to llama-server, then starts its own
llama-server on a free 127.0.0.1 port (never 8081 to 8085, so a running app is left alone), samples
the server's peak memory, and always stops it, errors included. Steps, on a copy of the invented
demo class in a throwaway home, with the bodies the device sends and cache_prompt off: one router
decision, the name pass, request topics and grading one essay (--runs each), the name pass over the
essay folder, one ask_device answer (LFM only: ask_device runs on LFM3-VL-2B with Glimmer plugged in
too), and with --full-grade the whole grading job. --reasoning repeats the steps at each level
(Glimmer). --draft repeats them greedily with a DFlash drafter for each --draft-n and compares.
Writes eval/reports/device_<label>.md and raw/device_<label>.jsonl (numbers, lengths and hashes,
never text), and refuses to write either if it holds a host name, an address, a user name or a home
path. Exit 0, 1 when it could not run or refused to write, 2 when the report is marked invalid
(the power source changed or was not the expected one) or a step failed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import httpx

from base.config import _is_loopback_url, load_settings
from base.local_llm import NAMES_PROMPT, NAMES_SCHEMA, REASONING_LEVELS, LocalLLM, parse_json
from base.policy import UserPolicy
from eval import run_eval
from scripts import gguf_info, plug_in_model, secrets_scan
from scripts.bench_speed import STEPS, step_messages
from scripts.device_smoke import GRADE, copy_invented

KINDS = ("lfm", "glimmer")
POWER = ("plugged", "battery")
APP_PORTS = range(8081, 8086)  # the app's own model servers; the bench never takes one
DEFAULT_CTX = {"lfm": 16384, "glimmer": 4096}  # scripts/start_checker.sh's CHECKER_CTX; the Jetson unit's -c
ALIAS = "bench"
# scripts/start_checker.sh's flags for LFM3-VL-2B: thinking off on the server, Liquid's sampling
LIQUID_FLAGS = ["--reasoning-budget", "0", "--temp", "0.1", "--top-p", "1.0", "--top-k", "50", "--min-p", "0.0",
                "--repeat-penalty", "1.1"]  # fmt: skip
DRAFT_FLAGS = ["-ngld", "99", "--spec-type", "draft-dflash"]  # scripts/start.sh's, with --spec-draft-n-max N
ESSAY_STEP = "Name pass, essay folder"
ASK_STEP = "ask_device answer"
GRADE_STEP = "Grading job, every essay"
ORDER = (*STEPS, ESSAY_STEP, ASK_STEP, GRADE_STEP)
ASK_QUESTION = "Which essays mention a school garden, and what does the rubric say about evidence?"
KEEP_DRAFTER = 1.1  # decided before any measurement: the drafter stays off below this speedup
META_DFLASH = ("Meta's model card gives 1.5x for DFlash on an M4 Max at Q4_K_M (23.7 to 37.8 tokens/s): "
               "https://huggingface.co/meta-models/Muse-Glimmer-30B")  # fmt: skip
GIB, MIB = 1024**3, 1024**2
BUFFER = re.compile(r"\b(model|KV|RS|compute) buffer size\s*=\s*([\d.]+) MiB")
OFFLOADED = re.compile(r"offloaded (\d+)/(\d+) layers")


class BenchError(RuntimeError):
    """A plain reason the bench could not go on."""


# ----- facts about this device -----


def _run(cmd: list[str], timeout: float = 10) -> str | None:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def _read(path: str | Path) -> str | None:
    try:
        return Path(path).read_text(errors="replace")
    except OSError:
        return None


def parse_kb_lines(text: str) -> dict[str, int]:
    """`Key:   1234 kB` lines (/proc/meminfo, /proc/PID/status) as key -> bytes."""
    return {m[1]: int(m[2]) * 1024 for m in re.finditer(r"^(\w+):\s+(\d+)\s*kB", text, re.M)}


def parse_vm_stat(text: str) -> int | None:
    """macOS vm_stat: free, inactive and speculative pages, in bytes (what a new process could get)."""
    page = re.search(r"page size of (\d+) bytes", text)
    counts = dict(re.findall(r"^Pages (free|inactive|speculative):\s+(\d+)\.", text, re.M))
    if not page or not counts:
        return None
    return sum(int(v) for v in counts.values()) * int(page[1])


def parse_pmset(text: str) -> tuple[str, str]:
    """`pmset -g batt` -> (plugged | battery | unknown, what it said)."""
    m = re.search(r"Now drawing from '([^']+)'", text or "")
    if not m:
        return "unknown", "pmset said nothing about the power source"
    return ("battery" if "Battery" in m[1] else "plugged"), m[1]


def linux_power(root: Path = Path("/sys/class/power_supply")) -> tuple[str, str]:
    """(plugged | battery | unknown, detail) from /sys. A board with no battery is on its supply."""
    supplies = []
    for d in sorted(root.glob("*")) if root.is_dir() else []:
        kind = (_read(d / "type") or "").strip()
        supplies.append((kind, (_read(d / "online") or "").strip(), (_read(d / "status") or "").strip()))
    batteries = [s for s in supplies if s[0] == "Battery"]
    if any(status == "Discharging" for _k, _o, status in batteries):
        return "battery", "a battery is discharging"
    online = [kind for kind, on, _s in supplies if kind != "Battery" and on == "1"]
    if online:
        return "plugged", f"{online[0]} supply online"
    if batteries:
        return "unknown", "a battery is present and no supply says it is online"
    return "plugged", "no battery reported (a board on its power supply)"


def power_source() -> tuple[str, str]:
    if sys.platform == "darwin":
        return parse_pmset(_run(["pmset", "-g", "batt"]) or "")
    return linux_power()


def parse_throttled(text: str | None) -> str | None:
    """`vcgencmd get_throttled` (throttled=0x50005) in words."""
    m = re.search(r"throttled=(0x[0-9a-fA-F]+)", text or "")
    if not m:
        return None
    value = int(m[1], 16)
    bits = {0: "under-voltage now", 1: "frequency capped now", 2: "throttled now", 3: "soft temperature limit now",
            16: "under-voltage since boot", 17: "capped since boot", 18: "throttled since boot",
            19: "soft temperature limit since boot"}  # fmt: skip
    words = [w for bit, w in bits.items() if value >> bit & 1]
    return f"{m[1]} ({', '.join(words) or 'none'})"


def parse_temp(text: str | None) -> float | None:
    m = re.search(r"temp=([\d.]+)", text or "")
    return float(m[1]) if m else None


def parse_tegrastats(line: str | None) -> str | None:
    """One tegrastats line as `RAM used/total MB, GPU n%`."""
    ram, gpu = re.search(r"RAM (\d+)/(\d+)MB", line or ""), re.search(r"GR3D_FREQ (\d+)%", line or "")
    if not ram:
        return None
    return f"RAM {ram[1]}/{ram[2]} MB" + (f", GPU {gpu[1]}%" if gpu else "")


def tegrastats_sample(timeout: float = 5) -> str | None:
    """One line of tegrastats (read only), when it is installed."""
    binary = shutil.which("tegrastats")
    if not binary:
        return None
    try:
        proc = subprocess.Popen([binary, "--interval", "500"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    except OSError:
        return None
    try:
        timer = threading.Timer(timeout, proc.kill)
        timer.start()
        line = proc.stdout.readline() if proc.stdout else ""
        timer.cancel()
    finally:
        proc.kill()
        proc.wait()
    return parse_tegrastats(line)


def pi_state() -> dict[str, str]:
    """Throttling and temperature on a Raspberry Pi (vcgencmd), else nothing."""
    if not shutil.which("vcgencmd"):
        return {}
    temp = parse_temp(_run(["vcgencmd", "measure_temp"]))
    return {"throttled": parse_throttled(_run(["vcgencmd", "get_throttled"])) or "not readable",
            "temp": "not readable" if temp is None else f"{temp:.1f} C"}  # fmt: skip


def os_name() -> str:
    if sys.platform == "darwin":
        version = _run(["sw_vers", "-productVersion"])
        return f"macOS {version}" if version else "macOS"
    pretty = re.search(r'^PRETTY_NAME="?([^"\n]+)"?', _read("/etc/os-release") or "", re.M)
    return f"{pretty[1] if pretty else platform.system()}, kernel {platform.release()}"


def cpu_name() -> str:
    if sys.platform == "darwin":
        return _run(["sysctl", "-n", "machdep.cpu.brand_string"]) or "not reported"
    info = _read("/proc/cpuinfo") or ""
    m = re.search(r"^(?:model name|Model|Hardware)\s*:\s*(.+)$", info, re.M)
    return m[1].strip() if m else platform.processor() or "not reported"


def memory_total() -> int | None:
    gb = plug_in_model.total_memory_gb()
    return None if gb is None else int(gb * GIB)


def available_memory() -> int | None:
    if sys.platform == "darwin":
        return parse_vm_stat(_run(["vm_stat"]) or "")
    return parse_kb_lines(_read("/proc/meminfo") or "").get("MemAvailable")


def process_rss(pid: int) -> int | None:
    """The process's resident memory in bytes: the kernel's peak (VmHWM) on Linux, ps on macOS."""
    if sys.platform.startswith("linux"):
        status = parse_kb_lines(_read(f"/proc/{pid}/status") or "")
        values = [v for k, v in status.items() if k in ("VmHWM", "VmRSS")]
        return max(values) if values else None
    out = _run(["ps", "-o", "rss=", "-p", str(pid)])
    return int(out) * 1024 if out and out.isdigit() else None


def other_llama_servers() -> int:
    out = _run(["ps", "-A", "-o", "comm="]) or ""
    return sum(1 for line in out.splitlines() if Path(line.strip()).name == "llama-server")


def gib(n: float | None) -> str:
    return "unknown" if n is None else f"{n / GIB:.2f} GB"


def device_facts(model: Path, server_bin: str | None) -> dict[str, str]:
    facts = {"OS": os_name(), "Board": (_read("/proc/device-tree/model") or "").strip("\0 \n") or "not reported",
             "CPU": cpu_name(), "Architecture": platform.machine() or "unknown", "Cores": str(os.cpu_count() or "unknown"),
             "Memory": gib(memory_total())}  # fmt: skip
    try:
        facts["Free disk on the model's volume"] = gib(shutil.disk_usage(model.parent).free)
    except OSError:
        facts["Free disk on the model's volume"] = "unknown"
    build = gguf_info.llama_build(server_bin)
    facts["llama.cpp build"] = f"b{build}" if build else "not read"
    facts["Other llama-server processes running"] = str(other_llama_servers())
    if shutil.which("nvpmodel"):
        mode = _run(["nvpmodel", "-q"])
        facts["Jetson power mode (nvpmodel -q)"] = " ".join(mode.split()) if mode else "not readable"
    return facts


# ----- memory -----


def precheck(sizes: dict[str, int], kv: int | None, memory: int | None, margin_gb: float) -> tuple[str | None, str | None]:
    """(why the model cannot load here, why the drafter cannot), each None when it fits. `sizes` holds
    the model's bytes and, when given, the projector's and the drafter's."""
    if memory is None:
        return None, None
    need = sizes["model"] + sizes.get("mmproj", 0) + (kv or 0) + margin_gb * GIB
    if need > memory:
        return (f"the model does not fit: it needs about {need / GIB:.1f} GB with its KV cache and {margin_gb:g} GB "
                f"for the system, and this device has {memory / GIB:.1f} GB"), None  # fmt: skip
    if "draft" in sizes and need + sizes["draft"] > memory:
        return None, (f"the drafter does not fit on this board: with it the run needs about "
                      f"{(need + sizes['draft']) / GIB:.1f} GB of {memory / GIB:.1f} GB")  # fmt: skip
    return None, None


class Sampler(threading.Thread):
    """Every `every` seconds: the server's resident memory (its peak) and the lowest available memory
    on the device, whose drop also counts the GPU's share on a Jetson."""

    def __init__(self, pid: int | None, every: float = 0.5, rss=process_rss, available=available_memory):
        super().__init__(daemon=True)
        self.pid, self.every, self.rss, self.available = pid, every, rss, available
        self.peak_rss: int | None = None
        self.min_available: int | None = None
        self.done = threading.Event()

    def sample(self) -> None:
        rss = self.rss(self.pid) if self.pid else None
        if rss is not None:
            self.peak_rss = max(rss, self.peak_rss or 0)
        free = self.available()
        if free is not None:
            self.min_available = free if self.min_available is None else min(free, self.min_available)

    def run(self) -> None:
        while True:
            self.sample()
            if self.done.wait(self.every):
                return

    def stop(self) -> None:
        self.done.set()
        if self.is_alive():
            self.join()


# ----- llama.cpp -----


def free_port(pick=None) -> int:
    """A free 127.0.0.1 port that is not one of the app's model ports."""

    def os_port() -> int:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    for _ in range(50):
        port = (pick or os_port)()
        if port not in APP_PORTS:
            return port
    raise BenchError("could not find a free port")


def parse_llama_bench(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r, dict) and "avg_ts" in r:
            test = f"tg{r.get('n_gen')}" if r.get("n_gen") else f"pp{r.get('n_prompt')}"
            rows.append({"phase": "llama-bench", "step": test, "tokens_per_s": round(float(r["avg_ts"]), 1),
                         "stddev": round(float(r.get("stddev_ts") or 0), 1)})  # fmt: skip
    return rows


def llama_bench(binary: Path, opts: argparse.Namespace) -> tuple[list[dict], str | None]:
    cmd = [str(binary), "-m", str(opts.gguf), "-p", "512", "-n", "128", "-r", "3", "-ngl", str(opts.ngl), "-o", "jsonl"]
    cmd += ["-ub", str(opts.ub)] if opts.ub else []
    cmd += ["-b", str(opts.batch)] if opts.batch else []
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=opts.bench_timeout)
    except subprocess.TimeoutExpired:
        return [], f"llama-bench took longer than {opts.bench_timeout} s"
    except OSError as exc:
        return [], f"llama-bench could not start ({type(exc).__name__})"
    rows = parse_llama_bench(out.stdout)
    if out.returncode or not rows:
        return [], f"llama-bench exited {out.returncode} with no results"
    return rows, None


def parse_buffers(log: str) -> dict:
    """MiB per buffer kind (model, KV, RS, compute) summed over devices, and the offloaded layers."""
    out: dict = {}
    for kind, mib in BUFFER.findall(log):
        out[kind] = round(out.get(kind, 0.0) + float(mib), 1)
    layers = OFFLOADED.findall(log)
    if layers:
        out["offloaded"] = f"{layers[-1][0]}/{layers[-1][1]}"
    return out


def server_command(server_bin: str, opts: argparse.Namespace, port: int, key_file: Path, draft_n: int | None = None) -> list[str]:
    # -lv 4: llama.cpp b11972 logs the buffer sizes and offloaded layers only at that verbosity
    cmd = [server_bin, "--model", str(opts.gguf), "--alias", ALIAS, "--host", "127.0.0.1", "--port", str(port),
           "-c", str(opts.ctx), "-np", "1", "-ngl", str(opts.ngl), "--jinja", "--no-slots", "--cache-ram", "0",
           "--ctx-checkpoints", "0", "--api-key-file", str(key_file), "-lv", "4"]  # fmt: skip
    cmd += ["--mmproj", str(opts.mmproj)] if opts.mmproj else ["--no-mmproj"]
    cmd += ["-ub", str(opts.ub)] if opts.ub else []
    cmd += ["-b", str(opts.batch)] if opts.batch else []
    cmd += ["--swa-full"] if opts.swa_full else []
    cmd += LIQUID_FLAGS if opts.kind == "lfm" else []
    if draft_n is not None:
        cmd += ["-md", str(opts.draft), *DRAFT_FLAGS, "--spec-draft-n-max", str(draft_n)]
    return cmd


def wait_healthy(proc, port: int, client: httpx.Client, timeout: float, sleep=time.sleep) -> float:
    """Seconds from the start to the first 200 from /health."""
    start = time.monotonic()
    while True:
        if proc.poll() is not None:
            raise BenchError(f"llama-server stopped while loading (exit {proc.returncode})")
        try:
            if client.get(f"http://127.0.0.1:{port}/health", timeout=2).status_code == 200:
                return time.monotonic() - start
        except httpx.HTTPError:
            pass
        if time.monotonic() - start > timeout:
            raise BenchError(f"llama-server did not answer /health within {timeout:.0f} s")
        sleep(0.2)


def stop(proc) -> None:
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


@contextmanager
def served(cmd: list[str], port: int, log_path: Path, client: httpx.Client, timeout: float):
    """llama-server from `cmd`, healthy: yields (process, load seconds) and always stops it."""
    with log_path.open("wb") as log:
        proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    try:
        yield proc, wait_healthy(proc, port, client, timeout)
    finally:
        stop(proc)


def log_tail(path: Path, n: int = 20) -> str:
    lines = (_read(path) or "").splitlines()[-n:]
    return "\n".join(lines).replace(str(Path.home()), "~")


# ----- steps -----


def post(client: httpx.Client, url: str, headers: dict, body: dict, timeout) -> dict:
    """One completion: wall time, llama-server's timings and the reply's length and hash, never its text."""
    start = time.monotonic()
    try:
        response = client.post(f"{url}/chat/completions", json=body, headers=headers, timeout=timeout)
        response.raise_for_status()
        data = response.json()
        choice = data["choices"][0]
        message = choice.get("message") or {}
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
        return {"latency_ms": int((time.monotonic() - start) * 1000), "error": type(exc).__name__}
    ms = int((time.monotonic() - start) * 1000)
    t, usage = data.get("timings") or {}, data.get("usage") or {}
    content = message.get("content") or ""
    try:
        valid = isinstance(parse_json(content), dict)
    except ValueError:
        valid = False
    return {
        "latency_ms": ms, "prompt_n": t.get("prompt_n", usage.get("prompt_tokens")),
        "prompt_per_s": _round(t.get("prompt_per_second")), "gen_n": t.get("predicted_n", usage.get("completion_tokens")),
        "gen_per_s": _round(t.get("predicted_per_second")), "draft_n": t.get("draft_n"),
        "draft_accepted": t.get("draft_n_accepted"),
        "reasoning_tokens": (usage.get("completion_tokens_details") or {}).get("reasoning_tokens"),
        "reasoning_chars": len(message.get("reasoning_content") or ""), "finish_reason": choice.get("finish_reason"),
        "valid_json": valid, "sha256": hashlib.sha256(content.encode()).hexdigest()[:16], "chars": len(content),
    }  # fmt: skip


def _round(x) -> float | None:
    return None if x is None else round(float(x), 1)


def body_for(llm: LocalLLM, messages: list[dict], schema: dict | None, max_tokens: int, reasoning: str | None,
             greedy: bool = False) -> dict:
    """The body the device sends for this step, with cache_prompt off so each call reads its whole
    prompt, and temperature 0 for a greedy comparison."""
    body = llm.build_body(messages, max_tokens=max_tokens, json_schema=schema, reasoning=reasoning)
    body["cache_prompt"] = False
    if greedy:
        body["temperature"] = 0.0
    return body


class Steps:
    def __init__(self, client: httpx.Client, llm: LocalLLM, workspace: Path, topics: dict):
        self.client, self.llm, self.workspace = client, llm, workspace
        self.steps = step_messages(workspace, topics)

    def call(self, body: dict, max_tokens: int) -> dict:
        return post(self.client, self.llm.base_url, self.llm.headers(), body, self.llm.timeout_for(max_tokens, None))

    def run(self, runs: int, *, phase: str, reasoning: str | None, greedy: bool = False) -> list[dict]:
        rows = []
        for step, (messages, schema, max_tokens) in self.steps.items():
            body = body_for(self.llm, messages, schema, max_tokens, reasoning, greedy)
            for i in range(runs):
                rows.append({"phase": phase, "step": step, "run": i + 1, "reasoning": reasoning, **self.call(body, max_tokens)})
        return rows

    def essays(self, n: int, reasoning: str | None) -> list[dict]:
        rows = []
        for i, path in enumerate(sorted((self.workspace / "essays").glob("*.md"))[:n], 1):
            messages = [{"role": "system", "content": NAMES_PROMPT}, {"role": "user", "content": path.read_text()}]
            body = body_for(self.llm, messages, NAMES_SCHEMA, 1500, reasoning)
            rows.append({"phase": "essays", "step": ESSAY_STEP, "run": i, "reasoning": reasoning, **self.call(body, 1500)})
        return rows


def bench_settings(kind: str, url: str, key: str | None, home: Path, workspace: Path, environ=None):
    """Device-only settings on the bench's server, for this process only (.env is never written)."""
    env = dict(os.environ if environ is None else environ)
    env.update({"BASE_HOME": str(home), "WORKSPACE_ROOT": str(workspace), "DEVICE_ONLY": "1", "CHECKER_BACKEND": "lfm",
                "CHECKER_URL": url, "CHECKER_MODEL": ALIAS, "CHECKER_API_KEY": key or "", "SEARCH_EMBEDDINGS": "0",
                "RELAY_URL": "", "DREAMING_BACKEND": "rules", "PRIMARY_MODEL": kind})  # fmt: skip
    if kind == "glimmer":
        env.update({"GLIMMER_BACKEND": "llama_server", "ANSWER_URL": url, "ROUTER_URL": url, "LLAMA_API_KEY": key or ""})
    settings = load_settings(env)
    settings.ensure_home()
    return settings


def ask_row(settings) -> dict:
    """One ask_device answer through the device's own DeviceAsk (BM25 only, no embedder)."""
    from base.services import Services

    row: dict = {"phase": "ask", "step": ASK_STEP, "run": 1}
    services = Services.for_eval(settings)
    start = time.monotonic()
    try:
        result = services.ask.run(ASK_QUESTION)
        row.update(parts=result.parts, answered=result.answered, timed_out=result.timed_out, quotes=len(result.quotes),
                   sha256=hashlib.sha256(result.answer.encode()).hexdigest()[:16], chars=len(result.answer))  # fmt: skip
    except Exception as exc:  # the bench goes on; the report says this step failed
        row["error"] = type(exc).__name__
    finally:
        row["latency_ms"] = int((time.monotonic() - start) * 1000)
        services.close()
    return row


def grade_row(settings) -> dict:
    """The run_private_task grading job over the essay folder, as Muse starts it."""
    from base.services import Services

    row: dict = {"phase": "full_grade", "step": GRADE_STEP, "run": 1}
    services = Services.for_eval(settings)
    start = time.monotonic()
    try:
        job = services.jobs.get(services.agent.run_sync(GRADE, "essays")) or {}
        row.update(status=job.get("status"), model_steps=len(job.get("model_log") or []),
                   feedback_files=len(list(settings.paths.output.rglob("*.md"))))  # fmt: skip
    except Exception as exc:
        row["error"] = type(exc).__name__
    finally:
        row["latency_ms"] = int((time.monotonic() - start) * 1000)
        services.close()
    return row


# ----- the drafter -----


def draft_table(rows: list[dict], draft_ns: list[int]) -> list[dict]:
    """Per drafted-token setting and step, against the greedy run without a drafter: wall-time
    speedup, generation speedup, acceptance (accepted / drafted) and how many outputs matched."""
    base = {(r["step"], r["run"]): r for r in rows if r["phase"] == "greedy" and "error" not in r}
    out = []
    for n in draft_ns:
        for step in ORDER:
            mine = [r for r in rows if r["phase"] == f"draft-{n}" and r["step"] == step and "error" not in r
                    and (step, r["run"]) in base]  # fmt: skip
            if not mine:
                continue
            before = [base[(step, r["run"])] for r in mine]
            drafted = sum(r.get("draft_n") or 0 for r in mine)
            accepted = sum(r.get("draft_accepted") or 0 for r in mine)
            out.append({
                "draft_n": n, "step": step, "runs": len(mine),
                "speedup": _ratio(_mean(r["latency_ms"] for r in before), _mean(r["latency_ms"] for r in mine)),
                "gen_before": _mean(r.get("gen_per_s") for r in before), "gen_after": _mean(r.get("gen_per_s") for r in mine),
                "acceptance": accepted / drafted if drafted else None, "drafted_per_call": drafted / len(mine),
                "same": sum(r["sha256"] == base[(step, r["run"])]["sha256"] for r in mine),
            })  # fmt: skip
    for r in out:
        r["gen_speedup"] = _ratio(r["gen_after"], r["gen_before"])
    return out


def _mean(values) -> float | None:
    values = [v for v in values if v is not None]
    return statistics.mean(values) if values else None


def _ratio(a: float | None, b: float | None) -> float | None:
    return a / b if a and b else None


def draft_verdict(table: list[dict]) -> list[str]:
    lines = []
    by_n: dict[int, list[dict]] = {}
    for r in table:
        by_n.setdefault(r["draft_n"], []).append(r)
    for n, rs in by_n.items():
        speed = _mean(r["speedup"] for r in rs)
        same = sum(r["same"] for r in rs), sum(r["runs"] for r in rs)
        keep = speed is not None and speed >= KEEP_DRAFTER
        lines.append(f"- {n} drafted tokens: {_x(speed)} mean wall-time speedup, {same[0]} of {same[1]} outputs the same "
                     f"as without the drafter: {'worth keeping on' if keep else 'keep the drafter off'}.")  # fmt: skip
    per_call = {n: round(sum(r["drafted_per_call"] for r in rs), 1) for n, rs in by_n.items()}
    if len(per_call) > 1:
        changed = len(set(per_call.values())) > 1
        lines.append(f"- Did --spec-draft-n-max change how much was drafted? {'Yes' if changed else 'No: every setting drafted the same, so the sweep measured one setting'}.")
    return lines


def _x(v: float | None) -> str:
    return "n/a" if v is None else f"{v:.2f}x"


# ----- the report -----


def host_names() -> set[str]:
    try:
        full = socket.gethostname()
    except OSError:
        return set()
    return {n for n in (full, full.split(".")[0]) if len(n) >= 4 and n.lower() != "localhost"}


def unsafe(text: str) -> list[str]:
    """Kinds of machine detail in a report (a key, an address, a host or user name, a home path), never the values."""
    found = {kind for _w, _n, kind in secrets_scan.scan_text(text, "", secrets_scan.user_names())}
    if any(re.search(rf"(?<![\w-]){re.escape(n)}(?![\w-])", text, re.I) for n in host_names()):
        found.add("host name")
    home = str(Path.home())
    if (len(home) > 1 and home in text) or re.search(r"/(?:Users|home)/[^/\s`|]+", text):
        found.add("home path")
    return sorted(found)


def _ms(v: float | None) -> str:
    return "n/a" if v is None else f"{v:.0f}"


def _num(v: float | None, digits: int = 1) -> str:
    return "n/a" if v is None else f"{v:.{digits}f}"


def reasoning(rows: list[dict]) -> str:
    """Mean reasoning tokens when the server counts them, else the mean length of reasoning_content."""
    tokens = _mean(r.get("reasoning_tokens") for r in rows)
    if tokens is not None:
        return _ms(tokens)
    chars = _mean(r.get("reasoning_chars") for r in rows)
    return f"{chars:.0f} chars" if chars else "n/a"


def step_lines(rows: list[dict]) -> list[str]:
    lines = ["| Step | Reasoning | Calls | Mean latency (ms) | p50 (ms) | Prompt tokens | Prompt tok/s | Generated tokens "
             "| Gen tok/s | Reasoning | Valid JSON | Errors |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]  # fmt: skip
    keys = []
    for r in rows:
        if r["phase"] in ("steps", "essays", "ask", "full_grade") and (r["step"], r.get("reasoning")) not in keys:
            keys.append((r["step"], r.get("reasoning")))
    keys.sort(key=lambda k: (ORDER.index(k[0]) if k[0] in ORDER else len(ORDER),
                             REASONING_LEVELS.index(k[1]) if k[1] in REASONING_LEVELS else -1))  # fmt: skip
    for step, level in keys:
        rs = [r for r in rows if r["step"] == step and r.get("reasoning") == level and r["phase"] != "greedy"
              and not r["phase"].startswith("draft")]  # fmt: skip
        ok = [r for r in rs if "error" not in r]
        lat = [r["latency_ms"] for r in ok]
        has_json = any("valid_json" in r for r in ok)
        lines.append(
            f"| {step} | {level or 'n/a'} | {len(rs)} | {_ms(_mean(lat))} | {_ms(statistics.median(lat) if lat else None)} "
            f"| {_ms(_mean(r.get('prompt_n') for r in ok))} | {_num(_mean(r.get('prompt_per_s') for r in ok))} "
            f"| {_ms(_mean(r.get('gen_n') for r in ok))} | {_num(_mean(r.get('gen_per_s') for r in ok))} "
            f"| {reasoning(ok)} "
            f"| {sum(bool(r.get('valid_json')) for r in ok) if has_json else 'n/a'} | {len(rs) - len(ok)} |"
        )
    return lines


def render(ctx: dict) -> str:
    rows, facts = ctx["rows"], ctx["facts"]
    valid = "valid" if not ctx["invalid"] else "INVALID: " + "; ".join(ctx["invalid"])
    lines = [
        f"# Device bench: {ctx['label']}", "", f"Command: `{ctx['command']}`", "",
        f"Date: {ctx['date']}. Result: {valid}.", "",
        "Invented demo data only: a copy of the invented class in a throwaway home. Numbers are from this one run "
        "on this one device. Prompt and generation speeds are llama-server's own timings with the prompt cache off.", "",
        "## Device", "", "| What | Value |", "|---|---|", *(f"| {k} | {v} |" for k, v in facts.items()), "",
        "## Model", "", "| What | Value |", "|---|---|", *(f"| {k} | {v} |" for k, v in ctx["model"].items()), "",
        "## llama-bench (pp512, tg128, 3 repetitions)", "",
    ]  # fmt: skip
    bench = [r for r in rows if r["phase"] == "llama-bench"]
    if bench:
        lines += ["| Test | Tokens/s | Std dev |", "|---|---:|---:|", *(f"| {r['step']} | {r['tokens_per_s']} | {r['stddev']} |" for r in bench)]
    else:
        lines.append(f"Not run: {ctx['skipped'].get('llama-bench', 'no result')}.")
    lines += ["", "## Server", "", "| What | Value |", "|---|---|", *(f"| {k} | {v} |" for k, v in ctx["server"].items()), ""]
    lines += ["## Steps", "", *step_lines(rows), ""]
    essays = [r for r in rows if r["phase"] == "essays" and "error" not in r]
    if essays:
        total = sum(r["latency_ms"] for r in essays) / 1000
        lines += [f"Name pass over {len(essays)} essays: {total:.1f} s in all, {_ms(_mean(r['latency_ms'] for r in essays))} ms "
                  f"per essay, {sum(bool(r.get('valid_json')) for r in essays)} valid JSON replies.", ""]  # fmt: skip
    for r in rows:
        if r["phase"] == "ask" and "error" not in r:
            lines += [f"ask_device: {r['latency_ms'] / 1000:.1f} s, {r['parts']} part(s), {r['answered']} answered, "
                      f"{r['quotes']} quote(s), timed out: {'yes' if r['timed_out'] else 'no'}.", ""]  # fmt: skip
        if r["phase"] == "full_grade" and "error" not in r:
            lines += [f"Grading job: {r['latency_ms'] / 1000:.1f} s, status {r['status']}, {r['model_steps']} model steps, "
                      f"{r['feedback_files']} feedback files written in the throwaway home.", ""]  # fmt: skip
    if ctx["draft_ns"]:
        lines += ["## Drafter", "", f"Rule written before measuring: the drafter stays off unless it is at least "
                  f"{KEEP_DRAFTER}x faster. {META_DFLASH}. Both runs are greedy (temperature 0); same output compares "
                  "a hash of each reply, never its text.", ""]  # fmt: skip
        table = draft_table(rows, ctx["draft_ns"])
        if table:
            lines += ["| Drafted tokens | Step | Runs | Gen tok/s without | Gen tok/s with | Wall-time speedup | Gen speedup "
                      "| Acceptance | Drafted per call | Same output |", "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|"]  # fmt: skip
            lines += [f"| {r['draft_n']} | {r['step']} | {r['runs']} | {_num(r['gen_before'])} | {_num(r['gen_after'])} "
                      f"| {_x(r['speedup'])} | {_x(r['gen_speedup'])} | {_num(None if r['acceptance'] is None else 100 * r['acceptance'], 0)}"
                      f"{'%' if r['acceptance'] is not None else ''} | {_num(r['drafted_per_call'])} | {r['same']}/{r['runs']} |"
                      for r in table]  # fmt: skip
            lines += ["", *draft_verdict(table), ""]
        else:
            lines += [f"No drafted run: {ctx['skipped'].get('drafter', 'it did not run')}.", ""]
    lines += ["## Power", "", "| When | Source |", "|---|---|", *(f"| {k} | {v} |" for k, v in ctx["power"].items()), ""]
    if ctx["pi"]:
        lines += ["## Raspberry Pi", "", "| When | Throttling | Temperature |", "|---|---|---|",
                  *(f"| {k} | {v.get('throttled')} | {v.get('temp')} |" for k, v in ctx["pi"].items()), ""]  # fmt: skip
    if ctx["skipped"]:
        lines += ["## Not run", "", *(f"- {k}: {v}." for k, v in ctx["skipped"].items()), ""]
    lines += [f"Raw rows: raw/device_{ctx['label']}.jsonl next to this report (numbers, lengths and hashes only).", ""]
    return "\n".join(lines)


def write_report(ctx: dict, out: Path) -> tuple[Path, Path] | list[str]:
    """Both files, or the kinds of machine detail that stopped the write."""
    text = render(ctx)
    raw_text = "".join(json.dumps(r) + "\n" for r in ctx["rows"])
    found = sorted(set(unsafe(text)) | set(unsafe(raw_text)))
    if found:
        return found
    md, raw = out / f"device_{ctx['label']}.md", out / "raw" / f"device_{ctx['label']}.jsonl"
    raw.parent.mkdir(parents=True, exist_ok=True)
    md.write_text(text)
    raw.write_text(raw_text)
    return md, raw


# ----- the run -----


def csv_ints(text: str) -> list[int]:
    try:
        values = [int(x) for x in text.split(",") if x.strip()]
    except ValueError:
        raise argparse.ArgumentTypeError("give whole numbers separated by commas, like 3,5,7,15,16") from None
    if not values or min(values) < 1:
        raise argparse.ArgumentTypeError("each value must be 1 or more")
    return values


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m scripts.bench_device", description=__doc__.split("\n")[0])
    p.add_argument("--label", required=True, help="the report's name: eval/reports/device_<label>.md, e.g. mac-lfm")
    p.add_argument("--gguf", required=True, type=Path, help="the model file")
    p.add_argument("--kind", choices=KINDS, default="lfm", help="the request body: LFM3-VL-2B's or Glimmer's (default lfm)")
    p.add_argument("--mmproj", type=Path, help="a vision projector to load as the app does (LFM3-VL-2B)")
    p.add_argument("--server-bin", help="llama-server (default LLAMA_SERVER_BIN, CHECKER_SERVER_BIN, then PATH)")
    p.add_argument("--url", help="attach to a llama-server already running on this device instead of starting one")
    p.add_argument("--ctx", type=int, help="context size (default: the app's, 16384 for lfm as start_checker.sh, "
                   "4096 for glimmer as the Jetson unit; give 16384 for Glimmer on a laptop)")
    p.add_argument("--ngl", type=int, default=99, help="layers on the GPU (default 99; a Pi has no GPU and ignores it)")
    p.add_argument("--ub", type=int, help="physical batch (-ub), 128 on an 8 GB Jetson")
    p.add_argument("--batch", type=int, help="logical batch (-b), 512 on an 8 GB Jetson")
    p.add_argument("--swa-full", action="store_true", help="--swa-full, as the Jetson unit runs it")
    p.add_argument("--runs", type=int, default=3, help="calls per step (default 3)")
    p.add_argument("--essays", type=int, default=24, help="essays in the folder name pass (default 24)")
    p.add_argument("--reasoning", default="low", help="Glimmer reasoning levels to sweep, like low,medium,high")
    p.add_argument("--draft", type=Path, help="a DFlash drafter: rerun the steps greedily with it")
    p.add_argument("--draft-n", type=csv_ints, default=[3, 5, 7, 15, 16], help="drafted tokens to sweep (default 3,5,7,15,16)")
    p.add_argument("--full-grade", action="store_true", help="also run the whole grading job over the essays")
    p.add_argument("--no-ask", action="store_true", help="leave out the ask_device answer")
    p.add_argument("--expect-power", choices=POWER, help="mark the report invalid unless the power source is this")
    p.add_argument("--skip-llama-bench", action="store_true")
    p.add_argument("--hash", action="store_true", help="put the model file's sha256 (first 16) in the report")
    p.add_argument("--margin", type=float, default=1.0, help="GB kept for the system in the memory check (default 1)")
    p.add_argument("--max-minutes", type=float, help="phases not started by then are skipped and listed")
    p.add_argument("--load-timeout", type=float, default=600, help="seconds to wait for /health (default 600)")
    p.add_argument("--keep-log", type=Path, help="copy the first server's log here, to read on this device (never copy it back)")
    p.add_argument("--bench-timeout", type=int, default=900, help=argparse.SUPPRESS)
    p.add_argument("--out", type=Path, default=run_eval.REPORTS_DIR)
    return p


def check_args(p: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", args.label):
        p.error("--label may use lowercase letters, digits, dash and underscore")
    for name in ("gguf", "mmproj", "draft"):
        path = getattr(args, name)
        if path is not None and not path.is_file():
            p.error(f"--{name}: no file at {path.name}")
    if args.ctx is None:
        args.ctx = DEFAULT_CTX[args.kind]
    if args.runs < 1 or args.essays < 0 or args.ctx < 256:
        p.error("--runs must be 1 or more, --essays 0 or more and --ctx at least 256")
    levels = [x.strip() for x in args.reasoning.split(",") if x.strip()]
    if any(x not in REASONING_LEVELS for x in levels) or not levels:
        p.error(f"--reasoning takes levels from {', '.join(REASONING_LEVELS)}")
    if args.kind == "lfm" and levels != ["low"]:
        p.error("--reasoning is for --kind glimmer (LFM3-VL-2B runs with thinking off)")
    args.levels = levels if args.kind == "glimmer" else [None]
    if args.url and not _is_loopback_url(args.url):
        p.error("--url must be this device (127.0.0.1 or localhost)")
    if args.url and args.draft:
        p.error("--draft restarts the server, so it cannot go with --url")


class Deadline:
    def __init__(self, minutes: float | None):
        self.end = None if minutes is None else time.monotonic() + minutes * 60

    def over(self) -> bool:
        return self.end is not None and time.monotonic() > self.end


def model_facts(args: argparse.Namespace, sizes: dict[str, int], kv: int | None, fit: str) -> dict[str, str]:
    facts = {"File": args.gguf.name, "Kind": "LFM3-VL-2B body (Liquid's sampling, thinking off)" if args.kind == "lfm"
             else "Glimmer body (reasoning strength in chat_template_kwargs)", "Size": gib(sizes["model"])}  # fmt: skip
    if args.mmproj:
        facts["Vision projector"] = f"{args.mmproj.name}, {gib(sizes['mmproj'])}"
    if args.draft:
        facts["Drafter"] = f"{args.draft.name}, {gib(sizes['draft'])}"
    facts["sha256 (first 16)"] = gguf_info.sha256(args.gguf)[:16] if args.hash else "not hashed (pass --hash)"
    facts[f"KV cache at {args.ctx:,} tokens"] = gib(kv) if kv is not None else "not given in the file"
    flags = " ".join(f for f in (f"-ub {args.ub}" if args.ub else "", f"-b {args.batch}" if args.batch else "",
                                 "--swa-full" if args.swa_full else "") if f)  # fmt: skip
    facts["Server flags"] = f"-c {args.ctx} -ngl {args.ngl} -np 1 --cache-ram 0 --ctx-checkpoints 0 {flags}".strip()
    facts["Memory check"] = fit
    return facts


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    p = parser()
    args = p.parse_args(argv)
    check_args(p, args)
    server_bin = args.server_bin or plug_in_model.server_binary(plug_in_model.ENV)
    if not args.url and not server_bin:
        p.error("no llama-server found: pass --server-bin or set LLAMA_SERVER_BIN")
    previous = signal.signal(signal.SIGTERM, lambda *_: sys.exit(143)) if threading.current_thread() is threading.main_thread() else None
    try:
        return bench(args, argv, server_bin)
    finally:
        if previous is not None:
            signal.signal(signal.SIGTERM, previous)


def bench(args: argparse.Namespace, argv: list[str], server_bin: str | None) -> int:
    deadline = Deadline(args.max_minutes)
    skipped: dict[str, str] = {}
    rows: list[dict] = []
    power = {"At start": power_source()}
    pi = {"Before": pi_state()} if shutil.which("vcgencmd") else {}
    facts = device_facts(args.gguf, server_bin)
    sizes = {"model": args.gguf.stat().st_size}
    sizes.update({k: getattr(args, k).stat().st_size for k in ("mmproj", "draft") if getattr(args, k)})
    try:
        kv = gguf_info.read(args.gguf).kv_cache_bytes(args.ctx)
    except (gguf_info.GGUFError, OSError):
        kv = None
    memory = memory_total()
    no_model, no_draft = precheck(sizes, kv, memory, args.margin)
    used = sizes["model"] + sizes.get("mmproj", 0) + (kv or 0) + args.margin * GIB
    fit = no_model or f"fits: about {used / GIB:.1f} GB of {gib(memory)} with a {args.margin:g} GB margin"
    model = model_facts(args, sizes, kv, fit)
    server: dict[str, str] = {}
    draft_ns = args.draft_n if args.draft else []
    if no_draft:
        skipped["drafter"] = no_draft
    status = 0
    with tempfile.TemporaryDirectory(prefix="base-bench-") as tmp:
        tmp_path = Path(tmp)
        workspace = tmp_path / "workspace"
        copy_invented(workspace)
        key = os.environ.get("LLAMA_API_KEY") if args.url else secrets.token_urlsafe(32)
        key_file = tmp_path / "llama_api_key"
        key_file.write_text(key or "")
        key_file.chmod(0o600)
        bench_bin = Path(server_bin).with_name("llama-bench") if server_bin else None
        if no_model:
            skipped["everything"] = no_model
        elif args.skip_llama_bench or args.url:
            skipped["llama-bench"] = "--skip-llama-bench" if args.skip_llama_bench else "attached to a running server (--url)"
        elif not (bench_bin and bench_bin.is_file()):
            skipped["llama-bench"] = "no llama-bench next to llama-server"
        else:
            found, why = llama_bench(bench_bin, args)  # before any server, so the model is never loaded twice
            rows += found
            if why:
                skipped["llama-bench"] = why
        client = httpx.Client(trust_env=False)
        try:
            if not no_model:
                status = run_phases(args, server_bin, key, key_file, tmp_path, workspace, client, rows, server,
                                    skipped, deadline, draft_ns, no_draft)  # fmt: skip
        finally:
            client.close()
    power["At end"] = power_source()
    if pi:
        pi["After"] = pi_state()
    invalid = []
    if power["At start"][0] != power["At end"][0]:
        invalid.append(f"the power source changed during the run ({power['At start'][0]} to {power['At end'][0]})")
    if args.expect_power and power["At start"][0] != args.expect_power:
        invalid.append(f"the run was meant to be {args.expect_power} but the device was {power['At start'][0]}")
    if args.expect_power:
        power["Expected"] = (args.expect_power, "--expect-power")
    ctx = {"label": args.label, "command": run_eval.shown_command("scripts.bench_device", argv),
           "date": datetime.now().strftime("%Y-%m-%d %H:%M"), "invalid": invalid, "facts": facts, "model": model,
           "server": server, "rows": rows, "draft_ns": draft_ns, "skipped": skipped, "pi": pi,
           "power": {k: f"{v[0]} ({v[1]})" for k, v in power.items()}}  # fmt: skip
    written = write_report(ctx, args.out)
    if isinstance(written, list):
        print(f"Refused to write the report: it would hold {', '.join(written)}. Nothing was written.", file=sys.stderr)
        return 1
    print(f"Wrote {run_eval.display_path(written[0])} and {run_eval.display_path(written[1])}")
    if no_model or status == 1:
        return 1
    errors = any("error" in r for r in rows)
    return 2 if invalid or errors or status == 2 else 0


def run_phases(args, server_bin, key, key_file, tmp_path, workspace, client, rows, server, skipped, deadline,
               draft_ns, no_draft) -> int:
    """Every phase on the server(s). Returns 1 when the server would not start, else 0."""
    port = None if args.url else free_port()
    url = args.url.rstrip("/") if args.url else f"http://127.0.0.1:{port}/v1"
    if not url.endswith("/v1"):
        url += "/v1"
    settings = bench_settings(args.kind, url, key, tmp_path / "home", workspace)
    llm = LocalLLM(settings, "checker" if args.kind == "lfm" else "answer", client=client)
    steps = Steps(client, llm, workspace, UserPolicy.load(settings.policy_path).request_topics)
    log = tmp_path / "server.log"

    def phases(pid: int | None) -> None:
        sampler = Sampler(pid)
        before = available_memory()
        sampler.start()
        try:
            sample = tegrastats_sample()
            if sample:
                server["tegrastats while loaded"] = sample
            for level in args.levels:
                if deadline.over():
                    skipped[f"steps at {level or 'default'}"] = "past --max-minutes"
                    continue
                rows.extend(steps.run(args.runs, phase="steps", reasoning=level))
            first = args.levels[0]
            plan = [("essay folder", args.essays > 0, lambda: rows.extend(steps.essays(args.essays, first))),
                    ("ask_device", args.kind == "lfm" and not args.no_ask, lambda: rows.append(ask_row(settings))),
                    ("grading job", args.full_grade, lambda: rows.append(grade_row(settings))),
                    ("greedy run without the drafter", bool(draft_ns) and not no_draft,
                     lambda: rows.extend(steps.run(args.runs, phase="greedy", reasoning=first, greedy=True)))]  # fmt: skip
            for name, wanted, go in plan:
                if wanted and deadline.over():
                    skipped[name] = "past --max-minutes"
                elif wanted:
                    go()
            if args.kind == "glimmer" and not args.no_ask:
                skipped["ask_device"] = "it runs on LFM3-VL-2B (the checker) even with Glimmer plugged in"
        finally:
            sampler.stop()
        server["Peak resident memory of llama-server"] = gib(sampler.peak_rss) + (" (ps; Metal buffers may not count)" if sys.platform == "darwin" else " (VmHWM)")
        if before is not None and sampler.min_available is not None:
            server["Lowest available memory during the run"] = f"{gib(sampler.min_available)} (a drop of {gib(max(0, before - sampler.min_available))})"

    if args.url:
        server["Server"] = "attached with --url: no load time or memory numbers for it"
        phases(None)
        return 0
    try:
        with served(server_command(server_bin, args, port, key_file), port, log, client, args.load_timeout) as (proc, load):
            server["Load time (start to the first 200 from /health)"] = f"{load:.1f} s"
            phases(proc.pid)
            buffers = parse_buffers(_read(log) or "")  # read after the steps, when the log is surely written
            for kind, label in (("model", "Model buffers"), ("KV", "KV cache buffers"), ("RS", "Recurrent state buffers"),
                                ("compute", "Compute buffers")):  # fmt: skip
                if kind in buffers:
                    server[label] = f"{buffers[kind]:.0f} MiB"
            server["Layers offloaded to the GPU"] = buffers.get("offloaded", "not in the log")
    except BenchError as exc:
        skipped["server"] = str(exc)
        print(f"{exc}. The end of its log:\n{log_tail(log)}", file=sys.stderr)
        return 1
    finally:
        if args.keep_log and log.is_file():
            shutil.copyfile(log, args.keep_log)  # for reading on this device only; never in a report
    for n in draft_ns if not no_draft else []:
        if deadline.over():
            skipped[f"drafter at {n}"] = "past --max-minutes"
            continue
        port = free_port()
        llm.base_url = f"http://127.0.0.1:{port}/v1"
        try:
            with served(server_command(server_bin, args, port, key_file, n), port, log, client, args.load_timeout) as (proc, _load):
                sampler = Sampler(proc.pid)
                sampler.start()
                try:
                    rows.extend(steps.run(args.runs, phase=f"draft-{n}", reasoning=args.levels[0], greedy=True))
                finally:
                    sampler.stop()
                server[f"Peak resident memory with the drafter at {n}"] = gib(sampler.peak_rss)
        except BenchError as exc:
            skipped[f"drafter at {n}"] = str(exc)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
