"""The manifest of invented files beside a .synthetic marker. See docs/CONTRACTS.md, Settings.

A .synthetic marker says a folder holds invented data, so a cloud model may read it. The marker
alone cannot tell a stray real file from an invented one, so .synthetic-manifest.json beside it
lists the sha256 of every invented file under that folder, by POSIX path relative to it.
config.synthetic_marked counts a marker only while its manifest reads and every file under the
folder is listed with a matching hash; on a cloud backend config.assert_synthetic refuses the
folder otherwise. Only the markers, the manifests and Finder's .DS_Store are left out of the
count. A link counts as the file it leads to, which must itself be listed inside the folder. A
listed file that is gone does not matter: it cannot reach a model.

scripts/make_manifest.py writes the manifest from git-tracked files only.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

MARKER_NAME = ".synthetic"  # config.SYNTHETIC_MARKER
MANIFEST_NAME = ".synthetic-manifest.json"
SKIPPED_NAMES = frozenset({MARKER_NAME, MANIFEST_NAME, ".DS_Store"})
VERSION = 1
NOTE = "sha256 of every invented file under this folder. scripts/make_manifest.py writes it from git-tracked files."
_SHA256 = re.compile(r"[0-9a-f]{64}")
_CACHE_LIMIT = 4096
_hashes: dict[tuple, str] = {}


@dataclass(frozen=True)
class Check:
    found: bool  # the manifest exists and reads as one
    unlisted: int  # files under the folder that are not listed with a matching hash

    @property
    def ok(self) -> bool:
        return self.found and self.unlisted == 0

    def problem(self) -> str:
        """What is wrong, as the end of a sentence. A count only, never a file name."""
        if not self.found:
            return f"this folder's {MARKER_NAME} marker has no readable {MANIFEST_NAME} beside it"
        files = "1 file in this folder is" if self.unlisted == 1 else f"{self.unlisted} files in this folder are"
        return f"{files} not in its {MANIFEST_NAME} with a matching hash"


def _nfc(rel: str) -> str:
    return unicodedata.normalize("NFC", rel)


def file_sha256(path: Path) -> str:
    """sha256 of the file's bytes, remembered until its inode, size or times change."""
    st = os.stat(path)
    key = (str(path), st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
    digest = _hashes.get(key)
    if digest is None:
        with open(path, "rb") as f:
            digest = hashlib.file_digest(f, "sha256").hexdigest()
        if len(_hashes) >= _CACHE_LIMIT:
            _hashes.clear()
        _hashes[key] = digest
    return digest


def folder_files(folder: Path) -> list[str]:
    """Every file under folder the manifest must list, as sorted POSIX paths relative to it.

    Links to files count; links to folders are not followed (the reader resolves and checks
    those folders on their own).
    """
    folder = Path(folder)
    found = []
    for dirpath, dirnames, filenames in os.walk(folder, followlinks=False):
        dirnames.sort()
        for name in filenames:
            if name not in SKIPPED_NAMES:
                found.append((Path(dirpath) / name).relative_to(folder).as_posix())
    return sorted(found)


def read_manifest(folder: Path) -> dict[str, str] | None:
    """{relative path: sha256} from folder's manifest, or None when it is missing or malformed."""
    try:
        data = json.loads((Path(folder) / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    files = data.get("files") if isinstance(data, dict) and data.get("version") == VERSION else None
    if not isinstance(files, dict):
        return None
    if not all(isinstance(k, str) and isinstance(v, str) and _SHA256.fullmatch(v) for k, v in files.items()):
        return None
    return {_nfc(k): v for k, v in files.items()}


def check(folder: Path) -> Check:
    """Whether every file under folder is listed in its manifest with a matching hash."""
    folder = Path(folder).resolve()
    listed = read_manifest(folder)
    files = folder_files(folder)
    if listed is None:
        return Check(found=False, unlisted=len(files))
    bad = 0
    for rel in files:
        try:
            real = (folder / rel).resolve()
            inside = real.is_relative_to(folder) and real.is_file()
            if not inside or listed.get(_nfc(real.relative_to(folder).as_posix())) != file_sha256(real):
                bad += 1
        except (OSError, RuntimeError):  # unreadable, or a link loop
            bad += 1
    return Check(found=True, unlisted=bad)


def entries(folder: Path, files: Iterable[str]) -> dict[str, str]:
    """{relative path: sha256} for the given files under folder: regular files only, no links."""
    folder = Path(folder)
    out: dict[str, str] = {}
    for rel in files:
        parts = PurePosixPath(rel).parts
        if not parts or PurePosixPath(rel).is_absolute() or ".." in parts:
            raise ValueError("manifest paths are relative to the marked folder")
        path = folder / rel
        if parts[-1] in SKIPPED_NAMES:
            continue
        if path.is_symlink() or not path.is_file():
            raise ValueError("a manifest lists regular files only")
        out[_nfc(PurePosixPath(rel).as_posix())] = file_sha256(path)
    return out


def render(files: dict[str, str]) -> str:
    """The manifest file's text for {relative path: sha256}."""
    data = {"version": VERSION, "note": NOTE, "files": dict(sorted(files.items()))}
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def write(folder: Path, files: Iterable[str]) -> Path:
    """Write folder/.synthetic-manifest.json for the given files (see entries) and return its path."""
    path = Path(folder) / MANIFEST_NAME
    path.write_text(render(entries(folder, files)), encoding="utf-8")
    return path
