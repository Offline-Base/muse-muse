"""The Jetson student's full set: train-student.jsonl plus the honest rows of train-stage-b-student-a.jsonl, appended and
shuffled with a fixed seed. Input lines are kept byte for byte. The honest rows are false_premise, after_cutoff,
unknowable and cutoff_restated (16,164); that file's contrast and replay rows are left out, since they come from
train-student.jsonl itself, and it holds no reasoning rows.

train-student.jsonl's 1,185 template rows (sources cutoff and after-cutoff) are dropped. They state October 28, 2026, while
the corpus and every honest row state October 29 (assemble_stage_b.py's note). 1,177 of them come back as cutoff_restated,
the same questions at the right date; the other 8 said the model doesn't know October 29 itself. Stage B can rely on a
later pass overriding them, but one shuffled set can't: it would train both dates on the same questions.

Writes train-student-honest.jsonl, its .gz (gzip -nc, for the copy) and its -report.json in dataset/. Then:
python3 scripts/knowledge/aws/check_student_lineage.py train-student-honest.jsonl

  python3 scripts/knowledge/aws/make_student_honest.py
"""
import collections, gzip, hashlib, json, os, random

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".data", "knowledge", "dataset")
SEED = 20261031
BASE, EXTRA, OUT = "train-student.jsonl", "train-stage-b-student-a.jsonl", "train-student-honest.jsonl"
HONEST = {"false_premise", "after_cutoff", "unknowable", "cutoff_restated"}
SUPERSEDED = {"cutoff", "after-cutoff"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


with open(os.path.join(D, BASE), "rb") as f:
    base_bytes = f.read()
with open(os.path.join(D, EXTRA), "rb") as f:
    extra_bytes = f.read()
base = base_bytes.splitlines(keepends=True)
extra = extra_bytes.splitlines(keepends=True)
kinds, honest = collections.Counter(), []
for line in extra:
    kind = json.loads(line)["kind"]
    kinds[kind] += 1
    if kind in HONEST:
        honest.append(line)
if "reasoning" in kinds:
    raise SystemExit("reasoning rows in the student file")
kept = [line for line in base if json.loads(line)["source"] not in SUPERSEDED]
lines = kept + honest
random.Random(SEED).shuffle(lines)
data = b"".join(lines)
with open(os.path.join(D, OUT), "wb") as f:
    f.write(data)
packed = gzip.compress(data, mtime=0)
with open(os.path.join(D, OUT + ".gz"), "wb") as f:
    f.write(packed)
report = {
    "out": OUT, "examples": len(lines), "sha256": sha(data), "gz_sha256": sha(packed), "gz_bytes": len(packed), "seed": SEED,
    "from": {BASE: {"examples": len(base), "sha256": sha(base_bytes)}, EXTRA: {"examples": len(extra), "sha256": sha(extra_bytes), "kinds": dict(kinds)}},
    "dropped_superseded_templates": len(base) - len(kept), "honest_rows": len(honest), "honest_share": round(len(honest) / len(lines), 4),
}
with open(os.path.join(D, OUT.replace(".jsonl", "-report.json")), "w") as f:
    json.dump(report, f, indent=1)
    f.write("\n")
print(json.dumps(report, indent=1))
