"""Scores a LittleBit Glimmer (from glimmer_littlebit.py train) or, with --fp, the plain BF16 model for comparison.

NON-COMMERCIAL ONLY: it loads models made with SamsungLabs/LittleBit (CC BY-NC 4.0), imported from LITTLEBIT_DIR
(README.md next to this file).

1. Probes: greedy generation with train_glimmer.py's exact prompt (system line, user question, the generation prompt
   with low reasoning, then the final channel opened), its batch size, token limit, answer cut and scoring
   (answered(), normalize()), on the eval probes (shuffled with Random(7) and cut to --eval_probes, as there) and the
   forgetting checks.
2. WikiText-2 perplexity (test split, 2,048-token windows, as LittleBit's eval.py computes it, but with Glimmer's own
   BOS: LittleBit's loader sets bos/eos ids to 1 and 2, which suits Llama, not Glimmer).

Loading: the base folder's BF16 model (vision tower, embeddings, lm_head and all buffers), then its 416 language
projections become empty LittleBitLinear modules (littlebit_config.json), then LittleBit's own loader reads and unpacks
the saved state dict. Every LittleBit tensor must be filled and the rest must match the saved model, or it stops.

Usage: python eval_littlebit.py --model OUT/model --base GLIMMER_DIR --probes eval-probes.jsonl --forget forget.jsonl --out DIR
       python eval_littlebit.py --fp --base GLIMMER_DIR ...   (the BF16 reference)
"""

import argparse
import json
import math
import os
import random
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import glimmer_littlebit as gl  # noqa: E402


def load_littlebit(model_dir, base_dir):
    import torch
    gl.use_littlebit()
    from quantization.utils.quant_util import _load_and_process_state_dict
    with open(os.path.join(model_dir, "littlebit_config.json")) as f:
        q = json.load(f)
    model = gl.glimmer_class().from_pretrained(base_dir, dtype=torch.bfloat16, low_cpu_mem_usage=True)
    layers = model.model.language_model.layers
    for layer in layers:
        gl.patch_layer(layer, q, do_train=False)
    mods = gl.check_patch(model, len(layers))
    sd, packed = _load_and_process_state_dict(model_dir, torch.bfloat16)
    if not packed:
        raise RuntimeError(f"{model_dir} isn't in LittleBit's packed format")
    # Names from named_parameters/buffers, not state_dict(), which would try to pack the still-empty factors.
    names ={n for n, _ in model.named_parameters()} | {n for n, _ in model.named_buffers()}
    missing = sorted(n for n in names if n not in sd and not n.endswith("inv_freq") and "rotary" not in n)
    unexpected = sorted(k for k in sd if k not in names)
    if missing or unexpected:
        raise RuntimeError(f"state dict doesn't fit: missing {missing[:6]} ({len(missing)}), unexpected {unexpected[:6]} ({len(unexpected)})")
    model.load_state_dict(sd, strict=False, assign=True)
    for n, m in mods.items():
        m._binarized = True  # U and V are now +1/-1 already
        for p in m.parameters(recurse=False):
            if p.is_meta:
                raise RuntimeError(f"{n} is still empty after loading")
    for n, p in model.named_parameters():
        if p.is_meta:
            raise RuntimeError(f"{n} is still empty after loading")
    bits = gl.bits_report(model)  # before the cast, which rounds the FP32 bit-count buffers to BF16
    model.to(torch.bfloat16)
    return model, q, bits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", help="a LittleBit model folder (train's OUT/model)")
    ap.add_argument("--base", required=True, help="the BF16 Glimmer folder the LittleBit model was made from")
    ap.add_argument("--fp", action="store_true", help="score the BF16 base itself")
    ap.add_argument("--probes", required=True)
    ap.add_argument("--forget", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--eval_probes", type=int, default=1500)
    ap.add_argument("--ppl", default="wikitext2", help="comma list: wikitext2; empty to skip")
    ap.add_argument("--seqlen", type=int, default=2048)
    ap.add_argument("--ppl_windows", type=int, default=0, help="score only the first N windows (0 = all)")
    ap.add_argument("--skip_probes", action="store_true")
    a = ap.parse_args()

    import torch
    from transformers import AutoTokenizer
    # cuDNN's attention builds a graph for every new sequence length, which made greedy decoding about 50 times slower
    # on the H100 (measured: 17 new tokens for 32 prompts, 15.4 s with it, 0.27 s without).
    torch.backends.cuda.enable_cudnn_sdp(False)
    tg = gl.train_glimmer()
    os.makedirs(a.out, exist_ok=True)
    began = time.time()
    if a.fp:
        model = gl.glimmer_class().from_pretrained(a.base, dtype=torch.bfloat16, low_cpu_mem_usage=True)
        q, bits = None, None
    else:
        model, q, bits = load_littlebit(a.model, a.base)
    model.to("cuda").eval()
    load_seconds = round(time.time() - began, 1)
    tok = AutoTokenizer.from_pretrained(a.base)
    bos = tok.bos_token or ""
    print("LB_EVAL " + json.dumps({"event": "loaded", "seconds": load_seconds, "fp": a.fp, "quant": q, "bits": bits,
                                   "gpu_gb": round(torch.cuda.memory_allocated() / 1024 ** 3, 2)}), flush=True)

    def render(messages, generation):
        text = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=generation, reasoning_strength=tg.REASONING)
        return text.removeprefix(bos) if bos else text

    def answer_all(label, items):
        # train_glimmer.py's answer_all(), line for line: left padding, the final channel opened, greedy decoding.
        tok.padding_side = "left"
        if tok.pad_token is None:
            tok.pad_token = tok.eos_token
        prompts = []
        for it in items:
            text = render([{"role": "system", "content": tg.SYSTEM}, {"role": "user", "content": it["question"]}], True)
            if not text.endswith(tg.GENERATION_PROMPT):
                raise RuntimeError("Generation prompt doesn't end with " + tg.GENERATION_PROMPT)
            prompts.append(text + tg.FINAL_CHANNEL)
        replies = []
        for start in range(0, len(prompts), tg.GEN_BATCH):
            enc = tok(prompts[start:start + tg.GEN_BATCH], return_tensors="pt", padding=True)
            with torch.no_grad():
                out = model.generate(input_ids=enc["input_ids"].to("cuda"), attention_mask=enc["attention_mask"].to("cuda"),
                                     max_new_tokens=tg.MAX_NEW_TOKENS, do_sample=False, pad_token_id=tok.pad_token_id)
            width = enc["input_ids"].shape[1]
            replies += [tg.final_answer(tok.decode(row[width:], skip_special_tokens=False)) for row in out]
            if (start // tg.GEN_BATCH) % 10 == 0:
                print("LB_EVAL " + json.dumps({"event": "answering", "set": label, "done": len(replies), "of": len(prompts)}), flush=True)
        return [{"question": it["question"], "answer": it["answer"], "reply": r, "right": tg.answered(r, it)} for it, r in zip(items, replies)]

    def score(rows):
        return round(sum(r["right"] for r in rows) / max(1, len(rows)), 4)

    metrics = {"model": a.model, "base": a.base, "fp": a.fp, "quant": q, "bits": bits, "load_seconds": load_seconds,
               "gpu": torch.cuda.get_device_name(0)}
    if not a.skip_probes:
        probes = gl.read_jsonl(a.probes)
        random.Random(7).shuffle(probes)
        probes = probes[: a.eval_probes]
        forget = gl.read_jsonl(a.forget)
        t = time.time()
        answers = {"probes": answer_all("probes", probes), "forget": answer_all("forget", forget)}
        metrics.update({"probes": len(probes), "forget_items": len(forget), "probe_accuracy": score(answers["probes"]),
                        "forget_accuracy": score(answers["forget"]), "answer_seconds": round(time.time() - t, 1)})
        gl.write_json(os.path.join(a.out, "answers.json"), answers)

    for name in [x for x in a.ppl.split(",") if x]:
        if name != "wikitext2":
            raise SystemExit(f"unknown perplexity set {name}")
        from datasets import load_dataset
        test = load_dataset(gl.WIKITEXT, "wikitext-2-raw-v1", split="test")
        ids = tok("\n\n".join(test["text"]), return_tensors="pt").input_ids
        n = ids.numel() // a.seqlen
        if a.ppl_windows:
            n = min(n, a.ppl_windows)
        nll, t = 0.0, time.time()
        for i in range(n):
            batch = ids[:, i * a.seqlen:(i + 1) * a.seqlen].to("cuda")
            with torch.no_grad():
                logits = model(input_ids=batch, use_cache=False).logits
            loss = torch.nn.functional.cross_entropy(logits[0, :-1].float(), batch[0, 1:])
            nll += float(loss) * (a.seqlen - 1)
        ppl = math.exp(nll / (n * (a.seqlen - 1)))
        metrics[f"{name}_ppl"] = round(ppl, 4)
        metrics[f"{name}_windows"] = n
        metrics[f"{name}_seconds"] = round(time.time() - t, 1)
        print("LB_EVAL " + json.dumps({"event": "ppl", "set": name, "ppl": round(ppl, 4), "windows": n}), flush=True)

    metrics["peak_gpu_gb"] = round(torch.cuda.max_memory_allocated() / 1024 ** 3, 2)
    gl.write_json(os.path.join(a.out, "metrics.json"), metrics)
    print("LB_EVAL " + json.dumps({"event": "done", **{k: v for k, v in metrics.items() if k not in ("bits",)}}), flush=True)


if __name__ == "__main__":
    main()
