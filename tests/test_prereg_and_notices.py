"""eval/reports/glimmer_prereg.md and THIRD_PARTY_NOTICES.md say what they must."""

import hashlib
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
        "`eval/splits/fresh_200_c.jsonl`",
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


def test_prereg_names_sets_that_exist_pins_them_and_checks_both_for_overlap():
    text = PREREG.read_text()
    paths = re.findall(r"`(eval/[\w./-]+\.jsonl)`", text)
    assert "eval/splits/fresh_200_c.jsonl" in paths and "eval/templated/fresh_200_t.jsonl" in paths
    for rel in paths:
        assert (REPO_ROOT / rel).is_file(), rel
    for rel in ("eval/splits/fresh_200_c.jsonl", "eval/templated/fresh_200_t.jsonl"):
        assert hashlib.sha256((REPO_ROOT / rel).read_bytes()).hexdigest() in text, rel  # hashed, never read
    assert "--sets eval/splits/fresh_200_c.jsonl eval/templated/fresh_200_t.jsonl" in text


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
        "mlx-community/sam3.1-bf16",
        "pdftotext",
        "SAM_ENABLED=1",
    ):
        assert needed in text, needed
    assert "Not part of this commit" not in text and "Planned" not in text  # the SAM sidecar is in the tree
    assert "—" not in text and "/Users/" not in text


def test_notices_list_every_sam_sidecar_dependency():
    project = tomllib.loads((REPO_ROOT / "sidecars" / "sam" / "pyproject.toml").read_text())
    table = rows(NOTICES.read_text())
    for spec in project["project"]["dependencies"]:
        name = re.match(r"[A-Za-z0-9_.-]+", spec).group(0).lower()
        assert name in table and table[name][-1], name
