"""The user's privacy controls: what gets redacted and which folders Muse can see.

Set on the approval page's Controls tab and kept in BASE_HOME/privacy_controls.json (mode 0600),
read again whenever the file changes, so a change applies to the next result. See docs/CONTRACTS.md,
"Privacy controls".

- tag_kinds: identifier kinds the user may leave as written (phone, email, address, dob,
  student_id). SSNs and card numbers are always tagged; guard.Redaction enforces that too.
- always_redact / never_redact: the user's own words and phrases (one per line on the page).
- names_off_folders: top-level folders whose results may carry real names. A result counts only
  when every document it came from is in one of them; anything mixed or unknown is tagged.
- hidden_folders: top-level folders Muse cannot list, search, ask about or run a task on. "."
  stands for the files at the top of the workspace.
"""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from base.guard import ALWAYS_TAGGED, Redaction

SKIPPABLE_KINDS = ("phone", "email", "address", "dob", "student_id")
KIND_LABELS = {
    "phone": "Phone numbers",
    "email": "Email addresses",
    "address": "Street addresses",
    "dob": "Dates of birth",
    "student_id": "Student ID numbers",
}
TOP = "."  # the files at the top of the workspace, as a folder name
MAX_WORDS = 200
MAX_WORD_CHARS = 100


def top_folder(doc_id: str) -> str:
    """The top-level folder of a workspace-relative path, or "." for a file at the top."""
    parts = PurePosixPath(str(doc_id).replace("\\", "/")).parts
    return parts[0] if len(parts) > 1 else TOP


def _words(values: Iterable[Any]) -> list[str]:
    out: list[str] = []
    for v in values:
        w = " ".join(str(v).split())[:MAX_WORD_CHARS]
        if w and w.lower() not in {o.lower() for o in out}:
            out.append(w)
    return out[:MAX_WORDS]


@dataclass
class Controls:
    tag_kinds: dict[str, bool] = field(default_factory=lambda: dict.fromkeys(SKIPPABLE_KINDS, True))
    always_redact: list[str] = field(default_factory=list)
    never_redact: list[str] = field(default_factory=list)
    names_off_folders: list[str] = field(default_factory=list)
    hidden_folders: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Controls:
        kinds = dict.fromkeys(SKIPPABLE_KINDS, True)
        for k, v in (data.get("tag_kinds") or {}).items():
            if k in kinds:
                kinds[k] = bool(v)
        return cls(
            tag_kinds=kinds,
            always_redact=_words(data.get("always_redact") or []),
            never_redact=_words(data.get("never_redact") or []),
            names_off_folders=_words(data.get("names_off_folders") or []),
            hidden_folders=_words(data.get("hidden_folders") or []),
        )

    def redaction(self, sources: Iterable[str] | None = None) -> Redaction | None:
        """The guard's Redaction for a result from these documents (None: the default, tag everything).

        Names stay as written only when every source is in a names-off folder.
        """
        src = [s for s in (sources or []) if s]
        names = not (src and self.names_off_folders and all(top_folder(s) in self.names_off_folders for s in src))
        r = Redaction(
            skip_kinds=frozenset(k for k, on in self.tag_kinds.items() if not on) - ALWAYS_TAGGED,
            names=names,
            always=tuple(self.always_redact),
            never=tuple(self.never_redact),
        )
        return None if r.is_default else r

    def visible(self, doc_id: str) -> bool:
        return top_folder(doc_id) not in self.hidden_folders


class ControlStore:
    """Controls in BASE_HOME/privacy_controls.json, cached until the file changes."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._cache: tuple[float, Controls] | None = None

    def get(self) -> Controls:
        with self._lock:
            try:
                mtime = self.path.stat().st_mtime
            except FileNotFoundError:
                return Controls()
            if self._cache is None or self._cache[0] != mtime:
                try:
                    data = json.loads(self.path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    data = {}  # a broken file means the strict default, never "nothing redacted"
                self._cache = (mtime, Controls.from_dict(data if isinstance(data, dict) else {}))
            return self._cache[1]

    def save(self, controls: Controls) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(asdict(controls), indent=2) + "\n", encoding="utf-8")
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
            self._cache = None
