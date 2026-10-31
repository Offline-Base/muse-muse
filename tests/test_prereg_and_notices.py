"""eval/reports/glimmer_prereg.md and THIRD_PARTY_NOTICES.md say what they must."""

import importlib.metadata
import json
import re
import tomllib

from base.config import REPO_ROOT

PREREG = REPO_ROOT / "eval" / "reports" / "glimmer_prereg.md"
NOTICES = REPO_ROOT / "THIRD_PARTY_NOTICES.md"


def rows(text: str) -> dict[str, list[str]]:
    """First cell of each table row -> the other cells."""
    out = {}
    for line in text.splitlines():
        if line.startswith("|") and not line.startswith("|---"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            out[cells[0]] = cells[1:]
    return out


def test_prereg_fixes_the_claim_sets_metrics_test_and_stop_rules():
    text = PREREG.read_text()
    for needed in (
        "Written on Oct 30, 2026",
        "`92ee1a7`",
        "git log --diff-filter=A",
        "about 1.6 bits per weight (IQ1_S",
        "policy decides, LFM labels",
        "tuned IQ1_S against base IQ1_S",
        "base IQ1_S against base Glimmer in the cloud",
        "`eval/fresh_200_b.jsonl`",
        "`eval/tasks.jsonl`",
        "`eval/fresh_200_c.jsonl`",
        "`eval/templated/fresh_200_t.jsonl`",
        "scored once, on a frozen commit",
        "McNemar",
        "math.comb",
        "p < 0.05",
        "more than 10% of its items",
        "20 s or more",
        "## If it loses",
        "Everything is published as measured",
        "## Amendments",
    ):
        assert needed in text, needed
    metrics = rows(text)
    for name in (
        "Decision accuracy",
        "Leaks",
        "Missed asks",
        "Over-refusals",
        "Needless asks",
        "Unsafe shares",
        "p95 latency",
    ):
        assert name in metrics, name
    assert "—" not in text and "/Users/" not in text


def test_notices_list_every_python_dependency_at_its_installed_version():
    project = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text())
    specs = [*project["project"]["dependencies"], *project["dependency-groups"]["dev"]]
    table = rows(NOTICES.read_text())
    for spec in specs:
        name = re.match(r"[A-Za-z0-9_.-]+", spec).group(0).lower()
        assert name in table, name
        version, license_name = table[name][0], table[name][1]
        assert version == importlib.metadata.version(name), name
        assert license_name, name


def test_notices_list_every_relay_dependency_at_its_locked_version():
    package = json.loads((REPO_ROOT / "relay" / "package.json").read_text())
    lock = json.loads((REPO_ROOT / "relay" / "package-lock.json").read_text())["packages"]
    table = rows(NOTICES.read_text())
    for name in [*package["dependencies"], *package["devDependencies"]]:
        locked = lock[f"node_modules/{name}"]
        assert table[name][:2] == [locked["version"], locked["license"]], name


def test_notices_name_each_model_and_tool_with_its_license():
    text = NOTICES.read_text()
    for needed in (
        "Muse Glimmer 30B",
        "Apache License 2.0",
        "SAM 3.1",
        "SAM License",
        "International Traffic in Arms Regulations (ITAR)",
        "LFM3-VL-2B",
        "LFM Open License v1.0",
        "EmbeddingGemma 2",
        "llama.cpp",
        "MIT License",
        "https://huggingface.co/facebook/sam3.1",
        "https://huggingface.co/LiquidAI/LFM3-VL-2B",
        "https://huggingface.co/google/embeddinggemma-2",
        "https://github.com/ggml-org/llama.cpp/blob/master/LICENSE",
    ):
        assert needed in text, needed
    assert "—" not in text and "/Users/" not in text
