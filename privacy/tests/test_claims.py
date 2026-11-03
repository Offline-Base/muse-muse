"""Claims the public docs may not make, checked against the docs and eval/reports.

Scans README.md, the site's page and script, docs/MUSE_SETUP.md and docs/RUBRIC.md. Fails on
"compliant", on "1-bit" with no measured bits per weight beside it, on "COPPA acts on", on any wording
about Glimmer that does not say it is not on the device today, and on a percentage in README.md that
no report under eval/reports holds.

The Glimmer check fails closed. No list of bad wording can name every way to say "it runs on your
device", so each clause that names Glimmer needs words that hold the claim back, or has to be one a
person read and put in REVIEWED.

Glimmer has not been measured on the device. When a measured file lands, its bits per weight come
from eval/reports/model_file_<label>.md (scripts/plug_in_model.py --check), which is what lets a
"1-bit" sentence through.
"""

from __future__ import annotations

import html
import re
from pathlib import Path

import pytest

from base import config

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "eval" / "reports"
SCANNED = ("README.md", "site/index.html", "site/site.js", "docs/MUSE_SETUP.md", "docs/RUBRIC.md")

# Plans and pipeline checks, not measurements, so a number found only there proves nothing.
# Never open the persona smokes: they hold rows nobody may read.
NOT_EVIDENCE_DIRS = {"raw", "smoke"}
NOT_EVIDENCE_FILES = {"PLAN.md", "glimmer_prereg.md"}

NUMBER = r"\d+(?:\.\d+)?"
PERCENT_SIGN = r"\s?(?:%|percent\b|per cent\b|pct\b)"
PERCENT = re.compile(rf"(?<![\d.,])({NUMBER}){PERCENT_SIGN}", re.I)
# "75, 85, 90%" and "72 to 81 percent" give every number in the run its percent sign.
PERCENT_RUN = re.compile(rf"(?<![\d.,])({NUMBER}(?:(?:,? and |,? to |,? or |, ){NUMBER})*){PERCENT_SIGN}", re.I)
ONE_BIT = re.compile(r"(?<![\d.])(?:1|(?<!\w)(?:one|single))[-\s]?bit\b", re.I)
BITS_PER_WEIGHT = re.compile(r"(\d+(?:\.\d+)?)\s*(?:bits per weight|bits/weight|bpw)\b", re.I)
BESIDE = 80  # characters on each side of "1-bit" that count as beside it

# Hyphens a keyboard does not type, and characters that do not show. A claim must not hide in them.
LOOKALIKES = {ord(c): "-" for c in "\u2010\u2011\u2012\u2013\u2014\u2212\ufe63\uff0d"} | dict.fromkeys(
    map(ord, "\u00ad\u200b\u200c\u200d\u2060\ufeff")
)

BLOCK_TAGS = (
    "address|article|aside|blockquote|body|br|button|caption|dd|details|div|dl|dt|figcaption|figure|footer|form"
    "|h[1-6]|head|header|hr|html|img|li|main|meta|nav|ol|p|pre|section|summary|svg|table|tbody|td|tfoot|th|thead"
    "|title|tr|ul"
)
SHOWN_ATTRIBUTE = re.compile(r"""\b(?:alt|aria-label|content|data-[\w-]+|placeholder|title|value)\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.I)

GLIMMER = re.compile(r"glimmer", re.I)
# A file name, flag or variable, such as GLIMMER_GGUF or muse-privacy-glimmer, claims nothing.
IDENTIFIER = re.compile(r"[\w./-]*(?:_|/|\.\w)[\w./-]*|\bmuse-privacy-glimmer\b|(?<!\S)--[\w-]+", re.I)
PLACE = re.compile(
    r"\b(?:devices?|on-device|laptops?|boards?|jetsons?|macs?|hardware|machines?|computers?|locally|local|offline)\b",
    re.I,
)
NOW = re.compile(r"\b(?:today|now|currently|already)\b", re.I)
NEGATED = re.compile(r"\b(?:not|never|no)\b|n't\b", re.I)
# Words that hold back the claim itself. "No", "never", "can", "if" and "when" are not among them:
# they fit a true claim as well ("Glimmer runs on your device, so no name can leave").
HOLDS_BACK = re.compile(
    r"\bno (?:\w+ )?glimmer\b"
    r"|\b(?:has|have|had|does|do|did|is|was|were) not\b(?: been)? (?:measured|run|ran|landed|done|part|used)\b"
    r"|\bnot (?:run|measured|yet|part|landed|done)\b"
    r"|\b(?:unmeasured|planned|designed|would)\b",
    re.I,
)
OFF_THE_DEVICE = re.compile(r"\b(?:openrouter|earlier)\b", re.I)
CLAUSE_BREAK = re.compile(r"[,;:]|\s(?:and|but|so|while|because|then|which|or)\s", re.I)

# Clauses a person read: they name Glimmer but do not say where it runs, or are in a section that
# already says. Add to this only after reading the sentence, and only if it is true today.
REVIEWED = frozenset(
    {
        "Other entries in this hackathon also put Glimmer redaction in front of Meta's models, through the Meta Model API rather than the Muse app.",
        "Glimmer runs on OpenRouter, so the device reads only folders marked .synthetic, such as demo/.",
        "### Laptop with your own Glimmer file (not run or measured yet)",
        "scripts/start.sh # Glimmer on 127.0.0.1:8081 and 8082, then the server;",
        "install.sh makes the service user, builds llama.cpp with CUDA, downloads and checks Glimmer i1-IQ1_S (6.5 GB), makes a self-signed certificate for the approval page and installs three systemd units.",
        "Muse Spark 1.3 wrote the 2,000 invented practice items and graded the essays a second time: the same total as Glimmer for 15 of 24, within one point for 23 of 24 ([grading_crosscheck.md](eval/reports/grading_crosscheck.md)).",
        "One 30B Muse Glimmer graded, found names the roster misses, read who Muse's request is for, wrote summaries and was the privacy router, every call at reasoning strength low.",
        "Its request labels follow contextual integrity, the idea Meta's Glimmer paper says its privacy training is inspired by ([arXiv 2610.24628](https://arxiv.org/html/2610.24628v1)).",
        "On 160 held-out invented requests, scored against Muse Spark's labels: for someone outside the class, Glimmer's recall was 0.84 at precision 0.75, where a keyword list's recall was 0.50;",
        "- A 30B model for an 8 GB board (designed, not run on a board): the Jetson would use a published Glimmer quant at about 1.6-bit (IQ1_S), i1-IQ1_S at 6.5 GB, for lookups and tagging, and hand grading to the laptop.",
        "Muse Glimmer 30B, meta/muse-glimmer-30b on OpenRouter",
        "Muse Glimmer, Meta's Q4_K_M GGUF (Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf)",
        "Would do grading, the name pass, summaries and the privacy router (Glimmer is its own router;",
        "Muse Glimmer i1-IQ1_S, about 1.6-bit (6.5 GB, mradermacher/Muse-Glimmer-30B-i1-GGUF)",
        "A tuned Muse Glimmer, about 1.6-bit (IQ1_S)",
        "118.8 s on a first day (the job itself 102.2 s, 28 Glimmer calls), with an instant approval;",
        "Same total for 21 of 24 essays between two Glimmer runs;",
        "Earlier, Glimmer over-labeled whole-text requests (precision 0.50 on held-out requests), so asking for one paragraph can be treated as asking for a whole essay.",
        "Muse Glimmer 30B",
        "Local model Muse Glimmer: on OpenRouter in this demo, planned for your device",
        "84% of held-out requests meant for someone outside the class found by Glimmer, at precision 0.75;",
        "23 of 24 essays where Muse Spark's total was within one point of Glimmer's",
        "The installer builds llama.cpp, fetches an about 1.6-bit (IQ1_S) Muse Glimmer and sets up three services.",
        "In an earlier test, Muse Glimmer spotted class-level requests with precision and recall of 0.94, against a keyword list's 0.92 and 0.67.\",",
        "To speed Glimmer up with Meta's DFlash drafter, add --draft /path/to/drafter.gguf (it must share the model's vocabulary;",
        "auto and --reasoning-budget N (-1 unrestricted, 0 none) are written to .env the same way, and scripts/start.sh passes all of them to Glimmer's llama-server only.",
        "A Glimmer file can be measured while the app keeps running: start a second llama-server for it on a free port on 127.0.0.1, then point the matrix there.",
        "[Muse Glimmer docs](https://dev.meta.ai/docs/muse-glimmer/)",
        "Glimmer's license (Apache 2.0)",
        "- The Rules require building with Meta AI products: \"Muse Spark, Glimmer, SAM 3, and any other Meta AI products identified on the Event page.\" They do not name the Muse app, its Secure VM or connectors.",
        "Whether a tuned Glimmer at about 1.6-bit (IQ1_S) lands and passes its pre-registered test (eval/reports/glimmer_prereg.md), so its device numbers can join the README's \"What Meta's models do here\" section",
        "Muse plans the work with tags, Muse Glimmer does every model step that touches the documents, and only tagged or summarized results go back to Muse: names and identifiers are swapped for tags on the device, and a final leak check runs on every text before it leaves.",
        "In this hackathon demo the model is Muse Glimmer 30B in the cloud, on OpenRouter, and the device reads only invented data.",
        "Glimmer on the device is the target, planned and not measured yet.",
        "The setup it ships now (.env.example) is cloud mode: Muse Glimmer 30B (meta/muse-glimmer-30b on OpenRouter) does every model step, on invented data only, because in this mode the device refuses any folder without a .synthetic marker.",
        "Today's defaults were scored on Glimmer on Nov 2, over the 200 invented items of fresh_200_b, a development set: [0 leaks of names or identifiers, with the 58 releases the simulated teacher approved checked too, and 71.5% decision accuracy (143 of 200), with 101 approval requests, 50 of them needless](eval/reports/glimmer_fresh_200_b_2026-11-02.md).",
        "Keeping the essays on the laptop needs Muse Glimmer on the device, which is planned and not measured yet.",
        "In this demo Glimmer runs on OpenRouter, so the device reads only an invented class.",
        "On the device, the agent swaps tags back to names only to choose what to do, and gives Muse Glimmer the documents with every name and identifier already swapped for tags, so in cloud mode OpenRouter sees tagged invented text.",
        "Every result goes through base/egress.py: exact checks for names on the roster and identifiers (phones, emails, SSNs, Luhn-checked cards, student ids, addresses, dates of birth), and a second pass where Muse Glimmer finds names the roster misses.",
        "Then the device reads Muse's request: a keyword scan for never-share topics, and one Glimmer call that labels who the result is for and what it asks (for a student's family, for someone outside the class, a whole text, who a tag really is, a class-level question).",
        "in cloud mode Muse Glimmer is the router, under floors it cannot loosen.",
        "The only page reader was LFM3-VL-2B, and the Glimmer files have no vision tensors ([model_file_r30b_iq1s.md](eval/reports/model_file_r30b_iq1s.md)), so page images are not read now and SAM has nothing to cover.",
        "Not measured yet: Glimmer of any size on the device, grade quality, Glimmer's speed on the laptop and on a Jetson, the Jetson's memory use, quantization quality (Q4_K_M against i1-IQ1_S), a router LoRA, how often Glimmer's name pass reports only part of a name, and the author's own grading spot-check ([eval/reports/grading_spotcheck.md](eval/reports/grading_spotcheck.md) is ready for those scores).",
        "LFM3-VL-2B read them, and the Glimmer files have no vision tensors, so an image is no longer a document.",
        "Every model step is now a cloud call: in the Glimmer bench the name pass averaged 7521 ms and the request labels 3031 ms, and a 24-essay grading job took 118.8 s, slower than the device-only setup it replaces.",
        "Muse Muse Spark 1.3 Muse Glimmer",
        "The default .env is cloud mode (since Nov 2, when the hackathon organizers ruled that every model the project calls must be a Meta model): Muse Glimmer 30B on OpenRouter does every model step, so fill in OPENROUTER_API_KEY, and the device reads only folders marked .synthetic (invented data), such as demo/.",
        "Muse Glimmer on the device is the target;",
        "Plugging in sets CHECKER_BACKEND=glimmer and turns off any setting the Nov 2 ruling refuses (LFM, EmbeddingGemma, Prompt Guard, the Jetson's LFM), so no other model runs beside Glimmer.",
        "Not usable since Nov 2: every setup in scripts/model_matrix.py starts from device-only LFM settings, which load_settings now refuses, so the matrix needs setups with Glimmer as the checker before it can run again.",
        "Held back by: the sealed set not scored yet, a router that asks too often (50 of 101 requests needless), and no Glimmer on the device",
        "scene F is skipped, since the privacy toggles need every model on the device), or, without --cloud, with DEVICE_ONLY=1 and Glimmer on llama-server here, which has not been run (--dry-run fakes the model).",
        "On Muse Glimmer 30B on OpenRouter with today's defaults, 0 leaks and 71.5% decision accuracy on 200 invented items on Nov 2, with 101 approval requests ([report](../eval/reports/glimmer_fresh_200_b_2026-11-02.md));",
    }
)


def plain_text(raw: str, *, kind: str = "md") -> str:
    """The words a reader sees, one block to a line: no tags or Markdown emphasis, wrapped lines rejoined."""
    if kind == "html":
        raw = re.sub(r"<(script|style)\b.*?</\1>|<!--.*?-->", " ", raw, flags=re.S | re.I)
        shown = [a or b for a, b in SHOWN_ATTRIBUTE.findall(raw)]
        # A source line break is a space and an inline tag is nothing, so only blocks end a sentence.
        raw = re.sub(r"\s+", " ", raw)
        raw = re.sub(rf"</?(?:{BLOCK_TAGS})\b[^>]*>|<a\b[^>]*\bclass=\"[^\"]*\bcard\b[^>]*>", "\n", raw, flags=re.I)
        raw = html.unescape("\n".join([re.sub(r" *<[^>]+> *", " ", raw), *shown]))
    elif kind == "md":
        raw = joined_markdown(raw)
    return raw.translate(LOOKALIKES).replace("*", "").replace("`", "")


def joined_markdown(raw: str) -> str:
    """Puts a paragraph wrapped over several lines back on one line. Lines in code fences stay apart."""
    out: list[str] = []
    in_fence = open_paragraph = False
    for line in raw.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence, open_paragraph = not in_fence, False
            out.append("")
        elif in_fence or not stripped or re.match(r"(?:\||#|>|[-+*] |\d+\. )", stripped):
            out.append(line)
            open_paragraph = bool(stripped) and not in_fence and not stripped.startswith(("|", "#"))
        elif open_paragraph:
            out[-1] += " " + stripped
        else:
            out.append(line)
            open_paragraph = True
    return "\n".join(out)


def sentences(text: str) -> list[str]:
    """Split on blocks, table cells and sentence ends."""
    found: list[str] = []
    for line in text.splitlines():
        for cell in line.split("|"):
            found += [s.strip() for s in re.split(r"(?<=[.!?;])\s+", cell) if s.strip()]
    return found


def clauses(sentence: str) -> list[str]:
    """The parts of a sentence, so words in one part cannot excuse another. A parenthesis is its own part."""
    inside = re.findall(r"\(([^()]*)\)", sentence)
    outside = re.sub(r"\([^()]*\)", " ", sentence)
    parts = [p for text in (outside, *inside) for p in CLAUSE_BREAK.split(text)]
    return [re.sub(r"\s+", " ", p).strip(" .!?#\"'") for p in parts if p.strip(" .!?#\"'")]


def banned_phrases(text: str) -> list[str]:
    flat = re.sub(r"\s+", " ", text)
    return [m.group(0) for m in re.finditer(r"\w*compliant\b|COPPA acts on", flat, re.I)]


def unmeasured_one_bit(text: str, measured: set[str]) -> list[str]:
    """Each "1-bit" that has no bits-per-weight figure from a model-file report beside it."""
    flat = re.sub(r"\s+", " ", html.unescape(text).translate(LOOKALIKES))
    bad = []
    for m in ONE_BIT.finditer(flat):
        near = flat[max(0, m.start() - BESIDE) : m.end() + BESIDE]
        if not any(n in measured for n in BITS_PER_WEIGHT.findall(near)):
            bad.append(near)
    return bad


def clause_is_a_claim(clause: str) -> bool:
    names = GLIMMER.search(IDENTIFIER.sub(" ", clause))
    if NOW.search(clause) and not NEGATED.search(clause):
        return bool(names or PLACE.search(clause))  # no "planned" or "earlier" excuses "today"
    if HOLDS_BACK.search(clause):
        return False
    if OFF_THE_DEVICE.search(clause) and not PLACE.search(clause):
        return False
    return bool(names or PLACE.search(clause))


def glimmer_sentences_to_read(text: str) -> list[str]:
    """Each sentence naming Glimmer, not yet read, with a part that could say it is on the device today."""
    bad = []
    for sentence in sentences(text):
        if not GLIMMER.search(IDENTIFIER.sub(" ", sentence)) or re.sub(r"\s+", " ", sentence) in REVIEWED:
            continue
        if any(clause_is_a_claim(clause) for clause in clauses(sentence)):
            bad.append(sentence)
    for line in text.splitlines():  # a table row says it across cells: | Glimmer | Laptop | Grading |
        row = line.replace("|", " ")
        if line.lstrip().startswith("|") and GLIMMER.search(IDENTIFIER.sub(" ", row)):
            if PLACE.search(row) and not HOLDS_BACK.search(row):
                bad.append(line)
    return bad


def percentages(text: str) -> set[str]:
    """Figures as a report states them, each with its own percent sign or word."""
    return {f"{number}%" for number in PERCENT.findall(text)}


def claimed_percentages(text: str) -> set[str]:
    """Figures a doc claims. Unlike percentages(), a list that ends in % claims every number in it."""
    return {f"{n}%" for run in PERCENT_RUN.findall(text) for n in re.findall(NUMBER, run)}


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


def raw_doc(name: str) -> str:
    return (ROOT / name).read_text(encoding="utf-8")


def doc(name: str) -> str:
    kind = {".html": "html", ".js": "script"}.get(Path(name).suffix, "md")
    return plain_text(raw_doc(name), kind=kind)


# The real docs


@pytest.mark.parametrize("name", SCANNED)
def test_no_banned_phrase(name):
    assert banned_phrases(doc(name)) == []
    assert banned_phrases(raw_doc(name)) == []  # attributes and scripts too


@pytest.mark.parametrize("name", SCANNED)
def test_one_bit_only_beside_a_measured_figure(name):
    assert unmeasured_one_bit(doc(name), measured_bits_per_weight()) == []
    assert unmeasured_one_bit(raw_doc(name), measured_bits_per_weight()) == []  # attributes and scripts too


@pytest.mark.parametrize("name", SCANNED)
def test_no_claim_that_glimmer_runs_on_the_device_today(name):
    assert glimmer_sentences_to_read(doc(name)) == []


@pytest.mark.parametrize("name", SCANNED)
def test_no_em_dash(name):
    assert chr(0x2014) not in raw_doc(name)


def test_every_readme_percentage_is_in_a_report():
    held: set[str] = set()
    for path in evidence_files():
        held |= percentages(path.read_text(encoding="utf-8", errors="replace"))
    missing = sorted(claimed_percentages(raw_doc("README.md")) - held)
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
        assert "latest result that shows tags" in said[n]  # rows 9 and 11 end with no tag to take
    assert [row[3].strip() for row in rows if row[1].strip() == "7"][0].startswith("The tagged per-student scores")


def clean_clone_settings(monkeypatch, tmp_path, changes: dict[str, str]) -> config.Settings:
    """Settings from .env.example plus the lines a setup step adds. Nothing is started or called."""
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path)  # so no .env from this checkout is merged
    values = config.read_dotenv(ROOT / ".env.example")
    return config.load_settings(values | changes | {"BASE_HOME": str(tmp_path / "home")})


def meta_models_only(settings: config.Settings) -> bool:
    """The organizers' Nov 2 ruling: Muse Glimmer for every model step, and no model that is not Meta's."""
    return (
        settings.primary_model == settings.checker_backend == "glimmer"
        and not (settings.search_embeddings or settings.has_jetson_lfm)
    )


def test_the_readme_cloud_steps_load_on_meta_models_only(monkeypatch, tmp_path):
    readme = raw_doc("README.md")
    steps = readme.split("### Laptop, cloud mode (what `.env.example` sets")[1].split("\n### ")[0]
    told = re.search(r"cp \.env\.example \.env\s+# then set (.*)", steps).group(1)
    assert told.strip() == "OPENROUTER_API_KEY"
    settings = clean_clone_settings(monkeypatch, tmp_path, {"OPENROUTER_API_KEY": "k"})
    assert meta_models_only(settings) and not settings.device_only
    assert settings.is_cloud_backend and settings.answer_model == "meta/muse-glimmer-30b"


def test_the_muse_setup_steps_load_on_meta_models_only(monkeypatch, tmp_path):
    section = raw_doc("docs/MUSE_SETUP.md").split("## 2. Connect the device to the relay")[1].split("\n## ")[0]
    changes = dict(re.findall(r"echo '([A-Z_]+)=([^']*)'\s*>> \.env", section))
    assert "DEVICE_ONLY" not in changes  # the example file sets it
    settings = clean_clone_settings(monkeypatch, tmp_path, changes)
    assert meta_models_only(settings) and not settings.device_only and settings.is_cloud_backend


@pytest.mark.parametrize("name", SCANNED)
def test_no_model_that_is_not_metas_is_said_to_do_the_work(name):
    """Nov 2 ruling: the public docs never present LFM, EmbeddingGemma or Prompt Guard as today's
    setup, and never call Llama Prompt Guard a Meta model."""
    text = doc(name)
    for bad in (r"LFM3-VL-2B (?:on|does|runs|answers)\b[^.]*\btoday", r"LFM3-VL-2B today", r"today's (?:default|setup)[^.|]*LFM", r"Meta's (?:Llama )?Prompt Guard", r"Meta's 22M classifier"):
        assert not re.search(bad, text, re.I), bad


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
        "A 1bit Muse Glimmer.",
        "A file called glimmer1bit.",
        "A single-bit Glimmer.",
        "A 1\u2011bit Muse Glimmer.",  # a non-breaking hyphen
        "A 1&#8209;bit Muse Glimmer.",
        "A 1\u00adbit Muse Glimmer.",  # a soft hyphen, which does not show
        '<meta name="description" content="Runs a 1-bit Muse Glimmer.">',
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
        # Words like these excused a whole sentence in the first version of this check
        "Muse Glimmer runs on your device, so nothing can leave.",
        "Your device grades every essay with Muse Glimmer, and no name leaves.",
        "The device runs Glimmer today, and names never leave.",
        "Muse Glimmer grades the essays locally and never sends them out.",
        "Muse plans the work with tags, your device does every step that touches the documents with Muse Glimmer, and no name goes back.",
        "The privacy router is Muse Glimmer, on the laptop, and it can ask you first.",
        "If you ask, Muse Glimmer grades on the device.",
        "When Muse asks, Glimmer answers on the laptop.",
        # Wording with no usual place word, or none at all
        "Muse Glimmer does every private step on hardware you own.",
        "| Muse Glimmer Q4_K_M | Laptop, llama-server | Grading and routing |",
        "Today Muse Glimmer does every private step, offline.",
        "Muse Glimmer does every private step.",
        "Muse plans the job with tags, Glimmer grades them on the device.",
        # An excuse in one part must not cover another
        "Earlier, Muse Glimmer ran on OpenRouter, and today it runs on the device.",
        "Muse Glimmer on the device replaced OpenRouter.",
        "The planned Muse Glimmer runs on the device today.",
        "Muse Glimmer has not leaked and runs on your laptop.",
        "Muse Glimmer (not run on a board) grades on the laptop.",
        "Glimmer does not send anything off the device.",
    ],
)
def test_glimmer_check_catches(text):
    assert glimmer_sentences_to_read(plain_text(text))


@pytest.mark.parametrize(
    "text",
    [
        "<p><b>Muse Glimmer</b> runs on the device today.</p>",
        '<p>Today <span class="k">Muse Glimmer</span> grades on your laptop.</p>',
        "<p>Muse Glimmer runs\n on the device today.</p>",
        '<p>Muse <a href="#m">Glimmer</a> grades\n  <em>on your laptop</em>.</p>',
        "<p>Muse&nbsp;Glimmer runs on the device today.</p>",
        '<meta name="description" content="Muse Glimmer runs on the device today.">',
        '<img src="x.png" alt="Muse Glimmer grading on the laptop">',
        '<a class="card" href="#"><b>0 leaks</b><span>Muse Glimmer on your laptop</span></a>',
        "<li>Glimmer does every private step</li>",
    ],
)
def test_glimmer_check_catches_in_html(text):
    assert glimmer_sentences_to_read(plain_text(text, kind="html"))


def test_glimmer_check_catches_a_sentence_wrapped_in_markdown():
    assert glimmer_sentences_to_read(plain_text("Some words before.\n\nMuse Glimmer runs\non the device today.\n"))


def test_html_blocks_still_end_a_sentence():
    text = plain_text("<h3>Muse Glimmer 30B</h3><p>On your device.</p>", kind="html")
    assert sentences(text) == ["Muse Glimmer 30B", "On your device."]


@pytest.mark.parametrize(
    "text",
    [
        "Glimmer has not been measured on the device.",
        "Glimmer does not run on the device today.",
        "No Glimmer numbers on the device.",
        "No Glimmer has been measured on the device, so nothing here says it helps.",
        "A tuned Glimmer at about 1.6-bit (IQ1_S) is planned for the device.",
        "Glimmer runs on OpenRouter.",
        "The keyword list runs on the laptop today.",
        "Muse Glimmer 30B is used for the earlier benchmarks.",
        "Would use Glimmer on the board.",
        "The service is muse-privacy-glimmer and the setting is GLIMMER_GGUF.",
    ],
)
def test_glimmer_check_passes(text):
    assert glimmer_sentences_to_read(plain_text(text)) == []


def test_new_wording_about_glimmer_has_to_be_read_first():
    new = "To use your own Glimmer on the device, plug it in."
    assert glimmer_sentences_to_read(new) == [new]
    assert new not in REVIEWED


def test_a_reviewed_sentence_passes_only_word_for_word():
    read = "Glimmer runs on OpenRouter, so the device reads only folders marked .synthetic, such as demo/."
    assert read in REVIEWED
    assert glimmer_sentences_to_read(read) == []
    assert glimmer_sentences_to_read(read.replace("OpenRouter", "this laptop")) != []


@pytest.mark.parametrize(
    "text, expected",
    [
        ("We got 99.7 percent on the set.", {"99.7%"}),
        ("We got 99.7 per cent on the set.", {"99.7%"}),
        ("We got 99.7 pct on the set.", {"99.7%"}),
        ("We got 99.7 % on the set.", {"99.7%"}),
        ("75, 85, 90, 85, 85, 90%", {"75%", "85%", "90%"}),
        ("from 72 to 81 percent", {"72%", "81%"}),
        ("between 40 and 50%", {"40%", "50%"}),
        ("72%, 81%", {"72%", "81%"}),
        ("a percentage of 12 points", set()),
    ],
)
def test_a_claimed_percentage_counts_every_number_and_the_word(text, expected):
    assert claimed_percentages(text) == expected


def test_a_number_list_in_a_report_does_not_prove_every_number():
    assert percentages("24, 90%") == {"90%"}


def test_a_percentage_is_matched_whole():
    assert percentages("81.5% and 8% and 100%, not 1,5%") == {"81.5%", "8%", "100%"}
    assert "1.5%" not in percentages("81.5%")


def test_the_persona_smokes_are_never_opened_as_evidence():
    assert [p for p in evidence_files() if "smoke" in p.parts or "raw" in p.parts] == []
