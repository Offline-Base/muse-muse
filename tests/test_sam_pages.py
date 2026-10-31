"""scripts/make_sam_pages.py: 24 invented page images with ground-truth boxes (eval/sam_pages)."""

from __future__ import annotations

import io
import json
import re
from pathlib import Path

import pytest
from PIL import Image

from base import manifest
from base.guard import find_identifiers, load_roster
from scripts import make_sam_pages as pages

REPO = Path(__file__).resolve().parent.parent
SET = REPO / "eval" / "sam_pages"
TRUTH = json.loads((SET / "truth.json").read_text(encoding="utf-8"))
ROSTER = load_roster(REPO / "eval" / "roster.json")
ROSTER_WORDS = {w.lower() for p in ROSTER.people() for w in (p.first, p.last, *p.nicknames)}
ROSTER_LASTS = {p.last for p in ROSTER.people()}


@pytest.fixture(scope="module")
def rendered() -> list[pages.Rendered]:
    return [pages.render(i) for i in range(len(pages.PAGES))]


def png_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def one_edit(a: str, b: str) -> bool:
    """True when b is a with one letter dropped, added or changed."""
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b, strict=True)) == 1
    short, long_ = sorted((a, b), key=len)
    return any(long_[:i] + long_[i + 1:] == short for i in range(len(long_)))


def test_a_rerun_writes_the_same_bytes(tmp_path, rendered):
    truth = pages.write(tmp_path)
    for i, spec in enumerate(pages.PAGES):
        assert (tmp_path / spec["file"]).read_bytes() == png_bytes(rendered[i].image), spec["file"]
    assert truth["pages"] == [pages.truth_row(i, r) for i, r in enumerate(rendered)]
    assert (tmp_path / ".synthetic").is_file()


def test_committed_set_matches_the_script(rendered):
    assert TRUTH["command"] == pages.COMMAND
    assert (SET / ".synthetic").is_file()
    on_disk = sorted(p.name for p in SET.iterdir() if p.name != "truth.json" and p.name not in manifest.SKIPPED_NAMES)
    assert on_disk == sorted(row["file"] for row in TRUTH["pages"])
    for i, row in enumerate(TRUTH["pages"]):
        fresh = pages.truth_row(i, rendered[i])
        assert {k: v for k, v in row.items() if k != "regions"} == {k: v for k, v in fresh.items() if k != "regions"}
        assert [r["kind"] for r in row["regions"]] == [r["kind"] for r in fresh["regions"]]
        for old, new in zip(row["regions"], fresh["regions"], strict=True):  # font rasterizing may differ by a pixel
            assert all(abs(a - b) <= 2 for a, b in zip(old["box"], new["box"], strict=True)), row["file"]
        with Image.open(SET / row["file"]) as im:
            assert im.size == (row["width"], row["height"])


def test_every_box_lies_inside_its_image():
    for row in TRUTH["pages"]:
        for region in row["regions"]:
            x1, y1, x2, y2 = region["box"]
            assert 0 <= x1 < x2 <= row["width"] and 0 <= y1 < y2 <= row["height"], row["file"]
            assert region["kind"] in TRUTH["kinds"]


def test_splits_kinds_and_negative_pages():
    rows = TRUTH["pages"]
    assert len(rows) == 24
    assert sorted(r["split"] for r in rows) == ["dev"] * 12 + ["test"] * 12
    negatives = [r for r in rows if not r["regions"]]
    assert len(negatives) == 5  # four printed pages plus a form with its signature line left blank
    for split in ("dev", "test"):
        kinds = {g["kind"] for r in rows if r["split"] == split for g in r["regions"]}
        assert kinds == set(pages.KINDS), split
        assert sum(1 for r in negatives if r["split"] == split) >= 2


def test_every_id_card_and_badge_says_sample(rendered):
    cards = [(spec["file"], texts) for spec, r in zip(pages.PAGES, rendered, strict=True)
             for kind, _, texts in r.regions if kind == "id_card"]
    assert len(cards) == 16
    for name, texts in cards:
        assert "SAMPLE" in texts, name


def allowed(hit) -> bool:
    v = hit.value
    if hit.kind == "phone":
        return re.fullmatch(r"555-01\d\d", v) is not None
    if hit.kind == "email":
        return re.search(r"@example\.(com|org)$", v) is not None
    if hit.kind == "ssn":
        return v.startswith(("9", "000"))
    if hit.kind == "card":
        return v.replace(" ", "") == "4111111111111111"
    if hit.kind == "student_id":
        return v in {p.student_id for p in ROSTER.students}
    if hit.kind == "address":
        return "Sample" in v or "Example" in v
    return hit.kind == "dob"  # every date on these pages is invented


def test_identifiers_are_only_synthetic_shapes(rendered):
    for spec, r in zip(pages.PAGES, rendered, strict=True):
        hits = find_identifiers("\n".join(r.texts), ROSTER)
        bad = [(h.kind, h.value) for h in hits if not allowed(h)]
        assert not bad, f"{spec['file']}: {bad}"


def test_signature_regions_hold_exactly_the_signature_names(rendered):
    for spec, r, row in zip(pages.PAGES, rendered, TRUTH["pages"], strict=True):
        written = sorted(t for kind, _, texts in r.regions if kind == "signature" for t in texts)
        assert written == sorted(row["signature_names"]), spec["file"]


def test_both_signature_cases_are_in_both_splits(rendered):
    """(a) an invented signer seen nowhere else on the page and not on the roster;
    (b) a roster surname misspelled by one letter."""
    found = {("a", "dev"), ("a", "test"), ("b", "dev"), ("b", "test")}
    seen = set()
    for spec, r, row in zip(pages.PAGES, rendered, TRUTH["pages"], strict=True):
        if spec["layout"] != "field_trip":
            continue
        for name in row["signature_names"]:
            words = name.split()
            others = [t for t in r.texts if t != name]
            if not any(w.lower() in ROSTER_WORDS for w in words) and not any(w in t for w in words for t in others):
                seen.add(("a", row["split"]))
            if any(one_edit(last, w) for w in words for last in ROSTER_LASTS):
                assert not any(w in ROSTER_LASTS for w in words)
                seen.add(("b", row["split"]))
    assert seen == found


def test_scribbles_and_blank_lines_have_no_names():
    by_file = {row["file"]: row for row in TRUTH["pages"]}
    for spec in pages.PAGES:
        sig = spec.get("signature")
        if (sig is None and spec["layout"] == "field_trip") or (isinstance(sig, dict) and sig["style"] == "scribble"):
            assert by_file[spec["file"]]["signature_names"] == [], spec["file"]
