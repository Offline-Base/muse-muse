"""Mode 2 (ask_device's agent) and the passage search under both modes. Models are scripted fakes."""

from __future__ import annotations

import dataclasses

import pytest

from base.config import load_settings
from base.workspace.ask import NOT_FOUND, DeviceAsk
from base.workspace.index import MAX_PIECES_PER_DOC, DocumentIndex, Snippet
from base.workspace.rag import Rag

REAL = "Corwin Ashgrove"  # invented
TAG = "[Student A]"


class TagMap:
    def __init__(self):
        self.values = {TAG: REAL}


class ScriptedLLM:
    """Replies from a list in order, and records every user message."""

    is_cloud = False

    def __init__(self, replies):
        self.replies, self.seen = list(replies), []

    def chat_json(self, messages, schema, **kw):
        self.seen.append(messages[-1]["content"])
        return self.replies.pop(0)


class FakeIndex:
    def __init__(self, rounds):
        self.rounds, self.queries = list(rounds), []

    def passages(self, queries, k=20, folder=None):
        self.queries.append(list(queries))
        return self.rounds.pop(0)


@pytest.fixture(autouse=True)
def plain_guard(monkeypatch):
    """Tag and restore by the one invented name, so the test sees exactly what the model sees."""
    from base import guard

    monkeypatch.setattr(guard, "tag", lambda text, roster, tagmap, **kw: type("R", (), {"text": text.replace(REAL, TAG)})())
    monkeypatch.setattr(guard, "restore", lambda text, tagmap: text.replace(TAG, REAL))


def rag_with(llm):
    return Rag(llm, roster=None, tagmap=TagMap())


P1 = Snippet("essays/a.md", f"{REAL} essay", f"{REAL} says tide pools are alive with crabs.", 1.0)
P2 = Snippet("essays/b.md", "Garden", "Tomatoes grow best in full sun.", 0.5)


def ask_with(replies, rounds_of_passages, **kw):
    llm = ScriptedLLM(replies)
    index = FakeIndex(rounds_of_passages)
    return DeviceAsk(rag_with(llm), index, **kw), llm, index


def answer(text, quotes=(), enough=True, more=()):
    return {"enough": enough, "more_queries": list(more), "answer": text, "quotes": [{"passage": n, "quote": q} for n, q in quotes]}


def test_answer_and_quotes_are_tagged_for_the_model_and_restored_for_egress():
    asker, llm, index = ask_with(
        [{"parts": [f"What did {TAG} see?"]}, {"queries": ["tidepool animals"]}, answer(f"{TAG} saw crabs.", [(1, "tide pools are alive")])],
        [[P1, P2]],
    )
    r = asker.run(f"What did {REAL} see?")
    assert index.queries == [[f"What did {REAL} see?", "tidepool animals"]]
    assert REAL not in llm.seen[2] and TAG in llm.seen[2]  # the model only sees tags
    assert llm.seen[2].rstrip().endswith(f"Question: What did {TAG} see?")  # the question comes last
    assert r.answer == f"{REAL} saw crabs." and r.quotes == [(f"{REAL} essay", "tide pools are alive")]
    assert r.sources == ["essays/a.md", "essays/b.md"] and (r.parts, r.answered) == (1, 1)


def test_a_made_up_quote_is_dropped():
    asker, _llm, _i = ask_with(
        [{"parts": ["q"]}, {"queries": []}, answer("Crabs.", [(1, "the octopus waved"), (9, "crabs")])], [[P1]]
    )
    assert asker.run("What lives there?").quotes == []


def test_it_keeps_searching_with_new_words_until_it_finds_something():
    asker, _llm, index = ask_with(
        [
            {"parts": ["q1"]},
            {"queries": ["q2"]},
            answer(NOT_FOUND, enough=False),  # nothing in the first passages, and no ideas
            {"queries": ["q3"]},  # so the device writes new queries itself
            answer("Tomatoes like sun.", [(1, "full sun")]),
        ],
        [[P1], [P2]],
    )
    r = asker.run("q1")
    assert index.queries == [["q1", "q2"], ["q1", "q2", "q3"]]
    assert r.answer == "Tomatoes like sun." and r.quotes == [("Garden", "full sun")]


def test_a_later_round_never_replaces_an_answer():
    asker, _llm, _i = ask_with(
        [{"parts": ["q1"]}, {"queries": []}, answer("Crabs live there.", enough=False, more=["q9"]), answer(NOT_FOUND)],
        [[P1], [P2]],
    )
    assert asker.run("q1").answer == "Crabs live there."


def test_a_request_with_parts_gets_one_combined_answer():
    asker, llm, _i = ask_with(
        [
            {"parts": [f"What did {TAG} see?", "What grows in sun?"]},
            {"queries": []},
            answer(f"{TAG} saw crabs.", [(1, "tide pools are alive")]),
            {"queries": []},
            answer("Tomatoes.", [(1, "full sun")]),
            {"answer": f"{TAG} saw crabs, and tomatoes like sun."},
        ],
        [[P1], [P2]],
    )
    r = asker.run(f"What did {REAL} see, and what grows in sun?")
    assert r.parts == 2 and r.answered == 2
    assert r.answer == f"{REAL} saw crabs, and tomatoes like sun."
    assert [q for _t, q in r.quotes] == ["tide pools are alive", "full sun"]
    assert REAL not in llm.seen[-1]  # the combining step sees tags too


def test_time_runs_out_between_parts():
    asker, _llm, _i = ask_with(
        [{"parts": ["a", "b"]}, {"queries": []}, answer("A.", [(1, "crabs")]), {"answer": "A, and b was not searched."}],
        [[P1]],
        deadline_seconds=0,
    )
    r = asker.run("a and b")
    assert r.timed_out and r.parts == 2


def test_no_passages_anywhere_means_not_found():
    asker, _llm, _i = ask_with([{"parts": ["x"]}, {"queries": []}, {"queries": []}], [[]])
    assert asker.run("anything").answer == NOT_FOUND


def test_split_failure_asks_the_request_whole():
    class Down(ScriptedLLM):
        def chat_json(self, messages, schema, **kw):
            if schema["name"] == "request_parts":
                raise RuntimeError("no server")
            return super().chat_json(messages, schema, **kw)

    asker = DeviceAsk(rag_with(Down([{"queries": []}, answer("Crabs.")])), FakeIndex([[P1]]))
    assert asker.run("whole question").parts == 1


def test_the_runner_finishes_a_job_and_keeps_its_sources():
    from base.workspace.ask import AskRunner

    class Jobs:
        def __init__(self):
            self.rows, self.n = {}, 0

        def active_count(self):
            return 0

        def create(self, kind, instructions, folder):
            self.n += 1
            self.rows[str(self.n)] = {"kind": kind, "instructions": instructions, "status": "queued"}
            return str(self.n)

        def start(self, job_id):
            self.rows[job_id]["status"] = "running"

        def finish(self, job_id, raw, kind, summary=None, topics=(), sources=()):
            self.rows[job_id].update(status="done", raw_result=raw, result_kind=kind, sources=list(sources))

        def fail(self, job_id, error):
            self.rows[job_id].update(status="failed", error=error)

    jobs = Jobs()
    asker, _llm, _i = ask_with([{"parts": ["q"]}, {"queries": []}, answer("Crabs.", [(1, "crabs")])], [[P1]])
    runner = AskRunner(asker, jobs)
    job_id = runner.run_sync("q", "q (tagged request)", None)
    row = jobs.rows[job_id]
    assert row["status"] == "done" and row["kind"] == "ask" and row["instructions"] == "q (tagged request)"
    assert row["raw_result"].startswith("Answer: Crabs.") and '"crabs"' in row["raw_result"]
    assert row["sources"] == ["essays/a.md"]  # in the job row, not in the runner's memory


def test_rewritten_queries_are_restored_and_a_failure_searches_the_question_only():
    rag = rag_with(ScriptedLLM([{"queries": [f"{TAG} tide pools", "q", "Q", "x", "y"]}]))
    # only the model's first 3 count, and repeats of the question (any case) are dropped
    assert rag.queries("q") == ["q", f"{REAL} tide pools"]

    class Down(ScriptedLLM):
        def chat_json(self, *a, **kw):
            raise RuntimeError("no server")

    assert rag_with(Down([])).queries("only this") == ["only this"]


# index.passages


def make_index(tmp_path, files):
    root = tmp_path / "w"
    root.mkdir()
    (root / ".synthetic").write_text("invented\n")
    for name, body in files.items():
        (root / name).write_text(body)
    s = load_settings({"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(root), "OPENROUTER_API_KEY": "k"})
    return DocumentIndex(dataclasses.replace(s, pdftotext_bin=None))


def test_passages_rank_pieces_and_cap_each_document(tmp_path):
    long_text = " ".join(f"Shark fact {i}: sharks have rows of teeth." for i in range(200))
    index = make_index(tmp_path, {"long.md": long_text, "other.md": "One shark visited the reef once."})
    found = index.passages("shark teeth", k=10)
    by_doc = [p.doc_id for p in found]
    assert by_doc.count("long.md") == MAX_PIECES_PER_DOC and "other.md" in by_doc
    assert all(len(p.text) <= 800 for p in found)


def test_passages_fuse_several_queries(tmp_path):
    index = make_index(tmp_path, {"a.md": "Tide pools hold crabs.", "b.md": "The garden grows tomatoes."})
    assert {p.doc_id for p in index.passages(["crabs", "tomatoes"])} == {"a.md", "b.md"}
    assert index.passages(["  "]) == []


def test_a_part_that_touches_a_never_share_topic_is_held_and_the_rest_goes():
    llm = ScriptedLLM(
        [
            {"parts": ["What grows in sun?", "Who has an IEP?"]},
            {"queries": []},
            answer("Tomatoes.", [(1, "full sun")]),
            {"queries": []},
            answer("[Student A] has an IEP for reading.", [(1, "IEP")]),
            {"answer": "Tomatoes grow in sun."},
        ]
    )
    asker = DeviceAsk(rag_with(llm), FakeIndex([[P2], [P1]]), never_share={"iep": ["IEP"]})
    r = asker.run("What grows in sun, and who has an IEP?")
    assert r.answered == 1 and [q for _t, q in r.quotes] == ["full sun"]
    assert "IEP for reading" not in llm.seen[-1]  # the held answer never reaches the combine step
    assert r.answer.endswith("One part of the request was kept on your device because it touches a topic you never share.")
