"""Marks each question whose answer was trained: its answer or an alias appears, as whole words (train_glimmer.answered), in
the answer of any stage 1 or stage 2 training row from the same passage. A question whose answer never appears there is
"never trained": a wrong reply to it is a fact the model never saw, not one it half knows. Standard library only.

Inputs, streamed: the question files (default the 2,500 eval probes and the 40,000 Stage B questions) and the training
files (default train-stage1-frozen.jsonl and train-stage2.jsonl, the exact files stage1-multi and stage2-multi trained on;
a .gz path is read as gzip). Only fact rows count (source:, event:, article:), the same rows the probes were held out from.

Writes one line per question to OUT: {"set", "i" (line in its file), "passageId", "key" (blake2b of passageId and the
normalized question, what assemble_stage_b.py joins on), "trained" (answer or alias), "answer_trained" (the answer alone,
the rule behind the plan's 1,917 and 583 on the 2,500), "rows" (training rows of that passage), "stage1", "stage2" (rows
whose answer holds the answer or an alias)}. No question or answer text goes in OUT, and only counts are printed.

  python3 scripts/knowledge/aws/trained_answer_split.py --out .data/knowledge/dataset/trained-answers.jsonl
"""

import argparse
import collections
import gzip
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "job"))
from train_glimmer import normalize  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
D = os.path.join(ROOT, ".data", "knowledge", "dataset")
FACT = re.compile(r"^(source|event|article):")
QUESTIONS = [("eval-2500", os.path.join(D, "stage2-eval-probes.jsonl")), ("stage-b-40000", os.path.join(D, "stage-b-questions.jsonl"))]
TRAIN = [("stage1", os.path.join(D, "train-stage1-frozen.jsonl")), ("stage2", os.path.join(D, "train-stage2.jsonl"))]


def read_jsonl(path):
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def qkey(question):
    return normalize(question).strip()


def label_key(passage, question):
    """The join key: one passage and one question, normalized as stage_b_lib.qkey does."""
    return hashlib.blake2b(f"{passage}\n{qkey(question)}".encode(), digest_size=12).hexdigest()


def targets(row, aliases=True):
    """The answer and, with aliases, every alias, normalized, as train_glimmer.answered compares them."""
    out = {normalize(a).strip() for a in [row["answer"], *((row.get("aliases") or []) if aliases else [])]}
    return [" " + t + " " for t in out if t]


def assistant_text(row):
    return " ".join(m.get("content") or "" for m in row.get("messages") or [] if m.get("role") == "assistant")


def split(question_files, train_files):
    """Labels in input order, and counts. Each question file is (set name, path), each training file (stage, path)."""
    labels, by_passage = [], collections.defaultdict(list)
    for name, path in question_files:
        for i, row in enumerate(read_jsonl(path)):
            lab = {"set": name, "i": i, "passageId": row.get("passageId") or "", "key": label_key(row.get("passageId") or "", row["question"]),
                   "trained": False, "answer_trained": False, "rows": 0, **{stage: 0 for stage, _ in train_files}}
            labels.append(lab)
            by_passage[lab["passageId"]].append((lab, targets(row), targets(row, aliases=False)))
    seen = collections.Counter()
    for stage, path in train_files:
        for row in read_jsonl(path):
            source = row.get("source") or ""
            if not FACT.match(source):
                continue
            seen[stage] += 1
            waiting = by_passage.get(source)
            if not waiting:
                continue
            said = normalize(assistant_text(row))
            for lab, want, answer in waiting:
                lab["rows"] += 1
                if any(t in said for t in want):
                    lab[stage] += 1
                    lab["trained"] = True
                if any(t in said for t in answer):
                    lab["answer_trained"] = True
    counts = {"fact_rows_read": dict(seen)}
    for name, _ in question_files:
        mine = [lab for lab in labels if lab["set"] == name]
        counts[name] = {"questions": len(mine), "trained": sum(lab["trained"] for lab in mine), "never_trained": sum(not lab["trained"] for lab in mine),
                        "answer_only_trained": sum(lab["answer_trained"] for lab in mine), "answer_only_never_trained": sum(not lab["answer_trained"] for lab in mine),
                        "trained_through_alias_only": sum(lab["trained"] and not lab["answer_trained"] for lab in mine),
                        "passage_has_training_rows": sum(lab["rows"] > 0 for lab in mine),
                        "never_trained_with_rows": sum(not lab["trained"] and lab["rows"] > 0 for lab in mine),
                        **{"in_" + stage: sum(lab[stage] > 0 for lab in mine) for stage, _ in train_files}}
    return labels, counts


def write_labels(path, labels):
    with open(path + ".tmp", "w") as f:
        f.writelines(json.dumps(lab, separators=(",", ":")) + "\n" for lab in labels)
    os.replace(path + ".tmp", path)


def load_labels(path, field="trained"):
    """key -> trained, for assemble_stage_b.py. A key labelled twice with different values is not trusted (None)."""
    out = {}
    for lab in read_jsonl(path):
        k, v = lab["key"], lab[field]
        out[k] = v if k not in out or out[k] == v else None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--questions", action="append", metavar="NAME=PATH", help="question files; default the 2,500 and the 40,000")
    ap.add_argument("--train", action="append", metavar="STAGE=PATH", help="training files; default stage 1 frozen and stage 2")
    ap.add_argument("--out", default=os.path.join(D, "trained-answers.jsonl"))
    a = ap.parse_args()
    pairs = lambda xs, default: [tuple(x.split("=", 1)) for x in xs] if xs else default  # noqa: E731
    labels, counts = split(pairs(a.questions, QUESTIONS), pairs(a.train, TRAIN))
    write_labels(a.out, labels)
    print(json.dumps(counts, indent=1))


if __name__ == "__main__":
    main()
