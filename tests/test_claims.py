"""Claims the public docs may not make, checked against the docs and eval/reports.

Scans README.md, site/index.html, docs/MUSE_SETUP.md and docs/RUBRIC.md. Fails on "compliant", on
"1-bit" with no measured bits per weight beside it, on "COPPA acts on", on any claim that Glimmer
runs on the device today, and on a percentage in README.md that no report under eval/reports holds.

Glimmer has not been measured on the device. When a measured file lands, its bits per weight come
from eval/reports/model_file_<label>.md (scripts/plug_in_model.py --check), which is what lets a
"1-bit" sentence through.
"""

from __future__ import annotations

import html
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "eval" / "reports"
SCANNED = ("README.md", "site/index.html", "docs/MUSE_SETUP.md", "docs/RUBRIC.md")

# Plans and pipeline checks, not measurements, so a number found only there proves nothing.
# Never open the persona smokes: they hold rows nobody may read.
NOT_EVIDENCE_DIRS = {"raw", "smoke"}
NOT_EVIDENCE_FILES = {"PLAN.md", "glimmer_prereg.md"}

PERCENT = re.compile(r"(?<![\d.,])\d+(?:\.\d+)?%")
ONE_BIT = re.compile(r"(?<![\d.])(?:1|one)[- ]bit\b", re.I)
BITS_PER_WEIGHT = re.compile(r"(\d+(?:\.\d+)?)\s*(?:bits per weight|bits/weight|bpw)\b", re.I)
BESIDE = 80  # characters on each side of "1-bit" that count as beside it

PLACE = re.compile(
    r"\b(?:on|in) (?:the|this|your|a|each|its) (?:own )?(?:device|laptop|board|jetson|mac)\b"
    r"|\bon[- ]device\b|\blocally\b|\byour device\b|\bthe device\b|\bthis device\b|\bthe laptop\b",
    re.I,
)
NOT_TODAY = re.compile(
    r"\b(?:not|never|no|until|earlier|openrouter|planned|coming|would|could|can|if|once|when|your own|designed|unmeasured)\b"
    r"|n't\b|\bhas not\b",
    re.I,
)
# Says "today" outright, so words like "no" elsewhere in the sentence do not excuse it. A negation
# inside the claim itself ("Glimmer does not run on the device today") still does.
RUNS_TODAY = re.compile(
    r"glimmer\b(?P<a>[^.;|]{0,80}?)\b(?:runs?|running|grades?|answers?|decides?|routes?|does)\b"
    r"(?P<b>[^.;|]{0,60}?)(?:" + PLACE.pattern + r")(?P<c>[^.;|]{0,40}?)\b(?:today|now|currently|already)\b",
    re.I,
)
INNER_NEGATION = re.compile(r"\b(?:not|never|no)\b|n't\b", re.I)


def plain_text(raw: str, *, is_html: bool = False) -> str:
    """The words a reader sees: no tags, scripts or Markdown emphasis, block ends kept as line breaks."""
    if is_html:
        raw = re.sub(r"<(script|style)\b.*?</\1>", " ", raw, flags=re.S | re.I)
        raw = re.sub(r"<br\s*/?>|</(?:p|h\d|li|div|summary|td|th|tr|span|b|a)>", "\n", raw, flags=re.I)
        raw = html.unescape(re.sub(r"<[^>]+>", "", raw))
    return raw.replace("*", "").replace("`", "")


def sentences(text: str) -> list[str]:
    """Split on lines, table cells and sentence ends. These docs do not wrap inside a sentence."""
    found: list[str] = []
    for line in text.splitlines():
        for cell in line.split("|"):
            found += [s.strip() for s in re.split(r"(?<=[.!?;])\s+", cell) if s.strip()]
    return found


def banned_phrases(text: str) -> list[str]:
    flat = re.sub(r"\s+", " ", text)
    return [m.group(0) for m in re.finditer(r"\w*compliant\b|COPPA acts on", flat, re.I)]


def unmeasured_one_bit(text: str, measured: set[str]) -> list[str]:
    """Each "1-bit" that has no bits-per-weight figure from a model-file report beside it."""
    flat = re.sub(r"\s+", " ", text)
    bad = []
    for m in ONE_BIT.finditer(flat):
        near = flat[max(0, m.start() - BESIDE) : m.end() + BESIDE]
        if not any(n in measured for n in BITS_PER_WEIGHT.findall(near)):
            bad.append(near)
    return bad


def glimmer_runs_on_device_today(text: str) -> list[str]:
    bad = []
    for sentence in sentences(text):
        if "glimmer" not in sentence.lower():
            continue
        said_today = RUNS_TODAY.search(sentence)
        if said_today and not INNER_NEGATION.search(said_today.group(0)):
            bad.append(sentence)
        elif PLACE.search(sentence) and not NOT_TODAY.search(sentence):
            bad.append(sentence)
    for line in text.splitlines():  # a table row says it across cells: | Glimmer | The laptop | Grading |
        row = line.replace("|", " ")
        if line.lstrip().startswith("|") and "glimmer" in row.lower() and PLACE.search(row) and not NOT_TODAY.search(row):
            bad.append(line)
    return bad


def percentages(text: str) -> set[str]:
    return set(PERCENT.findall(text))


def evidence_files() -> list[Path]:
    """The reports a claim may rest on, chosen by path before anything is opened."""
    files = []
    for path in REPORTS.rglob("*"):
        rel = path.relative_to(REPORTS)
        if path.suffix not in (".md", ".csv") or not path.is_file():
            continue
        if NOT_EVIDENCE_DIRS & set(rel.parts) or path.name in NOT_EVIDENCE_FILES:
            continue
        files.append(path)
    return files


def measured_bits_per_weight() -> set[str]:
    numbers: set[str] = set()
    for path in REPORTS.glob("model_file_*.md"):
        numbers |= set(BITS_PER_WEIGHT.findall(path.read_text(encoding="utf-8")))
        numbers |= set(re.findall(r"(?i)bits per weight[^\d\n]*(\d+(?:\.\d+)?)", path.read_text(encoding="utf-8")))
    return numbers


def doc(name: str) -> str:
    return plain_text((ROOT / name).read_text(encoding="utf-8"), is_html=name.endswith(".html"))


# The real docs


@pytest.mark.parametrize("name", SCANNED)
def test_no_banned_phrase(name):
    assert banned_phrases(doc(name)) == []
    assert banned_phrases((ROOT / name).read_text(encoding="utf-8")) == []  # attributes and scripts too


@pytest.mark.parametrize("name", SCANNED)
def test_one_bit_only_beside_a_measured_figure(name):
    assert unmeasured_one_bit(doc(name), measured_bits_per_weight()) == []


@pytest.mark.parametrize("name", SCANNED)
def test_no_claim_that_glimmer_runs_on_the_device_today(name):
    assert glimmer_runs_on_device_today(doc(name)) == []


@pytest.mark.parametrize("name", SCANNED)
def test_no_em_dash(name):
    assert chr(0x2014) not in (ROOT / name).read_text(encoding="utf-8")


def test_every_readme_percentage_is_in_a_report():
    held: set[str] = set()
    for path in evidence_files():
        held |= percentages(path.read_text(encoding="utf-8", errors="replace"))
    missing = sorted(percentages((ROOT / "README.md").read_text(encoding="utf-8")) - held)
    assert missing == []


def test_every_report_the_readme_links_exists():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    links = re.findall(r"\((eval/reports/[^)#\s]+)", readme)
    assert links
    assert [link for link in links if not (ROOT / link).exists()] == []


def test_the_demo_script_hardcodes_no_tag_in_what_to_say():
    """Tags rotate daily, so a fixed [Student C] gets EXPIRED_TAG or the wrong person past day one."""
    setup = (ROOT / "docs" / "MUSE_SETUP.md").read_text(encoding="utf-8")
    section = setup.split("## 7. Test script for the demo")[1].split("\n## ")[0]
    rows = [line.split("|") for line in section.splitlines() if re.match(r"\|\s*\d+\s*\|", line)]
    assert len(rows) >= 12
    said = {row[1].strip(): row[2] for row in rows}
    assert [n for n, words in said.items() if re.search(r"\[Student [A-Z]{1,3}\]", words)] == []
    for n in ("9", "10", "12"):
        assert "latest result" in said[n]


def test_the_muse_app_status_lines_rest_on_the_reports_that_exist():
    """eval/reports/muse_app holds script rehearsals only, until a real session has a report."""
    reports = [p.name for p in (REPORTS / "muse_app").glob("*.md")]
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    if all(name.startswith("rehearsal_") for name in reports):
        assert "No session in the real Muse app has a report" in readme
        assert "has not connected" not in readme
        assert "has not connected" not in (ROOT / "docs" / "MUSE_SETUP.md").read_text(encoding="utf-8")


# The checks themselves, on sentences they must and must not catch


@pytest.mark.parametrize(
    "text",
    [
        "Muse Privacy is HIPAA compliant.",
        "This keeps a school FERPA-compliant.",
        "A toggle does not make anyone compliant.",
        "Noncompliant setups are refused.",
        "COPPA acts on the device.",
        "coppa   acts\non a teacher's laptop.",
    ],
)
def test_banned_phrases_catch(text):
    assert banned_phrases(text)


@pytest.mark.parametrize("text", ["See docs/COMPLIANCE_PLAN.md.", "The compliance toggles tag more.", "COPPA maps to a toggle."])
def test_banned_phrases_pass(text):
    assert banned_phrases(text) == []


@pytest.mark.parametrize(
    "text",
    [
        "The Jetson uses a published 1-bit Glimmer quant.",
        "A 1 bit model.",
        "The one-bit Glimmer is small.",
        "A 1-bit Glimmer at 1.76 bits per weight.",  # a figure, but no report holds it
        "A 1-bit Glimmer. " + "Unrelated words go here to fill the space beside it. " * 3 + "It is 1.62 bits per weight.",
    ],
)
def test_one_bit_catches(text):
    assert unmeasured_one_bit(text, {"1.62"})


@pytest.mark.parametrize(
    "text",
    ["A 1-bit Glimmer, 1.62 bits per weight measured.", "1.62 bpw, the 1-bit file.", "About 1.6-bit (IQ1_S).", "The 4-bit file.", "An 11-bit field."],
)
def test_one_bit_passes(text):
    assert unmeasured_one_bit(text, {"1.62"}) == []


@pytest.mark.parametrize(
    "text",
    [
        "Muse Glimmer runs on the device today.",
        "Glimmer runs on this laptop now, and no data leaves.",
        "Today your device does every step with Muse Glimmer.",
        "Your device does every step with Muse Glimmer, and a final check runs on every text before it leaves.",
        "Glimmer grades them on the device.",
        "Muse Glimmer on-device handles routing.",
        "| Muse Glimmer Q4_K_M | The laptop, llama-server | Grading and routing |",
    ],
)
def test_glimmer_check_catches(text):
    assert glimmer_runs_on_device_today(text)


@pytest.mark.parametrize(
    "text",
    [
        "Glimmer has not been measured on the device.",
        "Glimmer does not run on the device today.",
        "No Glimmer numbers on the device.",
        "A tuned Glimmer at about 1.6-bit (IQ1_S) is planned for the device.",
        "Glimmer runs on OpenRouter, so the device reads only folders marked synthetic.",
        "LFM3-VL-2B runs on the laptop today.",
        "To use your own Glimmer on the device, plug it in.",
        "Muse Glimmer 30B is used for the earlier benchmarks.",
    ],
)
def test_glimmer_check_passes(text):
    assert glimmer_runs_on_device_today(text) == []


def test_a_percentage_is_matched_whole():
    assert percentages("81.5% and 8% and 100%, not 1,5%") == {"81.5%", "8%", "100%"}
    assert "1.5%" not in percentages("81.5%")


def test_the_persona_smokes_are_never_opened_as_evidence():
    assert [p for p in evidence_files() if "smoke" in p.parts or "raw" in p.parts] == []
