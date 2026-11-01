"""Document index for the private workspace. See docs/CONTRACTS.md, Workspace.

Only .md and .txt files under settings.workspace_root are visible, plus .pdf files when pdftotext
is installed (its text layer, read on this device), and .png and .jpg images when
the index has a ScanReader (a local vision model; see scans.py), whose text it reads through
that reader. Folder and document names are
relative to the root; absolute paths, ".." and symlinks that lead outside the root are rejected.
Every call checks config.assert_synthetic before it touches a file, so a cloud Glimmer backend
never reads a folder that is not marked as invented data. Search is BM25; with an Embedder
(EmbeddingGemma 2 on this device, see embed.py) it also ranks by meaning and fuses the two
rankings (reciprocal rank fusion), so a passage can be found without sharing a word with the query.
"""

from __future__ import annotations

import logging
import math
import os
import re
import subprocess
from collections import Counter
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from base.config import Settings, assert_synthetic

log = logging.getLogger(__name__)

EXTENSIONS = (".md", ".txt")
PDF_EXTENSIONS = (".pdf",)
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg")
PDF_TIMEOUT = 30
RRF_K = 60
MAX_PIECES_PER_DOC = 3  # passages() never lets one long file fill the whole list
# passages(): the meaning ranking counts only its closest pieces for each query. Past them a piece
# needs a keyword match. Every piece has some similarity, so counting them all let unrelated files
# (class essays, for a question about a credit union) fill every slot.
MEANING_TOP = 5
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
    def __init__(self, settings: Settings, scans: Any = None, embedder: Any = None, controls: Any = None):
        self.settings = settings
        self.controls = controls  # a ControlStore, or None: then every folder is visible
        self.root = Path(settings.workspace_root).resolve()
        self.scans = scans  # a ScanReader, or None: then images are not documents
        self.embedder = embedder  # an Embedder, or None: then search is BM25 only
        self.pdftotext = getattr(settings, "pdftotext_bin", None)
        self._pdf_cache: dict[tuple[str, float, int], str] = {}

    @property
    def extensions(self) -> tuple[str, ...]:
        found = EXTENSIONS + (PDF_EXTENSIONS if self.pdftotext else ())
        return found + IMAGE_EXTENSIONS if self.scans is not None else found

    def _is_image(self, path: Path) -> bool:
        return self.scans is not None and path.name.lower().endswith(IMAGE_EXTENSIONS)

    def _is_pdf(self, path: Path) -> bool:
        return bool(self.pdftotext) and path.name.lower().endswith(PDF_EXTENSIONS)

    def _text(self, path: Path) -> str:
        """A text file's contents, a PDF's text layer, or what the local vision model read in an image."""
        if self._is_image(path):
            return self.scans.text(path)
        if self._is_pdf(path):
            return self._pdf_text(path)
        return path.read_text(encoding="utf-8", errors="replace")

    def _pdf_text(self, path: Path) -> str:
        """pdftotext on this device, cached until the file changes. A PDF with no text layer
        (a scan) reads as empty."""
        stat = path.stat()
        key = (str(path.resolve()), stat.st_mtime, stat.st_size)
        if key not in self._pdf_cache:
            done = subprocess.run(
                [self.pdftotext, "-layout", "-enc", "UTF-8", "-q", str(path), "-"],
                capture_output=True,
                timeout=PDF_TIMEOUT,
                check=False,
            )
            if done.returncode != 0:
                raise ValueError("pdftotext could not read that PDF")
            self._pdf_cache[key] = done.stdout.decode("utf-8", errors="replace")
        return self._pdf_cache[key]

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
        if full != self.root and not self._visible(full):
            raise FileNotFoundError("That folder is not in the workspace.")  # hidden by the user
        return full

    def _visible(self, path: Path) -> bool:
        """False for anything in a folder the user hid from Muse on the Controls page."""
        if self.controls is None:
            return True
        return self.controls.get().visible(path.relative_to(self.root).as_posix())

    def _rel(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()

    def _files(self, folder: Path) -> list[Path]:
        """Visible documents under folder, skipping hidden names and links out of the root."""
        found: list[Path] = []
        for dirpath, dirnames, filenames in os.walk(folder, followlinks=False):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for fname in sorted(filenames):
                if fname.startswith(".") or not fname.lower().endswith(self.extensions):
                    continue
                path = Path(dirpath) / fname
                real = path.resolve()
                if not real.is_relative_to(self.root) or not real.is_file():
                    continue
                if not self._visible(path):
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
        if hidden or not path.is_file() or not path.name.lower().endswith(self.extensions):
            raise FileNotFoundError("That document is not in the workspace.")
        return self._text(path)

    def passages(self, queries: list[str] | str, k: int = 20, folder: str | None = None) -> list[Snippet]:
        """The best ~800-character pieces of every document under folder for one or more queries.

        Each piece is ranked by BM25 and, with an embedder, by meaning; every ranking of every query
        adds 1 / (60 + rank) to a piece (reciprocal rank fusion), so a piece that several queries or
        both methods agree on comes first. The meaning ranking counts only its MEANING_TOP closest
        pieces per query, so a piece with no keyword match must be among those. At most 3 pieces
        per document. Snippet.text is the whole
        piece and Snippet.score the fused score.
        """
        from base.workspace.embed import EmbedError, chunks, cosine

        qs = [q.strip() for q in ([queries] if isinstance(queries, str) else queries) if q and q.strip()]
        base = self.resolve(folder)
        assert_synthetic(self.settings, base)
        if not qs or not base.is_dir():
            return []
        pieces: list[tuple[str, str, str]] = []  # (doc_id, title, text)
        for doc_id, title, text in self._load(base):
            pieces += [(doc_id, title, piece) for piece in chunks(text)]
        if not pieces:
            return []
        tfs = [Counter(tokenize(title + "\n" + piece)) for _d, title, piece in pieces]
        vectors = None
        if self.embedder is not None:
            try:
                groups: dict[str, list[int]] = {}  # one documents() call per file, with its title
                for i, (doc_id, _t, _p) in enumerate(pieces):
                    groups.setdefault(doc_id, []).append(i)
                vectors = [[] for _ in pieces]
                for idxs in groups.values():
                    got = self.embedder.documents(pieces[idxs[0]][1], [pieces[i][2] for i in idxs])
                    for i, v in zip(idxs, got, strict=True):
                        vectors[i] = v
            except EmbedError as exc:
                log.warning("passages used keywords only: %s", exc)
                vectors = None
        fused = [0.0] * len(pieces)
        for q in qs:
            terms = list(dict.fromkeys(tokenize(q)))
            bm = _bm25(tfs, terms)
            for rank, i in enumerate(sorted((i for i in range(len(pieces)) if bm[i] > 0), key=lambda i: -bm[i])):
                fused[i] += 1 / (RRF_K + rank + 1)
            if vectors is not None:
                try:
                    qv = self.embedder.query(q)
                except EmbedError as exc:
                    log.warning("passages used keywords only for a query: %s", exc)
                    continue
                sims = [cosine(qv, v) for v in vectors]
                closest = sorted(range(len(pieces)), key=lambda i: -sims[i])[:MEANING_TOP]
                for rank, i in enumerate(closest):
                    fused[i] += 1 / (RRF_K + rank + 1)
        out: list[Snippet] = []
        per_doc: Counter = Counter()
        for i in sorted((i for i in range(len(pieces)) if fused[i] > 0), key=lambda i: (-fused[i], pieces[i][0], i)):
            doc_id, title, piece = pieces[i]
            if per_doc[doc_id] >= MAX_PIECES_PER_DOC:
                continue
            per_doc[doc_id] += 1
            out.append(Snippet(doc_id, title, piece, round(fused[i], 5)))
            if len(out) >= k:
                break
        return out

    def _load(self, base: Path) -> list[tuple[str, str, str]]:
        """(doc_id, title, text) for every readable document under base."""
        docs = []
        for path in self._files(base):
            assert_synthetic(self.settings, path.resolve().parent)  # a link into an unmarked folder
            try:
                text = self._text(path)
            except Exception as exc:  # a scan or PDF the device could not read: use the rest
                log.warning("skipped a document: %s", type(exc).__name__)
                continue
            title = _stem_title(path) if self._is_image(path) or self._is_pdf(path) else _title(path, text[:TITLE_SCAN_CHARS])
            docs.append((self._rel(path), title, text))
        return docs

    def search(self, query: str, k: int = 5, folder: str | None = None) -> list[Snippet]:
        """BM25 over every visible document under folder (default: the whole root), fused with
        an embedding ranking when the index has an embedder."""
        base = self.resolve(folder)
        assert_synthetic(self.settings, base)
        terms = list(dict.fromkeys(tokenize(query)))
        if not (terms or (self.embedder is not None and query.strip())) or not base.is_dir():
            return []
        docs = []
        for path in self._files(base):
            assert_synthetic(self.settings, path.resolve().parent)  # a link into an unmarked folder
            try:
                text = self._text(path)
            except Exception as exc:  # a scan or PDF the device could not read: search the rest
                log.warning("skipped a document in search: %s", type(exc).__name__)
                continue
            title = _stem_title(path) if self._is_image(path) or self._is_pdf(path) else _title(path, text[:TITLE_SCAN_CHARS])
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
        if self.embedder is not None:
            fused = self._fuse(query, scored, docs, terms, idf, k)
            if fused is not None:
                return fused
        return [
            Snippet(doc_id, title, snippet(text, terms, idf), round(score, 4))
            for score, doc_id, title, text in scored[:k]
        ]

    def _fuse(self, query, scored, docs, terms, idf, k) -> list[Snippet] | None:
        """Reciprocal rank fusion of the BM25 ranking and the embedding ranking. A document found
        only by meaning shows its closest piece. None when the embedder fails (keywords only)."""
        from base.workspace.embed import EmbedError, chunks, cosine

        try:
            q = self.embedder.query(query)
            best: dict[str, tuple[float, str]] = {}
            for doc_id, title, text, _tf in docs:
                pieces = chunks(text)
                if not pieces:
                    continue
                sims = [cosine(q, v) for v in self.embedder.documents(title, pieces)]
                i = max(range(len(sims)), key=sims.__getitem__)
                best[doc_id] = (sims[i], pieces[i])
        except EmbedError as exc:
            log.warning("search used keywords only: %s", exc)
            return None
        fused: dict[str, float] = {}
        for rank, (_s, doc_id, _t, _x) in enumerate(scored):
            fused[doc_id] = fused.get(doc_id, 0.0) + 1 / (RRF_K + rank + 1)
        by_meaning = sorted(best, key=lambda d: (-best[d][0], d))
        for rank, doc_id in enumerate(by_meaning):
            fused[doc_id] = fused.get(doc_id, 0.0) + 1 / (RRF_K + rank + 1)
        keyword_hits = {doc_id for _s, doc_id, _t, _x in scored}
        info = {doc_id: (title, text) for doc_id, title, text, _tf in docs}
        out = []
        for doc_id in sorted(fused, key=lambda d: (-fused[d], d))[:k]:
            title, text = info[doc_id]
            if doc_id in keyword_hits:
                shown = snippet(text, terms, idf)
            else:
                piece = best[doc_id][1]
                shown = piece if len(piece) <= SNIPPET_CHARS else piece[:SNIPPET_CHARS].rsplit(" ", 1)[0] + "..."
            out.append(Snippet(doc_id, title, shown, round(fused[doc_id], 4)))
        return out

    def _doc(self, path: Path) -> Doc:
        stat = path.stat()
        rel = self._rel(path)
        if self._is_image(path) or self._is_pdf(path):  # listing never reads these; the title is the file name
            return Doc(id=rel, path=rel, title=_stem_title(path), size=stat.st_size, modified=stat.st_mtime)
        with path.open(encoding="utf-8", errors="replace") as f:
            head = f.read(2000)
        return Doc(id=rel, path=rel, title=_title(path, head), size=stat.st_size, modified=stat.st_mtime)


TITLE_SCAN_CHARS = 2000


def _stem_title(path: Path) -> str:
    """A file name as a title, with _ as spaces, so "Jo_Ng_Resume" reads as a name and a word
    (the name check then tags just the name, not the whole title)."""
    return re.sub(r"\s+", " ", path.stem.replace("_", " ")).strip() or path.stem
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


def _bm25(tfs: list[Counter], terms: list[str]) -> list[float]:
    """BM25 of each term-frequency table for the query terms (0.0 where none occur)."""
    n = len(tfs)
    if not n or not terms:
        return [0.0] * n
    avg_len = sum(sum(tf.values()) for tf in tfs) / n or 1.0
    df = {t: sum(1 for tf in tfs if t in tf) for t in terms}
    idf = {t: math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5)) for t in terms}
    scores = []
    for tf in tfs:
        length = sum(tf.values())
        score = 0.0
        for t in terms:
            f = tf.get(t, 0)
            if f:
                score += idf[t] * f * (K1 + 1) / (f + K1 * (1 - B + B * length / avg_len))
        scores.append(score)
    return scores
