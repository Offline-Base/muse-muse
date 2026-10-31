"""The table for small_quants.sh: size, knowledge, old facts, speed, memory and sense for each small file, plus the budgets.

Knowledge is paired with the run's Q4_K_M, matched by question.
"Loops": a reply with some 3-word run at least 3 times, or over 12 words with under 40% distinct (same as shrink_table.py).
"Limit": stopped at 96 tokens. Sensible: old facts at least 36/40, limit and loops each at most 5% of replies, no empty reply,
and at least 8 of 10 plain questions right through the prefilled final channel. The chat path is reported, not gated: its 500s come from the server parser and hit good files too. Budgets are from muse-muse-devices/docs/DEVICES.md:
70% of the RAM a board or phone is sold with, read here as GiB, as lib/devices/subjects.ts does.

Usage: python small_report.py --dir SMALL_RUN_DIR --stock-scores RUN/scores [--types Q1_0,TQ1_0,Q2_0] [--extra IQ1_S,IQ2_XXS]
Writes table.md and table.json in --dir. Prints the name of the smallest sensible type last, as "BEST <type>".
"""

import argparse
import json
import math
import os
import re
from collections import Counter

BUDGETS = [("8 GB board", 8), ("12 GB phone", 12)]


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


def paired(ref, rows):
    """rows minus ref on the same questions, matched by question; None when ref lacks any of them."""
    right = {x["question"]: x["right"] for x in ref}
    if any(x["question"] not in right for x in rows):
        return None
    gain = sum(y["right"] and not right[y["question"]] for y in rows)
    lose = sum(right[y["question"]] and not y["right"] for y in rows)
    n = len(rows)
    d = gain - lose
    se = math.sqrt(max(0, gain + lose - d * d / n)) / n
    return 100 * d / n, 100 * (d / n - 1.96 * se), 100 * (d / n + 1.96 * se)


def load(p):
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--stock-scores", required=True)
    ap.add_argument("--types", default="Q1_0,TQ1_0,Q2_0")
    ap.add_argument("--extra", default="IQ1_S,IQ2_XXS")
    a = ap.parse_args()
    # The run's Q4_K_M; base's second part of the probes is in new1000-Q4_K_M.json.
    ref = []
    for name in ("Q4_K_M.json", "new1000-Q4_K_M.json"):
        d = load(os.path.join(a.stock_scores, name))
        ref += d["rows"]["probe"] if d else []
    rows, best = [], None
    types = a.types.split(",") + [x for x in a.extra.split(",") if x]
    for t in types:
        full = load(os.path.join(a.dir, "scores", t + "-full.json"))
        d = full or load(os.path.join(a.dir, "scores", t + ".json")) or load(os.path.join(a.stock_scores, t + ".json"))
        replies = load(os.path.join(a.dir, "replies", t + ".json"))
        mem = load(os.path.join(a.dir, "mem", t + ".json"))
        if not d:
            # A TQ type: no score_gguf.py run, only a few questions and the old facts on the CPU.
            if replies:
                row = {"type": t, "bytes": replies.get("bytes") or (mem or {}).get("bytes", 0), "n": 0, "old": replies["old_right"], "n_old": replies["old_n"],
                       "limit": sum(x["tokens"] >= 32 for x in replies["old_rows"]), "loops": sum(loops(x["reply"]) for x in replies["old_rows"]),
                       "empty": sum(not x["reply"].strip() for x in replies["old_rows"]), "sane_final": replies["final_ok"], "sane_chat": replies["chat_ok"],
                       "sane_n": replies["n"], "sensible": False, "unscored": True}
                row["gb"] = round(row["bytes"] / 1e9, 2)
                if mem:
                    row["mem"] = {f"{r['mode']}-{r['ctx']}": r for r in mem["runs"]}
                rows.append(row)
            continue
        pr, fg = d["rows"]["probe"], d["rows"]["forget"]
        every = pr + fg
        limit = sum(x["tokens"] >= 96 or x.get("stop") == "limit" for x in every)
        loop = sum(loops(x["reply"]) for x in every)
        empty = sum(not x["reply"].strip() for x in every)
        k = sum(x["right"] for x in pr)
        lo, hi = wilson(k, len(pr))
        row = {"type": t, "gb": d["gb"], "bytes": d["bytes"], "right": k, "n": len(pr), "pct": 100 * k / len(pr), "lo": lo, "hi": hi,
               "old": sum(x["right"] for x in fg), "n_old": len(fg), "limit": limit, "loops": loop, "empty": empty, "n_all": len(every),
               "decode_np1": d["decode_tokens_per_second_single"], "aggregate_np16": d["aggregate_tokens_per_second"],
               "gpu_np16_mib": d["gpu_mem_used_mib"]}
        row["vs_q4"] = paired(ref, pr)
        if replies:
            row["sane_final"], row["sane_chat"], row["sane_n"] = replies["final_ok"], replies["chat_ok"], replies["n"]
        if mem:
            row["mem"] = {f"{r['mode']}-{r['ctx']}": r for r in mem["runs"]}
        row["sensible"] = bool(row["old"] >= 0.9 * len(fg) and limit <= 0.05 * len(every) and loop <= 0.05 * len(every) and empty == 0
                               and row.get("sane_final", 0) >= 8)
        rows.append(row)
        if row["sensible"] and (best is None or d["bytes"] < best["bytes"]):
            best = row

    lines = ["| Type | GB | Knowledge (95%) | vs Q4_K_M, points (95%) | Old | Limit | Loops | Empty | Decode tok/s | GPU np16 MiB | Sane final | Sane chat | Sensible |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        if r.get("unscored"):
            lines.append(f"| {r['type']} | {r['gb']} | not scored | - | {r['old']}/{r['n_old']} (CPU) | {r['limit']} | {r['loops']} | {r['empty']} | - | - | {r['sane_final']}/{r['sane_n']} | {r['sane_chat']}/{r['sane_n']} | no |")
            continue
        v = r.get("vs_q4")
        vs = f"{v[0]:+.1f} ({v[1]:+.1f} to {v[2]:+.1f})" if v else "-"
        lines.append(f"| {r['type']} | {r['gb']} | {r['pct']:.1f}% ({r['right']}/{r['n']}, {r['lo']:.1f} to {r['hi']:.1f}) | {vs} | {r['old']}/{r['n_old']} | "
                     f"{r['limit']} | {r['loops']} | {r['empty']} | {r['decode_np1']} | {r['gpu_np16_mib']} | {r.get('sane_final', '-')}/10 | {r.get('sane_chat', '-')}/10 | "
                     f"{'yes' if r['sensible'] else 'no'} |")
    lines += ["", "Memory, one slot. Need in MiB; decode tok/s in brackets. cpu = --device none -ngl 0 --load-mode none, no mmap (VmHWM). cpu-mmap = the same with mmap (VmHWM, file pages included). "
              "gpu = -ngl 999, this process's GPU memory plus its peak private host memory.", "",
              "| Type | File MiB | cpu 4K | cpu 8K | cpu-mmap 4K | gpu 4K | gpu 8K | GPU part, 4K | Host part, 4K |", "|---|---|---|---|---|---|---|---|---|"]

    def cell(m, k):
        r = (m or {}).get(k)
        if not r:
            return "-"
        if "error" in r:
            return "failed"
        return f"{r['need_mib']} ({r['decode_tps']:.1f})"

    def part(m, key):
        r = (m or {}).get("gpu-4096") or {}
        return r.get(key, "-")

    for r in rows:
        m = r.get("mem")
        lines.append(f"| {r['type']} | {r['bytes'] // 2**20} | {cell(m, 'cpu-4096')} | {cell(m, 'cpu-8192')} | {cell(m, 'cpu-mmap-4096')} | {cell(m, 'gpu-4096')} | {cell(m, 'gpu-8192')} | {part(m, 'gpu_mib')} | {part(m, 'rss_anon_peak_mib')} |")
    lines += ["", "Fit, measured need against 70% of the RAM sold (GiB). Yes or no for 4K context, then 8K, for cpu and for gpu.", "",
              "| Type | " + " | ".join(f"{n}, {0.7 * g:.1f} GiB ({int(0.7 * g * 1024)} MiB)" for n, g in BUDGETS) + " |", "|---|" + "---|" * len(BUDGETS)]

    def fit(m, k, budget):
        r = (m or {}).get(k)
        if not r or "error" in r:
            return "-"
        return "yes" if r["need_mib"] <= budget else "no"

    for r in rows:
        m = r.get("mem")
        cells = []
        for _, g in BUDGETS:
            b = 0.7 * g * 1024
            cells.append(f"cpu {fit(m, 'cpu-4096', b)}/{fit(m, 'cpu-8192', b)}, gpu {fit(m, 'gpu-4096', b)}/{fit(m, 'gpu-8192', b)}")
        lines.append(f"| {r['type']} | " + " | ".join(cells) + " |")
    text = "\n".join(lines) + "\n"
    with open(os.path.join(a.dir, "table.md"), "w") as f:
        f.write(text)
    with open(os.path.join(a.dir, "table.json"), "w") as f:
        json.dump({"rows": rows, "best": best["type"] if best else None}, f, indent=1)
    print(text)
    print("BEST " + (best["type"] if best else "none"))


if __name__ == "__main__":
    main()
