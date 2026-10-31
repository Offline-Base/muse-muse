"""Stage B's measurement (docs/KNOWLEDGE_UPDATE.md, "Re-measure what the model now knows"): a model with a given adapter
answers questions it never trained on, the way train_glimmer.py answers its probes, so its "right" means the same thing
as the probe scores. One process per GPU, no DDP; run_measure_known.sh starts them all.

The model path, prompt and generation are train_glimmer.py's: Unsloth's from_pretrained and get_peft_model with its
settings, load_adapter(), the base chat template with its system line and reasoning strength, the final channel
appended, greedy, at most 96 new tokens, batches of 32, final_answer() and answered(). Constants and helpers are
imported, not copied. The base weights come from the same environment (KNOWLEDGE_MODEL, KNOWLEDGE_4BIT).

Each shard appends to OUT.shard-I-of-N.jsonl and syncs after every batch, so a stop loses at most one batch; a restart
with the same arguments carries on from what's there, and refuses if the adapter or the question file changed.
--merge (no GPU) joins the shards into OUT, in question order, and exits 1 if a question is missing, unless
--allow-partial. A row holds the question's fields plus i (its line in the question file), reply, right, and ended
(false when the reply ran into the token limit).

Usage: python measure_known.py --adapter DIR --questions Q.jsonl --out OUT.jsonl --gpu 3 --shard 3 --shards 8
       python measure_known.py --merge --questions Q.jsonl --out OUT.jsonl --shards 8 [--allow-partial]
Speed: 40,000 questions took 31 minutes on eight A100 80GB (Oct 31, loading included).
"""

import argparse
import hashlib
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_glimmer import (FINAL_CHANNEL, FINAL_ENDS, GEN_BATCH, GENERATION_PROMPT, GRAD_CKPT, LOAD_IN_4BIT,  # noqa: E402
                           MAX_NEW_TOKENS, MAX_SEQ_LENGTH, MODEL, MODEL_REVISION, REASONING, SYSTEM, answered, final_answer,
                           load_adapter, read_jsonl)

KEEP = ("question", "answer", "aliases", "passageId", "date", "url")


class Answerer:
    """The model as train_glimmer.py sets it up for answering. adapter=None keeps the fresh LoRA, whose output is the
    base model's, which is how train_glimmer.py answers "base"."""

    device = "cuda"

    def __init__(self, adapter):
        import torch  # after the caller has set CUDA_VISIBLE_DEVICES
        from unsloth import FastModel  # Unsloth patches transformers, so it comes before them.
        self.torch = torch
        rank = 64
        if adapter:
            with open(os.path.join(adapter, "adapter_config.json")) as f:
                rank = int(json.load(f)["r"])
        model, tokenizer = FastModel.from_pretrained(
            model_name=MODEL, revision=MODEL_REVISION, max_seq_length=MAX_SEQ_LENGTH, load_in_4bit=LOAD_IN_4BIT,
        )
        model = FastModel.get_peft_model(
            model, finetune_vision_layers=False, finetune_language_layers=True, finetune_attention_modules=True,
            finetune_mlp_modules=True, r=rank, lora_alpha=rank, lora_dropout=0, bias="none",
            use_gradient_checkpointing=GRAD_CKPT, random_state=3407,
        )
        if adapter:
            load_adapter(model, adapter, rank)
        self.model, self.tokenizer = model, tokenizer
        self.text_tokenizer = getattr(tokenizer, "tokenizer", tokenizer)
        self.bos = getattr(tokenizer, "bos_token", None) or getattr(self.text_tokenizer, "bos_token", None) or ""
        if hasattr(FastModel, "for_inference"):
            FastModel.for_inference(model)
        self.text_tokenizer.padding_side = "left"
        if self.text_tokenizer.pad_token is None:
            self.text_tokenizer.pad_token = self.text_tokenizer.eos_token

    def prompt(self, question):
        text = self.tokenizer.apply_chat_template([{"role": "system", "content": SYSTEM}, {"role": "user", "content": question}],
                                                  tokenize=False, add_generation_prompt=True, reasoning_strength=REASONING)
        text = text.removeprefix(self.bos) if self.bos else text
        if not text.endswith(GENERATION_PROMPT):
            raise RuntimeError("Generation prompt doesn't end with " + GENERATION_PROMPT)
        return text + FINAL_CHANNEL

    def ask(self, questions, max_new_tokens=MAX_NEW_TOKENS):
        """(raw decoded output, tokens generated) for each question, in order. Out of GPU memory, the batch is halved."""
        torch, tok = self.torch, self.text_tokenizer
        enc = tok([self.prompt(q) for q in questions], return_tensors="pt", padding=True)
        try:
            with torch.no_grad():
                out = self.model.generate(
                    input_ids=enc["input_ids"].to(self.device), attention_mask=enc["attention_mask"].to(self.device),
                    max_new_tokens=max_new_tokens, do_sample=False, pad_token_id=tok.pad_token_id,
                )
        except torch.cuda.OutOfMemoryError:
            if len(questions) == 1:
                raise
            torch.cuda.empty_cache()
            half = len(questions) // 2
            print(f"MEASURE out of memory at batch {len(questions)}; halving", flush=True)
            return self.ask(questions[:half], max_new_tokens) + self.ask(questions[half:], max_new_tokens)
        width = enc["input_ids"].shape[1]
        return [(tok.decode(row[width:], skip_special_tokens=False), int((row[width:] != tok.pad_token_id).sum())) for row in out]


def ended(raw):
    """The output reached an end token before the limit; final_answer() cuts at the same tokens."""
    return any(t in raw for t in FINAL_ENDS + ("<|start|>",))


def result(i, item, raw):
    reply = final_answer(raw)
    return {"i": i, **{k: item.get(k) for k in KEEP if k in item}, "reply": reply, "right": answered(reply, item), "ended": ended(raw)}


def shard_path(out, shard, shards):
    return f"{out}.shard-{shard}-of-{shards}.jsonl"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_done(path):
    """The finished rows of a shard file. A half-written last line (a stop mid-write) is dropped from the file, so the
    next append starts on a clean line."""
    if not os.path.exists(path):
        return {}
    rows = {}
    good = []
    with open(path) as f:
        for line in f:
            try:
                rows[json.loads(line)["i"]] = True
                good.append(line)
            except (ValueError, KeyError):
                pass
    with open(path + ".tmp", "w") as f:
        f.writelines(line if line.endswith("\n") else line + "\n" for line in good)
    os.replace(path + ".tmp", path)
    return rows


def check_meta(path, meta):
    """A shard restarted with another adapter or question file would mix two models' answers: stop instead."""
    if os.path.exists(path):
        with open(path) as f:
            old = json.load(f)
        changed = [k for k in ("adapter_sha256", "questions_sha256", "model", "revision", "max_new_tokens") if old.get(k) != meta.get(k)]
        if changed:
            raise SystemExit(f"{path} was written with a different {', '.join(changed)}; use another --out")
    with open(path + ".tmp", "w") as f:
        json.dump(meta, f, indent=1)
    os.replace(path + ".tmp", path)


def run_shard(questions, ask, path, shard, shards, batch, log=print):
    """Answers this shard's questions that aren't in `path` yet. ask(list of questions) gives (raw, tokens) pairs."""
    done = load_done(path)
    todo = [(i, q) for i, q in enumerate(questions) if i % shards == shard and i not in done]
    log(f"MEASURE shard {shard} of {shards}: {len(todo)} to do, {len(done)} already done")
    began, right = time.time(), 0
    with open(path, "a") as f:
        for start in range(0, len(todo), batch):
            chunk = todo[start:start + batch]
            replies = ask([q["question"] for _, q in chunk])
            rows = [result(i, q, raw) for (i, q), (raw, _) in zip(chunk, replies)]
            right += sum(r["right"] for r in rows)
            f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
            f.flush()
            os.fsync(f.fileno())
            finished = start + len(chunk)
            if (start // batch) % 10 == 0 or finished == len(todo):
                log(f"MEASURE shard {shard}: {finished} of {len(todo)}, {right} right, {finished / max(time.time() - began, 1e-9):.2f} questions/s")
    return len(todo)


def merge(questions, out, shards, allow_partial=False):
    rows, metas = {}, []
    for s in range(shards):
        path = shard_path(out, s, shards)
        if os.path.exists(path):
            for line in open(path):
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r["i"] % shards != s or r["i"] >= len(questions) or r["question"] != questions[r["i"]]["question"]:
                    raise SystemExit(f"{path}: row {r['i']} doesn't fit this question file and shard")
                rows[r["i"]] = r
        if os.path.exists(path + ".meta.json"):
            with open(path + ".meta.json") as f:
                metas.append(json.load(f))
    picks = ("adapter_sha256", "questions_sha256", "model", "revision", "max_new_tokens")
    if len({tuple(m.get(k) for k in picks) for m in metas}) > 1:
        raise SystemExit("the shards were written with different adapters, question files or settings")
    missing = len(questions) - len(rows)
    with open(out + ".tmp", "w") as f:
        f.writelines(json.dumps(rows[i], ensure_ascii=False) + "\n" for i in sorted(rows))
    os.replace(out + ".tmp", out)
    if metas:
        with open(out + ".meta.json", "w") as f:
            json.dump({k: v for k, v in metas[0].items() if k != "shard"}, f, indent=1)
    right = sum(r["right"] for r in rows.values())
    summary = {"questions": len(questions), "answered": len(rows), "missing": missing, "right": right,
               "accuracy": round(right / max(1, len(rows)), 4), "hit_token_limit": sum(not r["ended"] for r in rows.values())}
    print("MEASURE " + json.dumps(summary), flush=True)
    if missing and not allow_partial:
        raise SystemExit(f"{missing} questions have no answer yet; rerun the shards (they carry on) or pass --allow-partial")
    return summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter")
    ap.add_argument("--questions", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--gpu", type=int, default=0)
    ap.add_argument("--shard", type=int, default=0)
    ap.add_argument("--shards", type=int, default=1)
    ap.add_argument("--batch", type=int, default=GEN_BATCH)
    ap.add_argument("--merge", action="store_true")
    ap.add_argument("--allow-partial", action="store_true")
    a = ap.parse_args()
    questions = read_jsonl(a.questions)
    if a.merge:
        merge(questions, a.out, a.shards, a.allow_partial)
        return
    if not a.adapter or not 0 <= a.shard < a.shards:
        ap.error("answering needs --adapter and a --shard below --shards")
    os.environ["CUDA_VISIBLE_DEVICES"] = str(a.gpu)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    path = shard_path(a.out, a.shard, a.shards)
    check_meta(path + ".meta.json", {
        "adapter": a.adapter, "adapter_sha256": sha256_file(os.path.join(a.adapter, "adapter_model.safetensors")),
        "questions": a.questions, "questions_sha256": sha256_file(a.questions), "model": MODEL, "revision": MODEL_REVISION,
        "load_in_4bit": LOAD_IN_4BIT, "max_new_tokens": MAX_NEW_TOKENS, "batch": a.batch, "shard": a.shard, "shards": a.shards,
    })
    answerer = Answerer(a.adapter)
    print(f"MEASURE shard {a.shard} on GPU {a.gpu}: model and adapter loaded", flush=True)
    run_shard(questions, answerer.ask, path, a.shard, a.shards, a.batch, log=lambda m: print(m, flush=True))
    print(f"MEASURE shard {a.shard} done", flush=True)


if __name__ == "__main__":
    main()
