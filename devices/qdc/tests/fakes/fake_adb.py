"""A stand-in adb for the carrier's tests: the "phone" is the folder FAKE_ADB_ROOT. `adb push` copies into it, `adb shell`
runs the command with /bin/sh after pointing /data/local/tmp into it, and every call is logged as one JSON line to
FAKE_ADB_LOG. pkill is turned into a no-op, so a test can never stop a real process on this machine.

Scenario knobs in the JSON file FAKE_ADB_STATE (read and written on every call): "push_fail" (true: pushes fail),
"drop_polls" (how many of the carrier's next polls fail as if the connection dropped), "offline" (true: get-state
fails).
"""

import json
import os
import shutil
import subprocess
import sys

ROOT = os.environ["FAKE_ADB_ROOT"]
LOG = os.environ["FAKE_ADB_LOG"]
STATE = os.environ.get("FAKE_ADB_STATE", "")
DEVICE = "/data/local/tmp"


def state():
    if STATE and os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_state(data):
    if STATE:
        with open(STATE, "w", encoding="utf-8") as f:
            json.dump(data, f)


def on_phone(path):
    return ROOT + path if path.startswith(DEVICE) else path


def push(src, dst):
    dst = on_phone(dst)
    if os.path.isdir(dst):
        dst = os.path.join(dst, os.path.basename(src.rstrip("/")))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.isdir(src):
        shutil.copytree(src, dst, dirs_exist_ok=True)
    else:
        shutil.copyfile(src, dst)
        shutil.copymode(src, dst)


def main(argv):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"argv": argv}) + "\n")
    knobs = state()
    command = argv[0] if argv else ""
    if command == "get-state":
        if knobs.get("offline"):
            print("error: no devices/emulators found")
            return 1
        print("device")
        return 0
    if command == "wait-for-device":
        return 0
    if command == "push":
        if knobs.get("push_fail"):
            print("adb: error: failed to copy: remote couldn't create file: Read-only file system")
            return 1
        push(argv[1], argv[2])
        print(f"{argv[1]}: 1 file pushed, 0 skipped.")
        return 0
    if command == "shell":
        line = " ".join(argv[1:])
        if "mm-carrier-poll" in line and knobs.get("drop_polls", 0) > 0:
            knobs["drop_polls"] -= 1
            save_state(knobs)
            print("error: closed")
            return 255
        line = line.replace(DEVICE, ROOT + DEVICE).replace("pkill ", ": pkill ")
        env = {"PATH": "/usr/bin:/bin", "FAKE_ROOT": ROOT, "FAKE_KIT": os.environ.get("FAKE_KIT", "")}
        return subprocess.run(["/bin/sh", "-c", line], env=env, cwd=ROOT).returncode
    print(f"fake adb: no {command}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
