"""The How it works diagram: one markup builder, one script and one stylesheet for both pages."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from base.config import REPO_ROOT, load_settings
from base.controls import Controls, ControlStore
from base.flow import NODES, SITE_FACTS, STORIES, flow_html
from base.services import Services
from base.ui_app import create_app

STATIC = REPO_ROOT / "ui" / "static"
SITE = REPO_ROOT / "site"
PAGE = "http://127.0.0.1:8787"


def test_the_site_uses_the_same_script_stylesheet_and_markup():
    assert (SITE / "flow.js").read_text() == (STATIC / "flow.js").read_text()
    assert (SITE / "flow.css").read_text() == (STATIC / "flow.css").read_text()
    assert flow_html(SITE_FACTS) in (SITE / "index.html").read_text()


def test_the_script_knows_every_box_and_story_and_fetches_nothing():
    js = (STATIC / "flow.js").read_text()
    for key, _name in NODES:
        assert f'"{key}"' in js, key
    for key, _label in STORIES:
        assert re.search(rf"\b{key}: \[", js), key
    assert not re.search(r"https?://|fetch\(|XMLHttpRequest|WebSocket\(|EventSource", js)
    for name in ("flow.js", "flow.css"):
        assert "—" not in (STATIC / name).read_text()


def test_the_markup_escapes_and_links():
    html = flow_html({"files": "<b>x</b>"}, links={"approvals": "/"}, live=True, light="waiting", muse_off=True)
    assert "&lt;b&gt;" in html and "<b>" not in html
    assert '<a class="flow-node" data-node="approvals" href="/">' in html
    assert 'class="flow-node dim" data-node="muse"' in html and 'data-light="waiting"' in html
    assert html.count('class="flow-tab" data-story=') == len(STORIES)


def test_the_page_script_tells_the_diagram_about_the_light():
    assert 'dispatchEvent(new CustomEvent("muse:light"' in (STATIC / "app.js").read_text()


@pytest.fixture
def client(tmp_path):
    root = tmp_path / "w"
    (root / "essays").mkdir(parents=True)
    (root / "essays" / "a.md").write_text("# A\nInvented.")
    env = {"BASE_HOME": str(tmp_path / "home"), "WORKSPACE_ROOT": str(root), "DEVICE_ONLY": "1", "CHECKER_API_KEY": "k"}
    svc = Services.create(load_settings(env), light=False, heavy=False, owner=False)
    yield TestClient(create_app(svc), base_url=PAGE, headers={"Origin": PAGE}), svc
    svc.close()


def test_the_page_shows_this_devices_settings(client):
    c, svc = client
    page = c.get("/how").text
    assert 'href="/how"' in page and "How it works" in page and "/static/flow.js" in page
    assert "1 file Muse can see" in page and "LFM3-VL-2B on this device, no fallback" in page
    assert "Rules in code. Toggles: none." in page and "Nothing waiting" in page and "Not linked yet" in page
    assert 'data-live="1"' in page and 'class="flow-node dim"' not in page
    svc.approvals.create_pending(tool="t", request="r", result_kind="snippet", tagged_text="x", router_decision="ask_user")
    ControlStore(svc.settings.paths.controls).save(Controls(profiles=["ferpa", "hipaa"]))
    page = c.get("/how").text
    assert "1 waiting for you" in page and "Toggles: FERPA, HIPAA." in page and "plus places, dates and more" in page


def test_a_government_toggle_shows_muse_switched_off(client):
    c, svc = client
    ControlStore(svc.settings.paths.controls).save(Controls(profiles=["cui"]))
    page = c.get("/how").text
    assert 'class="flow-node dim" data-node="muse"' in page and "Off. Your toggles keep everything" in page


def test_no_file_names_reach_the_page(client):
    c, _svc = client
    assert "a.md" not in c.get("/how").text


def test_the_asset_version_covers_the_diagram_files():
    from base import ui_app

    assert "flow.js" in Path(ui_app.__file__).read_text().split("def _asset_version", 1)[1].split("return", 1)[0]
