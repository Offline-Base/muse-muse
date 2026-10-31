"""Build a tarball of this repo for a board, to carry over on a USB stick (nothing connects to a board).

    uv run python -m scripts.make_bundle [--add PATH ...] [--out dist] [--name muse-bench-YYYY-MM-DD]

Takes every file git tracks in the folders a board needs (base, eval, demo, scripts, ui, deploy, the
device runbook, pyproject.toml and uv.lock), as it is in the working tree, so uncommitted edits go
in, plus each --add path inside the repo. Leaves out .env files, every .gguf, eval/reports, the
unsealed eval/templated set and anything .git/info/exclude names (personal files in demo/ live
there). Runs the secrets scan over
every staged file and refuses to build on any finding. The bundle holds SHA256SUMS and
BOARD_README.txt; its own sha256 goes next to it. Owners and user names are blanked in the tar.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
from datetime import date
from pathlib import Path

from base.config import REPO_ROOT
from scripts import secrets_scan

INCLUDE = ("base", "eval", "demo", "scripts", "ui", "deploy", "docs/DEVICE_BENCH.md", "pyproject.toml", "uv.lock")
# eval/templated/ is an unsealed test set (eval/DATASET.md): no board runs it, so it never travels.
EXCLUDE_DIRS = ("eval/reports/", "eval/templated/", "models/", "relay/", "site/", "hardware/")
BOARD_README = """\
Muse Privacy device bench, built {date} by scripts/make_bundle.py from {files} files.

Nothing in here connects to anything: you copy it to the board and run it there. docs/DEVICE_BENCH.md
has the full steps per device (Mac, Jetson Orin Nano, Raspberry Pi), the labels and the table to fill in.

1. Check the copy:            sha256sum -c SHA256SUMS      (macOS: shasum -a 256 -c SHA256SUMS)
2. Build the app's Python:    uv sync --frozen --no-dev
3. Run the bench, for example on a Jetson with LFM3-VL-2B:
   uv run python -m scripts.bench_device --label jetson-lfm --gguf /path/to/LFM3-VL-2B-Q4_K_M.gguf \\
       --server-bin /path/to/llama.cpp/build/bin/llama-server --ub 128 --batch 512 --swa-full --full-grade
4. Copy back only eval/reports/device_<label>.md and eval/reports/raw/device_<label>.jsonl.
"""


class BundleError(RuntimeError):
    """A plain reason no bundle was built."""


def _git(root: Path, *args: str) -> str:
    out = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if out.returncode:
        raise BundleError("make_bundle runs in a git checkout of this repo")
    return out.stdout


def excluded(rel: str) -> str | None:
    """Why this path never goes in a bundle, or None."""
    name = rel.rsplit("/", 1)[-1]
    if name.startswith(".env"):
        return ".env file"
    if name.lower().endswith(".gguf"):
        return "model file"
    if rel.startswith(EXCLUDE_DIRS) or "/__pycache__/" in f"/{rel}":
        return "not needed on a board"
    return None


def bundle_files(root: Path, extra: list[str] = ()) -> tuple[list[str], dict[str, int]]:
    """The repo-relative files that go in, and counts of what was left out and why."""
    tracked = [p for p in _git(root, "ls-files", "-z", "--cached", "--", *INCLUDE).split("\0") if p]
    wanted = set(tracked)
    for item in extra:
        path = (root / item).resolve()
        if not path.is_relative_to(root.resolve()) or not path.exists():
            raise BundleError(f"--add {item}: not a file or folder inside the repo")
        files = [path] if path.is_file() else sorted(p for p in path.rglob("*") if p.is_file())
        wanted |= {p.relative_to(root.resolve()).as_posix() for p in files}
    info_exclude = root / _git(root, "rev-parse", "--git-path", "info/exclude").strip()
    private: set[str] = set()
    if info_exclude.is_file() and wanted:
        listed = _git(root, "ls-files", "-z", "--cached", "--others", "--ignored", f"--exclude-from={info_exclude}",
                      "--", *sorted(wanted))  # fmt: skip
        private = {p for p in listed.split("\0") if p}
    left: dict[str, int] = {}
    keep = []
    for rel in sorted(wanted):
        why = "named in .git/info/exclude" if rel in private else excluded(rel)
        if why is None and not (root / rel).is_file():
            why = "deleted in the working tree"
        if why:
            left[why] = left.get(why, 0) + 1
        else:
            keep.append(rel)
    return keep, left


def scan(stage: Path, files: list[str]) -> list[tuple[str, int, str]]:
    """The secrets scan over the staged copy: key shapes, addresses, host names, this machine's user."""
    users, found = secrets_scan.user_names(), []
    for rel in files:
        path = stage / rel
        if path.suffix.lower() in secrets_scan.SKIP_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        found += secrets_scan.scan_text(text, rel, users)
    return found


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(1 << 20):
            h.update(block)
    return h.hexdigest()


def _anonymous(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    return info


def build(root: Path, out: Path, name: str, extra: list[str] = ()) -> tuple[Path, int, dict[str, int]]:
    """Write out/<name>.tar.gz and its .sha256. Raises BundleError, and writes nothing, on a finding."""
    files, left = bundle_files(root, extra)
    with tempfile.TemporaryDirectory(prefix="base-bundle-") as tmp:
        stage = Path(tmp) / name
        for rel in files:
            (stage / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / rel, stage / rel)
        found = scan(stage, files)
        if found:
            listed = "\n".join(f"  {where}:{n}: {kind}" for where, n, kind in found)
            raise BundleError(f"the secrets scan found {len(found)} thing(s); nothing was built:\n{listed}")
        (stage / "SHA256SUMS").write_text("".join(f"{sha256(stage / rel)}  {rel}\n" for rel in files))
        (stage / "BOARD_README.txt").write_text(BOARD_README.format(date=date.today().isoformat(), files=len(files)))
        out.mkdir(parents=True, exist_ok=True)
        tarball = out / f"{name}.tar.gz"
        with tarfile.open(tarball, "w:gz") as tar:
            tar.add(stage, arcname=name, filter=_anonymous)
    (out / f"{name}.tar.gz.sha256").write_text(f"{sha256(tarball)}  {tarball.name}\n")
    return tarball, len(files), left


def main(argv: list[str] | None = None, root: Path = REPO_ROOT) -> int:
    p = argparse.ArgumentParser(prog="python -m scripts.make_bundle", description=__doc__.split("\n")[0])
    p.add_argument("--add", nargs="+", default=[], help="more files or folders inside the repo, tracked or not")
    p.add_argument("--out", type=Path, default=root / "dist")
    p.add_argument("--name", default=f"muse-bench-{date.today().isoformat()}")
    args = p.parse_args(argv)
    try:
        tarball, n, left = build(root, args.out, args.name, args.add)
    except BundleError as exc:
        print(f"make_bundle: {exc}", file=sys.stderr)
        return 1
    shown = tarball.relative_to(root) if tarball.is_relative_to(root) else tarball.name
    print(f"Wrote {shown}: {n} files, sha256 in {tarball.name}.sha256.")
    for why, count in left.items():
        print(f"  left out: {count} ({why})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
