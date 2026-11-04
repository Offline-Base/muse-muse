#!/usr/bin/env python3
"""Runs Muse Code for the rover demo page and streams the conversation into it.

    python3 musecode_bridge.py                 # wait for prompts typed in the page's "Ask Muse Code" box
    python3 musecode_bridge.py "Find the 2 Muse mascots"   # run one prompt now

Muse Code runs here (on the laptop) with this folder's .mcp.json, so its rover_* tool calls go to the rover's MCP
server. This script only relays: the prompt, Muse Code's reply text as it streams, and the end of the run. The steps
panel fills from the rover's own record of each tool call.
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

ROVER = os.environ.get("ROVER", "http://192.168.12.158:8799")
HERE = os.path.dirname(os.path.abspath(__file__))
EFFORT = os.environ.get("EFFORT", "minimal")


def post(event, text=""):
    req = urllib.request.Request(f"{ROVER}/chat", data=json.dumps({"event": event, "text": text}).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=5).read()
    except OSError as exc:
        print(f"[bridge] page not reached: {exc}", file=sys.stderr)


def run(prompt):
    print(f"\n[bridge] Muse Code: {prompt}")
    post("user", prompt)
    cmd = ["muse", "exec", "--json", "--yolo", "--reasoning-effort", EFFORT, prompt]
    proc = subprocess.Popen(cmd, cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
    buf, last_flush, final, failed = "", time.time(), None, None
    for line in proc.stdout:
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        kind, payload = ev.get("payload_type"), ev.get("payload") or {}
        if kind == "run.output.delta":
            buf += payload.get("text") or ""
            print(payload.get("text") or "", end="", flush=True)
        elif kind == "tool.result":
            name = (payload.get("correlation_facts") or {}).get("tool_name", "")
            print(f"\n[tool] {name}", flush=True)
        elif kind and kind.startswith("run.terminal"):
            final = payload.get("text") or ""
            if payload.get("terminal") != "completed":
                failed = payload.get("reason") or payload.get("terminal") or "stopped"
        if buf and time.time() - last_flush > 0.3:
            post("delta", buf)
            buf, last_flush = "", time.time()
    proc.wait()
    if buf:
        post("delta", buf)
    if failed or proc.returncode:
        post("error", final or f"Muse Code stopped ({failed or 'exit ' + str(proc.returncode)}).")
    else:
        post("done", final or "")
    print("\n[bridge] done")


def main():
    if len(sys.argv) > 1:
        run(" ".join(sys.argv[1:]))
        return
    print(f"[bridge] waiting for prompts from {ROVER} (Ctrl-C to stop)")
    while True:
        try:
            with urllib.request.urlopen(f"{ROVER}/ask/next", timeout=5) as r:
                prompt = json.loads(r.read() or b"{}").get("prompt")
        except (OSError, ValueError):
            prompt = None
        if prompt:
            run(prompt)
        time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
