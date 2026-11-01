"""scripts/check_request_topics.py: which items are scored, candidates, keywords. Fake model only."""

from __future__ import annotations

import argparse
import json

from base.policy import UserPolicy
from scripts import check_request_topics as crt


class FakeLLM:
    """Labels a request with every topic whose name appears in it; records the topics it was shown."""

    def __init__(self, fail_on: str | None = None):
        self.shown: list[list[str]] = []
        self.fail_on = fail_on
        self.prompt_tokens, self.completion_tokens = 10, 5

    def request_topics(self, request, topics, *, synthetic=False):
        assert synthetic is True
        self.shown.append(list(topics))
        if self.fail_on and self.fail_on in request:
            raise RuntimeError("model down")
        return [t for t in topics if t in request]


def _write(path, rows):
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return path


def _item(i, request, topics=(), kind="per_student"):
    return {"id": i, "request": request, "result_kind": kind, "topics": list(topics)}


def _files(tmp_path):
    synthetic = [_item(f"syn-{n:02d}", "for parents", ["parents"]) for n in range(10)]
    synthetic += [_item(f"syn-{n:02d}", "scores", ["grades"]) for n in range(10, 30)]
    tasks = [_item("t001", "a note for parents", ["parents"]), _item("t002", "the average", kind="class_aggregate"),
             _item("t003", "the only student who reidentify", ["reidentify"])]  # fmt: skip
    return (
        _write(tmp_path / "synthetic.jsonl", synthetic),
        _write(tmp_path / "tasks.jsonl", tasks),
        _write(tmp_path / "seen.jsonl", [{"id": "syn-00"}, {"id": "syn-15"}, {"id": "t001"}]),
    )


def _args(tmp_path, *extra):
    synthetic, tasks, seen = _files(tmp_path)
    return ["--synthetic", str(synthetic), "--tasks", str(tasks), "--seen", str(seen), "--sample", "8",
            "--out", str(tmp_path / "out"), "--workers", "1", *extra]  # fmt: skip


def test_held_out_draw_leaves_out_every_seen_id_and_the_tuning_sample(tmp_path):
    synthetic, tasks, seen = _files(tmp_path)
    ns = argparse.Namespace(synthetic=synthetic, tasks=tasks, seen=[seen], sample=8, seed=11, dev_seed=7)
    sets = crt.build_sets(ns)
    held, dev = {i["id"] for i in sets[crt.HELD_OUT]}, {i["id"] for i in sets[crt.DEV]}
    assert len(held) == 8 and not held & dev and not held & {"syn-00", "syn-15"}
    assert dev == {i["id"] for i in crt.sample_synthetic(crt.load(synthetic), 8, 7)}
    assert [i["id"] for i in sets[crt.TASKS]] == ["t001", "t002", "t003"]


def test_the_repo_held_out_sample_is_new_and_the_tuning_sample_is_the_one_kept():
    # The kept tuning labels are exactly the seed-7 sample plus the 100 eval tasks.
    ns = argparse.Namespace(synthetic=crt.EVAL / "synthetic.jsonl", tasks=crt.EVAL / "tasks.jsonl", seen=[crt.SEEN],
                            sample=160, seed=11, dev_seed=7)  # fmt: skip
    sets = crt.build_sets(ns)
    seen = {r["id"] for r in crt.load(crt.SEEN)}
    held = {i["id"] for i in sets[crt.HELD_OUT]}
    assert len(held) == 160 and not held & seen
    assert {i["id"] for i in sets[crt.DEV]} == {i for i in seen if i.startswith("syn-")}
    holdout = {i["id"] for i in crt.load(crt.EVAL / "holdout.jsonl")}
    assert len(sets[crt.TASKS]) == 100 and holdout <= {i["id"] for i in sets[crt.TASKS]}


def test_report_scores_tasks_once_and_says_what_is_in_sample(settings, tmp_path):
    llm = FakeLLM()
    assert crt.main(_args(tmp_path), settings=settings, llm=llm) == 0
    md = (tmp_path / "out" / "request_topics.md").read_text()
    assert "## Eval tasks, in-sample (3 items)" in md
    assert "## Synthetic sample, held out (8 items)" in md and "## Synthetic sample, seen during tuning (8 items)" in md
    assert "Search the essays for compost." in md and "full_text description was tightened" in md
    assert "Tokens over all 19 calls: prompt 10, completion 5." in md
    rows = crt.load(tmp_path / "out" / "raw" / "request_topics.jsonl")
    assert len(rows) == len({r["id"] for r in rows}) == 19  # 8 + 8 + 3, every item called once
    assert all(shown == list(UserPolicy.load(settings.policy_path).request_topics) for shown in llm.shown)


def test_extra_topic_is_scored_from_a_second_call_and_the_policy_is_unchanged(settings, tmp_path):
    before = settings.policy_path.read_text()
    llm = FakeLLM()
    desc = "narrows the class down to one or a few students by a trait"
    assert crt.main(_args(tmp_path, "--extra-topic", f"reidentify={desc}", "--name", "cand"), settings=settings, llm=llm) == 0
    assert settings.policy_path.read_text() == before
    policy_topics = list(UserPolicy.load(settings.policy_path).request_topics)
    assert llm.shown.count(policy_topics) == 19 and llm.shown.count([*policy_topics, "reidentify"]) == 19
    md = (tmp_path / "out" / "cand.md").read_text()
    assert f'- reidentify: "{desc}"' in md
    assert "| reidentify (candidate) | Glimmer | 1 | 1 | 1.00 | 1.00 |" in md  # t003 in the eval tasks
    row = next(r for r in crt.load(tmp_path / "out" / "raw" / "cand.jsonl") if r["id"] == "t003")
    assert row["extra"] == ["reidentify"] and "reidentify" not in row["topics"]


def test_extra_topic_must_be_new_and_well_formed(settings, tmp_path, capsys):
    assert crt.main(_args(tmp_path, "--extra-topic", "parents=for families"), settings=settings, llm=FakeLLM()) == 2
    assert "already in the policy" in capsys.readouterr().err
    for bad in ("reidentify", "=desc", "two words=x"):
        try:
            crt.extra_topic(bad)
        except argparse.ArgumentTypeError:
            continue
        raise AssertionError(bad)


def test_keywords_baseline_and_failures(settings, tmp_path):
    words = tmp_path / "kw.yaml"
    words.write_text("request_topics:\n  parents: [parents]\n  class_level: [average]\n")
    llm = FakeLLM(fail_on="a note")
    assert crt.main(_args(tmp_path, "--keywords", str(words)), settings=settings, llm=llm) == 1
    md = (tmp_path / "out" / "request_topics.md").read_text()
    assert "19 calls with the policy's topics, 1 failed" in md
    assert "| class_level | Keywords | 1 | 1 | 1.00 | 1.00 |" in md
    assert "| parents | Glimmer | 1 | 0 | n/a | 0.00 |" in md  # the failed call counts as no topics
