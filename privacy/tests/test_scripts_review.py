"""The speed bench and the secrets scan (review eval F6). Mocked model, throwaway git repos."""

from __future__ import annotations

import json
import subprocess

from base.local_llm import ChatResult
from scripts import bench_speed, charts, secrets_scan


class FakeLLM:
    def __init__(self):
        self.calls = []

    def chat(self, messages, **kw):
        self.calls.append(kw)
        assert kw["synthetic"] is True and kw["json_schema"] is not None
        return ChatResult(content="{}", completion_tokens=500, reasoning_tokens=200, latency_ms=2000)


def test_bench_writes_a_report_the_speed_chart_reads(settings, tmp_path, capsys):
    llm = FakeLLM()
    assert bench_speed.main(["--label", "laptop", "--runs", "2", "--out", str(tmp_path)], settings=settings, llm=llm) == 0
    assert len(llm.calls) == 8  # four steps, two runs each
    md = (tmp_path / "laptop_speed.md").read_text()
    assert "| Grade one essay | 2000 | 250.0 | 2 |" in md and "| Request topics | 2000 | 250.0 | 2 |" in md
    assert "not this device" in md  # the test settings use the cloud backend
    assert (tmp_path / "raw" / "laptop_speed.jsonl").read_text().count("\n") == 8
    [(name, metric, rows)] = charts.read_speed(tmp_path)
    assert name == "Laptop" and metric == "Tokens/s" and dict(rows)["Router decision"] == 250.0


def _repo(tmp_path, files: dict[str, str]):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    for name, text in files.items():
        (tmp_path / name).write_text(text)
    return tmp_path


def test_secrets_scan_finds_keys_ips_hosts_and_names_without_printing_them(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(secrets_scan, "user_names", lambda: {"invented-user"})
    fake_key = "sk-or-v1-" + "ab" * 32  # built here so this file holds no key shape
    lan_ip = ".".join(map(str, (192, 168, 7, 23)))  # a home-network shape; built here for the same reason
    root = _repo(tmp_path, {
        "a.py": f"KEY = '{fake_key}'\n",
        "b.md": f"board at {lan_ip} and {'box' + '.local'}\n",
        "c.txt": "home is /Users/invented-user/x\n",
        "ok.md": "loopback 127.0.0.1, docs 203.0.113.9, range 192.168.0.0/16, pydantic>=2.14.1.0\n",
    })  # fmt: skip
    assert secrets_scan.main([], root=root) == 1
    out = capsys.readouterr().out
    assert "a.py:1: openrouter key" in out and "b.md:1: ip address" in out and "b.md:1: host name" in out
    assert "c.txt:1: user name" in out and "ok.md" not in out
    assert fake_key not in out and lan_ip not in out and "invented-user" not in out


def test_secrets_scan_reads_history_too(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(secrets_scan, "user_names", lambda: set())
    root = _repo(tmp_path, {"a.txt": "token ghp_" + "x" * 36 + "\n"})
    git = ["git", "-C", str(root), "-c", "user.email=t@example.org", "-c", "user.name=Test"]
    subprocess.run([*git, "add", "a.txt"], check=True)
    subprocess.run([*git, "commit", "-qm", "add"], check=True)
    (root / "a.txt").write_text("clean\n")
    subprocess.run([*git, "commit", "-qam", "clean"], check=True)
    assert secrets_scan.main([], root=root) == 0
    assert secrets_scan.main(["--history"], root=root) == 1
    assert "github token" in capsys.readouterr().out


# ----- quantization eval: the shipped prompts and production inputs (review gap) -----


def _quant():
    import sys

    cloud = str(bench_speed.REPO_ROOT / "scripts" / "cloud")
    sys.path.insert(0, cloud)
    try:
        import quant_eval_modal as q
    finally:
        sys.path.remove(cloud)
    return q


def _quant_inputs(q):
    import argparse

    eval_dir = q.REPO / "eval"
    args = argparse.Namespace(essays=None, rubric=None, roster=str(eval_dir / "roster.json"),
                              tasks=str(eval_dir / "tasks.jsonl"), policy=str(eval_dir / "user_policy.yaml"))  # fmt: skip
    inputs, problems = q.load_inputs(args)
    assert problems == []
    return inputs


def test_quant_bodies_are_the_devices(tmp_path):
    from base.config import load_settings
    from base.local_llm import LocalLLM
    from base.policy import UserPolicy

    q = _quant()
    env = {"GLIMMER_BACKEND": "llama_server", "GLIMMER_MODEL": "glimmer", "BASE_HOME": str(tmp_path), "LLAMA_API_KEY": "x"}
    llama = LocalLLM(load_settings(env))  # the model alias the Jetson unit and the container both serve
    prompts = q.shipped_prompts(UserPolicy.load(q.REPO / "eval" / "user_policy.yaml").request_topics)
    messages = {"names": q.names_messages("An essay.", prompts["names"]),
                "topics": q.topics_messages("A note home.", prompts["topics"]),
                "route": q.route_messages({"request": "r", "result_kind": "snippet", "text": "t"}, [], prompts["route"]),
                "grade": q.grade_messages("[Student A] wrote.", "Rubric", prompts["grade"])}  # fmt: skip
    for job, msgs in messages.items():
        p = prompts[job]
        assert q.request_body(msgs, p["schema"], p["max_tokens"]) == llama.build_body(
            msgs, max_tokens=p["max_tokens"], json_schema=p["schema"]), job  # fmt: skip
    # The container side never imports base: everything it needs is in the payload.
    source = (q.REPO / "scripts" / "cloud" / "quant_eval_modal.py").read_text()
    container = source.split("# -- prompts and requests (used in the container")[1].split("# -- report")[0]
    assert "from base" not in container and "import base" not in container


def test_quant_topic_and_route_messages_match_egress_and_the_router():
    from dataclasses import replace

    from base.local_llm import LocalLLM
    from base.router import NO_RULES, SYSTEM_PROMPT, build_user_message

    q = _quant()
    inputs = _quant_inputs(q)
    prompts = q.shipped_prompts(inputs["request_topics"])
    seen = {}

    class Capture(LocalLLM):
        def __init__(self):
            pass

        def chat_json(self, messages, schema, **kw):
            seen.update(messages=messages, schema=schema)
            return {"topics": []}

    Capture().request_topics("Draft a note home.", inputs["request_topics"])
    assert seen["messages"] == q.topics_messages("Draft a note home.", prompts["topics"])
    assert seen["schema"] == prompts["topics"]["schema"]
    assert prompts["route"]["system"] == SYSTEM_PROMPT + NO_RULES
    for row in inputs["lookups"]:
        topics = [*row["keyword_topics"], "parents"]
        inp = replace(inputs["route_inputs"][row["id"]], topics=topics)
        assert q.route_messages(row, topics, prompts["route"])[1]["content"] == build_user_message(inp), row["id"]


def test_quant_lookups_take_production_inputs_not_hand_labels():
    from base import guard
    from base.policy import UserPolicy
    from base.router import RULE_KINDS
    from base.workspace.agent import TOPICS_GRADING
    from eval.run_eval import production_labels

    q = _quant()
    inputs = _quant_inputs(q)
    items = {i["id"]: i for i in map(json.loads, (q.REPO / "eval" / "tasks.jsonl").read_text().splitlines())}
    policy = UserPolicy.load(q.REPO / "eval" / "user_policy.yaml")
    roster = guard.load_roster(q.REPO / "eval" / "roster.json")
    assert [sum(r["expected"] == d for r in inputs["lookups"]) for d in q.DECISIONS] == [5, 5, 5, 5]
    for row in inputs["lookups"]:
        item = items[row["id"]]
        kind, job_topics = production_labels(item)  # what eval/run_eval.py release_item sends
        assert row["result_kind"] == kind and row["keyword_topics"][: len(job_topics)] == job_topics
        assert row["result_kind"] not in RULE_KINDS
        assert set(row["keyword_topics"]) <= set(policy.never_share) | set(TOPICS_GRADING)  # no other hand labels
        assert not guard.find_names(row["text"], roster) and not guard.find_identifiers(row["text"])
    graded = [r for r in inputs["lookups"] if r["result_kind"] == "per_student"]
    assert graded and all(r["keyword_topics"][:2] == TOPICS_GRADING for r in graded)  # the grading job's topics
    assert all(not guard.find_names(e["tagged"], roster) for e in inputs["essays"])
    extra = inputs["topic_items"]
    assert extra and not {r["id"] for r in extra} & {r["id"] for r in inputs["lookups"]}
    assert all(r["labels"] for r in extra) and len(inputs["lookups"]) + len(extra) <= q.N_TOPICS


def test_quant_lookups_read_the_request_as_egress_does():
    from base import guard
    from base.policy import UserPolicy

    q = _quant()
    policy = UserPolicy.load(q.REPO / "eval" / "user_policy.yaml")
    roster = guard.load_roster(q.REPO / "eval" / "roster.json")

    def lookup(id, request, result):
        item = {"id": id, "request": request, "result": result, "result_kind": "free_text", "expected": "ask_user"}
        return q.production_input(item, roster, guard.TagMap(seed=0), policy)

    # A never-share word only in the request asks (request:iep), as on the device, never refuses.
    row, inp = lookup("x1", "Which students have an IEP?", "Two students, both tagged.")
    assert inp.request_blocked == ["iep"] and row["topic_pass"]
    results = {"Q4_K_M": {"lookups": [{"id": "x1", "got": "share_tagged", "topics": []}]}}
    q.final_decisions(results, {"x1": inp}, policy)
    assert results["Q4_K_M"]["lookups"][0]["final"] == "ask_user"

    # The raw request is scanned too ("avenue" is inside the tagged address) and its address is a hit.
    row, inp = lookup("x2", "Mail the reading goals to 1200 Oak Avenue.", "Two books a month.")
    assert "[Address 1]" in row["request"] and inp.request_blocked == ["home_address"]
    assert row["hit_kinds"] == ["address"]

    # Egress skips the request-topic pass when the result's own never-share topic refuses.
    row, _inp = lookup("x3", "A note home.", "One student has an IEP meeting Friday.")
    assert row["topic_pass"] is False and "iep" in row["keyword_topics"]


def test_quant_jobs_run_the_shipped_prompts_and_the_router_floors(tmp_path, monkeypatch):
    from base.policy import UserPolicy

    q = _quant()
    inputs = _quant_inputs(q)
    payload = {"prompts": q.shipped_prompts(inputs["request_topics"]), **{k: inputs[k] for k in q.PAYLOAD_KEYS}}
    calls = []

    def fake_chat(url, messages, schema, max_tokens=2500):
        name = schema.get("name", "grade")
        calls.append((name, messages, max_tokens))
        if name == "request_topics":
            return {"topics": ["parents"]}, {}  # every request, so a skipped topic pass shows
        if name == "route":
            return {"decision": "share_tagged", "reason": "r"}, {}
        if name == "person_names":
            return {"names": []}, {}
        return {"scores": {"ideas": 4, "organization": 4, "evidence": 4, "conventions": 5}, "total": 99}, {}

    monkeypatch.setattr(q, "chat", fake_chat)
    out = q.run_jobs("http://127.0.0.1:1", payload, None)
    counts = {n: sum(c[0] == n for c in calls) for n in ("person_names", "request_topics", "route", "grade")}
    assert counts == {"person_names": 20, "request_topics": 20 + len(inputs["topic_items"]), "route": 20, "grade": 10}
    assert {c[2] for c in calls if c[0] == "grade"} == {3000} and out["grades"][0]["total"] == 16  # clamped, recomputed
    first_grade = next(c[1] for c in calls if c[0] == "grade")
    assert first_grade[1]["content"].startswith("Teacher's instructions:\nGrade each essay against rubric.md")
    results = {"Q4_K_M": out | {"size_bytes": 1, "file": "x", "repo": "r"}}
    q.final_decisions(results, inputs["route_inputs"], UserPolicy.load(q.REPO / "eval" / "user_policy.yaml"))
    finals = {r["id"]: r["final"] for r in out["lookups"]}
    blocked = [r["id"] for r in inputs["lookups"] if r["blocked"]]
    assert blocked and all(finals[i] == "refuse" for i in blocked)  # never-share floors apply on the laptop
    skipped = {r["id"] for r in inputs["lookups"] if not r["topic_pass"]}
    assert skipped and all(r["topics"] == ([] if r["id"] in skipped else ["parents"]) for r in out["lookups"])
    routed = [c[1][1]["content"] for c in calls if c[0] == "route"]
    assert sum("Topics: " in m and "parents" in m.split("Topics: ")[1].split("\n")[0] for m in routed) == 20 - len(skipped)
    s = q.score(out)
    assert s["lookup_accuracy"] == 0.25 and s["final_accuracy"] > s["lookup_accuracy"] and s["topics_n"] == len(out["topics"])
    report = tmp_path / "quantization.md"
    q.write_report(results, "cmd", report)
    text = report.read_text()
    assert "Lookups correct after the router's rule path and floors" in text
    assert "These are in-sample" in text and "eval/reports/request_topics.md" in text and "\u2014" not in text
