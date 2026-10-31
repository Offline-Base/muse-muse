"""Write .synthetic-manifest.json beside each .synthetic marker, from git-tracked files only.

    uv run python -m scripts.make_manifest              # every folder with a tracked .synthetic marker
    uv run python -m scripts.make_manifest demo         # one folder (relative to the repo)
    uv run python -m scripts.make_manifest --check      # exit 1 when a manifest is out of date

The manifest lists the sha256 of every file git tracks under the folder (git ls-files), so a file
that is untracked, or kept out by .gitignore or .git/info/exclude, is never listed, and a cloud
backend refuses the folder while such a file sits in it (base/manifest.py). Links are never
listed. Run it after changing an invented file and commit the manifest with the file. It prints
folder names relative to the repo and counts, never file names.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path, PurePosixPath

from base import manifest
from base.config import REPO_ROOT, SYNTHETIC_MARKER

LINK_MODES = ("120000", "160000")  # a symbolic link, a submodule


def _git(repo: Path, *args: str) -> str:
    done = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True, timeout=60)
    return done.stdout


def tracked_files(folder: Path, repo: Path = REPO_ROOT) -> list[str]:
    """Regular files git tracks under folder, as POSIX paths relative to it, minus markers and links."""
    rel = Path(folder).resolve().relative_to(Path(repo).resolve()).as_posix()
    out = []
    for record in _git(repo, "ls-files", "-z", "-s", "--", rel).split("\0"):
        if not record:
            continue
        meta, _, path = record.partition("\t")
        if meta.split(" ")[0] in LINK_MODES:
            continue
        inside = PurePosixPath(path).relative_to(rel).as_posix() if rel != "." else path
        if PurePosixPath(inside).name in manifest.SKIPPED_NAMES:
            continue
        if (Path(folder) / inside).is_file():  # a tracked file deleted here cannot be read either
            out.append(inside)
    return sorted(out)


def marked_folders(repo: Path = REPO_ROOT) -> list[Path]:
    """Folders with a git-tracked .synthetic marker."""
    paths = [p for p in _git(repo, "ls-files", "-z").split("\0") if p and PurePosixPath(p).name == SYNTHETIC_MARKER]
    return sorted(Path(repo) / PurePosixPath(p).parent for p in paths)


def fresh(folder: Path, repo: Path = REPO_ROOT) -> dict[str, str]:
    """{relative path: sha256} that folder's manifest should hold now."""
    return manifest.entries(folder, tracked_files(folder, repo))


def main(argv: list[str] | None = None, repo: Path = REPO_ROOT) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("folders", nargs="*", help="marked folders relative to the repo (default: every tracked marker)")
    ap.add_argument("--check", action="store_true", help="change nothing; exit 1 when a manifest is out of date")
    args = ap.parse_args(argv)
    repo = Path(repo).resolve()
    folders = [(repo / f).resolve() for f in args.folders] or marked_folders(repo)
    stale = 0
    for folder in folders:
        name = folder.relative_to(repo).as_posix() if folder.is_relative_to(repo) else None
        if name is None:
            print("A folder is outside this repository.", file=sys.stderr)
            return 2
        if not (folder / SYNTHETIC_MARKER).is_file():
            print(f"{name} has no {SYNTHETIC_MARKER} marker.", file=sys.stderr)
            return 2
        files = fresh(folder, repo)
        text, count = manifest.render(files), len(files)
        path = folder / manifest.MANIFEST_NAME
        current = path.read_text(encoding="utf-8") if path.is_file() else None
        if args.check:
            ok = current == text
            stale += not ok
            print(f"{name}: {'up to date' if ok else 'out of date'} ({count} files)")
        elif current != text:
            path.write_text(text, encoding="utf-8")
            print(f"{name}: wrote {manifest.MANIFEST_NAME} ({count} files)")
        else:
            print(f"{name}: already up to date ({count} files)")
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
