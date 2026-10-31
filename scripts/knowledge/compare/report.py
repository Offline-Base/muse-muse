#!/usr/bin/env python3
"""Tables and a side-by-side page for one eval run of evals.py (meta.json and rows.jsonl in the run folder).

Writes summary.json, report.md and report.html next to them. Usage: python3 report.py RUN_DIR [--base NAME]
(the same as `evals.py report`).

Statistics:
- Each cell: right / graded with a Wilson 95% interval (score_reasoning.wilson). Ungraded items (python tests not run)
  leave the denominator; errors and replies cut off with no final answer count as not right.
- Paired against the base model on the same set, item and mode: both right, right only in this model, right only in base.
  The difference in points has a Newcombe (1998) method 10 interval: Wilson limits for each model's rate, joined with
  phi from the 2x2 table (0 when a margin is empty). The exact two-sided sign p comes from score_reasoning.discordance,
  called on rows already filtered to one set, group and model. The main pairing is each tuned model against base;
  every other model is paired against base too.
- Serving: errors, length cuts, median completion tokens, reasoning characters, final words, seconds and tok/s.

rows.jsonl may hold several rows for one (set, id, model, mode): a resumed error, or a python item graded later on the
lab. The last one counts. A half-written last line (a killed run) is skipped.

report.html is self-contained (inline CSS and JS, rows as application/json, light and dark). It holds private dev
questions: keep it under .data/compare/.
"""

import argparse
import html
import json
import math
import os
import re
import statistics
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import common  # noqa: E402

JOB = os.path.join(common.ROOT, "scripts", "knowledge", "aws", "job")
if JOB not in sys.path:
    sys.path.append(JOB)
import score_reasoning  # noqa: E402

KEY = ("set", "id", "model", "mode")
Z = 1.96  # score_reasoning.wilson's
SET_ORDER = ("honesty-dev", "reasoning", "salient", "probes", "old-facts", "honesty-final")
HONESTY_KINDS = ("false_premise", "after_cutoff", "unknowable")
VERDICTS = ("honest", "hallucinated", "unclear", "degenerate", "error")
ANSWERED_SETS = ("salient", "probes", "old-facts")
MONTH_SETS = ("salient", "probes")
CAVEATS = [
    "honesty_grade reads wording, not truth, and was never audited on Qwen, Gemma or Granite wording; its audited figure "
    "is 62 of 69 on tuned Glimmer replies and only 17 of 22 on base replies. Don't call a few points' difference with it.",
    "The honesty dev set has no controls, so a model that declines everything scores honest: read its honest rate beside "
    "probe accuracy and over-refusal (the table above).",
    "answered() counts a reply right when the answer or an alias appears anywhere in it as whole words, so a long reply "
    "that lists several candidates can be marked right. That favours wordy models over terse ones: see the median final "
    "words. Read a sample of cards by hand before claiming a gap.",
    "These numbers come from the chat endpoint with each model's own chat template; they are not comparable to the "
    "earlier /completion tables (score_gguf.py, score_honesty.py), which prefill Glimmer's final channel.",
    "Greedy decoding with 2 slots per server is not bit-for-bit repeatable: batched kernels can change a near tie.",
    "Every model gets the same token limits per set and mode. Gemma 4 has no low reasoning setting (its template has no "
    "effort levels), so with reasoning on it thinks at its default length; Glimmer, Qwen and Granite are asked for low.",
    "Replies cut at the token limit are graded on the cut text, so an answer that would have come after the cut is "
    "missed: the accuracy and honesty tables count cut rows separately. Glimmer's own thinking-off limits (96 knowledge, "
    "192 honesty) cut most thinking-off replies of the other models on Oct 31; runs that ask them use the compare limits "
    "(384 knowledge, 768 honesty) unless --max-tokens-off says otherwise (see the limits table).",
    "answered() can mark a denial right when the expected name appears only as background, an example or a list item "
    "(Oct 31: 14 of the 25 rows graded right that also read as a decline were denials, all from Qwen, Gemma and "
    "Granite; Glimmer had none). Treat the other models' salient and probe rates as upper bounds; the Declines table "
    "counts \"right but declining\" rows and their cards say so. Read them before claiming a gap.",
    "Probe and salient events run to Oct 2026. For base Glimmer (template cutoff 2026-01-04) and the other models "
    "(Gemma 4's card: January 2025; Qwen3.8 and Granite 4.2 state none) most of them are after the cutoff, where "
    "declining is the honest reply, not over-refusal. The Declines table labels those models \"declined\" and counts "
    "declines on items dated before each stated cutoff on their own. Only the tuned models, which were taught these "
    "events, and every model on the old facts, are labelled over-refusal.",
    "Bits per weight differ although most files are labelled Q4_K_M (see the models table); more bits can mean a little "
    "more accuracy.",
    "HTTP 500 from a Glimmer model with reasoning on means llama-server's parser rejected its channels; such rows count "
    "as errors and not right. Stage 2 did it on every reasoning-on row (60 of 60 on Oct 31). Expect it from "
    "glimmer-final too on plain questions in chat and on honesty-dev: stage-b-r30, trained the same way, with low strength and a bare "
    "generation prompt it left 64 of 120 honesty replies and 96 of 300 controls with no final channel (run log, Oct 31, "
    "5:31 PM), while its reasoning items were fine.",
    "tok/s is measured on a shared GPU with every model running at once: it is not a property of the model.",
]


# Rows.

def load_rows_file(path):
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out


def load_rows(run_dir):
    path = os.path.join(run_dir, "rows.jsonl")
    if not os.path.exists(path):
        return []
    latest = {}
    for r in load_rows_file(path):
        latest[tuple(r.get(k) for k in KEY)] = r
    return list(latest.values())


def load_meta(run_dir):
    with open(os.path.join(run_dir, "meta.json")) as f:
        return json.load(f)


# Statistics.

def wilson_raw(k, n, z=Z):
    """Wilson score interval, unrounded (score_reasoning.wilson rounds to 3 places)."""
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - m) / d, (c + m) / d)


def newcombe_paired(a, b, c, d, z=Z):
    """Difference of paired proportions, (a + b) / n minus (a + c) / n, with Newcombe's (1998) method 10 interval.
    a: both right, b: right only in the first, c: right only in the second, d: neither. None when n is 0."""
    n = a + b + c + d
    if n == 0:
        return None
    p1, p2 = (a + b) / n, (a + c) / n
    l1, u1 = wilson_raw(a + b, n, z)
    l2, u2 = wilson_raw(a + c, n, z)
    den = (a + b) * (c + d) * (a + c) * (b + d)
    phi = (a * d - b * c) / math.sqrt(den) if den > 0 else 0.0
    theta = p1 - p2
    lo = theta - math.sqrt(max(0.0, (p1 - l1) ** 2 - 2 * phi * (p1 - l1) * (u2 - p2) + (u2 - p2) ** 2))
    hi = theta + math.sqrt(max(0.0, (u1 - p1) ** 2 - 2 * phi * (u1 - p1) * (p2 - l2) + (p2 - l2) ** 2))
    return theta, max(-1.0, lo), min(1.0, hi)


def is_cut(r):
    """A reply that stopped at the token limit (graded on the cut text)."""
    return r.get("finish") == "length" and not r.get("error")


def right_declining(r):
    """Graded right by answered() although the reply also reads as a decline (honesty_grade.refuses)."""
    return r.get("set") in ANSWERED_SETS and bool(r.get("right")) and bool(r.get("refused"))


def rate(rows):
    graded = [r for r in rows if r.get("right") is not None]
    k = sum(bool(r["right"]) for r in graded)
    n = len(graded)
    ci = None
    if n:
        lo, hi = score_reasoning.wilson(k, n)
        ci = [max(0.0, lo) + 0.0, min(1.0, hi) + 0.0]  # its rounding can give -0.0 at k = 0
    cut = [r for r in graded if is_cut(r)]
    return {"n": n, "right": k, "rate": round(k / n, 4) if n else None, "ci95": ci, "ungraded": len(rows) - n,
            "cut": len(cut), "cut_right": sum(bool(r["right"]) for r in cut),
            "right_declining": sum(right_declining(r) for r in graded)}


def cutoff_month(text):
    """"YYYY-MM" from a model's stated cutoff ("2025-01 (pretraining data, model card)"), or None when none is stated."""
    m = re.search(r"\b(\d{4})-(\d{2})\b", str(text or ""))
    return f"{m.group(1)}-{m.group(2)}" if m else None


def median(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return round(statistics.median(xs), 1) if xs else None


# Groups shown for each set.

def groups(set_name):
    allg = [("all", lambda r: True)]
    if set_name.startswith("honesty"):
        return allg + [(k, lambda r, k=k: r.get("kind") == k) for k in HONESTY_KINDS]
    if set_name == "reasoning":
        return allg + [(p, lambda r, p=p: r.get("part") == p) for p in ("multistep", "hard", "skills")] + \
            [(k, lambda r, k=k: r.get("kind") == k) for k in ("python", "json", "instructions", "multiturn")] + \
            [("also_off", lambda r: bool(r.get("also_off")))]
    if set_name == "salient":
        return allg + [(t, lambda r, t=t: r.get("topic") == t) for t in ("ai", "meta", "world")]
    return allg


def group_label(set_name, group):
    if set_name.startswith("honesty"):
        return "honest rate" + ("" if group == "all" else f", {group}")
    if group == "also_off":
        return "the also_off items (40 in full)"
    return "all" if group == "all" else group


def ordered_models(meta, rows):
    seen = [m["name"] for m in meta.get("models", [])]
    for r in rows:
        if r["model"] not in seen:
            seen.append(r["model"])
    role = {m["name"]: m.get("role") for m in meta.get("models", [])}
    rank = {"tuned": 0, "base": 1}
    return sorted(seen, key=lambda n: (rank.get(role.get(n), 2), seen.index(n)))


def sets_in(meta, rows):
    names = list(meta.get("plan", {}).get("sets") or [])
    for r in rows:
        if r["set"] not in names:
            names.append(r["set"])
    return sorted(names, key=lambda s: (SET_ORDER.index(s) if s in SET_ORDER else 99, s))


# Summary.

def build_summary(meta, rows, base=None):
    base = base or meta.get("base")
    models = ordered_models(meta, rows)
    mmeta = {m["name"]: m for m in meta.get("models", [])}
    tuned = [n for n in models if (mmeta.get(n) or {}).get("role") == "tuned"]
    sets = sets_in(meta, rows)
    modes = [m for m in ("off", "on") if any(r["mode"] == m for r in rows)]
    idx = {}
    for r in rows:
        idx.setdefault((r["set"], r["mode"], r["model"]), []).append(r)

    accuracy, paired, by_month, honesty, over, final_words = [], [], [], [], [], []
    for s in sets:
        for mode in modes:
            if not any((s, mode, n) in idx for n in models):
                continue
            for g, fn in groups(s):
                base_rows = [r for r in idx.get((s, mode, base), []) if fn(r)]
                for n in models:
                    mine = [r for r in idx.get((s, mode, n), []) if fn(r)]
                    if not mine:
                        continue
                    accuracy.append({"set": s, "group": g, "mode": mode, "model": n, **rate(mine)})
                    if n == base or not base_rows:
                        continue
                    d = score_reasoning.discordance(mine, base_rows)
                    neither = d["pairs"] - d["both"] - d["only_a"] - d["only_b"]
                    nc = newcombe_paired(d["both"], d["only_a"], d["only_b"], neither)
                    paired.append({"set": s, "group": g, "mode": mode, "model": n, "base": base, "main": n in tuned,
                                   "pairs": d["pairs"], "both": d["both"], "only_model": d["only_a"], "only_base": d["only_b"],
                                   "neither": neither, "sign_p": d["sign_p"],
                                   "diff_pts": round(100 * nc[0], 1) if nc else None,
                                   "ci95_pts": [round(100 * nc[1], 1), round(100 * nc[2], 1)] if nc else None})
            for n in models:
                mine = idx.get((s, mode, n), [])
                if not mine:
                    continue
                final_words.append({"set": s, "mode": mode, "model": n, "median": median([r.get("final_words") for r in mine if not r.get("error")]),
                                    "n": len(mine)})
                if s.startswith("honesty"):
                    entry = {"set": s, "mode": mode, "model": n, "n": len(mine)}
                    for v in VERDICTS:
                        entry[v] = sum(r.get("verdict") == v for r in mine)
                    entry["by_kind"] = {k: {v: sum(r.get("verdict") == v for r in mine if r.get("kind") == k) for v in VERDICTS}
                                        for k in HONESTY_KINDS if any(r.get("kind") == k for r in mine)}
                    entry["private"] = rate([r for r in mine if r.get("private")]) if any(r.get("private") for r in mine) else None
                    entry["cut"] = sum(is_cut(r) for r in mine)
                    entry["cut_honest"] = sum(is_cut(r) and r.get("verdict") == "honest" for r in mine)
                    honesty.append(entry)
                if s in ANSWERED_SETS:
                    wrong = [r for r in mine if r.get("right") is False]
                    refused = sum(bool(r.get("refused")) for r in wrong)
                    mm = mmeta.get(n) or {}
                    # A decline is over-refusal only where the model should know: the tuned models (taught these
                    # events) and the old facts (before every cutoff). Elsewhere it may be the honest reply.
                    reads_as = "over-refusal" if s == "old-facts" or mm.get("role") == "tuned" else "declined"
                    cm = cutoff_month(mm.get("cutoff"))
                    before = [r for r in mine if cm and (r.get("month") or "no date") != "no date" and str(r["month"])[:7] < cm]
                    before_declined = sum(r.get("right") is False and bool(r.get("refused")) for r in before)
                    over.append({"set": s, "mode": mode, "model": n, "n": len(mine), "wrong": len(wrong), "refused_wrong": refused,
                                 "rate": round(refused / len(mine), 4) if mine else None, "reads_as": reads_as,
                                 "cutoff_month": cm, "before_cutoff_n": len(before) if cm else None,
                                 "before_cutoff_declined": before_declined if cm else None,
                                 "before_cutoff_rate": round(before_declined / len(before), 4) if before else None,
                                 "right_declining": sum(right_declining(r) for r in mine),
                                 "cut": sum(is_cut(r) for r in mine)})
                if s in MONTH_SETS:
                    for month in sorted({r.get("month") or "no date" for r in mine}):
                        sub = [r for r in mine if (r.get("month") or "no date") == month]
                        by_month.append({"set": s, "mode": mode, "month": month, "model": n, **rate(sub)})

    context = []
    for mode in modes:
        for n in models:
            def cell(s, g="all"):
                return next((x for x in accuracy if x["set"] == s and x["group"] == g and x["mode"] == mode and x["model"] == n), None)
            h = next((x for x in honesty if x["set"] == "honesty-dev" and x["mode"] == mode and x["model"] == n), None)
            o = next((x for x in over if x["set"] == "probes" and x["mode"] == mode and x["model"] == n), None)
            if not (h or o or cell("salient")):
                continue
            context.append({"mode": mode, "model": n,
                            "honest_rate": round(h["honest"] / h["n"], 4) if h and h["n"] else None,
                            "hallucinated_rate": round(h["hallucinated"] / h["n"], 4) if h and h["n"] else None,
                            "probes_rate": (cell("probes") or {}).get("rate"), "probes_over_refusal": o["rate"] if o else None,
                            "salient_rate": (cell("salient") or {}).get("rate"), "old_facts_rate": (cell("old-facts") or {}).get("rate")})

    serving = []
    for n in models:
        for mode in modes:
            mine = [r for r in rows if r["model"] == n and r["mode"] == mode]
            if not mine:
                continue
            ok = [r for r in mine if not r.get("error")]
            serving.append({"model": n, "mode": mode, "replies": len(mine), "errors": sum(bool(r.get("error")) for r in mine),
                            "http_500": sum(r.get("http") == 500 for r in mine),
                            "length_cuts": sum(r.get("finish") == "length" for r in ok),
                            "cut_no_final": sum(r.get("finish") == "length" and not r.get("final") for r in ok),
                            "empty_final": sum(not r.get("final") for r in ok),
                            "median_completion_tokens": median([r.get("completion_tokens") for r in ok]),
                            "median_reasoning_chars": median([r.get("reasoning_chars") for r in ok]),
                            "median_final_words": median([r.get("final_words") for r in ok]),
                            "median_seconds": median([r.get("seconds") for r in ok]),
                            "median_tok_s": median([r.get("tok_s") for r in ok])})

    errors = sum(bool(r.get("error")) for r in rows)
    sessions = meta.get("sessions") or []
    planned = {}
    for s in sessions:
        for n, k in (s.get("planned") or {}).items():
            planned[n] = k
    ok_rows = {}
    for r in rows:
        if not r.get("error"):
            ok_rows[r["model"]] = ok_rows.get(r["model"], 0) + 1
    complete = bool(sessions) and sessions[-1].get("status") == "finished" and errors == 0 and \
        all(ok_rows.get(n, 0) >= k for n, k in planned.items())
    header = []
    for n in models:
        m = mmeta.get(n, {"name": n})
        header.append({k: m.get(k) for k in ("name", "label", "role", "publisher", "license", "quant", "params_b", "bytes", "bpw",
                                             "file", "sha256", "sha256_ok", "reasoning_level", "cutoff", "modes", "flags",
                                             "flags_source", "session")})
    last_lab = next((s.get("lab") for s in reversed(sessions) if s.get("lab")), None)
    with_rows = {r["model"] for r in rows}
    skipped = []
    for x in meta.get("skipped") or []:
        x = dict(x)
        if not x.get("mode") and x["model"] in with_rows:
            x["why"] += f" in session {x.get('session', '?')}; its rows from an earlier session are kept"
        skipped.append(x)
    return {"run_id": meta.get("run_id"), "created": meta.get("created"), "start": meta.get("start"), "end": meta.get("end"),
            "status": sessions[-1].get("status") if sessions else None, "complete": complete, "errors": errors,
            "base": base, "tuned": tuned, "models": header, "sets": sets, "modes": modes, "lab": last_lab,
            "labs": [s.get("lab") for s in sessions], "sessions": len(sessions), "limits": meta.get("limits"),
            "capped_by_lab": meta.get("capped_by_lab"), "sampling": meta.get("sampling"), "plan": meta.get("plan"),
            "skipped": skipped, "llama_cpp": meta.get("llama_cpp"), "git_head": meta.get("git_head"),
            "n_rows": len(rows), "accuracy": accuracy, "paired": paired, "by_month": by_month, "honesty": honesty,
            "context": context, "over_refusal": over, "serving": serving, "final_words": final_words}


# Markdown.

def pct(x):
    return "n/a" if x is None else f"{100 * x:.1f}%"


def acc_cell(c):
    if not c or not c["n"]:
        return "n/a" if not c or not c.get("ungraded") else f"ungraded ({c['ungraded']})"
    lo, hi = c["ci95"]
    cut = f", {c['cut']} cut ({c.get('cut_right', 0)} right)" if c.get("cut") else ""
    return f"{100 * c['rate']:.1f}% [{100 * lo:.1f}, {100 * hi:.1f}] {c['right']}/{c['n']}{cut}"


def declined_cell(o):
    if o.get("cutoff_month") is None:
        return "n/a (no stated cutoff)"
    if not o.get("before_cutoff_n"):
        return f"n/a (no dated items before {o['cutoff_month']})"
    return f"{o['before_cutoff_declined']}/{o['before_cutoff_n']} {pct(o['before_cutoff_rate'])} (before {o['cutoff_month']})"


DECLINES_NOTE = ("Wrong replies that decline (honesty_grade.refuses), over all replies. \"over-refusal\" only for the tuned "
                 "models, which were taught these events, and on the old facts; for base Glimmer and the other models "
                 "most events are after their cutoff, where declining is honest, so they read \"declined\". \"Before its "
                 "cutoff\" counts only items dated before the model's stated cutoff. \"Right but declining\": graded "
                 "right by answered() although the reply also reads as a decline; read those cards (an upper bound).")
DECLINES_HEAD = ["set", "mode", "model", "reads as", "n", "wrong", "wrong and declined", "rate", "before its cutoff",
                 "right but declining", "cut at limit"]


def declines_rows(summary):
    return [[o["set"], o["mode"], o["model"], o.get("reads_as", "over-refusal"), o["n"], o["wrong"], o["refused_wrong"], pct(o["rate"]),
             declined_cell(o), o.get("right_declining", 0), o.get("cut", 0)] for o in summary["over_refusal"]]


CONTEXT_HEAD = ["mode", "model", "dev honest", "dev made up", "probes right", "probes declined (wrong)", "salient right",
                "old facts right"]


def context_rows(summary):
    return [[c["mode"], c["model"], pct(c["honest_rate"]), pct(c["hallucinated_rate"]), pct(c["probes_rate"]),
             pct(c["probes_over_refusal"]), pct(c["salient_rate"]), pct(c["old_facts_rate"])] for c in summary["context"]]


def honesty_rows(summary):
    return [[h["set"], h["mode"], h["model"], h["n"]] + [f"{h[v]} ({pct(h[v] / h['n'] if h['n'] else None)})" for v in VERDICTS]
            + [f"{h.get('cut', 0)} ({h.get('cut_honest', 0)} honest)"] for h in summary["honesty"]]


def pair_cell(p):
    if not p or p["diff_pts"] is None:
        return "n/a"
    lo, hi = p["ci95_pts"]
    return f"{p['diff_pts']:+.1f} pts [{lo:.1f}, {hi:.1f}] {p['only_model']} vs {p['only_base']} p={p['sign_p']:.3f}"


def table(head, rows):
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for r in rows:
        out.append("| " + " | ".join(str(x).replace("|", "/") for x in r) + " |")
    return "\n".join(out)


def model_names(summary):
    return [m["name"] for m in summary["models"]]


def accuracy_markdown(summary):
    names = model_names(summary)
    keys = []
    for c in summary["accuracy"]:
        k = (c["set"], c["group"], c["mode"])
        if k not in keys:
            keys.append(k)
    rows = []
    for s, g, mode in keys:
        cells = {c["model"]: c for c in summary["accuracy"] if (c["set"], c["group"], c["mode"]) == (s, g, mode)}
        rows.append([s, group_label(s, g), mode] + [acc_cell(cells.get(n)) for n in names])
    return table(["set", "group", "mode"] + names, rows) if rows else "(no rows yet)"


def paired_markdown(summary):
    others = [n for n in model_names(summary) if n != summary["base"]]
    keys = []
    for p in summary["paired"]:
        k = (p["set"], p["group"], p["mode"])
        if k not in keys:
            keys.append(k)
    rows = []
    for s, g, mode in keys:
        cells = {p["model"]: p for p in summary["paired"] if (p["set"], p["group"], p["mode"]) == (s, g, mode)}
        rows.append([s, group_label(s, g), mode] + [pair_cell(cells.get(n)) for n in others])
    return table(["set", "group", "mode"] + [n + (" (tuned)" if n in summary["tuned"] else "") for n in others], rows) if rows else "(no pairs: the base model has no rows)"


def et(iso):
    if not iso:
        return "n/a"
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return t.astimezone(common.ET).strftime("%b %d, %Y %I:%M %p %Z")
    except ValueError:
        return iso


def lab_line(lab):
    if not lab:
        return "no lab state recorded (servers reached without lab.py state)"
    return (f"{lab.get('type') or 'unknown type'}, KV {lab.get('kv') or 'unknown'}, ctx per slot {lab.get('ctx_per_slot') or 'unknown'}, "
            f"llama.cpp {str(lab.get('llama_cpp_commit') or 'unknown')[:12]}, ladder steps {len(lab.get('ladder') or [])}")


ACCURACY_NOTE = ("Right / graded, Wilson 95% interval. Honesty sets: honest verdicts / replies. \"N cut (M right)\": replies "
                 "that stopped at the token limit, graded on the cut text, and how many of them still counted right.")


def off_text(plan):
    v = plan.get("max_tokens_off") or "glimmer (runs before --max-tokens-off)"
    return f"{v}{' (auto)' if plan.get('max_tokens_off_auto') else ''}"


def render_md(summary):
    names = model_names(summary)
    s = summary
    out = [f"# Eval run {s['run_id']}", ""]
    out.append(f"Started {et(s['start'])}, ended {et(s['end'])}. Status: {s['status']}, "
               f"{'complete' if s['complete'] else 'not complete'}, {s['n_rows']} replies, {s['errors']} errors, {s['sessions']} session(s).")
    pin = s.get("llama_cpp") or {}
    out.append(f"Lab: {lab_line(s['lab'])}. llama.cpp pinned in models.json: tag {pin.get('tag') or 'n/a'}, commit "
               f"{str(pin.get('commit') or 'n/a')[:12]}. Git HEAD {str(s.get('git_head') or 'n/a')[:12]}.")
    if s["sessions"] > 1:
        out.append(f"This run spans {s['sessions']} sessions (resumed, or models added later), which may have run on different "
                   "lab machines. Each session's lab: " + "; ".join(lab_line(x) for x in s["labs"]) + ".")
    out.append(f"Paired reference: {s['base']}. Keep this report local: it holds private dev questions.")
    out += ["", "## Models", ""]
    rows = []
    for m in s["models"]:
        rows.append([m["name"], m.get("role") or "", m.get("label") or "", m.get("file") or "", m.get("sha256") or "not recorded",
                     f"{m['bpw']:.2f}" if m.get("bpw") else "n/a", m.get("quant") or "", m.get("reasoning_level") or "",
                     ", ".join(m.get("modes") or []), m.get("cutoff") or "", m.get("license") or ""])
    out.append(table(["model", "role", "label", "file", "sha256", "bits per weight", "quant", "reasoning level", "modes", "cutoff", "license"], rows))
    out += ["", "Server flags as run:", ""]
    for m in s["models"]:
        src = "" if m.get("flags_source") == "lab state" else " (from models.json: no lab state was recorded)"
        out.append(f"- {m['name']}: `{' '.join(map(str, m.get('flags') or []))}`{src}")
    samp = s.get("sampling") or {}
    out += ["", "## Sampling and limits", "",
            f"Greedy for every model: temperature {samp.get('temperature')}, top_k {samp.get('top_k')}, top_p {samp.get('top_p')}, "
            f"seed {samp.get('seed')}, cache_prompt {samp.get('cache_prompt')}, plus the neutral block "
            f"`{json.dumps(samp.get('neutral'), separators=(',', ':'))}`. System prompt for every request: \"{common.SYSTEM}\".", ""]
    lim = s.get("limits") or {}
    out.append(table(["set", "max tokens off", "max tokens on"], [[k, v.get("off"), v.get("on")] for k, v in lim.items()]))
    if s.get("capped_by_lab"):
        out.append(f"\nThe lab ran the smaller context, so every reasoning-on limit was capped at {s['capped_by_lab']}.")
    p = s.get("plan") or {}
    out.append(f"\nPlan: reasoning {p.get('reasoning')}, limit {p.get('limit') or 'none'}, probes {p.get('probes_n')}, "
               f"thinking-off limits {off_text(p)}, python tests on the lab {'yes' if p.get('python_on_lab') else 'no'}.")
    out += ["", "## Accuracy", "", ACCURACY_NOTE, "", accuracy_markdown(s)]
    out += ["", "## Paired against " + str(s["base"]), "",
            "Same set, item and mode. Difference in points with a Newcombe (1998) method 10 interval; "
            "\"a vs b\" counts items right only in this model and right only in base; p is the exact two-sided sign test.", "",
            paired_markdown(s)]
    if s["honesty"]:
        out += ["", "## Honesty verdicts", "", "\"cut at limit\": replies that stopped at the token limit; the grader "
                "reads them as they stand.", ""]
        out.append(table(["set", "mode", "model", "n"] + list(VERDICTS) + ["cut at limit"], honesty_rows(s)))
        rows = []
        for h in s["honesty"]:
            for k, c in h["by_kind"].items():
                tot = sum(c.values())
                rows.append([h["set"], h["mode"], h["model"], k, tot] + [c[v] for v in VERDICTS])
        out += ["", "By kind (counts):", "", table(["set", "mode", "model", "kind", "n"] + list(VERDICTS), rows)]
    if s["context"]:
        out += ["", "## Honesty beside knowledge", "",
                "The honesty dev set has no controls: a model that declines everything looks honest. Read its honest rate "
                "next to probe accuracy and declines (wrong answers that decline or point to a cutoff; for models whose "
                "cutoff is before the events, declining is honest: see Declines).", ""]
        out.append(table(CONTEXT_HEAD, context_rows(s)))
    if s["over_refusal"]:
        out += ["", "## Declines", "", DECLINES_NOTE, ""]
        out.append(table(DECLINES_HEAD, declines_rows(s)))
    if s["by_month"]:
        out += ["", "## By event month", ""]
        keys = []
        for b in s["by_month"]:
            k = (b["set"], b["mode"], b["month"])
            if k not in keys:
                keys.append(k)
        rows = []
        for st, mode, month in keys:
            cells = {b["model"]: b for b in s["by_month"] if (b["set"], b["mode"], b["month"]) == (st, mode, month)}
            rows.append([st, mode, month] + [f"{cells[n]['right']}/{cells[n]['n']} {pct(cells[n]['rate'])}" if n in cells and cells[n]["n"] else "n/a" for n in names])
        out.append(table(["set", "mode", "month"] + names, rows))
    out += ["", "## Serving", "", "Errors count as not right. A length cut with no final answer is graded wrong. tok/s is on a "
            "shared GPU, not a model property.", ""]
    rows = [[x["model"], x["mode"], x["replies"], x["errors"], x["http_500"], x["length_cuts"], x["cut_no_final"], x["empty_final"],
             x["median_completion_tokens"], x["median_reasoning_chars"], x["median_final_words"], x["median_seconds"], x["median_tok_s"]]
            for x in s["serving"]]
    out.append(table(["model", "mode", "replies", "errors", "HTTP 500", "length cuts", "cut, no final", "empty final",
                      "median completion tokens", "median reasoning chars", "median final words", "median seconds", "median tok/s"], rows))
    if s["final_words"]:
        out += ["", "Median final words by set:", ""]
        keys = []
        for f in s["final_words"]:
            if (f["set"], f["mode"]) not in keys:
                keys.append((f["set"], f["mode"]))
        rows = []
        for st, mode in keys:
            cells = {f["model"]: f for f in s["final_words"] if (f["set"], f["mode"]) == (st, mode)}
            rows.append([st, mode] + [cells[n]["median"] if n in cells else "n/a" for n in names])
        out.append(table(["set", "mode"] + names, rows))
    if s["skipped"]:
        out += ["", "## Skipped", ""] + [f"- {x['model']}" + (f" mode {x['mode']}" if x.get("mode") else "") + f": {x['why']}" for x in s["skipped"]]
    out += ["", "## Caveats", ""] + [f"- {c}" for c in CAVEATS]
    return "\n".join(out) + "\n"


# HTML.

def esc(x):
    return html.escape("" if x is None else str(x))


def html_table(head, rows):
    out = ["<div class=\"tw\"><table><thead><tr>" + "".join(f"<th>{esc(h)}</th>" for h in head) + "</tr></thead><tbody>"]
    for r in rows:
        out.append("<tr>" + "".join(f"<td>{esc(x)}</td>" for x in r) + "</tr>")
    out.append("</tbody></table></div>")
    return "".join(out)


def page_data(summary, rows):
    items = {}
    for r in rows:
        k = (r["set"], r["id"], r["mode"])
        it = items.get(k)
        if it is None:
            it = items[k] = {"set": r["set"], "id": r["id"], "mode": r["mode"], "q": r.get("question") or "", "exp": r.get("expected"),
                             "kind": r.get("kind"), "part": r.get("part"), "month": r.get("month"), "c": {}}
        it["c"][r["model"]] = {"f": r.get("final") or "", "r": r.get("right"), "v": r.get("verdict"), "w": r.get("why"),
                               "e": r.get("error"), "fin": r.get("finish"), "ct": r.get("completion_tokens"),
                               "rc": r.get("reasoning_chars"), "s": r.get("seconds"), "rv": right_declining(r)}
    order = {s: i for i, s in enumerate(summary["sets"])}
    out = sorted(items.values(), key=lambda x: (order.get(x["set"], 99), x["id"], x["mode"]))
    return {"run_id": summary["run_id"], "base": summary["base"], "tuned": summary["tuned"], "sets": summary["sets"],
            "models": [{"name": m["name"], "label": m.get("label"), "role": m.get("role"), "bpw": m.get("bpw")} for m in summary["models"]],
            "items": out}


def json_for_script(value):
    """JSON safe inside a <script> element: no "<", ">" or "&" left to close it."""
    return json.dumps(value, ensure_ascii=False).replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e") \
        .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


CSS = """
:root{--bg:#f7f7f5;--panel:#ffffff;--text:#1d1f21;--muted:#5f6368;--line:#dadce0;--accent:#2f5bd3;
--ok:#1e7d3c;--ok-bg:#e3f4e8;--bad:#b3261e;--bad-bg:#fbe5e3;--warn:#8a5a00;--warn-bg:#fdf0d5;--grey-bg:#eceff1;color-scheme:light}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#141517;--panel:#1d1f22;--text:#e8eaed;--muted:#a0a4a8;
--line:#3a3d41;--accent:#8ab4f8;--ok:#7fd89b;--ok-bg:#183524;--bad:#f28b82;--bad-bg:#3d1d1b;--warn:#f5c26b;--warn-bg:#3a2d12;--grey-bg:#2a2d31;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#141517;--panel:#1d1f22;--text:#e8eaed;--muted:#a0a4a8;--line:#3a3d41;--accent:#8ab4f8;--ok:#7fd89b;
--ok-bg:#183524;--bad:#f28b82;--bad-bg:#3d1d1b;--warn:#f5c26b;--warn-bg:#3a2d12;--grey-bg:#2a2d31;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header,main{max-width:1400px;margin:0 auto;padding:12px 16px}h1{font-size:20px;margin:4px 0}h2{font-size:16px;margin:20px 0 8px}
.sub{color:var(--muted);margin:2px 0}nav{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
nav button,.filters button{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit}
nav button[aria-selected="true"]{border-color:var(--accent);color:var(--accent);font-weight:600}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:6px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap}
th{position:sticky;top:0;background:var(--panel)}
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:8px 0;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}
.filters input[type=search]{flex:1;min-width:160px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font:inherit}
.filters select{padding:4px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font:inherit}
.card{border:1px solid var(--line);border-radius:8px;background:var(--panel);margin:10px 0;padding:10px}
.q{white-space:pre-wrap;font-weight:600;margin:0 0 4px}.meta{color:var(--muted);font-size:12px;margin-bottom:6px;white-space:pre-wrap}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px}
.col{border:1px solid var(--line);border-radius:6px;padding:6px;min-width:0}.col h3{font-size:13px;margin:0 0 4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.final{white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;margin:4px 0;font-size:13px}
.why{color:var(--muted);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.b{display:inline-block;border-radius:10px;padding:0 7px;font-size:12px;font-weight:600}
.b.ok{background:var(--ok-bg);color:var(--ok)}.b.bad{background:var(--bad-bg);color:var(--bad)}.b.err{background:var(--warn-bg);color:var(--warn)}.b.na{background:var(--grey-bg);color:var(--muted)}
.count{color:var(--muted)}.more{margin:10px 0}.note{color:var(--muted);font-size:12px}
ul{padding-left:18px}
@media (max-width:600px){header,main{padding:10px 16px}th,td{padding:4px 6px}}
"""

JS = r"""
(function(){
var D = JSON.parse(document.getElementById('data').textContent);
var models = D.models, base = D.base, tuned = D.tuned || [];
var state = {set: null, mode: 'all', disagree: false, tunedBase: false, errors: false, care: false, q: '', shown: 40};
var summary = document.getElementById('summary'), items = document.getElementById('items');
var list = document.getElementById('list'), count = document.getElementById('count');
function el(tag, cls, text){var e = document.createElement(tag); if(cls) e.className = cls; if(text !== undefined && text !== null) e.textContent = String(text); return e;}
function right(c){ if(!c) return null; if(c.e) return false; return c.r; }
function differs(it){
  var seen = {}, n = 0;
  models.forEach(function(m){ var r = right(it.c[m.name]); if(r === null || r === undefined) return; if(!(String(r) in seen)){ seen[String(r)] = 1; n++; } });
  return n > 1;
}
function tunedVsBase(it){
  var b = right(it.c[base]); if(b === null || b === undefined) return false;
  return tuned.some(function(t){ var r = right(it.c[t]); return r !== null && r !== undefined && r !== b; });
}
function matches(it){
  if(it.set !== state.set) return false;
  if(state.mode !== 'all' && it.mode !== state.mode) return false;
  if(state.disagree && !differs(it)) return false;
  if(state.tunedBase && !tunedVsBase(it)) return false;
  if(state.errors && !models.some(function(m){ var c = it.c[m.name]; return c && c.e; })) return false;
  if(state.care && !models.some(function(m){ var c = it.c[m.name]; return c && !c.e && (c.rv || c.fin === 'length'); })) return false;
  if(state.q){
    var hay = (it.q + ' ' + (it.exp || '') + ' ' + it.id + ' ' + models.map(function(m){ var c = it.c[m.name]; return c ? c.f : ''; }).join(' ')).toLowerCase();
    if(hay.indexOf(state.q) < 0) return false;
  }
  return true;
}
function badge(c){
  if(!c) return el('span', 'b na', 'not asked');
  if(c.e) return el('span', 'b err', 'error');
  var txt = c.v || (c.r ? 'right' : 'wrong');
  if(c.r === null || c.r === undefined) return el('span', 'b na', txt);
  return el('span', c.r ? 'b ok' : 'b bad', txt);
}
function card(it){
  var d = el('div', 'card');
  d.appendChild(el('p', 'q', it.q));
  var bits = ['id ' + it.id, 'mode ' + it.mode];
  if(it.kind) bits.push('kind ' + it.kind); if(it.part) bits.push('part ' + it.part); if(it.month) bits.push('month ' + it.month);
  d.appendChild(el('div', 'meta', 'Expected: ' + (it.exp || 'n/a') + '\n' + bits.join(', ')));
  var cols = el('div', 'cols');
  models.forEach(function(m){
    var c = it.c[m.name]; var col = el('div', 'col'); var h = el('h3');
    h.appendChild(el('span', null, m.name + (m.role === 'base' ? ' (base)' : m.role === 'tuned' ? ' (tuned)' : '')));
    h.appendChild(badge(c)); col.appendChild(h);
    if(c){
      if(c.e) col.appendChild(el('div', 'why', c.e));
      col.appendChild(el('div', 'final', c.f || '(empty final answer)'));
      var w = [];
      if(c.w) w.push(c.w);
      if(c.rv && !(c.w && c.w.indexOf('decline') >= 0)) w.push('graded right, but the reply also reads as a decline: read it before counting it');
      if(c.fin === 'length' && !c.e && c.f) w.push('cut at the token limit: graded on the cut text');
      w.push('finish ' + (c.fin || 'n/a') + ', ' + (c.ct === null || c.ct === undefined ? '?' : c.ct) + ' tokens' + (c.rc ? ', reasoning ' + c.rc + ' chars' : '') + (c.s ? ', ' + c.s + ' s' : ''));
      col.appendChild(el('div', 'why', w.join('\n')));
    }
    cols.appendChild(col);
  });
  d.appendChild(cols);
  return d;
}
function render(){
  list.textContent = '';
  var hits = D.items.filter(matches);
  count.textContent = hits.length + ' of ' + D.items.filter(function(it){ return it.set === state.set; }).length + ' items match';
  hits.slice(0, state.shown).forEach(function(it){ list.appendChild(card(it)); });
  var more = document.getElementById('more');
  more.hidden = hits.length <= state.shown;
  more.textContent = 'Show 40 more (' + (hits.length - state.shown) + ' left)';
}
function show(name){
  document.querySelectorAll('nav button').forEach(function(b){ b.setAttribute('aria-selected', String(b.dataset.tab === name)); });
  if(name === '__summary'){ summary.hidden = false; items.hidden = true; state.set = null; }
  else { summary.hidden = true; items.hidden = false; state.set = name; state.shown = 40; render(); }
}
var nav = document.getElementById('tabs');
function tab(name, label){ var b = el('button', null, label); b.type = 'button'; b.dataset.tab = name; b.setAttribute('role', 'tab'); b.addEventListener('click', function(){ show(name); }); nav.appendChild(b); }
tab('__summary', 'Summary');
D.sets.forEach(function(s){ tab(s, s); });
document.getElementById('mode').addEventListener('change', function(e){ state.mode = e.target.value; state.shown = 40; render(); });
document.getElementById('disagree').addEventListener('change', function(e){ state.disagree = e.target.checked; state.shown = 40; render(); });
document.getElementById('tunedbase').addEventListener('change', function(e){ state.tunedBase = e.target.checked; state.shown = 40; render(); });
document.getElementById('errors').addEventListener('change', function(e){ state.errors = e.target.checked; state.shown = 40; render(); });
document.getElementById('care').addEventListener('change', function(e){ state.care = e.target.checked; state.shown = 40; render(); });
document.getElementById('q').addEventListener('input', function(e){ state.q = e.target.value.trim().toLowerCase(); state.shown = 40; render(); });
document.getElementById('more').addEventListener('click', function(){ state.shown += 40; render(); });
var start = decodeURIComponent((location.hash || '').slice(1));
show(D.sets.indexOf(start) >= 0 ? start : '__summary');
})();
"""


def render_html(summary, rows):
    s = summary
    names = model_names(s)
    parts = []
    acc_keys = []
    for c in s["accuracy"]:
        k = (c["set"], c["group"], c["mode"])
        if k not in acc_keys:
            acc_keys.append(k)
    acc_rows = []
    for st, g, mode in acc_keys:
        cells = {c["model"]: c for c in s["accuracy"] if (c["set"], c["group"], c["mode"]) == (st, g, mode)}
        acc_rows.append([st, group_label(st, g), mode] + [acc_cell(cells.get(n)) for n in names])
    parts.append(f"<h2>Accuracy</h2><p class=\"note\">{esc(ACCURACY_NOTE)} Thinking-off limits: {esc(off_text(s.get('plan') or {}))}.</p>")
    parts.append(html_table(["set", "group", "mode"] + names, acc_rows))
    others = [n for n in names if n != s["base"]]
    pk = []
    for p in s["paired"]:
        k = (p["set"], p["group"], p["mode"])
        if k not in pk:
            pk.append(k)
    pr = []
    for st, g, mode in pk:
        cells = {p["model"]: p for p in s["paired"] if (p["set"], p["group"], p["mode"]) == (st, g, mode)}
        pr.append([st, group_label(st, g), mode] + [pair_cell(cells.get(n)) for n in others])
    parts.append(f"<h2>Paired against {esc(s['base'])}</h2><p class=\"note\">Same set, item and mode. Points with a Newcombe "
                 "(1998) method 10 interval; \"a vs b\" counts items right only in this model and right only in base; p is the exact sign test.</p>")
    parts.append(html_table(["set", "group", "mode"] + [n + (" (tuned)" if n in s["tuned"] else "") for n in others], pr) if pr else "<p>No pairs: the base model has no rows.</p>")
    if s["context"]:
        parts.append("<h2>Honesty beside knowledge</h2><p class=\"note\">The honesty dev set has no controls: read the honest rate "
                     "next to probe accuracy and declines (for models whose cutoff is before the events, declining is honest: see Declines).</p>")
        parts.append(html_table(CONTEXT_HEAD, context_rows(s)))
    if s["honesty"]:
        parts.append("<h2>Honesty verdicts</h2><p class=\"note\">\"cut at limit\": replies that stopped at the token limit; "
                     "the grader reads them as they stand.</p>")
        parts.append(html_table(["set", "mode", "model", "n"] + list(VERDICTS) + ["cut at limit"], honesty_rows(s)))
    if s["over_refusal"]:
        parts.append(f"<h2>Declines</h2><p class=\"note\">{esc(DECLINES_NOTE)}</p>")
        parts.append(html_table(DECLINES_HEAD, declines_rows(s)))
    parts.append("<h2>Serving</h2><p class=\"note\">tok/s is on a shared GPU, not a model property.</p>")
    parts.append(html_table(["model", "mode", "replies", "errors", "HTTP 500", "length cuts", "cut, no final", "empty final", "median completion tokens",
                             "median reasoning chars", "median final words", "median seconds", "median tok/s"],
                            [[x["model"], x["mode"], x["replies"], x["errors"], x["http_500"], x["length_cuts"], x["cut_no_final"], x["empty_final"],
                              x["median_completion_tokens"], x["median_reasoning_chars"], x["median_final_words"], x["median_seconds"], x["median_tok_s"]]
                             for x in s["serving"]]))
    if s["by_month"]:
        mk = []
        for b in s["by_month"]:
            k = (b["set"], b["mode"], b["month"])
            if k not in mk:
                mk.append(k)
        mr = []
        for st, mode, month in mk:
            cells = {b["model"]: b for b in s["by_month"] if (b["set"], b["mode"], b["month"]) == (st, mode, month)}
            mr.append([st, mode, month] + [f"{cells[n]['right']}/{cells[n]['n']} {pct(cells[n]['rate'])}" if n in cells and cells[n]["n"] else "n/a" for n in names])
        parts.append("<h2>By event month</h2>" + html_table(["set", "mode", "month"] + names, mr))
    parts.append("<h2>Models</h2>")
    parts.append(html_table(["model", "role", "file", "sha256", "bits per weight", "quant", "reasoning level", "modes", "cutoff", "license"],
                            [[m["name"], m.get("role"), m.get("file"), m.get("sha256") or "not recorded", f"{m['bpw']:.2f}" if m.get("bpw") else "n/a",
                              m.get("quant"), m.get("reasoning_level"), ", ".join(m.get("modes") or []), m.get("cutoff"), m.get("license")] for m in s["models"]]))
    if s["skipped"]:
        parts.append("<h2>Skipped</h2><ul>" + "".join(f"<li>{esc(x['model'])}{esc(' mode ' + x['mode']) if x.get('mode') else ''}: {esc(x['why'])}</li>" for x in s["skipped"]) + "</ul>")
    parts.append("<h2>Caveats</h2><ul>" + "".join(f"<li>{esc(c)}</li>" for c in CAVEATS) + "</ul>")
    sub = (f"Started {et(s['start'])}, ended {et(s['end'])}. {s['n_rows']} replies, {s['errors']} errors, "
           f"{'complete' if s['complete'] else 'not complete'}. Lab: {lab_line(s['lab'])}. Paired reference: {s['base']}.")
    return ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            f"<title>Eval report {esc(s['run_id'])}</title><style>{CSS}</style></head><body>"
            f"<header><h1>Eval run {esc(s['run_id'])}</h1><p class=\"sub\">{esc(sub)}</p>"
            "<p class=\"sub\">Local only: this page holds private dev questions.</p><nav id=\"tabs\" role=\"tablist\"></nav></header><main>"
            f"<section id=\"summary\">{''.join(parts)}</section>"
            "<section id=\"items\" hidden><div class=\"filters\">"
            "<label>Mode <select id=\"mode\"><option value=\"all\">all</option><option value=\"off\">off</option><option value=\"on\">on</option></select></label>"
            "<label><input type=\"checkbox\" id=\"disagree\"> models disagree</label>"
            "<label><input type=\"checkbox\" id=\"tunedbase\"> tuned and base differ</label>"
            "<label><input type=\"checkbox\" id=\"errors\"> errors only</label>"
            "<label><input type=\"checkbox\" id=\"care\"> cut at limit or right but declining</label>"
            "<input type=\"search\" id=\"q\" placeholder=\"Search questions and answers\" aria-label=\"Search\">"
            "<span class=\"count\" id=\"count\"></span></div><div id=\"list\"></div>"
            "<button type=\"button\" class=\"more\" id=\"more\" hidden>Show more</button></section></main>"
            f"<script type=\"application/json\" id=\"data\">{json_for_script(page_data(s, rows))}</script>"
            f"<script>{JS}</script></body></html>\n")


def build(run_dir, base=None, write=True):
    meta = load_meta(run_dir)
    rows = load_rows(run_dir)
    summary = build_summary(meta, rows, base=base)
    if write:
        for name, text in (("summary.json", json.dumps(summary, ensure_ascii=False, indent=1)), ("report.md", render_md(summary)),
                           ("report.html", render_html(summary, rows))):
            write_private(os.path.join(run_dir, name), text)
    return summary


def write_private(path, text):
    """Atomic write, mode 600 (the reports hold private dev questions)."""
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Rebuild summary.json, report.md and report.html for one eval run folder.")
    ap.add_argument("run_dir")
    ap.add_argument("--base", help="paired reference (default: the run's base model)")
    a = ap.parse_args(argv)
    summary = build(a.run_dir, base=a.base)
    print(accuracy_markdown(summary))
    print(f"\nwrote {os.path.join(a.run_dir, 'summary.json')}, report.md and report.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
