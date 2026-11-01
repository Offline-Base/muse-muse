"""The dose test's training set and questions (plan, "Dose test"; gate D1 in job/dose_gate.py). Standard library only, on this Mac.

Training rows, dose/train.jsonl (15,000): every stage 1 and stage 2 fact row (source:, event:, article:) of passages drawn at
random (seed 20261101), 3,750 rows from each of four groups (check_by_kind.dose_group: Meta, AI first-party, Wikipedia current
events, CC-NEWS). Passages go in whole, in the drawn order, skipping one that would overshoot its group's 3,750. Each row is the
exact line a stage file trained on, so nothing new enters training; the file is then shuffled with the same seed.

Left out, as whole passages:
- any passage of the 2,500 eval probes (with the fixed 1,500 and the new 1,000), the 40,000 Stage B questions or the named
  controls (by passageId);
- any passage or record of the honesty dev set (its source names the passage, as stage_b_lib.Screen reads it);
- any passage with a row whose question is, normalized, a test question, or a near match (content-word Jaccard 0.6 or more,
  stage_b_lib's NEAR) of one: the 2,500, the 40 old facts, the honesty dev set, the named controls, the cutoff questions,
  salient_probes, reasoning_probes and honesty_probes (the 190);
- any passage with a row holding a salient answer: its answer holds the salient item's answer or a usable alias and its
  question shares at least 2 content words with the salient question.

Questions, dose/questions.jsonl (1,840), each with dose_kind, group and sim (the highest content-word Jaccard to any dose-row
question; D1 splits at 0.4):
- 1,000 coverable: held-out probes (probes.jsonl, train-stage2-probes.jsonl) of the dose passages whose answer or a usable
  alias appears in a dose row's answer of that passage, 250 per group;
- 300 uncovered: held-out probes of those passages whose answer and every alias appear in none, 75 per group;
- 500 train: dose-row questions verbatim, 125 per group, ones grade_recall.py can key (their answer is the training answer);
- 40 old: the old facts (forget.jsonl).
A held-out probe whose normalized question any stage 1 or 2 row trained on is dropped (it wasn't held out after all).

Also written: dose/probes.jsonl (the 2,500, which train_glimmer.py needs present), dose/forget.jsonl, dose/passages.json (passage
ids by group) and dose/report.json (counts, settings and sha256s; "set.by_kind" is what queue_b2.sh checks). The folder is the
run's data folder: copy it to train-1 as ~/k/data-dose. Only counts are printed; no question, answer or row text.

  python3 scripts/knowledge/aws/make_dose_set.py [--out .data/knowledge/dataset/dose]
"""

import argparse
import collections
import hashlib
import json
import math
import os
import random
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
JOB = os.path.join(HERE, "job")
sys.path.insert(0, JOB)
from check_by_kind import GROUPS, dose_group  # noqa: E402
from grade_recall import keys_for  # noqa: E402
from train_glimmer import normalize  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
D = os.path.join(ROOT, ".data", "knowledge", "dataset")
SEED = 20261101
ROWS_PER_GROUP = 3750
COVERABLE_PER_GROUP = 250
UNCOVERED_PER_GROUP = 75
TRAIN_PER_GROUP = 125
NEAR = 0.6
SIM_SPLIT = 0.4
STAGES = [("stage1", os.path.join(D, "train-stage1-frozen.jsonl")), ("stage2", os.path.join(D, "train-stage2.jsonl"))]
HELD_PROBES = [("stage1", os.path.join(D, "probes.jsonl")), ("stage2", os.path.join(D, "train-stage2-probes.jsonl"))]
EVAL_2500 = os.path.join(D, "stage2-eval-probes.jsonl")
PASSAGE_SETS = [("eval-2500", EVAL_2500), ("eval-1500", os.path.join(D, "eval-probes.jsonl")), ("eval-new-1000", os.path.join(D, "stage2-new-probes.jsonl")),
                ("stage-b-40000", os.path.join(D, "stage-b-questions.jsonl")), ("named-controls", os.path.join(D, "stage-b-named-controls.jsonl"))]
FORGET = os.path.join(HERE, "forget.jsonl")
HONESTY_DEV = os.path.join(D, "stage-b-honesty-dev.jsonl")
SALIENT = os.path.join(JOB, "salient_probes.jsonl")
TEST_QUESTIONS = [("eval-2500", EVAL_2500), ("old-facts", FORGET), ("honesty-dev", HONESTY_DEV), ("named-controls", PASSAGE_SETS[-1][1]),
                  ("cutoff", os.path.join(JOB, "cutoff_questions.jsonl")), ("salient", SALIENT), ("reasoning", os.path.join(JOB, "reasoning_probes.jsonl")),
                  ("honesty-190", os.path.join(JOB, "honesty_probes.jsonl"))]
# stage_b_lib's CONTENT_STOP, copied here because stage_b_lib.py is being changed by another workflow tonight.
CONTENT_STOP = set("""
of in on at to for from by with and or but is are was were be been being has have had do does did will would can could should
may might must that this these those it its as into about over after before during why what how who whom which when where
whose than then there their they them his her he she we our you your my me
""".split())


def read_jsonl(path):
    with open(path) as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def qkey(question):
    return normalize(question).strip()


def qhash(question):
    return hashlib.blake2b(qkey(question).encode(), digest_size=8).digest()


def content_words(text):
    return frozenset(w for w in normalize(text).split() if w not in CONTENT_STOP and len(w) > 2)


def jaccard(a, b):
    n = len(a & b)
    return n / (len(a) + len(b) - n) if n else 0.0


def record_of(passage):
    """stage_b_lib.record_of: "source:ons:7:0" is from "source:ons:7", "article:Title:Section:0" from "article:Title"."""
    if passage.startswith("source:"):
        return passage.rsplit(":", 1)[0]
    if passage.startswith("article:"):
        return passage.rsplit(":", 2)[0]
    return passage


def usable(question, answers):
    """Normalized answers that answered() can trust (stage_b_lib.usable_aliases): longer than 2 characters, not in the question."""
    asked = normalize(question)
    out = set()
    for a in answers:
        t = normalize(a).strip()
        if len(t) > 2 and " " + t + " " not in asked:
            out.add(t)
    return out


def every_target(row):
    return {t for t in (normalize(a).strip() for a in [row["answer"], *(row.get("aliases") or [])]) if t}


def holds(said, targets):
    return any(" " + t + " " in said for t in targets)


class NearIndex:
    """Exact Jaccard >= t search over a fixed list of word sets, with prefix filtering (rarest words first), so the stage files
    stream in a few minutes. Every candidate the filter finds is checked exactly; the filter never drops a true match."""

    def __init__(self, sets, t):
        self.sets, self.t = list(sets), t
        df = collections.Counter(w for s in self.sets for w in s)
        self.rank = lambda w: (df.get(w, 0), w)
        self.index = collections.defaultdict(list)
        for i, s in enumerate(self.sets):
            for w in self.prefix(s):
                self.index[w].append(i)

    def prefix(self, s):
        if not s:
            return []
        keep = len(s) - math.ceil(self.t * len(s) - 1e-9) + 1
        return sorted(s, key=self.rank)[:keep]

    def best(self, s):
        """(index, Jaccard) of the closest set at or above t, or None."""
        found = None
        for i in {i for w in self.prefix(s) for i in self.index.get(w, ())}:
            j = jaccard(s, self.sets[i])
            if j >= self.t and (found is None or j > found[1]):
                found = (i, j)
        return found


def max_similarity(questions, rows_words):
    """For each question's word set, the highest Jaccard to any of rows_words (0 when none shares a word)."""
    index = collections.defaultdict(list)
    for i, s in enumerate(rows_words):
        for w in s:
            index[w].append(i)
    out = []
    for q in questions:
        shared = collections.Counter(i for w in q for i in index.get(w, ()))
        out.append(max((n / (len(q) + len(rows_words[i]) - n) for i, n in shared.items()), default=0.0))
    return out


def fill_exact(pool, size, target):
    """Whole passages adding up to exactly target rows, in pool's (drawn) order: take each passage that still fits; if that
    leaves a gap no single passage fills, the earliest unused passages that add up to it (a small subset sum), giving back the
    last taken passages one at a time until a finish exists. Returns (passages, counts) or (None, counts)."""
    picked, left = [], target
    for p in pool:
        if size[p] <= left:
            picked.append(p)
            left -= size[p]
            if not left:
                break
    info = {"greedy_gap": left, "given_back": 0, "finish": 0}
    while left:
        taken = set(picked)
        reach = {0: []}
        for p in pool:
            if p in taken:
                continue
            for s in sorted(reach, reverse=True):
                t = s + size[p]
                if t <= left and t not in reach:
                    reach[t] = reach[s] + [p]
            if left in reach:
                break
        if left in reach:
            picked += reach[left]
            info["finish"] = len(reach[left])
            left = 0
            break
        if not picked:
            return None, info
        left += size[picked.pop()]
        info["given_back"] += 1
    return picked, info


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_lines(path, lines):
    with open(path + ".tmp", "w") as f:
        f.writelines(line if line.endswith("\n") else line + "\n" for line in lines)
    os.replace(path + ".tmp", path)


def build(out_dir, seed=SEED):
    counts = {"settings": {"seed": seed, "rows_per_group": ROWS_PER_GROUP, "groups": list(GROUPS), "near": NEAR, "sim_split": SIM_SPLIT,
                           "coverable_per_group": COVERABLE_PER_GROUP, "uncovered_per_group": UNCOVERED_PER_GROUP, "train_per_group": TRAIN_PER_GROUP}}

    # What stays out: passages by id, records of the dev set, and test questions for the row screen.
    held_passages, by_set = set(), {}
    for name, path in PASSAGE_SETS:
        ids = {p["passageId"] for p in read_jsonl(path) if p.get("passageId")}
        by_set[name] = len(ids)
        held_passages |= ids
    dev_passages = {p["source"].split(":", 1)[1] for p in read_jsonl(HONESTY_DEV) if ":" in str(p.get("source") or "")}
    dev_records = {record_of(p) for p in dev_passages}
    test_keys, test_sets, test_names = set(), [], []
    for name, path in TEST_QUESTIONS:
        n = 0
        for p in read_jsonl(path):
            n += 1
            test_keys.add(qkey(p["question"]))
            s = content_words(p["question"])
            if s:
                test_sets.append(s)
                test_names.append(name)
        by_set[f"questions:{name}"] = n
    near_index = NearIndex(test_sets, NEAR)
    salient = []
    for p in read_jsonl(SALIENT):
        targets = {t for t in usable(p["question"], [p["answer"], *(p.get("aliases") or [])]) if len(t) >= 4 and not t.replace(" ", "").isdigit()}
        if targets:
            salient.append((content_words(p["question"]), targets))
    salient_index = collections.defaultdict(list)
    for i, (words, _) in enumerate(salient):
        for w in words:
            salient_index[w].append(i)
    counts["held_out"] = {"passage_ids": by_set, "honesty_dev_passages": len(dev_passages), "test_questions": len(test_keys),
                          "salient_items_with_answer_keys": len(salient)}

    # Pass 1: every fact row's passage, group and rows per stage, the passages to leave out and why, and every trained question.
    rows_of = collections.defaultdict(lambda: [0, 0])
    group_of, excluded = {}, {}
    trained_questions = set()
    seen = collections.Counter()
    why_rows = collections.Counter()
    for si, (stage, path) in enumerate(STAGES):
        for row in read_jsonl(path):
            source = row.get("source") or ""
            user = next((m.get("content") or "" for m in row["messages"] if m["role"] == "user"), "")
            trained_questions.add(qhash(user))
            g = dose_group(source)
            if g is None:
                continue
            seen[(stage, g)] += 1
            rows_of[source][si] += 1
            group_of[source] = g
            if source in excluded:
                continue
            reason = None
            if source in held_passages:
                reason = "passage of a held-out set"
            elif source in dev_passages or record_of(source) in dev_records:
                reason = "honesty dev passage or record"
            else:
                words = content_words(user)
                if qkey(user) in test_keys:
                    reason = "row question is a test question"
                elif near_index.best(words):
                    reason = "row question near a test question"
                else:
                    hits = collections.Counter(i for w in words for i in salient_index.get(w, ()))
                    said = None
                    for i, n in hits.items():
                        if n >= 2:
                            said = said or normalize(" ".join(m.get("content") or "" for m in row["messages"] if m["role"] == "assistant"))
                            if holds(said, salient[i][1]):
                                reason = "row holds a salient answer"
                                break
            if reason:
                excluded[source] = reason
                why_rows[reason] += 1
    by_group = collections.defaultdict(lambda: collections.Counter())
    for p, g in group_of.items():
        by_group[g]["passages"] += 1
        by_group[g]["rows"] += sum(rows_of[p])
        if p in excluded:
            by_group[g]["passages_left_out"] += 1
            by_group[g]["rows_left_out"] += sum(rows_of[p])
            by_group[g]["left_out: " + excluded[p]] += 1
    counts["fact_rows_read"] = {f"{s}:{g}": n for (s, g), n in sorted(seen.items())}
    counts["pool"] = {g: dict(by_group[g]) for g in GROUPS}
    counts["trained_questions"] = len(trained_questions)

    counts["passages_left_out_by_reason"] = dict(why_rows)

    # The draw: whole passages in a seeded order, then an exact finish (fill_exact).
    rng = random.Random(seed)
    chosen = {}
    for g in GROUPS:
        pool = sorted(p for p, gg in group_of.items() if gg == g and p not in excluded)
        rng.shuffle(pool)
        picked, info = fill_exact(pool, {p: sum(rows_of[p]) for p in pool}, ROWS_PER_GROUP)
        if picked is None:
            raise SystemExit(f"group {g}: {ROWS_PER_GROUP} rows can't be made of whole passages from {len(pool)} usable ones; pool {json.dumps(counts['pool'][g])}")
        chosen.update((p, g) for p in picked)
        counts.setdefault("draw", {})[g] = {"passages": len(picked), "rows": ROWS_PER_GROUP, "usable_passages": len(pool), **info,
                                            "stage1_rows": sum(rows_of[p][0] for p in picked), "stage2_rows": sum(rows_of[p][1] for p in picked)}

    # Pass 2: the chosen passages' rows, as the exact lines the stages trained on.
    lines, words_of_row, rows_meta = [], [], []
    answers_by_passage = collections.defaultdict(list)
    for stage, path in STAGES:
        with open(path) as f:
            for line in f:
                if not line.strip():
                    continue
                row = json.loads(line)
                source = row.get("source") or ""
                if source not in chosen:
                    continue
                user = next((m.get("content") or "" for m in row["messages"] if m["role"] == "user"), "")
                answer = " ".join(m.get("content") or "" for m in row["messages"] if m["role"] == "assistant")
                lines.append(line)
                words_of_row.append(content_words(user))
                rows_meta.append((source, chosen[source], user, answer))
                answers_by_passage[source].append(normalize(answer))
    if len(lines) != ROWS_PER_GROUP * len(GROUPS):
        raise SystemExit(f"collected {len(lines)} rows, expected {ROWS_PER_GROUP * len(GROUPS)}")
    counts["duplicate_lines"] = len(lines) - len(set(lines))

    # Questions. Held-out probes of the chosen passages, once per passage and question.
    candidates, seen_q = collections.defaultdict(lambda: {"coverable": [], "uncovered": []}), set()
    probe_counts = collections.Counter()
    for stage, path in HELD_PROBES:
        for p in read_jsonl(path):
            source = p.get("passageId") or ""
            if source not in chosen:
                continue
            probe_counts["on_dose_passages"] += 1
            k = (source, qkey(p["question"]))
            if k in seen_q:
                probe_counts["repeat"] += 1
                continue
            seen_q.add(k)
            if qhash(p["question"]) in trained_questions:
                probe_counts["question_was_trained"] += 1
                continue
            if qkey(p["question"]) in test_keys:
                probe_counts["is_a_test_question"] += 1
                continue
            said = answers_by_passage[source]
            if any(holds(s, usable(p["question"], [p["answer"], *(p.get("aliases") or [])])) for s in said):
                kind = "coverable"
            elif not any(holds(s, every_target(p)) for s in said):
                kind = "uncovered"
            else:
                probe_counts["only_an_unusable_alias_in_a_row"] += 1
                continue
            probe_counts[kind] += 1
            candidates[chosen[source]][kind].append({k2: p[k2] for k2 in ("question", "answer", "aliases", "passageId", "date", "url") if k2 in p})
    counts["held_out_probes"] = dict(probe_counts)
    counts["held_out_probes_by_group"] = {g: {k: len(v) for k, v in candidates[g].items()} for g in GROUPS}

    questions = []
    for kind, per in (("coverable", COVERABLE_PER_GROUP), ("uncovered", UNCOVERED_PER_GROUP)):
        for g in GROUPS:
            pool = sorted(candidates[g][kind], key=lambda x: (x["passageId"], qkey(x["question"])))
            rng.shuffle(pool)
            if len(pool) < per:
                raise SystemExit(f"group {g}: {len(pool)} {kind} held-out probes, {per} needed")
            questions += [{**x, "dose_kind": kind, "group": g} for x in pool[:per]]
    keyed = collections.Counter()
    for g in GROUPS:
        order = [i for i, m in enumerate(rows_meta) if m[1] == g]
        order.sort(key=lambda i: (rows_meta[i][0], qkey(rows_meta[i][2])))
        rng.shuffle(order)
        picked, used = [], set()
        for i in order:
            source, _, user, answer = rows_meta[i]
            nums, names = keys_for(user, answer)
            if not (nums or names) or qkey(user) in used:
                keyed["unkeyed_or_repeat"] += 1
                continue
            used.add(qkey(user))
            picked.append({"question": user, "answer": answer, "aliases": [], "passageId": source, "dose_kind": "train", "group": g})
            if len(picked) == TRAIN_PER_GROUP:
                break
        if len(picked) < TRAIN_PER_GROUP:
            raise SystemExit(f"group {g}: {len(picked)} keyable dose-row questions, {TRAIN_PER_GROUP} needed")
        questions += picked
    questions += [{**p, "dose_kind": "old", "group": "old"} for p in read_jsonl(FORGET)]
    sims = max_similarity([content_words(q["question"]) for q in questions], words_of_row)
    for n, (q, s) in enumerate(zip(questions, sims)):
        q["id"] = f"dose-{n:04d}"
        q["sim"] = round(s, 4)
    split = collections.defaultdict(collections.Counter)
    for q in questions:
        split[q["dose_kind"]]["n"] += 1
        split[q["dose_kind"]][f"sim_below_{SIM_SPLIT}"] += q["sim"] < SIM_SPLIT
    counts["questions"] = {k: dict(v) for k, v in split.items()}
    counts["questions_by_group"] = dict(collections.Counter(f"{q['dose_kind']}:{q['group']}" for q in questions))

    # Write.
    os.makedirs(out_dir, exist_ok=True)
    order = list(range(len(lines)))
    random.Random(seed).shuffle(order)
    paths = {"train": os.path.join(out_dir, "train.jsonl"), "questions": os.path.join(out_dir, "questions.jsonl"),
             "probes": os.path.join(out_dir, "probes.jsonl"), "forget": os.path.join(out_dir, "forget.jsonl"),
             "passages": os.path.join(out_dir, "passages.json")}
    write_lines(paths["train"], [lines[i] for i in order])
    write_lines(paths["questions"], [json.dumps(q, ensure_ascii=False) for q in questions])
    shutil.copyfile(EVAL_2500, paths["probes"])
    shutil.copyfile(FORGET, paths["forget"])
    with open(paths["passages"], "w") as f:
        json.dump({g: sorted(p for p, gg in chosen.items() if gg == g) for g in GROUPS}, f, indent=1)
    by_kind = dict(collections.Counter(chosen[m[0]] for m in rows_meta))
    steps = math.ceil(len(lines) / 32)
    counts["set"] = {"records": len(lines), "by_kind": by_kind, "passages": len(chosen), "key": "dose_group"}
    counts["run"] = {"effective_batch": 32, "steps_per_epoch": steps, "epochs": 5, "steps": 5 * steps, "save_steps": steps}
    counts["sha256"] = {k: sha256(p) for k, p in paths.items()}
    counts["inputs_sha256"] = {os.path.basename(p): sha256(p) for _, p in STAGES}
    report = os.path.join(out_dir, "report.json")
    with open(report + ".tmp", "w") as f:
        json.dump(counts, f, indent=1)
    os.replace(report + ".tmp", report)
    return counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(D, "dose"))
    a = ap.parse_args()
    counts = build(a.out)
    print(json.dumps(counts, indent=1))


if __name__ == "__main__":
    main()
