"""Picks the dev control set of real named things (reports, trials, acts, funds: stage_b_lib.NAMED's shape) for
score_honesty_bf16.py --named-controls: held-out probes that Stage B never trains on, so compare_stage_b.py can report how many
a trained mix refuses. False premises are mostly invented names of this shape, so this is where over-refusal should show.

Out: what make_stage_b_questions.py keeps out, and anything already in the measured questions. stage_b_lib.Screen then keeps these
questions and their passages out of Stage B. Seeded, on this Mac, no GPU.

  python3 scripts/knowledge/aws/make_stage_b_named_controls.py [--n 150] [--seed 20261031]
"""

import argparse
import collections
import json
import os
import random

from make_stage_b_questions import answer_problem, digest, english, trained_questions
from stage_b_lib import D, HELD_OUT, NAMED_CONTROLS, PROBES, SKIP, Screen, named_thing, qkey, read_jsonl, source_kind, usable_aliases


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=150)
    ap.add_argument("--seed", type=int, default=20261031)
    ap.add_argument("--probes", default=PROBES)
    ap.add_argument("--questions", default=os.path.join(D, "stage-b-questions.jsonl"))
    ap.add_argument("--out", default=NAMED_CONTROLS)
    a = ap.parse_args()
    dev = os.path.join(D, "stage-b-honesty-dev.jsonl")
    screen = Screen(dev=dev if os.path.exists(dev) else None, held_out=HELD_OUT, pool=a.probes)
    measured = {qkey(p["question"]) for p in read_jsonl(a.questions)}
    trained = trained_questions([os.path.join(D, f) for f in ("train-stage1-frozen.jsonl", "train-stage2.jsonl")])
    dropped, picked = collections.Counter(), {}
    for p in read_jsonl(a.probes):
        if not named_thing(p["question"]):
            continue
        why = screen.why(p["question"])
        if not why and (p["passageId"] in screen.passages or screen.in_dev(p["passageId"])):
            why = "passage holds an eval or dev item"
        if not why and qkey(p["question"]) in measured:
            why = "in the measured questions"
        if not why and digest(qkey(p["question"])) in trained:
            why = "trained on"
        if not why and SKIP.match(source_kind(p["passageId"])):
            why = "set stays out of training"
        if not why and not english(p["question"]):
            why = "not in English"
        why = why or answer_problem(p)
        if why:
            dropped[why] += 1
        elif p["passageId"] not in picked:
            picked[p["passageId"]] = {**p, "aliases": usable_aliases(p["question"], p.get("aliases"))}
    rows = list(picked.values())
    random.Random(a.seed).shuffle(rows)
    rows = rows[:a.n]
    with open(a.out + ".tmp", "w") as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
    os.replace(a.out + ".tmp", a.out)
    print(json.dumps({"named_controls": len(rows), "eligible_passages": len(picked), "dropped": dict(dropped.most_common()), "out": os.path.relpath(a.out)}, indent=1))


if __name__ == "__main__":
    main()
