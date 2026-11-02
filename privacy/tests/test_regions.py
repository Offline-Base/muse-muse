"""Covering pages before they are read (base/regions.py), with the SAM sidecar's fake backend.

The sidecar app (sidecars/sam/sam_server.py) runs in-process with FakePredictor, which answers from
eval/sam_pages/truth.json; respx stands in for a sidecar that is down. No model and no mlx is ever
started. Every page and name here is invented.
"""

from __future__ import annotations

import base64
import dataclasses
import importlib.util
import json
import os
import shutil
import stat
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from base import compliance, regions, retention
from base.config import (
    _load_settings_for_tests as load_settings,  # pre-ruling loader: LFM code load_settings now refuses
)
from base.controls import Controls, ControlStore
from base.egress import Egress
from base.regions import (
    UNCHECKED,
    ImageCheck,
    RegionClient,
    RegionError,
    covered_note,
    describe,
    note_unchecked,
    png_size,
    unchecked_images,
    unchecked_note,
)
from base.services import Services
from base.ui_app import create_app
from base.workspace.agent import short_error
from base.workspace.index import DocumentIndex
from base.workspace.scans import ScanError, ScanReader

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "sidecars" / "sam" / "sam_server.py"
PAGES = REPO / "eval" / "sam_pages"
TRUTH = json.loads((PAGES / "truth.json").read_text(encoding="utf-8"))
KEY = "test-sam-key"
SAM = "http://127.0.0.1:8085"
SIGNED = "p01_field_trip.png"  # one signature, signed by an invented Thaddeus Wrenfield
CLINIC = "p15_clinic_intake.png"  # a face, a signature, an ID card and a barcode
PLAIN = "p21_handout.png"  # nothing to cover


def load_sidecar():
    if "sam_server" in sys.modules:
        return sys.modules["sam_server"]
    spec = importlib.util.spec_from_file_location("sam_server", SERVER)
    module = importlib.util.module_from_spec(spec)
    sys.modules["sam_server"] = module
    spec.loader.exec_module(module)
    return module


sam = load_sidecar()


def truth(name: str) -> dict:
    return next(p for p in TRUTH["pages"] if p["file"] == name)


def counts_of(name: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in truth(name)["regions"]:
        out[r["kind"]] = out.get(r["kind"], 0) + 1
    return out


@pytest.fixture(scope="module")
def sidecar_app():
    return sam.create_app(sam.FakePredictor(PAGES / "truth.json"), KEY)


class Counting:
    """The sidecar's test client, counting every call."""

    def __init__(self, client):
        self.client, self.calls = client, []

    def get(self, url, **kw):
        self.calls.append(("GET", url))
        kw.pop("timeout", None)  # the test client runs in-process
        return self.client.get(url, **kw)

    def post(self, url, **kw):
        self.calls.append(("POST", url))
        return self.client.post(url, **kw)

    def close(self):
        self.client.close()


@pytest.fixture
def sidecar(sidecar_app):
    return Counting(TestClient(sidecar_app))


SHARE_POLICY = (  # a teacher who shares every tagged result, so a floor is what any hold comes from
    "name: Shares everything tagged (invented)\nnever_share:\n  iep: [\"IEP\"]\nask_first: []\nrequest_topics: {}\n"
    "rules: []\ndefault: {wants: share_tagged, on_ask: {approve: true, remember: false}}\n"
)


def sam_settings(tmp_path, **extra):
    root = tmp_path / "work"
    root.mkdir(parents=True, exist_ok=True)
    (root / ".synthetic").write_text("invented\n")
    (tmp_path / "policy.yaml").write_text(SHARE_POLICY)
    env = {
        "BASE_HOME": str(tmp_path / "home"),
        "BASE_DEVICE": "laptop",
        "USER_POLICY": str(tmp_path / "policy.yaml"),
        "WORKSPACE_ROOT": str(root),
        "DEVICE_ONLY": "1",
        "CHECKER_API_KEY": KEY,
        "SAM_ENABLED": "1",
        "LIGHT_SERIAL": "",
        **extra,
    }
    s = load_settings(env)
    s.ensure_home()
    return s


@pytest.fixture
def settings(tmp_path):
    return sam_settings(tmp_path)


@pytest.fixture
def client(settings, sidecar):
    return RegionClient(settings, client=sidecar, allow_fake=True)


def put(settings, name: str, folder: str = "forms") -> Path:
    dest = settings.workspace_root / folder / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(PAGES / name, dest)
    return dest


class Vision:
    """A local vision model that records the image it was shown."""

    is_cloud = False

    def __init__(self, text="Field trip permission form. Guardian signature: [unreadable]", fail=False):
        self.text, self.fail, self.images = text, fail, []

    def chat(self, messages, **kw):
        url = messages[1]["content"][0]["image_url"]["url"]
        self.images.append(base64.b64decode(url.split(",", 1)[1]))
        if self.fail:
            raise RuntimeError("down")
        return SimpleNamespace(content=self.text)


class NoSidecar:
    """A RegionClient stand-in that must never be called."""

    def check(self, data):
        raise AssertionError("SAM was called")


# -- settings ---------------------------------------------------------------------------------------


def test_sam_is_off_by_default_and_must_be_this_device(tmp_path):
    s = load_settings({"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(tmp_path)})
    assert s.sam_enabled is False and s.sam_url == "http://127.0.0.1:8085"
    assert s.paths.regions == s.home / "regions"
    on = load_settings({"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(tmp_path), "SAM_ENABLED": "1", "SAM_URL": "http://localhost:9085/"})
    assert on.sam_enabled and on.sam_url == "http://localhost:9085"
    with pytest.raises(ValueError, match="SAM_URL must be this device"):
        load_settings({"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(tmp_path), "SAM_URL": "http://192.0.2.11:8085"})


def test_the_client_refuses_another_machine_and_ignores_proxies(settings):
    with pytest.raises(ValueError, match="this device"):
        RegionClient(dataclasses.replace(settings, sam_url="http://192.0.2.11:8085"))
    real = RegionClient(settings)
    try:
        assert real.client._trust_env is False and real.url == SAM
    finally:
        real.close()


def test_services_wire_the_client_only_with_sam_enabled(tmp_path):
    on = Services.create(sam_settings(tmp_path / "a"), light=False, heavy=False, owner=False)
    off = Services.create(sam_settings(tmp_path / "b", SAM_ENABLED="0"), light=False, heavy=False, owner=False)
    try:
        assert isinstance(on.regions, RegionClient) and on.scans.regions is on.regions
        assert on.scans.controls is on.controls
        assert off.regions is None and off.scans.regions is None
    finally:
        on.close()
        off.close()


# -- the client -------------------------------------------------------------------------------------


def test_a_check_counts_kinds_keeps_boxes_and_a_covered_copy(settings, client):
    data = (PAGES / CLINIC).read_bytes()
    found = client.check(data)
    page = truth(CLINIC)
    assert found.counts == counts_of(CLINIC) and found.counts["face"] == 1
    assert sorted(b for _k, b in found.boxes) == sorted(tuple(r["box"]) for r in page["regions"])
    assert png_size(found.covered) == (page["width"], page["height"]) and found.covered != data
    assert found.model == "fake-from-truth" and found.prompts_version == "v1"
    folder = settings.paths.regions
    assert sorted(p.name for p in folder.iterdir()) == sorted([f"{found.sha}.json", f"{found.sha}.png"])
    assert stat.S_IMODE(folder.stat().st_mode) == 0o700
    assert all(stat.S_IMODE(p.stat().st_mode) == 0o600 for p in folder.iterdir())
    record = json.loads((folder / f"{found.sha}.json").read_text())
    assert set(record) == {"version", "counts", "boxes", "model", "prompts_version", "pad"}  # no pixels
    assert (folder / f"{found.sha}.png").read_bytes() == found.covered  # the covered copy, never the original
    assert not any(p.read_bytes() == data for p in folder.iterdir())


def test_a_cached_image_makes_no_sidecar_call(client, sidecar):
    data = (PAGES / SIGNED).read_bytes()
    first = client.check(data)
    calls = len(sidecar.calls)
    again = client.check(data)
    assert len(sidecar.calls) == calls and again.counts == first.counts == {"signature": 1}
    assert again.covered == first.covered


def test_a_broken_cache_file_means_a_new_check(settings, client, sidecar):
    data = (PAGES / SIGNED).read_bytes()
    found = client.check(data)
    (settings.paths.regions / f"{found.sha}.json").write_text('{"version": 1, "counts": {"face": "x"}}')
    calls = len(sidecar.calls)
    assert client.check(data).counts == {"signature": 1} and len(sidecar.calls) > calls
    (settings.paths.regions / f"{found.sha}.png").write_bytes(b"not a png")
    assert client.check(data).covered == found.covered


def test_a_page_with_nothing_on_it_is_checked_too(client):
    found = client.check((PAGES / PLAIN).read_bytes())
    assert found.counts == {} and found.boxes == ()
    assert covered_note(found.counts) == "Checked on this device before reading: no faces, signatures, ID cards or barcodes found."


def test_the_fake_test_model_is_no_checker(settings, sidecar):
    with pytest.raises(RegionError):
        RegionClient(settings, client=sidecar).check((PAGES / SIGNED).read_bytes())
    assert not settings.paths.regions.exists() or not any(settings.paths.regions.iterdir())
    assert [m for m, _u in sidecar.calls] == ["GET"]  # the image itself was never sent


def test_no_key_means_no_check(tmp_path, sidecar):
    s = sam_settings(tmp_path, CHECKER_API_KEY="")
    s = dataclasses.replace(s, checker_api_key=None)
    with pytest.raises(RegionError):
        RegionClient(s, client=sidecar, allow_fake=True).check((PAGES / SIGNED).read_bytes())
    assert sidecar.calls == []


@respx.mock
def test_a_sidecar_that_is_down_fails_closed_and_is_not_waited_on_again(settings):
    now = [1000.0]
    health = respx.get(f"{SAM}/health").mock(side_effect=httpx.ConnectError("refused"))
    post = respx.post(f"{SAM}/regions").mock(return_value=httpx.Response(500))
    c = RegionClient(settings, clock=lambda: now[0])
    with pytest.raises(RegionError, match="could not check that image"):
        c.check(b"\x89PNG not really")
    assert health.call_count == 1 and post.call_count == 0
    with pytest.raises(RegionError):
        c.check(b"\x89PNG another")
    assert health.call_count == 1  # fails at once for RETRY_SECONDS instead of waiting again
    now[0] += regions.RETRY_SECONDS + 1
    with pytest.raises(RegionError):
        c.check(b"\x89PNG later")
    assert health.call_count == 2
    assert not c.available()


def good_reply(**changes):
    covered = (PAGES / PLAIN).read_bytes()  # a real PNG of the right size stands in for a covered copy
    body = {"width": 850, "height": 1100, "model": "mlx-community/sam3.1-bf16", "prompts_version": "v1",
            "regions": [{"kind": "signature", "concept": "signature", "score": 0.9, "box": [10, 10, 200, 60]}],
            "counts": {"signature": 1}, "pad": 8, "covered_png_b64": base64.b64encode(covered).decode(), "ms": 5}
    body.update(changes)
    return body


@respx.mock
def test_a_bad_reply_fails_that_image_only(settings):
    respx.get(f"{SAM}/health").mock(return_value=httpx.Response(200, json={"ok": True, "backend": "mlx", "model": "m"}))
    post = respx.post(f"{SAM}/regions").mock(side_effect=[httpx.Response(500, json={"error": "x"}), httpx.Response(200, json=good_reply())])
    c = RegionClient(settings)
    with pytest.raises(RegionError):
        c.check(b"\x89PNG first")
    assert c.check(b"\x89PNG second").counts == {"signature": 1} and post.call_count == 2


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(401, json={"error": "A valid bearer key is required."}),
        httpx.Response(500, json={"error": "The region model failed on that image."}),
        httpx.Response(200, text="not json"),
        httpx.Response(200, json=good_reply(covered_png_b64=base64.b64encode(b"GIF89a....").decode())),
        httpx.Response(200, json=good_reply(width=600)),  # the covered copy is not the page's size
        httpx.Response(200, json=good_reply(regions=[{"kind": "tattoo", "box": [0, 0, 5, 5]}])),
        httpx.Response(200, json=good_reply(regions=[{"kind": "face", "box": [0, 0, 5000, 5]}])),
        httpx.Response(200, json={k: v for k, v in good_reply().items() if k != "covered_png_b64"}),
    ],
)
@respx.mock
def test_a_bad_reply_fails_closed_and_stores_nothing(settings, response):
    respx.get(f"{SAM}/health").mock(return_value=httpx.Response(200, json={"ok": True, "backend": "mlx", "model": "m"}))
    post = respx.post(f"{SAM}/regions").mock(return_value=response)
    with pytest.raises(RegionError, match="could not check that image"):
        RegionClient(settings).check(b"\x89PNG page")
    assert post.call_count == 1
    assert not settings.paths.regions.exists() or not any(settings.paths.regions.iterdir())


@respx.mock
def test_the_request_carries_the_key_and_counts_come_from_the_regions(settings):
    respx.get(f"{SAM}/health").mock(return_value=httpx.Response(200, json={"ok": True, "backend": "mlx", "model": "m"}))
    post = respx.post(f"{SAM}/regions").mock(return_value=httpx.Response(200, json=good_reply(counts={"face": 9})))
    found = RegionClient(settings).check(b"\x89PNG page")
    sent = post.calls[0].request
    assert sent.headers["authorization"] == f"Bearer {KEY}"
    body = json.loads(sent.content)
    assert body["concepts"] == ["face", "signature", "id card", "barcode"] and body["cover"] is True and body["pad"] == 8
    assert found.counts == {"signature": 1}  # the reply's own counts are not trusted


def test_words_for_counts_have_no_dashes():
    assert describe({"signature": 2, "face": 1}) == "1 photo of a person and 2 signatures"
    assert describe({"barcode": 1, "id_card": 2, "face": 3}) == "3 photos of people, 2 ID cards and 1 barcode"
    assert describe({}) == "" and describe({"face": 0}) == ""
    assert covered_note({"signature": 1}) == "Covered on this device before reading: 1 signature."
    assert unchecked_note(1).startswith("1 image was not read") and unchecked_note(3).startswith("3 images were not read")
    for text in (covered_note({"face": 2}), unchecked_note(2), UNCHECKED, compliance.FACE_REASON, compliance.SIGNATURE_REASON):
        assert "—" not in text and "–" not in text


# -- the scan reader --------------------------------------------------------------------------------


def test_the_model_reads_only_the_covered_copy(settings, client):
    path = put(settings, SIGNED)
    vision = Vision()
    text = ScanReader(settings, vision, regions=client, controls=ControlStore(settings.paths.controls)).text(path)
    [shown] = vision.images
    found = client.check(path.read_bytes())
    assert shown == found.covered and shown != path.read_bytes()
    assert text.endswith("Covered on this device before reading: 1 signature.")
    names = sorted(p.name for p in settings.paths.scans.iterdir())
    assert names == [f"{found.sha}.covered-v1.txt"]


def test_an_old_reading_of_the_uncovered_page_is_never_reused(settings, client):
    path = put(settings, SIGNED)
    sha = __import__("hashlib").sha256(path.read_bytes()).hexdigest()
    settings.paths.scans.mkdir(parents=True, exist_ok=True)
    (settings.paths.scans / f"{sha}.txt").write_text("Signed: Thaddeus Wrenfield")  # read before SAM was on
    text = ScanReader(settings, Vision(), regions=client).text(path)
    assert "Wrenfield" not in text and "Covered on this device" in text


def test_a_cached_covered_reading_calls_neither_model(settings, client, sidecar):
    path = put(settings, SIGNED)
    vision = Vision()
    reader = ScanReader(settings, vision, regions=client)
    first = reader.text(path)
    calls = len(sidecar.calls)
    assert reader.text(path) == first and len(vision.images) == 1 and len(sidecar.calls) == calls


def test_a_covered_reading_keeps_its_check_on_record(settings, client, sidecar):
    path = put(settings, SIGNED)
    vision = Vision()
    reader = ScanReader(settings, vision, regions=client)
    first = reader.text(path)
    for p in settings.paths.regions.iterdir():
        p.unlink()  # retention took the check but not yet the text
    assert reader.text(path) == first and len(vision.images) == 1  # the text is reused
    assert regions.image_check(settings, [f"forms/{SIGNED}"]) == ImageCheck({"signature": 1}, 1, 0)


@respx.mock
def test_sidecar_down_means_the_image_is_not_read(settings):
    respx.get(f"{SAM}/health").mock(side_effect=httpx.ConnectError("refused"))
    path = put(settings, SIGNED)
    vision = Vision()
    reader = ScanReader(settings, vision, regions=RegionClient(settings))
    with unchecked_images() as unread:
        with pytest.raises(ScanError) as caught:
            reader.text(path)
    assert str(caught.value) == UNCHECKED and unread == {str(path)}
    assert vision.images == []  # the vision model never saw the page
    assert not settings.paths.scans.exists() or not any(settings.paths.scans.iterdir())
    note_unchecked(path)  # outside a block it is a no-op


@pytest.mark.parametrize("toggle", ["cui", "cjis", "export"])
def test_sam_is_never_called_under_the_local_only_toggles(settings, toggle):
    path = put(settings, SIGNED)
    store = ControlStore(settings.paths.controls)
    store.save(Controls(profiles=[toggle]))
    vision = Vision()
    ScanReader(settings, vision, regions=NoSidecar(), controls=store).text(path)
    assert vision.images == [path.read_bytes()]  # read as it is: nothing read under these toggles can leave


def test_a_broken_controls_file_keeps_sam_out_too(settings):
    path = put(settings, SIGNED)
    settings.paths.controls.write_text("{broken")
    vision = Vision()
    ScanReader(settings, vision, regions=NoSidecar(), controls=ControlStore(settings.paths.controls)).text(path)
    assert vision.images == [path.read_bytes()]


def test_without_sam_the_reader_is_unchanged(settings):
    path = put(settings, SIGNED)
    vision = Vision()
    assert ScanReader(settings, vision).text(path) == vision.text
    assert vision.images == [path.read_bytes()]


def test_a_failed_task_says_why_in_fixed_words():
    assert short_error(ScanError(UNCHECKED)) == UNCHECKED


# -- the index: an unchecked image is nowhere -------------------------------------------------------


@respx.mock
def test_with_the_sidecar_down_the_image_is_absent_from_search_and_passages(settings):
    respx.get(f"{SAM}/health").mock(side_effect=httpx.ConnectError("refused"))
    put(settings, SIGNED)
    (settings.workspace_root / "forms" / "notes.md").write_text("# Notes\nThe field trip permission forms are due Friday.\n")
    vision = Vision("Field trip permission form signed by Thaddeus Wrenfield")
    store = ControlStore(settings.paths.controls)
    store.save(Controls(profiles=["ferpa"]))
    index = DocumentIndex(settings, scans=ScanReader(settings, vision, regions=RegionClient(settings), controls=store))
    with unchecked_images() as unread:
        hits = index.search("field trip permission form")
        pieces = index.passages(["field trip permission form signed"])
    assert [h.doc_id for h in hits] == ["forms/notes.md"] and [p.doc_id for p in pieces] == ["forms/notes.md"]
    assert unread and vision.images == []
    assert "forms/p01_field_trip.png" in [d.id for d in index.list("forms")]  # listed by file name only
    with pytest.raises(ScanError, match="could not check that image"):
        index.read(f"forms/{SIGNED}")


# -- egress: receipts and floors --------------------------------------------------------------------


class _Llm:
    is_cloud = False

    def __init__(self, decision="share_tagged"):
        self.decision = decision

    def chat_json(self, *_a, **_k):
        return {"decision": self.decision, "reason": "because"}

    def chat(self, *_a, **_k):
        return SimpleNamespace(content="The class improved overall.")

    def llm_names(self, *_a, **_k):
        return []

    def llm_details(self, *_a, **_k):
        return []

    def request_topics(self, *_a, **_k):
        return []


@pytest.fixture
def svc(settings):
    s = Services.create(settings, light=False, heavy=False, owner=False)
    s.router.llm = s.checker_llm = s.answer_llm = _Llm()
    yield s
    s.close()


def checked(settings, client, name) -> str:
    """Put an invented page in the workspace and check it with the fake sidecar; its doc id."""
    path = put(settings, name)
    client.check(path.read_bytes())
    return f"forms/{name}"


def toggles(settings, *profiles):
    ControlStore(settings.paths.controls).save(Controls(profiles=list(profiles)))


def receipt_of(svc) -> dict:
    [row] = svc.approvals.history(limit=5)
    return json.loads(row["receipt"])


def test_the_receipt_counts_what_was_covered_and_nothing_else(settings, client, svc):
    doc = checked(settings, client, CLINIC)
    out = Egress(svc).release("search_documents", "intake forms for my records", "Intake form. Visit reason: checkup.", "snippet", sources=[doc])
    assert out.status == "shared"
    r = receipt_of(svc)
    assert r["image_regions"] == counts_of(CLINIC) and r["images_unchecked"] == 0
    assert r["checks"][:2] == ["tagging", "image check"]
    flat = json.dumps(r)
    assert "box" not in flat and "png" not in flat.lower() and CLINIC not in flat  # counts only


def test_a_result_with_no_image_source_has_no_image_fields(settings, svc):
    Egress(svc).release("search_documents", "notes for my records", "Plain notes about tide pools.", "snippet", sources=["notes.md"])
    r = receipt_of(svc)
    assert "image_regions" not in r and "image check" not in r["checks"]


@pytest.mark.parametrize("toggle", ["hipaa", "coppa"])
def test_a_page_with_a_face_asks_first_under_hipaa_and_coppa(settings, client, svc, toggle):
    doc = checked(settings, client, CLINIC)
    toggles(settings, toggle)
    out = Egress(svc).release("search_documents", "intake forms for my records", "Intake form. Visit reason: checkup.", "snippet", sources=[doc])
    assert out.status == "waiting" and "compliance:face" in out.decision.floors
    assert out.decision.reason == compliance.FACE_REASON


def test_ferpa_alone_asks_about_a_scan_but_not_for_the_face(settings, client, svc):
    doc = checked(settings, client, CLINIC)
    toggles(settings, "ferpa")
    out = Egress(svc).release("search_documents", "intake forms for my records", "Intake form. Visit reason: checkup.", "snippet", sources=[doc])
    assert out.status == "waiting" and out.decision.floors[-1] == "compliance:scan"


@pytest.mark.parametrize("toggle", ["hipaa", "legal", "hr"])
def test_a_signed_page_asks_first_under_hipaa_legal_and_hr(settings, client, svc, toggle):
    doc = checked(settings, client, SIGNED)
    toggles(settings, toggle)
    out = Egress(svc).release("search_documents", "trip forms for my records", "Field trip permission form for the aquarium.", "snippet", sources=[doc])
    assert out.status == "waiting" and out.decision.floors[-1] == "compliance:signature"
    assert out.decision.reason == compliance.SIGNATURE_REASON


def test_an_image_nobody_checked_is_kept_while_sam_is_on(settings, svc):
    put(settings, SIGNED)  # in the workspace, never checked
    out = Egress(svc).release("search_documents", "trip forms for my records", "Field trip permission form.", "snippet", sources=[f"forms/{SIGNED}"])
    assert out.status == "refused" and out.text.startswith("Kept on your device. It came from an image the device has not checked")
    assert "regions:unchecked" in out.decision.floors
    assert receipt_of(svc)["images_unchecked"] == 1


def test_a_changed_or_missing_image_counts_as_unchecked(settings, client, svc):
    doc = checked(settings, client, SIGNED)
    (settings.workspace_root / doc).write_bytes((PAGES / PLAIN).read_bytes())  # replaced after its check
    check = regions.image_check(settings, [doc, "forms/gone.png", "notes.md"])
    assert check == ImageCheck({}, 0, 2)
    assert regions.image_check(settings, ["notes.md", "forms"]) is None


def test_without_sam_an_unchecked_image_keeps_todays_behavior(tmp_path):
    s = Services.create(sam_settings(tmp_path, SAM_ENABLED="0"), light=False, heavy=False, owner=False)
    try:
        s.router.llm = s.checker_llm = s.answer_llm = _Llm()
        put(s.settings, SIGNED)
        out = Egress(s).release("search_documents", "trip forms for my records", "Field trip permission form.", "snippet", sources=[f"forms/{SIGNED}"])
        assert out.status == "shared" and "regions:unchecked" not in out.decision.floors
        r = receipt_of(s)
        assert "image_regions" not in r and "images_unchecked" not in r and "image check" not in r["checks"]
    finally:
        s.close()


def test_a_local_only_toggle_keeps_its_own_reason(settings, svc):
    put(settings, SIGNED)
    toggles(settings, "cui")
    out = Egress(svc).release("search_documents", "trip forms for my records", "Field trip permission form.", "snippet", sources=[f"forms/{SIGNED}"])
    assert out.status == "refused" and "A privacy toggle keeps everything on this device." in out.text


def test_a_document_list_is_not_an_image_result(settings, svc):
    put(settings, SIGNED)
    out = Egress(svc).release("list_documents", "list forms", f"1 documents in folder forms:\n- p01 field trip (forms/{SIGNED})", "document_list", sources=[f"forms/{SIGNED}"])
    assert out.status == "shared" and "regions:unchecked" not in out.decision.floors


# -- tasks: the pages a job read are its sources ------------------------------------------------------


class _Answers(_Llm):
    def chat_json(self, *_a, **_k):
        return {"answer": "Intake form: the visit reason is a checkup."}


def run_task(svc, regions_client) -> str:
    """A run_private_task job over forms/, read by the device's scan reader; its job id."""
    svc.scans.regions = svc.regions = regions_client
    svc.scans.llm = Vision("Intake form. Visit reason: checkup.")
    svc.agent.llm = _Answers()
    job_id = svc.agent.run_sync("Summarize the intake forms for my records", "forms")
    assert svc.jobs.get(job_id)["status"] == "done"
    return job_id


def released(svc, job_id) -> tuple[str, dict]:
    from base.connector.server import Connector

    body = Connector(svc).get_result(job_id)[0].structured_content
    [row] = svc.approvals.history(limit=5)
    return body["status"], json.loads(row["receipt"])


def test_a_task_over_a_page_with_a_face_asks_first_under_hipaa(settings, client, svc):
    put(settings, CLINIC)
    toggles(settings, "hipaa")
    job_id = run_task(svc, client)
    assert svc.jobs.get(job_id)["sources"] == [f"forms/{CLINIC}"]  # the page, not the folder name
    status, receipt = released(svc, job_id)
    assert status == "waiting" and receipt["floors"][-1] == "compliance:face"
    assert receipt["image_regions"] == counts_of(CLINIC) and "image check" in receipt["checks"]


def test_a_task_whose_page_lost_its_check_is_kept(settings, client, svc):
    put(settings, SIGNED)
    job_id = run_task(svc, client)
    for p in settings.paths.regions.iterdir():  # retention removed the check before Muse asked
        p.unlink()
    status, receipt = released(svc, job_id)
    assert status == "refused" and "regions:unchecked" in receipt["floors"] and receipt["images_unchecked"] == 1


def test_a_task_read_under_cui_stays_kept_after_cui_is_turned_off(settings, client, svc):
    path = put(settings, SIGNED)
    client.check(path.read_bytes())  # checked once before, so a record is on file
    toggles(settings, "cui")
    job_id = run_task(svc, NoSidecar())  # under cui SAM is never called: the page is read uncovered
    assert svc.jobs.get(job_id)["sources"] == [f"{regions.UNCOVERED}forms/{SIGNED}"]
    toggles(settings)  # cui off before Muse asks for the result
    status, receipt = released(svc, job_id)
    assert status == "refused" and "regions:unchecked" in receipt["floors"]


def test_mark_uncovered_marks_images_once_and_leaves_the_rest():
    once = regions.mark_uncovered(["forms/a.png", "notes.md", "b.JPG"])
    assert once == ["uncovered:forms/a.png", "notes.md", "uncovered:b.JPG"] and regions.mark_uncovered(once) == once
    assert regions.reads_uncovered(SimpleNamespace(scans=None)) is False and regions.reads_uncovered(None) is False


def test_compliance_check_order_strictest_wins():
    face = {"face": 1, "signature": 1}
    assert compliance.check("Notes.", ["a.png"], ["hipaa"], image_kinds=face)[1] == "compliance:face"
    assert compliance.check("Notes.", ["a.png"], ["hr"], image_kinds=face)[1] == "compliance:signature"
    assert compliance.check("Notes.", ["a.png"], ["ferpa"], image_kinds=face)[1] == "compliance:scan"
    assert compliance.check("Notes.", ["a.png"], [], image_kinds=face) is None  # no toggle, no floor
    assert compliance.check("Three students missed it.", ["a.png"], ["hipaa"], image_kinds=face)[0] == "refuse"
    assert compliance.check("Notes.", ["a.png"], ["hipaa", "cui"], image_kinds=face)[1] == "compliance:local_only"
    assert compliance.check("Notes.", ["a.png"], ["hipaa"], image_kinds={"barcode": 2})[1] == "compliance:scan"


# -- retention --------------------------------------------------------------------------------------


def test_retention_removes_old_image_checks(settings, client, svc):
    old = client.check((PAGES / SIGNED).read_bytes())
    new = client.check((PAGES / PLAIN).read_bytes())
    long_ago = time.time() - 200 * 86400
    for suffix in (".json", ".png"):
        os.utime(settings.paths.regions / f"{old.sha}{suffix}", (long_ago, long_ago))
    counts = retention.purge(svc, 90)
    left = sorted(p.name for p in settings.paths.regions.iterdir())
    assert counts["files"] >= 2 and left == sorted([f"{new.sha}.json", f"{new.sha}.png"])


@respx.mock
async def test_a_search_with_the_sidecar_down_never_carries_the_page(settings, svc):
    from mcp import Client

    from base.connector.server import build_server

    respx.get(f"{SAM}/health").mock(side_effect=httpx.ConnectError("refused"))
    put(settings, SIGNED)
    (settings.workspace_root / "forms" / "notes.md").write_text("# Notes\nThe field trip permission forms are due Friday.\n")
    toggles(settings, "ferpa")
    vision = Vision("Field trip permission form signed by Thaddeus Wrenfield")
    svc.scans.llm = vision
    svc.rag = None  # keyword search, so no model writes queries
    async with Client(build_server(svc)) as c:
        result = await c.call_tool("search_documents", {"query": "field trip permission form", "purpose": "for my own records"})
    text = result.content[0].text
    assert vision.images == [] and "Wrenfield" not in text and "permission forms are due Friday" in text
    assert text.rstrip().endswith(unchecked_note(1))
    [row] = svc.approvals.history(limit=5)
    assert json.loads(row["sources"]) == ["forms/notes.md"] and "image_regions" not in json.loads(row["receipt"])


class ReadsWhatItSees(Vision):
    """Reads the signer's name only off the uncovered page, like a vision model would."""

    def __init__(self, original: bytes):
        super().__init__()
        self.original = original

    def chat(self, messages, **kw):
        super().chat(messages, **kw)
        signed = self.images[-1] == self.original
        return SimpleNamespace(content="Field trip permission form. Guardian signature: " + ("Thaddeus Wrenfield" if signed else "[unreadable]"))


async def test_a_search_with_the_sidecar_up_reads_and_reports_the_covered_page(settings, client, svc):
    from mcp import Client

    from base.connector.server import build_server

    path = put(settings, SIGNED)
    svc.scans.regions = svc.regions = client
    svc.scans.llm = vision = ReadsWhatItSees(path.read_bytes())
    svc.rag = None
    async with Client(build_server(svc)) as c:
        result = await c.call_tool("search_documents", {"query": "field trip permission form guardian signature", "purpose": "for my own records"})
    text = result.content[0].text
    assert len(vision.images) == 1 and vision.images[0] != path.read_bytes()
    assert "Wrenfield" not in text and "Covered on this device before reading: 1 signature." in text
    [row] = svc.approvals.history(limit=5)
    receipt = json.loads(row["receipt"])
    assert receipt["image_regions"] == {"signature": 1} and "image check" in receipt["checks"]


# -- the approval page ------------------------------------------------------------------------------

LOCAL = "http://127.0.0.1:8787"
LAN = "http://base-jetson.test:8787"


def waiting_on(settings, client, svc, name=SIGNED) -> int:
    """A decision waiting for the user, from a checked page under HIPAA; its id."""
    doc = checked(settings, client, name)
    toggles(settings, "hipaa")
    out = Egress(svc).release("search_documents", "trip forms for my records", "Field trip permission form.", "snippet", sources=[doc])
    assert out.status == "waiting"
    return out.approval_id


def page_client(svc):
    (svc.settings.home / "setup.json").write_text('{"chosen": true}\n')  # past the first-visit setup page
    return TestClient(create_app(svc, nights_csv=svc.settings.home / "none.csv"), base_url=LOCAL, headers={"Origin": LOCAL})


def test_the_card_shows_the_covered_page_and_the_route_serves_only_that(settings, client, svc):
    rid = waiting_on(settings, client, svc)
    covered = client.check((PAGES / SIGNED).read_bytes()).covered
    with page_client(svc) as c:
        body = c.get("/").text
        assert f'<img src="/scan-preview/{rid}/0"' in body and "Muse gets text only, never the image" in body
        r = c.get(f"/scan-preview/{rid}/0")
        assert r.status_code == 200 and r.headers["content-type"] == "image/png"
        assert r.content == covered and r.content != (PAGES / SIGNED).read_bytes()
        for bad in (f"/scan-preview/{rid}/1", f"/scan-preview/{rid}/x", "/scan-preview/999/0", f"/scan-preview/{rid}/-1"):
            assert c.get(bad).status_code == 404, bad
        svc.approvals.delete(rid)
        assert c.get(f"/scan-preview/{rid}/0").status_code == 404


def test_no_covered_copy_means_no_thumbnail_and_no_page(settings, svc):
    put(settings, SIGNED)  # never checked: there is no covered copy to show
    row_id = svc.approvals.create_pending(tool="search_documents", request="trip forms", result_kind="snippet",
                                          tagged_text="Field trip permission form.", router_decision="ask_user",
                                          sources=[f"forms/{SIGNED}"])
    with page_client(svc) as c:
        body = c.get("/").text
        assert f'id="approval-{row_id}"' in body and "/scan-preview/" not in body
        assert c.get(f"/scan-preview/{row_id}/0").status_code == 404


def test_the_preview_needs_a_session_off_this_device(settings, client, svc):
    rid = waiting_on(settings, client, svc)
    svc.settings = dataclasses.replace(settings, device="jetson", approval_host="0.0.0.0", heavy_queue=False)
    app = create_app(svc, nights_csv=settings.home / "none.csv")
    with TestClient(app, base_url=LAN, follow_redirects=False) as c:
        r = c.get(f"/scan-preview/{rid}/0")
        assert r.status_code in (303, 401) and r.headers.get("content-type") != "image/png"


def test_history_and_the_audit_export_show_counts_only(settings, client, svc):
    waiting_on(settings, client, svc, CLINIC)
    with page_client(svc) as c:
        history = c.get("/history").text
        assert "Image check" in history and "Covered before reading: 1 photo of a person, 1 signature, 1 ID card and 1 barcode" in history
        csv_text = c.get("/api/audit.csv").text
    header, row = csv_text.splitlines()[:2]
    assert header.endswith(",image_regions") and row.endswith("barcode=1;face=1;id_card=1;signature=1")
    assert "trip forms" not in csv_text and CLINIC not in csv_text and "Field trip" not in csv_text


@respx.mock
def test_the_controls_page_says_when_images_are_left_out(settings, sidecar, svc):
    respx.get(f"{SAM}/health").mock(side_effect=httpx.ConnectError("refused"))
    svc.regions = RegionClient(settings)
    with page_client(svc) as c:
        assert "Images are not being read right now" in c.get("/controls").text
    svc.regions = RegionClient(settings, client=sidecar, allow_fake=True)
    with page_client(svc) as c:
        assert "Images are not being read" not in c.get("/controls").text


# -- scripts/start.sh -------------------------------------------------------------------------------


def test_start_runs_sam_only_when_enabled_and_never_lets_it_stop_the_app():
    code = "\n".join(line for line in (REPO / "scripts" / "start.sh").read_text().splitlines() if not line.lstrip().startswith("#"))
    assert '"SAM": "1" if s.sam_enabled else "0"' in code
    block = code[code.index('if [ "$SAM" = 1 ]; then') :]
    block = block.split("\nfi", 1)[0]
    assert "start_sam.sh" in block
    # kept running by scripts/supervise.sh, never required, so its exit never stops the app
    assert 'keep_running "the region finder (SAM 3.1)"' in block
    assert "require" not in block and "watch_required" in code
    assert 'wait_up "http://127.0.0.1:$SAM_PORT/health" 180' in code
