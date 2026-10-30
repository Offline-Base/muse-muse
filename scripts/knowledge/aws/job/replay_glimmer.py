"""Replay data for the knowledge fine-tune (docs/KNOWLEDGE_UPDATE.md, Training methods): base Glimmer answers general prompts
before training, and those answers go into the training set so the tuned model keeps what it already does well.

Prompts are Databricks Dolly 15k (CC BY-SA 3.0), without the ones that depend on the date, whose old answers would teach
stale facts. Answers cut off by the token limit are dropped. Runs on the same plain GPU machine as train_glimmer.py and
appends to the output, so a restart carries on.

    python replay_glimmer.py dolly.jsonl replay.jsonl [count]
"""

import json
import os
import random
import re
import sys
import time

from train_glimmer import FINAL_CHANNEL, FINAL_ENDS, GENERATION_PROMPT, MAX_SEQ_LENGTH, MODEL, MODEL_REVISION, REASONING, SYSTEM, final_answer, say

BATCH = 96
MAX_NEW_TOKENS = 320
# Anything whose right answer may have changed since the model's cutoff, or that has no answer without its context.
DATED = re.compile(r"\b(current|currently|latest|recent|recently|today|now|this year|last year|newest|president|prime minister|ceo|champion|winner|won|20[12]\d|how many|population|who is the|richest|tallest|largest|best)\b", re.I)


def prompts(path, count):
    rows = []
    with open(path) as f:
        for line in f:
            row = json.loads(line)
            # Dolly's context-bound tasks need the passage they came with, so they stay out.
            if not row.get("context", "").strip() and not DATED.search(row["instruction"]) and row["category"] in ("open_qa", "general_qa", "brainstorming", "creative_writing", "classification"):
                rows.append(row["instruction"].strip())
    random.Random(7).shuffle(rows)
    return rows[:count]


def main():
    source, out = sys.argv[1], sys.argv[2]
    count = int(sys.argv[3]) if len(sys.argv) > 3 else 15000
    from unsloth import FastModel
    import torch

    items = prompts(source, count)
    done = set()
    if os.path.exists(out):
        with open(out) as f:
            done = {json.loads(line)["prompt"] for line in f}
    items = [p for p in items if p not in done]
    say("replay_start", todo=len(items), done=len(done))
    model, tokenizer = FastModel.from_pretrained(model_name=MODEL, revision=MODEL_REVISION, max_seq_length=MAX_SEQ_LENGTH)
    FastModel.for_inference(model)
    text_tokenizer = getattr(tokenizer, "tokenizer", tokenizer)
    text_tokenizer.padding_side = "left"
    if text_tokenizer.pad_token is None:
        text_tokenizer.pad_token = text_tokenizer.eos_token
    bos = getattr(tokenizer, "bos_token", None) or getattr(text_tokenizer, "bos_token", None) or ""

    def render(question):
        text = tokenizer.apply_chat_template([{"role": "system", "content": SYSTEM}, {"role": "user", "content": question}], tokenize=False, add_generation_prompt=True, reasoning_strength=REASONING)
        text = text.removeprefix(bos) if bos else text
        if not text.endswith(GENERATION_PROMPT):
            raise RuntimeError("Generation prompt doesn't end with " + GENERATION_PROMPT)
        return text + FINAL_CHANNEL

    began, kept, seen = time.time(), 0, 0
    with open(out, "a") as f:
        for start in range(0, len(items), BATCH):
            batch = items[start:start + BATCH]
            enc = text_tokenizer([render(p) for p in batch], return_tensors="pt", padding=True)
            with torch.no_grad():
                generated = model.generate(
                    input_ids=enc["input_ids"].to("cuda"), attention_mask=enc["attention_mask"].to("cuda"),
                    max_new_tokens=MAX_NEW_TOKENS, do_sample=False, pad_token_id=text_tokenizer.pad_token_id,
                )
            width = enc["input_ids"].shape[1]
            for prompt, row in zip(batch, generated):
                raw = text_tokenizer.decode(row[width:], skip_special_tokens=False)
                seen += 1
                if not any(end in raw for end in FINAL_ENDS):
                    continue
                answer = final_answer(raw)
                if answer:
                    f.write(json.dumps({"prompt": prompt, "answer": answer, "source": "dolly-15k", "license": "CC BY-SA 3.0"}, ensure_ascii=False) + "\n")
                    kept += 1
            f.flush()
            say("replay", seen=seen, kept=kept, of=len(items), seconds=round(time.time() - began))
    say("replay_done", seen=seen, kept=kept)


if __name__ == "__main__":
    main()
