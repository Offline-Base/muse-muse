"""The 10 name leaks in eval/reports/device_only_fresh_200.md (Oct 30), replayed with no model.

eval/reports/device_only_fresh_200_leaks.md has the item-by-item account. Each of the 10 items
names someone the roster does not know, and LFM3-VL-2B's name pass missed them. The replay gives
the name pass the worst answer it can give (no names) and runs the real egress in DEVICE_ONLY
mode: with the name-shape check, nothing leaks; with only that check switched off (today's code
otherwise), all 10 leak again.
"""

from __future__ import annotations

import pytest

from base import config as base_config
from base.config import REPO_ROOT
from eval import run_eval
from scripts import replay_null_names as replay


@pytest.fixture(autouse=True)
def _pre_ruling_settings(monkeypatch):
    """The Oct 30 replay runs on the device-only LFM setup. The Nov 2 ruling made load_settings refuse LFM settings
    (tests/test_config.py); these tests keep that code tested with the pre-ruling loader until the
    owner decides whether to delete it."""
    monkeypatch.setattr(base_config, "load_settings", base_config._load_settings_for_tests)


LEAKED_OCT_30 = [
    "syn-0533", "syn-1560", "syn-1599", "syn-0390", "syn-0177",
    "syn-0366", "syn-1822", "syn-0966", "syn-0932", "syn-0757",
]  # fmt: skip
SET = REPO_ROOT / "eval" / "fresh_200.jsonl"
RAW = REPO_ROOT / "eval" / "reports" / "raw" / "device_only_fresh_200.jsonl"


def items() -> list[dict]:
    rows = [i for i in run_eval.load_items(SET) if i["id"] in LEAKED_OCT_30]
    assert len(rows) == 10
    return rows


def test_the_list_is_every_leak_the_oct_30_run_recorded():
    leaked = {r["id"] for r in run_eval.load_items(RAW) if r["leaked"]}
    assert leaked == set(LEAKED_OCT_30)
    assert all(i["names"] for i in items())  # each one names somebody


def test_none_of_the_names_is_on_the_roster():
    roster = (REPO_ROOT / "eval" / "roster.json").read_text()
    assert not [n for i in items() for n in i["names"] if n in roster]


def test_with_the_name_shape_check_none_of_the_10_leaks_even_when_the_model_finds_no_names():
    report = replay.replay(items())
    assert report.errors == report.fallbacks == 0
    assert replay.leaked_rows(report) == []


def test_without_the_name_shape_check_all_10_leak_again():
    report = replay.replay(items(), name_shapes=False)
    assert sorted(r["id"] for r in replay.leaked_rows(report)) == sorted(LEAKED_OCT_30)
    assert all(
        "name" in (r["leak_kinds"] or r["leak_kinds_after_approval"]) for r in replay.leaked_rows(report)
    )


def test_the_replay_refuses_the_sealed_set(capsys):
    import pytest

    with pytest.raises(SystemExit):
        replay.main(["--set", str(REPO_ROOT / "eval" / "splits" / "fresh_200_c.jsonl")])
    assert "sealed" in capsys.readouterr().err
