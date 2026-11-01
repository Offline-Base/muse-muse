"""scripts/grade_crosscheck.py: Spark grades tagged essays, the budget holds, agreement math. Mocked Meta API."""

from __future__ import annotations

import json

import httpx
import respx

from base.spark import Spark
from scripts import grade_crosscheck as gc

ESSAYS = {
    "Abigail Thornbury.md": "# My opinion\nBy Abigail Thornbury\n\nOur school should have a garden. Camila said so too.",
    "Benjamin Adeyemi.md": "# Gardens\nBy Benjamin Adeyemi\n\nA garden helps us learn. Call 512-555-0143.",
}
SCORES = {"ideas": 3, "organization": 2, "evidence": 3, "conventions": 4}


def _grade(scores=SCORES):
    return json.dumps({"scores": scores, "total": 99, "strengths": "s", "next_step": "n", "feedback": "f"})


def _reply(content):
    return {"choices": [{"message": {"content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1000, "completion_tokens": 400, "completion_tokens_details": {"reasoning_tokens": 150}}}  # fmt: skip


def _folder(tmp_path):
    essays = tmp_path / "essays"
    essays.mkdir()
    for name, text in ESSAYS.items():
        (essays / name).write_text(text)
    (tmp_path / "rubric.md").write_text("# Rubric\nScore ideas, organization, evidence, conventions from 1 to 4.\n")
    spot = tmp_path / "spot.jsonl"
    runs = {"run_a": {"scores": {"Ideas": 3, "Organization": 3, "Evidence": 3, "Conventions": 4}, "total": 13},
            "run_b": {"scores": {"Ideas": 3, "Organization": 3, "Evidence": 3, "Conventions": 3}, "total": 12}}  # fmt: skip
    spot.write_text(json.dumps({"essay": "Abigail Thornbury.md", "picked": True, **runs}) + "\n")
    return ["--essays", str(essays), "--rubric", str(tmp_path / "rubric.md"), "--glimmer", str(spot),
            "--out", str(tmp_path / "out")]  # fmt: skip


class FakeGlimmer:
    def __init__(self):
        self.calls = []

    def chat_json(self, messages, schema, **kw):
        assert kw["synthetic"] is True and schema is gc.GRADE_SCHEMA
        self.calls.append(messages)
        return json.loads(_grade({"ideas": 4, "organization": 4, "evidence": 4, "conventions": 4}))


@respx.mock
def test_spark_grades_tagged_essays_with_the_agents_prompt_and_is_compared(settings, tmp_path):
    route = respx.post(f"{settings.spark_base}/chat/completions").mock(return_value=httpx.Response(200, json=_reply(_grade())))
    spark = Spark(settings, cache_path=tmp_path / "spark.db")
    glimmer = FakeGlimmer()
    assert gc.main(_folder(tmp_path), settings=settings, spark=spark, glimmer_llm=glimmer) == 0
    assert route.call_count == 2
    for call in route.calls:
        body = json.loads(call.request.content)
        sent = json.dumps(body["messages"])
        assert body["messages"][0]["content"] == gc.GRADE_SYSTEM and body["reasoning_effort"] == "low"
        assert gc.GRADE_INSTRUCTIONS in sent and "[Student " in sent
        assert not any(word in sent for word in ("Abigail", "Thornbury", "Camila", "Adeyemi", "555-0143"))
    # The essay missing from the spot-check file was graded by Glimmer with the same messages.
    assert len(glimmer.calls) == 1 and glimmer.calls[0] == json.loads(route.calls[1].request.content)["messages"]
    md = (tmp_path / "out" / "grading_crosscheck.md").read_text()
    assert "Spark is a second opinion, not ground truth." in md
    assert "| Same total | 0 of 2 | 0 of 1 |" in md  # Spark 12 vs 13 and 12 vs 16; run A 13 vs run B 12
    assert "| Mean absolute difference in total (of 16) | 2.50 | 1.00 |" in md
    assert "Harsher grader: Spark, by 2.50 points per essay on average." in md
    assert "2 API calls (at most 30), 0 answered from the local cache, 2000 prompt and 800 completion tokens, 300 of them reasoning" in md
    rows = [json.loads(line) for line in (tmp_path / "out" / "raw" / "grading_crosscheck.jsonl").read_text().splitlines()]
    assert [r["glimmer_source"] for r in rows] == ["spotcheck run A", "graded now"]
    assert rows[0]["spark"] == {"scores": SCORES, "total": 12}  # total recomputed from the scores
    assert "feedback" not in json.dumps(rows)


@respx.mock
def test_spark_calls_stop_at_the_budget_and_a_bad_reply_is_retried_once(settings, tmp_path):
    route = respx.post(f"{settings.spark_base}/chat/completions").mock(return_value=httpx.Response(200, json=_reply("not json")))
    spark = Spark(settings, cache_path=tmp_path / "spark.db")
    assert gc.main([*_folder(tmp_path), "--max-calls", "3"], settings=settings, spark=spark, glimmer_llm=FakeGlimmer()) == 1
    assert route.call_count == 3  # two tries for the first essay, one before the budget ran out
    rows = [json.loads(line) for line in (tmp_path / "out" / "raw" / "grading_crosscheck.jsonl").read_text().splitlines()]
    assert [r["spark_error"] for r in rows] == ["bad_reply", "budget"]
    md = (tmp_path / "out" / "grading_crosscheck.md").read_text()
    assert "Not compared (2)" in md and "No essay was scored by both." in md


def test_compare_counts_agreement_and_who_is_harsher():
    g = {"scores": {"ideas": 3, "organization": 3, "evidence": 3, "conventions": 3}, "total": 12}
    s = {"scores": {"ideas": 3, "organization": 2, "evidence": 3, "conventions": 4}, "total": 12}
    low = {"scores": {"ideas": 2, "organization": 2, "evidence": 2, "conventions": 2}, "total": 8}
    stats = gc.compare([(g, s), (g, low)])
    assert stats["same_total"] == 1 and stats["total_within_1"] == 1 and stats["criteria_same"] == 2
    assert stats["criteria_within_1"] == 8 and stats["mad"] == 2.0 and stats["spark_lower"] == 1
    assert gc.harsher(stats) == "Spark, by 2.00 points per essay on average"
    assert gc.harsher(gc.compare([(low, g)])) == "Glimmer, by 4.00 points per essay on average"
