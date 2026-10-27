"""Jetson units and scripts, scripts/start.sh, and the cloud scripts' offline modes."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
DEPLOY = REPO / "deploy" / "jetson"
UNITS = sorted(DEPLOY.glob("*.service"))
BASH_SCRIPTS = [DEPLOY / "install.sh", DEPLOY / "adapter_sync.sh", REPO / "scripts" / "start.sh"]
SH_SCRIPTS = [DEPLOY / "glimmer-env.sh"]
SCANNED = [*UNITS, *BASH_SCRIPTS, *SH_SCRIPTS, DEPLOY / "README.md", REPO / "hardware" / "light" / "README.md",
           REPO / "scripts" / "cloud" / "README.md"]
CLOUD = REPO / "scripts" / "cloud"
HARDENING = {
    "User": "muse-privacy",
    "NoNewPrivileges": "yes",
    "ProtectSystem": "strict",
    "ProtectHome": "yes",
    "PrivateTmp": "yes",
    "ReadWritePaths": "/var/lib/muse-privacy",
    "Restart": "on-failure",
}


def parse_unit(path: Path) -> dict[str, dict[str, list[str]]]:
    """A small systemd INI parser: sections of key -> list of values (keys may repeat)."""
    sections: dict[str, dict[str, list[str]]] = {}
    current = None
    for n, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("[") and line.endswith("]"):
            current = sections.setdefault(line[1:-1], {})
            continue
        assert current is not None, f"{path.name}:{n}: key outside a section"
        assert "=" in line, f"{path.name}:{n}: not key=value"
        assert not line.endswith("\\"), f"{path.name}:{n}: keep each setting on one line"
        key, _, value = line.partition("=")
        assert re.fullmatch(r"[A-Za-z]+", key), f"{path.name}:{n}: bad key {key!r}"
        current.setdefault(key, []).append(value)
    return sections


def test_three_units_exist():
    assert [u.name for u in UNITS] == [
        "muse-privacy-glimmer.service",
        "muse-privacy-relay.service",
        "muse-privacy.service",
    ]


@pytest.mark.parametrize("unit", UNITS, ids=lambda p: p.name)
def test_unit_parses_and_is_hardened(unit):
    sections = parse_unit(unit)
    assert set(sections) == {"Unit", "Service", "Install"}
    service = sections["Service"]
    for key, value in HARDENING.items():
        assert service.get(key) == [value], f"{unit.name}: {key}"
    families = service["RestrictAddressFamilies"][0].split()
    assert set(families) <= {"AF_UNIX", "AF_INET", "AF_INET6"}
    assert service["ExecStart"][0].startswith("/opt/muse-privacy/")
    assert sections["Install"]["WantedBy"] == ["multi-user.target"]
    if unit.name != "muse-privacy-glimmer.service":
        assert "MemoryMax" in service


def test_glimmer_unit_command():
    service = parse_unit(DEPLOY / "muse-privacy-glimmer.service")["Service"]
    cmd = service["ExecStart"][0]
    assert cmd.startswith("/opt/muse-privacy/llama.cpp/")
    assert "--model /opt/muse-privacy/models/Muse-Glimmer-30B.i1-IQ1_S.gguf" in cmd
    for flag in ("--host 127.0.0.1", "--port 8081", "-c 4096", "-np 1", "-ngl 99", "--no-mmproj"):
        assert f" {flag}" in cmd
    assert cmd.endswith(" $LORA_ARGS")  # unbraced: splits into zero or more arguments
    assert service["ExecStartPre"] == ["/opt/muse-privacy/bin/glimmer-env.sh"]
    assert service["EnvironmentFile"] == ["-/var/lib/muse-privacy/glimmer.env"]
    assert service["IPAddressDeny"] == ["any"] and service["IPAddressAllow"] == ["localhost"]


def test_python_units_set_device_and_backend():
    for name, module in (("muse-privacy.service", "-m base"), ("muse-privacy-relay.service", "-m base.connector.relay_client run")):
        service = parse_unit(DEPLOY / name)["Service"]
        assert service["ExecStart"][0].endswith(module)
        env = service["Environment"]
        assert "BASE_DEVICE=jetson" in env and "GLIMMER_BACKEND=llama_server" in env
        assert any(e.startswith("BASE_HOME=/var/lib/muse-privacy/") for e in env)


IPV4 = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])")
HOSTISH = re.compile(r"\b[\w-]+\.(?:local|lan|internal|ts\.net)\b|ngrok|jetson-\d|\b\w+@[\w.-]+:", re.I)


@pytest.mark.parametrize("path", SCANNED, ids=lambda p: p.name)
def test_no_wildcard_bind_ips_or_hostnames(path):
    text = path.read_text()
    assert not re.search(r"(?<![\d.])0\.0\.0\.0(?![\d/])", text)  # a wildcard bind; "10.0.0.0/8" is a range
    # 127.0.0.1, and the private network ranges the server unit may reach (never a real address)
    private_ranges = {"10.0.0.0", "172.16.0.0", "192.168.0.0"}
    assert set(IPV4.findall(text)) <= {"127.0.0.1", *private_ranges}, path.name
    assert not HOSTISH.search(text), HOSTISH.search(text)


@pytest.mark.parametrize("script", BASH_SCRIPTS, ids=lambda p: p.name)
def test_bash_syntax(script):
    subprocess.run(["bash", "-n", str(script)], check=True)


@pytest.mark.parametrize("script", SH_SCRIPTS, ids=lambda p: p.name)
def test_sh_syntax(script):
    subprocess.run(["sh", "-n", str(script)], check=True)


@pytest.mark.parametrize("script", [*BASH_SCRIPTS, *SH_SCRIPTS], ids=lambda p: p.name)
def test_scripts_are_executable_with_shebang(script):
    assert script.read_text().startswith("#!")
    assert os.access(script, os.X_OK)


def code_lines(path: Path) -> str:
    return "\n".join(line for line in path.read_text().splitlines() if not line.lstrip().startswith("#"))


def test_install_never_reboots_or_touches_power():
    code = code_lines(DEPLOY / "install.sh")
    for word in ("reboot", "shutdown", "nvpmodel", "jetson_clocks", "poweroff"):
        assert word not in code
    assert "https://huggingface.co/mradermacher/Muse-Glimmer-30B-i1-GGUF/resolve/main/Muse-Glimmer-30B.i1-IQ1_S.gguf" in (
        (DEPLOY / "install.sh").read_text().replace('$MODEL_REPO', 'mradermacher/Muse-Glimmer-30B-i1-GGUF')
        .replace('$MODEL_NAME', 'Muse-Glimmer-30B.i1-IQ1_S.gguf'))
    assert "--continue-at -" in code and "sha256sum" in code and "/api/models/" in code


def test_install_help_runs_anywhere():
    out = subprocess.run(["bash", str(DEPLOY / "install.sh"), "--help"], capture_output=True, text=True, check=True)
    assert "--build-llama" in out.stdout


def test_adapter_sync_rejects_non_gguf(tmp_path):
    bad = tmp_path / "router.gguf"
    bad.write_bytes(b"NOPE")
    r = subprocess.run(["bash", str(DEPLOY / "adapter_sync.sh"), str(bad)], capture_output=True, text=True)
    assert r.returncode != 0 and "not a GGUF" in r.stderr
    code = code_lines(DEPLOY / "adapter_sync.sh")
    assert "/lora-adapters" in code and "127.0.0.1:8081" in code


@pytest.mark.parametrize("with_adapter", [True, False])
def test_glimmer_env_writes_lora_args(tmp_path, with_adapter):
    adapter = tmp_path / "router.gguf"
    if with_adapter:
        adapter.write_bytes(b"GGUF")
    out = tmp_path / "glimmer.env"
    env = {**os.environ, "MUSE_ADAPTER": str(adapter), "MUSE_GLIMMER_ENV": str(out)}
    subprocess.run(["sh", str(DEPLOY / "glimmer-env.sh")], env=env, check=True)
    text = out.read_text()
    if with_adapter:
        assert text == f'LORA_ARGS="--lora {adapter} --lora-init-without-apply"\n'
    else:
        assert text == "LORA_ARGS=\n"


# -- scripts/start.sh ----------------------------------------------------------------------------


def run_start(tmp_path, **env):
    full = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "BASE_HOME": str(tmp_path / "home"),
            "APPROVAL_HOST": "127.0.0.1", **env}
    return subprocess.run(["bash", str(REPO / "scripts" / "start.sh")], env=full, capture_output=True, text=True,
                          timeout=60)


@pytest.mark.skipif(not (REPO / ".venv" / "bin" / "python").exists(), reason="needs the uv virtualenv")
def test_start_refuses_jetson(tmp_path):
    r = run_start(tmp_path, BASE_DEVICE="jetson", GLIMMER_BACKEND="llama_server")
    assert r.returncode != 0 and "BASE_DEVICE=laptop" in r.stderr


@pytest.mark.skipif(not (REPO / ".venv" / "bin" / "python").exists(), reason="needs the uv virtualenv")
def test_start_needs_llama_server_bin(tmp_path):
    r = run_start(tmp_path, BASE_DEVICE="laptop", GLIMMER_BACKEND="llama_server",
                  LLAMA_SERVER_BIN=str(tmp_path / "missing"), GLIMMER_GGUF=str(tmp_path / "missing.gguf"))
    assert r.returncode != 0 and "LLAMA_SERVER_BIN" in r.stderr


@pytest.mark.skipif(not (REPO / ".venv" / "bin" / "python").exists(), reason="needs the uv virtualenv")
def test_start_needs_gguf(tmp_path):
    fake_bin = tmp_path / "llama-server"
    fake_bin.write_text("#!/bin/sh\nexit 1\n")
    fake_bin.chmod(0o755)
    r = run_start(tmp_path, BASE_DEVICE="laptop", GLIMMER_BACKEND="llama_server", LLAMA_SERVER_BIN=str(fake_bin),
                  GLIMMER_GGUF=str(tmp_path / "missing.gguf"))
    assert r.returncode != 0 and "GLIMMER_GGUF" in r.stderr


@pytest.mark.skipif(not (REPO / ".venv" / "bin" / "python").exists(), reason="needs the uv virtualenv")
def test_start_refuses_lan_bind_on_laptop(tmp_path):
    r = run_start(tmp_path, BASE_DEVICE="laptop", GLIMMER_BACKEND="openrouter", APPROVAL_HOST="192.0.2.11")
    assert r.returncode != 0 and "127.0.0.1" in r.stderr


def test_start_binds_loopback_only():
    code = code_lines(REPO / "scripts" / "start.sh")
    hosts = re.findall(r"--host (\S+)", code)
    assert hosts and set(hosts) == {"127.0.0.1"}
    assert "--port 8081" in code and "--port 8082" in code and "/health" in code


# -- cloud scripts -------------------------------------------------------------------------------


def run_cloud(name, *args):
    return subprocess.run([sys.executable, str(CLOUD / name), *args], capture_output=True, text=True, timeout=60,
                          cwd=str(REPO))


def test_modal_not_needed_for_offline_modes():
    for name in ("quant_eval_modal.py", "train_lora_modal.py"):
        source = (CLOUD / name).read_text()
        top = source.split("def build_app")[0]
        assert "import modal" not in top, name


@pytest.mark.parametrize("name", ["quant_eval_modal.py", "train_lora_modal.py"])
def test_cloud_help_runs_without_modal(name):
    r = run_cloud(name, "--help")
    assert r.returncode == 0 and "--check" in r.stdout


def make_eval_fixture(root: Path, synthetic: bool = True) -> list[str]:
    essays = root / "demo" / "class"
    essays.mkdir(parents=True)
    if synthetic:
        (root / "demo" / ".synthetic").write_text("")
    (essays / "rubric.md").write_text("# Rubric\n- Ideas\n- Organization\n")
    students = [{"name": f"Testname{i} Example", "first": f"Testname{i}", "last": "Example", "nicknames": []}
                for i in range(20)]
    for i, s in enumerate(students):
        (essays / f"essay_{i:02d}.md").write_text(f"My summer, by {s['first']}. I went to the lake with my cousin.\n")
    roster = {"teacher": {"name": "Teacher Example", "first": "Teacher", "last": "Example"}, "students": students}
    (root / "roster.json").write_text(json.dumps(roster))
    items = []
    for d in ("share_tagged", "share_summary", "ask_user", "refuse"):
        for k in range(5):
            items.append({"id": f"{d}-{k}", "request": "How did [Student A] do?", "result": "Testname1 scored 3.",
                          "result_kind": "per_student", "topics": [], "expected": d, "names": ["Testname1"]})
    (root / "tasks.jsonl").write_text("\n".join(json.dumps(i) for i in items))
    (root / "policy.yaml").write_text("name: invented\n")
    return ["--essays", str(essays), "--roster", str(root / "roster.json"), "--tasks", str(root / "tasks.jsonl"),
            "--policy", str(root / "policy.yaml")]


def test_quant_eval_check_passes_on_invented_inputs(tmp_path):
    r = run_cloud("quant_eval_modal.py", "--check", *make_eval_fixture(tmp_path))
    assert r.returncode == 0, r.stderr
    assert "inputs ok" in r.stdout and "lookups: 20" in r.stdout


def test_quant_eval_finds_rubric_one_folder_up(tmp_path):
    args = make_eval_fixture(tmp_path)
    essays = Path(args[1])
    (essays / "rubric.md").rename(essays.parent / "rubric.md")  # the demo/ layout: rubric beside essays/
    (essays / "README.md").write_text("Not an essay.\n")
    r = run_cloud("quant_eval_modal.py", "--check", *args)
    assert r.returncode == 0, r.stderr
    assert "essays: 20" in r.stdout


def test_quant_eval_check_refuses_unmarked_folder(tmp_path):
    r = run_cloud("quant_eval_modal.py", "--check", *make_eval_fixture(tmp_path, synthetic=False))
    assert r.returncode == 1 and ".synthetic" in r.stderr


def test_quant_eval_report_shape(tmp_path):
    sys.path.insert(0, str(CLOUD))
    try:
        import quant_eval_modal as q
    finally:
        sys.path.remove(str(CLOUD))
    result = {
        "names": [{"expected": ["Testname1 Example"], "found": ["Testname1"]}],
        "lookups": [{"id": "a", "expected": "refuse", "got": "refuse"}, {"id": "b", "expected": "ask_user", "got": None}],
        "grades": [{"file": "e.md", "total": 7, "reference_total": 8}],
        "parse_failures": 1, "prompt_tps": 900.0, "gen_tps": 40.5, "size_bytes": 6_500_000_000, "seconds": 60,
        "file": "x.gguf", "repo": "example/repo",
    }
    out = tmp_path / "quantization.md"
    q.write_report({"Q4_K_M": result, "i1-IQ1_S": result}, "uv run python scripts/cloud/quant_eval_modal.py --run", out)
    text = out.read_text()
    assert text.splitlines()[2].startswith("Command: `uv run")
    assert "| i1-IQ1_S | 6.5 GB | 900.0 | 40.5 | 100% | 50% | 0% | 1.00 | 1 |" in text
    assert (tmp_path / "raw" / "quantization.json").is_file()


def test_train_check_passes_and_counts_labels(tmp_path):
    data = tmp_path / "train.jsonl"
    rows = [
        {"request": "Share the class average", "result_kind": "class_aggregate", "tagged_text": "Average 3.1",
         "label": "share_summary", "weight": 3},
        {"messages": [{"role": "user", "content": "x"}, {"role": "assistant", "content": '{"decision": "refuse"}'}]},
    ]
    data.write_text("\n".join(json.dumps(r) for r in rows))
    r = run_cloud("train_lora_modal.py", "--check", "--data", str(data), "--roster", str(tmp_path / "none.json"))
    assert r.returncode == 0, r.stderr
    assert '"refuse": 1' in r.stdout and '"share_summary": 1' in r.stdout


@pytest.mark.parametrize(
    "text",
    ["Call 512-555-0143 after school", "Email parent@example.com", "SSN 900-12-3456", "Card 4111 1111 1111 1111",
     "Testname3 asked for help"],
)
def test_train_check_refuses_identifiers_and_names(tmp_path, text):
    roster = tmp_path / "roster.json"
    roster.write_text(json.dumps({"teacher": {}, "students": [{"name": "Testname3 Example", "first": "Testname3",
                                                               "last": "Example"}]}))
    data = tmp_path / "train.jsonl"
    data.write_text(json.dumps({"request": "r", "result_kind": "free_text", "tagged_text": text, "label": "refuse"}))
    r = run_cloud("train_lora_modal.py", "--check", "--data", str(data), "--roster", str(roster))
    assert r.returncode == 1
    assert text not in r.stderr  # problems name the line and kind, never the value


# ----- review fixes: device F1, F2, F9, SEC-1, SEC-5, SEC-9 -----


@pytest.mark.parametrize("unit", UNITS, ids=lambda p: p.name)
def test_protect_clock_never_blocks_devices(unit):
    # On systemd before 252, ProtectClock implies DeviceAllow=char-rtc and blocks every other
    # device node: the Jetson GPU for llama-server, the light's serial port for the server.
    service = parse_unit(unit)["Service"]
    if service.get("ProtectClock") == ["yes"]:
        assert service.get("PrivateDevices") == ["yes"] or "DeviceAllow" in service, unit.name


def test_glimmer_unit_memory_and_key_flags():
    service = parse_unit(DEPLOY / "muse-privacy-glimmer.service")["Service"]
    cmd = service["ExecStart"][0]
    for flag in ("-ub 128", "--cache-ram 0", "--ctx-checkpoints 0", "--swa-full", "--no-slots"):
        assert f" {flag} " in cmd, flag
    assert " --api-key-file /var/lib/muse-privacy/home/llama_api_key " in cmd
    assert " --api-key " not in cmd  # a key on the command line shows in /proc


def test_server_unit_cannot_reach_the_internet():
    service = parse_unit(DEPLOY / "muse-privacy.service")["Service"]
    assert service["IPAddressDeny"] == ["any"]
    allowed = service["IPAddressAllow"][0].split()
    assert "localhost" in allowed and "0.0.0.0/0" not in allowed


def test_relay_unit_sees_only_its_two_files_and_stops_on_auth_errors():
    service = parse_unit(DEPLOY / "muse-privacy-relay.service")["Service"]
    assert service["TemporaryFileSystem"] == ["/var/lib/muse-privacy:ro"]
    bound = service["BindReadOnlyPaths"][0].split()
    assert sorted(Path(b).name for b in bound) == ["connector_token", "relay.json"]
    assert service["RestartPreventExitStatus"] == ["3"]


@pytest.mark.parametrize(
    "text",
    ["camila wrote three pages", "kowalczyk asked for help", "essays/camila_restrepo_draft.md",
     "Call 512‑555‑0143 after school", "C a m i l a R e s t r e p o"],
)
def test_train_check_decodes_and_uses_the_guard(tmp_path, text):
    # Review privacy F9: lowercase names, slugs and escaped Unicode dashes passed the old check.
    data = tmp_path / "train.jsonl"
    data.write_text(json.dumps({"request": "r", "result_kind": "free_text", "tagged_text": text, "label": "refuse"}))
    r = run_cloud("train_lora_modal.py", "--check", "--data", str(data), "--roster", str(REPO / "eval" / "roster.json"),
                  "--tagmap", str(tmp_path / "none.json"))
    assert r.returncode == 1, r.stdout
    assert text not in r.stderr


def test_train_labels_follow_the_chat_template():
    sys.path.insert(0, str(CLOUD))
    import importlib

    mod = importlib.import_module("train_lora_modal")

    class Tok:  # one token per character
        def __call__(self, text, add_special_tokens=False):
            return {"input_ids": [ord(c) for c in text]}

    full = "<|start|>user<|message|>hi<|eot|><|start|>assistant to=user<|message|>{}<|eot|>"
    prefix = "<|start|>user<|message|>hi<|eot|><|start|>assistant"
    ids, labels = mod.split_labels(Tok(), full, prefix, 4096)
    learned = "".join(chr(t) for t in labels if t != -100)
    assert learned == " to=user<|message|>{}<|eot|>"  # the header and the end token are learned too
    assert mod.target_modules(r".*language_model.*\.(q_proj)$").startswith(".*")
    assert mod.target_modules("q_proj, v_proj") == ["q_proj", "v_proj"]


def test_quant_eval_survives_a_failed_request_and_uses_the_jetson_flags(tmp_path, monkeypatch):
    # Review device F8: one 500 or timeout used to lose every model's results after a paid download.
    sys.path.insert(0, str(CLOUD))
    try:
        import quant_eval_modal as q
    finally:
        sys.path.remove(str(CLOUD))
    calls = []

    def flaky(url, messages, schema, max_tokens=2500):
        calls.append(1)
        if len(calls) == 3:
            raise TimeoutError("slow")
        return {"names": [], "decision": "refuse", "total": 8}, {}

    monkeypatch.setattr(q, "chat", flaky)
    payload = {"essays": [{"text": "x", "names": [], "file": f"{i}.md"} for i in range(q.N_NAMES)],
               "lookups": [{"id": "a", "request": "r", "result_kind": "snippet", "text": "t", "expected": "refuse"}],
               "policy": "", "rubric": "r"}
    out = q.run_jobs("http://127.0.0.1:1", payload, None)
    assert out["request_errors"] == {"TimeoutError": 1} and out["parse_failures"] == 1
    unit = (DEPLOY / "muse-privacy-glimmer.service").read_text()
    for flag in ("-c 4096", "-ub 128", "--cache-ram 0", "--ctx-checkpoints 0"):
        assert flag in " ".join(q.JETSON_FLAGS) and flag in unit
    report = tmp_path / "quantization.md"
    q.write_report({"i1-IQ1_S": {"failed": "RuntimeError", "file": "x.gguf", "repo": "example/repo"}}, "cmd", report)
    assert "not run: RuntimeError" in report.read_text()
