"""The student's smoke slice (job/STUDENT.md, section a): 200 probes (the first 100 fixed and the first 100 new in
stage2-eval-probes.jsonl's seed-7 order, which is how train_student.py orders them) and 3,000 training rows from
train-student.jsonl: every row of a passage those probes ask about, then the file's head (it is already shuffled) up
to 3,000, shuffled with seed 5.

  python3 scripts/knowledge/aws/make_student_slice.py OUT_DIR

Writes OUT_DIR/probes.jsonl and OUT_DIR/train.jsonl and prints what they hold.
"""
import json, os, random, sys

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".data", "knowledge", "dataset")
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)


def rows(name):
    with open(os.path.join(D, name)) as f:
        return [json.loads(l) for l in f if l.strip()]


fixed = {p["question"] for p in rows("eval-probes.jsonl")}
probes = rows("stage2-eval-probes.jsonl")
random.Random(7).shuffle(probes)
pick, n_fixed, n_new = [], 0, 0
for p in probes:
    if p["question"] in fixed and n_fixed < 100:
        pick.append(p)
        n_fixed += 1
    elif p["question"] not in fixed and n_new < 100:
        pick.append(p)
        n_new += 1
passages = {p["passageId"] for p in pick}
train = rows("train-student.jsonl")
of_probes = [r for r in train if r.get("source") in passages]
rest = [r for r in train if r.get("source") not in passages][: 3000 - len(of_probes)]
chosen = of_probes + rest
random.Random(5).shuffle(chosen)
for name, lines in (("probes.jsonl", pick), ("train.jsonl", chosen)):
    with open(os.path.join(OUT, name), "w") as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in lines)
covered = {r.get("source") for r in chosen}
print(json.dumps({"probes": len(pick), "fixed": n_fixed, "new": n_new, "probe_passages": len(passages),
                  "probes_covered": sum(p["passageId"] in covered for p in pick), "train": len(chosen),
                  "rows_of_probe_passages": len(of_probes)}))
