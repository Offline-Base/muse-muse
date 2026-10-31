"""Does an adapter still write Glimmer's channels? For the BF16 model with an adapter on one GPU under transformers, with
reasoning on and no prefill (every earlier knowledge score prefills the final channel, which is why the damage went unseen).

It reports:
- how sure the model is of its control tokens: P("=self") after " to" on 60 items (header_probs.py's, which gave 0.21 for
  stage 1 Q4_K_M and 0.99999 for base), then, with the model's own reasoning teacher-forced under the right header on up to 40
  items, P(<|eom|>) and P(<|eot|>) closing it, P("assistant") after <|start|>, and P("=user") after the second " to";
- the 260 reasoning_probes.jsonl items and the 40 reasoning-off ones, as score_reasoning.py runs them with llama-server: same
  prompts, greedy, 2,048 new tokens, <|eom|> not an end token. Splitting and grading are score_reasoning.reply_row, not a copy,
  and the JSON has its row shape, so `score_reasoning.py --table BASE.json THIS.json` works on it, beside GGUF runs.

Batches: replies vary from 30 to 2,048 tokens, and a plain generate() would run every batch to its longest. So each batch runs
in chunks of 32 steps through generate(), keeping its cache, and drops the finished rows between chunks. Greedy output is then
the same as one long generate(); test_glimmer_labels.py checks that on a tiny Muse Glimmer. At the start 8 prompts of different
lengths are also answered one at a time for 48 tokens. If 2 or more differ from the batched answers, padding is changing the
model's answers and the run goes on one at a time (slow; the time limit will cut it short, and the JSON says so).

Time (an estimate; this has not run on a GPU): one A100 80GB gives at most about 180 tokens a second with an unmerged LoRA (stage
2: about 5 steps a second at batch 32), and less as batches shrink. Base's 300 replies are 112,812 tokens, stage 1's 76,368, so
about 10 to 15 minutes of generating plus 3 or 4 of loading and measuring. --minutes (15, counted from the start, 0 for none)
starts no new chunk after it: replies still going are left out and the JSON says complete: false. Order is the short
reasoning-off pass, multi-step, skills, then the hard set, so a cut loses the hard set first. That's fine for a pilot; the
well-formed gate counts all 260, so a final model's run takes --minutes 0, about 20 minutes.

Usage (model from KNOWLEDGE_MODEL and KNOWLEDGE_4BIT, as train_glimmer.py; --adapter none is the base model):
  CUDA_VISIBLE_DEVICES is set from --gpu; UNSLOTH_RETURN_LOGITS=1 is set here, for the forward pass that reads the probabilities.
  python check_channels_bf16.py --adapter DIR --label NAME --out FILE.json --tokenizer BASE_DIR --allow-code-exec [--gpu 0]
      [--strength medium] [--batch 32] [--minutes 15] [--limit N]
  python check_channels_bf16.py --gates FILE.json --base BASE.json [--vision VISION.json] [--header HEADER.json]
      prints each gate that FILE can answer (a run of this script, or of score_reasoning.py, with header_probs.py's output
      as --header and score_reasoning.py --vision-only's as --vision), and exits 1 if one fails.
"""

import argparse
import json
import os
import random
import re
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from score_reasoning import ENDS_TEXT, chat_counts, gpu_mem_used_mib, prompt_ids, reply_row, summarize  # noqa: E402

# llama.cpp's end tokens for this model. <|eom|> only ends a message, so one request carries both channels.
STOP_TOKENS = ("<|eot|>", "<|end_of_text|>")
PAD_TOKEN = "<|finetune_right_pad|>"
CHUNK = 32
HEADER_ITEMS = 60
WALK_ITEMS = 40
WALK_MAX_TOKENS = 400
PART_ORDER = {"multistep": 0, "skills": 1, "hard": 2}
# The final model's gates (the Stage B plan). Probes and honesty come from compare_stage_b.py and score_honesty_bf16.py.
GATE_P_SELF = 0.99
GATE_WELL_FORMED = 247
GATE_MULTISTEP_SLACK = 3
GATE_OFF = 35
GATE_VISION = 5


def stop_ids(tok):
    return [tok.convert_tokens_to_ids(t) for t in STOP_TOKENS]


def pad_id(tok):
    return tok.pad_token_id if tok.pad_token_id is not None else tok.convert_tokens_to_ids(PAD_TOKEN)


def left_padded(torch, prompts, pad, device):
    width = max(len(p) for p in prompts)
    ids = torch.tensor([[pad] * (width - len(p)) + list(p) for p in prompts], device=device)
    mask = torch.tensor([[0] * (width - len(p)) + [1] * len(p) for p in prompts], device=device)
    return ids, mask


def run_batch(model, torch, prompts, pad, stops, max_new_tokens, chunk, deadline, device):
    """(generated ids with the end token, "eos" or "limit") per prompt; None for one still going at the deadline."""
    ids, mask = left_padded(torch, prompts, pad, device)
    stop_set = set(stops)
    rows = list(range(len(prompts)))
    got = [[] for _ in prompts]
    results = [None] * len(prompts)
    cache, left = None, max_new_tokens
    while rows and left > 0:
        if time.time() > deadline:
            return results
        out = model.generate(input_ids=ids, attention_mask=mask, past_key_values=cache, max_new_tokens=min(chunk, left), do_sample=False,
                             pad_token_id=pad, eos_token_id=list(stops), use_cache=True, return_dict_in_generate=True)
        new = out.sequences[:, ids.shape[1]:]
        left -= new.shape[1]
        keep = []
        for pos, row in enumerate(rows):
            toks = new[pos].tolist()
            end = next((k for k, t in enumerate(toks) if t in stop_set), None)
            got[row] += toks if end is None else toks[:end + 1]
            if end is None:
                keep.append(pos)
            else:
                results[row] = (got[row], "eos")
        rows = [rows[p] for p in keep]
        if not rows or left <= 0:
            break
        index = torch.tensor(keep, device=device)
        grown = torch.cat([mask, torch.ones((mask.shape[0], new.shape[1]), dtype=mask.dtype, device=device)], dim=1)
        ids, mask = out.sequences[index], grown[index]
        # The last generated token isn't in the cache yet; generate() feeds what the cache lacks.
        cache = out.past_key_values
        if len(keep) < new.shape[0]:
            cache.batch_select_indices(index)
    for row in rows:
        results[row] = (got[row], "limit")
    return results


def greedy_tokens(model, torch, tok, prompts, max_new_tokens, batch, deadline=float("inf"), chunk=CHUNK, on_done=None, device="cuda", log=print):
    """Greedy replies to token-id prompts, in order: (generated ids, stop) or None past the deadline. Out of GPU memory, the
    batch is halved and run again. on_done(index, reply) sees each as it finishes."""
    pad, stops = pad_id(tok), stop_ids(tok)
    results = [None] * len(prompts)

    def run(indices, size):
        for start in range(0, len(indices), size):
            part = indices[start:start + size]
            if time.time() > deadline:
                return
            try:
                with torch.no_grad():
                    replies = run_batch(model, torch, [prompts[i] for i in part], pad, stops, max_new_tokens, chunk, deadline, device)
            except torch.cuda.OutOfMemoryError:
                if len(part) == 1:
                    raise
                torch.cuda.empty_cache()
                log(f"CHANNELS out of memory at batch {len(part)}; halving")
                run(part, max(1, len(part) // 2))
                continue
            for i, reply in zip(part, replies):
                results[i] = reply
                if reply is not None and on_done:
                    on_done(i, reply)

    run(list(range(len(prompts))), batch)
    return results


def batch_check(model, torch, tok, prompts, device="cuda", new_tokens=48):
    """The same prompts, batched with left padding and one at a time, for new_tokens: how many replies agree."""
    prompts = sorted(prompts, key=len)
    together = greedy_tokens(model, torch, tok, prompts, new_tokens, len(prompts), device=device)
    alone = [greedy_tokens(model, torch, tok, [p], new_tokens, 1, device=device)[0] for p in prompts]
    same = sum(a[0] == b[0] for a, b in zip(together, alone))
    return {"n": len(prompts), "same": same, "lengths": [len(p) for p in prompts], "new_tokens": new_tokens}


def next_token_probs(model, torch, tok, prompts, wanted, batch, device="cuda"):
    """P(next token) for each prompt, read from generate()'s own logits, the path answers take. wanted: name -> token id.
    Returns name -> list of probabilities, and the mean top tokens."""
    pad, stops = pad_id(tok), stop_ids(tok)
    out = {name: [] for name in wanted}
    mean = None
    for start in range(0, len(prompts), batch):
        ids, mask = left_padded(torch, prompts[start:start + batch], pad, device)
        with torch.no_grad():
            r = model.generate(input_ids=ids, attention_mask=mask, max_new_tokens=1, do_sample=False, pad_token_id=pad, eos_token_id=list(stops),
                               output_logits=True, return_dict_in_generate=True)
        probs = torch.softmax(r.logits[0].float(), dim=-1)
        for name, token in wanted.items():
            out[name] += probs[:, token].tolist()
        total = probs.sum(dim=0)
        mean = total if mean is None else mean + total
    values, tokens = (mean / len(prompts)).topk(5)
    return out, [[tok.decode([t]), round(v, 6)] for t, v in zip(tokens.tolist(), values.tolist())]


def own_reasoning(raw):
    """The text of a reply's first message, whatever its header said, or None if it never closes."""
    body = raw.split("<|message|>", 1)[1] if "<|message|>" in raw else raw
    cuts = [body.find(e) for e in ENDS_TEXT + ("<|start|>",) if e in body]
    return body[:min(cuts)] if cuts else None


def walk_probs(model, torch, tok, items, reasonings, strength, batch, device="cuda"):
    """Teacher-forced through one correct reply: prompt, right header, the model's own reasoning, then the control tokens. One
    forward pass per batch, reading the last columns (left padding lines them up)."""
    enc = lambda s: tok(s, add_special_tokens=False)["input_ids"]
    head, tail = enc(" to=self<|message|>"), enc("<|eom|><|start|>assistant to=user<|message|>")
    keep = len(tail) + 1
    names = {"<|eom|>": "p_eom", "<|start|>": "p_start", "assistant": "p_assistant", " to": "p_to_second", "=user": "p_user", "<|message|>": "p_message"}
    eot = tok.convert_tokens_to_ids("<|eot|>")
    prompts = [prompt_ids(tok, it, "on", strength) + head + enc(text)[:WALK_MAX_TOKENS] + tail for it, text in zip(items, reasonings)]
    prompts.sort(key=len)
    out = {v: [] for v in names.values()}
    out["p_eot"] = []
    pad = pad_id(tok)
    for start in range(0, len(prompts), batch):
        ids, mask = left_padded(torch, prompts[start:start + batch], pad, device)
        positions = (mask.cumsum(-1) - 1).clamp(min=0)
        with torch.no_grad():
            logits = model(input_ids=ids, attention_mask=mask, position_ids=positions, use_cache=False, logits_to_keep=keep).logits
        if logits.shape[1] != keep:
            raise RuntimeError(f"the forward pass kept {logits.shape[1]} columns, not {keep}")
        probs = torch.softmax(logits[:, :-1].float(), dim=-1)
        for col, token in enumerate(tail):
            out[names[tok.decode([token])]] += probs[:, col, token].tolist()
        out["p_eot"] += probs[:, 0, eot].tolist()
    return out


def mean(xs):
    return round(statistics.mean(xs), 6) if xs else None


def free_run_counts(rows):
    """What the replies themselves did at the same places."""
    on = [r for r in rows if r["mode"] == "on"]
    closes = {"<|eom|>": 0, "<|eot|>": 0, "<|end_of_text|>": 0, "none": 0}
    starts, assistant = 0, 0
    for r in on:
        first = min(((r["raw"].find(e), e) for e in ENDS_TEXT if e in r["raw"]), default=(0, "none"))
        closes[first[1]] += 1
        for after in re.findall(r"<\|start\|>(.{0,9})", r["raw"], re.S):
            starts += 1
            assistant += after.startswith("assistant")
    return {"first_close": closes, "after_start": starts, "after_start_assistant": assistant}


def main_run(a):
    began = time.time()
    # Set before torch: answers run on this card alone, and Unsloth's patched forward returns logits only when asked.
    os.environ["CUDA_VISIBLE_DEVICES"] = str(a.gpu)
    os.environ["UNSLOTH_RETURN_LOGITS"] = "1"
    from measure_known import Answerer
    from transformers import AutoTokenizer
    deadline = began + a.minutes * 60 if a.minutes else float("inf")
    tok = AutoTokenizer.from_pretrained(a.tokenizer)
    answerer = Answerer(None if a.adapter == "none" else a.adapter)
    load_seconds = round(time.time() - began, 1)
    print(f"CHANNELS {a.label}: model loaded in {load_seconds}s", flush=True)
    torch, model, device = answerer.torch, answerer.model, answerer.device
    with open(a.probes) as f:
        probes = [json.loads(line) for line in f if line.strip()]
    order = probes[:]
    # The same order as score_reasoning.py, so a run cut short still pairs with the others by id.
    random.Random(7).shuffle(order)
    if a.limit:
        order = order[: a.limit]
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)

    enc = lambda s: tok(s, add_special_tokens=False)["input_ids"]
    token_to, token_self, token_user = enc(" to")[0], enc("=self")[0], enc("=user")[0]
    plain = [it for it in order if not it.get("turns")][:HEADER_ITEMS]
    first = [prompt_ids(tok, it, "on", a.strength) for it in plain]
    t0 = time.time()
    p_first, top_first = next_token_probs(model, torch, tok, first, {"p_to": token_to}, a.batch, device)
    p_after, top_after = next_token_probs(model, torch, tok, [p + [token_to] for p in first], {"p_self": token_self, "p_user_first": token_user}, a.batch, device)
    channel = {"strength": a.strength, "n_header": len(first), "p_to": mean(p_first["p_to"]), "p_self": mean(p_after["p_self"]), "p_self_min": round(min(p_after["p_self"]), 6) if first else None,
               "p_user_first": mean(p_after["p_user_first"]), "top_after_prompt": top_first, "top_after_to": top_after, "header_seconds": round(time.time() - t0, 1)}
    print("CHANNELS header " + json.dumps(channel, ensure_ascii=False), flush=True)
    with open(a.out + ".channel.json", "w") as f:
        json.dump(channel, f, ensure_ascii=False, indent=1)

    jobs = [(it, "off") for it in order if it.get("also_off")] + sorted(((it, "on") for it in order), key=lambda j: PART_ORDER.get(j[0]["part"], 3))
    prompts = [prompt_ids(tok, it, mode, a.strength) for it, mode in jobs]
    check = batch_check(model, torch, tok, prompts[:: max(1, len(prompts) // 8)][:8], device)
    print("CHANNELS batch check " + json.dumps(check), flush=True)
    batch = a.batch if check["n"] - check["same"] < 2 else 1
    if batch != a.batch:
        print(f"CHANNELS {check['n'] - check['same']} of {check['n']} replies changed under padding; going on one at a time", flush=True)

    t0 = time.time()
    done, generated = [0], [0]
    partial = open(a.out + ".partial.jsonl", "w")
    rows = [None] * len(jobs)

    def finished(i, reply):
        toks, stop = reply
        it, mode = jobs[i]
        rows[i] = reply_row(it, mode, prompts[i], toks, toks, stop, tok, a.allow_code_exec)
        done[0] += 1
        generated[0] += len(toks)
        partial.write(json.dumps(rows[i], ensure_ascii=False) + "\n")
        partial.flush()
        if done[0] % 25 == 0:
            print(f"CHANNELS {a.label} {done[0]}/{len(jobs)} {round(generated[0] / max(time.time() - t0, 1e-9), 1)} tok/s, {round(time.time() - began)} s so far", flush=True)

    greedy_tokens(model, torch, tok, prompts, a.max_new_tokens, batch, deadline=deadline, on_done=finished, device=device, log=lambda m: print(m, flush=True))
    wall = time.time() - t0
    kept = [r for r in rows if r]

    channel["free_run"] = free_run_counts(kept)
    try:
        chosen = []
        for (it, mode), r in zip(jobs, rows):
            text = own_reasoning(r["raw"]) if r and mode == "on" and not it.get("turns") else None
            if text and text.strip() and len(chosen) < WALK_ITEMS:
                chosen.append((it, text))
        t1 = time.time()
        walked = walk_probs(model, torch, tok, [c[0] for c in chosen], [c[1] for c in chosen], a.strength, a.batch // 2 or 1, device)
        channel.update({k: mean(v) for k, v in walked.items()})
        channel.update({"n_walk": len(chosen), "walk_seconds": round(time.time() - t1, 1)})
    except Exception as e:  # the replies matter more than this reading; a failure here must not lose them
        channel["walk_error"] = repr(e)[:400]
    print("CHANNELS channel " + json.dumps(channel, ensure_ascii=False), flush=True)

    out = {"label": a.label, "gguf": None, "adapter": a.adapter, "strength": a.strength, "prefill_reasoning": False, "probes": os.path.abspath(a.probes), "max_new_tokens": a.max_new_tokens, "parallel": batch,
           "complete": len(kept) == len(jobs), "n_requests": len(jobs), "n_skipped": len(jobs) - len(kept), "aggregate_tokens_per_second": round(generated[0] / max(wall, 1e-9), 1),
           "generated_tokens": generated[0], "score_seconds": round(wall, 1), "server_load_seconds": load_seconds, "gpu_mem_used_mib": gpu_mem_used_mib(), "seconds_total": round(time.time() - began, 1),
           "channel": channel, "batch_check": check, "chat_endpoint": chat_counts(kept), "summary": summarize(kept), "rows": kept}
    with open(a.out + ".tmp", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(a.out + ".tmp", a.out)
    s = out["summary"]
    print("CHANNELS " + json.dumps({"label": a.label, "complete": out["complete"], "seconds_total": out["seconds_total"], "p_self": channel["p_self"], "well_formed": s["lenient"]["shapes"].get("well formed: to=self, then to=user", 0),
                                    "n": s["structure"]["n"], "multistep": s["multistep"]["right"], "chat_endpoint": out["chat_endpoint"], "off": s["off40"]["off"]["right"]}), flush=True)


def gate_lines(run, base, vision=None, header=None):
    """(name, value, what it needs, True/False/None). None: this file can't answer it."""
    s, b = summarize(run["rows"]), summarize(base["rows"])
    well = s["lenient"]["shapes"].get("well formed: to=self, then to=user", 0)
    on = s["structure"]["n"]
    p_self = (run.get("channel") or {}).get("p_self")
    if p_self is None and header:
        p_self = next((p for t, p in header.get("after_to", []) if t == "=self"), None)
    lines = [('P("=self") after " to"', p_self, f"at least {GATE_P_SELF}", None if p_self is None else p_self >= GATE_P_SELF),
             ("well formed", f"{well}/{on}", f"at least {GATE_WELL_FORMED}/260", None if on != 260 else well >= GATE_WELL_FORMED),
             ("multi-step, strict", f"{s['multistep']['right']}/{s['multistep']['n']}", f"within {GATE_MULTISTEP_SLACK} of base's {b['multistep']['right']}/{b['multistep']['n']}",
              None if s["multistep"]["n"] != b["multistep"]["n"] else s["multistep"]["right"] >= b["multistep"]["right"] - GATE_MULTISTEP_SLACK),
             ("the 40, reasoning off", f"{s['off40']['off']['right']}/{s['off40']['off']['n']}", f"at least {GATE_OFF}/40", None if s["off40"]["off"]["n"] != 40 else s["off40"]["off"]["right"] >= GATE_OFF)]
    chat = chat_counts(run["rows"])
    lines.append(("multi-step right and chat endpoint would accept (shape only; vision below calls it)", f"{chat['multistep_right']}/{chat['multistep_n']}", "no separate gate", None))
    v = (vision or {}).get("vision")
    lines.append(("chat endpoint on vision", f"{v['chat_ok']}/{v['n']}" if v else "not run", f"{GATE_VISION}/5, from score_reasoning.py --vision-only on the GGUF", (v["chat_ok"] == GATE_VISION) if v else None))
    lines.append(("probes and honesty", "not in this file", "compare_stage_b.py and score_honesty_bf16.py", None))
    return lines


def main_gates(a):
    def load(path):
        with open(path) as f:
            return json.load(f)
    lines = gate_lines(load(a.gates), load(a.base), load(a.vision) if a.vision else None, load(a.header) if a.header else None)
    failed = False
    for name, value, need, ok in lines:
        print(f"{'NOT MEASURED' if ok is None else 'PASS' if ok else 'FAIL':12} {name}: {value} (needs {need})")
        failed |= ok is False
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter")
    ap.add_argument("--label")
    ap.add_argument("--out")
    ap.add_argument("--tokenizer")
    ap.add_argument("--probes", default=os.path.join(HERE, "reasoning_probes.jsonl"))
    ap.add_argument("--strength", default="medium")
    ap.add_argument("--gpu", type=int, default=0)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--minutes", type=float, default=15)
    ap.add_argument("--limit", type=int, default=0, help="only the first N items after shuffling, to look at replies first")
    ap.add_argument("--max-new-tokens", type=int, default=2048)
    ap.add_argument("--allow-code-exec", action="store_true")
    ap.add_argument("--gates")
    ap.add_argument("--base")
    ap.add_argument("--vision")
    ap.add_argument("--header")
    a = ap.parse_args()
    if a.gates:
        if not a.base:
            ap.error("--gates needs --base")
        main_gates(a)
    else:
        missing = [n for n in ("adapter", "label", "out", "tokenizer") if not getattr(a, n)]
        if missing:
            ap.error("a run needs " + ", ".join("--" + m for m in missing))
        main_run(a)
