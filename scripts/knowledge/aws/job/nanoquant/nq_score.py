"""Scores a NanoQuant Glimmer (nq_glimmer.py) by greedy generation through NanoQuant's CUDA GEMV kernels in PyTorch,
on the same probes and prompts train_glimmer.py uses; or, with no --nq, the BF16 model in --base the same way.

- Prompts: train_glimmer.py's final-channel prompt (system line, user question, generation prompt at reasoning "low",
  then " to=user<|message|>"), left-padded batches of 32, greedy, 96 new tokens, its final_answer() cut and
  answered() / normalize() scoring (imported from train_glimmer.py, so the scoring can't drift).
- Probes: eval-probes.jsonl shuffled with random.Random(7) as train_glimmer.py does, first --n-probes of them; and all
  of forget.jsonl (the old-fact checks).
- Kernels: every NanoQuantLinear gets NanoQuant's _prepare_kernel("gemv", bfloat16), which packs its signs into the
  half2 bit layout of the binary_kernels GEMV op. Before that, logits for one prompt are taken through NanoQuant's
  PyTorch path and compared with the kernel path, as a check that the kernels compute the same model.
- --ppl: WikiText-2 perplexity with NanoQuant's own evaluate_ppl / get_test_loaders (2048-token windows, no BOS per
  window, as NanoQuant runs it for non-Gemma models).
- --bench: decode tokens per second at batch 1 (prefill excluded), eager PyTorch with a DynamicCache, 128 tokens.

    python nq_score.py --base BASE_OR_MERGED_DIR [--nq nq-text.safetensors] --probes eval-probes.jsonl \
        --forget forget.jsonl --n-probes 300 --out DIR [--ppl] [--bench]
"""

import argparse
import json
import os
import random
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nq_glimmer as nqg  # noqa: E402

GEN_BATCH = 32
MAX_NEW_TOKENS = 96


def say(event, **fields):
    nqg.say(event, **fields)


def read_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def scoring_functions(train_glimmer_dir):
    """answered() and final_answer() from train_glimmer.py itself (it only imports the standard library at the top)."""
    sys.path.insert(0, train_glimmer_dir)
    import train_glimmer as tg
    return tg.answered, tg.final_answer, tg.normalize


def load(a):
    began = time.time()
    model = nqg.load_bf16(a.base, a.layers, device_map="cpu")
    info = {"base": os.path.abspath(a.base), "nq": os.path.abspath(a.nq) if a.nq else None}
    if a.nq:
        if a.nq.endswith(".safetensors"):
            from safetensors.torch import load_file
            sd = load_file(a.nq)
        else:
            sd = torch.load(a.nq, map_location="cpu", weights_only=True)
        prefixes = nqg.install_quantized(model, sd)
        expected = len(nqg.decoder_layers(model)) * len(nqg.LINEARS)
        if len(prefixes) != expected:
            raise RuntimeError(f"{a.nq} holds {len(prefixes)} quantized linears, the model has {expected}")
        if a.nq.endswith(".pt"):
            # The full file also carries every other tensor; they must equal the BF16 model's.
            ref = model.state_dict()
            other = [k for k in sd if not k.endswith(nqg.NQ_SUFFIXES)]
            changed = [k for k in other if not torch.equal(sd[k], ref[k])]
            if changed:
                raise RuntimeError(f"{len(changed)} non-quantized tensors differ from {a.base}: {changed[:3]}")
            info["full_file_other_tensors_equal_base"] = len(other)
        info["quantized_linears"] = len(prefixes)
        info["bits"] = nqg.bits_report(model)
    model.to("cuda")
    model.eval()
    info["load_seconds"] = round(time.time() - began, 1)
    return model, info


@torch.no_grad()
def prepare_kernels(model, tok, info, dtype):
    mods = nqg.nq_modules(model)
    if not mods:
        return
    ids = tok(nqg.probe_prompt(tok, "Who won the 2026 FIFA World Cup?"), return_tensors="pt").input_ids.cuda()
    ref = model(input_ids=ids, use_cache=False).logits.float()
    began = time.time()
    for m in mods.values():
        # The kernel computes in `dtype`; NanoQuantLinear casts the BF16 activations in and the result back.
        m._prepare_kernel(kernel_type="gemv", dtype=dtype)
    torch.cuda.synchronize()
    out = model(input_ids=ids, use_cache=False).logits.float()
    diff = (out - ref).abs()
    info["kernel_check"] = {
        "kernel_dtype": str(dtype), "against": "NanoQuant's PyTorch path (unpacked signs, BF16 matmuls)",
        "prepare_seconds": round(time.time() - began, 1), "tokens": int(ids.shape[1]),
        "max_abs_logit_diff": float(diff.max()), "mean_abs_logit_diff": float(diff.mean()),
        "logit_abs_mean": float(ref.abs().mean()),
        "argmax_agreement": float((out.argmax(-1) == ref.argmax(-1)).float().mean()),
    }
    say("kernel_check", **info["kernel_check"])


@torch.no_grad()
def answer_all(model, tok, items, final_answer, answered, label):
    tok.padding_side = "left"
    prompts = [nqg.probe_prompt(tok, it["question"]) for it in items]
    replies, new_tokens = [], 0
    torch.cuda.synchronize()
    began = time.time()
    for s in range(0, len(prompts), GEN_BATCH):
        enc = tok(prompts[s:s + GEN_BATCH], return_tensors="pt", padding=True)
        out = model.generate(input_ids=enc["input_ids"].cuda(), attention_mask=enc["attention_mask"].cuda(),
                             max_new_tokens=MAX_NEW_TOKENS, do_sample=False, pad_token_id=tok.pad_token_id, use_cache=True)
        width = enc["input_ids"].shape[1]
        for row in out:
            gen = row[width:]
            new_tokens += int((gen != tok.pad_token_id).sum())
            replies.append(final_answer(tok.decode(gen, skip_special_tokens=False)))
        say("answering", model=label, done=len(replies), of=len(prompts))
    torch.cuda.synchronize()
    seconds = time.time() - began
    rows = [{"question": it["question"], "answer": it["answer"], "reply": r, "right": answered(r, it)} for it, r in zip(items, replies)]
    return rows, {"seconds": round(seconds, 1), "generated_tokens": new_tokens, "tokens_per_second_batch32": round(new_tokens / seconds, 1)}


@torch.no_grad()
def bench(model, tok, steps=128):
    from transformers import DynamicCache
    ids = tok(nqg.probe_prompt(tok, "Summarize what happened in world news in October 2026."), return_tensors="pt").input_ids.cuda()

    def run(n):
        cache = DynamicCache(config=model.config.text_config)
        out = model(input_ids=ids, past_key_values=cache, use_cache=True)
        nxt = out.logits[:, -1:].argmax(-1)
        torch.cuda.synchronize()
        t0 = time.time()
        for _ in range(n):
            out = model(input_ids=nxt, past_key_values=cache, use_cache=True)
            nxt = out.logits[:, -1:].argmax(-1)
        torch.cuda.synchronize()
        return time.time() - t0

    run(8)
    seconds = run(steps)
    return {"batch": 1, "prompt_tokens": int(ids.shape[1]), "decode_tokens": steps, "seconds": round(seconds, 3),
            "decode_tokens_per_second": round(steps / seconds, 2), "mode": "eager PyTorch, DynamicCache, greedy"}


@torch.no_grad()
def bench_static(model, tok, steps=128):
    """Decode speed with transformers' static cache, which compiles the decode step (CUDA graphs); the custom
    NanoQuant op has a Meta implementation, so it traces. Decode time = generate time minus one prefill."""
    ids = tok(nqg.probe_prompt(tok, "Summarize what happened in world news in October 2026."), return_tensors="pt").input_ids.cuda()
    kw = dict(do_sample=False, max_new_tokens=steps, min_new_tokens=steps, cache_implementation="static",
              pad_token_id=tok.pad_token_id, use_cache=True)
    t0 = time.time()
    model.generate(input_ids=ids, **kw)
    model.generate(input_ids=ids, **kw)
    warm = time.time() - t0
    torch.cuda.synchronize()
    t0 = time.time()
    model(input_ids=ids, use_cache=False)
    torch.cuda.synchronize()
    prefill = time.time() - t0
    t0 = time.time()
    model.generate(input_ids=ids, **kw)
    torch.cuda.synchronize()
    total = time.time() - t0
    return {"batch": 1, "prompt_tokens": int(ids.shape[1]), "decode_tokens": steps, "generate_seconds": round(total, 3),
            "prefill_seconds": round(prefill, 3), "warmup_seconds": round(warm, 1),
            "decode_tokens_per_second": round(steps / max(total - prefill, 1e-6), 2),
            "mode": "transformers generate, cache_implementation=static (compiled decode step), greedy"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="BF16 Glimmer folder (the base snapshot or the merged model)")
    ap.add_argument("--nq", default="", help="nq-text.safetensors or nq-full.pt; empty scores the BF16 model")
    ap.add_argument("--tokenizer", default="")
    ap.add_argument("--probes", required=True)
    ap.add_argument("--forget", required=True)
    ap.add_argument("--n-probes", type=int, default=300)
    ap.add_argument("--train-glimmer-dir", default=os.path.dirname(os.path.abspath(__file__)),
                    help="folder holding train_glimmer.py (nq_run.sh copies the repo's copy next to this file)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--label", default="")
    ap.add_argument("--ppl", action="store_true")
    ap.add_argument("--bench", action="store_true")
    ap.add_argument("--layers", type=int, default=0, help="a model cut to its first N text layers (tests)")
    ap.add_argument("--kernel-dtype", default="bfloat16", choices=["bfloat16", "float16"])
    ap.add_argument("--no-kernels", action="store_true", help="NanoQuant's PyTorch path instead of the CUDA kernels")
    ap.add_argument("--check-only", action="store_true", help="load, run the kernel check, write score.json, stop")
    ap.add_argument("--bench-static", action="store_true")
    a = ap.parse_args()
    # SDPA picks cuDNN attention on this H100 build, and cuDNN builds a new plan for every new key length: about
    # 150 ms of CPU per attention call while decoding with a growing cache. Flash / memory-efficient attention don't.
    torch.backends.cuda.enable_cudnn_sdp(False)
    os.makedirs(a.out, exist_ok=True)
    answered, final_answer, _ = scoring_functions(a.train_glimmer_dir)
    tok = nqg.load_tokenizer(a.tokenizer or a.base)
    model, info = load(a)
    if not a.no_kernels:
        prepare_kernels(model, tok, info, getattr(torch, a.kernel_dtype))
    info["gpu_memory_allocated_gb"] = round(torch.cuda.memory_allocated() / 1024 ** 3, 2)
    model.config.use_cache = True
    model.config.text_config.use_cache = True
    if a.check_only:
        with open(os.path.join(a.out, "score.json"), "w") as f:
            json.dump(info, f, indent=1)
        say("done", out=a.out, check_only=True)
        return

    probes = read_jsonl(a.probes)
    random.Random(7).shuffle(probes)
    probes = probes[: a.n_probes]
    forget = read_jsonl(a.forget)
    label = a.label or ("nq" if a.nq else "bf16")
    p_rows, p_time = answer_all(model, tok, probes, final_answer, answered, label + "/probes")
    f_rows, f_time = answer_all(model, tok, forget, final_answer, answered, label + "/forget")
    score = {
        "label": label, **info, "probes": len(p_rows), "forget_items": len(f_rows),
        "probe_accuracy": round(sum(r["right"] for r in p_rows) / max(1, len(p_rows)), 4),
        "forget_accuracy": round(sum(r["right"] for r in f_rows) / max(1, len(f_rows)), 4),
        "probe_right": sum(r["right"] for r in p_rows), "forget_right": sum(r["right"] for r in f_rows),
        "generation": {"probes": p_time, "forget": f_time}, "probe_file": os.path.abspath(a.probes),
        "probe_order": "random.Random(7).shuffle, first n", "max_new_tokens": MAX_NEW_TOKENS, "batch": GEN_BATCH,
        "kernels": ("NanoQuant PyTorch path (no kernels)" if a.no_kernels else
                    f"NanoQuant binary_kernels nanoquant_dyn_forward (GEMV), {a.kernel_dtype}") if a.nq else "BF16 PyTorch",
    }
    with open(os.path.join(a.out, "answers.json"), "w") as f:
        json.dump({"probes": p_rows, "forget": f_rows}, f, ensure_ascii=False, indent=1)
    say("scored", probe_accuracy=score["probe_accuracy"], forget_accuracy=score["forget_accuracy"])
    if a.bench:
        score["bench"] = bench(model, tok)
        say("bench", **score["bench"])
    if a.bench_static:
        try:
            score["bench_static"] = bench_static(model, tok)
            say("bench_static", **score["bench_static"])
        except Exception as e:  # compiled decoding is a nice-to-have; the eager number stands without it
            score["bench_static"] = {"error": f"{type(e).__name__}: {str(e)[:300]}"}
            say("bench_static_failed", error=score["bench_static"]["error"])
    if a.ppl:
        from nanoquant.utils.data_utils import get_test_loaders
        from nanoquant.utils.eval_utils import evaluate_ppl
        model.config.use_cache = False
        model.seqlen = 2048
        # evaluate_ppl reads model.config.max_position_embeddings (a text-config field on Glimmer) as a fallback.
        model.config.max_position_embeddings = model.config.text_config.max_position_embeddings
        began = time.time()
        _, testenc = get_test_loaders("wikitext2", seqlen=model.seqlen, model_name=a.tokenizer or a.base)
        ppl = evaluate_ppl(model, testenc, "cuda", "wikitext2", args=None, verbose=True)
        score["wikitext2_ppl"] = {"ppl": ppl, "seqlen": 2048, "tokens": int(getattr(testenc, "input_ids", testenc).numel()), "seconds": round(time.time() - began, 1),
                                  "evaluator": "nanoquant.utils.eval_utils.evaluate_ppl"}
        say("ppl", **score["wikitext2_ppl"])
    with open(os.path.join(a.out, "score.json"), "w") as f:
        json.dump(score, f, indent=1)
    say("done", out=a.out)


if __name__ == "__main__":
    main()
