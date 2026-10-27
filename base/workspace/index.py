"""Document index for the private workspace. See docs/CONTRACTS.md, Workspace.

Only .md and .txt files under settings.workspace_root are visible. Folder and document names are
relative to the root; absolute paths, ".." and symlinks that lead outside the root are rejected.
Every call checks config.assert_synthetic before it touches a file, so a cloud Glimmer backend
never reads a folder that is not marked as invented data. Search is plain BM25, no embeddings.
"""

from __future__ import annotations

import math
import os
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from base.config import Settings, assert_synthetic

EXTENSIONS = (".md", ".txt")
MAX_FILE_BYTES = 5_000_000
SNIPPET_CHARS = 240
K1 = 1.5
B = 0.75
STOPWORDS = frozenset(
    "a an and are as at be but by for from has have he her his i in is it its of on or our she so that "
    "the their them they this to was we were what when which who will with you your".split()
)


class WorkspacePathError(ValueError):
    """A folder or document name points outside the workspace root."""


@dataclass(frozen=True)
class Doc:
    """One document. id and path are relative to the workspace root, never absolute."""

    id: str
    path: str
    title: str
    size: int
    modified: float


@dataclass(frozen=True)
class Snippet:
    doc_id: str
    title: str
    text: str
    score: float


def tokenize(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in STOPWORDS]


class DocumentIndex:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.root = Path(settings.workspace_root).resolve()

    # paths

    def resolve(self, name: str | None) -> Path:
        """Turn a folder or document name relative to the root into a checked absolute path."""
        raw = (name or "").replace("\\", "/").strip()
        rel = PurePosixPath(raw or ".")
        if rel.is_absolute() or raw.startswith("~") or ".." in rel.parts or re.match(r"^[A-Za-z]:", raw):
            raise WorkspacePathError("That path is outside the workspace.")
        full = (self.root / rel).resolve()
        if not full.is_relative_to(self.root):
            raise WorkspacePathError("That path is outside the workspace.")
        return full

    def _rel(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()

    def _files(self, folder: Path) -> list[Path]:
        """Visible .md/.txt files under folder, skipping hidden names and links out of the root."""
        found: list[Path] = []
        for dirpath, dirnames, filenames in os.walk(folder, followlinks=False):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for fname in sorted(filenames):
                if fname.startswith(".") or not fname.lower().endswith(EXTENSIONS):
                    continue
                path = Path(dirpath) / fname
                real = path.resolve()
                if not real.is_relative_to(self.root) or not real.is_file():
                    continue
                if real.stat().st_size > MAX_FILE_BYTES:
                    continue
                found.append(path)
        return found

    # contract

    def list(self, folder: str | None = None) -> list[Doc]:
        path = self.resolve(folder)
        assert_synthetic(self.settings, path)
        if not path.is_dir():
            raise FileNotFoundError("That folder is not in the workspace.")
        files = self._files(path)
        for p in files:
            assert_synthetic(self.settings, p.resolve().parent)  # a link into an unmarked folder
        return [self._doc(p) for p in files]

    def read(self, doc_id: str) -> str:
        path = self.resolve(doc_id)
        assert_synthetic(self.settings, path.parent)
        hidden = any(part.startswith(".") for part in PurePosixPath(self._rel(path)).parts)
        if hidden or not path.is_file() or not path.name.lower().endswith(EXTENSIONS):
            raise FileNotFoundError("That document is not in the workspace.")
        return path.read_text(encoding="utf-8", errors="replace")

    def search(self, query: str, k: int = 5, folder: str | None = None) -> list[Snippet]:
        """BM25 over every visible document under folder (default: the whole root)."""
        base = self.resolve(folder)
        assert_synthetic(self.settings, base)
        terms = list(dict.fromkeys(tokenize(query)))
        if not terms or not base.is_dir():
            return []
        docs = []
        for path in self._files(base):
            assert_synthetic(self.settings, path.resolve().parent)  # a link into an unmarked folder
            text = path.read_text(encoding="utf-8", errors="replace")
            title = _title(path, text[:TITLE_SCAN_CHARS])
            docs.append((self._rel(path), title, text, Counter(tokenize(title + "\n" + text))))
        if not docs:
            return []
        n = len(docs)
        avg_len = sum(sum(tf.values()) for *_, tf in docs) / n or 1.0
        df = {t: sum(1 for *_, tf in docs if t in tf) for t in terms}
        idf = {t: math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5)) for t in terms}
        scored = []
        for doc_id, title, text, tf in docs:
            length = sum(tf.values())
            score = 0.0
            for t in terms:
                f = tf.get(t, 0)
                if f:
                    score += idf[t] * f * (K1 + 1) / (f + K1 * (1 - B + B * length / avg_len))
            if score > 0:
                scored.append((score, doc_id, title, text))
        scored.sort(key=lambda s: (-s[0], s[1]))
        return [
            Snippet(doc_id, title, snippet(text, terms, idf), round(score, 4))
            for score, doc_id, title, text in scored[:k]
        ]

    def _doc(self, path: Path) -> Doc:
        stat = path.stat()
        with path.open(encoding="utf-8", errors="replace") as f:
            head = f.read(2000)
        rel = self._rel(path)
        return Doc(id=rel, path=rel, title=_title(path, head), size=stat.st_size, modified=stat.st_mtime)


TITLE_SCAN_CHARS = 2000
_HEADING = re.compile(r"#{1,3}\s+(\S.*)")  # \s+ then \S never overlap, so this is linear


def _title(path: Path, text: str) -> str:
    """First markdown heading in the first few lines, else the file name without extension.

    Linear in the line length: the older pattern backtracked in cubic time on a heading followed
    by a long run of spaces, and one 3 KB essay held the whole server for seconds.
    """
    for line in text[:TITLE_SCAN_CHARS].splitlines()[:10]:
        m = _HEADING.match(line[:300])
        if m:
            title = m.group(1).rstrip().rstrip("#").rstrip()
            if title:
                return title
    return path.stem


def snippet(
    text: str, terms: list[str], idf: dict[str, float] | None = None, width: int = SNIPPET_CHARS
) -> str:
    """About `width` characters around the spot where the query terms are densest."""
    flat = re.sub(r"\s+", " ", text).strip()
    if len(flat) <= width:
        return flat
    lower = flat.lower()
    hits: list[tuple[int, float]] = []
    for t in terms:
        weight = (idf or {}).get(t, 1.0)
        hits += [(m.start(), weight) for m in re.finditer(rf"\b{re.escape(t)}\b", lower)]
    center = 0
    if hits:
        hits.sort()
        best, best_i, best_j, j, total = -1.0, 0, 1, 0, 0.0
        for i in range(len(hits)):
            while j < len(hits) and hits[j][0] - hits[i][0] <= width - 40:
                total += hits[j][1]
                j += 1
            if total > best:
                best, best_i, best_j = total, i, j
            total -= hits[i][1]
        center = (hits[best_i][0] + hits[best_j - 1][0]) // 2
    start = max(0, min(center - width // 2, len(flat) - width))
    end = start + width
    if start > 0:
        space = flat.find(" ", start)
        start = space + 1 if 0 <= space < start + 30 else start
    if end < len(flat):
        space = flat.rfind(" ", start, end)
        end = space if space > end - 30 else end
    return ("..." if start > 0 else "") + flat[start:end].strip() + ("..." if end < len(flat) else "")
