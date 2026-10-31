"""GAP-13: docs/THREAT_MODEL.md stays true to the tests.

Every test the page names must exist in a form this file can look up, every row's test column must
name a test or say plainly that it is a gap, a row that cites an xfail must say so (and an "Enforced
in code" row must not cite one), and the known-gaps list must be exactly the xfails in the attack
tests. When a fix takes an xfail marker off, this file fails until the page says so too. It reads the
page and the source files and runs no attack, so it needs no model and no network.
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
HARNESS = "tests/test_no_egress.py"

NODE_ID = re.compile(r"(tests/test_\w+\.py)::(test_\w+)")
NODE_LIKE = re.compile(r"(?<![\w/.-])tests/[^\s`|,;)]*::[^\s`|,;)]*")  # anything written as a node id
TEST_FILE = re.compile(r"(?<![\w/.-])tests/test_\w+\.py(?!::)")
BARE_NAME = re.compile(r"(?<![\w/.-])test_\w+\b(?!\.py)")
RELAY_TEST = re.compile(r"`(relay/test/[^\s`]+)::([^`]+)`")
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
    for form in NODE_LIKE.findall(text):
        node = NODE_ID.fullmatch(form)
        if not node or not (REPO / node[1]).is_file() or node[2] not in defined_tests(REPO / node[1]):
            missing.append(form)  # a class-style id or a parameter is not looked up, so it counts as missing
    rest = NODE_LIKE.sub(" ", text)
    for file in TEST_FILE.findall(rest):
        if not (REPO / file).is_file():
            missing.append(file)
    in_attacks = defined_tests(REPO / ATTACKS)
    missing += [name for name in BARE_NAME.findall(rest) if name not in in_attacks]
    for file, title in RELAY_TEST.findall(text):
        path = REPO / file
        if not path.is_file() or f'it("{title}' not in path.read_text():
            missing.append(f"{file}::{title}")
    return sorted(set(missing))


def split_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def table_rows(text: str) -> list[tuple[str, list[str], str]]:
    """(heading, cells, test cell) for every body row of every markdown table. The test cell is the
    one under the header "Test" or "Tests": empty if the table has no such column or the row does
    not line up with its header, so such a row names nothing."""
    rows, heading, header = [], "", None
    for line in text.splitlines():
        if line.startswith("#"):
            heading = line.lstrip("# ").strip()
        if not line.startswith("|"):
            header = None
            continue
        if header is None:
            header = split_row(line)  # the separator follows it
            continue
        if set(line) <= set("|-: "):
            continue
        cells = split_row(line)
        tests = [cell for name, cell in zip(header, cells, strict=False) if name in ("Test", "Tests")]
        rows.append((heading, cells, tests[0] if tests and len(cells) == len(header) else ""))
    return rows


def names_a_test(cell: str) -> bool:
    return bool(cited_tests(cell) or RELAY_TEST.search(cell))


def rows_with_neither(text: str) -> list[str]:
    return [cells[0] for _h, cells, test in table_rows(text) if not names_a_test(test) and not GAP.search(test)]


def cited_tests(text: str) -> set[tuple[str, str]]:
    """(file, test) for every Python test `text` names."""
    bare = BARE_NAME.findall(NODE_LIKE.sub(" ", text))
    return {*NODE_ID.findall(text), *((ATTACKS, name) for name in bare)}


def enforced_rows_on_an_xfail(text: str, xfailed: set[tuple[str, str]]) -> list[str]:
    """Rows of "Enforced in code" that cite a test with an xfailed case: that table is code with a
    test that fails if the code stops, and an xfail cannot."""
    return [cells[0] for heading, cells, test in table_rows(text) if heading == "Enforced in code" and cited_tests(test) & xfailed]


def rows_hiding_an_xfail(text: str, xfailed: set[tuple[str, str]]) -> list[str]:
    """Rows that cite a test with an xfailed case and do not say so. The tables whose job is to list
    xfails with their findings are left out."""
    listing = ("Known gaps", "Findings", "Attack families")
    return [
        cells[0]
        for heading, cells, test in table_rows(text)
        if not heading.startswith(listing) and cited_tests(test) & xfailed and "xfail" not in test
    ]


def uses_xfail(source: str, *, imperative_only: bool = False) -> list[int]:
    """Lines in Python `source` that use xfail: every pytest.mark.xfail and pytest.xfail, or only
    pytest.xfail(...), which no marker shows and no count below would see."""
    return [
        node.lineno
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Attribute)
        and node.attr == "xfail"
        and not (imperative_only and not (isinstance(node.value, ast.Name) and node.value.id == "pytest"))
    ]


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
        "`relay/test/no-such.test.ts::keeps no body anywhere`",
        "`test_f4_One_student_keeps_one_tag_within_a_day`",  # a capital letter
        "`tests/test_manifest.py::TestNope::test_a_changed_file_is_refused`",  # a class-style id
        "`tests/test_manifest.py::test_a_changed_file_is_refused[case]`",  # a parameter
        "`tests/test_manifest.py::`",
        "`tests/helpers/test_manifest.py::test_a_changed_file_is_refused`",
        "`::test_no_such_attack_exists`",
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


@pytest.mark.parametrize(
    "table",
    [
        "| Claim | Test |\n|---|---|\n| A claim | |\n| `test_f4_one_student_keeps_one_tag_within_a_day` is in no test cell | |\n",
        "| Claim | Other |\n|---|---|\n| A claim | `test_f4_one_student_keeps_one_tag_within_a_day` |\n",
        "| Claim | Test |\n|---|---|\n| A claim | `test_f4_one_student_keeps_one_tag_within_a_day` | stray |\n",
    ],
)
def test_only_the_test_cell_counts(table):
    assert rows_with_neither(table)[0] == "A claim"


def test_a_test_in_the_test_cell_counts():
    table = "| Claim | Test | Status |\n|---|---|---|\n| A claim | `test_f4_one_student_keeps_one_tag_within_a_day` | Held |\n"
    assert rows_with_neither(table) == []


def test_no_enforced_row_rests_on_an_xfail(xfails):
    xfailed = {(file, name) for file, name, _finding in xfails}
    assert enforced_rows_on_an_xfail(page(), xfailed) == []


def test_an_enforced_row_on_an_xfail_is_caught():
    text = "### Enforced in code\n\n| What | Test |\n|---|---|\n| A claim | `test_x`, `tests/test_y.py::test_y` |\n"
    assert enforced_rows_on_an_xfail(text, {(ATTACKS, "test_x")}) == ["A claim"]
    assert enforced_rows_on_an_xfail(text, {("tests/test_y.py", "test_y")}) == ["A claim"]
    assert enforced_rows_on_an_xfail(text, {(ATTACKS, "test_z")}) == []
    assert enforced_rows_on_an_xfail(text.replace("Enforced in code", "Other"), {(ATTACKS, "test_x")}) == []


def test_a_row_that_cites_an_xfail_says_so(xfails):
    xfailed = {(file, name) for file, name, _finding in xfails}
    assert rows_hiding_an_xfail(page(), xfailed) == []


def test_a_row_hiding_an_xfail_is_caught():
    text = "## Who attacks\n\n| Id | Test |\n|---|---|\n| A0 | `test_x` |\n| A1 | `test_x` (xfail) |\n"
    assert rows_hiding_an_xfail(text, {(ATTACKS, "test_x")}) == ["A0"]
    assert rows_hiding_an_xfail(text.replace("Who attacks", "Findings"), {(ATTACKS, "test_x")}) == []


@pytest.mark.parametrize("file", XFAIL_FILES)
def test_the_attack_tests_have_no_imperative_xfail(file):
    assert uses_xfail((REPO / file).read_text(), imperative_only=True) == [], (
        f"{file}: pytest.xfail() is not a strict marker and the Known gaps count cannot see it"
    )


def test_only_the_attack_tests_use_xfail():
    own = {*XFAIL_FILES, str(Path(__file__).resolve().relative_to(REPO))}
    others = [p for p in sorted((REPO / "tests").rglob("test_*.py")) if str(p.relative_to(REPO)) not in own]
    assert others
    assert [str(p.relative_to(REPO)) for p in others if uses_xfail(p.read_text())] == []


def test_an_imperative_xfail_is_told_from_a_marker():
    marker = "@pytest.mark.xfail(strict=True, reason='x')\ndef test_a(): pass\n"
    imperative = "def test_b():\n    pytest.xfail('RED-F11 x')\n"
    assert uses_xfail(marker) == [1] and uses_xfail(marker, imperative_only=True) == []
    assert uses_xfail(imperative) == [2] and uses_xfail(imperative, imperative_only=True) == [2]


def test_the_harness_calls_all_eight_tools():
    """The page says the no-egress harness drives every tool. A new tool fails here until it does."""
    tools = re.findall(r'@server\.tool\(\s*name="(\w+)"', (REPO / "base" / "connector" / "server.py").read_text())
    assert len(tools) == 8, "docs/THREAT_MODEL.md says all eight tools stay on the device"
    harness = (REPO / HARNESS).read_text()
    assert [tool for tool in tools if f'"{tool}"' not in harness] == []


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
        "only what no rule matches asks the user",
        "Always approve first appears in a commit on Oct 30 (f62b827).",
        "On the committed code of Oct 28 that ask waits for a person.",
    ],
)
def test_the_page_says_the_plain_things(words):
    assert words in page()


def test_both_retention_rows_say_what_happens_with_no_toggle():
    assert page().count("With no toggle, only stopped tags are deleted, hourly") == 2


@pytest.mark.parametrize("banned", ["Offline Base", "Ethan", chr(0x2014)])
def test_the_page_leaves_these_out(banned):
    assert banned not in page()
