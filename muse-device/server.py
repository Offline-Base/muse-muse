#!/usr/bin/env python3
"""Muse Device: an MCP tool server that lets Muse Muse see and use one board.

Standard library only, so a freshly flashed board can run it with nothing installed.
It speaks MCP over streamable HTTP at POST /mcp and requires a bearer token.

  python3 server.py [--host 127.0.0.1] [--port 8765] [--allow-exec]

The token is read from ~/.muse-device/token, created on first start with mode 600.
It binds to loopback by default. Reach it through an SSH forward or a tunnel, not an open port.

The training tools need setup-train.sh to have run and train.py beside this file. train.py runs in ~/train/venv, because
this server's python has no torch. Each run keeps its state in ~/train/runs/<name>/, so it outlives a restart of this server.
Under systemd, give this server's unit KillMode=process and OOMPolicy=continue. Otherwise restarting it ends a run, and a run
killed for memory takes the server down with it, leaving nothing to report that.
"""
import argparse
import array
import base64
import contextlib
import glob
import hmac
import json
import math
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.3.0"
PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"]
MAX_BODY_BYTES = 1024 * 1024
MAX_OUTPUT_BYTES = 64 * 1024
CAPTURE_WARMUP_FRAMES = 30
MODEL_DIR = os.path.expanduser("~/models")
MODEL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.gguf")
# On loopback only, like this server. The fleet's own model service uses its own port and is left alone.
MODEL_PORT = 8766
MODEL_START_TIMEOUT_S = 120
MODEL_ANSWER_TIMEOUT_S = 240
# Under the 5 minutes a platform route gets, so it can still hear why.
INSTALL_TIMEOUT_S = 280
MODEL_MAX_BYTES = 8 * 2**30
# Left free by a download, which also keeps a training run's TRAIN_DISK_GIB safe from one.
INSTALL_RESERVE_GIB = 1
# A platform dataset comes to about 8 MB, so this is far past any real one, and short of what a loop of appends could write.
DATASET_MAX_BYTES = 64 * 2**20
# start_model holds model_lock for minutes. A call waiting that long outlives its caller, then acts when nobody expects it.
MODEL_LOCK_WAIT_S = 5
# The same for a capture: callers give up on a recording of up to 30 seconds, and the queue would go on recording for nobody.
CAPTURE_LOCK_WAIT_S = 5
TRAIN_DIR = os.path.expanduser("~/train")
TRAIN_PYTHON = os.path.join(TRAIN_DIR, "venv", "bin", "python")
TRAIN_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "train.py")
CONVERTER = os.path.join(TRAIN_DIR, "llama.cpp", "convert_lora_to_gguf.py")
BASE_DIR = os.path.join(TRAIN_DIR, "models")
DATASET_DIR = os.path.join(TRAIN_DIR, "datasets")
RUN_DIR = os.path.join(TRAIN_DIR, "runs")
TRAIN_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
DEFAULT_BASE = "Qwen3.5-0.8B"
ACTIVE_STATES = ("loading", "training", "converting")
# Room for the adapter, its GGUF and the log. Even at the highest rank these come to a few hundred MB.
TRAIN_DISK_GIB = 0.5
# On top of the base's weights: gradients through the model and the optimizer's state, plus some of the runtime. A real
# 442-token step peaked at 1.91 GiB allocated on 1.42 GiB of loaded weights, and took about 2.3 GiB off what was available.
TRAIN_OVERHEAD_GIB = 1.0
STOP_TIMEOUT_S = 30
# secrets.token_urlsafe(32) makes 43. Under this the token is empty, cut short, or one anyone could guess.
MIN_TOKEN_CHARS = 32

# start_model's floor, on top of the files themselves: llama-server's own buffers, and its cache per 4096 tokens of context.
# Estimates, not measured on a board: this is here to stop a load that can't fit, not to judge one that nearly does.
MODEL_OVERHEAD_GIB = 0.5
MODEL_CONTEXT_GIB_PER_4K = 0.1

capture_lock = threading.Lock()
# Taken before train_lock when both are needed: the board's memory holds a running model or a training run, not both.
model_lock = threading.Lock()
model_process = None
model_loaded = None
train_lock = threading.Lock()
train_process = None
# One download at a time: each works out its room alone, so several together could pass the reserve, and they'd share a .part.
install_lock = threading.Lock()


class ToolError(Exception):
    """A failure the model should read and can act on."""


def read_text(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read().replace("\0", "").strip()
    except OSError:
        return None


def run(args, timeout=10):
    """Runs a command with no shell. Returns its output, or None when it can't run."""
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout.strip() if done.returncode == 0 else None


def find_cameras():
    """Video nodes that capture frames. A UVC camera's metadata node has index 1, so index 0 picks the real one."""
    cameras = []
    for node in sorted(glob.glob("/sys/class/video4linux/video*")):
        if read_text(f"{node}/index") == "0":
            name = os.path.basename(node)
            cameras.append({"device": f"/dev/{name}", "name": read_text(f"{node}/name")})
    return cameras


def find_microphones():
    """USB sound cards with a capture device. The board's own APE and HDA cards have no microphone attached."""
    mics = []
    for card in sorted(glob.glob("/proc/asound/card[0-9]*")):
        if os.path.exists(f"{card}/usbid") and os.path.exists(f"{card}/pcm0c"):
            index = card.rsplit("card", 1)[1]
            mics.append({"device": f"plughw:{index},0", "name": read_text(f"{card}/id")})
    return mics


def meminfo_gib(key):
    match = re.search(rf"^{key}:\s+(\d+) kB", read_text("/proc/meminfo") or "", re.M)
    return round(int(match.group(1)) / 1024 / 1024, 2) if match else None


def describe_device(_args):
    disk = shutil.disk_usage("/")
    usb = run(["lsusb"])
    temps = [read_text(p) for p in glob.glob("/sys/devices/virtual/thermal/thermal_zone*/temp")]
    temps = [int(t) / 1000 for t in temps if t and t.lstrip("-").isdigit()]
    return text_result(
        json.dumps(
            {
                "hostname": read_text("/etc/hostname"),
                "model": read_text("/proc/device-tree/model"),
                "os": (re.search(r'^PRETTY_NAME="(.+)"', read_text("/etc/os-release") or "", re.M) or [None, None])[1],
                "cpu_cores": os.cpu_count(),
                "memory_gib": {"total": meminfo_gib("MemTotal"), "available": meminfo_gib("MemAvailable")},
                "disk_gib": {"total": round(disk.total / 2**30, 1), "free": round(disk.free / 2**30, 1)},
                "gpu": run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"]),
                "max_temp_c": max(temps) if temps else None,
                "cameras": find_cameras(),
                "microphones": find_microphones(),
                "usb_devices": usb.splitlines() if usb else [],
                "buses": {
                    "i2c": sorted(glob.glob("/dev/i2c-*")),
                    "spi": sorted(glob.glob("/dev/spidev*")),
                    "gpio": sorted(glob.glob("/dev/gpiochip*")),
                    "serial": sorted(glob.glob("/dev/ttyTHS*") + glob.glob("/dev/ttyUSB*") + glob.glob("/dev/ttyACM*")),
                },
                "note": "Motors and many sensors don't identify themselves, so this list can't show them.",
            },
            indent=2,
        )
    )


def int_arg(args, name, default, low, high):
    value = args.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ToolError(f"{name} must be a whole number from {low} to {high}.")
    return value


def choose(found, kind, wanted):
    if not found:
        raise ToolError(f"No {kind} is attached to this board.")
    if wanted is None:
        return found[0]["device"]
    if wanted not in [item["device"] for item in found]:
        raise ToolError(f"{wanted} is not a {kind} on this board. Found: {[item['device'] for item in found]}")
    return wanted


@contextlib.contextmanager
def capture_lock_or_busy():
    if not capture_lock.acquire(timeout=CAPTURE_LOCK_WAIT_S):
        raise ToolError("The camera and microphone are busy with another capture. Try again in a moment.")
    try:
        yield
    finally:
        capture_lock.release()


def capture_image(args):
    device = choose(find_cameras(), "camera", args.get("device"))
    width = int_arg(args, "width", 1280, 160, 1920)
    height = int_arg(args, "height", 720, 120, 1080)
    with capture_lock_or_busy(), tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "frame.jpg")
        # The first frames are dark while auto-exposure settles, so only the last one is kept.
        done = subprocess.run(
            ["gst-launch-1.0", "-q", "v4l2src", f"device={device}", f"num-buffers={CAPTURE_WARMUP_FRAMES}", "!",
             f"image/jpeg,width={width},height={height}", "!", "multifilesink", f"location={path}", "max-files=1"],
            capture_output=True, text=True, timeout=30,
        )
        if done.returncode != 0 or not os.path.exists(path):
            raise ToolError(f"The camera didn't return a frame at {width}x{height}: {(done.stderr or done.stdout)[-400:]}")
        with open(path, "rb") as f:
            data = base64.b64encode(f.read()).decode()
    return {"content": [{"type": "image", "data": data, "mimeType": "image/jpeg"}]}


def record_audio(args):
    device = choose(find_microphones(), "microphone", args.get("device"))
    seconds = int_arg(args, "seconds", 3, 1, 30)
    with capture_lock_or_busy(), tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "audio.wav")
        done = subprocess.run(
            ["arecord", "-q", "-D", device, "-d", str(seconds), "-f", "S16_LE", "-r", "16000", "-c", "1", path],
            capture_output=True, text=True, timeout=seconds + 10,
        )
        if done.returncode != 0 or not os.path.exists(path):
            raise ToolError(f"The microphone didn't record: {done.stderr[-400:]}")
        with wave.open(path) as w:
            samples = array.array("h", w.readframes(w.getnframes()))
        with open(path, "rb") as f:
            data = base64.b64encode(f.read()).decode()
    rms = math.sqrt(sum(s * s for s in samples) / len(samples)) if samples else 0
    peak = max((abs(s) for s in samples), default=0)
    return {
        "content": [
            {"type": "text", "text": json.dumps({"seconds": seconds, "sample_rate": 16000, "rms": round(rms, 1), "peak": peak})},
            {"type": "audio", "data": data, "mimeType": "audio/wav"},
        ]
    }


def run_command(args):
    command = args.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ToolError("command must be a non-empty string.")
    timeout = int_arg(args, "timeout_s", 60, 1, 600)
    try:
        done = subprocess.run(["/bin/bash", "-lc", command], capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ToolError(f"The command ran past {timeout} seconds and was stopped.")
    output = (done.stdout + done.stderr)[-MAX_OUTPUT_BYTES:].decode(errors="replace")
    return text_result(json.dumps({"exit_code": done.returncode, "output": output}))


def model_files():
    os.makedirs(MODEL_DIR, exist_ok=True)
    return sorted(name for name in os.listdir(MODEL_DIR) if name.endswith(".gguf"))


def model_file(name, kind="model"):
    """The path of a file in MODEL_DIR, from its bare name."""
    if name not in model_files():
        raise ToolError(f"{name} is not a {kind} on this board. Found: {model_files()}")
    return os.path.join(MODEL_DIR, name)


def find_llama_server():
    """llama-server on PATH, or the newest build the fleet installed, with the library folders it needs."""
    found = shutil.which("llama-server")
    if found:
        return found, {}
    builds = sorted(glob.glob("/opt/jetson-gguf/*/llama-*/llama-server"))
    if not builds:
        raise ToolError("llama-server isn't installed on this board.")
    folder = os.path.dirname(builds[-1])
    libraries = [folder] + glob.glob(os.path.join(os.path.dirname(folder), "cudart-*"))
    return builds[-1], {"LD_LIBRARY_PATH": ":".join(libraries)}


def model_request(path, body=None, timeout=5):
    """A call to the running llama-server. Returns its JSON, and raises OSError when it can't answer."""
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"http://127.0.0.1:{MODEL_PORT}{path}", data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as res:
        return json.load(res)


def stop_running_model():
    global model_process, model_loaded
    if model_process and model_process.poll() is None:
        model_process.terminate()
        try:
            model_process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            model_process.kill()
            model_process.wait()
    model_process, model_loaded = None, None


@contextlib.contextmanager
def model_lock_or_busy():
    if not model_lock.acquire(timeout=MODEL_LOCK_WAIT_S):
        raise ToolError("Another call is starting or stopping a model on this board. Try again in a minute. list_models shows what's running.")
    try:
        yield
    finally:
        model_lock.release()


def list_models(_args):
    running = model_process is not None and model_process.poll() is None
    return text_result(
        json.dumps(
            {
                "files": [{"name": name, "gib": round(os.path.getsize(os.path.join(MODEL_DIR, name)) / 2**30, 3)} for name in model_files()],
                "running": model_loaded if running else None,
                "memory_available_gib": meminfo_gib("MemAvailable"),
                "disk_free_gib": round(shutil.disk_usage("/").free / 2**30, 1),
            }
        )
    )


class HttpsOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith("https://"):
            raise ToolError("That URL redirects to one that isn't https.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


DOWNLOADS = urllib.request.build_opener(HttpsOnlyRedirect)


def install_model(args):
    url, name = args.get("url"), args.get("name")
    if not isinstance(url, str) or not url.startswith("https://"):
        raise ToolError("url must be an https URL.")
    if not isinstance(name, str) or not MODEL_NAME.fullmatch(name):
        raise ToolError("name must be a file name ending in .gguf, with only letters, digits, dots, dashes and underscores.")
    if not install_lock.acquire(blocking=False):
        raise ToolError("Another download is running on this board. Try again when it's done.")
    try:
        return download_model(url, name)
    finally:
        install_lock.release()


def download_model(url, name):
    os.makedirs(MODEL_DIR, exist_ok=True)
    path = os.path.join(MODEL_DIR, name)
    if os.path.exists(path):
        raise ToolError(f"{name} is already in {MODEL_DIR}, and this would replace it. Choose another name.")
    with train_lock:
        active = active_run()
    if active:
        raise ToolError(f"Training run {active} needs this board's disk. Wait for it, or call stop_training first.")
    room = min(MODEL_MAX_BYTES, shutil.disk_usage(MODEL_DIR).free - INSTALL_RESERVE_GIB * 2**30)
    too_big = f"That file doesn't fit: this board can take {max(room, 0) / 2**30:.1f} GiB, which keeps {INSTALL_RESERVE_GIB} GiB of disk free."
    part = f"{path}.part"
    deadline = time.time() + INSTALL_TIMEOUT_S
    try:
        with DOWNLOADS.open(url, timeout=30) as res, open(part, "wb") as f:
            length = res.headers.get("Content-Length") or ""
            if length.isdigit() and int(length) > room:
                raise ToolError(too_big)
            written = 0
            # read1 returns whatever has arrived, so a server that trickles bytes still meets the deadline.
            while block := res.read1(1024 * 1024):
                written += len(block)
                if written > room:
                    raise ToolError(too_big)
                f.write(block)
                if time.time() > deadline:
                    raise ToolError(f"The download ran past {INSTALL_TIMEOUT_S} seconds and was stopped.")
        with open(part, "rb") as f:
            if f.read(4) != b"GGUF":
                raise ToolError("That file isn't a GGUF.")
        os.replace(part, path)
    finally:
        if os.path.exists(part):
            os.remove(part)
    return text_result(json.dumps({"installed": name, "gib": round(os.path.getsize(path) / 2**30, 3)}))


def model_memory_gib(paths, context):
    return sum(os.path.getsize(path) for path in paths) / 2**30 + MODEL_OVERHEAD_GIB + context / 4096 * MODEL_CONTEXT_GIB_PER_4K


def start_model(args):
    global model_process, model_loaded
    model = model_file(args.get("model"))
    adapter = args.get("adapter")
    adapter_path = model_file(adapter, "adapter") if adapter is not None else None
    binary, env = find_llama_server()
    context = int_arg(args, "context", 4096, 512, 32768)
    command = [binary, "--model", model, "--host", "127.0.0.1", "--port", str(MODEL_PORT), "--no-webui", "-ngl", "999", "-c",
               str(context), "-np", "1", "--jinja", "--reasoning", "off"]
    if adapter_path:
        command += ["--lora", adapter_path]
    with model_lock_or_busy():
        with train_lock:
            active = active_run()
        if active:
            raise ToolError(f"Training run {active} is using this board's memory. Wait for it to finish, or call stop_training first.")
        stop_running_model()
        # After the stop, since what's free depends on it. A failed GPU allocation has frozen and rebooted these boards (train.py).
        needed = model_memory_gib([model] + ([adapter_path] if adapter_path else []), context)
        memory = meminfo_gib("MemAvailable")
        if memory is not None and memory < needed:
            raise ToolError(f"This model needs about {needed:.1f} GiB of free memory at this context size, and this board has {memory} GiB available. No model is running now.")
        log = open(os.path.join(MODEL_DIR, "llama-server.log"), "wb")
        model_process = subprocess.Popen(command, env={**os.environ, **env}, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        log.close()
        deadline = time.time() + MODEL_START_TIMEOUT_S
        while time.time() < deadline:
            if model_process.poll() is not None:
                code = model_process.returncode
                model_process = None
                with open(os.path.join(MODEL_DIR, "llama-server.log"), errors="replace") as f:
                    raise ToolError(f"llama-server exited with {code}: {f.read()[-600:]}")
            try:
                model_request("/health", timeout=2)
                model_loaded = {"model": args["model"], "adapter": adapter}
                return list_models({})
            except OSError:
                time.sleep(1)
        stop_running_model()
    raise ToolError(f"llama-server wasn't ready after {MODEL_START_TIMEOUT_S} seconds.")


def stop_model(_args):
    with model_lock_or_busy():
        stop_running_model()
    return list_models({})


def ask_model(args):
    prompt = args.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ToolError("prompt must be a non-empty string.")
    if not model_loaded or model_process.poll() is not None:
        raise ToolError("No model is running. Call start_model first.")
    use_adapter = args.get("use_adapter", True)
    if not isinstance(use_adapter, bool):
        raise ToolError("use_adapter must be true or false.")
    system = args.get("system")
    messages = ([{"role": "system", "content": system}] if isinstance(system, str) and system else []) + [{"role": "user", "content": prompt}]
    body = {"messages": messages, "max_tokens": int_arg(args, "max_tokens", 512, 1, 4096), "temperature": 0, "chat_template_kwargs": {"enable_thinking": False}}
    if model_loaded["adapter"]:
        # The adapter stays loaded, so one model answers with and without it.
        body["lora"] = [{"id": 0, "scale": 1.0 if use_adapter else 0.0}]
    try:
        reply = model_request("/v1/chat/completions", body, timeout=MODEL_ANSWER_TIMEOUT_S)
    except OSError as err:
        raise ToolError(f"The model didn't answer: {err}")
    timings = reply.get("timings") or {}
    return text_result(
        json.dumps(
            {
                "answer": reply["choices"][0]["message"]["content"],
                "finish_reason": reply["choices"][0].get("finish_reason"),
                "used_adapter": bool(model_loaded["adapter"] and use_adapter),
                "tokens": timings.get("predicted_n"),
                "tokens_per_second": round(timings.get("predicted_per_second") or 0, 1),
            }
        )
    )


def require_training():
    if not os.path.isdir(TRAIN_DIR):
        raise ToolError("Training isn't set up on this board. Run muse-device/setup-train.sh on it first.")


def name_arg(args, key, default=None):
    """A name that becomes one file or folder, so it can't escape that folder."""
    value = args.get(key, default)
    if not isinstance(value, str) or not TRAIN_NAME.fullmatch(value):
        raise ToolError(f"{key} must be a name with only letters, digits, dots, dashes and underscores, starting with a letter or digit.")
    return value


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json(path, value):
    part = f"{path}.part"
    with open(part, "w", encoding="utf-8") as f:
        json.dump(value, f)
    os.replace(part, path)


def check_examples(examples):
    if not isinstance(examples, list) or not examples:
        raise ToolError("examples must be a non-empty list.")
    for index, example in enumerate(examples):
        messages = example.get("messages") if isinstance(example, dict) else None
        turns = isinstance(messages, list) and all(isinstance(m, dict) and isinstance(m.get("role"), str) and isinstance(m.get("content"), str) for m in messages)
        # At least two: train.py trains on the last answer, and needs a turn before it to answer.
        if not turns or len(messages) < 2 or messages[-1]["role"] != "assistant" or not messages[-1]["content"].strip():
            raise ToolError(f"examples[{index}] must have messages, a list of {{role, content}} turns ending in an assistant's answer to an earlier turn.")


def count_examples(path):
    with open(path, encoding="utf-8") as f:
        return sum(1 for line in f if line.strip())


def save_dataset(args):
    require_training()
    name = name_arg(args, "name")
    examples = args.get("examples")
    check_examples(examples)
    append = args.get("append", False)
    if not isinstance(append, bool):
        raise ToolError("append must be true or false.")
    os.makedirs(DATASET_DIR, exist_ok=True)
    path = os.path.join(DATASET_DIR, f"{name}.jsonl")
    lines = "".join(json.dumps({"messages": example["messages"]}) + "\n" for example in examples)
    with train_lock:
        # train.py reads the file some way into a run, and would train on whatever this leaves there by then.
        active = active_run()
        if active and read_json(run_file(active, "config.json"))["dataset"] == name:
            raise ToolError(f"Training run {active} is using dataset {name}. Wait for it, call stop_training, or save under another name.")
        size = len(lines.encode())
        if size + (os.path.getsize(path) if append and os.path.exists(path) else 0) > DATASET_MAX_BYTES:
            raise ToolError(f"That makes dataset {name} too large: a dataset can be {DATASET_MAX_BYTES // 2**20} MiB.")
        if shutil.disk_usage(DATASET_DIR).free - size < INSTALL_RESERVE_GIB * 2**30:
            raise ToolError(f"That doesn't fit: saving it would leave under {INSTALL_RESERVE_GIB} GiB of disk free.")
        if append:
            with open(path, "a", encoding="utf-8", newline="\n") as f:
                f.write(lines)
        else:
            part = f"{path}.part"
            with open(part, "w", encoding="utf-8", newline="\n") as f:
                f.write(lines)
            os.replace(part, path)
        return text_result(json.dumps({"name": name, "examples": count_examples(path)}))


def run_file(name, file):
    return os.path.join(RUN_DIR, name, file)


def run_names():
    """Every run, newest first. A run exists once its config does, which train_model writes as it starts one."""
    if not os.path.isdir(RUN_DIR):
        return []
    configs = {name: read_json(run_file(name, "config.json")) for name in os.listdir(RUN_DIR)}
    return sorted((name for name, config in configs.items() if config), key=lambda name: configs[name]["started"], reverse=True)


def record_status(name, status):
    """Best effort: on a full disk this can't be written, and that mustn't stop a run being reported."""
    try:
        write_json(run_file(name, "status.json"), status)
    except OSError as err:
        print(f"couldn't record run {name}: {err}", flush=True)


def remove_partial_gguf(name):
    """What a killed train.py leaves behind. list_models doesn't show it, so nothing else would ever remove it."""
    with contextlib.suppress(OSError):
        os.remove(os.path.join(MODEL_DIR, f"{name}.gguf.part"))


def process_alive(name, pid):
    """Whether a run's process lives. After a restart this server only has /proc, and the path guards against a reused pid."""
    if train_process and train_process.pid == pid:
        return train_process.poll() is None
    return run_file(name, "status.json") in (read_text(f"/proc/{pid}/cmdline") or "")


def run_status(name):
    """What a run's files say, except that an unfinished run whose process has gone is recorded as failed."""
    config = read_json(run_file(name, "config.json"))
    if not config:
        raise ToolError(f"There is no training run called {name}. Found: {run_names()}")
    # In this order, so a process that finishes between the two steps has already written its last status.
    alive = process_alive(name, config["pid"])
    status = read_json(run_file(name, "status.json")) or {"state": "loading"}
    if status["state"] in ACTIVE_STATES:
        status["seconds"] = round(time.time() - config["started"])
        if not alive:
            log = (read_text(run_file(name, "train.log")) or "")[-600:]
            status.update(state="failed", error=f"The training process died without saying why, which usually means memory ran out. End of its log: {log}")
            remove_partial_gguf(name)
            record_status(name, status)
    return status


def active_run():
    return next((name for name in run_names() if run_status(name)["state"] in ACTIVE_STATES), None)


def chosen_run(args):
    if args.get("run") is not None:
        return name_arg(args, "run")
    names = run_names()
    if not names:
        raise ToolError("This board has no training runs yet. Call train_model first.")
    return names[0]


def describe_run(name, status):
    return json.dumps({"run": name, **{key: status.get(key) for key in ("state", "step", "steps", "loss", "seconds", "peak_gpu_gib", "error", "adapter", "examples", "skipped")}})


def refuse_if_model_running():
    """Only this server's own model counts. A fleet service on its own port is left alone: a 60-step run beside jetson-02's
    idle LFM3-1.7B peaked at 1.64 GiB on the GPU, the start checks free memory, and train.py stops below its memory floor."""
    if model_process is not None and model_process.poll() is None:
        raise ToolError("A model is running, and this board's shared memory can't hold it and a training run. Call stop_model first.")
    try:
        socket.create_connection(("127.0.0.1", MODEL_PORT), timeout=1).close()
    except OSError:
        return
    raise ToolError(f"A model from before this server restarted is still on port {MODEL_PORT}, and this board's shared memory can't hold it and a training run. stop_model can't reach it, so end that llama-server process first.")


def train_model(args):
    global train_process
    require_training()
    name = name_arg(args, "name")
    dataset = name_arg(args, "dataset")
    base = name_arg(args, "base", DEFAULT_BASE)
    steps = int_arg(args, "steps", 60, 1, 5000)
    rank = int_arg(args, "rank", 8, 1, 64)
    max_length = int_arg(args, "max_length", 512, 64, 4096)
    lr = args.get("lr", 2e-4)
    if isinstance(lr, bool) or not isinstance(lr, (int, float)) or not 0 < lr <= 0.1:
        raise ToolError("lr must be a number above 0, at most 0.1.")
    for path in (TRAIN_PYTHON, CONVERTER, TRAIN_SCRIPT):
        if not os.path.exists(path):
            raise ToolError(f"Training isn't set up on this board: {path} is missing. Run muse-device/setup-train.sh on it, with train.py beside server.py.")
    base_path = os.path.join(BASE_DIR, base)
    weights = glob.glob(os.path.join(glob.escape(base_path), "*.safetensors"))
    if not weights:
        raise ToolError(f"The base model {base} isn't in {BASE_DIR}. Found: {sorted(os.listdir(BASE_DIR)) if os.path.isdir(BASE_DIR) else []}")
    # Found now, not after hours of training: an adapter only loads on top of its base's GGUF.
    if not glob.glob(os.path.join(glob.escape(MODEL_DIR), f"{glob.escape(base)}-*.gguf")):
        raise ToolError(f"{MODEL_DIR} has no GGUF of {base}, so an adapter trained on it couldn't be loaded. Install one first with install_model, named {base}-<quantization>.gguf.")
    dataset_path = os.path.join(DATASET_DIR, f"{dataset}.jsonl")
    if not os.path.exists(dataset_path) or not count_examples(dataset_path):
        raise ToolError(f"There is no dataset called {dataset}. Call save_dataset first.")
    gguf = os.path.join(MODEL_DIR, f"{name}.gguf")
    if os.path.exists(gguf):
        raise ToolError(f"{name}.gguf is already in {MODEL_DIR}, and this run would replace it. Choose another name.")
    disk = shutil.disk_usage(TRAIN_DIR).free / 2**30
    if disk < TRAIN_DISK_GIB:
        raise ToolError(f"Training needs about {TRAIN_DISK_GIB} GiB of free disk, for the adapter and its GGUF. This board has {disk:.1f} GiB free.")
    needed = sum(os.path.getsize(path) for path in weights) / 2**30 + TRAIN_OVERHEAD_GIB

    with model_lock_or_busy(), train_lock:
        active = active_run()
        if active:
            raise ToolError(f"Training run {active} is still going. Wait for it, or call stop_training first.")
        # install_model looks for a run under train_lock once it has install_lock, so the two can't both go ahead.
        if install_lock.locked():
            raise ToolError("A download is running, and it needs this board's disk. Wait for it to finish.")
        refuse_if_model_running()
        memory = meminfo_gib("MemAvailable")
        if memory is not None and memory < needed:
            raise ToolError(f"Training on {base} needs about {needed:.1f} GiB of free memory: its weights, plus {TRAIN_OVERHEAD_GIB} GiB for PyTorch and the optimizer. This board has {memory} GiB available.")
        folder = os.path.join(RUN_DIR, name)
        shutil.rmtree(folder, ignore_errors=True)
        os.makedirs(folder)
        os.makedirs(MODEL_DIR, exist_ok=True)
        remove_partial_gguf(name)
        write_json(run_file(name, "status.json"), {"state": "loading", "step": 0, "steps": steps})
        command = [TRAIN_PYTHON, TRAIN_SCRIPT, "--model", base_path, "--dataset", dataset_path, "--out", os.path.join(folder, "adapter"), "--status", run_file(name, "status.json"),
                   "--gguf-out", gguf, "--converter", CONVERTER, "--steps", str(steps), "--rank", str(rank), "--lr", str(lr), "--max-length", str(max_length)]
        with open(run_file(name, "train.log"), "wb") as log:
            # Its own session, so a restart of this server doesn't end it, unless systemd ends the whole cgroup. See the top of this file.
            train_process = subprocess.Popen(command, cwd=folder, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        write_json(run_file(name, "config.json"), {"pid": train_process.pid, "started": time.time(), "base": base, "dataset": dataset, "steps": steps, "rank": rank, "lr": lr, "max_length": max_length})
    return text_result(json.dumps({"run": name, "state": "loading"}))


def training_status(args):
    require_training()
    with train_lock:
        name = chosen_run(args)
        return text_result(describe_run(name, run_status(name)))


def wait_for_exit(name, pid, timeout):
    deadline = time.time() + timeout
    while process_alive(name, pid):
        if time.time() > deadline:
            return False
        time.sleep(0.1)
    return True


def stop_training(args):
    require_training()
    with train_lock:
        name = chosen_run(args)
        status = run_status(name)
        if status["state"] not in ACTIVE_STATES:
            raise ToolError(f"Run {name} isn't active. It is {status['state']}.")
        pid = read_json(run_file(name, "config.json"))["pid"]
        try:
            os.kill(pid, signal.SIGTERM)
            # train.py only notices between steps of Python, and a step can take a while.
            if not wait_for_exit(name, pid, STOP_TIMEOUT_S):
                os.killpg(pid, signal.SIGKILL)
                if not wait_for_exit(name, pid, 10):
                    raise ToolError(f"Run {name}'s process {pid} didn't stop.")
        except ProcessLookupError:
            pass
        remove_partial_gguf(name)
        # train.py normally records this itself, unless it was killed or hadn't reached its signal handler.
        status = read_json(run_file(name, "status.json")) or status
        if status["state"] in ACTIVE_STATES:
            status.update(state="stopped", seconds=round(time.time() - read_json(run_file(name, "config.json"))["started"]))
            record_status(name, status)
        return text_result(describe_run(name, status))


def text_result(text):
    return {"content": [{"type": "text", "text": text}]}


READ_ONLY = {"readOnlyHint": True}
DEVICE_PROP = {"device": {"type": "string", "description": "Which one to use, from describe_device. Defaults to the first."}}
TOOLS = {
    "describe_device": (
        describe_device,
        {
            "description": "Lists this board's hardware: model, memory, disk, GPU, temperature, cameras, microphones, USB devices and I2C, SPI, GPIO and serial buses. Call this first.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": READ_ONLY,
        },
    ),
    "capture_image": (
        capture_image,
        {
            "description": "Takes one photo with a camera attached to the board and returns it as a JPEG. Takes about 2 seconds.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    **DEVICE_PROP,
                    "width": {"type": "integer", "minimum": 160, "maximum": 1920, "default": 1280},
                    "height": {"type": "integer", "minimum": 120, "maximum": 1080, "default": 720},
                },
                "additionalProperties": False,
            },
            "annotations": READ_ONLY,
        },
    ),
    "record_audio": (
        record_audio,
        {
            "description": "Records from a microphone attached to the board and returns 16 kHz mono WAV plus its RMS and peak level. Levels are 16-bit sample values.",
            "inputSchema": {
                "type": "object",
                "properties": {**DEVICE_PROP, "seconds": {"type": "integer", "minimum": 1, "maximum": 30, "default": 3}},
                "additionalProperties": False,
            },
            "annotations": READ_ONLY,
        },
    ),
    "list_models": (
        list_models,
        {
            "description": "Lists the GGUF models and adapters on this board, which one is running, and the free memory and disk.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": READ_ONLY,
        },
    ),
    "install_model": (
        install_model,
        {
            "description": "Downloads a GGUF model or LoRA adapter to this board from an https URL. Waits up to about 5 minutes, so it suits adapters and small models. It won't replace a file already there, and refuses during a training run.",
            "inputSchema": {
                "type": "object",
                "properties": {"url": {"type": "string"}, "name": {"type": "string", "description": "The file name to save it as, ending in .gguf."}},
                "required": ["url", "name"],
                "additionalProperties": False,
            },
        },
    ),
    "start_model": (
        start_model,
        {
            "description": "Runs a model from list_models on this board's GPU, with a LoRA adapter if one is named, in place of any model this server started. Takes up to 2 minutes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "adapter": {"type": "string", "description": "A LoRA adapter from list_models, trained for this model."},
                    "context": {"type": "integer", "minimum": 512, "maximum": 32768, "default": 4096},
                },
                "required": ["model"],
                "additionalProperties": False,
            },
        },
    ),
    "ask_model": (
        ask_model,
        {
            "description": "Asks the model start_model is running, and returns its answer and its speed on this board. With use_adapter false, a tuned model answers as its base model, to compare the two.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string"},
                    "system": {"type": "string"},
                    "max_tokens": {"type": "integer", "minimum": 1, "maximum": 4096, "default": 512},
                    "use_adapter": {"type": "boolean", "default": True},
                },
                "required": ["prompt"],
                "additionalProperties": False,
            },
            "annotations": READ_ONLY,
        },
    ),
    "stop_model": (
        stop_model,
        {
            "description": "Stops the model start_model is running, which frees its memory.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    ),
    "save_dataset": (
        save_dataset,
        {
            "description": "Stores examples for train_model on this board. Each call's body is limited to 1 MB, so send a large dataset in pages with append true. Returns the dataset's total count.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "examples": {
                        "type": "array",
                        "description": "Each is {messages: [{role, content}, ...]}, ending in the assistant's answer.",
                        "items": {"type": "object", "properties": {"messages": {"type": "array", "items": {"type": "object"}}}, "required": ["messages"]},
                    },
                    "append": {"type": "boolean", "default": False, "description": "Add to the dataset. Otherwise this replaces it."},
                },
                "required": ["name", "examples"],
                "additionalProperties": False,
            },
        },
    ),
    "train_model": (
        train_model,
        {
            "description": "Fine-tunes a LoRA adapter on this board's GPU from a saved dataset, in the background, and returns at once. Follow it with training_status. When done, the adapter is <name>.gguf: load it with start_model, on the base model's GGUF. Refuses while a model is running: call stop_model first. Examples longer than max_length tokens are skipped.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "dataset": {"type": "string", "description": "A name given to save_dataset."},
                    "name": {"type": "string", "description": "This run's name, and the adapter's file name without .gguf. It can't be one already in list_models."},
                    "base": {"type": "string", "default": DEFAULT_BASE},
                    "steps": {"type": "integer", "minimum": 1, "maximum": 5000, "default": 60},
                    "rank": {"type": "integer", "minimum": 1, "maximum": 64, "default": 8},
                    "max_length": {"type": "integer", "minimum": 64, "maximum": 4096, "default": 512, "description": "The longest example to train on, in tokens. Longer ones need more memory."},
                    "lr": {"type": "number", "exclusiveMinimum": 0, "maximum": 0.1, "default": 0.0002},
                },
                "required": ["dataset", "name"],
                "additionalProperties": False,
            },
        },
    ),
    "training_status": (
        training_status,
        {
            "description": "Reports a training run: state (loading, training, converting, done, failed or stopped), step, steps, loss, seconds, peak_gpu_gib, error, adapter, the GGUF's file name once it's ready, and examples and skipped, how many it's training on and how many were too long.",
            "inputSchema": {
                "type": "object",
                "properties": {"run": {"type": "string", "description": "A run's name. Defaults to the newest."}},
                "additionalProperties": False,
            },
            "annotations": READ_ONLY,
        },
    ),
    "stop_training": (
        stop_training,
        {
            "description": "Stops an active training run, which frees its memory. Takes up to 40 seconds. Anything it hasn't saved is lost.",
            "inputSchema": {
                "type": "object",
                "properties": {"run": {"type": "string", "description": "A run's name. Defaults to the newest."}},
                "additionalProperties": False,
            },
        },
    ),
}
EXEC_TOOL = (
    run_command,
    {
        "description": "Runs a bash command on the board as the server's user and returns its exit code and the last 64 KB of output.",
        "inputSchema": {
            "type": "object",
            "properties": {"command": {"type": "string"}, "timeout_s": {"type": "integer", "minimum": 1, "maximum": 600, "default": 60}},
            "required": ["command"],
            "additionalProperties": False,
        },
        "annotations": {"destructiveHint": True},
    },
)


def handle_rpc(method, params):
    if method == "initialize":
        requested = params.get("protocolVersion")
        return {
            "protocolVersion": requested if requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "muse-device", "version": VERSION},
            "instructions": "Tools for one physical board. Call describe_device first to see what is attached.",
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [{"name": name, **info} for name, (_, info) in TOOLS.items()]}
    if method == "tools/call":
        tool = TOOLS.get(params.get("name"))
        if not tool:
            raise LookupError(f"Unknown tool: {params.get('name')}")
        try:
            return tool[0](params.get("arguments") or {})
        except ToolError as err:
            return {"content": [{"type": "text", "text": str(err)}], "isError": True}
        except (OSError, subprocess.SubprocessError) as err:
            return {"content": [{"type": "text", "text": f"{params.get('name')} failed: {err}"}], "isError": True}
    raise NotImplementedError(method)


class Handler(BaseHTTPRequestHandler):
    server_version = f"muse-device/{VERSION}"
    token = ""

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)

    def reply(self, status, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def rpc_error(self, status, code, message, rpc_id=None):
        self.reply(status, {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}})

    def authorized(self):
        sent = self.headers.get("Authorization", "")
        return bool(self.token) and hmac.compare_digest(sent.encode(), f"Bearer {self.token}".encode())

    def do_GET(self):
        # This server sends nothing unprompted, so it offers no event stream.
        self.send_response(405)
        self.send_header("Allow", "POST")
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_DELETE = do_GET

    def do_POST(self):
        if self.path != "/mcp":
            return self.reply(404, {"error": "not found"})
        # Browsers send Origin and server-to-server clients don't, so a web page can't reach this through a tunnel or forward.
        if self.headers.get("Origin"):
            return self.reply(403, {"error": "browser requests are refused"})
        if not self.authorized():
            return self.reply(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.rpc_error(400, -32700, "Bad Content-Length")
        if not 0 < length <= MAX_BODY_BYTES:
            return self.rpc_error(413, -32600, "Body is empty or too large")
        try:
            message = json.loads(self.rfile.read(length))
        except ValueError:
            return self.rpc_error(400, -32700, "Invalid JSON")
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return self.rpc_error(400, -32600, "Expected one JSON-RPC 2.0 message")
        if "method" not in message or "id" not in message:
            return self.reply(202)  # A notification or a client's response needs no answer.
        rpc_id, method = message["id"], message["method"]
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        try:
            self.reply(200, {"jsonrpc": "2.0", "id": rpc_id, "result": handle_rpc(method, params)})
        except LookupError as err:
            self.rpc_error(200, -32602, str(err), rpc_id)
        except NotImplementedError as err:
            self.rpc_error(200, -32601, f"Method not found: {err}", rpc_id)
        except Exception as err:
            print(f"error in {method}: {err!r}", flush=True)
            self.rpc_error(200, -32603, "Internal error", rpc_id)


def load_token():
    folder = os.path.expanduser("~/.muse-device")
    path = os.path.join(folder, "token")
    os.makedirs(folder, mode=0o700, exist_ok=True)
    if not os.path.exists(path):
        # Whole or not at all, since a full disk or a crash can't be allowed to leave an empty token for the next start.
        fd, part = tempfile.mkstemp(dir=folder)
        try:
            with os.fdopen(fd, "w") as f:
                f.write(secrets.token_urlsafe(32))
            os.replace(part, path)
        finally:
            if os.path.exists(part):
                os.remove(part)
    token = read_text(path)
    # authorized() compares against this, so an empty or unreadable file would open the board to "Bearer " or "Bearer None".
    if not token or len(token) < MIN_TOKEN_CHARS:
        raise SystemExit(f"{path} is empty, unreadable or too short. Fix its owner and mode, or delete it to make a new token, then start again.")
    return token


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--allow-exec", action="store_true", help="also offer run_command, which runs any shell command")
    options = parser.parse_args()
    if options.allow_exec:
        TOOLS["run_command"] = EXEC_TOOL
    Handler.token = load_token()
    print(f"muse-device {VERSION} on {options.host}:{options.port}, tools: {', '.join(TOOLS)}", flush=True)
    ThreadingHTTPServer((options.host, options.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
