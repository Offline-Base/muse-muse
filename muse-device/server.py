#!/usr/bin/env python3
"""Muse Device: an MCP tool server that lets Muse Muse see and use one board.

Standard library only, so a freshly flashed board can run it with nothing installed.
It speaks MCP over streamable HTTP at POST /mcp and requires a bearer token.

  python3 server.py [--host 127.0.0.1] [--port 8765] [--allow-exec]

The token is read from ~/.muse-device/token, created on first start with mode 600.
It binds to loopback by default. Reach it through an SSH forward or a tunnel, not an open port.
"""
import argparse
import array
import base64
import glob
import hmac
import json
import math
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.1.0"
PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"]
MAX_BODY_BYTES = 1024 * 1024
MAX_OUTPUT_BYTES = 64 * 1024
CAPTURE_WARMUP_FRAMES = 30

capture_lock = threading.Lock()


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


def capture_image(args):
    device = choose(find_cameras(), "camera", args.get("device"))
    width = int_arg(args, "width", 1280, 160, 1920)
    height = int_arg(args, "height", 720, 120, 1080)
    with capture_lock, tempfile.TemporaryDirectory() as tmp:
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
    with capture_lock, tempfile.TemporaryDirectory() as tmp:
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
        return hmac.compare_digest(sent.encode(), f"Bearer {self.token}".encode())

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
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_urlsafe(32))
    return read_text(path)


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
