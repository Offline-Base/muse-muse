"""Picks the questions Stage B's measurement asks (job/measure_known.py): about 40,000 of the held-out probes in
train-stage2-probes.jsonl, weighted to AI, Meta and general news (stage_b_lib.SHARES). Seeded, on this Mac, no GPU.

Out: the honesty test and dev set (normalized question, or a shared distinctive name: stage_b_lib.Screen, counts only);
eval-probes.jsonl, stage2-eval-probes.jsonl and forget.jsonl; every other question from a passage that holds an eval
or dev item; any question stage 1 or stage 2 trained on (by normalized text); sets that stay out of training; questions that
aren't in English (the reply would be); answers so short or generic that answered() can't tell knowing from luck (one
character, yes, no, true, false) or already in the question. An alias of two characters or fewer, or one the question
holds, is dropped and the row kept, since a reply saying the question back would otherwise count as right. At most
--per-passage from one passage, so more of the corpus gets measured.

  python3 scripts/knowledge/aws/make_stage_b_questions.py [--n 40000] [--seed 20261031] [--per-passage 1] \
      [--dev .data/knowledge/dataset/stage-b-honesty-dev.jsonl] [--out .data/knowledge/dataset/stage-b-questions.jsonl]

Writes OUT and OUT's -report.json. Prints counts only.
"""

import argparse
import collections
import hashlib
import json
import os
import random
import re

from stage_b_lib import D, PROBES, SHARES, SKIP, Screen, qkey, read_jsonl, source_kind, topic_group, usable_aliases

FOREIGN_START = re.compile(r"^\W*(welche[rsmn]?|wie|wer|wann|warum|wieviele|qual|quais|quem|quando|onde|como|quantos|quantas|quanto|"
                           r"cu[aá]nt[oa]s?|cu[aá]l(es)?|qui[eé]n|d[oó]nde|cu[aá]ndo|quel(le)?s?|combien|o[uù]|quand|chi|quale|quanti|dove)\b", re.I)
FOREIGN_WORD = re.compile(r"\b(der|das|und|ist|wurde|el|los|las|una|por|para|dos|em|foi|les|des|est|sur|dans|il|della|del|di)\b", re.I)
GENERIC = {"yes", "no", "true", "false"}


def digest(text):
    return hashlib.blake2b(text.encode(), digest_size=8).digest()


def english(question):
    letters = [c for c in question if c.isalpha()]
    if not letters or sum(ord(c) > 127 for c in letters) > 0.1 * len(letters):
        return False
    return not FOREIGN_START.match(question) and len(FOREIGN_WORD.findall(question)) < 2


def answer_problem(p):
    want = qkey(p["answer"])
    if len(want) < 2 or want in GENERIC:
        return "answer too short or generic"
    if f" {want} " in f" {qkey(p['question'])} ":
        return "answer already in the question"
    return None


def trained_questions(paths):
    seen = set()
    for path in paths:
        with open(path) as f:
            for line in f:
                seen.add(digest(qkey(json.loads(line)["messages"][1]["content"])))
    return seen


def pick(pool, n, shares, rng, per_passage):
    """pool: group -> rows. Each group's share of n, at most per_passage from a passage; a group's shortfall goes to the
    others in order of their shares."""
    used = collections.Counter()
    chosen = collections.defaultdict(list)
    queues = {g: list(rows) for g, rows in pool.items()}
    for rows in queues.values():
        rng.shuffle(rows)

    def take(group, want):
        rows = queues.get(group, [])
        while rows and want > 0:
            r = rows.pop()
            if used[r["passageId"]] < per_passage:
                used[r["passageId"]] += 1
                chosen[group].append(r)
                want -= 1
        return want

    short = sum(take(g, round(n * s)) for g, s in shares.items())
    for g in sorted(shares, key=lambda g: -shares[g]):
        short = take(g, short)
    return chosen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probes", default=PROBES)
    ap.add_argument("--out", default=os.path.join(D, "stage-b-questions.jsonl"))
    ap.add_argument("--dev", help="the honesty dev set, screened like the test; its file if it exists by default")
    ap.add_argument("--n", type=int, default=40000)
    ap.add_argument("--seed", type=int, default=20261031)
    ap.add_argument("--per-passage", type=int, default=1)
    ap.add_argument("--trained", default=",".join(os.path.join(D, f) for f in ("train-stage1-frozen.jsonl", "train-stage2.jsonl")))
    a = ap.parse_args()
    dev = a.dev or os.path.join(D, "stage-b-honesty-dev.jsonl")
    dev = dev if os.path.exists(dev) else None
    screen = Screen(dev=dev, pool=a.probes)
    trained = trained_questions(a.trained.split(","))
    dropped = collections.Counter()
    pool = collections.defaultdict(list)
    total = aliases_dropped = 0
    for p in read_jsonl(a.probes):
        total += 1
        why = screen.why(p["question"])
        if not why and (p["passageId"] in screen.passages or screen.in_dev(p["passageId"])):
            why = "passage holds an eval or dev item"
        if not why and digest(qkey(p["question"])) in trained:
            why = "trained on"
        if not why and SKIP.match(source_kind(p["passageId"])):
            why = "set stays out of training"
        if not why and not english(p["question"]):
            why = "not in English"
        why = why or answer_problem(p)
        if why:
            dropped[why] += 1
        else:
            kept = usable_aliases(p["question"], p.get("aliases"))
            aliases_dropped += len(p.get("aliases") or []) - len(kept)
            pool[topic_group(p["passageId"])].append({**p, "aliases": kept})
    chosen = pick(pool, a.n, SHARES, random.Random(a.seed), a.per_passage)
    rows = [r for g in chosen.values() for r in g]
    random.Random(a.seed + 1).shuffle(rows)
    with open(a.out + ".tmp", "w") as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
    os.replace(a.out + ".tmp", a.out)
    report = {
        "pool": total, "dropped": dict(dropped.most_common()), "aliases_dropped": aliases_dropped, "eligible": {g: len(v) for g, v in pool.items()},
        "questions": len(rows), "by_group": {g: len(v) for g, v in chosen.items()},
        "top_sources": dict(collections.Counter(source_kind(r["passageId"]) for r in rows).most_common(15)),
        "screen": screen.counts(), "dev_set": bool(dev), "seed": a.seed, "per_passage": a.per_passage, "out": os.path.relpath(a.out),
    }
    with open(re.sub(r"\.jsonl$", "", a.out) + "-report.json", "w") as f:
        json.dump(report, f, indent=1)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
