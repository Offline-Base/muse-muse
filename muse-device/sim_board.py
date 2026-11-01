#!/usr/bin/env python3
"""A SIMULATED board: the real server.py (its TLS, pairing, token rules and routes) with made-up hardware and a made-up model.

No camera, microphone, GPU, motor or model is touched, and every answer says it's simulated. It keeps its state in its own folder,
never in this machine's ~/.muse-device. It's for tests and demos where no board is on hand.

  python3 sim_board.py --state DIR [--kind jetson_orin_nano] [--port 8791] [--host 127.0.0.1]
  python3 sim_board.py --state DIR pair

The robot tools are here only. server.py has no actuator tools: nothing here has moved real hardware.
"""
import argparse
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BOARD_MODELS = {
    "jetson_orin_nano": "Simulated NVIDIA Jetson Orin Nano Developer Kit",
    "raspberry_pi": "Simulated Raspberry Pi 5",
    "other": "Simulated gadget",
}
# The model each kind runs: lib/caps/hardware/targets.ts decides, and these are its ids.
BOARD_TARGETS = {"jetson_orin_nano": "muse-glimmer-30b-IQ1_S", "raspberry_pi": "Llama-3.2-3B-Q4_K_M", "other": "Llama-3.2-3B-Q4_K_M"}
# The same list as ROBOT_ACTIONS in lib/caps/hardware/robot.ts. Anything else is refused here as well as on the platform.
ROBOT_ACTIONS = {
    "fan_run": {"seconds": (1, 30)},
    "pump_run": {"seconds": (1, 5)},
    "light_set": {"percent": (0, 100)},
}


class SimRobot:
    """Moves numbers. The plant's soil dries, the air warms, and the actions push back. A hard stop latches until the owner clears it."""

    def __init__(self):
        self.lock = threading.Lock()
        self.soil = 22.0
        self.temp = 33.0
        self.light = 40
        self.fan_until = 0.0
        self.pump_until = 0.0
        self.stopped = False
        self.log = []

    def status(self):
        now = time.time()
        with self.lock:
            return {
                "simulated": True,
                "stopped": self.stopped,
                "sensors": [
                    {"name": "soil-moisture", "kind": "moisture", "value": round(self.soil, 1), "unit": "%"},
                    {"name": "air-temp", "kind": "temperature", "value": round(self.temp, 1), "unit": "C"},
                ],
                "actuators": {"fan": self.fan_until > now, "pump": self.pump_until > now, "light": self.light},
                "log": self.log[-10:],
            }

    def act(self, action, args):
        limits = ROBOT_ACTIONS.get(action)
        if not limits:
            raise ValueError(f"{action} isn't an allowed action.")
        if set(args) != set(limits):
            raise ValueError(f"{action} takes {', '.join(limits)}.")
        for name, (low, high) in limits.items():
            value = args[name]
            if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                raise ValueError(f"{name} must be a whole number from {low} to {high}.")
        now = time.time()
        with self.lock:
            if self.stopped:
                raise ValueError("The hard stop is on. The owner has to clear it first.")
            if action == "fan_run":
                self.fan_until = now + args["seconds"]
                self.temp -= 0.4 * args["seconds"]
            elif action == "pump_run":
                self.pump_until = now + args["seconds"]
                self.soil = min(100.0, self.soil + 8 * args["seconds"])
            else:
                self.light = args["percent"]
            self.log.append({"at": int(now), "action": action, **args})
        return self.status()

    def stop(self):
        with self.lock:
            self.stopped = True
            self.fan_until = self.pump_until = 0.0
            self.log.append({"at": int(time.time()), "action": "hard_stop"})
        return self.status()

    def clear(self):
        with self.lock:
            self.stopped = False
            self.log.append({"at": int(time.time()), "action": "clear_stop"})
        return self.status()


def simulated_answer(target, messages):
    """A fixed rule, not a model: it reads numbers like "soil 22" from the last message. lib/gateway/gadget-sim.ts answers the same way."""
    last = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
    text = last if isinstance(last, str) else ""
    soil = re.search(r"(?:soil|moisture)\D{0,20}(\d+(?:\.\d+)?)", text, re.I)
    temp = re.search(r"(?:temp|temperature)\D{0,20}(\d+(?:\.\d+)?)", text, re.I)
    if soil and float(soil.group(1)) < 30:
        advice = f"The soil is dry at {soil.group(1)}%. Run the pump for 3 seconds."
    elif temp and float(temp.group(1)) > 30:
        advice = f"It's warm at {temp.group(1)} C. Run the fan for 10 seconds."
    elif soil or temp:
        advice = "Everything looks fine. Nothing to do."
    else:
        advice = f"I read: {text[:120]}"
    return f"[simulated {target}] {advice}"


def fake_model_server(target):
    """Stands in for llama-server on loopback, so server.py's /v1 routes run for real. Holds no model."""

    class FakeModel(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def answer(self, body):
            data = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.answer({"object": "list", "data": [{"id": target, "object": "model"}]})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
            self.answer({"model": target, "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": simulated_answer(target, body.get("messages") or [])}}]})

    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeModel)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


def text_result(value):
    return {"content": [{"type": "text", "text": json.dumps(value)}]}


def install(server, kind):
    """Swaps the hardware tools for made-up ones, and adds the robot's. Everything else in server.py runs as it does on a board."""
    robot = SimRobot()
    target = BOARD_TARGETS.get(kind, BOARD_TARGETS["other"])

    def guarded(work):
        def call(args):
            try:
                return text_result(work(args))
            except ValueError as err:
                raise server.ToolError(str(err))
        return call

    empty = {"type": "object", "properties": {}, "additionalProperties": False}
    tools = {
        "describe_device": (lambda _a: text_result({"simulated": True, "model": BOARD_MODELS.get(kind, BOARD_MODELS["other"]), "kind": kind, "cameras": [], "microphones": [], "robot": True}), {"description": "A simulated board.", "inputSchema": empty}),
        "read_sensor": (lambda _a: text_result({"simulated": True, "sensors": robot.status()["sensors"]}), {"description": "Reads the simulated sensors.", "inputSchema": {"type": "object", "properties": {"sensor": {"type": "string"}}, "additionalProperties": False}}),
        "show_text": (lambda a: text_result({"simulated": True, "shown": a.get("text")}), {"description": "Pretends to show a line.", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": False}}),
        "robot_status": (lambda _a: text_result(robot.status()), {"description": "The simulated sensors, actuators and hard stop. Read only.", "inputSchema": empty}),
        "robot_action": (guarded(lambda a: robot.act(a.get("action"), a.get("args") or {})), {"description": "One allow-listed simulated action.", "inputSchema": {"type": "object", "properties": {"action": {"type": "string"}, "args": {"type": "object"}}, "required": ["action", "args"], "additionalProperties": False}}),
        "hard_stop": (lambda _a: text_result(robot.stop()), {"description": "Stops everything simulated, and stays stopped.", "inputSchema": empty}),
        "clear_stop": (lambda _a: text_result(robot.clear()), {"description": "Clears the hard stop.", "inputSchema": empty}),
    }
    server.TOOLS.clear()
    server.TOOLS.update(tools)
    server.MODEL_PORT = fake_model_server(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", nargs="?", choices=["pair"])
    parser.add_argument("--state", required=True, help="a folder for this simulated board's token, certificate and pairing")
    parser.add_argument("--kind", default="jetson_orin_nano", choices=sorted(BOARD_MODELS))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8791)
    options = parser.parse_args()
    # Before server.py reads it, so nothing lands in this machine's real ~/.muse-device or ~/models.
    os.environ["HOME"] = os.path.abspath(options.state)
    os.makedirs(os.environ["HOME"], exist_ok=True)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import server

    if options.command == "pair":
        return server.print_pairing_code()
    install(server, options.kind)
    print(f"SIMULATED board ({options.kind}). No real hardware or model.", flush=True)
    server.serve(options.host, options.port, True)


if __name__ == "__main__":
    main()
