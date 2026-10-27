"""The speed bench and the secrets scan (review eval F6). Mocked model, throwaway git repos."""

from __future__ import annotations

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
    assert len(llm.calls) == 6
    md = (tmp_path / "laptop_speed.md").read_text()
    assert "| Grade one essay | 2000 | 250.0 | 2 |" in md
    assert "not this device" in md  # the test settings use the cloud backend
    assert (tmp_path / "raw" / "laptop_speed.jsonl").read_text().count("\n") == 6
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
