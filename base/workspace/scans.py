"""Text out of images in the workspace, read by the local vision model. See docs/CONTRACTS.md, Workspace.

A scanned form or a photo of a page becomes text the index can search and the guard can tag like
any other document. Only a model on this device may read one: ScanReader refuses a client that
calls a cloud endpoint. What the model read is kept under BASE_HOME/scans (0600), one file per
image hash, so each image is read once and never written back into the workspace folder.

With SAM_ENABLED=1 the reader has a RegionClient (base/regions.py): the SAM 3.1 sidecar covers
faces, signatures, ID cards and barcodes first, the model reads only the covered copy, and the text
ends with one fixed sentence saying what was covered. That text is cached apart from the plain
reading (<sha>.covered-v1.txt), so an older reading of the uncovered page is never reused. An image
the sidecar cannot check is not read at all (ScanError), and the index then leaves it out.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
from pathlib import Path
from typing import Any

from base import compliance
from base.config import Settings
from base.regions import UNCHECKED, RegionError, covered_note, note_unchecked

log = logging.getLogger(__name__)

IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
SCAN_MAX_TOKENS = 2000
COVER_VERSION = "v1"  # part of the covered text's cache name: bump it when covering changes

SCAN_PROMPT = (
    "You read scanned documents. Write out all the text in the image exactly as it appears, line "
    "by line, top to bottom: names, numbers, dates and handwriting included. Do not summarize, "
    "explain or add anything. If a word cannot be read, write [unreadable]. Reply with the text only."
)


class ScanError(RuntimeError):
    """The device could not read an image. The message is fixed text, never model output."""


class ScanReader:
    def __init__(
        self, settings: Settings, llm: Any, *, max_tokens: int = SCAN_MAX_TOKENS, regions: Any = None, controls: Any = None
    ):
        if getattr(llm, "is_cloud", True):
            raise ValueError("only a model on this device may read scans")
        self.settings = settings
        self.llm = llm
        self.max_tokens = max_tokens
        self.regions = regions  # a RegionClient with SAM_ENABLED=1, else None: pages are read as they are
        self.controls = controls  # the ControlStore, for the toggles that keep SAM out

    @property
    def folder(self) -> Path:
        return self.settings.paths.scans

    def text(self, path: Path) -> str:
        """The text in the image at `path`, from the cache or one call to the vision model."""
        mime = IMAGE_TYPES.get(path.suffix.lower())
        if mime is None:
            raise ScanError("That file is not an image the device can read.")
        data = path.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        if self._covering():
            return self._covered_text(path, data, sha)
        cached = self.folder / f"{sha}.txt"
        if cached.is_file():
            return cached.read_text(encoding="utf-8")
        text = self._read(data, mime)
        self._save(cached, text)
        return text

    def _covering(self) -> bool:
        """Whether the page goes to the SAM sidecar before the model reads it.

        Never while the cui, cjis or export toggle is on: the SAM License excludes ITAR and military
        end uses, and those toggles already keep every result on this device (egress refuses them
        all, floor compliance:local_only), so the page is read as it is and nothing read from it can
        leave. A broken controls file reads as every toggle on, so it keeps SAM out too.
        """
        if self.regions is None:
            return False
        try:
            profiles = self.controls.get().profiles if self.controls is not None else []
        except Exception as exc:
            log.warning("privacy controls unreadable (%s); every toggle applies", type(exc).__name__)
            profiles = list(compliance.PROFILES)
        return not compliance.local_only(profiles)

    def _covered_text(self, path: Path, data: bytes, sha: str) -> str:
        # The check comes first even when the text is cached: it is a cache hit in BASE_HOME/regions
        # when the page was checked before, and it keeps a record of the check (which egress needs
        # for receipts) next to every covered reading, also after retention removed an old one.
        try:
            found = self.regions.check(data)
        except RegionError:
            note_unchecked(path)  # the caller's result says how many images were left out
            raise ScanError(UNCHECKED) from None
        cached = self.folder / f"{sha}.covered-{COVER_VERSION}.txt"
        if cached.is_file():
            return cached.read_text(encoding="utf-8")
        text = f"{self._read(found.covered, 'image/png')}\n\n{covered_note(found.counts)}".strip()
        self._save(cached, text)
        return text

    def _read(self, data: bytes, mime: str) -> str:
        url = f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
        messages = [
            {"role": "system", "content": SCAN_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": url}},
                    {"type": "text", "text": "Write out the text in this image."},
                ],
            },
        ]
        try:
            result = self.llm.chat(messages, max_tokens=self.max_tokens)
        except Exception as exc:
            log.warning("could not read a scan: %s", type(exc).__name__)
            raise ScanError("The device could not read that scan.") from None
        return (getattr(result, "content", "") or "").strip()

    def _save(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        tmp = path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
