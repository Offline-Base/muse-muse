"""The score table for one quantized run: each GGUF's size, new-fact accuracy (held-out probes), old-fact accuracy
(the 40 forget checks) and speed, next to the base model's GGUFs and the BF16 references from training.

Base GGUF scores (quantize.sh base) cover all 1,500 probes in train_glimmer.py's shuffled order, and new1000-<quant>.json
adds stage 2's other 1,000, so a run is compared with the base's answers to the same questions. BF16 references come from the
training run's own transformers answers: ckpt/base.json for the base and out/answers.json (or metrics.json, when all
1,500 probes were scored) for the tuned model. Accuracy is right / total with a 95% Wilson interval.

Usage: python make_table.py --run NAME --dir RUN_DIR --base-dir BASE_DIR [--base-bf16 base.json]
       [--tuned-bf16 metrics.json] [--tuned-answers answers.json]
"""

import argparse
import json
import math
import os
import sys

ORDER = ["Q8_0", "Q4_K_M", "IQ2_XXS", "IQ1_M", "IQ1_S"]


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def pct(k, n):
    lo, hi = wilson(k, n)
    return f"{100 * k / max(1, n):.1f}% ({k}/{n}, {100 * lo:.1f} to {100 * hi:.1f})"


def load(path):
    with open(path) as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--base-dir", required=True)
    ap.add_argument("--base-bf16", default="")
    ap.add_argument("--tuned-bf16", default="")
    ap.add_argument("--tuned-answers", default="")
    a = ap.parse_args()

    runs = {t: load(os.path.join(a.dir, "scores", t + ".json")) for t in ORDER if os.path.exists(os.path.join(a.dir, "scores", t + ".json"))}
    if not runs:
        raise SystemExit("no scores in " + a.dir)
    n = min(r["n_probes"] for r in runs.values())
    questions = [x["question"] for x in next(iter(runs.values()))["rows"]["probe"][:n]]
    lines, table = [], []

    def add(model, quant, gb, probe_rows, forget_rows, tps, agg, note=""):
        if [x["question"] for x in probe_rows] != questions:
            raise SystemExit(f"{model} {quant}: probe questions don't match the run's first {n}")
        pk, fk = sum(x["right"] for x in probe_rows), sum(x["right"] for x in forget_rows)
        table.append({"model": model, "quant": quant, "gb": gb, "probe_right": pk, "probes": len(probe_rows),
                      "probe_accuracy": round(pk / max(1, len(probe_rows)), 4), "forget_right": fk, "forget": len(forget_rows),
                      "forget_accuracy": round(fk / max(1, len(forget_rows)), 4), "decode_tokens_per_second": tps,
                      "aggregate_tokens_per_second": agg, "note": note})
        lines.append(f"| {model} | {quant} | {gb if gb is not None else '-'} | {pct(pk, len(probe_rows))} | {pct(fk, len(forget_rows))} | "
                     f"{tps if tps is not None else '-'} | {agg if agg is not None else '-'} |")

    if a.base_bf16 and os.path.exists(a.base_bf16):
        b = load(a.base_bf16)
        add("base", "BF16 (transformers)", 59.55, b["probes"][:n], b["forget"], None, None, "answered on the GH200 before training")
    if a.tuned_answers and os.path.exists(a.tuned_answers):
        t = load(a.tuned_answers)["tuned"]
        add(a.run, "BF16 (transformers)", 59.55, t["probes"][:n], t["forget"], None, None, "answered on the GH200 after training")
    elif a.tuned_bf16 and os.path.exists(a.tuned_bf16) and n == 1500:
        m = load(a.tuned_bf16)
        pk, fk = round(m["tuned_probe_accuracy"] * m["probes"]), round(m["tuned_forget_accuracy"] * m["forget_items"])
        table.append({"model": a.run, "quant": "BF16 (transformers)", "gb": 59.55, "probe_accuracy": m["tuned_probe_accuracy"],
                      "forget_accuracy": m["tuned_forget_accuracy"], "probes": m["probes"], "forget": m["forget_items"]})
        lines.append(f"| {a.run} | BF16 (transformers) | 59.55 | {pct(pk, m['probes'])} | {pct(fk, m['forget_items'])} | - | - |")
    for t in ORDER:
        p = os.path.join(a.base_dir, "scores", t + ".json")
        if os.path.exists(p):
            r = load(p)
            # Matched by question: stage 2 scores a bigger probe file in its own order, and new1000-<quant>.json holds
            # the base's answers to the probes beyond the 1,500. A row missing any of them is left out, not partial.
            rows = {x["question"]: x for x in r["rows"]["probe"]}
            extra = os.path.join(a.base_dir, "scores", "new1000-" + t + ".json")
            if os.path.exists(extra):
                rows.update({x["question"]: x for x in load(extra)["rows"]["probe"]})
            missing = sum(q not in rows for q in questions)
            if missing:
                print(f"base {t}: no answers to {missing} of the run's {n} probes; row left out", file=sys.stderr)
                continue
            add("base", t, r["gb"], [rows[q] for q in questions], r["rows"]["forget"], r["decode_tokens_per_second_single"], r["aggregate_tokens_per_second"])
    for t, r in runs.items():
        add(a.run, t, r["gb"], r["rows"]["probe"][:n], r["rows"]["forget"], r["decode_tokens_per_second_single"], r["aggregate_tokens_per_second"])

    head = [f"# {a.run}: quantized Muse Glimmer 30B", "",
            f"New facts: {n} held-out probes (train_glimmer.py's order, first {n}). Old facts: the 40 forget checks. "
            "Greedy, 96 new tokens, final-channel prompt, graded by train_glimmer.answered(). "
            "GGUFs on llama.cpp b11970 llama-server, one A100 40GB, full offload. Accuracy in brackets: right/total, 95% interval. "
            "Decode tok/s: one request at a time (mean of 8). Aggregate: 16 requests in flight.", "",
            "| Model | Quant | GB | New-fact accuracy | Old-fact accuracy | Decode tok/s | Aggregate tok/s |",
            "|---|---|---|---|---|---|---|"]
    md = "\n".join(head + lines) + "\n"
    with open(os.path.join(a.dir, "table.md"), "w") as f:
        f.write(md)
    with open(os.path.join(a.dir, "table.json"), "w") as f:
        json.dump({"run": a.run, "n_probes": n, "rows": table}, f, indent=1)
    print(md)


if __name__ == "__main__":
    main()
