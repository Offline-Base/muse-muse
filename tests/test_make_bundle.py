"""scripts/make_bundle.py: what goes in a board's tarball, the secrets scan, the sums. Throwaway git repos."""

from __future__ import annotations

import hashlib
import subprocess
import sys
import tarfile

import pytest

from base.config import REPO_ROOT
from scripts import make_bundle as mb


def git(root, *args):
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.setattr(mb.secrets_scan, "user_names", lambda: {"invented-user"})
    root = tmp_path / "repo"
    files = {
        "base/app.py": "print('hi')\n", "scripts/bench_device.py": "# bench\n", "eval/roster.json": "{}\n",
        "eval/reports/old.md": "# old\n", "demo/essays/Rose Hallaway.md": "An invented essay.\n",
        "demo/Screenshot one.png": "png", "deploy/jetson/install.sh": "#!/bin/sh\n", "relay/wrangler.jsonc": "{}\n",
        ".env.example": "KEY=\n", "eval/tiny.gguf": "GGUF", "pyproject.toml": "[project]\n", "uv.lock": "lock\n",
        "docs/DEVICE_BENCH.md": "# Runbook\n", "docs/OTHER.md": "# other\n",
    }  # fmt: skip
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text)
    git(root.parent, "init", "-q", str(root))
    git(root, "add", "-f", ".")
    git(root, "-c", "user.name=Invented", "-c", "user.email=invented@example.com", "commit", "-qm", "init")
    (root / ".git" / "info" / "exclude").write_text("demo/Screenshot*\ndemo/*.pdf\n")
    (root / "scripts" / "new_untracked.py").write_text("# not tracked, not added\n")
    (root / "scripts" / "extra_tool.py").write_text("# added by name\n")
    (root / "demo" / "resume.pdf").write_text("a personal file")  # untracked and in info/exclude
    (root / "base" / "app.py").write_text("print('edited, not committed')\n")
    return root


def test_tracked_files_plus_named_extras_without_env_models_reports_or_private_files(repo):
    files, left = mb.bundle_files(repo, ["scripts/extra_tool.py", "demo"])
    assert files == ["base/app.py", "demo/essays/Rose Hallaway.md", "deploy/jetson/install.sh", "docs/DEVICE_BENCH.md",
                     "eval/roster.json", "pyproject.toml", "scripts/bench_device.py", "scripts/extra_tool.py", "uv.lock"]  # fmt: skip
    assert left == {"not needed on a board": 1, "model file": 1, "named in .git/info/exclude": 2}
    with pytest.raises(mb.BundleError, match="inside the repo"):
        mb.bundle_files(repo, ["../outside.txt"])


def test_the_bundle_has_its_sums_a_readme_the_working_tree_and_no_owner_names(repo, tmp_path):
    tarball, n, _left = mb.build(repo, tmp_path / "dist", "muse-bench-test", ["scripts/extra_tool.py"])
    assert n == 9 and (tmp_path / "dist" / "muse-bench-test.tar.gz.sha256").read_text().split()[0] == mb.sha256(tarball)
    with tarfile.open(tarball) as tar:
        members = {m.name: m for m in tar.getmembers()}
        assert all(m.uname == "" and m.uid == 0 for m in members.values())
        names = {name.removeprefix("muse-bench-test/") for name in members}
        assert {"SHA256SUMS", "BOARD_README.txt", "scripts/extra_tool.py", "scripts/bench_device.py"} <= names
        assert not {"relay/wrangler.jsonc", ".env.example", "eval/tiny.gguf", "demo/resume.pdf", "scripts/new_untracked.py"} & names
        assert tar.extractfile("muse-bench-test/base/app.py").read() == b"print('edited, not committed')\n"
        sums = tar.extractfile("muse-bench-test/SHA256SUMS").read().decode().splitlines()
        for line in sums:
            digest, rel = line.split("  ", 1)
            assert hashlib.sha256(tar.extractfile(f"muse-bench-test/{rel}").read()).hexdigest() == digest
        assert len(sums) == n


def test_a_secrets_finding_builds_nothing_and_names_only_the_place(repo, tmp_path, capsys):
    key = "sk-or-v1-" + "cd" * 32  # built here so this file holds no key shape
    (repo / "scripts" / "bench_device.py").write_text(f"KEY = '{key}'\nhome = '/Users/invented-user/x'\n")
    assert mb.main(["--out", str(tmp_path / "dist")], root=repo) == 1
    err = capsys.readouterr().err
    assert "scripts/bench_device.py:1: openrouter key" in err and "scripts/bench_device.py:2: user name" in err
    assert key not in err and not (tmp_path / "dist").exists()


def test_the_real_repo_bundle_unpacks_and_the_bench_starts(tmp_path, monkeypatch):
    monkeypatch.setattr(mb.secrets_scan, "user_names", lambda: {"invented-user"})
    files, _left = mb.bundle_files(REPO_ROOT)
    assert {"scripts/bench_device.py", "scripts/make_bundle.py", "pyproject.toml", "uv.lock", "docs/DEVICE_BENCH.md",
            "deploy/jetson/install.sh", "eval/roster.json"} <= set(files)  # fmt: skip
    assert not [f for f in files if f.endswith(".gguf") or f.rsplit("/", 1)[-1].startswith(".env")
                or f.startswith(("relay/", "site/", "eval/reports/", "tests/"))]  # fmt: skip
    tarball, _n, _left = mb.build(REPO_ROOT, tmp_path / "dist", "bundle")
    with tarfile.open(tarball) as tar:
        tar.extractall(tmp_path / "board", filter="data")
    out = subprocess.run([sys.executable, "-m", "scripts.bench_device", "--help"], cwd=tmp_path / "board" / "bundle",
                         capture_output=True, text=True, timeout=120)  # fmt: skip
    assert out.returncode == 0 and "--label" in out.stdout
