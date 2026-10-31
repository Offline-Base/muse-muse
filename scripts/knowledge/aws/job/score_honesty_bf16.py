"""The honesty test on the BF16 model with an adapter, on one GPU, for choosing between Stage B's mixes without building
a GGUF for each. Same prompts, token limits, grading and output format as score_honesty.py, so its --replies-only and
judge-honesty.ts read the result; only the runtime differs (transformers through measure_known.Answerer rather than
llama-server, so `gguf` is null and `adapter` says what ran, and `stop` is "limit" or "eos").

Two extras for compare_stage_b.py, neither of them graded. --cutoff-questions (cutoff_questions.jsonl, 20 direct questions)
records which date the model gives as its cutoff, since any date grades honest. --named-controls (stage-b-named-controls.jsonl,
real named reports, trials and acts from held-out questions) records how many it refuses: a model taught that "X Report" means
"false" would refuse the real ones.

--probes has no default on purpose: pass the dev set while choosing, and the final test (honesty_probes.jsonl) only once,
on the model already chosen. `--adapter none` answers with the base model.

--reasoning-on: nothing prefilled, as score_honesty.py --reasoning-on: the bare generation prompt at --strength (low, like the prefilled
prompts, so the two pair up), 1,024 new tokens for every item unless --max-new-tokens says otherwise, through check_channels_bf16.greedy_tokens,
graded on the strict to=user channel only. It needs --tokenizer. Honesty with reasoning on hasn't been measured on any model.
Time: an estimate, not run on a GPU: 120 dev probes and 300 controls at low (a mean of 260 tokens on base) are about 110,000 tokens, about
10 to 15 minutes at the 180 tokens a second check_channels_bf16.py expects.

Usage: python score_honesty_bf16.py --adapter DIR --label NAME --out FILE.json --probes DEV.jsonl \
       --controls-file eval-probes.jsonl [--n-controls 300] [--max-new-tokens 192] [--gpu 0] [--batch 32] [--reasoning-on --tokenizer BASE_DIR [--strength low]]
       python score_honesty.py --replies-only --out FILE.json [MORE.json ...]
"""

import argparse
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from honesty_grade import grade, refuses, stated_cutoffs  # noqa: E402
from measure_known import Answerer, ended  # noqa: E402
from score_honesty import ON_MAX_NEW_TOKENS, check_probes, control_extra, honesty_extra, reasoning_on_reply, summarize  # noqa: E402
from train_glimmer import GEN_BATCH, MAX_NEW_TOKENS, REASONING, answered, final_answer, read_jsonl  # noqa: E402


def in_batches(items, batch, ask, max_new_tokens):
    out = []
    for start in range(0, len(items), batch):
        out += ask([it["question"] for it in items[start:start + batch]], max_new_tokens)
    return out


def read_prefilled(answer):
    """(reply, how it ran, the row's extra fields) of an Answerer.ask() answer: (raw output, tokens)."""
    raw, toks = answer
    return final_answer(raw), {"tokens": toks, "stop": "eos" if ended(raw) else "limit"}, {}


def score(probes, controls, ask, max_new_tokens, batch, cutoff=(), named=(), read=read_prefilled, short=MAX_NEW_TOKENS):
    """Rows in score_honesty.py's format. ask(questions, max_new_tokens) gives one answer per question, and read() parses it.
    short is the limit for everything but the honesty probes."""
    rows = {"honesty": [], "controls": []}
    generated = 0
    for it, answer in zip(probes, in_batches(probes, batch, ask, max_new_tokens)):
        reply, ran, extra = read(answer)
        generated += ran["tokens"]
        rows["honesty"].append({k: it.get(k) for k in ("id", "kind", "topic", "question", "premise", "bait", "note", "facts")}
                               | {"reply": reply, **grade(reply, it | ran), **ran} | honesty_extra(extra, it | ran))
    for it, answer in zip(controls, in_batches(controls, batch, ask, short)):
        reply, ran, extra = read(answer)
        generated += ran["tokens"]
        rows["controls"].append({"question": it["question"], "answer": it["answer"], "aliases": it.get("aliases", []), "reply": reply,
                                 "right": answered(reply, it), "refused": refuses(reply), **ran} | control_extra(extra, it))
    for it, answer in zip(cutoff, in_batches(cutoff, batch, ask, short)):
        reply, ran, extra = read(answer)
        generated += ran["tokens"]
        rows.setdefault("cutoff", []).append({"question": it["question"], "reply": reply, "stated": stated_cutoffs(reply), "stop": ran["stop"]} | extra)
    for it, answer in zip(named, in_batches(named, batch, ask, short)):
        reply, ran, extra = read(answer)
        generated += ran["tokens"]
        rows.setdefault("named", []).append({"question": it["question"], "answer": it["answer"], "aliases": it.get("aliases", []), "reply": reply,
                                             "right": answered(reply, it), "refused": refuses(reply), "stop": ran["stop"]} | control_extra(extra, it))
    return rows, generated


def reasoning_on_ask(answerer, tok, strength):
    """ask() and read() for score() with nothing prefilled: the model's whole reply, chunked, parsed the strict way."""
    from check_channels_bf16 import greedy_tokens
    from score_reasoning import prompt_ids

    def ask(questions, max_new_tokens):
        prompts = [prompt_ids(tok, {"question": q}, "on", strength) for q in questions]
        return greedy_tokens(answerer.model, answerer.torch, tok, prompts, max_new_tokens, len(prompts), device=answerer.device, log=lambda m: print(m, flush=True))

    def read(answer):
        toks, stop = answer
        reply, extra = reasoning_on_reply(toks, tok)
        return reply, {"tokens": len(toks), "stop": stop}, extra

    return ask, read


def choose_controls(path, n):
    """score_honesty.py's controls: the first n after shuffling with random.Random(7)."""
    if n <= 0:
        return []
    controls = read_jsonl(path)
    random.Random(7).shuffle(controls)
    return controls[:n]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True, help="an adapter folder, or none for the base model")
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--probes", required=True)
    ap.add_argument("--controls-file")
    ap.add_argument("--n-controls", type=int, default=300)
    ap.add_argument("--cutoff-questions", help="direct questions about the model's cutoff (cutoff_questions.jsonl)")
    ap.add_argument("--named-controls", help="real named things it should not refuse (stage-b-named-controls.jsonl)")
    ap.add_argument("--max-new-tokens", type=int, help="192; with --reasoning-on 1,024, for everything asked")
    ap.add_argument("--reasoning-on", action="store_true", help="nothing prefilled: the model reasons first, and only its to=user channel is graded")
    ap.add_argument("--strength", default=REASONING, help="reasoning strength for --reasoning-on")
    ap.add_argument("--tokenizer", help="the base tokenizer folder, for --reasoning-on")
    ap.add_argument("--gpu", type=int, default=0)
    ap.add_argument("--batch", type=int, default=GEN_BATCH)
    a = ap.parse_args()
    if a.n_controls > 0 and not a.controls_file:
        ap.error("--controls-file is needed unless --n-controls is 0")
    if a.reasoning_on and not a.tokenizer:
        ap.error("--reasoning-on needs --tokenizer")
    os.environ["CUDA_VISIBLE_DEVICES"] = str(a.gpu)
    if a.reasoning_on:
        os.environ["UNSLOTH_BFLOAT16_MIXED_PRECISION"] = "1"  # greedy_tokens() runs in chunks; check_channels_bf16.py says why
    limit = a.max_new_tokens or (ON_MAX_NEW_TOKENS if a.reasoning_on else 192)
    short = limit if a.reasoning_on else MAX_NEW_TOKENS
    probes = read_jsonl(a.probes)
    check_probes(probes)
    controls = choose_controls(a.controls_file, a.n_controls)
    adapter = None if a.adapter == "none" else a.adapter
    began = time.time()
    answerer = Answerer(adapter)
    load_seconds = round(time.time() - began, 1)
    print(f"HONESTY {a.label} model up in {load_seconds}s, {len(probes)} probes + {len(controls)} controls", flush=True)
    t0 = time.time()
    cutoff = read_jsonl(a.cutoff_questions) if a.cutoff_questions else []
    named = read_jsonl(a.named_controls) if a.named_controls else []
    if a.reasoning_on:
        from transformers import AutoTokenizer
        ask, read = reasoning_on_ask(answerer, AutoTokenizer.from_pretrained(a.tokenizer), a.strength)
    else:
        ask, read = answerer.ask, read_prefilled
    rows, generated = score(probes, controls, ask, limit, a.batch, cutoff, named, read, short)
    wall = time.time() - t0
    summary = summarize(rows)
    weights = os.path.join(adapter, "adapter_model.safetensors") if adapter else None
    size = os.path.getsize(weights) if weights else 0
    out = {
        "label": a.label, "gguf": None, "adapter": adapter or "none", "bytes": size, "gb": round(size / 1e9, 2),
        "probes": os.path.abspath(a.probes), "controls_file": os.path.abspath(a.controls_file) if controls else None,
        **({"reasoning": "on", "strength": a.strength} if a.reasoning_on else {}),
        "max_new_tokens": limit, "control_max_new_tokens": short, "summary": summary,
        "aggregate_tokens_per_second": round(generated / max(wall, 1e-9), 1), "parallel": a.batch,
        "generated_tokens": generated, "score_seconds": round(wall, 1), "server_load_seconds": load_seconds,
        "gpu_mem_used_mib": None, "server_cmd": None, "rows": rows,
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out + ".tmp", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(a.out + ".tmp", a.out)
    print("HONESTY " + json.dumps({"label": a.label, **{k: v for k, v in summary.items() if k != "by_topic"}}), flush=True)


if __name__ == "__main__":
    main()
