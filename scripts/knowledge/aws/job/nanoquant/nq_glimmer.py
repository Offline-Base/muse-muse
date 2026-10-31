"""Sub-1-bit NanoQuant quantization of Muse Glimmer 30B (the merged stage 1 knowledge model), docs/KNOWLEDGE_UPDATE.md.

NanoQuant (SamsungLabs/NanoQuant at a9e0a43, Apache 2.0, arXiv 2602.06694) is used as an installed tool in its own venv
(~/k/nq/venv, built by nq_setup.sh); none of its code is copied here. NanoQuant supports OPT, Llama, Qwen and Gemma. This
file is the Glimmer adaptation it lacks:

- Layers: MuseGlimmerForConditionalGeneration keeps its text decoder at model.model.language_model.layers (NanoQuant
  looks for model.model.layers) and its config's model_type is "muse_glimmer". NanoQuant's get_decoder_layers is
  extended for that model type, so its calculate_ranks works unchanged.
- What is quantized: the 8 linear projections of each of the 52 text decoder layers: self_attn q, k, v, o, Glimmer's
  attention output gate (self_attn.gate_proj), and mlp gate, up, down. The vision tower, vision adapter and projection,
  token embeddings, lm_head and every norm stay BF16 (NanoQuant also leaves embeddings and lm_head alone).
- Per-layer arguments: Glimmer alternates three sliding-window layers with one full-attention layer, and the
  full-attention layers are NoPE (layer_rope_theta 0: no rotary embedding). NanoQuant caches one set of layer-0
  arguments for all layers. Here each layer gets the mask of its own type and rotary embeddings only where it has
  them, built with the same helpers MuseGlimmerTextModel.forward uses (nq_selftest.py checks the chain against the
  model's own forward).
- Glimmer's decoder layers return a tensor, not a tuple. NanoQuant's tuning loops take [0] of a block's output; with
  their batch of 1 that drops the batch axis and the loss broadcasts to the same value, so their functions run as is.
- Calibration statistics: Glimmer's logits are 20 * tanh(output_multiplier * lm_head(h) / 20). NanoQuant's gradient
  statistics use cut-cross-entropy on raw lm_head logits; here that call gets lm_head * output_multiplier and
  softcap 20, so the statistics come from the model's real output distribution.
- Model-level distillation (NanoQuant's last step: scales only, forward KL to the BF16 model, AdamW, cosine schedule)
  is rewritten here so the BF16 teacher leaves the GPU once its logits are cached (in BF16, on CPU). NanoQuant's
  version keeps teacher and student on the GPU together, which a 30B model on one 96 GB H100 can't hold.
- Calibration text: our stage 1 training examples (never the eval probes), rendered with Glimmer's chat template
  exactly as train_glimmer.py renders them (reasoning "low"; the template's BOS is stripped and the tokenizer adds it),
  packed whole into rows of seqlen tokens that each start with BOS (no padding).

Everything else is NanoQuant's own: collect_stats / get_shrunk_stats / register_stats, calculate_ranks, tune_nonfact,
factorize_and_replace (the ADMM initialization), tune_fact, NanoQuantLinear, its bit packing and its CUDA kernels.

    python nq_glimmer.py quantize --model MERGED_DIR --out OUT_DIR --bits 0.8 --calib-jsonl train-stage1-frozen.jsonl \
        --calib-cache CALIB.pt --stats STATS.pt [--samples 128 --seqlen 2048 --nonfact-epochs 8 --fact-epochs 8
        --kd-epochs 8 --admm-iters 400 --layers N --resume]

Writes OUT_DIR/nq-full.pt (NanoQuant's packed state dict of the whole model), OUT_DIR/nq-text.safetensors (only the
quantized layers; everything else is bit-identical to the BF16 model, which the writer checks) and OUT_DIR/quant.json.
"""

import argparse
import json
import math
import os
import random
import re
import sys
import time

import torch
import torch.nn as nn
import torch.nn.functional as F

# NanoQuant's packages import each other in a cycle; nanoquant.modules must be imported first.
import nanoquant.modules  # noqa: F401
import nanoquant.utils.utils as nq_utils
from nanoquant.core import importance as nq_importance
from nanoquant.core.compress_block import factorize_and_replace, tune_fact, tune_nonfact
from nanoquant.kernel.utils import binary_unpacker
from nanoquant.modules.hub import NanoQuantConfigDataclass
from nanoquant.modules.linear import NanoQuantLinear
from nanoquant.optimi import AdamW as NQAdamW

# Same order as NanoQuant's Llama list (q, v, o, k, then the MLP), with Glimmer's attention output gate after k.
LINEARS = ["self_attn.q_proj", "self_attn.v_proj", "self_attn.o_proj", "self_attn.k_proj", "self_attn.gate_proj",
           "mlp.gate_proj", "mlp.up_proj", "mlp.down_proj"]
# train_glimmer.py's chat settings.
REASONING = "low"
SYSTEM = "You are a helpful assistant."
GENERATION_PROMPT = "<|start|>assistant"
FINAL_CHANNEL = " to=user<|message|>"
NQ_SUFFIXES = ("V_packed", "V_shape", "U_packed", "U_shape", "scale_pre", "scale_post", "scale_mid")


def say(event, **fields):
    print("NQ " + json.dumps({"event": event, "t": round(time.time(), 1), **fields}, ensure_ascii=False, default=str), flush=True)


# ---------------------------------------------------------------- Glimmer structure

def language_model(model):
    return model.model.language_model


def decoder_layers(model):
    return model.model.language_model.layers


_nq_get_decoder_layers = nq_utils.get_decoder_layers


def _get_decoder_layers(model):
    if model.config.model_type == "muse_glimmer":
        return decoder_layers(model)
    return _nq_get_decoder_layers(model)


nq_utils.get_decoder_layers = _get_decoder_layers


def layer_kwargs(lm, seqlen, device, batch=1):
    """Arguments for each decoder layer, as MuseGlimmerTextModel.forward passes them for an unpadded batch."""
    from transformers.masking_utils import create_causal_mask, create_sliding_window_causal_mask
    tc = lm.config
    pos = torch.arange(seqlen, device=device).unsqueeze(0)
    dtype = lm.embed_tokens.weight.dtype
    dummy = torch.zeros((batch, seqlen, tc.hidden_size), dtype=dtype, device=device)
    lm.rotary_emb.to(device)
    rope = lm.rotary_emb(dummy, pos)
    mk = dict(config=tc, inputs_embeds=dummy, attention_mask=None, past_key_values=None, position_ids=pos)
    masks = {"full_attention": create_causal_mask(**mk), "sliding_attention": create_sliding_window_causal_mask(**mk)}

    def for_layer(i):
        return {"attention_mask": masks[tc.layer_types[i]], "position_embeddings": rope if tc.layer_rope_theta[i] else None,
                "position_ids": pos}
    return for_layer


def embed(lm, ids):
    """Layer-0 input: MuseGlimmerModel zeroes image and video placeholder ids (calibration text has none), then the
    language model's normed embedding."""
    return lm.embed_tokens(ids)


# ---------------------------------------------------------------- model loading

def load_bf16(path, layers=0, device_map="cpu"):
    from transformers import AutoConfig, MuseGlimmerForConditionalGeneration
    cfg = AutoConfig.from_pretrained(path)
    if layers:
        # A truncated model for tests: the first N text layers only.
        tc = cfg.text_config
        tc.num_hidden_layers = layers
        tc.layer_types = tc.layer_types[:layers]
        tc.layer_rope_theta = tc.layer_rope_theta[:layers]
    model = MuseGlimmerForConditionalGeneration.from_pretrained(path, config=cfg, dtype=torch.bfloat16, device_map=device_map,
                                                               attn_implementation="sdpa")
    model.eval()
    model.requires_grad_(False)
    model.config.use_cache = False
    model.config.text_config.use_cache = False
    return model


def load_tokenizer(path):
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(path)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    return tok


def render(tok, messages, generation):
    """train_glimmer.py's render: the chat template at reasoning "low", without the template's BOS (the tokenizer adds it)."""
    text = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=generation, reasoning_strength=REASONING)
    bos = tok.bos_token or ""
    return text.removeprefix(bos) if bos else text


def probe_prompt(tok, question):
    text = render(tok, [{"role": "system", "content": SYSTEM}, {"role": "user", "content": question}], True)
    if not text.endswith(GENERATION_PROMPT):
        raise RuntimeError("Generation prompt doesn't end with " + GENERATION_PROMPT)
    return text + FINAL_CHANNEL


# ---------------------------------------------------------------- calibration data

def build_calibration(tok, jsonl, n, seqlen, seed):
    """n rows of seqlen tokens from the training examples: whole examples, each tokenized with its BOS, packed in a
    seeded random order; an example that doesn't fit is cut to fill the row and the next row starts a fresh one."""
    with open(jsonl) as f:
        rows = [json.loads(line) for line in f if line.strip()]
    order = list(range(len(rows)))
    random.Random(seed).shuffle(order)
    out, cur, used, k, bos_first = [], [], 0, 0, 0
    while len(out) < n:
        if k >= len(order):
            raise RuntimeError(f"ran out of examples after {len(out)} rows")
        ids = tok(render(tok, rows[order[k]]["messages"], False), add_special_tokens=True).input_ids
        k += 1
        bos_first += int(ids[0] == tok.bos_token_id)
        room = seqlen - len(cur)
        cur += ids[:room]
        used += 1
        if len(cur) == seqlen:
            out.append(cur)
            cur = []
    calib = torch.tensor(out, dtype=torch.long)
    return calib, {"rows": n, "seqlen": seqlen, "examples_used": used, "examples_total": len(rows), "seed": seed,
                   "examples_starting_with_bos": bos_first, "source": os.path.abspath(jsonl)}


# ---------------------------------------------------------------- calibration statistics (NanoQuant's collect_stats)

def glimmer_lce(model):
    """cut-cross-entropy on Glimmer's real logits: lm_head scaled by output_multiplier, then softcap."""
    from cut_cross_entropy import linear_cross_entropy as lce
    tc = model.config.text_config
    cache = {}

    def fn(e, c, targets, **kw):
        key = (c.data_ptr(), c.device)
        if key not in cache:
            cache.clear()
            cache[key] = (c * tc.output_multiplier).contiguous()
        return lce(e, cache[key], targets, softcap=tc.final_logit_softcapping, **kw)
    return fn


def calibration_stats(model, calib, strategy="online"):
    nq_importance.linear_cross_entropy = glimmer_lce(model)
    began = time.time()
    raw = nq_importance.collect_stats(model, calib, "cuda", strategy=strategy)
    model.gradient_checkpointing_disable()
    if hasattr(model, "disable_input_require_grads"):
        model.disable_input_require_grads()
    model.requires_grad_(False)
    model.eval()
    model.cpu()
    torch.cuda.empty_cache()
    raw = {"i_norm": {k: v.float().cpu() for k, v in raw["i_norm"].items()},
           "o_norm": {k: v.float().cpu() for k, v in raw["o_norm"].items()},
           "n_samples": raw["n_samples"], "stats_device": "cpu"}
    say("stats", seconds=round(time.time() - began, 1), layers=len(raw["i_norm"]))
    return raw


# ---------------------------------------------------------------- bits

def module_bits(m):
    a, b, r = m.in_features, m.out_features, m.rank
    scales = 16 * (a + b) + (16 * r if getattr(m, "scale_mid", None) is not None else 0)
    return {"in": a, "out": b, "rank": r, "binary_bits": r * (a + b), "scale_bits": scales, "dense_weights": a * b}


def bits_report(model):
    rows = {n: module_bits(m) for n, m in model.named_modules() if isinstance(m, NanoQuantLinear)}
    binary = sum(r["binary_bits"] for r in rows.values())
    scales = sum(r["scale_bits"] for r in rows.values())
    dense = sum(r["dense_weights"] for r in rows.values())
    nq_params = {id(p) for m in nq_modules(model).values() for p in m.parameters(recurse=False)}
    text_other = sum(p.numel() for p in language_model(model).parameters() if id(p) not in nq_params) + model.lm_head.weight.numel()
    vision = sum(p.numel() for n, p in model.model.named_parameters() if not n.startswith("language_model."))
    ranks = sorted({(r["in"], r["out"], r["rank"]) for r in rows.values()})
    return {
        "quantized_linears": len(rows), "quantized_weights": dense,
        "binary_bits": binary, "scale_bits": scales,
        "bits_per_weight_quantized_layers": (binary + scales) / dense if dense else None,
        "bits_per_weight_quantized_layers_without_scales": binary / dense if dense else None,
        "bf16_text_weights_kept": text_other, "bf16_vision_weights_kept": vision,
        "bits_per_weight_text_model": (binary + scales + 16 * text_other) / (dense + text_other) if dense else None,
        "ranks_by_shape": [{"in": a, "out": b, "rank": r} for a, b, r in ranks],
    }


# ---------------------------------------------------------------- saving and loading

def nq_modules(model):
    return {n: m for n, m in model.named_modules() if isinstance(m, NanoQuantLinear)}


@torch.no_grad()
def compressed_state(model, device="cuda"):
    """NanoQuant's packed state dict (the keys get_compressed_state_dict writes: <module>.V_packed / V_shape / U_packed /
    U_shape / scale_pre / scale_post for each NanoQuantLinear, every other parameter as is), with each module's packing
    done on the GPU."""
    mods = nq_modules(model)
    out = {}
    for name, p in model.named_parameters():
        owner = name.rsplit(".", 1)[0]
        if owner not in mods:
            out[name] = p.data
    for name, m in mods.items():
        home = m.V.device
        m.to(device)
        for k, v in m.pack_weights().items():
            out[f"{name}.{k}"] = v.cpu()
        for k in ("scale_pre", "scale_post", "scale_mid"):
            t = getattr(m, k, None)
            if isinstance(t, torch.Tensor):
                out[f"{name}.{k}"] = t.data.cpu()
        m.to(home)
    return out


@torch.no_grad()
def install_quantized(model, sd, device="cuda", dtype=torch.bfloat16):
    """Turns the linears named in a packed state dict into NanoQuantLinear modules holding its weights (the rest of
    the model is left as loaded). Unpacking runs on the GPU."""
    prefixes = sorted({k.rsplit(".", 1)[0] for k in sd if k.endswith(".V_packed")})
    for prefix in prefixes:
        m = model.get_submodule(prefix)
        if not isinstance(m, nn.Linear):
            raise RuntimeError(f"{prefix} is {type(m).__name__}, not nn.Linear")
        shape_v = tuple(int(x) for x in sd[prefix + ".V_shape"].tolist())
        shape_u = tuple(int(x) for x in sd[prefix + ".U_shape"].tolist())
        if shape_v != (shape_v[0], m.in_features) or shape_u != (m.out_features, shape_v[0]):
            raise RuntimeError(f"{prefix}: V {shape_v} U {shape_u} don't fit Linear({m.in_features}, {m.out_features})")
        m.__class__ = NanoQuantLinear
        m.init_for_inference(rank=shape_v[0], has_scale_mid=(prefix + ".scale_mid") in sd)
        m.V = nn.Parameter(binary_unpacker(sd[prefix + ".V_packed"].to(device), shape_v).to(dtype).cpu(), requires_grad=False)
        m.U = nn.Parameter(binary_unpacker(sd[prefix + ".U_packed"].to(device), shape_u).to(dtype).cpu(), requires_grad=False)
        for k in ("scale_pre", "scale_post", "scale_mid"):
            if prefix + "." + k in sd:
                setattr(m, k, nn.Parameter(sd[prefix + "." + k].to(dtype).clone(), requires_grad=False))
    return prefixes


def block_state(block):
    """A finished block's NanoQuant layers, for resuming: signs as int8, scales as stored."""
    out = {}
    for name, m in block.named_modules():
        if isinstance(m, NanoQuantLinear):
            out[name] = {"V": m.V.data.to(torch.int8).cpu(), "U": m.U.data.to(torch.int8).cpu(), "rank": m.rank,
                         **{k: getattr(m, k).data.cpu() for k in ("scale_pre", "scale_post", "scale_mid")
                            if isinstance(getattr(m, k, None), torch.Tensor)}}
    return out


def restore_block(block, state, dtype=torch.bfloat16):
    for name, s in state.items():
        m = block.get_submodule(name)
        m.__class__ = NanoQuantLinear
        m.init_for_inference(rank=s["rank"], has_scale_mid="scale_mid" in s)
        m.V = nn.Parameter(s["V"].to(dtype), requires_grad=False)
        m.U = nn.Parameter(s["U"].to(dtype), requires_grad=False)
        for k in ("scale_pre", "scale_post", "scale_mid"):
            if k in s:
                setattr(m, k, nn.Parameter(s[k].to(dtype), requires_grad=False))


# ---------------------------------------------------------------- block reconstruction (NanoQuant's per-block steps)

@torch.no_grad()
def run_block(block, inputs, kwargs, device, batch=8):
    out = torch.empty_like(inputs)
    for s in range(0, inputs.shape[0], batch):
        out[s:s + batch] = block(inputs[s:s + batch].to(device), **kwargs).to(out.dtype).cpu()
    return out


def quantize_blocks(qm, fpm, calib, cfg, ranks, work, resume, ckpt_every, free_fp=False):
    """NanoQuant's block reconstruction over Glimmer's text layers. With free_fp, each BF16 layer is dropped once its
    outputs are taken (its norm weights are kept for the final check), which keeps two runs inside the machine's RAM.
    Returns those kept tensors by state-dict name."""
    kept = {}
    dev = "cuda"
    lm_q, lm_fp = language_model(qm), language_model(fpm)
    n, seqlen = calib.shape
    kw = layer_kwargs(lm_fp, seqlen, dev)
    language_model(qm).rotary_emb.to(dev)
    start = 0
    os.makedirs(os.path.join(work, "blocks"), exist_ok=True)
    inputs_path = os.path.join(work, "inputs.pt")
    if resume and os.path.exists(inputs_path):
        saved = torch.load(inputs_path, map_location="cpu", weights_only=True)
        start, fp_in, q_in = int(saved["next"]), saved["fp_in"], saved["q_in"]
        for i in range(start):
            restore_block(lm_q.layers[i], torch.load(os.path.join(work, "blocks", f"blk-{i:02d}.pt"), map_location="cpu", weights_only=True))
            if free_fp:
                for k, v in lm_fp.layers[i].state_dict().items():
                    if not any(k == f"{name}.weight" for name in LINEARS):
                        kept[f"model.language_model.layers.{i}.{k}"] = v.detach().clone()
                lm_fp.layers[i] = nn.Module()
        say("resumed", next_block=start)
    else:
        with torch.no_grad():
            fp_in = torch.cat([embed(lm_fp, calib[j:j + 1]) for j in range(n)]).to(torch.bfloat16)
        q_in = fp_in.clone()
    total = len(lm_q.layers)
    began = time.time()
    for i in range(start, total):
        t0 = time.time()
        kwargs = kw(i)
        fpb = lm_fp.layers[i].to(dev)
        qb = lm_q.layers[i].to(dev)
        target = run_block(fpb, fp_in, kwargs, dev)
        tin, tgt = q_in.to(dev), target.to(dev)
        down = qb.mlp.down_proj
        importance = down.o_norm.to(dev) if hasattr(down, "o_norm") else torch.ones(tgt.shape[-1], device=dev)
        with torch.no_grad():
            before = float(((qb(tin[:8], **kwargs).float() - tgt[:8].float()).square() * importance).mean())
        for name in LINEARS:
            if cfg["tune_nonfact"]:
                tune_nonfact(qb, tin, tgt, importance, kwargs, cfg)
            nl, res = factorize_and_replace(qb, name, ranks[f"{i}.{name}"], cfg)
            del res
            if cfg["tune_fact"]:
                tune_fact(qb, nl, tin, tgt, importance, kwargs, cfg)
            torch.cuda.empty_cache()
        del tin, tgt
        with torch.no_grad():
            q_out = run_block(qb, q_in, kwargs, dev)
            err = float((((q_out[:8].to(dev).float() - target[:8].to(dev).float()).square()) * importance).mean())
        if free_fp:
            for k, v in fpb.state_dict().items():
                if not any(k == f"{name}.weight" for name in LINEARS):
                    kept[f"model.language_model.layers.{i}.{k}"] = v.detach().cpu().clone()
            lm_fp.layers[i] = nn.Module()
            del fpb
        else:
            lm_fp.layers[i] = fpb.cpu()
        lm_q.layers[i] = qb.cpu()
        fp_in, q_in = target, q_out
        torch.save(block_state(lm_q.layers[i]), os.path.join(work, "blocks", f"blk-{i:02d}.pt"))
        if (i + 1) % ckpt_every == 0 and i + 1 < total:
            torch.save({"next": i + 1, "fp_in": fp_in, "q_in": q_in}, inputs_path + ".tmp")
            os.replace(inputs_path + ".tmp", inputs_path)
        torch.cuda.empty_cache()
        done = i + 1 - start
        rate = (time.time() - began) / done
        say("block", block=i, of=total, seconds=round(time.time() - t0, 1), weighted_mse_first8_before=before,
            weighted_mse_first8_after_chain=err, eta_minutes=round(rate * (total - i - 1) / 60, 1),
            gpu_peak_gb=round(torch.cuda.max_memory_allocated() / 1024 ** 3, 2))
        torch.cuda.reset_peak_memory_stats()
    return kept


# ---------------------------------------------------------------- model-level distillation (NanoQuant's last step)

def kd_loss(student_logits, teacher_logits):
    """Forward KL as NanoQuant's model reconstruction computes it (temperature 1, every position counted):
    minus the teacher-weighted student log-probabilities, averaged over positions."""
    t = F.softmax(teacher_logits.float(), dim=-1)
    s = F.log_softmax(student_logits.float(), dim=-1)
    return -(t * s).sum(-1).mean()


@torch.no_grad()
def teacher_logits(model, calib):
    """The BF16 model's logits on every calibration row, in BF16 on CPU. The model must already be on the GPU."""
    model.eval()
    n, seqlen = calib.shape
    out = torch.empty((n, seqlen, model.config.text_config.vocab_size), dtype=torch.bfloat16)
    for j in range(n):
        out[j] = model(input_ids=calib[j:j + 1].to("cuda"), use_cache=False).logits[0].to(torch.bfloat16).cpu()
    return out


class GpuLock:
    """An exclusive lock on a file, so two runs sharing the GPU don't both hold a whole model on it at once."""

    def __init__(self, path):
        self.path, self.f = path, None

    def __enter__(self):
        if self.path:
            import fcntl
            self.f = open(self.path, "a")
            waited = time.time()
            fcntl.flock(self.f, fcntl.LOCK_EX)
            say("gpu_lock", path=self.path, waited_seconds=round(time.time() - waited, 1))
        return self

    def __exit__(self, *exc):
        if self.f:
            import fcntl
            fcntl.flock(self.f, fcntl.LOCK_UN)
            self.f.close()


def model_kd(qm, fpm, calib, epochs, lr, seed, teacher_path=""):
    dev = "cuda"
    n = calib.shape[0]
    began = time.time()
    if teacher_path and os.path.exists(teacher_path):
        teacher = torch.load(teacher_path, map_location="cpu", mmap=True, weights_only=True)
        if tuple(teacher.shape[:2]) != tuple(calib.shape):
            raise RuntimeError(f"{teacher_path} holds {tuple(teacher.shape)}, calibration is {tuple(calib.shape)}")
        say("kd_teacher", reused=teacher_path)
    else:
        fpm.to(dev)
        teacher = teacher_logits(fpm, calib)
        fpm.cpu()
        torch.cuda.empty_cache()
        say("kd_teacher", seconds=round(time.time() - began, 1), rows=n)
    qm.to(dev)
    qm.train()
    qm.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    params = []
    for m in nq_modules(qm).values():
        for k in ("scale_pre", "scale_post", "scale_mid"):
            p = getattr(m, k, None)
            if isinstance(p, nn.Parameter):
                p.requires_grad_(True)
                params.append(p)
    opt = NQAdamW(params, lr=lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs * n)
    rng = random.Random(seed)
    losses = []
    with torch.enable_grad():
        for ep in range(epochs):
            order = list(range(n))
            rng.shuffle(order)
            total = 0.0
            for j in order:
                logits = qm(input_ids=calib[j:j + 1].to(dev), use_cache=False).logits
                loss = kd_loss(logits, teacher[j:j + 1].to(dev, non_blocking=True))
                opt.zero_grad(set_to_none=True)
                loss.backward()
                opt.step()
                sched.step()
                total += float(loss.detach())
            losses.append(round(total / n, 5))
            say("kd_epoch", epoch=ep + 1, of=epochs, loss=losses[-1], seconds=round(time.time() - began, 1))
    for p in params:
        p.requires_grad_(False)
    qm.gradient_checkpointing_disable()
    qm.eval()
    qm.cpu()
    del teacher, opt
    torch.cuda.empty_cache()
    return {"epochs": epochs, "lr": lr, "loss_by_epoch": losses, "seconds": round(time.time() - began, 1), "tuned_scale_tensors": len(params)}


# ---------------------------------------------------------------- the whole run

def nq_config(a):
    c = NanoQuantConfigDataclass(model_id=a.model, bits=a.bits, seed=a.seed, num_calib_samples=a.samples, seqlen=a.seqlen,
                                 calib_dataset="train-stage1-frozen", nonfact_epochs=a.nonfact_epochs, fact_epochs=a.fact_epochs,
                                 admm_outer_iters=a.admm_iters, model_kd_epochs=a.kd_epochs).to_dict()
    return c


def calibration(a, tok):
    if a.calib_cache and os.path.exists(a.calib_cache):
        saved = torch.load(a.calib_cache, map_location="cpu", weights_only=False)
        calib, calib_info = saved["ids"], saved["info"]
        if tuple(calib.shape) != (a.samples, a.seqlen):
            raise RuntimeError(f"{a.calib_cache} holds {tuple(calib.shape)}, wanted {(a.samples, a.seqlen)}")
    else:
        calib, calib_info = build_calibration(tok, a.calib_jsonl, a.samples, a.seqlen, a.seed)
        if a.calib_cache:
            torch.save({"ids": calib, "info": calib_info}, a.calib_cache)
    say("calibration", **calib_info, shape=list(calib.shape))
    return calib, calib_info


def prepare(a):
    """What both bit settings share, computed once from the BF16 model: the calibration rows, NanoQuant's calibration
    statistics (they don't depend on the bit target) and the BF16 teacher's logits for the distillation step."""
    began = time.time()
    tok = load_tokenizer(a.model)
    calib, _ = calibration(a, tok)
    model = load_bf16(a.model, a.layers)
    say("loaded", seconds=round(time.time() - began, 1))
    model.to("cuda")
    if a.teacher:
        t0 = time.time()
        logits = teacher_logits(model, calib)
        torch.save(logits, a.teacher + ".tmp")
        os.replace(a.teacher + ".tmp", a.teacher)
        say("teacher_saved", path=a.teacher, shape=list(logits.shape), seconds=round(time.time() - t0, 1))
        del logits
    raw = calibration_stats(model, calib, NanoQuantConfigDataclass().calib_strategy)
    torch.save(raw, a.stats + ".tmp")
    os.replace(a.stats + ".tmp", a.stats)
    say("prepared", stats=a.stats, seconds=round(time.time() - began, 1))


def quantize(a):
    torch.manual_seed(a.seed)
    os.makedirs(a.out, exist_ok=True)
    work = os.path.join(a.out, "work")
    os.makedirs(work, exist_ok=True)
    began = time.time()
    tok = load_tokenizer(a.model)
    calib, calib_info = calibration(a, tok)

    qm = load_bf16(a.model, a.layers)
    say("loaded", which="student", seconds=round(time.time() - began, 1))
    cfg = nq_config(a)
    if a.stats and os.path.exists(a.stats):
        raw = torch.load(a.stats, map_location="cpu", weights_only=False)
        say("stats_reused", path=a.stats)
    else:
        with GpuLock(a.gpu_lock):
            raw = calibration_stats(qm, calib, cfg["calib_strategy"])
        if a.stats:
            torch.save(raw, a.stats)
    shrunk = nq_importance.get_shrunk_stats(raw, shrinkage=cfg["calib_shrinkage"])
    nq_importance.register_stats(qm, shrunk)
    ranks = nq_utils.calculate_ranks(qm, LINEARS, cfg)
    missing = [f"{i}.{n}" for i in range(len(decoder_layers(qm))) for n in LINEARS if f"{i}.{n}" not in ranks]
    if missing:
        raise RuntimeError(f"no rank for {missing[:4]}")
    say("ranks", bits=a.bits, distinct=sorted(set(ranks.values())), count=len(ranks))

    fpm = load_bf16(a.model, a.layers)
    say("loaded", which="teacher", seconds=round(time.time() - began, 1))
    t_blocks = time.time()
    # With the teacher's logits on disk the BF16 layers are only needed for their own block, so they can go.
    free_fp = bool(a.teacher and os.path.exists(a.teacher))
    kept = quantize_blocks(qm, fpm, calib, cfg, ranks, work, a.resume, a.ckpt_every, free_fp=free_fp)
    blocks_seconds = round(time.time() - t_blocks, 1)
    kd = None
    if a.kd_epochs > 0:
        with GpuLock(a.gpu_lock):
            kd = model_kd(qm, fpm, calib, a.kd_epochs, cfg["model_kd_lr"], a.seed, a.teacher)

    # Everything but the quantized linears must still equal the BF16 model it came from.
    sd = compressed_state(qm)
    ref = {**fpm.state_dict(), **kept}
    others = [k for k in sd if not k.endswith(NQ_SUFFIXES)]
    changed = [k for k in others if k not in ref or not torch.equal(sd[k], ref[k])]
    if changed:
        raise RuntimeError(f"tensors outside the quantized layers changed or unchecked: {changed[:5]}")
    torch.save(sd, os.path.join(a.out, "nq-full.pt"))
    from safetensors.torch import save_file
    text = {k: v.contiguous() for k, v in sd.items() if k.endswith(NQ_SUFFIXES)}
    save_file(text, os.path.join(a.out, "nq-text.safetensors"),
              metadata={"format": "nanoquant-packed", "model": os.path.abspath(a.model), "bits_target": str(a.bits)})
    report = {
        "model": os.path.abspath(a.model), "bits_target": a.bits, "nanoquant_config": cfg, "calibration": calib_info,
        "bits": bits_report(qm), "kd": kd, "block_seconds": blocks_seconds, "total_seconds": round(time.time() - began, 1),
        "files": {f: os.path.getsize(os.path.join(a.out, f)) for f in ("nq-full.pt", "nq-text.safetensors")},
        "unchanged_tensors_checked": len(others),
        "nanoquant_commit": "a9e0a430881ff80d83b622c3129e330dc33c04f5", "layers": a.layers or len(decoder_layers(qm)),
        "gpu": torch.cuda.get_device_name(0),
    }
    with open(os.path.join(a.out, "quant.json"), "w") as f:
        json.dump(report, f, indent=1)
    say("done", **{k: report[k] for k in ("bits_target", "block_seconds", "total_seconds", "files")},
        bpw=report["bits"]["bits_per_weight_quantized_layers"])


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare")
    q = sub.add_parser("quantize")
    for s in (p, q):
        s.add_argument("--model", required=True)
        s.add_argument("--calib-jsonl", default="")
        s.add_argument("--calib-cache", default="")
        s.add_argument("--stats", default="", required=s is p)
        s.add_argument("--teacher", default="", help="BF16 teacher logits file (prepare writes it, quantize reads it)")
        s.add_argument("--samples", type=int, default=128)
        s.add_argument("--seqlen", type=int, default=2048)
        s.add_argument("--seed", type=int, default=0)
        s.add_argument("--layers", type=int, default=0, help="a model cut to its first N text layers (tests)")
    q.add_argument("--out", required=True)
    q.add_argument("--bits", type=float, required=True)
    q.add_argument("--nonfact-epochs", type=int, default=8)
    q.add_argument("--fact-epochs", type=int, default=8)
    q.add_argument("--kd-epochs", type=int, default=8)
    q.add_argument("--admm-iters", type=int, default=400)
    q.add_argument("--resume", action="store_true")
    q.add_argument("--ckpt-every", type=int, default=4)
    q.add_argument("--gpu-lock", default="", help="lock file held while a whole model is on the GPU")
    a = ap.parse_args()
    if a.cmd == "prepare":
        prepare(a)
    elif a.cmd == "quantize":
        quantize(a)


if __name__ == "__main__":
    main()
