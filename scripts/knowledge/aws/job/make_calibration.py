"""Calibration text for llama-imatrix, built from our own stage 1 training data (never from the eval probes).

Examples are rendered in Glimmer's chat format exactly as train_glimmer.py renders training texts (the base chat
template, reasoning strength low, leading BOS removed, since llama-imatrix puts a BOS at the start of every chunk), and
joined into one text file. The mix is by tokens: facts (source:* Q&A), overviews (article:*, event:* and anchor:*
passages) and replay (general prompts with the model's own answers). Any example that contains an eval probe question
or an old-fact check question is dropped. llama-imatrix must run with --parse-special so the chat markers become
their special tokens.

Usage: python make_calibration.py --train train.jsonl --tokenizer BASE_DIR --probes eval-probes.jsonl
       --forget forget.jsonl --out calib.txt [--tokens 400000]
"""

import argparse
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_glimmer import REASONING, normalize  # noqa: E402  (same rendering and normalizing as training)

GROUPS = {"facts": ("source",), "overviews": ("article", "event", "anchor"), "replay": ("replay",)}
SHARES = {"facts": 0.40, "overviews": 0.35, "replay": 0.25}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument("--probes", required=True)
    ap.add_argument("--forget", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tokens", type=int, default=400000)
    ap.add_argument("--seed", type=int, default=11)
    a = ap.parse_args()

    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.tokenizer)
    bos = tok.bos_token or ""

    held_out = []
    for path in (a.probes, a.forget):
        with open(path) as f:
            held_out += [normalize(json.loads(line)["question"]).strip() for line in f if line.strip()]
    held_out = [q for q in held_out if len(q) >= 12]

    pools = {g: [] for g in GROUPS}
    with open(a.train) as f:
        for line in f:
            if not line.strip():
                continue
            row = json.loads(line)
            prefix = row.get("source", "").split(":", 1)[0]
            for g, prefixes in GROUPS.items():
                if prefix in prefixes:
                    pools[g].append(row)
    rng = random.Random(a.seed)
    chosen, stats, dropped = [], {}, 0
    for g, rows in pools.items():
        rng.shuffle(rows)
        quota, used, n = int(a.tokens * SHARES[g]), 0, 0
        for row in rows:
            if used >= quota:
                break
            text = tok.apply_chat_template(row["messages"], tokenize=False, add_generation_prompt=False, reasoning_strength=REASONING)
            text = text.removeprefix(bos) if bos else text
            flat = normalize(text)
            if any(q in flat for q in held_out):
                dropped += 1
                continue
            n_tok = len(tok(text, add_special_tokens=False)["input_ids"])
            chosen.append(text)
            used += n_tok
            n += 1
        stats[g] = {"examples": n, "tokens": used, "pool": len(rows)}
    rng.shuffle(chosen)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as f:
        f.write("\n".join(chosen))
    total = len(tok("\n".join(chosen), add_special_tokens=False)["input_ids"])
    report = {"out": a.out, "train": a.train, "seed": a.seed, "target_tokens": a.tokens, "tokens": total, "examples": len(chosen),
              "groups": stats, "dropped_for_holding_an_eval_question": dropped, "held_out_questions_checked": len(held_out)}
    with open(a.out + ".json", "w") as f:
        json.dump(report, f, indent=1)
    print("CALIB " + json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
