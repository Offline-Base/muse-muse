"""GAP-13: docs/THREAT_MODEL.md stays true to the tests.

Every test the page names must exist, every table row must name a test or say plainly that it is a
gap, and the known-gaps list must be exactly the xfails in the attack tests. When a fix takes an
xfail marker off, this file fails until the page says so too. It reads the page and the test files
and runs no attack, so it needs no model and no network.
"""

from __future__ import annotations

import ast
import importlib
import itertools
import re
from collections import Counter
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
PAGE = REPO / "docs" / "THREAT_MODEL.md"
ATTACKS = "tests/test_attacks.py"  # where a bare test name in the page lives
XFAIL_FILES = (ATTACKS, "tests/test_red_model_view.py")

NODE_ID = re.compile(r"(tests/test_\w+\.py)::(test_\w+)")
TEST_FILE = re.compile(r"(?<![\w/.-])tests/test_\w+\.py(?!::)")
BARE_NAME = re.compile(r"(?<![\w/.:-])test_[a-z0-9_]+\b(?!\.py)")
RELAY_TEST = re.compile(r"`(relay/test/\w+\.test\.ts)::([^`]+)`")
REPO_PATH = re.compile(r"(?<![\w/.:-])(?:base|docs|eval|relay|scripts|sidecars|tests)/[\w./-]*\w")
FINDING = re.compile(r"\bRED-(?:F\d+[a-z]?|N\d+)\b")
GAP = re.compile(r"\bGap: (?:\S+ ){3,}\S")


def page() -> str:
    return PAGE.read_text()


def defined_tests(path: Path) -> set[str]:
    """Test function names in one Python file, read without importing it."""
    tree = ast.parse(path.read_text())
    return {
        node.name
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.name.startswith("test_")
    }


def missing_tests(text: str) -> list[str]:
    """Every reference in `text` to a test or test file that does not exist."""
    missing = []
    for file, name in NODE_ID.findall(text):
        path = REPO / file
        if not path.is_file() or name not in defined_tests(path):
            missing.append(f"{file}::{name}")
    for file in TEST_FILE.findall(text):
        if not (REPO / file).is_file():
            missing.append(file)
    in_attacks = defined_tests(REPO / ATTACKS)
    missing += [name for name in BARE_NAME.findall(text) if name not in in_attacks]
    for file, title in RELAY_TEST.findall(text):
        path = REPO / file
        if not path.is_file() or f'it("{title}' not in path.read_text():
            missing.append(f"{file}::{title}")
    return sorted(set(missing))


def table_rows(text: str) -> list[tuple[str, list[str], str]]:
    """(heading, cells, whole line) for every body row of every markdown table."""
    rows, heading, in_table = [], "", False
    for line in text.splitlines():
        if line.startswith("#"):
            heading = line.lstrip("# ").strip()
        if not line.startswith("|"):
            in_table = False
            continue
        if not in_table:
            in_table = True  # the header row; the separator follows it
            continue
        if set(line) <= set("|-: "):
            continue
        rows.append((heading, [cell.strip() for cell in line.strip().strip("|").split("|")], line))
    return rows


def names_a_test(line: str) -> bool:
    return bool(NODE_ID.search(line) or BARE_NAME.search(line) or RELAY_TEST.search(line))


def rows_with_neither(text: str) -> list[str]:
    return [cells[0] for _h, cells, line in table_rows(text) if not names_a_test(line) and not GAP.search(line)]


def xfail_marks(fn) -> list:
    return [m for m in getattr(fn, "pytestmark", []) if m.name == "xfail"]


def param_xfails(value) -> list:
    """The xfail marks on one pytest.param value (a plain value has none)."""
    marks = [getattr(m, "mark", m) for m in getattr(value, "marks", ())]
    return [m for m in marks if m.name == "xfail"]


def xfailed_cases(fn) -> Counter:
    """Finding id to the number of collected cases of `fn` that are xfails, from its markers."""
    whole = xfail_marks(fn)
    params = [m.args[1] for m in getattr(fn, "pytestmark", []) if m.name == "parametrize"]
    found: Counter = Counter()
    for combo in itertools.product(*params):
        for mark in whole or [x for value in combo for x in param_xfails(value)]:
            assert mark.kwargs.get("strict") is True, f"{fn.__name__}: every attack xfail must be strict"
            finding = FINDING.match(mark.kwargs["reason"])
            assert finding, f"{fn.__name__}: an xfail reason must start with its finding id"
            found[finding.group()] += 1
    return found


@pytest.fixture(scope="module")
def modules():
    return {file: importlib.import_module(file[:-3].replace("/", ".")) for file in XFAIL_FILES}


@pytest.fixture(scope="module")
def xfails(modules) -> dict[tuple[str, str, str], int]:
    """(file, test, finding id) to case count, for every xfail in the attack tests."""
    out = {}
    for file, module in modules.items():
        for name, fn in vars(module).items():
            if name.startswith("test_") and callable(fn):
                for finding, count in xfailed_cases(fn).items():
                    out[(file, name, finding)] = count
    return out


def row_for(finding: str) -> str:
    return next(line for line in page().splitlines() if line.startswith(f"| {finding} |"))


def test_every_test_the_page_names_exists():
    assert missing_tests(page()) == [], "docs/THREAT_MODEL.md names a test that does not exist"


@pytest.mark.parametrize(
    "text",
    [
        "`test_no_such_attack_exists`",
        "plain text naming test_no_such_attack_exists too",
        "`tests/test_attacks.py::test_no_such_attack_exists`",
        "`tests/test_no_such_file.py::test_f4_one_student_keeps_one_tag_within_a_day`",
        "`tests/test_no_such_file.py`",
        "`tests/test_guard.py::test_f4_one_student_keeps_one_tag_within_a_day`",  # a real test, in another file
        "`relay/test/mcp.test.ts::no such relay test`",
    ],
)
def test_a_name_that_does_not_exist_is_caught(text):
    assert missing_tests(text)


def test_real_names_of_every_form_are_not_flagged():
    text = (
        "`test_f4_one_student_keeps_one_tag_within_a_day`, `tests/test_guard.py::test_tagmap_file_is_private_and_reloads`, "
        "`tests/test_attacks.py`, `relay/test/mcp.test.ts::keeps no body anywhere`"
    )
    assert missing_tests(text) == []


def test_every_table_row_names_a_test_or_says_it_is_a_gap():
    rows = table_rows(page())
    assert len(rows) > 50  # the parser found the tables
    assert rows_with_neither(page()) == []


@pytest.mark.parametrize(
    "row",
    ["| A claim | no test at all |", "| A claim | Gap: |", "| A claim | Gap: too short |"],
)
def test_a_row_with_neither_is_caught(row):
    assert rows_with_neither(f"| Claim | Test |\n|---|---|\n{row}\n") == ["A claim"]


def test_the_known_gaps_table_is_exactly_the_xfails(xfails):
    listed = {}
    for heading, cells, _line in table_rows(page()):
        if heading.startswith("Known gaps"):
            ref = cells[0].strip("`")
            file, name = ref.split("::") if "::" in ref else (ATTACKS, ref)
            listed[(file, name, cells[1])] = int(cells[2])
    assert listed == xfails, (
        "The Known gaps table in docs/THREAT_MODEL.md must list every xfail with its count. "
        "If a fix took a marker off, update the table and the finding's row."
    )
    assert f"There are {sum(xfails.values())} xfailed cases" in page()


def test_every_open_finding_is_an_xfail_or_a_plain_gap(xfails):
    open_ids = {finding for _file, _name, finding in xfails}
    xfailed_tests = {name for _file, name, _finding in xfails}
    findings = [cells for heading, cells, _line in table_rows(page()) if heading == "Findings"]
    assert findings
    for cells in findings:
        finding, what, test = cells[0], cells[2], cells[-1]
        if what.startswith("Fixed:"):
            assert finding not in open_ids, f"{finding} says fixed but is still an xfail"
            named = set(BARE_NAME.findall(test)) | {name for _f, name in NODE_ID.findall(test)}
            assert named and not named & xfailed_tests, f"{finding} says fixed but names an xfailed test"
        else:
            assert finding in open_ids or GAP.search(test), f"{finding} is open with no xfail and no plain gap"


def test_every_finding_id_on_the_page_has_a_row():
    ids = set(FINDING.findall(page()))
    rows = {cells[0] for heading, cells, _line in table_rows(page()) if heading == "Findings"}
    assert ids and ids - rows == set()


@pytest.mark.parametrize(
    ("finding", "cases"),
    [("RED-F3a", "NARROWED"), ("RED-F3b", "CONTACT"), ("RED-F3c", "OUTSIDE")],
)
def test_the_paraphrase_counts_match_the_tests(modules, finding, cases):
    rows = getattr(modules[ATTACKS], cases)
    missed = sum(1 for _text, caught in rows if not caught)
    assert f"{missed} of {len(rows)} " in row_for(finding)


def test_the_shape_and_name_counts_match_the_tests(modules):
    attacks = modules[ATTACKS]
    assert f"({len(attacks.GLUES)} shapes x {len(attacks.LONG)} names)" in page()


def test_every_path_the_page_names_exists():
    missing = sorted({p for p in REPO_PATH.findall(page()) if not (REPO / p).exists()})
    assert missing == []


@pytest.mark.parametrize(
    "heading",
    [
        "What the attack suite is",
        "Enforced in code",
        "Only documented",
        "Known gaps: the attacks that work today",
        "Muse retention: what Meta's side keeps",
        "The Oct 28 list_documents exposure",
    ],
)
def test_the_page_has_each_section(heading):
    assert re.search(rf"^#+ {re.escape(heading)}$", page(), re.MULTILINE)


@pytest.mark.parametrize(
    "words",
    [
        "The attacks are hand-written.",
        "They are not Spark.",
        "was stopped by a safety check and is dropped, not retried",
        "Glimmer has not been measured on the device",
        "How long Meta keeps what reaches Muse is not known.",
        "Whether a real file name went out is unverified.",
    ],
)
def test_the_page_says_the_plain_things(words):
    assert words in page()


@pytest.mark.parametrize("banned", ["Offline Base", "Ethan", chr(0x2014)])
def test_the_page_leaves_these_out(banned):
    assert banned not in page()
