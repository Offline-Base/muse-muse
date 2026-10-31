"""Cover faces, signatures, ID cards and barcodes in a page image before the local model reads it.

See docs/CONTRACTS.md, Regions. With SAM_ENABLED=1 the scan reader (base/workspace/scans.py) sends
each image to Meta's SAM 3.1 on this device (the sidecar in sidecars/sam/, at SAM_URL, loopback
only) and LFM3-VL-2B reads only the covered copy that comes back. If the sidecar is down, slow,
answers with the fake test model or replies badly, RegionClient.check raises RegionError and the
image is not read at all: the device fails closed, and the result Muse gets says how many images
were left out (unchecked_images below).

What the sidecar found is kept under BASE_HOME/regions, one pair of files per image hash:
<sha>.json (counts, boxes, model and prompts version, no pixels) and <sha>.png (the covered copy,
never the original), both 0600 in a 0700 folder. Retention deletes them with the scan text. Boxes
and pixels never leave this device: receipts carry counts per kind, and only the approval page
shows the covered copy, to the user.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
import os
import struct
import threading
import time
from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

import httpx

from base.config import Settings, _is_loopback_url

log = logging.getLogger(__name__)

CONCEPTS = ("face", "signature", "id card", "barcode")
KINDS = ("face", "signature", "id_card", "barcode")
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg")
PAD = 8  # pixels added around each box before it is filled; the sidecar's default too
TIMEOUT_SECONDS = 60
CONNECT_SECONDS = 5
HEALTH_SECONDS = 60  # how long a good /health answer counts
RETRY_SECONDS = 30  # after the sidecar was down or slow, images fail closed at once for this long
RECORD_VERSION = 1
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

UNCHECKED = "The device could not check that image for faces and signatures, so it was not read."
_WORDS = {
    "face": ("photo of a person", "photos of people"),
    "signature": ("signature", "signatures"),
    "id_card": ("ID card", "ID cards"),
    "barcode": ("barcode", "barcodes"),
}


class RegionError(RuntimeError):
    """The image could not be checked. The message is fixed text, never sidecar output."""


@dataclass(frozen=True)
class Regions:
    """One image's check: counts per kind, the boxes, and the covered PNG. Stays on this device."""

    sha: str
    counts: dict[str, int]
    boxes: tuple[tuple[str, tuple[int, int, int, int]], ...]
    model: str
    prompts_version: str
    covered: bytes = field(repr=False)


@dataclass(frozen=True)
class ImageCheck:
    """What egress knows about the images a result came from: counts per kind over the images the
    sidecar checked, and how many images have no check on record."""

    counts: dict[str, int]
    checked: int
    unchecked: int


# -- words ----------------------------------------------------------------------------------------


def describe(counts: Mapping[str, int]) -> str:
    """'2 signatures and 1 photo of a person', in KINDS order; '' when nothing was found."""
    parts = []
    for kind in KINDS:
        n = int(counts.get(kind, 0) or 0)
        if n > 0:
            one, many = _WORDS[kind]
            parts.append(f"{n} {one if n == 1 else many}")
    if len(parts) < 2:
        return "".join(parts)
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def covered_note(counts: Mapping[str, int]) -> str:
    """The fixed sentence the scan reader adds after the text it read from a covered page."""
    found = describe(counts)
    if found:
        return f"Covered on this device before reading: {found}."
    return "Checked on this device before reading: no faces, signatures, ID cards or barcodes found."


def unchecked_note(n: int) -> str:
    """The fixed sentence a result gets when images were left out because they could not be checked."""
    if n == 1:
        return "1 image was not read, because the device could not check it for faces and signatures first."
    return f"{n} images were not read, because the device could not check them for faces and signatures first."


# -- images left unread in one call ---------------------------------------------------------------

_UNCHECKED: ContextVar[set[str] | None] = ContextVar("unchecked_images", default=None)


@contextmanager
def unchecked_images() -> Iterator[set[str]]:
    """Collect the images the scan reader left unread inside this block (paths, kept in memory only),
    so the caller can add unchecked_note(len(...)) to what it returns."""
    box: set[str] = set()
    token = _UNCHECKED.set(box)
    try:
        yield box
    finally:
        _UNCHECKED.reset(token)


def note_unchecked(path: Any) -> None:
    box = _UNCHECKED.get()
    if box is not None:
        box.add(str(path))


# -- the cache ------------------------------------------------------------------------------------


def png_size(data: bytes) -> tuple[int, int] | None:
    """(width, height) from a PNG's header, or None when `data` is not a PNG."""
    if len(data) < 24 or data[:8] != PNG_SIGNATURE or data[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", data[16:24])


def read_record(folder: Path, sha: str) -> dict[str, Any] | None:
    """The stored check for one image hash (counts, boxes, model), or None when there is none."""
    if not _is_sha(sha):
        return None
    try:
        data = json.loads((Path(folder) / f"{sha}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("version") != RECORD_VERSION or not isinstance(data.get("counts"), dict):
        return None
    return data


def _is_sha(value: str) -> bool:
    return len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def _write_private(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


# -- the sidecar ----------------------------------------------------------------------------------


def parse_reply(sha: str, body: Any) -> Regions:
    """A /regions reply checked field by field. Counts are recomputed from the regions, and the
    covered copy must be a PNG the size of the page. Anything else is a RegionError."""
    try:
        width, height = int(body["width"]), int(body["height"])
        boxes = []
        for r in body["regions"]:
            kind, box = r["kind"], tuple(int(v) for v in r["box"])
            if kind not in KINDS or len(box) != 4:
                raise ValueError("kind or box")
            x1, y1, x2, y2 = box
            if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
                raise ValueError("box outside the page")
            boxes.append((kind, box))
        covered = base64.b64decode(body["covered_png_b64"], validate=True)
        model, prompts = str(body["model"]), str(body.get("prompts_version") or "")
    except (KeyError, TypeError, ValueError, binascii.Error):
        raise RegionError(UNCHECKED) from None
    if width <= 0 or height <= 0 or png_size(covered) != (width, height):
        raise RegionError(UNCHECKED)
    counts: dict[str, int] = {}
    for kind, _box in boxes:
        counts[kind] = counts.get(kind, 0) + 1
    return Regions(sha, counts, tuple(boxes), model, prompts, covered)


class RegionClient:
    """The SAM sidecar on this device. `check(image bytes) -> Regions`, from the cache when this
    image was checked before; RegionError (fail closed) for anything that is not a good answer
    from the real model. `allow_fake=True` accepts the sidecar's fake test model (tests only)."""

    def __init__(self, settings: Settings, *, client: httpx.Client | None = None, allow_fake: bool = False,
                 clock: Any = time.monotonic):
        if not _is_loopback_url(settings.sam_url):
            raise ValueError("SAM_URL must be this device (127.0.0.1 or localhost): it reads raw page images")
        self.url = settings.sam_url.rstrip("/")
        self.key = settings.checker_api_key  # the same BASE_HOME/llama_api_key file as the model servers
        self.folder = settings.paths.regions
        self.allow_fake = allow_fake
        self.client = client or httpx.Client(
            timeout=httpx.Timeout(TIMEOUT_SECONDS, connect=CONNECT_SECONDS), trust_env=False
        )
        self._clock = clock
        self._lock = threading.Lock()
        self._healthy_until = 0.0
        self._down_until = 0.0

    def close(self) -> None:
        self.client.close()

    def check(self, data: bytes) -> Regions:
        sha = hashlib.sha256(data).hexdigest()
        found = self.cached(sha)
        if found is not None:
            return found
        if not self.key or self._clock() < self._down_until:
            raise RegionError(UNCHECKED)
        try:
            self._verify()
            response = self.client.post(
                f"{self.url}/regions",
                headers={"Authorization": f"Bearer {self.key}"},
                json={"image_b64": base64.b64encode(data).decode("ascii"), "concepts": list(CONCEPTS), "pad": PAD, "cover": True},
            )
            response.raise_for_status()
            found = parse_reply(sha, response.json())
        except httpx.TransportError as exc:  # down or slow: the next images fail at once for a while
            log.warning("image check failed: %s", type(exc).__name__)
            self._failed()
            raise RegionError(UNCHECKED) from None
        except Exception as exc:  # a fake model, an error status or a bad reply: this image only
            log.warning("image check failed: %s", type(exc).__name__)
            with self._lock:
                self._healthy_until = 0.0  # ask /health again next time
            raise RegionError(UNCHECKED) from None
        self._save(found)
        return found

    def available(self) -> bool:
        """Whether the real model answers right now (the Controls page shows a line when not)."""
        if not self.key:
            return False
        try:
            self._verify(timeout=2)
            return True
        except Exception:
            self._failed()
            return False

    def _verify(self, timeout: float | None = None) -> None:
        """GET /health, at most once a minute while it is good: a fake model is no checker."""
        if self._clock() < self._healthy_until:
            return
        kw = {"timeout": timeout} if timeout is not None else {}
        response = self.client.get(f"{self.url}/health", **kw)
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict) or body.get("ok") is not True:
            raise RegionError(UNCHECKED)
        if not (body.get("backend") == "mlx" or (body.get("backend") == "fake" and self.allow_fake)):
            raise RegionError(UNCHECKED)
        with self._lock:
            self._healthy_until = self._clock() + HEALTH_SECONDS

    def _failed(self) -> None:
        with self._lock:
            self._healthy_until = 0.0
            self._down_until = self._clock() + RETRY_SECONDS

    def cached(self, sha: str) -> Regions | None:
        """This image's earlier check, or None (none yet, or a broken file: then it is checked again)."""
        record = read_record(self.folder, sha)
        png = self.folder / f"{sha}.png"
        try:
            if record is None or png_size(covered := png.read_bytes()) is None:
                return None
            boxes = tuple((str(k), tuple(int(v) for v in b)) for k, b in record.get("boxes") or [])
            counts = {str(k): int(n) for k, n in record["counts"].items()}
        except (OSError, TypeError, ValueError):
            return None
        return Regions(sha, counts, boxes, str(record.get("model") or ""), str(record.get("prompts_version") or ""), covered)

    def _save(self, found: Regions) -> None:
        record = {
            "version": RECORD_VERSION,
            "counts": found.counts,
            "boxes": [[k, list(b)] for k, b in found.boxes],
            "model": found.model,
            "prompts_version": found.prompts_version,
            "pad": PAD,
        }
        _write_private(self.folder / f"{found.sha}.png", found.covered)  # the png first: a record means both exist
        _write_private(self.folder / f"{found.sha}.json", json.dumps(record).encode("utf-8"))


# -- what egress and the approval page look up ----------------------------------------------------


def image_sources(sources: Iterable[Any]) -> list[str]:
    """The sources of a result that are images, in order."""
    return [str(s) for s in sources or () if str(s).lower().endswith(IMAGE_SUFFIXES)]


# The prefix on a source image that was read while covering was off (a local_only toggle or a
# broken controls file keeps SAM out). image_check counts it as unchecked, so with SAM_ENABLED=1
# egress keeps the result (floor regions:unchecked) even after the toggle is turned off.
UNCOVERED = "uncovered:"


def reads_uncovered(index: Any) -> bool:
    """Whether the index's scan reader reads page images without covering them right now: it has
    a region client (SAM_ENABLED=1) but ScanReader.covering() says no."""
    scans = getattr(index, "scans", None)
    return getattr(scans, "regions", None) is not None and not scans.covering()


def mark_uncovered(sources: Iterable[Any]) -> list[str]:
    """The sources with each image marked UNCOVERED (once)."""
    out = []
    for s in sources or ():
        s = str(s)
        out.append(UNCOVERED + s if s.lower().endswith(IMAGE_SUFFIXES) and not s.startswith(UNCOVERED) else s)
    return out


def workspace_file(settings: Settings, doc_id: str) -> Path | None:
    """A source's file inside the workspace root, or None (outside the root, missing, not a file)."""
    rel = PurePosixPath(str(doc_id).replace("\\", "/"))
    if rel.is_absolute() or ".." in rel.parts or str(doc_id).startswith("~"):
        return None
    root = Path(settings.workspace_root).resolve()
    path = (root / rel).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        return None
    return path


def _sha_of(settings: Settings, doc_id: str) -> str | None:
    path = workspace_file(settings, doc_id)
    if path is None:
        return None
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def image_check(settings: Settings, sources: Iterable[Any]) -> ImageCheck | None:
    """Counts per kind for the image sources the sidecar checked, and how many it never checked
    (no record, or the file changed or is gone). None when no source is an image."""
    images = image_sources(sources)
    if not images:
        return None
    counts: dict[str, int] = {}
    checked = unchecked = 0
    for doc_id in images:
        if doc_id.startswith(UNCOVERED):  # read while covering was off: a record does not cover that reading
            unchecked += 1
            continue
        sha = _sha_of(settings, doc_id)
        record = read_record(settings.paths.regions, sha) if sha else None
        if record is None:
            unchecked += 1
            continue
        checked += 1
        for kind, n in record["counts"].items():
            if kind in KINDS:
                counts[kind] = counts.get(kind, 0) + int(n)
    return ImageCheck(counts, checked, unchecked)


def covered_png(settings: Settings, doc_id: str) -> Path | None:
    """The covered copy of a source image, or None. Never the original: only files in
    BASE_HOME/regions with a check on record are returned."""
    sha = _sha_of(settings, doc_id)
    if not sha or read_record(settings.paths.regions, sha) is None:
        return None
    path = Path(settings.paths.regions) / f"{sha}.png"
    return path if path.is_file() else None
