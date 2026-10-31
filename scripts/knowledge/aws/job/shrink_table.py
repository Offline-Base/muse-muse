"""The table for shrink_bench.sh: size against knowledge for each candidate, paired with the stock files on the same questions.

Stock rows are the first N of the existing score files (score_gguf.py keeps Random(7)'s order, so those are the questions the
candidates saw; this is checked). Base rows are matched by question, with new1000-<quant>.json filling in beyond the first 1,500.
"Loops": a reply with some 3-word run at least 3 times, or over 12 words with under 40% distinct. "Limit": stopped at 96 tokens.

Usage: python shrink_table.py --dir SHRINK_DIR --stock STAGE_SCORES --base BASE_SCORES --n 600
"""

import argparse
import glob
import json
import math
import os
import re
from collections import Counter

STOCK = ["Q8_0", "Q4_K_M", "IQ2_XXS", "IQ1_M", "IQ1_S"]


def wilson(k, n, z=1.96):
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return 100 * max(0.0, c - h), 100 * min(1.0, c + h)


def loops(reply):
    w = re.findall(r"\w+", reply.lower())
    if len(w) >= 12 and len(set(w)) / len(w) < 0.4:
        return True
    return bool(w) and max(Counter(zip(w, w[1:], w[2:])).values(), default=0) >= 3


def paired(a, b):
    """b minus a on the same questions: right-only counts and a 95% interval on the difference in points."""
    gain = sum(y["right"] and not x["right"] for x, y in zip(a, b))
    lose = sum(x["right"] and not y["right"] for x, y in zip(a, b))
    n = len(a)
    d = gain - lose
    se = math.sqrt(max(0, gain + lose - d * d / n)) / n
    return gain, lose, 100 * d / n, 100 * (d / n - 1.96 * se), 100 * (d / n + 1.96 * se)


def row(name, d, probes, forget, mem, ref):
    n = len(probes)
    k = sum(x["right"] for x in probes)
    lo, hi = wilson(k, n)
    every = probes + forget
    limit = sum(x["tokens"] >= 96 or x.get("stop") == "limit" for x in every)
    loop = sum(loops(x["reply"]) for x in every)
    empty = sum(not x["reply"].strip() for x in every)
    gain, lose, diff, dlo, dhi = paired(ref, probes)
    return {"name": name, "gb": d["gb"], "right": k, "n": n, "pct": 100 * k / n, "lo": lo, "hi": hi,
            "old": sum(x["right"] for x in forget), "n_old": len(forget), "limit": limit, "loop": loop, "empty": empty,
            "gain": gain, "lose": lose, "diff": diff, "dlo": dlo, "dhi": dhi,
            "gpu16": d.get("gpu_mem_used_mib"), "gpu1": (mem or {}).get("gpu_model_mib"),
            "decode": d.get("decode_tokens_per_second_single"), "agg": d.get("aggregate_tokens_per_second")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--stock", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--n", type=int, default=600)
    a = ap.parse_args()

    def load(p):
        with open(p) as f:
            return json.load(f)

    def mem(name):
        p = os.path.join(a.dir, "mem", name + ".json")
        return load(p) if os.path.exists(p) else None

    stock = {t: load(os.path.join(a.stock, t + ".json")) for t in STOCK if os.path.exists(os.path.join(a.stock, t + ".json"))}
    questions = [x["question"] for x in next(iter(stock.values()))["rows"]["probe"][: a.n]]
    ref = stock["Q4_K_M"]["rows"]["probe"][: a.n]
    rows = []

    base_ref = None
    for t in ["Q4_K_M", "IQ1_S"]:
        p = os.path.join(a.base, t + ".json")
        if not os.path.exists(p):
            continue
        d = load(p)
        by_q = {x["question"]: x for x in d["rows"]["probe"]}
        extra = os.path.join(a.base, "new1000-" + t + ".json")
        if os.path.exists(extra):
            by_q.update({x["question"]: x for x in load(extra)["rows"]["probe"]})
        if any(q not in by_q for q in questions):
            print(f"base {t}: not all {a.n} probes found, row left out")
            continue
        probes = [by_q[q] for q in questions]
        if t == "Q4_K_M":
            base_ref = probes
        rows.append(row("base " + t + " (stock)", d, probes, d["rows"]["forget"], mem("stock-base-" + t), ref))
    for t, d in stock.items():
        probes = d["rows"]["probe"][: a.n]
        rows.append(row("stage2 " + t + " (stock)", d, probes, d["rows"]["forget"], mem("stock-" + t), ref))
    for p in sorted(glob.glob(os.path.join(a.dir, "scores", "*.json"))):
        name = os.path.basename(p)[:-5]
        d = load(p)
        probes = d["rows"]["probe"]
        if [x["question"] for x in probes] != questions[: len(probes)] or len(probes) != a.n:
            print(f"{name}: questions don't match the {a.n}-probe subset, left out")
            continue
        rows.append(row(name, d, probes, d["rows"]["forget"], mem(name), ref))
    rows.sort(key=lambda r: r["gb"])

    print(f"Knowledge: first {a.n} of the probes in Random(7) order, prefilled final channel, greedy, 96 tokens. Old facts of {rows[0]['n_old']}. "
          "Change: points against stage 2 Q4_K_M on the same questions (paired, 95%). Limit, loops, empty: counts over probes + old facts. "
          "GPU np16: MiB at -np 16 -c 16384, whole card. GPU 1 slot: MiB above idle at -np 1 -c 2048.")
    print()
    print("| Candidate | GB | Knowledge (95%) | Old | vs Q4_K_M, points (95%) | Limit | Loops | Empty | GPU np16 MiB | GPU 1 slot MiB | Decode tok/s |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        print(f"| {r['name']} | {r['gb']} | {r['pct']:.1f}% ({r['right']}/{r['n']}, {r['lo']:.1f} to {r['hi']:.1f}) | {r['old']}/{r['n_old']} | "
              f"{r['diff']:+.1f} ({r['dlo']:+.1f} to {r['dhi']:+.1f}) | {r['limit']} | {r['loop']} | {r['empty']} | {r['gpu16'] if r['gpu16'] else '-'} | {r['gpu1'] if r['gpu1'] else '-'} | {r['decode']} |")
    with open(os.path.join(a.dir, "table.json"), "w") as f:
        json.dump(rows, f, indent=1)
    if base_ref:
        print()
        print(f"Base Q4_K_M on this subset: {100 * sum(x['right'] for x in base_ref) / a.n:.1f}%.")


if __name__ == "__main__":
    main()
