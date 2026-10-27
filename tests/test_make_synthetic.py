import itertools
import json
import re
from collections import Counter

import pytest
import respx

from base.spark import SparkError, SparkRefused
from scripts import make_synthetic as ms

ROSTER_JSON = {
    "teacher": {"name": "Odessa Brightwater", "first": "Odessa", "last": "Brightwater", "role": "teacher"},
    "students": [
        {"name": "Quillon Marsh", "first": "Quillon", "last": "Marsh", "nicknames": ["Quill"]},
        {"name": "Tavi Rendleman", "first": "Tavi", "last": "Rendleman", "nicknames": []},
    ],
    "school": "Fernhollow Elementary (invented)",
}


def raw(expected="share_tagged", kind="per_student", **over):
    item = {
        "request": "Give the rubric scores for [Student C] on the fractions quiz.",
        "result": "Corvin Ashdale: 3, 4, 3 on the fractions quiz rubric.",
        "result_kind": kind,
        "topics": [],
        "expected": expected,
        "names": ["Corvin Ashdale"],
        "identifiers": [],
        "tricky": False,
        "notes": "Ordinary per-student scores.",
    }
    item.update(over)
    return item


# text helpers and filters


def test_normalize_and_jaccard():
    assert ms.normalize("  Show [Student A]'s   essay!! ") == "show student a s essay"
    assert ms.jaccard({"a", "b"}, {"a", "b"}) == 1.0
    assert ms.jaccard({"a", "b"}, {"b", "c"}) == pytest.approx(1 / 3)


def test_dedupe_by_normalized_request():
    filt = ms.RequestFilter()
    assert filt.reason("Show [Student A]'s essay.") is None
    filt.add("Show [Student A]'s essay.")
    assert filt.reason("show student a's ESSAY") == "duplicate"
    assert filt.reason("Show [Student B]'s essay.") is None


def test_overlap_with_eval_sets_is_dropped():
    filt = ms.RequestFilter(["Please give me the class average on the fractions quiz"])
    # 9 of 10 tokens shared: Jaccard 0.9
    assert filt.reason("Give me the class average on the fractions quiz") == "overlaps_eval"
    # 7 of 9 shared: Jaccard 0.78, kept
    assert filt.reason("Give me the class average for the fractions quiz") is None
    assert filt.reason("List the documents in the poetry folder") is None


def test_roster_tokens(tmp_path):
    path = tmp_path / "roster.json"
    path.write_text(json.dumps(ROSTER_JSON))
    tokens = ms.roster_tokens(path)
    assert {"odessa", "brightwater", "quillon", "marsh", "quill", "tavi", "rendleman"} <= tokens
    assert "fernhollow" not in tokens and "elementary" not in tokens
    assert ms.roster_tokens(tmp_path / "missing.json") == set()


# identifiers


def test_scan_identifiers_fake_and_real():
    found, bad = ms.scan_identifiers(
        "Mom: (512) 555-0143, dad.lane@example.org, SSN 900-12-3456, card 4111 1111 1111 1111, id S123456"
    )
    assert bad == []
    assert "(512) 555-0143" in found and "dad.lane@example.org" in found
    assert "900-12-3456" in found and "4111 1111 1111 1111" in found and "S123456" in found
    for text in ("call 512-555-1234", "mail a@gmail.com", "SSN 123-45-6789", "card 5500 0000 0000 0004"):
        assert ms.scan_identifiers(text)[1], text


def test_batch_prompt_has_no_identifiers():
    for message in ms.batch_messages(ms.plan_cells(25), 1, 1):
        found, bad = ms.scan_identifiers(message["content"])
        assert found == [] and bad == []


# item checks


def test_clean_item_ok():
    item, reason = ms.clean_item(raw())
    assert reason == "ok"
    assert item["source"] == "spark" and item["names"] == ["Corvin Ashdale"]
    assert list(item) == [
        "request",
        "result",
        "result_kind",
        "topics",
        "expected",
        "names",
        "identifiers",
        "tricky",
        "notes",
        "source",
    ]


def test_clean_item_fills_identifiers_and_drops_unseen_names():
    item, reason = ms.clean_item(
        raw(
            "refuse",
            "contact_info",
            topics=["parent_contact"],
            result="Corvin's mom: (512) 555-0177, corvin.home@example.com",
            names=["Corvin", "Nobody Here"],
            identifiers=["(512) 555-0177"],
        )
    )
    assert reason == "ok"
    assert item["names"] == ["Corvin"]
    assert item["identifiers"] == ["(512) 555-0177", "corvin.home@example.com"]


@pytest.mark.parametrize(
    ("item", "reason"),
    [
        (raw(result="Corvin Ashdale, phone 512-555-1234"), "real_identifier"),
        (raw("ask_user", "free_text", result="Email Corvin Ashdale at cash@gmail.com"), "real_identifier"),
        (raw(result="Corvin Ashdale (512) 555-0101"), "identifier_floor"),
        (raw(request="Show Corvin's scores."), "name_in_request"),
        (raw(result="Quill Marsh scored 3."), "roster_collision"),
        (raw("refuse", "sensitive_record", topics=["grades"]), "label_topic_mismatch"),
        (raw("share_tagged", topics=["iep"]), "label_topic_mismatch"),
        (raw("share_summary", "per_student"), "label_kind_mismatch"),
        (raw(expected="maybe"), "bad_label"),
        (raw(result=" "), "empty"),
        (raw(request="Text (512) 555-0101 the scores."), "identifier_in_request"),
    ],
)
def test_clean_item_drops(item, reason):
    roster = {"quill", "quillon", "marsh", "odessa"}
    assert ms.clean_item(item, roster) == (None, reason)


# planning


def test_plan_spreads_decisions_and_kinds():
    plan = ms.plan_cells(2000)
    by_decision = Counter(d for d, _ in plan)
    assert set(by_decision.values()) == {500}
    tagged = Counter(k for d, k in plan if d == "share_tagged")
    assert set(tagged.values()) == {100}
    ask = Counter(k for d, k in plan if d == "ask_user")
    assert max(ask.values()) - min(ask.values()) <= 1
    assert all(k == "class_aggregate" for d, k in plan if d == "share_summary")
    first = plan[:25]
    assert len({d for d, _ in first}) == 4


def test_remaining_cells():
    plan = ms.plan_cells(8)
    have = Counter({plan[0]: 1, plan[1]: 1})
    assert ms.remaining_cells(plan, have) == plan[2:]


# generation with a fake Spark


class FakeSpark:
    """Answers each batch prompt with items for exactly the slots it lists."""

    cache_path = None

    def __init__(self, bad_first=0, fail_batches=0):
        self.calls = []
        self.serial = itertools.count(1)
        self.bad_first = bad_first
        self.fail_batches = fail_batches

    def chat_json(self, messages, schema, **kw):
        self.calls.append((messages, kw))
        if len(self.calls) <= self.fail_batches:
            raise SparkError("timeout")
        cells = re.findall(r"^\d+\. (\w+), (\w+)$", messages[-1]["content"], re.M)
        items = []
        for expected, kind in cells:
            n = next(self.serial)
            if n <= self.bad_first:
                items.append(raw(result="Corvin Ashdale 512-555-9876"))  # real-looking phone
                continue
            topics = ["medical"] if expected == "refuse" else []
            result = f"Corvin Ashdale{' has an asthma plan' if topics else ''}, note {n}."
            items.append(
                raw(
                    expected,
                    kind,
                    topics=topics,
                    result=result,
                    request=f"Request number {n} for [Student C].",
                )
            )
        return {"items": items}


def test_generate_fills_plan_evenly():
    spark = FakeSpark()
    items, stats = ms.generate(spark, 20, batch=8, workers=2, log=lambda m: None)
    assert len(items) == 20
    assert Counter(i["expected"] for i in items) == Counter({d: 5 for d in ms.DECISIONS})
    assert [i["id"] for i in items][:2] == ["syn-0001", "syn-0002"]
    assert len({i["id"] for i in items}) == 20
    assert all(i["source"] == "spark" for i in items)
    assert len(spark.calls) == 3
    _, kw = spark.calls[0]
    assert kw["effort"] == "low" and kw["max_tokens"] == ms.batch_max_tokens(8)


def test_generate_refills_after_drops_and_failures():
    spark = FakeSpark(bad_first=3, fail_batches=1)
    items, stats = ms.generate(spark, 12, batch=6, workers=1, log=lambda m: None)
    assert len(items) == 12
    assert stats["batch_failed"] == 1
    assert stats["real_identifier"] == 3
    assert Counter(i["expected"] for i in items) == Counter({d: 3 for d in ms.DECISIONS})


def test_generate_applies_dedupe_overlap_and_policy():
    class Repeating(FakeSpark):
        def chat_json(self, messages, schema, **kw):
            data = super().chat_json(messages, schema, **kw)
            for item in data["items"]:
                item["request"] = "Same request for [Student C]."
            return data

    items, stats = ms.generate(Repeating(), 4, batch=4, max_rounds=1, log=lambda m: None)
    assert len(items) == 1 and stats["duplicate"] == 3

    items, stats = ms.generate(
        Repeating(), 4, batch=4, max_rounds=1, reference=["same request for student c"], log=lambda m: None
    )
    assert items == [] and stats["overlaps_eval"] == 4

    items, stats = ms.generate(
        FakeSpark(), 8, batch=8, max_rounds=1, labeler=lambda item: "refuse", log=lambda m: None
    )
    assert {i["expected"] for i in items} == {"refuse"} and stats["policy_disagrees"] == 6


def test_generate_stops_on_refusal():
    class Refusing(FakeSpark):
        def chat_json(self, messages, schema, **kw):
            raise SparkRefused("input contains student")

    with pytest.raises(SparkRefused):
        ms.generate(Refusing(), 4, batch=4, log=lambda m: None)


# CLI


def test_dry_run_prints_body_and_sends_nothing(capsys):
    with respx.mock(assert_all_called=False) as mock:
        assert ms.main(["--dry-run", "--batch", "5"]) == 0
        assert not mock.calls
    body = json.loads(capsys.readouterr().out)
    assert body["reasoning_effort"] == "low"
    assert body["response_format"]["json_schema"]["strict"] is True
    assert body["response_format"]["json_schema"]["name"] == "synthetic_batch"
    assert len(re.findall(r"^\d+\. ", body["messages"][-1]["content"], re.M)) == 5


def test_main_writes_jsonl(tmp_path, monkeypatch):
    tasks = tmp_path / "tasks.jsonl"
    tasks.write_text(json.dumps({"id": "t1", "request": "Request number 1 for [Student C]."}) + "\n")
    monkeypatch.setattr(ms, "REFERENCE_FILES", (tasks, tmp_path / "holdout.jsonl"))
    monkeypatch.setattr(ms, "Spark", lambda settings: FakeSpark())
    monkeypatch.setattr(ms, "make_labeler", lambda settings: None)
    monkeypatch.setattr(ms, "roster_tokens", lambda path: set())
    monkeypatch.setattr(ms, "usage_summary", lambda path, since=None: {"calls": 0})
    out = tmp_path / "out" / "synthetic.jsonl"
    assert ms.main(["--count", "8", "--batch", "4", "--out", str(out)]) == 0
    rows = [json.loads(line) for line in out.read_text().splitlines()]
    assert len(rows) == 8
    assert all(r["request"] != "Request number 1 for [Student C]." for r in rows)
    assert set(rows[0]) == {
        "id",
        "request",
        "result",
        "result_kind",
        "topics",
        "expected",
        "names",
        "identifiers",
        "tricky",
        "notes",
        "source",
    }
