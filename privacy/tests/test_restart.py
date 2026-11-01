"""What a restart must not lose: a search or ask job released after the device restarts keeps the
documents it came from, so the user's controls and toggles apply to it as they would have before.

Real Services in DEVICE_ONLY mode on a temp BASE_HOME. "A restart" closes them and builds new
Services and a new Connector on the same home, as `python -m base` does. The models and the index
are in-process fakes, so nothing is sent anywhere. All names are from the invented roster.
"""

from __future__ import annotations

import json

import pytest

from base.config import load_settings
from base.connector.server import Connector
from base.controls import Controls, ControlStore
from base.egress import HELD_TEXT, Released
from base.services import Services
from base.workspace.ask import AskResult, AskRunner
from base.workspace.index import Snippet
from base.workspace.jobs import JobStore

NAME = "Abigail Thornbury"  # on the invented roster
QUERY = "Find essay excerpts about bees."  # the policy shares excerpts (tests/test_device_only.py)


def settings_for(tmp_path):
    root = tmp_path / "w"
    root.mkdir(exist_ok=True)
    s = load_settings(
        {"BASE_HOME": str(tmp_path / "home"), "WORKSPACE_ROOT": str(root), "DEVICE_ONLY": "1", "LIGHT_SERIAL": ""}
    )
    s.ensure_home()
    return s


class NoNames:
    """The device's model, answering at once: no extra names, details or request topics."""

    def llm_names(self, *_a, **_k):
        return []

    llm_details = llm_names

    def request_topics(self, *_a, **_k):
        return []

    def close(self):
        return None


class OneSnippet:
    def __init__(self, snippet):
        self.snippet = snippet

    def search(self, query, k=5, folder=None):
        return [self.snippet]


class CheckDown:
    """Egress while the model is down: nothing is decided, and the release can be tried again."""

    def release(self, *_a, **_k):
        return Released("refused", HELD_TEXT, retryable=True)


def device(settings):
    svc = Services.create(settings, light=False, heavy=False)
    svc.checker_llm = svc.answer_llm = NoNames()
    svc.rag = None  # search_documents keeps the index's own ranking
    return svc


@pytest.fixture
def restart(tmp_path):
    """Search once with the check down, restart, and release the same job on the new device."""
    made = []

    def run(controls, snippet):
        settings = settings_for(tmp_path)
        ControlStore(settings.paths.controls).save(controls)
        before = device(settings)
        made.append(before)
        before.index, before.egress = OneSnippet(snippet), CheckDown()
        result, outcome = Connector(before).search_documents(QUERY)
        job_id = result.structured_content["job_id"]
        assert outcome == "pending" and before.jobs.get(job_id)["release_status"] == "none"
        before.close()
        after = device(settings)
        made.append(after)
        body = Connector(after).get_result(job_id)[0].structured_content
        return after, body

    yield run
    for svc in made:
        svc.close()


def test_a_search_from_a_scan_still_waits_under_hipaa_after_a_restart(restart):
    scan = Snippet("forms/trip.png", "trip form", f"{NAME} wrote about bees on the form.", 1.0)
    after, body = restart(Controls(profiles=["hipaa"]), scan)
    assert body["status"] == "waiting"
    [card] = after.approvals.pending()
    assert "compliance:scan" in json.loads(card["receipt"])["floors"]
    assert NAME not in card["tagged_text"]


def test_a_search_in_a_names_off_folder_keeps_the_names_after_a_restart(restart):
    essay = Snippet(f"essays/{NAME}.md", NAME, f"{NAME} wrote about bees in the garden.", 1.0)
    _after, body = restart(Controls(names_off_folders=["essays"]), essay)
    assert body["status"] == "shared" and NAME in body["result"]  # the user's choice for that folder


def test_without_a_names_off_folder_the_same_search_is_tagged(restart):
    essay = Snippet(f"essays/{NAME}.md", NAME, f"{NAME} wrote about bees in the garden.", 1.0)
    _after, body = restart(Controls(), essay)
    assert body["status"] == "shared" and NAME not in body["result"] and "[Student " in body["result"]


class Asker:
    def run(self, question, folder, deadline=None):
        return AskResult(answer=f"{NAME} wrote about bees.", sources=[f"essays/{NAME}.md"], answered=1)


def test_an_ask_jobs_sources_survive_a_new_runner_and_a_restart(tmp_path):
    settings = settings_for(tmp_path)
    ControlStore(settings.paths.controls).save(Controls(names_off_folders=["essays"]))
    job_id = AskRunner(Asker(), JobStore(settings.paths.db)).run_sync(QUERY, QUERY, None)
    assert JobStore(settings.paths.db).get(job_id)["sources"] == [f"essays/{NAME}.md"]
    after = device(settings)  # a new process: no runner has this job in memory
    try:
        assert after.ask_runner is not None and not hasattr(after.ask_runner, "sources")
        body = Connector(after).get_result(job_id)[0].structured_content
        assert body["status"] == "shared" and NAME in body["result"]
    finally:
        after.close()
