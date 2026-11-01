"""scripts/export_routing_training.py: rows in the app's format, with no held-out item in them."""

from __future__ import annotations

import json

from eval import run_eval
from scripts import export_routing_training as ex
from scripts import make_splits

BASE_B = make_splits.EVAL / "fresh_200_b.jsonl"


def some_items(n: int = 40) -> list[dict]:
    return run_eval.load_items(BASE_B)[:n]


def rows(path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_a_held_out_item_is_left_out_by_id_and_by_result_text(tmp_path):
    items = some_items(3)
    same_text = {**items[1], "id": "other-id"}
    fresh = {**items[2], "id": "fresh-id", "result": "An invented class note that no eval set holds, about the school garden."}
    source = tmp_path / "source.jsonl"
    source.write_text("\n".join(json.dumps(i) for i in (items[0], same_text, fresh)) + "\n")
    held = tmp_path / "held.jsonl"
    held.write_text("\n".join(json.dumps(i) for i in items[:2]) + "\n")
    kept, left = ex.usable(source, [held])
    assert [i["id"] for i in kept] == ["fresh-id"]
    assert left == {"held-out id": 1, "same text as a held-out item": 1}


def test_rows_are_what_the_app_sends_with_the_expected_answer(tmp_path):
    items = some_items()
    facts = ex.export(items, tmp_path)
    route = rows(tmp_path / "route.jsonl")
    assert route and len(route) == facts["route_rows"]
    assert facts["route_rows"] + facts["settled_by_a_floor_no_route_row"] + facts["dropped_for_a_name_or_identifier"] >= len(items)
    for row in route:
        system, user, answer = row["messages"]
        assert (system["role"], user["role"], answer["role"]) == ("system", "user", "assistant")
        assert "privacy router" in system["content"]
        assert "reasoning strength" not in system["content"].lower()
        reply = json.loads(answer["content"])
        assert set(reply) == {"decision", "reason"} and reply["decision"] in ex.REASONS
    labels = rows(tmp_path / "labels.jsonl")
    assert labels and all(set(json.loads(r["messages"][2]["content"])) == {"topics"} for r in labels)
    assert all("Topics:" in r["messages"][0]["content"] for r in labels)


def test_no_row_holds_a_roster_name(tmp_path):
    ex.export(some_items(), tmp_path)
    from base import guard
    from base.config import REPO_ROOT

    people = guard.load_roster(REPO_ROOT / "eval" / "roster.json").people()
    full_names = {f"{p.first} {p.last}" for p in people}
    text = (tmp_path / "route.jsonl").read_text() + (tmp_path / "labels.jsonl").read_text()
    assert not [name for name in full_names if name in text]


def test_the_reasoning_line_can_be_kept_for_a_file_served_with_reasoning(tmp_path):
    ex.export(some_items(10), tmp_path, keep_line=True)
    assert all("reasoning strength: low" in r["messages"][0]["content"].lower() for r in rows(tmp_path / "route.jsonl"))


def test_gold_labels_follow_the_request_topic_check():
    names = ["parents", "class_level", "full_text"]
    assert ex.gold_labels({"topics": ["parents", "grades"], "result_kind": "per_student"}, names) == ["parents"]
    assert ex.gold_labels({"topics": [], "result_kind": "class_aggregate"}, names) == ["class_level"]
