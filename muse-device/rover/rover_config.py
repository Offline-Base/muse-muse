#!/usr/bin/env python3
"""Muse Rover's one config, ~/.muse-device/rover.json, and the sketch's rover_config.h, which is written from it.

  python3 rover_config.py write <rover.json> [--pin role=PIN]... [--stop-mm N] [--invert part]... [--reset]
  python3 rover_config.py header <rover.json> <rover_config.h>

setup-rover.sh runs both. write keeps what an earlier run set and changes only what its flags name, unless --reset. server.py
offers the rover's tools when rover.json exists. Every pin is the UNO Q header's own name: D2 to D13, or A0 to A5.
"""
import argparse
import copy
import json
import os
import re
import sys

VERSION = 1
# The wiring in docs/ROVER.md. Channel A of the TB6612 is the left motor, B the right.
DEFAULT = {
    "version": VERSION,
    "driver": "tb6612",
    "pins": {
        "pwma": "D5", "ain1": "D4", "ain2": "D8",
        "pwmb": "D6", "bin1": "D12", "bin2": "D13",
        "stby": "A0",
        "enc_left": "D2", "enc_right": "D3",
        "servo_pan": "D9", "servo_tilt": "D10",
        "xshut_front": "A1", "xshut_left": "A2", "xshut_right": "A3",
    },
    "stop_mm": 150,
    # With the front sensor gone, nothing would stop the rover driving forward into something, so it refuses to.
    "need_front_sensor": True,
    # The DIYables 2WD chassis has slotted discs on its motors but no sensor to read them, so encoders are off unless one is
    # fitted to enc_left and enc_right.
    "encoders": False,
    # A motor wired the other way round, or a servo mounted facing the other way.
    "invert": {"left": False, "right": False, "pan": False, "tilt": False},
    "pan_deg": [-90, 90],
    "tilt_deg": [-45, 45],
    "servo_us": [500, 2500],
    # How long the servos get pulses after each look. After that they rest, so a Bridge call can't make them twitch.
    "servo_hold_ms": 1500,
}
MAX_DRIVE_MS = 3000
PIN = re.compile(r"D([2-9]|1[0-3])|A[0-5]")
# The pins the board's overlay gives a PWM channel, which the motor driver's speed inputs need.
PWM_PINS = {"D2", "D3", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13"}
PWM_ROLES = ("pwma", "pwmb")
STOP_MM = (50, 1000)


class ConfigError(ValueError):
    """A config that can't drive the rover, in plain words."""


def check(config):
    """config, if every field is one the sketch can use. Raises ConfigError otherwise."""
    if not isinstance(config, dict) or config.get("driver") != "tb6612":
        raise ConfigError("driver must be tb6612, the only motor driver the sketch knows.")
    pins = config.get("pins")
    if not isinstance(pins, dict) or set(pins) != set(DEFAULT["pins"]):
        raise ConfigError(f"pins must name exactly these roles: {', '.join(DEFAULT['pins'])}.")
    for role, pin in pins.items():
        if not isinstance(pin, str) or not PIN.fullmatch(pin):
            raise ConfigError(f"{role} is {pin!r}, and a pin must be D2 to D13 or A0 to A5. D0 and D1 are the header's serial port.")
    for role in PWM_ROLES:
        if pins[role] not in PWM_PINS:
            raise ConfigError(f"{role} is {pins[role]}, which has no PWM. Use one of {', '.join(sorted(PWM_PINS, key=lambda p: int(p[1:])))}.")
    taken = {}
    for role, pin in pins.items():
        if pin in taken:
            raise ConfigError(f"{taken[pin]} and {role} are both on {pin}.")
        taken[pin] = role
    stop = config.get("stop_mm")
    if isinstance(stop, bool) or not isinstance(stop, int) or not STOP_MM[0] <= stop <= STOP_MM[1]:
        raise ConfigError(f"stop_mm must be a whole number of millimetres from {STOP_MM[0]} to {STOP_MM[1]}.")
    if not isinstance(config.get("need_front_sensor"), bool):
        raise ConfigError("need_front_sensor must be true or false.")
    if not isinstance(config.get("encoders"), bool):
        raise ConfigError("encoders must be true or false.")
    invert = config.get("invert")
    if not isinstance(invert, dict) or set(invert) != set(DEFAULT["invert"]) or not all(isinstance(v, bool) for v in invert.values()):
        raise ConfigError("invert must say true or false for each of left, right, pan and tilt.")
    for key, low, high in (("pan_deg", -90, 90), ("tilt_deg", -90, 90), ("servo_us", 400, 2600)):
        value = config.get(key)
        if not (isinstance(value, list) and len(value) == 2 and all(isinstance(v, int) and not isinstance(v, bool) for v in value)
                and low <= value[0] < value[1] <= high):
            raise ConfigError(f"{key} must be [lowest, highest], whole numbers from {low} to {high}.")
    hold = config.get("servo_hold_ms")
    if isinstance(hold, bool) or not isinstance(hold, int) or not 0 <= hold <= 600000:
        raise ConfigError("servo_hold_ms must be a whole number from 0, which means always, to 600000.")
    return config


def build(existing=None, pins=(), stop_mm=None, invert=(), reset=False):
    """The config to write: what was there (unless reset, or it was unusable), with these changes."""
    config = copy.deepcopy(DEFAULT)
    if existing is not None and not reset:
        try:
            config = check(copy.deepcopy(existing))
        except ConfigError:
            pass
    config["version"] = VERSION
    for item in pins:
        role, _, pin = item.partition("=")
        role = role.strip().lower()
        if role not in DEFAULT["pins"]:
            raise ConfigError(f"There is no pin role called {role}. The roles: {', '.join(DEFAULT['pins'])}.")
        config["pins"][role] = pin.strip().upper()
    if stop_mm is not None:
        config["stop_mm"] = stop_mm
    for part in invert:
        if part not in DEFAULT["invert"]:
            raise ConfigError(f"There is nothing called {part} to invert. Choose from {', '.join(DEFAULT['invert'])}.")
        config["invert"][part] = True
    return check(config)


def pin_code(pin):
    """A header pin as the Arduino core names it: Dn is digital pin n, and An is the core's own A0 to A5."""
    return pin[1:] if pin.startswith("D") else pin


def render_header(config):
    """rover_config.h, for the sketch."""
    check(config)
    lines = [
        "// Muse Rover's pins and limits. setup-rover.sh writes this from ~/.muse-device/rover.json (rover_config.py), so",
        "// change that file and run the setup again rather than editing this one.",
        "#pragma once",
        "",
    ]
    for role, pin in config["pins"].items():
        lines.append(f"#define ROVER_PIN_{role.upper()} {pin_code(pin)}" + (f"  // {pin}" if pin.startswith("D") else ""))
    flags = config["invert"]
    lines += [
        "",
        f"#define ROVER_STOP_MM {config['stop_mm']}",
        f"#define ROVER_MAX_DRIVE_MS {MAX_DRIVE_MS}",
        f"#define ROVER_NEED_FRONT {int(config['need_front_sensor'])}",
        f"#define ROVER_ENCODERS {int(config['encoders'])}",
        f"#define ROVER_LEFT_INVERT {int(flags['left'])}",
        f"#define ROVER_RIGHT_INVERT {int(flags['right'])}",
        f"#define ROVER_PAN_INVERT {int(flags['pan'])}",
        f"#define ROVER_TILT_INVERT {int(flags['tilt'])}",
        f"#define ROVER_PAN_MIN_DEG ({config['pan_deg'][0]})",
        f"#define ROVER_PAN_MAX_DEG ({config['pan_deg'][1]})",
        f"#define ROVER_TILT_MIN_DEG ({config['tilt_deg'][0]})",
        f"#define ROVER_TILT_MAX_DEG ({config['tilt_deg'][1]})",
        f"#define ROVER_SERVO_MIN_US {config['servo_us'][0]}",
        f"#define ROVER_SERVO_MAX_US {config['servo_us'][1]}",
        f"#define ROVER_SERVO_HOLD_MS {config['servo_hold_ms']}",
        "",
    ]
    return "\n".join(lines)


def read_config(path):
    """rover.json, or None when it is missing or isn't JSON."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_text(path, text):
    part = f"{path}.part"
    with open(part, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(part, path)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    write = commands.add_parser("write", help="write rover.json")
    write.add_argument("config")
    write.add_argument("--pin", action="append", default=[], metavar="ROLE=PIN")
    write.add_argument("--stop-mm", type=int)
    write.add_argument("--invert", action="append", default=[], metavar="PART")
    write.add_argument("--reset", action="store_true", help="start from the defaults, not from what is there")
    header = commands.add_parser("header", help="write rover_config.h from rover.json")
    header.add_argument("config")
    header.add_argument("out")
    options = parser.parse_args(argv)
    try:
        if options.command == "write":
            config = build(read_config(options.config), options.pin, options.stop_mm, options.invert, options.reset)
            write_text(options.config, json.dumps(config, indent=2) + "\n")
            print(json.dumps({"stop_mm": config["stop_mm"], "pins": config["pins"]}))
        else:
            config = read_config(options.config)
            if config is None:
                raise ConfigError(f"{options.config} is missing or isn't JSON.")
            write_text(options.out, render_header(config))
    except ConfigError as err:
        print(err, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
