"""base/guardian.py and the family toggle: a guardian PIN locks the settings, approvals can need it, denying never does."""

from __future__ import annotations

import json
import stat

import pytest
from fastapi.testclient import TestClient

from base import compliance
from base.guardian import COOKIE, LOCK_SECONDS, MAX_MISSES, UNLOCK_SECONDS, Guardian, GuardianError
from base.ui_app import create_app
from tests.test_ui_app import LOCAL, make_services

PIN = "invented-pin-4821"


class Clock:
    def __init__(self) -> None:
        self.now = 1_790_000_000.0

    def __call__(self) -> float:
        return self.now


# ----- the PIN itself


def test_the_pin_is_stored_hashed_and_private(tmp_path):
    g = Guardian(tmp_path)
    assert not g.is_set() and g.allows(None) and g.allows_approval(None)
    g.set(PIN, approvals=True)
    text = (tmp_path / "guardian.json").read_text()
    assert PIN not in text and json.loads(text)["hash"]
    assert stat.S_IMODE((tmp_path / "guardian.json").stat().st_mode) == 0o600
    assert g.is_set() and g.approvals_locked() and not g.allows(None) and not g.allows_approval(None)


def test_unlock_lasts_ten_minutes_and_lock_ends_it(tmp_path):
    clock = Clock()
    g = Guardian(tmp_path, clock=clock)
    g.set(PIN, approvals=False)
    assert g.unlock("wrong-pin-000") is None
    token = g.unlock(PIN)
    assert token and g.allows(token) and g.allows_approval(None)  # approvals stay open when the box is off
    clock.now += UNLOCK_SECONDS + 1
    assert not g.allows(token)
    token = g.unlock(PIN)
    g.lock(token)
    assert not g.allows(token)


def test_five_misses_lock_the_pin_for_fifteen_minutes(tmp_path):
    clock = Clock()
    g = Guardian(tmp_path, clock=clock)
    g.set(PIN, approvals=True)
    for _ in range(MAX_MISSES):
        assert g.unlock("wrong-pin-000") is None
    with pytest.raises(GuardianError):
        g.unlock(PIN)  # even the right PIN, while locked out
    clock.now += LOCK_SECONDS + 1
    assert g.unlock(PIN)


def test_changing_or_removing_the_pin_needs_an_unlocked_browser(tmp_path):
    g = Guardian(tmp_path)
    with pytest.raises(GuardianError):
        g.set("short", approvals=True)
    g.set(PIN, approvals=True)
    with pytest.raises(GuardianError):
        g.set("another-invented-pin", approvals=False)
    with pytest.raises(GuardianError):
        g.remove(None)
    token = g.unlock(PIN)
    g.set("another-invented-pin", approvals=False, token=token)
    assert not g.approvals_locked()
    g.remove(token)
    assert not g.is_set()


# ----- the pages


@pytest.fixture
def client(settings, tmp_path):
    app = create_app(make_services(settings), nights_csv=tmp_path / "none.csv")
    with TestClient(app, base_url=LOCAL, headers={"Origin": LOCAL}) as c:
        yield c


def set_pin(client, approvals=True):
    r = client.post("/api/guardian", json={"pin": PIN, "pin_again": PIN, "approvals": approvals})
    assert r.status_code == 200 and COOKIE in r.cookies
    client.post("/api/guardian/lock")
    assert COOKIE not in client.cookies


def test_with_a_pin_set_settings_stay_locked_until_the_guardian_unlocks(client):
    assert client.post("/api/auto-approve", json={"on": False}).status_code == 200  # no PIN yet
    set_pin(client)
    for path, body in (("/api/controls", {"controls": {}}), ("/api/setup", {}), ("/api/auto-approve", {"on": True}),
                       ("/api/learning", {"learning": "rules"}), ("/api/history/1/delete", {})):  # fmt: skip
        r = client.post(path, json=body)
        assert r.status_code == 403 and "guardian" in r.json()["detail"], path
    assert client.post("/api/guardian/unlock", json={"pin": "wrong-pin-000"}).status_code == 403
    assert client.post("/api/guardian/unlock", json={"pin": PIN}).json()["minutes"] == 10
    assert client.post("/api/auto-approve", json={"on": False}).status_code == 200


def test_approving_needs_the_guardian_but_denying_never_does(client):
    set_pin(client, approvals=True)
    r = client.post("/api/approvals/1", json={"approve": True})
    assert r.status_code == 403 and "approves results" in r.json()["detail"]
    assert client.post("/api/approvals/2", json={"approve": False, "remember": True}).status_code == 200
    assert "approves results on this device" in client.get("/").text
    client.post("/api/guardian/unlock", json={"pin": PIN})
    assert client.post("/api/approvals/1", json={"approve": True, "remember": True}).status_code == 200


def test_without_the_approvals_box_anyone_approves_but_not_dont_ask_again(client):
    set_pin(client, approvals=False)
    assert client.post("/api/approvals/1", json={"approve": True, "remember": True}).status_code == 403
    assert client.post("/api/approvals/1", json={"approve": True}).status_code == 200


def test_the_setup_page_shows_each_state_and_never_the_pin(client):
    assert "Set the PIN" in client.get("/setup").text
    set_pin(client)
    page = client.get("/setup").text
    assert "Unlock for 10 minutes" in page and PIN not in page
    client.post("/api/guardian/unlock", json={"pin": PIN})
    assert "Remove the PIN" in client.get("/setup").text
    assert client.post("/api/guardian", json={"remove": True}).json() == {"ok": True, "set": False}
    assert "Set the PIN" in client.get("/setup").text


def test_mismatched_pins_are_refused(client):
    r = client.post("/api/guardian", json={"pin": PIN, "pin_again": PIN + "x", "approvals": True})
    assert r.status_code == 400


# ----- the family toggle


def test_the_family_toggle_keeps_codes_and_account_numbers_and_asks_about_money():
    keep = compliance.check("Her bank account number ends in 4421.", [], ["family"])
    assert keep and keep[0] == "refuse"
    assert compliance.check("The verification code is in the email.", [], ["family"])[0] == "refuse"
    ask = compliance.check("The insurance letter says the claim was paid.", [], ["family"])
    assert ask and ask[0] == "ask_user"
    assert compliance.check("Two kids signed up for the soccer camp.", [], ["family"]) is None  # a few people is the point
    assert compliance.check("Two kids signed up for the soccer camp.", [], ["ferpa"])[0] == "refuse"
    assert "family" in compliance.FACE_TOGGLES and "13" in compliance.PROFILES["family"].limit
