#!/usr/bin/env python3
"""Muse Rover's self-test. setup-rover.sh runs it as the board's user once everything is installed. It goes through this
board's own muse-device server, the way Muse Muse does through the fleet, and prints one line of JSON on stdout and nothing
else. It reads the server's token to call it, and never prints it.

  python3 selftest.py [--port 8765]

It moves the rover: each wheel turns alone for a moment at low speed, so give it room or put it on a stand.
"""
import argparse
import base64
import itertools
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bridge_client  # noqa: E402
import rover_config  # noqa: E402

TOKEN_FILE = os.path.expanduser("~/.muse-device/token")
ROVER_TOOLS = ("drive", "stop", "look", "ranges", "rover_status")
# Low enough that the rover barely moves, and enough for the gear motors on 6 V to turn.
WHEEL_SPEED = 110
WHEEL_MS = 300
SERVER_WAIT_S = 20
# Never through a proxy: this is the board's own server.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Board:
    """This board's muse-device server, over MCP."""

    def __init__(self, port, token):
        self.url = f"http://127.0.0.1:{port}/mcp"
        self.token = token
        self.ids = itertools.count(1)

    def rpc(self, method, params=None):
        body = json.dumps({"jsonrpc": "2.0", "id": next(self.ids), "method": method, "params": params or {}}).encode()
        request = urllib.request.Request(self.url, data=body, headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        with OPENER.open(request, timeout=30) as res:
            reply = json.load(res)
        if "error" in reply:
            raise RuntimeError(reply["error"].get("message") or "the server answered with an error")
        return reply["result"]

    def tool(self, name, **arguments):
        """(whether it worked, the reply's text, the reply's content)."""
        result = self.rpc("tools/call", {"name": name, "arguments": arguments})
        content = result.get("content") or []
        text = next((item.get("text") for item in content if item.get("type") == "text"), "") or ""
        return not result.get("isError"), text, content


def tool_names(board, wait_s):
    """The server's tools, once it answers. Raises OSError when it never does."""
    deadline = time.monotonic() + wait_s
    while True:
        try:
            return [tool["name"] for tool in board.rpc("tools/list")["tools"]]
        except urllib.error.HTTPError:
            raise
        except OSError:
            if time.monotonic() > deadline:
                raise
            time.sleep(1)


def wheel_check(board, side, before):
    """Turns one wheel alone, forward, and says whether its own encoder counted."""
    ok, text, _ = board.tool("drive", left=WHEEL_SPEED if side == "left" else 0, right=WHEEL_SPEED if side == "right" else 0, ms=WHEEL_MS)
    if not ok:
        return text, None
    after = json.loads(text).get("ticks") or {}
    moved = {key: after.get(key, 0) - before.get(key, 0) for key in ("left", "right")}
    other = "right" if side == "left" else "left"
    if moved[side] > 0:
        return "ok", moved
    if moved[other]:
        return f"only the {other} encoder counted while the {side} wheel turned, so the encoder wires look swapped", moved
    return f"no encoder ticks while the {side} wheel was driven: check that it turned, and its encoder's power and signal wire", moved


def run(board, encoders=True):
    """Every check, as ok or why not, and what was measured."""
    checks, seen = {}, {}
    try:
        names = tool_names(board, SERVER_WAIT_S)
    except urllib.error.HTTPError as err:
        checks["server"] = f"the server refused this board's own token ({err.code})"
        return checks, seen
    except OSError as err:
        checks["server"] = f"the server isn't answering on {board.url}: {err}"
        try:
            bridge_client.call("status")
            checks["sketch"] = "ok, answering the router directly"
        except bridge_client.BridgeError as bridge_err:
            checks["sketch"] = str(bridge_err)
        return checks, seen
    checks["server"] = "ok"
    missing = [name for name in ROVER_TOOLS if name not in names]
    if missing:
        checks["rover_tools"] = f"the server doesn't offer {', '.join(missing)}: ~/.muse-device/rover.json or rover/bridge_client.py is missing, or it runs with --tls"
        return checks, seen
    checks["rover_tools"] = "ok"

    ok, text, _ = board.tool("rover_status")
    if not ok:
        checks["sketch"] = text
        return checks, seen
    status = json.loads(text)
    checks["sketch"] = "ok"
    seen["sketch"] = status.get("version")
    seen["stop_mm"] = status.get("stop_mm")

    ok, text, _ = board.tool("look", pan=0, tilt=0)
    checks["servos"] = "ok, centered (check by eye that both moved)" if ok else text

    ok, text, _ = board.tool("ranges")
    if ok:
        ranges = json.loads(text)
        seen["ranges"] = ranges
        gone = [side for side, state in ranges["sensors"].items() if state == "missing"]
        checks["ranges"] = "ok" if not gone else f"the {' and '.join(gone)} distance sensor isn't answering: check its 3.3 V, SDA, SCL and XSHUT wires"
    else:
        checks["ranges"] = text

    for side in ("left", "right"):
        ok, text, _ = board.tool("rover_status")
        before = (json.loads(text).get("ticks") or {}) if ok else {}
        if encoders:
            checks[f"{side}_wheel"], seen[f"{side}_ticks"] = wheel_check(board, side, before)
        else:
            ok, text, _ = board.tool("drive", left=WHEEL_SPEED if side == "left" else 0, right=WHEEL_SPEED if side == "right" else 0, ms=WHEEL_MS)
            checks[f"{side}_wheel"] = "ok, pulsed: there is no encoder to count it, so check by eye that it turned" if ok else text
        time.sleep(0.3)
    board.tool("stop")

    ok, text, _ = board.tool("describe_device")
    cameras = json.loads(text).get("cameras") if ok else None
    if not cameras:
        checks["photo"] = "skipped: no camera is attached"
    else:
        ok, text, content = board.tool("capture_image", width=640, height=480)
        image = next((item for item in content if item.get("type") == "image"), None)
        if ok and image:
            checks["photo"] = "ok"
            seen["photo_bytes"] = len(base64.b64decode(image["data"]))
            seen["camera"] = cameras[0].get("name")
        else:
            checks["photo"] = text or "the camera returned no image"
    return checks, seen


def passed(checks):
    return bool(checks) and all(result.startswith("ok") or result.startswith("skipped") for result in checks.values())


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8765)
    options = parser.parse_args(argv)
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            token = f.read().strip()
    except OSError:
        token = None
    if not token:
        checks, seen = {"server": "this board has no readable ~/.muse-device/token, so its server can't be called"}, {}
    else:
        try:
            config = rover_config.read_config(os.path.expanduser("~/.muse-device/rover.json")) or {}
            checks, seen = run(Board(options.port, token), encoders=config.get("encoders", True) is True)
        except (OSError, ValueError, KeyError, RuntimeError) as err:
            checks, seen = {"self_test": f"stopped partway: {err}"}, {}
    print(json.dumps({"ok": passed(checks), "checks": checks, "seen": seen}))
    return 0 if passed(checks) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
