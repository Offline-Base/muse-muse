"""Gate D1 of the dose test (plan, "Dose test"): does repeating already-trained facts teach more? Standard library only; runs on
train-1 (job/queue_b2.sh calls it) or this Mac. Counts only: no question, answer or reply text is printed or written.

Inputs: the dose questions (make_dose_set.py's questions.jsonl: dose_kind, group, sim per question) and one merged answer file per
model from measure_known.py (rows with i, question, reply, right): epoch 0 (stage 2, the dose run's start), epochs 1 to 5 (the
dose run's checkpoints), and base (reported only). Every row is joined on i, its question must be the question file's, and
"right" is recomputed with train_glimmer.answered() so a stale file can't pass.

D1 holds, and Stage A+ goes ahead, when all of these hold:
  1. The best epoch beats epoch 0 by at least 8 points on the 750 coverable probes from Meta, AI first-party and events, paired
     exact McNemar p < 0.05 (two-sided).
  2. At least 5 of those points hold on the coverable probes below 0.4 similarity to any dose-row question (same epochs).
  3. The 300 uncovered probes drop by 2 points or less from epoch 0, at E.
  4. Old facts stay at 39 of 40 or better, at E.
E is the smallest epoch within 2 points of the best on the 750: what Stage A+ would train for. Items 1 and 2 are read at the best
epoch, as the plan words them; 3 and 4 at E, the epochs Stage A+ would use. Every item is also reported for every epoch, with
CC-NEWS's 250 coverable probes (to size N2), the 500 verbatim training questions (grade_recall.py's key-fact grade) and base.
P(=self) on epoch 5 comes from the channel check, not from here.

  python3 dose_gate.py --questions data-dose/questions.jsonl --dir runs/dose/evals [--out runs/dose/evals/d1.json]
     reads DIR/epoch0.jsonl .. DIR/epoch5.jsonl and DIR/base.jsonl (or name each: --answers 0=FILE ... --answers base=FILE)
Exit 0: D1 holds (go). Exit 2: D1 fails (no-go). Exit 1: an answer file is missing or doesn't fit the questions.
"""

import argparse
import collections
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_glimmer import answered  # noqa: E402

try:
    from grade_recall import grade as recall_grade
except Exception:  # noqa: BLE001  grade_recall reads a word list at import; the verbatim score is reported only
    recall_grade = None

EPOCHS = (0, 1, 2, 3, 4, 5)
GATED_GROUPS = ("meta", "ai_first_party", "events")
MIN_GAIN = 8.0
MIN_LOW_SIM_GAIN = 5.0
MAX_CONTROL_DROP = 2.0
MIN_OLD = 39
WITHIN_BEST = 2.0
SIM_SPLIT = 0.4
ALPHA = 0.05


def read_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def mcnemar(a, b):
    """Exact two-sided McNemar p for paired right/wrong lists a (after) and b (before), and the discordant counts."""
    up = sum(x and not y for x, y in zip(a, b))
    down = sum(y and not x for x, y in zip(a, b))
    n = up + down
    if not n:
        return 1.0, up, down
    tail = sum(math.comb(n, k) for k in range(0, min(up, down) + 1)) / 2 ** n
    return min(1.0, 2 * tail), up, down


def pct(xs):
    return round(100.0 * sum(xs) / len(xs), 2) if xs else None


def load_answers(path, questions):
    """Right or wrong per question index, from a merged measure_known.py file, checked against the question file."""
    rows = read_jsonl(path)
    got = {}
    for r in rows:
        i = r.get("i")
        if not isinstance(i, int) or not 0 <= i < len(questions):
            raise ValueError(f"{path}: a row has index {i!r}, outside the {len(questions)} questions")
        if r.get("question") != questions[i]["question"]:
            raise ValueError(f"{path}: row {i} is for another question")
        if i in got:
            raise ValueError(f"{path}: row {i} appears twice")
        q = questions[i]
        reply = r.get("reply") or ""
        right = answered(reply, q)
        if q["dose_kind"] == "train" and recall_grade is not None:
            g = recall_grade(q["question"], q["answer"], reply)
            got[i] = {"right": right, "recall": g["right"]}
        else:
            got[i] = {"right": right, "recall": None}
    missing = len(questions) - len(got)
    if missing:
        raise ValueError(f"{path}: {missing} of {len(questions)} questions have no answer")
    return got


def subsets(questions):
    idx = collections.defaultdict(list)
    for i, q in enumerate(questions):
        k, g = q["dose_kind"], q.get("group")
        if k == "coverable":
            if g in GATED_GROUPS:
                idx["covered"].append(i)
                if (q.get("sim") or 0) < SIM_SPLIT:
                    idx["covered_low_sim"].append(i)
            else:
                idx["ccnews_covered"].append(i)
            idx[f"covered:{g}"].append(i)
        elif k == "uncovered":
            idx["uncovered"].append(i)
        elif k == "train":
            idx["train"].append(i)
        elif k == "old":
            idx["old"].append(i)
    return idx


def gate(questions, answers):
    """answers: {0: ..., 1: ..., ..., 5: ..., "base": ... (optional)} as load_answers gives. Returns the verdict as a dict."""
    idx = subsets(questions)
    need = {"covered": 750, "uncovered": 300, "old": 40}
    sizes = {k: len(v) for k, v in sorted(idx.items())}
    for k, n in need.items():
        if sizes.get(k, 0) != n:
            raise ValueError(f"the question file has {sizes.get(k, 0)} {k} questions, the gate expects {n}")
    right = {e: {k: [answers[e][i]["right"] for i in v] for k, v in idx.items()} for e in answers}
    table = {}
    for e in answers:
        r = right[e]
        row = {k: pct(r[k]) for k in ("covered", "covered_low_sim", "ccnews_covered", "uncovered")}
        row["old_right"] = sum(r["old"])
        row.update({f"covered:{g}": pct(r[f"covered:{g}"]) for g in (*GATED_GROUPS, "ccnews")})
        recall = [answers[e][i]["recall"] for i in idx["train"] if answers[e][i]["recall"] is not None]
        row["train_verbatim_recall"] = pct(recall) if recall else None
        row["train_verbatim_keyed"] = len(recall)
        row["train_verbatim_answered"] = pct(r["train"])  # whole training sentence in the reply: near zero, for reference only
        if e != 0:
            p, up, down = mcnemar(r["covered"], right[0]["covered"])
            zero = lambda k: pct(right[0][k])  # noqa: E731
            row["covered_gain"] = round(row["covered"] - zero("covered"), 2)
            row["covered_p"], row["covered_newly_right"], row["covered_newly_wrong"] = round(p, 6), up, down
            row["covered_low_sim_gain"] = round(row["covered_low_sim"] - zero("covered_low_sim"), 2)
            row["uncovered_drop"] = round(zero("uncovered") - row["uncovered"], 2)
            row["ccnews_covered_gain"] = round(row["ccnews_covered"] - zero("ccnews_covered"), 2)
        table[str(e)] = row
    epochs = [e for e in EPOCHS if e != 0]
    best = max(epochs, key=lambda e: (table[str(e)]["covered"], -e))
    E = min(e for e in epochs if table[str(e)]["covered"] >= table[str(best)]["covered"] - WITHIN_BEST)
    b, t = table[str(best)], table[str(E)]
    checks = [
        {"item": 1, "rule": f"best epoch beats epoch 0 by {MIN_GAIN:g}+ points on the 750, paired p < {ALPHA}", "epoch": best,
         "value": b["covered_gain"], "p": b["covered_p"], "pass": b["covered_gain"] >= MIN_GAIN and b["covered_p"] < ALPHA},
        {"item": 2, "rule": f"{MIN_LOW_SIM_GAIN:g}+ points hold below {SIM_SPLIT} similarity ({sizes['covered_low_sim']} probes)", "epoch": best,
         "value": b["covered_low_sim_gain"], "pass": b["covered_low_sim_gain"] >= MIN_LOW_SIM_GAIN},
        {"item": 3, "rule": f"uncovered 300 drop {MAX_CONTROL_DROP:g} points or less", "epoch": E, "value": t["uncovered_drop"],
         "pass": t["uncovered_drop"] <= MAX_CONTROL_DROP},
        {"item": 4, "rule": f"old facts {MIN_OLD}/40 or better", "epoch": E, "value": t["old_right"], "pass": t["old_right"] >= MIN_OLD},
    ]
    go = all(c["pass"] for c in checks)
    return {"go": go, "E": E, "best_epoch": best, "checks": checks, "by_epoch": table, "sizes": sizes,
            "settings": {"min_gain": MIN_GAIN, "min_low_sim_gain": MIN_LOW_SIM_GAIN, "max_control_drop": MAX_CONTROL_DROP, "min_old": MIN_OLD,
                         "within_best": WITHIN_BEST, "sim_split": SIM_SPLIT, "alpha": ALPHA, "test": "exact McNemar, two-sided",
                         "verbatim_grader": "grade_recall.grade" if recall_grade else "unavailable"}}


def print_verdict(v):
    cols = ("covered", "covered_gain", "covered_p", "covered_low_sim", "covered_low_sim_gain", "ccnews_covered", "uncovered", "uncovered_drop", "old_right", "train_verbatim_recall")
    print("| model | " + " | ".join(cols) + " |")
    print("|" + "---|" * (len(cols) + 1))
    for e, row in v["by_epoch"].items():
        print(f"| {'epoch ' + e if e != 'base' else 'base'} | " + " | ".join("" if row.get(c) is None else str(row.get(c)) for c in cols) + " |")
    for c in v["checks"]:
        print(f"{'PASS' if c['pass'] else 'FAIL'} D1.{c['item']} at epoch {c['epoch']}: {c['rule']}: {c['value']}" + (f", p {c['p']}" if "p" in c else ""))
    print(f"D1 {'GO' if v['go'] else 'NO-GO'}: best epoch {v['best_epoch']}, E {v['E']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--questions", required=True)
    ap.add_argument("--dir", help="folder with epoch0.jsonl .. epoch5.jsonl and base.jsonl")
    ap.add_argument("--answers", action="append", default=[], metavar="EPOCH=FILE", help="0..5 or base; overrides --dir for that model")
    ap.add_argument("--out")
    a = ap.parse_args()
    questions = read_jsonl(a.questions)
    files = {}
    if a.dir:
        files.update({e: os.path.join(a.dir, f"epoch{e}.jsonl") for e in EPOCHS})
        if os.path.exists(os.path.join(a.dir, "base.jsonl")):
            files["base"] = os.path.join(a.dir, "base.jsonl")
    for item in a.answers:
        k, _, path = item.partition("=")
        files["base" if k == "base" else int(k)] = path
    try:
        missing = [e for e in EPOCHS if e not in files or not os.path.exists(files[e])]
        if missing:
            raise ValueError(f"no answer file for epoch {', '.join(map(str, missing))}")
        answers = {e: load_answers(p, questions) for e, p in files.items() if e != "base" or os.path.exists(p)}
        verdict = gate(questions, answers)
    except ValueError as err:
        print(f"D1 ERROR: {err}")
        sys.exit(1)
    verdict["files"] = {str(k): v for k, v in files.items()}
    print_verdict(verdict)
    if a.out:
        with open(a.out + ".tmp", "w") as f:
            json.dump(verdict, f, indent=1)
        os.replace(a.out + ".tmp", a.out)
    sys.exit(0 if verdict["go"] else 2)


if __name__ == "__main__":
    main()
