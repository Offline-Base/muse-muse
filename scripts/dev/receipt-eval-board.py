#!/usr/bin/env python3
"""
Answers the held-out receipts on a board, with and without a trained adapter, in train.py's venv:

  ~/train/venv/bin/python receipt-eval-board.py --model ~/train/models/Llama-3.2-1B-Instruct --adapter <run dir> \
      --heldout heldout.jsonl --out answers.jsonl

One model load, the adapter switched off for the base answers, greedy decoding, and the prompt rendered the way train.py
renders it, so the only difference between the two passes is the adapter. Score the result on a laptop with
`receipt-bench.py score`. Invented data only.
"""
import argparse
import json
import os
import time

os.environ.setdefault("PYTORCH_ALLOC_CONF", "expandable_segments:True")

# The same instruction the training rows carry (receipt-bench.py SYSTEM).
SYSTEM = (
    "You read receipts. Answer with one JSON object and nothing else, with exactly these keys: merchant (string), "
    "date (YYYY-MM-DD), subtotal (number), tax (number), total (number), item_count (integer, the number of purchased lines)."
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--heldout", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-new-tokens", type=int, default=120)
    options = parser.parse_args()

    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(options.model)
    model = AutoModelForCausalLM.from_pretrained(options.model, dtype=torch.bfloat16).to("cuda")
    model = PeftModel.from_pretrained(model, options.adapter).eval()
    with open(options.heldout, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]

    with open(options.out, "w", encoding="utf-8") as out:
        for which in ("base", "tuned"):
            for row in rows:
                messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": row["text"]}]
                prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
                ids = tokenizer(prompt, add_special_tokens=False, return_tensors="pt").input_ids.to("cuda")
                start = time.time()
                with torch.no_grad():
                    if which == "base":
                        with model.disable_adapter():
                            got = model.generate(ids, max_new_tokens=options.max_new_tokens, do_sample=False, pad_token_id=tokenizer.eos_token_id)
                    else:
                        got = model.generate(ids, max_new_tokens=options.max_new_tokens, do_sample=False, pad_token_id=tokenizer.eos_token_id)
                new = got[0, ids.shape[1]:]
                seconds = time.time() - start
                text = tokenizer.decode(new, skip_special_tokens=True)
                out.write(json.dumps({"id": row["id"], "which": which, "raw": text, "seconds": round(seconds, 2), "completion_tokens": int(new.shape[0])}) + "\n")
                out.flush()
                print(which, row["id"], round(seconds, 1), flush=True)
    print("peak_gpu_gib", round(torch.cuda.max_memory_reserved() / 2**30, 2), flush=True)


if __name__ == "__main__":
    main()
