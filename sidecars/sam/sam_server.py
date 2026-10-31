"""Region finder for Muse Privacy: Meta's SAM 3.1 on this device, behind a small HTTP server.

    cd sidecars/sam && .venv/bin/python -m sam_server --host 127.0.0.1 --port 8085 \\
        --model-dir ../../models/sam3.1-mlx --key-file <BASE_HOME>/llama_api_key

scripts/start_sam.sh runs that line when SAM_ENABLED=1. POST /regions takes one page image and
concept names (face, signature, id card, barcode) and returns each region's kind, score and box,
plus a copy of the page with every padded box filled solid. GET /health says which model answers.
The key is the bearer token in a file under BASE_HOME; the host must be loopback; one request runs
at a time; the image is never logged or written to disk. See docs/CONTRACTS.md, Regions sidecar.

MlxSamPredictor runs SAM 3.1 through mlx-vlm (MIT) on Apple silicon. It is UNVERIFIED: it was
written from the mlx-community/sam3.1-bf16 model card and the mlx-vlm SAM 3 README and has never
run here, since neither mlx-vlm nor the weights are installed (both wait on Ethan's yes).
FakePredictor answers from eval/sam_pages/truth.json, so the tests run in the root environment and
never import mlx. This file imports only the standard library, Pillow, FastAPI and Starlette at the
top, which both environments have.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import hmac
import io
import json
import logging
import math
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from PIL import Image, ImageDraw
from starlette.concurrency import run_in_threadpool

log = logging.getLogger("sam_server")

# Concept name in a request -> region kind in a reply. The prompts sent to SAM for each concept are
# chosen on the dev split of eval/sam_pages; bump PROMPTS_VERSION when they change.
CONCEPTS = {"face": "face", "signature": "signature", "id card": "id_card", "barcode": "barcode"}
PROMPTS = {"face": ("face",), "signature": ("signature",), "id card": ("id card",), "barcode": ("barcode", "qr code")}
PROMPTS_VERSION = "v1"

PORT = 8085
MAX_BODY = 8 * 1024 * 1024
MAX_PIXELS = 40_000_000
DEFAULT_THRESHOLD = 0.3
DEFAULT_PAD = 8
MAX_PAD = 64
FILL = (0, 0, 0)
LOOPBACK = ("127.0.0.1", "::1", "localhost")
DEFAULT_MODEL = "mlx-community/sam3.1-bf16"


@dataclass(frozen=True)
class Region:
    kind: str
    concept: str
    score: float
    box: tuple[int, int, int, int]  # x1, y1, x2, y2 in pixels; x2 and y2 exclusive

    def as_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "concept": self.concept, "score": self.score, "box": list(self.box)}


class Predictor(Protocol):
    model: str
    backend: str

    def find(self, image: Image.Image, concept: str, threshold: float) -> list[Region]: ...


class BadRequest(ValueError):
    """A request the server will not run. The message is fixed text, never request content."""


# -- predictors ---------------------------------------------------------------------------------


def pixel_key(image: Image.Image) -> str:
    """A hash of the decoded pixels, so the same page matches however it was encoded."""
    rgb = image.convert("RGB")
    return hashlib.sha256(f"{rgb.width}x{rgb.height}".encode() + rgb.tobytes()).hexdigest()


class FakePredictor:
    """Answers from a truth.json made by scripts/make_sam_pages.py: the page's own boxes, score 1.0.

    An image that is not one of those pages has no regions. For tests and harness checks only.
    """

    backend = "fake"

    def __init__(self, truth_path: Path, model: str = "fake-from-truth"):
        truth_path = Path(truth_path)
        truth = json.loads(truth_path.read_text(encoding="utf-8"))
        self.model = model
        self.pages: dict[str, list[dict[str, Any]]] = {}
        for row in truth["pages"]:
            with Image.open(truth_path.parent / row["file"]) as im:
                self.pages[pixel_key(im)] = row["regions"]

    def find(self, image: Image.Image, concept: str, threshold: float) -> list[Region]:
        kind = CONCEPTS[concept]
        rows = self.pages.get(pixel_key(image), [])
        return [Region(kind, concept, 1.0, tuple(r["box"])) for r in rows if r["kind"] == kind]


class MlxSamPredictor:
    """SAM 3.1 (or SAM 3) through mlx-vlm. UNVERIFIED: written from the model card, never run here.

    The model card shows a Sam3Predictor whose predict(image, text_prompt=...) returns boxes,
    scores and masks. Only the boxes and scores are used: a box fill covers at least the mask and
    fails safe. If the import or the call does not match the installed mlx-vlm, this class is the one
    place to fix. mlx is imported here, never at the top of the file.
    """

    backend = "mlx"

    def __init__(self, model_dir: Path, model: str = DEFAULT_MODEL):
        model_dir = Path(model_dir)
        if not (model_dir / "config.json").is_file():
            raise FileNotFoundError(f"no SAM weights in {model_dir.name}/ (config.json is missing)")
        os.environ.setdefault("HF_HUB_OFFLINE", "1")  # never download at run time
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        try:
            from mlx_vlm.models.sam3.generate import Sam3Predictor  # UNVERIFIED path
            from mlx_vlm.utils import load  # UNVERIFIED: returns (model, processor)
        except ImportError as exc:
            raise RuntimeError("mlx-vlm's SAM 3 predictor was not found; see sidecars/sam/README.md") from exc
        loaded, processor = load(str(model_dir))
        self._predictor = Sam3Predictor(loaded, processor)
        self.model = model

    def find(self, image: Image.Image, concept: str, threshold: float) -> list[Region]:
        found: list[Region] = []
        for prompt in PROMPTS[concept]:
            result = self._predictor.predict(image, text_prompt=prompt)
            found.extend(regions_from_output(result.boxes, result.scores, concept, threshold, image.size))
        return dedupe(found)


def _rows(values: Any) -> list[Any]:
    if values is None:
        return []
    return values.tolist() if hasattr(values, "tolist") else list(values)


def regions_from_output(boxes: Any, scores: Any, concept: str, threshold: float,
                        size: tuple[int, int]) -> list[Region]:
    """Boxes (x1, y1, x2, y2, in pixels or 0..1) and scores from a model -> Regions inside the image."""
    w, h = size
    out = []
    for box, score in zip(_rows(boxes), _rows(scores), strict=False):
        score = float(score)
        if score < threshold:
            continue
        x1, y1, x2, y2 = (float(v) for v in box)
        if max(abs(x1), abs(y1), abs(x2), abs(y2)) <= 1.5:  # normalized coordinates
            x1, x2, y1, y2 = x1 * w, x2 * w, y1 * h, y2 * h
        left, right = sorted((x1, x2))
        top, bottom = sorted((y1, y2))
        b = (max(0, math.floor(left)), max(0, math.floor(top)), min(w, math.ceil(right)), min(h, math.ceil(bottom)))
        if b[2] > b[0] and b[3] > b[1]:
            out.append(Region(CONCEPTS[concept], concept, round(score, 3), b))
    return out


def _iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union else 0.0


def dedupe(regions: list[Region], iou: float = 0.7) -> list[Region]:
    """Drop a region that mostly repeats a higher-scoring one of the same kind (two prompts, one barcode)."""
    kept: list[Region] = []
    for r in sorted(regions, key=lambda r: -r.score):
        if all(k.kind != r.kind or _iou(k.box, r.box) < iou for k in kept):
            kept.append(r)
    return kept


# -- the work -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Job:
    image: bytes
    concepts: tuple[str, ...]
    threshold: float
    pad: int
    cover: bool


def parse_job(body: bytes) -> Job:
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise BadRequest("The body must be JSON.") from None
    if not isinstance(data, dict) or not isinstance(data.get("image_b64"), str):
        raise BadRequest("image_b64 is required.")
    try:
        image = base64.b64decode(data["image_b64"], validate=True)
    except (binascii.Error, ValueError):
        raise BadRequest("image_b64 is not base64.") from None
    concepts = data.get("concepts", list(CONCEPTS))
    if not isinstance(concepts, list) or not concepts or not all(c in CONCEPTS for c in concepts):
        raise BadRequest("concepts must be a list drawn from: " + ", ".join(CONCEPTS) + ".")
    threshold = data.get("threshold", DEFAULT_THRESHOLD)
    pad = data.get("pad", DEFAULT_PAD)
    cover = data.get("cover", True)
    if isinstance(threshold, bool) or not isinstance(threshold, int | float) or not 0 <= threshold <= 1:
        raise BadRequest("threshold must be a number from 0 to 1.")
    if isinstance(pad, bool) or not isinstance(pad, int) or not 0 <= pad <= MAX_PAD:
        raise BadRequest(f"pad must be a whole number from 0 to {MAX_PAD}.")
    if not isinstance(cover, bool):
        raise BadRequest("cover must be true or false.")
    return Job(image, tuple(dict.fromkeys(concepts)), float(threshold), pad, cover)


def open_image(data: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data))
        if image.format not in ("PNG", "JPEG"):
            raise BadRequest("That is not a PNG or JPEG image.")
        if image.width * image.height > MAX_PIXELS:
            raise BadRequest("The image is too large to check.")
        return image.convert("RGB")
    except BadRequest:
        raise
    except Exception:
        raise BadRequest("That is not a PNG or JPEG image.") from None


def cover(image: Image.Image, regions: list[Region], pad: int) -> Image.Image:
    """A copy with each region's box, grown by `pad` and clipped to the image, filled solid."""
    out = image.copy()
    draw = ImageDraw.Draw(out)
    w, h = out.size
    for r in regions:
        x1, y1, x2, y2 = r.box
        x1, y1, x2, y2 = max(0, x1 - pad), max(0, y1 - pad), min(w, x2 + pad), min(h, y2 + pad)
        if x2 > x1 and y2 > y1:
            draw.rectangle([x1, y1, x2 - 1, y2 - 1], fill=FILL)
    return out


def counts(regions: list[Region]) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in regions:
        out[r.kind] = out.get(r.kind, 0) + 1
    return out


def check(predictor: Predictor, job: Job) -> dict[str, Any]:
    start = time.monotonic()
    image = open_image(job.image)
    regions: list[Region] = []
    for concept in job.concepts:
        regions.extend(predictor.find(image, concept, job.threshold))
    reply: dict[str, Any] = {
        "width": image.width,
        "height": image.height,
        "model": predictor.model,
        "prompts_version": PROMPTS_VERSION,
        "regions": [r.as_dict() for r in regions],
        "counts": counts(regions),
        "pad": job.pad,
    }
    if job.cover:
        buf = io.BytesIO()
        cover(image, regions, job.pad).save(buf, format="PNG")
        reply["covered_png_b64"] = base64.b64encode(buf.getvalue()).decode("ascii")
    reply["ms"] = round((time.monotonic() - start) * 1000)
    found = ", ".join(f"{n} {k}" for k, n in sorted(reply["counts"].items())) or "nothing"
    log.info("regions: %s in %d ms", found, reply["ms"])  # counts only, never pixels
    return reply


# -- the HTTP app -------------------------------------------------------------------------------


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def _authorized(request: Request, key: str) -> bool:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    return scheme.lower() == "bearer" and hmac.compare_digest(token.strip().encode(), key.encode())


async def _read_capped(request: Request) -> bytes | None:
    """The body, or None once it passes MAX_BODY (checked before and while reading)."""
    try:
        if int(request.headers.get("content-length", "0")) > MAX_BODY:
            return None
    except ValueError:
        return None
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def create_app(predictor: Predictor, key: str) -> FastAPI:
    if not key:
        raise ValueError("the region finder needs an API key")
    app = FastAPI(title="Muse Privacy regions", docs_url=None, redoc_url=None, openapi_url=None)
    lock = threading.Lock()  # one image at a time: the model is not shared between threads

    def run(job: Job) -> JSONResponse:
        with lock:
            try:
                return JSONResponse(check(predictor, job))
            except BadRequest as exc:
                return _error(400, str(exc))
            except Exception as exc:
                log.warning("region check failed: %s", type(exc).__name__)
                return _error(500, "The region model failed on that image.")

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "model": predictor.model, "backend": predictor.backend,
                "prompts_version": PROMPTS_VERSION, "concepts": list(CONCEPTS)}

    @app.post("/regions")
    async def regions(request: Request) -> JSONResponse:
        if not _authorized(request, key):
            return _error(401, "A valid bearer key is required.")
        body = await _read_capped(request)
        if body is None:
            return _error(413, "The request is over 8 MB.")
        try:
            job = parse_job(body)
        except BadRequest as exc:
            return _error(400, str(exc))
        return await run_in_threadpool(run, job)

    return app


def read_key(path: Path) -> str | None:
    try:
        return Path(path).expanduser().read_text().strip() or None
    except OSError:
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="SAM region finder for Muse Privacy (loopback only).")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL, help="the id /health reports, e.g. mlx-community/sam3-8bit")
    parser.add_argument("--key-file", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.host not in LOOPBACK:
        parser.error("--host must be 127.0.0.1, ::1 or localhost: this server reads raw page images")
    key = read_key(args.key_file)
    if not key:
        parser.error("the key file is missing or empty; scripts/start_sam.sh makes BASE_HOME/llama_api_key")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    try:
        predictor = MlxSamPredictor(args.model_dir, args.model)
    except (FileNotFoundError, RuntimeError) as exc:
        parser.exit(1, f"sam_server: {exc}\n")
    import uvicorn

    uvicorn.run(create_app(predictor, key), host=args.host, port=args.port, access_log=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
