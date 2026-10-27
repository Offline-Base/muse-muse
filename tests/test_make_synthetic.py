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


def test_roster_tokens_include_student_ids(tmp_path):
    data = {**ROSTER_JSON, "students": [{**ROSTER_JSON["students"][0], "student_id": "S700001"}]}
    path = tmp_path / "roster.json"
    path.write_text(json.dumps(data))
    assert "s700001" in ms.roster_tokens(path)


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


def test_clean_item_replaces_em_dashes():
    item, reason = ms.clean_item(
        raw(result="Corvin Ashdale \u2014 3, 4, 3.", request="Scores\u2014[Student C].", notes="Fine \u2014 tagged.")
    )
    assert reason == "ok"
    assert item["result"] == "Corvin Ashdale - 3, 4, 3."
    assert item["request"] == "Scores - [Student C]." and item["notes"] == "Fine - tagged."


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
        (raw("refuse", "contact_info", topics=["parent_contact"], result="Corvin's mom: 9NN-NN-NNNN"), "placeholder"),
        (raw("refuse", "contact_info", topics=["parent_contact"], result="Corvin Ashdale, S700001"), "roster_collision"),
        (raw("refuse", "contact_info", topics=["parent_contact"], result="Corvin Ashdale, S700042"), "roster_collision"),
    ],
)
def test_clean_item_drops(item, reason):
    roster = {"quill", "quillon", "marsh", "odessa", "s700001"}
    assert ms.clean_item(item, roster) == (None, reason)


# the device guard on Spark output


class Hit:
    def __init__(self, kind, value):
        self.kind, self.value = kind, value


def fake_guard(names=(), identifiers=(), topics=()):
    return ms.GuardChecks(
        names=lambda text: [Hit("student", n) for n in names if n in text],
        identifiers=lambda text: [Hit(k, v) for k, v in identifiers if v in text],
        topics=lambda text: [t for t, word in topics if word in text],
    )


def test_guard_name_hit_is_a_roster_collision():
    item = raw(result="Corvyn Ashdale: 3, 4, 3.", names=["Corvyn Ashdale"])
    assert ms.clean_item(item, guard=fake_guard(names=["Corvyn"])) == (None, "roster_collision")
    assert ms.clean_item(item, guard=fake_guard())[1] == "ok"


def test_guard_keyword_topic_is_added_and_can_flip_the_label():
    item = raw(result="Corvin Ashdale: 3, 4, 3, then a nurse visit.")
    guard = fake_guard(topics=[("medical", "nurse visit")])
    assert ms.clean_item(item, guard=guard) == (None, "label_topic_mismatch")
    refused, reason = ms.clean_item(raw("refuse", "snippet", topics=["grades"], result=item["result"]), guard=guard)
    assert reason == "ok" and refused["topics"] == ["grades", "medical"]


def test_guard_identifier_hits_must_be_fake():
    base = raw("refuse", "contact_info", topics=["parent_contact"], result="Corvin's dad: 555 0142 x9")
    real = fake_guard(identifiers=[("phone", "555 0142 x9")])
    assert ms.clean_item(base, guard=real) == (None, "real_identifier")
    item, reason = ms.clean_item(
        {**base, "result": "Corvin's dad: 555-0142"}, guard=fake_guard(identifiers=[("phone", "555-0142")])
    )
    assert reason == "ok" and item["identifiers"] == ["555-0142"]
    tagged = raw(result="Corvin Ashdale, born on the 3rd, scored 3.")
    assert ms.clean_item(tagged, guard=fake_guard(identifiers=[("dob", "born on the 3rd")])) == (
        None,
        "identifier_floor",
    )


def test_in_roster_id_block():
    roster = {"s401127", "maya", "ty"}
    assert ms.in_roster_id_block("s401127", roster) and ms.in_roster_id_block("s401275", roster)
    assert not ms.in_roster_id_block("s482913", roster) and not ms.in_roster_id_block("s4011270", roster)
    assert not ms.in_roster_id_block("5125550147", roster)


def test_is_fake():
    assert ms.is_fake("phone", "(512) 555-0143") and ms.is_fake("phone", "555-0199")
    assert not ms.is_fake("phone", "(512) 555-1234")
    assert ms.is_fake("email", "a@school.example.org") and not ms.is_fake("email", "a@mail.test")
    assert ms.is_fake("ssn", "912-34-5678") and not ms.is_fake("ssn", "123-45-6789")
    assert ms.is_fake("card", "4111 1111 1111 1111") and not ms.is_fake("card", "4242 4242 4242 4242")
    assert ms.is_fake("student_id", "S123456")


# the prompt agrees with the real policy and passes the real guard


def test_prompt_topics_cover_the_policy():
    from base.config import load_settings
    from base.policy import UserPolicy

    policy = UserPolicy.load(load_settings().policy_path)
    used = set(policy.never_share) | {t for r in policy.rules for t in (*r.topics_any, *r.topics_all)}
    assert used <= set(ms.TOPICS)
    assert set(policy.never_share) == set(ms.NEVER_SHARE_TOPICS)
    for topic in ms.TOPICS:
        assert f"{topic} (" in ms.SYSTEM_PROMPT


@pytest.mark.parametrize(
    ("expected", "kind", "topics"),
    [
        ("share_tagged", "per_student", ["grades"]),
        ("share_tagged", "snippet", ["writing"]),
        ("share_tagged", "free_text", ["grades", "writing"]),
        ("share_tagged", "document_list", []),
        ("share_summary", "class_aggregate", ["grades"]),
        ("ask_user", "free_text", ["grades", "parents"]),
        ("ask_user", "snippet", ["grades", "third_party"]),
        ("ask_user", "per_student", ["writing", "full_text"]),
        ("ask_user", "per_student", ["attendance"]),
        ("refuse", "sensitive_record", ["iep"]),
        ("refuse", "per_student", ["grades", "lunch_status"]),
        ("refuse", "snippet", ["reidentify"]),
    ],
)
def test_prompt_decision_order_matches_the_policy(expected, kind, topics):
    from base.config import load_settings
    from base.policy import UserPolicy

    policy = UserPolicy.load(load_settings().policy_path)
    assert policy.wants({"request": "Show this for [Student C].", "result_kind": kind, "topics": topics}) == expected


def test_batch_prompts_pass_the_real_guard():
    from base import guard
    from base.config import load_settings

    roster = guard.load_roster(load_settings().roster_path)
    plan = ms.plan_cells(2000)
    for round_no in (1, 2, 3, 4):
        for n in range(1, 81):
            for message in ms.batch_messages(plan[(n - 1) * 25 : n * 25], n, round_no):
                text = message["content"]
                assert not guard.find_identifiers(text) and not guard.find_names(text, roster)


# planning


def test_plan_spreads_decisions_and_kinds():
    plan = ms.plan_cells(2000)
    by_decision = Counter(d for d, _ in plan)
    assert set(by_decision.values()) == {500}
    tagged = Counter(k for d, k in plan if d == "share_tagged")
    assert set(tagged.values()) == {125}
    assert "dreaming_report" not in {k for _, k in plan}  # rule path, and the policy has no rule for it
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


def test_generate_respects_max_calls():
    spark = FakeSpark(bad_first=100)  # every item dropped, so it would keep re-asking
    items, stats = ms.generate(spark, 8, batch=4, max_calls=3, log=lambda m: None)
    assert items == [] and len(spark.calls) == 3 and stats["calls"] == 3


def test_check_items_passes_a_good_set_and_flags_a_bad_one():
    items, _ = ms.generate(FakeSpark(), 8, batch=8, log=lambda m: None)
    rows = ms.check_items(items, 8, reference=["Something else entirely."], guard=fake_guard())
    assert all(ok for _, ok, _ in rows), rows
    assert "| item count | pass | 8 of 8 |" in ms.render_checks(rows)
    from_muse = [{**i, "source": "muse"} for i in items]
    assert all(ok for _, ok, _ in ms.check_items(from_muse, 8, guard=fake_guard()))

    bad = [dict(i) for i in items]
    bad[1]["request"] = bad[0]["request"]
    bad[2]["result"] = bad[2]["result"] + " Call (512) 555-1234."
    rows = dict((name, ok) for name, ok, _ in ms.check_items(bad[:7], 8, guard=fake_guard(names=["Corvin"])))
    assert not rows["item count"]
    assert not rows["no duplicate requests or results"]
    assert not rows["no identifier outside the fake ranges"]
    assert not rows["no roster name (guard.find_names, misspellings included)"]
    assert not rows["every item passes the generator checks again"]


def test_check_items_flags_overlap_with_eval_sets():
    items, _ = ms.generate(FakeSpark(), 4, batch=4, log=lambda m: None)
    rows = ms.check_items(items, 4, reference=[items[0]["request"]])
    assert ("no request with Jaccard >= 0.8 to tasks or holdout", False) in [(n, ok) for n, ok, _ in rows]


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
    monkeypatch.setattr(ms, "load_policy", lambda settings: None)
    monkeypatch.setattr(ms, "make_guard", lambda settings, never_share: None)
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


def test_export_usage_writes_numbers_only(tmp_path):
    import sqlite3

    db = tmp_path / "spark.db"
    with sqlite3.connect(db) as con:
        con.execute("CREATE TABLE spark_calls (ts REAL, model TEXT, prompt_tokens INT, completion_tokens INT, "
                    "reasoning_tokens INT, cached INT, cached_tokens INT, prompt TEXT)")
        con.execute("INSERT INTO spark_calls VALUES (1.0, 'muse-spark-1.3', 10, 20, 5, 0, 0, 'invented prompt')")
    out = tmp_path / "raw" / "usage.jsonl"
    assert ms.export_usage(db, out) == 1
    row = json.loads(out.read_text())
    assert row["completion_tokens"] == 20 and "prompt" not in row
