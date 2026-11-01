""".github/workflows/ci.yml: it parses, runs every check on ubuntu and macOS, and needs no secrets."""

from __future__ import annotations

from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "ci.yml"


def load() -> dict:
    return yaml.safe_load(WORKFLOW.read_text())


def runs(job: dict) -> list[str]:
    return [step["run"] for step in job["steps"] if "run" in step]


def test_the_workflow_runs_on_push_and_pull_requests_with_read_only_access():
    data = load()
    triggers = data.get("on", data.get(True))  # YAML 1.1 reads a bare on: as true
    assert set(triggers) == {"push", "pull_request"}
    assert data["permissions"] == {"contents": "read"}


def test_the_python_job_runs_every_check_on_both_systems():
    job = load()["jobs"]["python"]
    assert job["strategy"]["matrix"]["os"] == ["ubuntu-latest", "macos-latest"]
    checkout = next(s for s in job["steps"] if s.get("uses", "").startswith("actions/checkout@"))
    assert checkout["with"]["fetch-depth"] == 0  # the history scan needs every commit
    uv = next(s for s in job["steps"] if s.get("uses", "").startswith("astral-sh/setup-uv@"))
    assert uv["with"]["python-version"] == "3.12"
    assert runs(job) == [
        "uv sync --locked",
        "uv run ruff check .",
        "uv run pytest -q",
        "uv run python -m scripts.secrets_scan --history",
        "grep -q REPLACE_WITH_OAUTH_KV_ID relay/wrangler.jsonc",
    ]


def test_the_relay_job_installs_from_the_lock_and_runs_its_tests():
    job = load()["jobs"]["relay"]
    assert job["runs-on"] == "ubuntu-latest" and job["defaults"]["run"]["working-directory"] == "relay"
    node = next(s for s in job["steps"] if s.get("uses", "").startswith("actions/setup-node@"))
    assert (
        node["with"]["node-version"] == 22
        and node["with"]["cache-dependency-path"] == "relay/package-lock.json"
    )
    assert runs(job) == ["npm ci --legacy-peer-deps --no-audit --no-fund", "npm run typecheck", "npm test"]


def test_no_secrets_and_no_integration_tests():
    text = WORKFLOW.read_text()
    assert "secrets." not in text and "RUN_INTEGRATION=" not in text and "RUN_INTEGRATION:" not in text
    for job in load()["jobs"].values():
        assert "env" not in job and all("env" not in step for step in job["steps"])
    for step in (s for job in load()["jobs"].values() for s in job["steps"] if "uses" in s):
        assert "@" in step["uses"] and not step["uses"].endswith(("@main", "@master")), "actions are pinned"
