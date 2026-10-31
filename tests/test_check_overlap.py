"""scripts/check_overlap.py: training data against the eval sets, counts only. Invented data."""

from __future__ import annotations

import json

import pytest

from scripts import check_overlap as co

ITEMS = [
    {"id": "syn-9001", "request": "Share [Student A] spelling scores from the Friday quiz for my records.",
     "result": "Quorra Fennimore scored 18 of 20 on the Friday spelling quiz and missed two words.",
     "names": ["Quorra Fennimore"], "identifiers": []},
    {"id": "syn-9002", "request": "Summarize how the class did on the fraction exit ticket this week.",
     "result": "Most of the class placed fractions on a number line correctly, and six students mixed up halves and thirds.",
     "names": [], "identifiers": []},
    {"id": "syn-9003", "request": "Draft a note to [Student B]'s family about the field trip form.",
     "result": "Brannoch Elsworthy still needs the signed field trip form; call 555-0142 with questions.",
     "names": ["Brannoch Elsworthy"], "other_names": ["Morwen Elsworthy"], "identifiers": ["555-0142"]},
    {"id": "syn-9004", "request": "List which reading group each student is in for the spring term.",
     "result": "Group one meets Monday, group two meets Wednesday, and group three meets Friday mornings.",
     "names": [], "identifiers": []},
]  # fmt: skip
ROSTER = {"teacher": {"name": "Ilsabet Marrowgate", "first": "Ilsabet", "last": "Marrowgate"},
          "students": [{"name": "Tobiah Quenneville", "first": "Tobiah", "last": "Quenneville", "nicknames": []}]}  # fmt: skip


def jsonl(path, rows):
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    return path


def chat(user: str, answer: str = '{"decision": "share_tagged"}') -> dict:
    return {"messages": [{"role": "system", "content": "You decide what leaves the device."},
                         {"role": "user", "content": user}, {"role": "assistant", "content": answer}]}  # fmt: skip


@pytest.fixture
def files(tmp_path):
    sets = jsonl(tmp_path / "fresh_test.jsonl", ITEMS)
    roster = tmp_path / "roster.json"
    roster.write_text(json.dumps(ROSTER))
    return tmp_path, sets, roster


def run(tmp_path, train, sets, roster, *extra):
    argv = ["--train", str(train), "--sets", str(sets), "--roster", str(roster), "--name", "t", "--out", str(tmp_path / "r"), *extra]
    code = co.main(argv)
    return code, (tmp_path / "r" / "overlap_t.md").read_text()


def test_exact_near_name_and_id_hits_are_counted_and_no_text_is_written(files, capsys):
    tmp_path, sets, roster = files
    train = jsonl(tmp_path / "train.jsonl", [
        # 1: the request, in the router's layout, and its result tagged the way egress tags it
        chat("Request: Share [Student A] spelling scores from the Friday quiz for my records.\nResult kind: per_student\n"
             "Tagged text:\n[Student A] scored 18 of 20 on the Friday spelling quiz and missed two words."),
        # 2: the result with one word changed
        {"request": "class results", "tagged_text": "Most of the class placed fractions on a number line correctly, "
                                                     "and six students mixed up halves and quarters."},
        # 3: an invented name from item 3, and item 4's id
        {"note": "Morwen Elsworthy signed it.", "item_id": "syn-9004"},
    ])  # fmt: skip
    code, text = run(tmp_path, train, sets, roster)
    assert code == 1
    assert "| fresh_test.jsonl | 4 | 1 | 1 | 1 | 1 | 4 |" in text
    for item in ITEMS:
        for value in (item["request"], item["result"], item["id"], *item["names"], *item.get("other_names", [])):
            assert value not in text and value.lower() not in text
    assert str(tmp_path) not in text and "Command: `uv run python -m scripts.check_overlap --train train.jsonl" in text
    assert "Quorra" not in capsys.readouterr().out


def test_unrelated_training_data_is_clean_and_exits_0(files):
    tmp_path, sets, roster = files
    train = jsonl(tmp_path / "train.jsonl", [chat("Request: Find essays about volcanoes and lava for my notes.\nResult kind: snippet"),
                                             {"request": "What is the class median?", "tagged_text": "The median was 3."}])  # fmt: skip
    code, text = run(tmp_path, train, sets, roster)
    assert code == 0 and "Result: clean" in text and "| fresh_test.jsonl | 4 | 0 | 0 | 0 | 0 | 0 |" in text


def test_roster_names_in_training_rows_are_counted(files):
    tmp_path, sets, roster = files
    train = jsonl(tmp_path / "train.jsonl", [{"text": "Tobiah  Quenneville wrote about bees."}, {"text": "Nothing here."}, "plain"])
    (tmp_path / "train.jsonl").write_text((tmp_path / "train.jsonl").read_text() + "not json\n")
    code, text = run(tmp_path, train, sets, roster)
    assert code == 1 and "roster: 1 (1 of the roster's 2 names)" in text and "Tobiah" not in text
    assert "3 rows, 1 unreadable lines" in text


def test_near_duplicates_follow_the_threshold(files):
    tmp_path, sets, roster = files
    changed = "Group one meets Tuesday, group two meets Wednesday, and group three meets Friday mornings."  # one word changed
    train = jsonl(tmp_path / "train.jsonl", [{"text": changed}])
    assert "| 4 | 0 | 1 |" in run(tmp_path, train, sets, roster)[1]
    assert "| 4 | 0 | 0 |" in run(tmp_path, train, sets, roster, "--threshold", "0.95")[1]
    assert "| 4 | 0 | 0 |" in run(tmp_path, train, sets, roster, "--shingle", "3")[1]  # 3 of 12 runs of three change


def test_normalize_folds_tags_case_and_punctuation():
    assert co.normalize("[Student A] and [Student B]'s  Essay!") == "zztagzz and zztagzz s essay"
    assert co.normalize("[Student A] [Student B] wrote") == "zztagzz wrote"


def test_the_near_check_matches_a_brute_force_jaccard():
    train = co.Training([])
    texts = ["the quick brown fox jumps over the lazy dog today", "a quick brown fox jumps over the lazy dog today",
             "something else entirely about the garden and the bees"]  # fmt: skip
    train.sets = [co.shingles(co.normalize(t)) for t in texts]
    for i, sh in enumerate(train.sets):
        for s in sh:
            train.index.setdefault(s, []).append(i)
    query = co.normalize("the quick brown fox jumps over the lazy dog tonight")
    a = co.shingles(query)
    best = max(len(a & b) / len(a | b) for b in train.sets)
    for t in (0.5, 0.7, best, best + 0.01):
        assert train.near(query, t) == (best >= t)


def test_a_folder_set_reads_one_item_per_markdown_file(tmp_path):
    folder = tmp_path / "essays"
    folder.mkdir()
    (folder / "a.md").write_text("My garden has tomatoes, beans and three kinds of squash this year.\n")
    (folder / "README.txt").write_text("not an essay")
    train = jsonl(tmp_path / "train.jsonl", [{"text": "Rubric: ideas\nEssay:\nMy garden has tomatoes, beans and three kinds of squash this year."}])
    code, text = run(tmp_path, train, folder, tmp_path / "none.json")
    assert code == 1 and "| essays/ | 1 | 1 |" in text
