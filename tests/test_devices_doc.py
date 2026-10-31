"""docs/DEVICES.md only says what the reports say: Mac numbers are copied from them, every other device
says "not measured", prices have a URL and a date, and the per-school figure is labeled an assumption."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from scripts.charts import parse_tables

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "docs" / "DEVICES.md"
TEXT = DOC.read_text()
BENCH = "eval/reports/device_mac-lfm.md"
SMOKE = "eval/reports/device_smoke_lfm_loosen_default.md"
FRESH = "eval/reports/floors_fresh_200_b.md"


def section(title: str) -> str:
    return TEXT.split(f"## {title}")[1].split("\n## ")[0]


def rows(title: str) -> list[list[str]]:
    return [r for table in parse_tables(section(title)) for r in table[1:]]


@pytest.mark.parametrize(
    ("doc_text", "report", "report_text"),
    [
        ("1.02 GB, 0.19 GB", BENCH, "1.02 GB"),
        ("1.02 GB, 0.19 GB", BENCH, "0.19 GB"),
        ("0.8 s", BENCH, "| 0.8 s |"),
        ("210.4 tokens/s", BENCH, "| tg128 | 210.4 |"),
        ("3253.9 tokens/s", BENCH, "| pp512 | 3253.9 |"),
        ("25/25", BENCH, "| 25/25 |"),
        ("349 ms", BENCH, "| Router decision | n/a | 3 | 349 |"),
        ("232 ms", BENCH, "232 ms per essay"),
        ("1486 ms", BENCH, "| Grade one essay | n/a | 3 | 1486 |"),
        ("13.8 s", BENCH, "ask_device: 13.8 s"),
        ("32.7 s", BENCH, "Grading job: 32.7 s"),
        ("about 2.6 GB of 36.00 GB with a 1 GB margin", BENCH, "about 2.6 GB of 36.00 GB with a 1 GB margin"),
        ("1.70 GB resident", BENCH, "| 1.70 GB (ps; Metal buffers may not count) |"),
        ("1246 MiB", BENCH, "| 1246 MiB |"),
        ("200 MiB", BENCH, "| 200 MiB |"),
        ("513 MiB", BENCH, "| 513 MiB |"),
        ("2 other llama-server", BENCH, "| Other llama-server processes running | 2 |"),
        ("Apple M4 Max", BENCH, "| Apple M4 Max |"),
        ("41.1 s", SMOKE, "- grading seconds: 41.1"),
        ("35.9 s", SMOKE, "- grading seconds: 35.9"),
        ("16.7 s", SMOKE, "| ask the device: result | get_result | shared | 16.7 |"),
        ("17.6 s", SMOKE, "| ask the device: result | get_result | shared | 17.6 |"),
        ("82.5%", FRESH, "82.5% (165 of 200)"),
        ("75 approval requests", FRESH, "| Approval requests | 75 |"),
        ("0 leaks", FRESH, "| Leaks | 0 |"),
    ],
)
def test_every_copied_number_is_in_its_report(doc_text, report, report_text):
    assert doc_text in TEXT
    assert report_text in (ROOT / report).read_text()


def test_only_reports_that_exist_are_named_as_sources():
    for path in re.findall(r"(?<!`)eval/reports/[\w./-]+\.md", TEXT):
        assert (ROOT / path).is_file(), path


@pytest.mark.parametrize(
    "device", ["Jetson Orin Nano", "Raspberry Pi 5", "AWS Device Farm", "A 16 GB laptop"]
)
def test_unmeasured_devices_say_so_and_say_what_is_needed(device):
    matrix = [r for r in rows("Device matrix") if r[0].startswith(device)]
    needed = [r for r in rows("What is needed to measure the rest") if r[0].startswith(device)]
    assert matrix and all(r[2] == "not measured" for r in matrix)
    assert needed and needed[0][1] == "not measured" and len(needed[0][2]) > 40


def test_glimmer_is_not_implied_to_have_been_measured():
    glimmer = [r for r in rows("Device matrix") if "Glimmer" in r[1]]
    assert glimmer and all(r[2] == "not measured" for r in glimmer)
    assert "Glimmer has not been measured on any device" in TEXT
    for report in ("device_mac-glimmer1b.md", "device_mac-lfm-battery.md"):
        assert not (ROOT / "eval" / "reports" / report).exists(), f"{report} exists: update docs/DEVICES.md"


def test_every_price_has_a_url_and_a_date():
    table = rows("Cost per device")
    priced = [r for r in table if re.search(r"\$[1-9]|\$0\.", r[1])]
    assert len(priced) == 4
    for row in priced:
        assert "https://" in row[2], row[0]
        assert re.search(r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w* \d{1,2}, 20\d\d", row[2]), (
            row[0]
        )


def test_the_16_gb_laptop_is_projected_and_unknown_costs_say_unknown():
    laptop = next(r for r in rows("Cost per device") if r[0].startswith("A 16 GB laptop"))
    assert laptop[1] == "$0, projected" and laptop[3] == "not measured"
    assert "Unknown, because no source was read" in TEXT
    assert next(r for r in rows("Memory by process") if r[0] == "All together")[1] == "unknown"


def test_the_per_school_figure_is_an_assumption_with_its_inputs_and_its_arithmetic_holds():
    part = section("Per-school figure (an assumption)")
    assert "Everything in this table is an assumption" in part and "30 teachers in a school" in part
    assert "assumption" in parse_tables(part)[0][0][3]
    prices = {r[0]: r[1] for r in rows("Cost per device")}
    checked = 0
    for name, teachers, price, total in rows("Per-school figure (an assumption)"):
        each = int(price.strip("$"))
        assert int(total.strip("$").replace(",", "")) == int(teachers) * each, name
        if each:
            assert price in prices[name], name
            checked += 1
    assert checked == 3


def test_the_doc_keeps_the_repo_rules():
    assert "—" not in TEXT
    lowered = TEXT.lower()
    for word in ("offline base", "compliant", "certified", "fits", "too slow"):
        assert word not in lowered, word
    assert not re.search(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", TEXT)
