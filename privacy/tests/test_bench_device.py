"""scripts/bench_device.py: parsing, the memory precheck, the drafter math, the report's safety, and
full runs on a fake llama-server (a script that prints buffer lines and sleeps; /health and the
completions are respx mocks, so nothing binds a port and no model is called)."""

from __future__ import annotations

import importlib.util
import json
import os
import re
import signal
import stat

import httpx
import pytest
import respx

from base import config as base_config
from base.config import REPO_ROOT
from scripts import bench_device as bd
from tests.gguf_helpers import glimmer_like


@pytest.fixture(autouse=True)
def _pre_ruling_settings(monkeypatch):
    """The bench's LFM runs (--kind lfm) start from LFM settings. The Nov 2 ruling made load_settings refuse LFM settings
    (tests/test_config.py); these tests keep that code tested with the pre-ruling loader until the
    owner decides whether to delete it."""
    monkeypatch.setattr(bd, "load_settings", base_config._load_settings_for_tests)


MAC_LOG = """\
load_tensors: offloading 16 repeating layers to GPU
load_tensors: offloaded 17/17 layers to GPU
load_tensors:   CPU_Mapped model buffer size =   100.50 MiB
load_tensors: Metal_Mapped model buffer size =  1000.00 MiB
llama_kv_cache:      Metal KV buffer size =    64.00 MiB
llama_memory_recurrent:      Metal RS buffer size =     2.00 MiB
llama_context:      Metal compute buffer size =   300.25 MiB
llama_context:        CPU compute buffer size =    12.00 MiB
"""


def test_buffer_and_layer_lines_are_summed_per_kind():
    assert bd.parse_buffers(MAC_LOG) == {"model": 1100.5, "KV": 64.0, "RS": 2.0, "compute": 312.2, "offloaded": "17/17"}
    assert bd.parse_buffers("nothing here") == {}


def test_proc_files_vm_stat_pmset_vcgencmd_and_tegrastats_parse_from_fixtures():
    status = "Name:\tllama-server\nVmHWM:\t 6291456 kB\nVmRSS:\t 6000000 kB\n"
    assert bd.parse_kb_lines(status) == {"VmHWM": 6291456 * 1024, "VmRSS": 6000000 * 1024}
    meminfo = "MemTotal:        7620000 kB\nMemFree:          100000 kB\nMemAvailable:     900000 kB\n"
    assert bd.parse_kb_lines(meminfo)["MemAvailable"] == 900000 * 1024
    vm = ("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      1000.\n"
          "Pages active:   9999.\nPages inactive:   200.\nPages speculative:   50.\n")  # fmt: skip
    assert bd.parse_vm_stat(vm) == 1250 * 16384 and bd.parse_vm_stat("") is None
    assert bd.parse_pmset("Now drawing from 'AC Power'\n -InternalBattery-0 18%; charging") == ("plugged", "AC Power")
    assert bd.parse_pmset("Now drawing from 'Battery Power'")[0] == "battery"
    assert bd.parse_pmset("")[0] == "unknown"
    assert bd.parse_throttled("throttled=0x0") == "0x0 (none)"
    assert bd.parse_throttled("throttled=0x50005") == "0x50005 (under-voltage now, throttled now, under-voltage since boot, throttled since boot)"
    assert bd.parse_temp("temp=48.3'C") == 48.3 and bd.parse_temp(None) is None
    line = "RAM 2519/7620MB (lfb 2x4MB) SWAP 0/3810MB CPU [5%@729,0%@729] GR3D_FREQ 61% cpu@48C"
    assert bd.parse_tegrastats(line) == "RAM 2519/7620 MB, GPU 61%" and bd.parse_tegrastats("") is None


def supply(root, name, kind, online=None, status=None):
    d = root / name
    d.mkdir(parents=True)
    (d / "type").write_text(kind + "\n")
    if online is not None:
        (d / "online").write_text(online + "\n")
    if status is not None:
        (d / "status").write_text(status + "\n")


def test_linux_power_from_sys(tmp_path):
    assert bd.linux_power(tmp_path / "none")[0] == "plugged"  # a Pi or a Jetson: no battery, on its supply
    supply(tmp_path / "a", "BAT0", "Battery", status="Discharging")
    supply(tmp_path / "a", "AC", "Mains", online="0")
    assert bd.linux_power(tmp_path / "a")[0] == "battery"
    supply(tmp_path / "b", "usb", "USB", online="1")
    assert bd.linux_power(tmp_path / "b") == ("plugged", "USB supply online")
    supply(tmp_path / "c", "BAT0", "Battery", status="Unknown")
    assert bd.linux_power(tmp_path / "c")[0] == "unknown"


def test_llama_bench_jsonl_and_the_free_port():
    out = '{"n_prompt": 512, "n_gen": 0, "avg_ts": 2400.51, "stddev_ts": 10.2, "model_filename": "/x/m.gguf"}\n' \
          '{"n_prompt": 0, "n_gen": 128, "avg_ts": 180.04, "stddev_ts": 1.1}\nnot json\n'  # fmt: skip
    rows = bd.parse_llama_bench(out)
    assert [(r["step"], r["tokens_per_s"]) for r in rows] == [("pp512", 2400.5), ("tg128", 180.0)]
    assert "model_filename" not in rows[0]
    picks = iter([8083, 8081, 8085, 9200])
    assert bd.free_port(lambda: next(picks)) == 9200


def test_precheck_skips_with_a_reason_instead_of_running_out_of_memory():
    g = bd.GIB
    assert bd.precheck({"model": 1 * g}, None, None, 1) == (None, None)  # memory unknown: try
    model, draft = bd.precheck({"model": int(6.1 * g), "draft": int(1.6 * g)}, int(0.2 * g), int(7.4 * g), 1)
    assert model is None and draft.startswith("the drafter does not fit on this board")
    model, draft = bd.precheck({"model": int(6.1 * g), "mmproj": int(0.5 * g)}, int(0.2 * g), int(7.4 * g), 1)
    assert model.startswith("the model does not fit") and "7.4 GB" in model and draft is None
    assert bd.precheck({"model": int(6.1 * g), "draft": int(1.6 * g)}, 0, 16 * g, 1) == (None, None)


def test_drafter_speedup_acceptance_and_same_output_math():
    def row(phase, run, ms, gen, sha, drafted=None, accepted=None):
        return {"phase": phase, "step": "Grade one essay", "run": run, "latency_ms": ms, "gen_per_s": gen,
                "sha256": sha, "draft_n": drafted, "draft_accepted": accepted}  # fmt: skip

    rows = [row("greedy", 1, 1000, 20.0, "a"), row("greedy", 2, 1000, 20.0, "b"),
            row("draft-5", 1, 500, 40.0, "a", 100, 80), row("draft-5", 2, 500, 40.0, "x", 100, 60),
            row("draft-16", 1, 2000, 10.0, "a", 100, 10), row("draft-16", 2, 2000, 10.0, "b", 100, 10)]  # fmt: skip
    t5, t16 = bd.draft_table(rows, [5, 16])
    assert t5["speedup"] == 2.0 and t5["gen_speedup"] == 2.0 and t5["acceptance"] == 0.7 and t5["same"] == 1
    assert t16["speedup"] == 0.5 and t16["same"] == 2 and t16["drafted_per_call"] == 100
    verdict = "\n".join(bd.draft_verdict([t5, t16]))
    assert "5 drafted tokens: 2.00x" in verdict and "worth keeping on" in verdict
    assert "16 drafted tokens: 0.50x" in verdict and "keep the drafter off" in verdict
    assert "every setting drafted the same" in verdict  # 100 per call at both settings


def test_unsafe_finds_home_paths_addresses_user_and_host_names(monkeypatch):
    monkeypatch.setattr(bd.secrets_scan, "user_names", lambda: {"invented-user"})
    monkeypatch.setattr(bd, "host_names", lambda: {"benchbox"})
    lan = ".".join(map(str, (192, 168, 4, 20)))
    assert bd.unsafe("loopback 127.0.0.1, b11972, macOS 26.5") == []
    assert bd.unsafe(f"server at {lan}") == ["ip address"]
    assert bd.unsafe("ran on BenchBox") == ["host name"]
    assert "home path" in bd.unsafe("model at /Users/someone/models") and "home path" in bd.unsafe(str(bd.Path.home()) + "/x")
    assert "user name" in bd.unsafe("by invented-user")


# ----- full runs on a fake llama-server -----


FAKE_SERVER = """#!/bin/sh
if [ "$1" = "--version" ]; then echo "version: 11972 (abc1234)"; exit 0; fi
echo $$ >> "$BENCH_TEST_DIR/pids"
printf '%s\\n' "$@" > "$BENCH_TEST_DIR/args.$$"
port=""; prev=""
for a in "$@"; do [ "$prev" = "--port" ] && port="$a"; prev="$a"; done
cat <<'LOG'
""" + MAC_LOG + """LOG
touch "$BENCH_TEST_DIR/ready.$port"
exec sleep 60
"""
FAKE_BENCH = """#!/bin/sh
echo '{"n_prompt": 512, "n_gen": 0, "avg_ts": 2400.0, "stddev_ts": 5.0}'
echo '{"n_prompt": 0, "n_gen": 128, "avg_ts": 150.0, "stddev_ts": 1.0}'
"""
MAIN_PORT = 9101


def fake_value(schema: dict):
    if "enum" in schema:
        return schema["enum"][0]
    kind = schema.get("type")
    kind = next((k for k in kind if k != "null"), "null") if isinstance(kind, list) else kind
    if kind == "object":
        return {k: fake_value(v) for k, v in schema.get("properties", {}).items()}
    if kind == "array":
        return []
    if kind in ("integer", "number"):
        return max(1, schema.get("minimum", 1))
    if kind == "boolean":
        return False
    if kind == "string":
        return "Invented reply."
    return None


def completion(request: httpx.Request) -> httpx.Response:
    """A reply that fits the request's schema, with llama-server timings; a drafted server (any port
    but the main one) drafts and generates twice as fast."""
    body = json.loads(request.content)
    schema = (body.get("response_format") or {}).get("json_schema", {}).get("schema", {"type": "object"})
    drafted = request.url.port != MAIN_PORT
    timings = {"prompt_n": 300, "prompt_per_second": 1500.0, "predicted_n": 60, "predicted_per_second": 120.0 if drafted else 60.0}
    if drafted:
        timings.update(draft_n=50, draft_n_accepted=40)
    return httpx.Response(200, json={
        "choices": [{"message": {"content": json.dumps(fake_value(schema))}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 300, "completion_tokens": 60}, "timings": timings})  # fmt: skip


@pytest.fixture
def fake(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, text in (("llama-server", FAKE_SERVER), ("llama-bench", FAKE_BENCH)):
        (bin_dir / name).write_text(text)
        (bin_dir / name).chmod(stat.S_IRWXU)
    monkeypatch.setenv("BENCH_TEST_DIR", str(tmp_path))
    ports = iter([MAIN_PORT, 9102, 9103, 9104])
    monkeypatch.setattr(bd, "free_port", lambda pick=None: next(ports))
    powers = iter([("plugged", "AC Power"), ("plugged", "AC Power")])
    monkeypatch.setattr(bd, "power_source", lambda: next(powers))
    monkeypatch.setattr(bd, "memory_total", lambda: 64 * bd.GIB)
    model = glimmer_like(tmp_path / "invented-model.gguf")
    draft = glimmer_like(tmp_path / "invented-drafter.gguf")
    out = tmp_path / "reports"
    ready = lambda request: httpx.Response(200 if (tmp_path / f"ready.{request.url.port}").exists() else 503)  # noqa: E731
    with respx.mock(assert_all_called=False) as mock:
        mock.get(url__regex=r"http://127\.0\.0\.1:\d+/health").mock(side_effect=ready)
        chat = mock.post(url__regex=r"http://127\.0\.0\.1:\d+/v1/chat/completions").mock(side_effect=completion)
        yield {"tmp": tmp_path, "server": str(bin_dir / "llama-server"), "model": model, "draft": draft, "out": out,
               "chat": chat, "monkeypatch": monkeypatch}  # fmt: skip


def started_pids(tmp) -> list[int]:
    path = tmp / "pids"
    return [int(x) for x in path.read_text().split()] if path.exists() else []


def assert_all_stopped(pids):
    for pid in pids:
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)


def argv(f, label="mac-lfm", *extra):
    return ["--label", label, "--gguf", str(f["model"]), "--server-bin", f["server"], "--runs", "2", "--essays", "3",
            "--out", str(f["out"]), *extra]  # fmt: skip


def test_a_full_lfm_run_writes_both_files_with_no_machine_details_and_stops_the_server(fake):
    assert bd.main(argv(fake, "mac-lfm", "--full-grade", "--expect-power", "plugged")) == 0
    [pid] = started_pids(fake["tmp"])
    assert_all_stopped([pid])
    args = (fake["tmp"] / f"args.{pid}").read_text().split("\n")
    assert args[args.index("--host") + 1] == "127.0.0.1" and int(args[args.index("--port") + 1]) not in bd.APP_PORTS
    assert "--api-key-file" in args and "--no-mmproj" in args and "--reasoning-budget" in args  # LFM's server flags
    assert args[args.index("-lv") + 1] == "4" and args[args.index("-c") + 1] == "16384"  # buffer lines; the app's context
    md = (fake["out"] / "device_mac-lfm.md").read_text()
    for text in (md, (fake["out"] / "raw" / "device_mac-lfm.jsonl").read_text()):
        assert str(fake["tmp"]) not in text and "/Users/" not in text and str(REPO_ROOT) not in text
        assert not re.search(r"(?<![\d.])(?!127\.0\.0\.1)\d{1,3}(?:\.\d{1,3}){3}(?![\d.])", text)
        assert "Invented reply" not in text  # no model text, only hashes and lengths
    assert "Command: `uv run python -m scripts.bench_device --label mac-lfm --gguf invented-model.gguf" in md
    assert "Result: valid." in md and "| pp512 | 2400.0 | 5.0 |" in md and "| llama.cpp build | b11972 |" in md
    assert "| Model buffers | 1100 MiB |" in md and "| Layers offloaded to the GPU | 17/17 |" in md
    assert "| Router decision | n/a | 2 |" in md and "| 1500.0 | 60 | 60.0 |" in md
    assert "Name pass over 3 essays" in md and "ask_device: " in md and "Grading job: " in md
    assert "status done" in md and "24 feedback files" in md
    raw = [json.loads(line) for line in (fake["out"] / "raw" / "device_mac-lfm.jsonl").read_text().splitlines()]
    assert {r["phase"] for r in raw} == {"llama-bench", "steps", "essays", "ask", "full_grade"}
    assert not any("error" in r for r in raw)
    sent = [json.loads(c.request.content) for c in fake["chat"].calls]
    assert all(b["cache_prompt"] is False for b in sent[:11])  # the timed steps; the jobs use the app's own bodies
    assert "chat_template_kwargs" not in sent[0] and sent[0]["temperature"] == 0.1  # LFM's body, Liquid's sampling


def test_glimmer_with_a_drafter_sweeps_reasoning_and_draft_n_and_compares_greedy_runs(fake):
    code = bd.main(argv(fake, "mac-glimmer1b-dflash", "--kind", "glimmer", "--reasoning", "low,high", "--draft",
                        str(fake["draft"]), "--draft-n", "5,16", "--essays", "0", "--skip-llama-bench"))  # fmt: skip
    assert code == 0
    pids = started_pids(fake["tmp"])
    assert len(pids) == 3  # the plain server, then one per drafted-token setting
    assert_all_stopped(pids)
    drafted = (fake["tmp"] / f"args.{pids[1]}").read_text().split("\n")
    assert drafted[drafted.index("-md") + 1].endswith("invented-drafter.gguf") and "draft-dflash" in drafted
    assert drafted[drafted.index("--spec-draft-n-max") + 1] == "5" and "--reasoning-budget" not in drafted
    md = (fake["out"] / "device_mac-glimmer1b-dflash.md").read_text()
    assert "| Router decision | low | 2 |" in md and "| Router decision | high | 2 |" in md
    assert "| 5 | Router decision | 2 | 60.0 | 120.0 |" in md and "| 80% | 50.0 | 2/2 |" in md
    assert "at least 1.1x faster" in md and "1.5x" in md and "ask_device: it runs on LFM3-VL-2B" in md
    sent = [json.loads(c.request.content) for c in fake["chat"].calls]
    assert {b["chat_template_kwargs"]["reasoning_strength"] for b in sent} == {"low", "high"}
    greedy = [b for c, b in zip(fake["chat"].calls, sent, strict=True) if c.request.url.port != MAIN_PORT]
    assert greedy and all(b["temperature"] == 0.0 for b in greedy)


def test_a_power_change_marks_the_report_invalid(fake):
    powers = iter([("plugged", "AC Power"), ("battery", "Battery Power")])
    fake["monkeypatch"].setattr(bd, "power_source", lambda: next(powers))
    assert bd.main(argv(fake, "mac-lfm", "--no-ask", "--skip-llama-bench", "--expect-power", "plugged")) == 2
    md = (fake["out"] / "device_mac-lfm.md").read_text()
    assert "Result: INVALID: the power source changed during the run (plugged to battery)." in md


def test_the_wrong_power_source_marks_it_invalid_too(fake):
    assert bd.main(argv(fake, "mac-lfm-battery", "--no-ask", "--skip-llama-bench", "--expect-power", "battery")) == 2
    assert "meant to be battery but the device was plugged" in (fake["out"] / "device_mac-lfm-battery.md").read_text()


def test_a_report_with_the_host_name_is_never_written(fake):
    fake["monkeypatch"].setattr(bd, "host_names", lambda: {"benchbox"})
    assert bd.main(argv(fake, "benchbox", "--no-ask", "--skip-llama-bench")) == 1
    assert not (fake["out"] / "device_benchbox.md").exists() and not (fake["out"] / "raw").exists()
    assert_all_stopped(started_pids(fake["tmp"]))


def test_the_server_is_stopped_when_a_step_raises(fake):
    def boom(*_a, **_k):
        raise RuntimeError("invented failure")

    fake["monkeypatch"].setattr(bd.Steps, "run", boom)
    with pytest.raises(RuntimeError):
        bd.main(argv(fake, "mac-lfm", "--skip-llama-bench"))
    pids = started_pids(fake["tmp"])
    assert pids and not (fake["out"] / "device_mac-lfm.md").exists()
    assert_all_stopped(pids)


def test_a_server_that_dies_while_loading_is_reported_not_retried(fake, tmp_path):
    dead = tmp_path / "bin" / "dead-server"
    dead.write_text("#!/bin/sh\necho 'error loading model' >&2\nexit 3\n")
    dead.chmod(stat.S_IRWXU)
    args = argv(fake, "mac-lfm", "--skip-llama-bench")
    args[args.index("--server-bin") + 1] = str(dead)
    assert bd.main(args) == 1
    assert "server: llama-server stopped while loading (exit 3)" in (fake["out"] / "device_mac-lfm.md").read_text()


def test_a_model_that_does_not_fit_is_skipped_with_its_reason(fake):
    fake["monkeypatch"].setattr(bd, "memory_total", lambda: int(0.5 * bd.GIB))
    assert bd.main(argv(fake, "pi5-8-glimmer1b")) == 1
    md = (fake["out"] / "device_pi5-8-glimmer1b.md").read_text()
    assert "everything: the model does not fit" in md and not started_pids(fake["tmp"])


def test_a_dry_run_with_url_attaches_and_writes_both_files(fake):
    args = ["--label", "dry-run", "--gguf", str(fake["model"]), "--url", "http://127.0.0.1:9101/v1", "--runs", "1",
            "--essays", "1", "--no-ask", "--server-bin", fake["server"], "--out", str(fake["out"])]  # fmt: skip
    assert bd.main(args) == 0
    assert not started_pids(fake["tmp"])
    md = (fake["out"] / "device_dry-run.md").read_text()
    assert "attached with --url" in md and "llama-bench: attached to a running server" in md
    assert (fake["out"] / "raw" / "device_dry-run.jsonl").is_file()


def test_main_restores_the_sigterm_handler(fake):
    before = signal.getsignal(signal.SIGTERM)
    bd.main(argv(fake, "mac-lfm", "--no-ask", "--skip-llama-bench", "--essays", "0"))
    assert signal.getsignal(signal.SIGTERM) == before


@pytest.mark.parametrize(
    ("extra", "says"),
    [(["--kind", "lfm", "--reasoning", "high"], "--reasoning is for --kind glimmer"),
     (["--url", "http://192.0.2.7:8080/v1"], "must be this device"),
     (["--label", "Bad Label"], "--label may use"), (["--draft-n", "0"], "1 or more")],
)
def test_bad_arguments_are_refused(fake, extra, says, capsys):
    with pytest.raises(SystemExit):
        bd.main([*argv(fake), *extra])
    assert says in capsys.readouterr().err


# ----- the runbook -----


def test_every_command_in_the_runbook_exists_and_the_labels_are_listed():
    text = (REPO_ROOT / "docs" / "DEVICE_BENCH.md").read_text()
    modules = set(re.findall(r"python -m (scripts\.\w+)", text))
    assert {"scripts.bench_device", "scripts.make_bundle", "scripts.plug_in_model"} <= modules
    for module in modules:
        assert importlib.util.find_spec(module) is not None, module
    for label in ("mac-lfm", "mac-lfm-battery", "mac-glimmer1b", "mac-glimmer1b-dflash", "jetson-glimmer1b",
                  "jetson-lfm", "pi5-8-lfm", "pi5-16-lfm", "pi5-16-glimmer1b"):  # fmt: skip
        assert f"--label {label}" in text, label
    assert "—" not in text and "unverified" in text.lower() and "ssh" in text.lower()
    assert not re.search(r"(?<![\d.])(?!127\.0\.0\.1)\d{1,3}(?:\.\d{1,3}){3}(?![\d.])", text)
    assert not re.search(r"\b[\w-]+\.(?:local|lan)\b|jetson-\d", text)


def test_bench_device_lfm_is_refused(tmp_path, monkeypatch):
    """With the real load_settings (the Nov 2 ruling), --kind lfm cannot start, and --kind glimmer
    sets no LFM beside Glimmer."""
    monkeypatch.setattr(bd, "load_settings", base_config.load_settings)
    url = "http://127.0.0.1:8091/v1"
    with pytest.raises(base_config.NonMetaModelRefused, match="not a Meta model"):
        bd.bench_settings("lfm", url, "k", tmp_path / "h", tmp_path, environ={})
    s = bd.bench_settings("glimmer", url, "k", tmp_path / "h2", tmp_path, environ={})
    assert s.primary_model == s.checker_backend == "glimmer" and s.device_only
