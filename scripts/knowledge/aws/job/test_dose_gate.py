"""Offline checks for dose_gate.py, check_by_kind.py and make_dose_set.py's draw and near search, on synthetic data only (no
real question, answer or row is read). Standard library, plain asserts, one process:

  python3 -I scripts/knowledge/aws/job/test_dose_gate.py
"""

import json
import os
import random
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import check_by_kind  # noqa: E402
import dose_gate  # noqa: E402
import make_dose_set  # noqa: E402

done = []


def ok(name, detail=""):
    done.append(name)
    print(f"ok {len(done)}: {name}{' (' + str(detail) + ')' if detail != '' else ''}", flush=True)


def synthetic_questions():
    qs = []
    for g in ("meta", "ai_first_party", "events", "ccnews"):
        for k in range(250):
            qs.append({"question": f"Covered question {g} {k}?", "answer": f"answer{g}{k}", "aliases": [], "dose_kind": "coverable", "group": g, "sim": 0.2 if k % 2 else 0.7})
    for k in range(300):
        qs.append({"question": f"Uncovered question {k}?", "answer": f"control{k}", "aliases": [], "dose_kind": "uncovered", "group": "meta", "sim": 0.1})
    for k in range(500):
        qs.append({"question": f"Who led Zarnia project {k} in March?", "answer": f"Orlanda Vexby led project {k} in March.", "aliases": [], "dose_kind": "train", "group": "events", "sim": 1.0})
    for k in range(40):
        qs.append({"question": f"Old fact {k}?", "answer": f"old{k}", "aliases": [], "dose_kind": "old", "group": "old", "sim": 0.0})
    return qs


def answers_file(folder, name, qs, right):
    """A merged measure_known.py file where question i is answered right exactly when right(i, q)."""
    path = os.path.join(folder, name)
    with open(path, "w") as f:
        for i, q in enumerate(qs):
            reply = (q["answer"] if q["dose_kind"] != "train" else "Orlanda Vexby did.") if right(i, q) else "I am not sure."
            f.write(json.dumps({"i": i, "question": q["question"], "reply": reply, "right": False, "ended": True}) + "\n")
    return path


def make_case(folder, qs, base_rate, gains, low_gains=None, control_drop=0, old_right=40, train_rate=0.3):
    """epoch0..epoch5 where the 750 gated coverable probes go from base_rate up by gains[e] points (low-sim ones by low_gains[e])."""
    gated = [i for i, q in enumerate(qs) if q["dose_kind"] == "coverable" and q["group"] != "ccnews"]
    low = [i for i in gated if qs[i]["sim"] < 0.4]
    high = [i for i in gated if qs[i]["sim"] >= 0.4]
    unc = [i for i, q in enumerate(qs) if q["dose_kind"] == "uncovered"]
    old = [i for i, q in enumerate(qs) if q["dose_kind"] == "old"]
    train = [i for i, q in enumerate(qs) if q["dose_kind"] == "train"]
    low_gains = low_gains or gains
    for e in range(6):
        # Nested sets, so a later epoch keeps what an earlier one had: paired gains, as training would give.
        n_low = round(len(low) * (base_rate + low_gains[e] / 100))
        n_all = round(len(gated) * (base_rate + gains[e] / 100))
        n_high = max(0, n_all - n_low)
        yes = set(low[:n_low]) | set(high[:n_high])
        yes |= set(unc[:round(len(unc) * 0.2) - (round(len(unc) * control_drop / 100) if e == 5 else 0)])
        yes |= set(old[:old_right if e >= 1 else 40])
        yes |= set(train[:round(len(train) * train_rate)])
        yes |= {i for i, q in enumerate(qs) if q["group"] == "ccnews" and q["dose_kind"] == "coverable" and i % 3 == 0}
        answers_file(folder, f"epoch{e}.jsonl", qs, lambda i, q, yes=yes: i in yes)
    answers_file(folder, "base.jsonl", qs, lambda i, q: i % 7 == 0)


def run_gate(folder, qfile):
    r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "dose_gate.py"), "--questions", qfile, "--dir", folder, "--out", os.path.join(folder, "d1.json")],
                       capture_output=True, text=True)
    verdict = json.load(open(os.path.join(folder, "d1.json"))) if r.returncode in (0, 2) else None
    return r, verdict


def check_mcnemar():
    p, up, down = dose_gate.mcnemar([True] * 10 + [False] * 2 + [True] * 5, [False] * 10 + [True] * 2 + [True] * 5)
    assert (up, down) == (10, 2) and abs(p - 2 * (1 + 12 + 66) / 4096) < 1e-12, (p, up, down)
    assert dose_gate.mcnemar([True, False], [True, False])[0] == 1.0
    ok("exact McNemar matches the hand count", f"10 up, 2 down: p {p:.5f}")


def check_gate():
    qs = synthetic_questions()
    with tempfile.TemporaryDirectory(prefix="dose-gate-") as d:
        qfile = os.path.join(d, "questions.jsonl")
        with open(qfile, "w") as f:
            f.writelines(json.dumps(q) + "\n" for q in qs)

        def case(name, **kw):
            folder = os.path.join(d, name)
            os.makedirs(folder)
            make_case(folder, qs, 0.3, **kw)
            return run_gate(folder, qfile)

        r, v = case("go", gains=[0, 6, 10, 12, 11, 12])
        assert r.returncode == 0 and v["go"], r.stdout
        assert v["best_epoch"] == 3 and v["E"] == 2, (v["best_epoch"], v["E"])  # 10 is within 2 points of 12; ties go to the earlier epoch
        assert v["by_epoch"]["3"]["covered_gain"] == 12.0 and v["by_epoch"]["base"]["covered"] is not None
        assert v["by_epoch"]["1"]["train_verbatim_recall"] == 30.0, v["by_epoch"]["1"]
        assert "GO" in r.stdout and "answer" not in r.stdout and "Covered question" not in r.stdout
        ok("D1 goes on a 12-point gain; best epoch 3, E 2", r.stdout.strip().splitlines()[-1])

        r, v = case("small", gains=[0, 3, 5, 7, 7, 6])
        assert r.returncode == 2 and not v["go"] and not v["checks"][0]["pass"]
        r, v = case("lowsim", gains=[0, 6, 9, 10, 10, 10], low_gains=[0, 1, 2, 3, 3, 3])
        assert r.returncode == 2 and v["checks"][0]["pass"] and not v["checks"][1]["pass"], v["checks"]
        r, v = case("control", gains=[0, 6, 8, 10, 11, 12], control_drop=5)
        # The drop is at epoch 5 only, and E is 3 (10 points, within 2 of the best 12): D1 holds, and the drop is still reported.
        assert r.returncode == 0 and v["E"] == 3 and v["checks"][2]["pass"] and v["by_epoch"]["5"]["uncovered_drop"] == 5.0, v["checks"]
        r, v = case("control5", gains=[0, 2, 4, 6, 8, 12], control_drop=5)
        assert r.returncode == 2 and v["E"] == 5 and not v["checks"][2]["pass"], v["checks"]
        r, v = case("old", gains=[0, 6, 10, 12, 11, 12], old_right=38)
        assert r.returncode == 2 and not v["checks"][3]["pass"], v["checks"]
        ok("D1 stops on a small gain, a gain only on near questions, a control drop at E, and old facts below 39")

        os.remove(os.path.join(d, "old", "epoch4.jsonl"))
        r, _ = run_gate(os.path.join(d, "old"), qfile)
        assert r.returncode == 1 and "epoch 4" in r.stdout
        bad = os.path.join(d, "go", "epoch2.jsonl")
        lines = open(bad).read().splitlines()
        row = json.loads(lines[5])
        row["question"] = "Something else?"
        lines[5] = json.dumps(row)
        with open(bad, "w") as f:
            f.write("\n".join(lines) + "\n")
        r, _ = run_gate(os.path.join(d, "go"), qfile)
        assert r.returncode == 1 and "row 5 is for another question" in r.stdout and "Something else" not in r.stdout
        ok("a missing epoch or a row for another question stops with exit 1, naming only the index")


def check_by_kind_rule():
    by_kind = {"reasoning": 18000, "false_premise": 2900, "after_cutoff": 1800, "unknowable": 1110, "cutoff_restated": 990, "measured_wrong": 1600,
               "measured_right": 8440, "replay": 4200, "contrast": 20960}
    table = {"by_kind": {"reasoning": 18000, "false_premise+after_cutoff+unknowable": 5810, "cutoff_restated": 990, "measured_wrong": 1600,
                         "measured_right": 8440, "replay": 4200, "contrast": 20960}, "total": 60000}
    good, lines = check_by_kind.check(by_kind, table, 0.02)
    assert good, lines
    off = dict(by_kind, measured_wrong=1640)  # 2.5% over
    assert not check_by_kind.check(off, table, 0.02)[0]
    near = dict(by_kind, measured_wrong=1631)  # 1.9% over
    assert check_by_kind.check(near, dict(table, total=60031), 0.02)[0]
    extra = dict(by_kind, stray=5)
    assert not check_by_kind.check(extra, table, 0.02)[0]
    assert not check_by_kind.check(by_kind, table, 0.02, file_counts=dict(by_kind, replay=4199))[0]
    assert not check_by_kind.check(by_kind, table, 0.02, records=60000, file_rows=59999)[0]
    # r30b's real report against r30b's column of the plan passes; against B2's table it fails, as it must.
    r30b = {"contrast": 20397, "reasoning": 18000, "measured_right": 7023, "replay": 4091, "measured_wrong": 3652, "false_premise": 3023, "after_cutoff": 1621,
            "unknowable": 1392, "cutoff_restated": 801}
    r30b_table = {"by_kind": {"reasoning": 18000, "false_premise+after_cutoff+unknowable": 6036, "cutoff_restated": 801, "measured_wrong": 3652,
                              "measured_right": 7023, "replay": 4091, "contrast": 20397}, "total": 60000}
    assert check_by_kind.check(r30b, r30b_table, 0.02)[0]
    good, lines = check_by_kind.check(r30b, table, 0.02)
    assert not good and sum(line.startswith("FAIL") for line in lines) == 6, lines
    assert check_by_kind.dose_group("source:meta-docs:x:0") == "meta" and check_by_kind.dose_group("source:gap-hf-facebook:x:0") == "meta"
    assert check_by_kind.dose_group("source:gap-hf-qwen:x:0") == "ai_first_party" and check_by_kind.dose_group("source:pytorch-blog:x:0") == "ai_first_party"
    assert check_by_kind.dose_group("event:2026-01-04:0") == "events" and check_by_kind.dose_group("source:s3-ccnews-general:x:0") == "ccnews"
    assert check_by_kind.dose_group("article:T:S:0") is None and check_by_kind.dose_group("anchor:x") is None and check_by_kind.dose_group("replay:3") is None
    ok("by_kind rule: 2% per planned entry, combined kinds, stray kinds, file against report; r30b's set fails B2's table", "6 entries off")


def check_fill_and_near():
    rng = random.Random(5)
    for trial in range(300):
        pool = [f"p{i}" for i in range(rng.randrange(1, 40))]
        size = {p: rng.choice([1, 2, 3, 5, 8, 9, 13, 20]) if rng.random() < 0.8 else rng.randrange(1, 30) for p in pool}
        target = rng.randrange(1, 120)
        picked, info = make_dose_set.fill_exact(pool, size, target)
        possible = {0}
        for p in pool:
            possible |= {s + size[p] for s in possible if s + size[p] <= target}
        assert (picked is not None) == (target in possible), (trial, picked, info)
        if picked:
            assert sum(size[p] for p in picked) == target and len(set(picked)) == len(picked)
    pool = ["a", "b", "c"]
    assert make_dose_set.fill_exact(pool, {"a": 9, "b": 9, "c": 1}, 19)[0] == ["a", "b", "c"]
    picked, info = make_dose_set.fill_exact(["a", "b", "c"], {"a": 4, "b": 3, "c": 3}, 6)
    assert sorted(picked) == ["b", "c"] and info["given_back"] == 1
    ok("fill_exact finds whole passages for exactly the target whenever any exist", "300 random pools, against brute force")

    words = [f"w{i}" for i in range(30)]
    sets = [frozenset(rng.sample(words, rng.randrange(1, 9))) for _ in range(400)]
    index = make_dose_set.NearIndex(sets, 0.6)
    for _ in range(600):
        s = frozenset(rng.sample(words, rng.randrange(1, 9)))
        brute = max((make_dose_set.jaccard(s, t) for t in sets), default=0)
        got = index.best(s)
        assert (got is not None) == (brute >= 0.6), (sorted(s), brute, got)
        if got:
            assert abs(got[1] - brute) < 1e-12
    assert index.best(frozenset()) is None
    sims = make_dose_set.max_similarity([frozenset({"w1", "w2"}), frozenset({"zz"})], [frozenset({"w1", "w2", "w3"}), frozenset({"w2"})])
    assert sims == [2 / 3, 0.0], sims
    ok("prefix-filtered near search agrees with brute force", "600 random sets at Jaccard 0.6; max_similarity by hand")


if __name__ == "__main__":
    check_mcnemar()
    check_gate()
    check_by_kind_rule()
    check_fill_and_near()
    print(f"all {len(done)} checks passed")
