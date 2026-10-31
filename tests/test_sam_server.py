"""sidecars/sam/sam_server.py with the fake predictor, and scripts/start_sam.sh. Never imports mlx."""

from __future__ import annotations

import base64
import importlib.util
import io
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageChops, ImageDraw

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "sidecars" / "sam" / "sam_server.py"
START = REPO / "scripts" / "start_sam.sh"
TRUTH_PATH = REPO / "eval" / "sam_pages" / "truth.json"
TRUTH = json.loads(TRUTH_PATH.read_text(encoding="utf-8"))
KEY = "test-sam-key"
AUTH = {"Authorization": f"Bearer {KEY}"}


def load_server():
    spec = importlib.util.spec_from_file_location("sam_server", SERVER)
    module = importlib.util.module_from_spec(spec)
    sys.modules["sam_server"] = module
    spec.loader.exec_module(module)
    return module


sam = load_server()


@pytest.fixture(scope="module")
def fake():
    return sam.FakePredictor(TRUTH_PATH)


@pytest.fixture
def client(fake):
    with TestClient(sam.create_app(fake, KEY)) as c:
        yield c


def page(name: str) -> bytes:
    return (TRUTH_PATH.parent / name).read_bytes()


def body(image: bytes, **kw) -> dict:
    return {"image_b64": base64.b64encode(image).decode("ascii"), **kw}


def decode(b64: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


def png(size=(300, 200), color=(250, 250, 250)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def padded(box, pad, size):
    x1, y1, x2, y2 = box
    return max(0, x1 - pad), max(0, y1 - pad), min(size[0], x2 + pad), min(size[1], y2 + pad)


# -- the HTTP contract ---------------------------------------------------------------------------


def test_never_imports_mlx(client):
    client.post("/regions", headers=AUTH, json=body(page("p07_student_ids.png")))
    assert not any(name == "mlx" or name.startswith(("mlx.", "mlx_vlm")) for name in sys.modules)


def test_health_names_the_model_without_a_key(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "model": "fake-from-truth", "backend": "fake", "prompts_version": "v1",
                        "concepts": ["face", "signature", "id card", "barcode"]}


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": f"Basic {KEY}"},
                                     {"Authorization": KEY}])
def test_regions_need_the_bearer_key(client, headers):
    r = client.post("/regions", headers=headers, json=body(page("p07_student_ids.png")))
    assert r.status_code == 401
    assert "regions" not in r.json()


def test_a_body_over_8_mb_is_413(client):
    big = b"x" * (8 * 1024 * 1024 + 1)
    assert client.post("/regions", headers=AUTH, content=big).status_code == 413

    def chunks():  # no Content-Length: the cap holds while reading too
        for _ in range(9):
            yield b"y" * (1024 * 1024)

    assert client.post("/regions", headers=AUTH, content=chunks()).status_code == 413


@pytest.mark.parametrize("payload", [
    b"not json",
    json.dumps({"concepts": ["face"]}).encode(),
    json.dumps({"image_b64": "@@@ secret-ish text @@@"}).encode(),
    json.dumps(body(b"a text file, not a page with Thaddeus Wrenfield on it")).encode(),
    json.dumps(body(png(), concepts=["face", "street sign"])).encode(),
    json.dumps(body(png(), concepts=[])).encode(),
    json.dumps(body(png(), pad=500)).encode(),
    json.dumps(body(png(), threshold=2)).encode(),
    json.dumps(body(png(), cover="yes")).encode(),
])
def test_bad_requests_are_400_with_fixed_text(client, payload):
    r = client.post("/regions", headers={**AUTH, "Content-Type": "application/json"}, content=payload)
    assert r.status_code == 400
    assert set(r.json()) == {"error"}
    for leak in ("secret-ish", "Wrenfield", "street sign"):
        assert leak not in r.text


@pytest.mark.parametrize("row", [r for r in TRUTH["pages"] if r["regions"]], ids=lambda r: r["file"])
def test_finds_the_page_regions_and_covers_only_them(client, row):
    original = page(row["file"])
    r = client.post("/regions", headers=AUTH, json=body(original, pad=8))
    assert r.status_code == 200
    data = r.json()
    assert (data["width"], data["height"]) == (row["width"], row["height"])
    want = sorted((g["kind"], g["box"]) for g in row["regions"])
    assert sorted((g["kind"], g["box"]) for g in data["regions"]) == want
    assert data["counts"] == {k: sum(1 for g in row["regions"] if g["kind"] == k) for k in {g["kind"] for g in row["regions"]}}
    covered = decode(data["covered_png_b64"])
    before = Image.open(io.BytesIO(original)).convert("RGB")
    expected = before.copy()
    draw = ImageDraw.Draw(expected)
    for g in row["regions"]:
        x1, y1, x2, y2 = padded(g["box"], 8, before.size)
        assert covered.crop((x1, y1, x2, y2)).getextrema() == ((0, 0), (0, 0), (0, 0))  # all ink inside
        draw.rectangle([x1, y1, x2 - 1, y2 - 1], fill=(0, 0, 0))
    assert ImageChops.difference(expected, covered).getbbox() is None  # nothing outside changed


def test_only_the_asked_concepts(client):
    r = client.post("/regions", headers=AUTH, json=body(page("p11_state_id.png"), concepts=["face"])).json()
    assert {g["kind"] for g in r["regions"]} == {"face"} and r["counts"] == {"face": 1}
    r = client.post("/regions", headers=AUTH, json=body(page("p11_state_id.png"), concepts=["id card", "barcode"])).json()
    assert r["counts"] == {"id_card": 2, "barcode": 1}
    assert {g["concept"] for g in r["regions"]} == {"id card", "barcode"}


def test_an_unknown_image_has_no_regions_and_comes_back_unchanged(client):
    original = png((320, 240), (200, 220, 240))
    r = client.post("/regions", headers=AUTH, json=body(original)).json()
    assert r["regions"] == [] and r["counts"] == {}
    assert ImageChops.difference(decode(r["covered_png_b64"]), Image.open(io.BytesIO(original)).convert("RGB")).getbbox() is None


def test_cover_false_sends_no_image(client):
    r = client.post("/regions", headers=AUTH, json=body(page("p01_field_trip.png"), cover=False)).json()
    assert "covered_png_b64" not in r and r["counts"] == {"signature": 1}


def test_the_log_never_holds_pixels(client, caplog):
    original = page("p15_clinic_intake.png")
    b64 = base64.b64encode(original).decode("ascii")
    with caplog.at_level(logging.DEBUG):
        r = client.post("/regions", headers=AUTH, json=body(original)).json()
    text = caplog.text
    assert "regions: 1 barcode, 1 face, 1 id_card, 1 signature in" in text
    for blob in (b64[:40], b64[1000:1040], r["covered_png_b64"][:40], "iVBOR"):
        assert blob not in text


def test_a_model_error_is_500_with_fixed_text(caplog):
    class Broken:
        model, backend = "broken", "fake"

        def find(self, image, concept, threshold):
            raise RuntimeError("detail about Thaddeus Wrenfield")

    with caplog.at_level(logging.DEBUG), TestClient(sam.create_app(Broken(), KEY)) as c:
        r = c.post("/regions", headers=AUTH, json=body(png()))
    assert r.status_code == 500 and r.json() == {"error": "The region model failed on that image."}
    assert "Wrenfield" not in caplog.text and "RuntimeError" in caplog.text


def test_one_image_at_a_time():
    active, peak, guard = [0], [0], threading.Lock()

    class Slow:
        model, backend = "slow", "fake"

        def find(self, image, concept, threshold):
            with guard:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            time.sleep(0.05)
            with guard:
                active[0] -= 1
            return []

    with TestClient(sam.create_app(Slow(), KEY)) as c:
        codes = []
        threads = [threading.Thread(target=lambda: codes.append(
            c.post("/regions", headers=AUTH, json=body(png(), concepts=["face"])).status_code)) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    assert codes == [200] * 4 and peak[0] == 1


def test_create_app_needs_a_key(fake):
    with pytest.raises(ValueError):
        sam.create_app(fake, "")


# -- the pieces the real predictor uses ---------------------------------------------------------


def test_regions_from_model_output_in_pixels_or_fractions():
    class Arr(list):
        def tolist(self):
            return list(self)

    boxes = Arr([[10.4, 20.6, 50.2, 60.9], [0.1, 0.2, 0.5, 0.6], [5, 5, 6, 6], [-4, -3, 900, 700], [30, 30, 30, 40]])
    scores = Arr([0.9, 0.8, 0.1, 0.5, 0.95])
    out = sam.regions_from_output(boxes, scores, "id card", 0.3, (400, 300))
    assert [(r.kind, r.concept, r.box) for r in out] == [
        ("id_card", "id card", (10, 20, 51, 61)),
        ("id_card", "id card", (40, 60, 200, 180)),
        ("id_card", "id card", (0, 0, 400, 300)),
    ]
    assert [r.score for r in out] == [0.9, 0.8, 0.5]
    assert sam.regions_from_output(None, None, "face", 0.3, (10, 10)) == []


def test_dedupe_keeps_the_best_of_overlapping_boxes():
    a = sam.Region("barcode", "barcode", 0.6, (0, 0, 100, 50))
    b = sam.Region("barcode", "barcode", 0.9, (2, 1, 101, 50))
    c = sam.Region("face", "face", 0.5, (0, 0, 100, 50))
    d = sam.Region("barcode", "barcode", 0.4, (200, 0, 300, 50))
    assert sam.dedupe([a, b, c, d]) == [b, c, d]


def test_the_mlx_predictor_needs_weights_and_imports_nothing_without_them(tmp_path):
    with pytest.raises(FileNotFoundError):
        sam.MlxSamPredictor(tmp_path / "missing")
    assert "mlx_vlm" not in sys.modules


def test_mlx_predictor_turns_each_prompt_into_regions():
    """The predict() glue, with the model replaced: two barcode prompts, one box each, deduped."""
    predictor = sam.MlxSamPredictor.__new__(sam.MlxSamPredictor)
    calls = []

    def predict(image, text_prompt):
        calls.append(text_prompt)
        return SimpleNamespace(boxes=[[10, 10, 110, 60]], scores=[0.8 if text_prompt == "barcode" else 0.7])

    predictor._predictor = SimpleNamespace(predict=predict)
    out = predictor.find(Image.new("RGB", (200, 100)), "barcode", 0.3)
    assert calls == ["barcode", "qr code"]
    assert out == [sam.Region("barcode", "barcode", 0.8, (10, 10, 110, 60))]


# -- main(): loopback only, a key file, never mlx in the tests ------------------------------------


@pytest.fixture
def key_file(tmp_path):
    path = tmp_path / "llama_api_key"
    path.write_text(KEY + "\n")
    return path


@pytest.mark.parametrize("host", ["0.0.0.0", "192.0.2.11", "::", "example.org"])
def test_main_refuses_a_host_that_is_not_loopback(monkeypatch, key_file, host, tmp_path):
    monkeypatch.setattr(sam, "MlxSamPredictor", lambda *a, **k: pytest.fail("must not load a model"))
    with pytest.raises(SystemExit) as exc:
        sam.main(["--host", host, "--model-dir", str(tmp_path), "--key-file", str(key_file)])
    assert exc.value.code != 0


def test_main_needs_a_key_file(monkeypatch, tmp_path):
    monkeypatch.setattr(sam, "MlxSamPredictor", lambda *a, **k: pytest.fail("must not load a model"))
    (tmp_path / "empty").write_text("\n")
    for path in (tmp_path / "missing", tmp_path / "empty"):
        with pytest.raises(SystemExit) as exc:
            sam.main(["--model-dir", str(tmp_path), "--key-file", str(path)])
        assert exc.value.code != 0


def test_main_serves_on_loopback_with_the_key(monkeypatch, key_file, tmp_path, fake):
    seen = {}
    monkeypatch.setitem(sys.modules, "uvicorn", SimpleNamespace(run=lambda app, **kw: seen.update(app=app, **kw)))
    monkeypatch.setattr(sam, "MlxSamPredictor", lambda model_dir, model: fake)
    assert sam.main(["--model-dir", str(tmp_path), "--key-file", str(key_file)]) == 0
    assert (seen["host"], seen["port"], seen["access_log"]) == ("127.0.0.1", 8085, False)
    with TestClient(seen["app"]) as c:
        assert c.post("/regions", headers=AUTH, json=body(png())).status_code == 200


# -- scripts/start_sam.sh -----------------------------------------------------------------------


def run_start(tmp_path, **env):
    full = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "BASE_HOME": str(tmp_path / "home"),
            "SAM_URL": "http://127.0.0.1:8085", **env}
    return subprocess.run(["bash", str(START)], env=full, capture_output=True, text=True, timeout=60)


needs_venv = pytest.mark.skipif(not (REPO / ".venv" / "bin" / "python").exists(), reason="needs the uv virtualenv")


@needs_venv
def test_start_stays_off_unless_enabled(tmp_path):
    r = run_start(tmp_path, SAM_ENABLED="0")
    assert r.returncode == 0 and "stays off" in r.stdout
    assert not (tmp_path / "home").exists()


@needs_venv
def test_start_refuses_a_sam_url_off_this_device(tmp_path):
    r = run_start(tmp_path, SAM_ENABLED="1", SAM_URL="http://192.0.2.11:8085")
    assert r.returncode != 0 and "127.0.0.1" in r.stderr


@needs_venv
def test_start_without_weights_prints_the_download_and_downloads_nothing(tmp_path):
    r = run_start(tmp_path, SAM_ENABLED="1", SAM_MODEL_DIR=str(tmp_path / "no-weights"))
    assert r.returncode != 0
    assert "Nothing was downloaded" in r.stderr and "hf download mlx-community/sam3.1-bf16" in r.stderr
    assert not (tmp_path / "home").exists() and not (tmp_path / "no-weights").exists()


@needs_venv
@pytest.mark.skipif((REPO / "sidecars" / "sam" / ".venv").exists(), reason="the sidecar environment is set up here")
def test_start_without_the_sidecar_environment_installs_nothing(tmp_path):
    weights = tmp_path / "weights"
    weights.mkdir()
    (weights / "config.json").write_text("{}")
    r = run_start(tmp_path, SAM_ENABLED="1", SAM_MODEL_DIR=str(weights))
    assert r.returncode != 0 and "Nothing was installed" in r.stderr
    assert not (REPO / "sidecars" / "sam" / ".venv").exists() and not (tmp_path / "home").exists()


def test_start_binds_loopback_and_never_fetches():
    code = "\n".join(line for line in START.read_text().splitlines() if not line.lstrip().startswith("#"))
    assert re.findall(r"--host (\S+)", code) == ["127.0.0.1"]
    assert "HF_HUB_OFFLINE=1" in code
    for line in code.splitlines():
        if re.search(r"hf download|uv sync|uv lock|pip install|curl -[^s]", line):
            assert "die " in line, line  # only ever printed for Ethan, never run
