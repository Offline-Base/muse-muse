"""Knowledge with reasoning on. Every knowledge score so far prefills the final channel, so nobody has measured whether trained
facts survive when the model reasons first. This asks the fixed 1,500's first 300, the new 1,000's first 300 and the 40 old
facts with the template's generation prompt and nothing after it, greedy, at reasoning medium and low, and grades with
train_glimmer.answered() on the final channel only (a closed to=user channel with exactly that header, what an app can
parse). "First 300" is score_gguf.py's choice, the first after shuffling with random.Random(7), so NanoQuant's 300 and 300 are
the same questions.

Also reported, so a loss can be placed: right with any header spelling (the gap is channel damage, not knowledge), the answer
somewhere in the reasoning but not the final reply, and the final reply's first 96 tokens only (what a prefilled score reads).
With --prefilled, each question is paired with the prefilled answer of the same model: the accuracy on the same questions, and
how many went each way, with an exact sign test.

Two modes. --gguf: llama-server, through score_reasoning.py's helpers. --adapter: transformers on one GPU, through
measure_known.Answerer (KNOWLEDGE_MODEL and KNOWLEDGE_4BIT as for train_glimmer.py) and check_channels_bf16.greedy_tokens;
--adapter none is the base. Replies are parsed by score_reasoning.py, not a copy. Hold ~/q/gpu.lock around GGUF mode.

  python score_probes_reasoning.py --gguf FILE --tokenizer BASE_DIR --label NAME --out FILE.json --probes stage2-eval-probes.jsonl \
      --forget forget.jsonl [--prefilled scores/Q4_K_M.json] [--strengths medium,low] [--parallel 32] [--port 8095] [--deadline-epoch N]
  python score_probes_reasoning.py --adapter DIR --tokenizer BASE_DIR --label NAME --out FILE.json --probes stage2-eval-probes.jsonl \
      --forget forget.jsonl [--prefilled answers.json:tuned] [--gpu 0] [--batch 32]
  python score_probes_reasoning.py --table A.json [B.json ...]

--probes holds the fixed 1,500, then the new 1,000 (stage_probes.py writes it so; --fixed-n moves the line). --prefilled takes
score_gguf.py's JSON or a train_glimmer.py answers.json with :base or :tuned, several times to pool (the fixed file and a new-1000
file; base needs both). Output prints counts only.

Time: 640 questions a strength. Replies average perhaps 150 to 300 tokens (not measured on these questions), so about 100,000 to
200,000 tokens: 6 to 12 minutes a strength in GGUF mode at about 290 tokens a second, 10 to 20 in adapter mode at about 180.
"""

import argparse
import json
import os
import random
import re
import statistics
import sys
import threading
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from score_reasoning import SERVER, analyze_raw, channel_parts, discordance, post, prompt_ids, rate, start_server, stop_server  # noqa: E402
from train_glimmer import answered, read_jsonl  # noqa: E402

FIXED_N = 1500
SETS = ("fixed", "new", "old")
FIRST_FINAL = 96  # MAX_NEW_TOKENS of every prefilled score


def choose(probes_path, forget_path, n, fixed_n):
    """The questions, tagged: score_gguf.py's first n of each set, then the old facts."""
    probes = read_jsonl(probes_path)
    fixed, new = probes[:fixed_n], probes[fixed_n:]
    random.Random(7).shuffle(fixed)
    random.Random(7).shuffle(new)
    return [{**p, "set": "fixed"} for p in fixed[:n]] + [{**p, "set": "new"} for p in new[:n]] + [{**p, "set": "old"} for p in read_jsonl(forget_path)]


def graded_row(item, toks, stop, tok, strength):
    """One reply. right: answered() on the strict final channel, closed or not, as score_reasoning.py grades a cut reply."""
    reasoning, final_toks, channels, reached = channel_parts(toks, "on", tok)
    final = tok.decode(final_toks, skip_special_tokens=False).strip()
    raw = tok.decode(toks, skip_special_tokens=False)
    seen = analyze_raw(raw)
    # Whatever isn't the lenient final reply counts as reasoning here, so a misspelled header can't hide a fact.
    cut = raw.rfind(seen["final_lenient"]) if seen["final_lenient"] else len(raw)
    thinking = re.sub(r"<\|[^|]*\|>", " ", raw[:cut])
    return {"set": item["set"], "strength": strength, "question": item["question"], "answer": item["answer"], "tokens": len(toks), "stop": stop, "hit_limit": stop == "limit",
            "channels": channels, "shape": seen["shape"], "reached_final": reached, "reasoning_tokens": len(reasoning), "final_tokens": len(final_toks), "final": final, "raw": raw,
            "right": answered(final, item), "right_first96": answered(tok.decode(final_toks[:FIRST_FINAL], skip_special_tokens=False), item),
            "right_lenient": answered(seen["final_lenient"], item), "in_reasoning": answered(thinking, item)}


def read_prefilled(specs):
    """question -> right, from score_gguf.py JSON files and answers.json files (FILE:base or FILE:tuned)."""
    right = {}
    for spec in specs or []:
        path, _, part = spec.partition(":")
        with open(path) as f:
            d = json.load(f)
        if "rows" in d:
            groups = [d["rows"]["probe"], d["rows"]["forget"]]
        else:
            if part not in ("base", "tuned"):
                raise SystemExit(f"{spec}: an answers.json needs :base or :tuned")
            groups = [d[part]["probes"], d[part]["forget"]]
        for rows in groups:
            for r in rows:
                right[r["question"]] = bool(r["right"])
    return right


def set_summary(rows, prefilled):
    tokens = [r["tokens"] for r in rows]
    out = {"final_channel": rate(rows), "first_96_final_tokens": rate([{"right": r["right_first96"]} for r in rows]), "any_header": rate([{"right": r["right_lenient"]} for r in rows]),
           "in_reasoning_not_final": sum(r["in_reasoning"] and not r["right_lenient"] for r in rows), "reached_final": sum(r["reached_final"] for r in rows), "hit_limit": sum(r["hit_limit"] for r in rows),
           "well_formed": sum(r["shape"] == "well formed: to=self, then to=user" for r in rows), "tokens_median": statistics.median(tokens) if tokens else 0,
           "reasoning_tokens_median": statistics.median(r["reasoning_tokens"] for r in rows) if rows else 0}
    paired = [r for r in rows if r["question"] in prefilled]
    if paired:
        with_key = lambda value: [{"id": i, "mode": "on", "right": value(r)} for i, r in enumerate(paired)]
        out["prefilled_same_questions"] = rate([{"right": prefilled[r["question"]]} for r in paired])
        out["paired_final_vs_prefilled"] = discordance(with_key(lambda r: prefilled[r["question"]]), with_key(lambda r: r["right"]))
        out["paired_any_header_vs_prefilled"] = discordance(with_key(lambda r: prefilled[r["question"]]), with_key(lambda r: r["right_lenient"]))
    return out


def summarize_strength(rows, prefilled):
    return {s: set_summary([r for r in rows if r["set"] == s], prefilled) for s in SETS}


def answer_gguf(a, tok, items, strength, prompts, on_row):
    """llama-server's replies, one strength. Returns the server's load seconds."""
    limit = a.deadline_epoch or float("inf")

    def ask(job):
        item, ids = job
        now = time.time()
        if now > limit:
            return
        timeout = 1500 if limit == float("inf") else max(5, limit + 120 - now)
        try:
            r = post(a.port, "/completion", {"prompt": ids, "n_predict": a.max_new_tokens, "temperature": 0.0, "top_k": 1, "return_tokens": True, "cache_prompt": False, "stream": False}, timeout)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            print(f"PROBES request failed: {type(e).__name__}", flush=True)
            return
        on_row(item, r.get("tokens") or [], r.get("stop_type"))

    cmd = [a.server, "-m", a.gguf, "--port", str(a.port), "--host", "127.0.0.1", "-ngl", "999", "-fa", "on", "-np", str(a.parallel), "-c", str(a.parallel * a.slot_ctx), "--no-webui"]
    server, load = start_server(cmd, a.port, f"{a.out}.{strength}.server.log")
    try:
        with ThreadPoolExecutor(max_workers=a.parallel) as pool:
            list(pool.map(ask, zip(items, prompts)))
    finally:
        stop_server(server)
    return load


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gguf")
    ap.add_argument("--adapter")
    ap.add_argument("--tokenizer")
    ap.add_argument("--label")
    ap.add_argument("--out")
    ap.add_argument("--probes")
    ap.add_argument("--forget")
    ap.add_argument("--prefilled", action="append")
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--fixed-n", type=int, default=FIXED_N)
    ap.add_argument("--strengths", default="medium,low")
    ap.add_argument("--max-new-tokens", type=int, default=1024)
    ap.add_argument("--gpu", type=int, default=0)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--server", default=SERVER)
    ap.add_argument("--port", type=int, default=8095)
    ap.add_argument("--parallel", type=int, default=32)
    ap.add_argument("--slot-ctx", type=int, default=1400)
    ap.add_argument("--deadline-epoch", type=float, default=0)
    ap.add_argument("--table", nargs="+")
    a = ap.parse_args()
    if a.table:
        print_table(a.table)
        return
    missing = [n for n in ("tokenizer", "label", "out", "probes", "forget") if not getattr(a, n)]
    if missing or bool(a.gguf) == bool(a.adapter):
        ap.error("a run needs --tokenizer, --label, --out, --probes, --forget and one of --gguf or --adapter")

    items = choose(a.probes, a.forget, a.n, a.fixed_n)
    prefilled = read_prefilled(a.prefilled)
    answerer = None
    if a.adapter:
        os.environ["CUDA_VISIBLE_DEVICES"] = str(a.gpu)
        os.environ["UNSLOTH_BFLOAT16_MIXED_PRECISION"] = "1"  # greedy_tokens() runs in chunks; check_channels_bf16.py says why
        from measure_known import Answerer
        answerer = Answerer(None if a.adapter == "none" else a.adapter)
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.tokenizer)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    print(f"PROBES {a.label}: {len(items)} questions, {sum(i['set'] == 'fixed' for i in items)} fixed, {sum(i['set'] == 'new' for i in items)} new, {sum(i['set'] == 'old' for i in items)} old, "
          f"{sum(i['question'] in prefilled for i in items)} with a prefilled answer", flush=True)

    out = {"label": a.label, "gguf": a.gguf, "adapter": a.adapter, "n_questions": len(items), "max_new_tokens": a.max_new_tokens, "prefilled": a.prefilled or [], "runs": {}}
    for strength in a.strengths.split(","):
        prompts = [prompt_ids(tok, it, "on", strength) for it in items]
        if a.gguf and max(map(len, prompts)) + a.max_new_tokens > a.slot_ctx:
            raise RuntimeError("a prompt is too long for --slot-ctx")
        rows, lock, t0, generated = [], threading.Lock(), time.time(), [0]

        def on_row(item, toks, stop):
            row = graded_row(item, toks, stop, tok, strength)
            with lock:
                rows.append(row)
                generated[0] += len(toks)
                if len(rows) % 50 == 0:
                    print(f"PROBES {a.label} {strength} {len(rows)}/{len(items)} {round(generated[0] / max(time.time() - t0, 1e-9), 1)} tok/s", flush=True)

        if a.gguf:
            answer_gguf(a, tok, items, strength, prompts, on_row)
        else:
            from check_channels_bf16 import greedy_tokens
            deadline = a.deadline_epoch or float("inf")
            greedy_tokens(answerer.model, answerer.torch, tok, prompts, a.max_new_tokens, a.batch, deadline=deadline,
                          on_done=lambda i, reply: on_row(items[i], reply[0], reply[1]), device=answerer.device, log=lambda m: print(m, flush=True))
        out["runs"][strength] = {"complete": len(rows) == len(items), "n_skipped": len(items) - len(rows), "seconds": round(time.time() - t0, 1), "generated_tokens": generated[0],
                                 "summary": summarize_strength(rows, prefilled), "rows": rows}
        # After every strength, so a stop loses at most the one running.
        with open(a.out + ".tmp", "w") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        os.replace(a.out + ".tmp", a.out)
        print("PROBES " + json.dumps({"label": a.label, "strength": strength, **{k: v for k, v in out["runs"][strength].items() if k != "rows"}}), flush=True)


def print_table(paths):
    runs = []
    for p in paths:
        with open(p) as f:
            d = json.load(f)
        runs += [(d["label"], strength, r) for strength, r in d["runs"].items()]

    def cell(x):
        return f"{x['right']}/{x['n']} {100 * x['rate']:.1f}%" if x else "not given"

    print("| | " + " | ".join(f"{label} ({strength})" for label, strength, _ in runs) + " |")
    print("|---|" + "---|" * len(runs))
    print("| complete | " + " | ".join(str(r["complete"]) for _, _, r in runs) + " |")
    for s in SETS:
        def line(name, value):
            print(f"| {s}: {name} | " + " | ".join(str(value(r["summary"][s])) for _, _, r in runs) + " |")
        line("**final channel, reasoning on**", lambda x: cell(x["final_channel"]))
        line("prefilled, same questions", lambda x: cell(x.get("prefilled_same_questions")))
        line("only prefilled right / only reasoning right, sign p", lambda x: (lambda y: f"{y['only_a']} / {y['only_b']}, {y['sign_p']}" if y else "")(x.get("paired_final_vs_prefilled")))
        line("any header spelling", lambda x: cell(x["any_header"]))
        line("first 96 final tokens", lambda x: cell(x["first_96_final_tokens"]))
        line("in reasoning, not in any final", lambda x: x["in_reasoning_not_final"])
        line("well formed / reached final / hit limit", lambda x: f"{x['well_formed']} / {x['reached_final']} / {x['hit_limit']}")
        line("tokens / reasoning tokens, median", lambda x: f"{x['tokens_median']:.0f} / {x['reasoning_tokens_median']:.0f}")


if __name__ == "__main__":
    main()
