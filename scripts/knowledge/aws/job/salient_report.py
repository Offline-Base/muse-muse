"""Report the salient-event test, and how many of its answers appear in the training sets (computed after the questions were
frozen, so the writing never saw it).

Grades with train_glimmer.py's answered() as written (normalize, whole words, answer or any alias), so it matches score_gguf.py.

Training overlap, for each probe, over every row's question and answer text:
- answer_anywhere: some row holds the answer or an alias as whole words. A weak test: "Spain" is in thousands of rows.
- answer_with_context: some row holds the answer or an alias and at least half of the question's distinctive words (at least
  two, skipping common words and anything in the answer). The closer proxy for "this fact was trained on".
- exact_question: some row's user question is the same text once normalized.

Usage: python3 salient_report.py --probes salient_probes.jsonl --scores label=FILE.json [...] --train FILE.jsonl [...]
       --out REPORT.json
"""

import argparse
import collections
import importlib.util
import json
import math
import os
import re

COMMON = set("""the a an in on at of for to from by with and or but as if it its this that these those he she they we you i his her
their our your my there here when where while after before during since until who whom whose what which how why was were is are be
been has have had will would can could may might must should do does did not no yes about over under between into through per than
then new first last next many most some several all both each other another also 2026 january february march april may june july
august september october november december country city company name called named win won become became state president prime
minister people killed year years day date number much long""".split())


def load_grading(here):
    """normalize and answered, from train_glimmer.py's source text only: importing it would pull in torch."""
    text = open(os.path.join(here, "train_glimmer.py")).read()
    spec = {"re": re}
    for name in ("normalize", "answered"):
        match = re.search(r"^def " + name + r"\(.*?(?=^\S)", text, re.S | re.M)
        exec(match.group(0), spec)
    return spec["normalize"], spec["answered"]


def wilson(k, n, z=1.96):
    if not n:
        return [0.0, 0.0]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(c - h, 3), round(c + h, 3)]


def overlap(probes, train_paths, normalize):
    needles = collections.defaultdict(list)  # first word of a needle: (probe index, needle text, padded)
    contexts = []
    for i, p in enumerate(probes):
        forms = {normalize(x) for x in [p["answer"], *p.get("aliases", [])]}
        forms = {f for f in forms if f.strip()}
        for f in forms:
            needles[f.split()[0]].append((i, f))
        answer_words = set(" ".join(forms).split())
        words = {w for w in normalize(p["question"]).split() if w not in COMMON and w not in answer_words and len(w) > 2}
        contexts.append(words)
    questions = {normalize(p["question"]): i for i, p in enumerate(probes)}
    anywhere = [0] * len(probes)
    with_context = [0] * len(probes)
    exact = [0] * len(probes)
    rows = 0
    for path in train_paths:
        with open(path) as f:
            for line in f:
                r = json.loads(line)
                rows += 1
                msgs = r["messages"]
                text = normalize(" ".join(m["content"] for m in msgs if m["role"] != "system"))
                tokens = set(text.split())
                done = set()
                for tok in tokens & needles.keys():
                    for i, needle in needles[tok]:
                        if i in done or needle not in text:
                            continue
                        done.add(i)
                        anywhere[i] += 1
                        ctx = contexts[i]
                        need = max(2, math.ceil(len(ctx) / 2))
                        if len(ctx & tokens) >= need:
                            with_context[i] += 1
                for m in msgs:
                    if m["role"] == "user":
                        i = questions.get(normalize(m["content"]))
                        if i is not None:
                            exact[i] += 1
    return rows, anywhere, with_context, exact


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probes", required=True)
    ap.add_argument("--scores", nargs="+", required=True)
    ap.add_argument("--train", nargs="*", default=[])
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    normalize, answered = load_grading(os.path.dirname(os.path.abspath(__file__)))
    probes = [json.loads(line) for line in open(a.probes)]
    by_q = {p["question"]: p for p in probes}
    report = {"n": len(probes), "topics": dict(collections.Counter(p["topic"] for p in probes)), "models": {}}
    right = {}
    replies = {}
    for spec in a.scores:
        label, path = spec.split("=", 1)
        d = json.load(open(path))
        rows = d["rows"]["probe"]
        if len(rows) != len(probes):
            raise SystemExit(f"{label}: {len(rows)} rows, {len(probes)} probes")
        right[label] = {r["question"]: answered(r["reply"], by_q[r["question"]]) for r in rows}
        replies[label] = {r["question"]: r["reply"] for r in rows}
        report["models"][label] = {"forget_right": d["forget_right"], "n_forget": d["n_forget"], "topics": {}}
        for topic in ["ai", "meta", "world", "ALL"]:
            ps = [p for p in probes if topic == "ALL" or p["topic"] == topic]
            k = sum(right[label][p["question"]] for p in ps)
            report["models"][label]["topics"][topic] = {"right": k, "n": len(ps), "rate": round(k / len(ps), 3), "ci95": wilson(k, len(ps))}
    labels = list(right)
    if "base" in right:
        report["base_knew"] = sum(right["base"].values())
        for label in labels:
            if label == "base":
                continue
            gained = sum(right[label][q] and not right["base"][q] for q in by_q)
            lost = sum(right["base"][q] and not right[label][q] for q in by_q)
            report["models"][label]["gained_over_base"] = gained
            report["models"][label]["lost_from_base"] = lost
            new = [q for q in by_q if not right["base"][q]]
            k = sum(right[label][q] for q in new)
            report["models"][label]["on_base_wrong"] = {"right": k, "n": len(new), "rate": round(k / max(1, len(new)), 3), "ci95": wilson(k, len(new))}
            months = collections.defaultdict(lambda: [0, 0])
            for p in probes:
                months[p["date"][:7]][1] += 1
                months[p["date"][:7]][0] += right[label][p["question"]]
            report["models"][label]["by_month"] = {m: months[m] for m in sorted(months)}
    if a.train:
        rows, anywhere, with_context, exact = overlap(probes, a.train, normalize)
        report["overlap"] = {"train_rows": rows, "train_files": [os.path.basename(t) for t in a.train],
                             "answer_anywhere": sum(x > 0 for x in anywhere), "answer_with_context": sum(x > 0 for x in with_context),
                             "exact_question": sum(x > 0 for x in exact), "by_topic": {}}
        for topic in ["ai", "meta", "world"]:
            idx = [i for i, p in enumerate(probes) if p["topic"] == topic]
            report["overlap"]["by_topic"][topic] = {"n": len(idx), "answer_anywhere": sum(anywhere[i] > 0 for i in idx),
                                                    "answer_with_context": sum(with_context[i] > 0 for i in idx),
                                                    "exact_question": sum(exact[i] > 0 for i in idx)}
        for label in labels:
            for name, flags in (("trained_with_context", [x > 0 for x in with_context]), ("no_context_row", [x == 0 for x in with_context])):
                idx = [i for i, f in enumerate(flags) if f]
                k = sum(right[label][probes[i]["question"]] for i in idx)
                report["models"][label][name] = {"right": k, "n": len(idx), "rate": round(k / max(1, len(idx)), 3), "ci95": wilson(k, len(idx))}
        for i, p in enumerate(probes):
            p["rows_answer"] = anywhere[i]
            p["rows_context"] = with_context[i]
    per_probe = []
    for p in probes:
        per_probe.append({"id": p["id"], "topic": p["topic"], "question": p["question"], "answer": p["answer"],
                          "rows_answer": p.get("rows_answer"), "rows_context": p.get("rows_context"),
                          "right": {label: right[label][p["question"]] for label in labels},
                          "replies": {label: replies[label][p["question"]] for label in labels}})
    report["probes"] = per_probe
    with open(a.out, "w") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in report.items() if k != "probes"}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
