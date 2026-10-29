"""Text out of images in the workspace, read by the local vision model. See docs/CONTRACTS.md, Workspace.

A scanned form or a photo of a page becomes text the index can search and the guard can tag like
any other document. Only a model on this device may read one: ScanReader refuses a client that
calls a cloud endpoint. What the model read is kept under BASE_HOME/scans (0600), one file per
image hash, so each image is read once and never written back into the workspace folder.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
from pathlib import Path
from typing import Any

from base.config import Settings

log = logging.getLogger(__name__)

IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}
SCAN_MAX_TOKENS = 2000

SCAN_PROMPT = (
    "You read scanned documents. Write out all the text in the image exactly as it appears, line "
    "by line, top to bottom: names, numbers, dates and handwriting included. Do not summarize, "
    "explain or add anything. If a word cannot be read, write [unreadable]. Reply with the text only."
)


class ScanError(RuntimeError):
    """The device could not read an image. The message is fixed text, never model output."""


class ScanReader:
    def __init__(self, settings: Settings, llm: Any, *, max_tokens: int = SCAN_MAX_TOKENS):
        if getattr(llm, "is_cloud", True):
            raise ValueError("only a model on this device may read scans")
        self.settings = settings
        self.llm = llm
        self.max_tokens = max_tokens

    @property
    def folder(self) -> Path:
        return self.settings.paths.scans

    def text(self, path: Path) -> str:
        """The text in the image at `path`, from the cache or one call to the vision model."""
        mime = IMAGE_TYPES.get(path.suffix.lower())
        if mime is None:
            raise ScanError("That file is not an image the device can read.")
        data = path.read_bytes()
        cached = self.folder / f"{hashlib.sha256(data).hexdigest()}.txt"
        if cached.is_file():
            return cached.read_text(encoding="utf-8")
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
        text = (getattr(result, "content", "") or "").strip()
        self._save(cached, text)
        return text

    def _save(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        tmp = path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
