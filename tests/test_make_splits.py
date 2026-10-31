"""scripts/make_splits.py: seeded, non-overlapping splits, never printing item text. Invented items."""

from __future__ import annotations

import json
from collections import Counter

import pytest

from base.config import REPO_ROOT
from scripts import make_splits as ms

DECISIONS = ms.DECISIONS


def items(prefix: str, n: int, *, start: int = 0, text: str = "result") -> list[dict]:
    return [{"id": f"{prefix}-{i:04d}", "request": f"Ask {i}", "result": f"Invented {text} number {i}.",
             "expected": DECISIONS[i % 4]} for i in range(start, start + n)]  # fmt: skip


def jsonl(path, rows):
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return path


@pytest.fixture
def world(tmp_path):
    source = items("syn", 400)
    # an existing set holds syn-0000..0019; another item in it repeats syn-0020's result text
    taken = jsonl(tmp_path / "fresh.jsonl", source[:20] + [{"id": "t001", "result": "invented RESULT number 20."}])
    compliance = jsonl(tmp_path / "compliance.jsonl", [{"id": "c-1", "text": "Invented result number 21."}])
    used = jsonl(tmp_path / "topics.jsonl", [{"id": "syn-0030", "ms": 5}, {"id": "syn-0031"}])
    src = jsonl(tmp_path / "synthetic.jsonl", source + [{**source[40], "id": "syn-9999"}])  # a repeat of syn-0040
    return tmp_path, src, [taken, compliance], [used]


def make(world, **kw):
    _tmp, src, sets, used = world
    return ms.make(ms.read_lines(src), sets, used, **{"sealed": 40, "holdout": 20, "unseen": 20, "days": 200, **kw})


def test_the_pool_leaves_out_set_ids_scored_ids_matching_texts_and_repeats(world):
    splits, left = make(world)
    assert left["reasons"] == {"in a set": 20, "text matches a set item": 2, "scored in a report": 2,
                               "repeats a pool item": 1}  # fmt: skip
    assert left["pool"] == 376 and left["sets"]["fresh.jsonl"] == 21 and left["used"]["topics.jsonl"] == 2
    ids = [i["id"] for name in ms.SPLITS for _l, i in splits[name]]
    assert len(ids) == len(set(ids))  # no item in two splits
    out = {"syn-0020", "syn-0021", "syn-0030", "syn-0031", "syn-9999"} | {f"syn-{i:04d}" for i in range(20)}
    assert not out & set(ids)


def test_sizes_and_exact_per_decision_counts(world):
    splits, left = make(world)
    assert [len(splits[n]) for n in ms.SPLITS] == [40, 20, 20, 200]
    for name in ("sim_holdout", "sim_unseen"):
        assert Counter(i["expected"] for _l, i in splits[name]) == {d: 5 for d in DECISIONS}
    assert left["spare"] == 376 - 280


def test_same_seed_same_bytes_other_seed_other_items(world, tmp_path):
    tmp, src, _sets, _used = world
    a, b = (make(world)[0], make(world)[0])
    assert a == b
    assert {i["id"] for _l, i in make(world, seed=7)[0]["fresh_200_c"]} != {i["id"] for _l, i in a["fresh_200_c"]}
    # lines are the source's, byte for byte, in source order
    source_lines = src.read_text().splitlines()
    for name in ms.SPLITS:
        lines = [line for line, _i in a[name]]
        assert lines == [line for line in source_lines if line in set(lines)]


def test_too_small_a_pool_or_an_uneven_share_is_a_plain_error(world):
    with pytest.raises(ms.SplitError, match="fewer than the 1000"):
        make(world, sealed=1000)
    with pytest.raises(ms.SplitError, match="equally"):
        make(world, holdout=10)
    with pytest.raises(ms.SplitError, match="items left, 100 are needed"):
        make(world, holdout=400)


def test_main_writes_files_and_an_unsealed_manifest_and_never_prints_text(world, capsys):
    tmp, src, sets, used = world
    out = tmp / "splits"
    argv = ["--source", str(src), "--sets", *map(str, sets), "--used", *map(str, used), "--sealed", "40",
            "--holdout", "20", "--unseen", "20", "--days", "100", "--out", str(out)]  # fmt: skip
    assert ms.main(argv) == 0
    printed = capsys.readouterr().out
    assert "Invented" not in printed and "Ask " not in printed and "syn-" not in printed
    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["status"] == "UNSEALED" and "contaminated" in manifest["reason"]
    assert manifest["files"]["fresh_200_c.jsonl"]["items"] == 40 and manifest["files"]["sim_days.jsonl"]["items"] == 100
    assert str(tmp) not in manifest["command"] and str(tmp) not in (out / "MANIFEST.md").read_text()
    assert "—" not in (out / "MANIFEST.md").read_text()
    assert ms.main(["--verify", "--out", str(out)]) == 0
    (out / "sim_days.jsonl").write_text("{}\n")
    assert ms.main(["--verify", "--out", str(out)]) == 1 and "changed" in capsys.readouterr().out


def test_the_committed_splits_match_their_manifest_and_touch_no_used_item():
    out = REPO_ROOT / "eval" / "splits"
    assert ms.verify(out) == []
    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["status"] == "UNSEALED" and manifest["seed"] == ms.SEED
    split_ids = [i["id"] for name in manifest["files"] for _l, i in ms.read_lines(out / name)]
    assert len(split_ids) == len(set(split_ids))
    used = {str(i["id"]) for p in [*ms.SETS, *ms.used_files()] for _l, i in ms.read_lines(p) if "id" in i}
    assert not used & set(split_ids)
    texts = {h for p in ms.SETS for _l, i in ms.read_lines(p) for h in ms.item_hashes(i)}
    assert not any(ms.item_hashes(i) & texts for name in manifest["files"] for _l, i in ms.read_lines(out / name))
    holdout = Counter(i["expected"] for _l, i in ms.read_lines(out / "sim_holdout.jsonl"))
    assert holdout == {d: 20 for d in DECISIONS}
