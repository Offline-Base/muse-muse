"""Plug a local GGUF into Muse Privacy as the device's main model, or undo that.

    uv run python -m scripts.plug_in_model /path/to/model.gguf [--check]
    uv run python -m scripts.plug_in_model --undo

Checks the file, then sets the model's lines in .env: every model on this device, your GGUF for
answers and routing, LFM3-VL-2B for scans and search. The other lines stay as they are, and the
old file is kept as .env.before-plug-in. Restart scripts/start.sh afterwards, then run
scripts.compare_modes to score it. Nothing is downloaded, and no value in .env is printed.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from base.config import REPO_ROOT, read_dotenv

ENV = REPO_ROOT / ".env"
BACKUP_NAME = ".env.before-plug-in"
MARGIN_GB = 4  # LFM, the embedder, the app and the system, on top of the model
GIB = 1024**3


def total_memory_gb() -> float | None:
    try:
        if sys.platform == "darwin":
            return int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)) / GIB
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / GIB
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def check_model(path: Path, memory_gb: float | None) -> list[str]:
    """Plain reasons this file can't be the device's model. Empty means it can."""
    if not path.is_file():
        return [f"No file at {path}."]
    with path.open("rb") as f:
        if f.read(4) != b"GGUF":
            return [f"{path.name} is not a GGUF file."]
    size_gb = path.stat().st_size / GIB
    if memory_gb is not None and size_gb + MARGIN_GB > memory_gb:
        return [f"{path.name} is {size_gb:.1f} GB. With {MARGIN_GB} GB for everything else, it needs more than this device's {memory_gb:.0f} GB of memory."]
    return []


def with_lines(text: str, values: dict[str, str]) -> str:
    """`text` (a .env file) with each key set: replaced where it is, added at the end if new."""
    left = dict(values)
    out = []
    for line in text.splitlines():
        key = line.split("=", 1)[0].strip()
        if "=" in line and not line.lstrip().startswith("#") and key in left:
            out.append(f"{key}={left.pop(key)}")
        else:
            out.append(line)
    if left:
        out += ["", "# Set by scripts/plug_in_model.py", *(f"{k}={v}" for k, v in left.items())]
    return "\n".join(out) + "\n"


def plug_in(model: Path, env_path: Path = ENV) -> dict[str, str]:
    """Set the model's lines in the .env at `env_path`, keeping a backup. Returns what was set."""
    current = env_path.read_text() if env_path.is_file() else ""
    backup = env_path.with_name(BACKUP_NAME)
    if not backup.exists():  # the first backup is the one to go back to
        backup.write_text(current)
        os.chmod(backup, 0o600)
    env = read_dotenv(env_path)
    values = {
        "DEVICE_ONLY": "1",
        "PRIMARY_MODEL": "glimmer",
        "GLIMMER_BACKEND": "llama_server",
        "GLIMMER_GGUF": str(model.resolve()),
        "CHECKER_BACKEND": "lfm",
    }
    server = env.get("LLAMA_SERVER_BIN") or env.get("CHECKER_SERVER_BIN")
    if server:
        values["LLAMA_SERVER_BIN"] = server
    env_path.write_text(with_lines(current, values))
    os.chmod(env_path, 0o600)
    return values


def undo(env_path: Path = ENV) -> bool:
    backup = env_path.with_name(BACKUP_NAME)
    if not backup.is_file():
        return False
    shutil.copy2(backup, env_path)
    os.chmod(env_path, 0o600)
    backup.unlink()
    return True


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("model", nargs="?", type=Path, help="the .gguf file")
    p.add_argument("--check", action="store_true", help="check the file and change nothing")
    p.add_argument("--undo", action="store_true", help="put .env back as it was before plugging in")
    args = p.parse_args(argv)
    if args.undo:
        print("Put .env back. Restart scripts/start.sh." if undo() else "Nothing to undo.")
        return 0
    if args.model is None:
        p.error("give the path to a .gguf file, or --undo")
    problems = check_model(args.model, total_memory_gb())
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    if args.check:
        print(f"{args.model.name} can be plugged in.")
        return 0
    plug_in(args.model)
    print(f"Plugged in {args.model.name}. Next:")
    print("  1. Stop scripts/start.sh with Ctrl-C and start it again.")
    print("  2. uv run python -m scripts.device_smoke --name my_model")
    print("  3. uv run python -m scripts.compare_modes --name my_model")
    print("Undo with: uv run python -m scripts.plug_in_model --undo")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
