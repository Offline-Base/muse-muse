"""scripts/model_matrix.py: configs, the paired statistics, resume, the preflight and the cloud
refusals. Every model server is mocked (respx); all items are invented."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import respx

from base import config as base_config
from base.config import REPO_ROOT, CloudBackendRefused
from base.local_llm import LocalLLM
from base.router import lfm_labels, routing_mode
from eval import run_eval
from scripts import model_matrix as mm

LFM = "http://127.0.0.1:8083/v1"
SIDE = "http://127.0.0.1:8091/v1"
TASKS = REPO_ROOT / "eval" / "tasks.jsonl"


@pytest.fixture
def environ(tmp_path):
    (tmp_path / "workspace").mkdir()
    return {"BASE_HOME": str(tmp_path / "home"), "WORKSPACE_ROOT": str(tmp_path / "workspace"), "CHECKER_API_KEY": "k"}


def opts(**kw):
    p, o = mm.parse(["--name", "t", "--configs", "policy_lfm", *kw.pop("argv", [])])
    for k, v in kw.items():
        setattr(o, k, v)
    return o


def _schema_name(body):
    return ((body.get("response_format") or {}).get("json_schema") or {}).get("name")


def model_reply(request, decision="ask_user"):
    """A llama-server answering each pass the device makes: names, request labels, the router, a summary."""
    body = json.loads(request.content)
    name = _schema_name(body)
    content = {
        "person_names": '{"names": []}',
        "request_topics": '{"topics": []}',
        "route": json.dumps({"decision": decision, "reason": "Asked first."}),
    }.get(name, "Most of the class met the goal.")
    usage = {"prompt_tokens": 100, "completion_tokens": 20, "completion_tokens_details": {"reasoning_tokens": 5}}
    return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": content}}], "usage": usage})


def write_set(path: Path, n: int) -> Path:
    items = run_eval.load_items(TASKS)[:n]
    path.write_text("".join(json.dumps(i) + "\n" for i in items))
    return path


# ----- configs -----


@pytest.mark.parametrize(
    ("name", "mode"),
    [("keywords", "rules"), ("policy_lfm", "rules"), ("lfm_tighten", "tighten"), ("lfm_decide", "decide"),
     ("glimmer_labels", "rules"), ("glimmer_tighten", "tighten"), ("glimmer_decide", "decide"),
     ("base_cloud_tighten", "tighten"), ("base_cloud_decide", "decide")],
)  # fmt: skip
def test_every_config_is_device_only_with_lfm_labels(environ, name, mode):
    s = mm.settings_for(mm.CONFIGS[name], opts(), {**environ, "PRIMARY_MODEL": "glimmer", "DREAMING_BACKEND": "local_lora"})
    assert s.device_only and s.primary_model == "lfm" and s.checker_backend == "lfm"
    assert s.router_url == s.checker_url == LFM  # the side port is a client swap, never a setting
    assert routing_mode(s) == mode
    assert lfm_labels(s)  # checked labels on every row, so rows differ in who decides


def test_reasoning_and_budget_are_a_per_process_override(environ):
    s = mm.settings_for(mm.CONFIGS["glimmer_decide"], opts(reasoning="high", max_tokens=3000), environ)
    assert s.router_reasoning == "high" and s.router_max_tokens == 3000


def test_customize_keeps_device_only_while_swapping_the_client(environ, tmp_path):
    from base.services import Services

    o = opts(glimmer_url=SIDE, glimmer_model="glimmer")
    for name in ("glimmer_decide", "glimmer_labels", "keywords"):
        s = run_eval.prepare_home(mm.settings_for(mm.CONFIGS[name], o, environ), tmp_path / name)
        services = Services.for_eval(s)
        lfm = services.checker_llm
        swaps = mm.Swaps()
        mm.customize_for(mm.CONFIGS[name], o, swaps)(services)
        assert services.settings.device_only and services.settings is s
        if name == "glimmer_decide":
            assert isinstance(services.router.llm, LocalLLM) and services.router.llm.base_url == SIDE
            assert not services.router.llm.liquid and not services.router.llm.is_cloud  # Glimmer's body
            assert services.checker_llm is lfm  # labels and the name pass stay on LFM
        elif name == "glimmer_labels":
            assert services.router.llm is services.router_llm  # the router stays as it was
            assert services.checker_llm.labeler.base_url == SIDE and services.checker_llm.llm_names == lfm.llm_names
        else:
            assert services.checker_llm is None and services.answer_llm is None
            assert isinstance(services.router.llm, mm.NoModel)
        swaps.undo()
        assert services.checker_llm is lfm and services.router.llm is services.router_llm
        services.close()


def test_glimmer_url_must_be_this_device(environ):
    with pytest.raises(mm.MatrixError):
        mm.glimmer_client(mm.settings_for(mm.CONFIGS["glimmer_decide"], opts(), environ), "http://192.0.2.10:8091/v1")


@pytest.mark.parametrize(
    ("argv", "says"),
    [(["--configs", "base_cloud_decide"], "--allow-cloud"),
     (["--configs", "base_cloud_decide", "--allow-cloud"], "--max-usd is 0"),
     (["--configs", "base_cloud_decide", "--allow-cloud", "--max-usd", "1", "--sets", "SET"], "only read invented sets in eval/"),
     (["--configs", "glimmer_decide"], "--glimmer-url"),
     (["--configs", "glimmer_decide", "--glimmer-url", "http://192.0.2.7:8091/v1"], "this device")],
)  # fmt: skip
def test_refusals_before_anything_runs(environ, tmp_path, capsys, argv, says):
    outside = write_set(tmp_path / "mine.jsonl", 1)
    argv = [str(outside) if a == "SET" else a for a in argv]
    with respx.mock(assert_all_called=False) as mock:
        assert mm.main(["--name", "r", "--out", str(tmp_path / "out"), *argv], environ) == 1
        assert not mock.calls
    assert says in capsys.readouterr().err
    assert not (tmp_path / "out").exists()


# ----- statistics -----


def test_mcnemar_exact_on_known_counts():
    assert mm.mcnemar_p(0, 0) == 1.0
    assert mm.mcnemar_p(5, 5) == 1.0
    assert mm.mcnemar_p(0, 6) == pytest.approx(2 / 64)
    assert mm.mcnemar_p(1, 9) == pytest.approx(2 * 11 / 1024)  # C(10,0) + C(10,1)
    assert mm.mcnemar_p(9, 1) == mm.mcnemar_p(1, 9)
    assert mm.mcnemar_p(2, 3) == 1.0  # capped


def _r(id, expected, decision, fallback=False):
    return {"id": id, "expected": expected, "decision": decision, "fallback": fallback}


def test_fixed_and_broke_join_on_item_ids():
    base = [_r("a", "refuse", "refuse"), _r("b", "ask_user", "refuse"), _r("c", "share_tagged", "share_tagged"),
            _r("d", "refuse", "ask_user"), _r("e", "ask_user", "ask_user", fallback=True)]  # fmt: skip
    other = [_r("e", "ask_user", "ask_user"), _r("d", "refuse", "refuse"), _r("c", "share_tagged", "ask_user"),
             _r("b", "ask_user", "refuse"), _r("z", "refuse", "refuse")]  # fmt: skip
    fixed, broke = mm.paired(base, other)
    assert fixed == ["e", "d"]  # a fallback is never right, so its real answer later is a fix
    assert broke == ["c"]  # "a" was not scored here, "z" not in the baseline: neither counts


# ----- full runs, servers mocked -----


def test_keywords_row_calls_no_model_at_all(environ, tmp_path):
    items = write_set(tmp_path / "set.jsonl", 4)
    with respx.mock(assert_all_called=False) as mock:  # any request at all would be unmocked and fail
        code = mm.main(["--name", "kw", "--configs", "keywords", "--sets", str(items), "--out", str(tmp_path / "out")], environ)
        assert not mock.calls
    assert code == 0
    rows = [json.loads(line) for line in (tmp_path / "out" / "raw" / "matrix_kw_keywords_set.jsonl").read_text().splitlines()]
    assert len(rows) == 4 and all(r["router_calls"] == 0 and not r["fallback"] for r in rows)


def test_a_matrix_run_writes_one_report_with_paired_columns(environ, tmp_path):
    out = tmp_path / "out"
    with respx.mock(assert_all_called=False) as mock:
        lfm = mock.post(f"{LFM}/chat/completions").mock(side_effect=model_reply)
        side = mock.post(f"{SIDE}/chat/completions").mock(side_effect=lambda r: model_reply(r, "refuse"))
        code = mm.main(["--name", "unit", "--configs", "keywords,policy_lfm,lfm_decide,glimmer_decide", "--sets",
                        str(TASKS), "--limit", "6", "--glimmer-url", SIDE, "--reasoning", "medium", "--out", str(out)],
                       environ)  # fmt: skip
    assert code in (0, 2)
    assert lfm.called and side.called
    glimmer_body = json.loads(side.calls.last.request.content)
    assert glimmer_body["chat_template_kwargs"] == {"reasoning_strength": "medium"}
    assert all("chat_template_kwargs" not in json.loads(c.request.content) for c in lfm.calls)  # LFM's own body

    md = (out / "matrix_unit.md").read_text()
    assert md.startswith("# Model matrix: unit\n\nCommand: `uv run python -m scripts.model_matrix --name unit")
    assert "| Config | Decision accuracy | Leaks | Held by the final check | Approval requests | Needless asks" in md
    assert "Fixed / broke vs policy_lfm | McNemar p | Beats policy_lfm |" in md
    assert "| policy_lfm |" in md and "| baseline |" in md and "| glimmer_decide |" in md
    assert "Model fixed versus broke" in md and "All items invented; teacher decisions are simulated" in md
    assert "## Holdout: 2 of the 20 holdout items, scored inside the tasks.jsonl run" in md  # t001 and t006
    assert "/Users/" not in md and str(Path.home()) not in md and "pytest-of" not in md
    assert "\u2014" not in md

    raw_dir = out / "raw"
    for name in ("keywords", "policy_lfm", "lfm_decide", "glimmer_decide"):
        raw = (raw_dir / f"matrix_unit_{name}_tasks.jsonl").read_text()
        assert len(raw.splitlines()) == 6 and "request" not in raw.replace('"request_', "")
        assert json.loads((raw_dir / f"matrix_unit_{name}_tasks.summary.json").read_text())["n"] == 6
    decided = [json.loads(line) for line in (raw_dir / "matrix_unit_glimmer_decide_tasks.jsonl").read_text().splitlines()]
    assert any(r["router_calls"] == 1 and r["reasoning_tokens"] == 5 for r in decided)


def test_holdout_is_scored_as_a_subset_of_the_tasks_run():
    rows = [{"id": i["id"], "expected": i["expected"], "wants": i["expected"], "decision": i["expected"],
             "status": "shared", "source": "rule", "fallback": False, "leaked": False, "latency_ms": 1}
            for i in run_eval.load_items(TASKS)]  # fmt: skip
    report = run_eval.rescore(rows, run_eval.EvalReport(name="x"))
    holdout = {i["id"] for i in run_eval.load_items(REPO_ROOT / "eval" / "holdout.jsonl")}
    sub = run_eval.subset(report, holdout)
    assert sub.n == 20 and sub.correct == 20 and {r["id"] for r in sub.rows} == holdout


class Crash(Exception):
    pass


def fake_runner(calls, crash_after=None):
    def run_items(config, settings, o, items, *, name, on_row=None):
        calls.append([i["id"] for i in items])
        rows = []
        for n, item in enumerate(items):
            if crash_after is not None and n == crash_after:
                raise Crash()
            row = {"id": item["id"], "expected": item["expected"], "wants": item["expected"], "decision": "ask_user",
                   "status": "waiting", "source": "rule", "floors": [], "fallback": False, "leaked": False,
                   "leak_kinds": [], "latency_ms": 1, "release_ms": 2, "router_calls": 0}  # fmt: skip
            rows.append(row)
            if on_row is not None:
                on_row(row)
        return rows

    return run_items


def test_resume_picks_up_a_partial_raw_file_and_skips_a_finished_config(environ, tmp_path, monkeypatch):
    items = write_set(tmp_path / "set.jsonl", 5)
    argv = ["--name", "res", "--configs", "policy_lfm", "--sets", str(items), "--out", str(tmp_path / "out")]
    calls: list = []
    monkeypatch.setattr(mm, "run_items", fake_runner(calls, crash_after=2))
    with pytest.raises(Crash):
        mm.main(argv, environ)
    raw = tmp_path / "out" / "raw" / "matrix_res_policy_lfm_set.jsonl"
    assert len(raw.read_text().splitlines()) == 2
    assert not raw.with_name("matrix_res_policy_lfm_set.summary.json").exists()

    monkeypatch.setattr(mm, "run_items", fake_runner(calls))
    assert mm.main([*argv, "--resume"], environ) == 0
    ids = [i["id"] for i in run_eval.load_items(items)]
    assert calls[-1] == ids[2:]  # only what was missing
    assert [json.loads(line)["id"] for line in raw.read_text().splitlines()] == ids

    assert mm.main([*argv, "--resume"], environ) == 0
    assert len(calls) == 2  # finished on this commit and item list: nothing runs
    assert "(5/5)" not in (tmp_path / "out" / "matrix_res.md").read_text()  # all asks: 0 right
    assert "| policy_lfm | 0.0% (0/5) |" in (tmp_path / "out" / "matrix_res.md").read_text()

    assert mm.main([*argv, "--resume", "--limit", "3"], environ) == 0  # another item list: starts over
    assert calls[-1] == ids[:3]
    assert mm.main(argv, environ) == 0  # without --resume: always starts over
    assert calls[-1] == ids


def test_preflight_stops_when_the_side_port_serves_another_file(environ, tmp_path):
    gguf = tmp_path / "glimmer-iq1s.gguf"
    gguf.write_bytes(b"GGUF" + b"\0" * 64)
    with respx.mock(assert_all_called=False) as mock:
        mock.get("http://127.0.0.1:8083/health").mock(return_value=httpx.Response(200, json={"status": "ok"}))
        mock.get("http://127.0.0.1:8091/health").mock(return_value=httpx.Response(200, json={"status": "ok"}))
        mock.get("http://127.0.0.1:8091/props").mock(return_value=httpx.Response(200, json={"model_path": "/m/other.gguf"}))
        post = mock.post(f"{SIDE}/chat/completions").mock(side_effect=model_reply)
        code = mm.main(["--name", "pf", "--configs", "policy_lfm,glimmer_decide", "--sets", str(TASKS), "--limit", "2",
                        "--glimmer-url", SIDE, "--glimmer-gguf", str(gguf), "--preflight",
                        "--out", str(tmp_path / "out")], environ)  # fmt: skip
        assert code == 1 and not post.called
    assert not (tmp_path / "out" / "matrix_pf.md").exists()


def test_preflight_checks_the_sha256_against_the_model_file_report(environ, tmp_path, monkeypatch):
    gguf = tmp_path / "glimmer-iq1s.gguf"
    gguf.write_bytes(b"GGUF" + b"\0" * 64)
    reports = tmp_path / "reports"
    reports.mkdir()
    (reports / "model_file_g1.md").write_text("| What | Value |\n|---|---|\n| sha256 | " + "a" * 64 + " |\n")
    monkeypatch.setattr(mm, "REPORTS", reports)
    o = opts(glimmer_url=SIDE, glimmer_gguf=gguf, glimmer_label="g1")
    mm.check_configs([mm.CONFIGS["glimmer_decide"]], o, environ)
    assert o.glimmer_report_sha == "a" * 64 and o.glimmer_sha != o.glimmer_report_sha
    with respx.mock(assert_all_called=False) as mock:
        mock.get("http://127.0.0.1:8083/health").mock(return_value=httpx.Response(200))
        mock.get("http://127.0.0.1:8091/health").mock(return_value=httpx.Response(200))
        mock.get("http://127.0.0.1:8091/props").mock(return_value=httpx.Response(200, json={"model_path": str(gguf)}))
        s = mm.settings_for(mm.CONFIGS["glimmer_decide"], o, environ)
        problems = mm.server_problems([mm.CONFIGS["glimmer_decide"]], o, s)
    assert problems == ["glimmer-iq1s.gguf does not match the sha256 in its model file report"]


def test_preflight_stops_a_run_whose_model_is_down(environ, tmp_path):
    with respx.mock(assert_all_called=False) as mock:
        mock.get("http://127.0.0.1:8083/health").mock(return_value=httpx.Response(200))
        mock.post(f"{LFM}/chat/completions").mock(return_value=httpx.Response(400, json={"error": "no slot"}))
        code = mm.main(["--name", "down", "--configs", "lfm_decide", "--sets", str(TASKS), "--limit", "8",
                        "--preflight", "--out", str(tmp_path / "out")], environ)  # fmt: skip
    assert code == 1 and not (tmp_path / "out" / "raw" / "matrix_down_lfm_decide_tasks.jsonl").exists()


def test_cloud_config_runs_only_through_a_process_override_and_leaves_env_alone(environ, tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    env_file = repo / ".env"
    env_file.write_text("DEVICE_ONLY=1\nOPENROUTER_API_KEY=test-key\nDREAMING_BACKEND=rules\n")
    before = env_file.read_bytes()
    monkeypatch.setattr(base_config, "REPO_ROOT", repo)
    env = {**environ, "ROSTER_PATH": str(REPO_ROOT / "eval" / "roster.json"),
           "USER_POLICY": str(REPO_ROOT / "eval" / "user_policy.yaml")}  # fmt: skip
    usage = iter([0.10, 0.12, 0.13, 0.14])
    with respx.mock(assert_all_called=False) as mock:
        mock.post(f"{LFM}/chat/completions").mock(side_effect=model_reply)
        cloud = mock.post("https://openrouter.ai/api/v1/chat/completions").mock(side_effect=model_reply)
        mock.get("https://openrouter.ai/api/v1/key").mock(
            side_effect=lambda r: httpx.Response(200, json={"data": {"usage": next(usage)}})
        )
        code = mm.main(["--name", "cl", "--configs", "base_cloud_decide", "--sets", str(TASKS), "--limit", "8",
                        "--allow-cloud", "--max-usd", "1", "--out", str(tmp_path / "out")], env)  # fmt: skip
    assert code in (0, 2) and cloud.called
    assert env_file.read_bytes() == before
    sent = cloud.calls.last.request
    assert sent.headers["authorization"] == "Bearer test-key"
    assert json.loads(sent.content)["reasoning"] == {"effort": "low"}  # Glimmer's OpenRouter body
    md = (tmp_path / "out" / "matrix_cl.md").read_text()
    assert "spent $0.0" in md and "test-key" not in md


def test_the_cloud_client_still_refuses_unmarked_calls(environ):
    s = mm.settings_for(mm.CONFIGS["base_cloud_decide"], opts(), environ)
    client = mm.cloud_client(s, "test-key", "https://openrouter.ai/api/v1", "meta/muse-glimmer-30b")
    with respx.mock(assert_all_called=False) as mock:
        with pytest.raises(CloudBackendRefused):
            client.chat([{"role": "user", "content": "hi"}])
        assert not mock.calls


def test_the_cost_cap_stops_a_cloud_run():
    spent = iter([1.00, 1.40, 2.10])
    with respx.mock(assert_all_called=False) as mock:
        mock.get("https://openrouter.ai/api/v1/key").mock(
            side_effect=lambda r: httpx.Response(200, json={"data": {"usage": next(spent)}})
        )
        meter = mm.CostMeter("https://openrouter.ai/api/v1", "test-key", 1.0)
        meter.check()
        assert meter.spent == pytest.approx(0.40)
        with pytest.raises(mm.CostCapReached):
            meter.check()
        mock.get("https://openrouter.ai/api/v1/key").mock(return_value=httpx.Response(401))
        with pytest.raises(mm.MatrixError, match="cost cap cannot hold"):
            mm.CostMeter("https://openrouter.ai/api/v1", "test-key", 1.0)


def test_report_command_shows_paths_outside_the_repo_by_name_only():
    argv = ["--glimmer-gguf", "/Users/someone/models/g.gguf", "--glimmer-gguf=/Users/someone/models/h.gguf",
            "--sets", str(TASKS), "eval/holdout.jsonl", "--out", "~/reports", "--glimmer-url", SIDE]  # fmt: skip
    assert mm._shown_argv(argv) == ["--glimmer-gguf", "g.gguf", "--glimmer-gguf=h.gguf", "--sets", "eval/tasks.jsonl",
                                    "eval/holdout.jsonl", "--out", "reports", "--glimmer-url", SIDE]  # fmt: skip
