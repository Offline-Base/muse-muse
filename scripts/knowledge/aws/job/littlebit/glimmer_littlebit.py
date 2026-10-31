"""Muse Glimmer 30B quantized below 1 bit per weight with LittleBit (Samsung Research, NeurIPS 2025, arXiv 2506.13771).

NON-COMMERCIAL ONLY (see README.md next to this file). This file is ours, but it drives SamsungLabs/LittleBit, which
is licensed CC BY-NC 4.0 and is installed by setup.sh outside this repo (LITTLEBIT_DIR, default ~/lb/LittleBit, at a
pinned commit). No LittleBit code is copied here; it is imported at run time. Neither these scripts nor any model they
make may be used in a commercial product.

What this adapts to Glimmer (meta-models/Muse-Glimmer-30B, transformers 5.15.0):
- Glimmer loads as MuseGlimmerForConditionalGeneration. It isn't in AutoModelForCausalLM's map, which LittleBit's
  main.py, eval.py and loader all use, so it is loaded by class here.
- Only the language model's projections become LittleBitLinear: in each of the 52 decoder layers, self_attn q, k, v,
  o and gate (Glimmer gates its attention output) and mlp gate, up and down. That is 416 modules holding 25.16B of the
  model's 29.78B weights. LittleBit's own patch turns every nn.Linear except lm_head into LittleBitLinear, which would
  include the vision tower; here the vision tower, vision adapter and projection, the embeddings and lm_head stay BF16
  and frozen. The decoder norms train, as in LittleBit's recipe (it freezes only embeddings and lm_head).
- Data: our knowledge text, rendered with Glimmer's chat template exactly as train_glimmer.py renders it, mixed with
  LittleBit's c4_wiki loader, in 2,048-token blocks. Eval probes and forgetting checks are never trained on (`data`
  drops any training example whose question matches one).
- Init (Dual-SVID, plus LittleBit-2's Joint-ITQ with --use_itq True) runs once, layer by layer and sharded across GPUs
  (`init`), and is saved in FP32, so the training ranks don't each redo it.
- Training is LittleBit's KDTrainer, unchanged: loss = KL(teacher || student) on the logits + l2l_loss_scale x the sum
  over decoder layers of the MSE between student and teacher hidden states. The teacher is the full-precision BF16
  model (the merged, tuned Glimmer), frozen: ZeRO-3 inference under DeepSpeed, or on the same GPU for one-GPU tests.
  The student never sees labels, only the teacher.
- Saving: LittleBit's packed format (U and V as bit-packed signs, scales in BF16), gathered layer by layer under
  ZeRO-3, plus littlebit_config.json. eval_littlebit.py loads it.

Commands:
  slice --model DIR --layers N --out DIR      the first N decoder layers as a small Glimmer, for tests on one GPU
  data  --model DIR --train JSONL... --exclude JSONL... --general_ratio R --out DIR
  init  --model DIR --out DIR --eff_bit B [--shard K/N]
  train --model DIR --data DIR --init DIR --out DIR [--ds_config FILE] ...   (python, or deepspeed for ZeRO-3)
"""

import argparse
import json
import os
import re
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LB_DIR = os.environ.get("LITTLEBIT_DIR", os.path.expanduser("~/lb/LittleBit"))
# train_glimmer.py (chat template markers, the final-channel prompt, probe scoring) sits one folder up.
JOB_DIR = os.environ.get("GLIMMER_JOB_DIR", os.path.dirname(HERE))
LANG_LINEAR = re.compile(r"^model\.language_model\.layers\.(\d+)\.(self_attn|mlp)\.(q|k|v|o|gate|up|down)_proj$")
PER_LAYER = 8
LAYER_PREFIX = "model.language_model.layers."
TOKENIZER_FILES = ("config.json", "generation_config.json", "processor_config.json", "tokenizer.json",
                   "tokenizer_config.json", "chat_template.jinja", "LICENSE", "USAGE_POLICY.md")
QUANT_KEYS = ("quant_func", "quant_mod", "eff_bit", "residual", "split_dim", "kv_factor", "min_split_dim", "use_itq", "itq_n_iter")
RANK = int(os.environ.get("RANK", "0"))
LOCAL_RANK = int(os.environ.get("LOCAL_RANK", "0"))
MAIN = RANK == 0


def say(event, **fields):
    if MAIN:
        print("LB " + json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def use_littlebit():
    if not os.path.isdir(os.path.join(LB_DIR, "quantization")):
        raise SystemExit(f"LittleBit isn't at {LB_DIR} (run setup.sh, or set LITTLEBIT_DIR)")
    if LB_DIR not in sys.path:
        sys.path.insert(0, LB_DIR)
    # LittleBit's packages import each other in a cycle that only resolves in its own main.py's order (utils first).
    import quantization.utils  # noqa: F401


def train_glimmer():
    if JOB_DIR not in sys.path:
        sys.path.insert(0, JOB_DIR)
    import train_glimmer as tg
    return tg


def read_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def write_json(path, value):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump(value, f, indent=1)
    os.replace(path + ".tmp", path)


def str2bool(v):
    if str(v).lower() in ("1", "true", "yes", "y", "t"):
        return True
    if str(v).lower() in ("0", "false", "no", "n", "f"):
        return False
    raise argparse.ArgumentTypeError(f"not a boolean: {v}")


def quant_config(a):
    return {k: getattr(a, k) for k in QUANT_KEYS}


def glimmer_class():
    from transformers.models.muse_glimmer.modeling_muse_glimmer import MuseGlimmerForConditionalGeneration
    return MuseGlimmerForConditionalGeneration


def shard_index(folder):
    idx = os.path.join(folder, "model.safetensors.index.json")
    if os.path.exists(idx):
        with open(idx) as f:
            return json.load(f)["weight_map"]
    from safetensors import safe_open
    with safe_open(os.path.join(folder, "model.safetensors"), framework="pt") as f:
        return {k: "model.safetensors" for k in f.keys()}


def read_tensors(folder, names):
    """The named tensors from a safetensors folder (one shard open at a time)."""
    from safetensors import safe_open
    where = shard_index(folder)
    out, by_file = {}, {}
    for n in names:
        by_file.setdefault(where[n], []).append(n)
    for fname, keys in by_file.items():
        with safe_open(os.path.join(folder, fname), framework="pt") as f:
            for k in keys:
                out[k] = f.get_tensor(k)
    return out


# ---- the patch: LittleBit's patch_inst on each decoder layer, so nothing outside the language model is touched ----

def patch_layer(layer, q, do_train):
    """Turns the 8 projections of one decoder layer into LittleBitLinear with LittleBit's own converter. With do_train,
    __quant_convert__ runs LittleBit's init (SVD on the GPU, plus ITQ when use_itq) from the layer's weights; without
    it, the factors are empty placeholders on the meta device, to be loaded."""
    import torch.nn as nn
    use_littlebit()
    from quantization.utils.quant_util import get_quant_func_and_mod, patch_inst
    func, mod = get_quant_func_and_mod(q["quant_func"], q["quant_mod"])
    common = {"do_train": do_train, "quant_func": func, "residual": q["residual"], "split_dim": q["split_dim"],
              "eff_bit": q["eff_bit"], "min_split_dim": q["min_split_dim"], "use_itq": q["use_itq"], "itq_n_iter": q["itq_n_iter"]}
    # LittleBit's k/v rule: kv_factor scales the rank of k_proj and v_proj.
    kv = {"ratio_factor": q["kv_factor"]}
    patch_inst(layer, mapping={nn.Linear: mod}, convert_kwargs=[([nn.Linear], common), ([re.compile(r"\.k_proj$"), re.compile(r"\.v_proj$")], kv)])
    return mod


def littlebit_modules(model):
    use_littlebit()
    from quantization.modules import LittleBitLinear
    return {n: m for n, m in model.named_modules() if isinstance(m, LittleBitLinear)}


def check_patch(model, n_layers):
    """Exactly the 8 projections of every decoder layer are LittleBitLinear, and nothing else is."""
    found = littlebit_modules(model)
    bad = [n for n in found if not LANG_LINEAR.match(n)]
    if bad or len(found) != PER_LAYER * n_layers:
        raise RuntimeError(f"patch check failed: {len(found)} LittleBit modules (want {PER_LAYER * n_layers}), outside the language layers: {bad[:5]}")
    return found


def bits_report(model):
    mods = littlebit_modules(model)
    bits = sum(m.total_bit_usage for m in mods.values())
    weights = sum(m.in_features * m.out_features for m in mods.values())
    split = {n.split(".")[-1]: int(m._split_dim_final) for n, m in list(mods.items())[:PER_LAYER]}
    return {"modules": len(mods), "weights": weights, "bits": bits, "bits_per_weight": round(bits / max(1, weights), 4),
            "packed_gb": round(bits / 8 / 1e9, 3), "rank_per_projection_layer0": split}


# ---- slice ----

def cmd_slice(a):
    """A Glimmer with only its first N decoder layers (plus embeddings, final norm, lm_head and the whole vision
    side), saved as a normal checkpoint folder. LittleBit's whole path runs on it unchanged, so a one-GPU test exercises
    the same code as the full run; time and memory per decoder layer scale to 52."""
    from safetensors.torch import save_file
    with open(os.path.join(a.model, "config.json")) as f:
        cfg = json.load(f)
    t = cfg["text_config"]
    if not 0 < a.layers <= t["num_hidden_layers"]:
        raise SystemExit("--layers out of range")
    t["num_hidden_layers"] = a.layers
    for k in ("layer_types", "layer_rope_theta"):
        if isinstance(t.get(k), list):
            t[k] = t[k][: a.layers]
    os.makedirs(a.out, exist_ok=True)
    for f in TOKENIZER_FILES:
        if os.path.exists(os.path.join(a.model, f)) and f != "config.json":
            shutil.copy(os.path.join(a.model, f), os.path.join(a.out, f))
    write_json(os.path.join(a.out, "config.json"), cfg)
    keep = [k for k in shard_index(a.model) if not k.startswith(LAYER_PREFIX) or int(k[len(LAYER_PREFIX):].split(".")[0]) < a.layers]
    tensors = read_tensors(a.model, keep)
    save_file(tensors, os.path.join(a.out, "model.safetensors"), metadata={"format": "pt"})
    say("slice", layers=a.layers, tensors=len(tensors), out=a.out, layer_types=t.get("layer_types"))


# ---- data ----

WIKITEXT = "Salesforce/wikitext"  # the Hub dropped the bare "wikitext" id that LittleBit's loader still uses


def wikitext_by_id(module):
    """Points a LittleBit module's load_dataset at the current WikiText id (same data, new repo name)."""
    original = module.load_dataset

    def load(name, *args, **kwargs):
        return original(WIKITEXT if name == "wikitext" else name, *args, **kwargs)
    module.load_dataset = load


def cmd_data(a):
    import datasets
    from itertools import chain
    from transformers import AutoTokenizer
    tg = train_glimmer()
    tok = AutoTokenizer.from_pretrained(a.model)
    bos = tok.bos_token or ""
    banned = set()
    for path in a.exclude:
        for row in read_jsonl(path):
            if row.get("question"):
                banned.add(tg.normalize(row["question"]))
    texts, dropped, rows = [], 0, 0
    for path in a.train:
        for row in read_jsonl(path):
            rows += 1
            if a.max_own and len(texts) >= a.max_own:
                break
            if any(m["role"] == "user" and tg.normalize(m["content"]) in banned for m in row["messages"]):
                dropped += 1
                continue
            # train_glimmer.py's render(): the template with low reasoning, its BOS removed (the tokenizer adds one).
            text = tok.apply_chat_template(row["messages"], tokenize=False, add_generation_prompt=False, reasoning_strength=tg.REASONING)
            text = text.removeprefix(bos) if bos else text
            for m in row["messages"]:
                marker = {"user": tg.INSTRUCTION_PART, "assistant": tg.RESPONSE_PART}.get(m["role"])
                if marker and marker + m["content"] not in text:
                    raise RuntimeError("The template didn't put a " + m["role"] + " message right after " + marker + ": " + text[:400])
            texts.append(text)
    say("data_own", rows_read=rows, kept=len(texts), dropped_matching_eval=dropped, excluded_questions=len(banned), example=texts[0][:300] if texts else None)
    n = a.seqlen

    def blocks(batch):
        ids = list(chain.from_iterable(batch["input_ids"]))
        k = len(ids) // n * n
        return {"input_ids": [ids[i:i + n] for i in range(0, k, n)]}

    own = datasets.Dataset.from_dict({"text": texts})
    own = own.map(lambda b: {"input_ids": tok(b["text"])["input_ids"]}, batched=True, remove_columns=["text"], num_proc=a.num_proc)
    own_tokens = sum(len(x) for x in own["input_ids"])
    own = own.map(blocks, batched=True, batch_size=4000, remove_columns=own.column_names, num_proc=a.num_proc)
    parts, general_blocks = [own], 0
    if a.general_ratio != 0:
        if n != 2048:
            raise SystemExit("LittleBit's c4_wiki loader makes 2,048-token blocks; use --seqlen 2048 with general text")
        use_littlebit()
        import utils.datautils as lb_data  # LittleBit's loader: C4 en shard 0 + WikiText-2 train
        wikitext_by_id(lb_data)
        gen = lb_data.get_c4_wiki_train(tokenizer=tok)
        gen = gen.remove_columns([c for c in gen.column_names if c != "input_ids"])
        want = len(gen) if a.general_ratio < 0 else min(len(gen), round(a.general_ratio * len(own)))
        gen = gen.shuffle(seed=a.seed).select(range(want))
        general_blocks = len(gen)
        parts.append(gen)
    data = datasets.concatenate_datasets(parts).shuffle(seed=a.seed)
    data.save_to_disk(a.out)
    report = {"own_rows_read": rows, "own_examples": len(texts), "dropped_matching_eval": dropped, "own_tokens": own_tokens,
              "own_blocks": len(own), "general_blocks": general_blocks, "blocks": len(data), "seqlen": n,
              "tokens": len(data) * n, "train_files": a.train, "exclude_files": a.exclude, "general_ratio": a.general_ratio}
    write_json(os.path.join(a.out, "muse_data.json"), report)
    say("data", **report)


# ---- init ----

def cmd_init(a):
    """LittleBit's init for this shard's decoder layers, one layer at a time on this process's GPU, saved in FP32
    (init/layer-NNN.safetensors). Run one process per GPU with --shard K/N; a layer already saved is skipped."""
    import torch
    from safetensors.torch import save_file
    from transformers import AutoConfig
    from transformers.models.muse_glimmer.modeling_muse_glimmer import MuseGlimmerTextDecoderLayer
    torch.manual_seed(a.seed)
    cfg = AutoConfig.from_pretrained(a.model).text_config
    k, n = (int(x) for x in a.shard.split("/"))
    q = quant_config(a)
    os.makedirs(a.out, exist_ok=True)
    meta = {"model": os.path.abspath(a.model), "layers": cfg.num_hidden_layers, "quant": q, "seed": a.seed}
    meta_path = os.path.join(a.out, "init.json")
    if os.path.exists(meta_path):
        with open(meta_path) as f:
            old = json.load(f)
        if old["quant"] != q or old["model"] != meta["model"]:
            raise SystemExit(f"{a.out} holds an init with other settings: {old}")
    elif k == 0:
        write_json(meta_path, meta)
    names = list(shard_index(a.model))
    for i in range(k, cfg.num_hidden_layers, n):
        path = os.path.join(a.out, f"layer-{i:03d}.safetensors")
        if os.path.exists(path):
            continue
        began = time.time()
        # Seeded per layer (svd_lowrank and ITQ draw random numbers), so the init doesn't depend on the sharding.
        torch.manual_seed(a.seed * 1000 + i)
        prefix = f"{LAYER_PREFIX}{i}."
        sd = {key[len(prefix):]: v for key, v in read_tensors(a.model, [x for x in names if x.startswith(prefix)]).items()}
        with torch.device("meta"):
            layer = MuseGlimmerTextDecoderLayer(cfg, i)
        layer.load_state_dict(sd, strict=True, assign=True)
        patch_layer(layer, q, do_train=True)
        out = {prefix + name: p.detach().float().contiguous() for name, p in layer.named_parameters()
               if name.split(".")[-1] in ("U", "V", "u1", "u2", "v1", "v2", "U_R", "V_R", "u1_R", "u2_R", "v1_R", "v2_R")}
        save_file(out, path + ".tmp", metadata={"format": "pt"})
        os.replace(path + ".tmp", path)
        print("LB " + json.dumps({"event": "init_layer", "layer": i, "shard": a.shard, "tensors": len(out),
                                  "seconds": round(time.time() - began, 1)}), flush=True)
        del layer, sd, out
        torch.cuda.empty_cache()


def load_init(model, init_dir, q):
    """Student factors from an init folder (or a training checkpoint's latents) into the empty LittleBit modules."""
    import torch
    from safetensors.torch import load_file
    with open(os.path.join(init_dir, "init.json")) as f:
        meta = json.load(f)
    if meta["quant"] != q:
        raise SystemExit(f"init {init_dir} was made with {meta['quant']}, this run asks {q}")
    mods = littlebit_modules(model)
    want = {f"{n}.{p}" for n, m in mods.items() for p, _ in m.named_parameters(recurse=False)}
    got = {}
    n_layers = len(mods) // PER_LAYER
    for i in range(n_layers):
        got.update(load_file(os.path.join(init_dir, f"layer-{i:03d}.safetensors")))
    missing, extra = want - set(got), set(got) - want
    if missing or extra:
        raise RuntimeError(f"init doesn't fit: missing {sorted(missing)[:4]}, extra {sorted(extra)[:4]}")
    model.load_state_dict(got, strict=False, assign=True)
    for n, m in mods.items():
        m.do_train = True
        for p in m.parameters(recurse=False):
            if p.is_meta:
                raise RuntimeError(f"{n} still has meta parameters after loading the init")
            p.requires_grad_(True)
    return len(got)


# ---- train ----

def cmd_train(a):
    import torch
    use_littlebit()
    from datasets import load_from_disk
    from transformers import AutoTokenizer, TrainerCallback, TrainingArguments, default_data_collator, set_seed
    from utils.kd_utils import KDTrainer
    from utils.utils import prepare_model_for_training
    from quantization.modules import LittleBitLinear
    set_seed(a.seed)
    if a.ds_config and torch.cuda.is_available():
        torch.cuda.set_device(LOCAL_RANK)
    Glimmer = glimmer_class()
    q = quant_config(a)
    os.makedirs(a.out, exist_ok=True)
    data = load_from_disk(a.data)
    data = data.remove_columns([c for c in data.column_names if c != "input_ids"])
    if a.max_blocks:
        data = data.select(range(min(a.max_blocks, len(data))))
    tok = AutoTokenizer.from_pretrained(a.model)
    say("start", quant=q, data=a.data, blocks=len(data), init=a.init, deepspeed=a.ds_config, l2l_loss_scale=a.l2l_loss_scale)

    t0 = time.time()
    student = Glimmer.from_pretrained(a.model, dtype=torch.bfloat16, low_cpu_mem_usage=True)
    student.config.use_cache = False
    # LittleBit's helper: freezes names holding these words, makes inputs require grads, turns on gradient checkpointing.
    prepare_model_for_training(student, exclude=("lm_head", "embed", "vision"))
    layers = student.model.language_model.layers
    for layer in layers:
        patch_layer(layer, q, do_train=not a.init)
    check_patch(student, len(layers))
    if a.init:
        load_init(student, a.init, q)
    for n, p in student.named_parameters():
        if "vision" in n or "embed" in n or n.startswith("lm_head"):
            p.requires_grad_(False)
    trainable = sum(p.numel() for p in student.parameters() if p.requires_grad)
    say("student", seconds=round(time.time() - t0, 1), trainable=trainable, total=sum(p.numel() for p in student.parameters()), **bits_report(student))

    t0 = time.time()
    if a.ds_config:
        import deepspeed
        from transformers.integrations.deepspeed import HfDeepSpeedConfig
        with open(a.teacher_ds_config or os.path.join(LB_DIR, "configs", "zero3_inference.json")) as f:
            tcfg = json.load(f)
        keep = HfDeepSpeedConfig(tcfg)  # noqa: F841 (from_pretrained partitions the teacher while this lives)
        teacher = Glimmer.from_pretrained(a.model, dtype=torch.bfloat16)
        teacher.eval()
        for p in teacher.parameters():
            p.requires_grad = False
        teacher.config.use_cache = False
        teacher, _, _, _ = deepspeed.initialize(model=teacher, model_parameters=teacher.parameters(), config=tcfg)
    else:
        teacher = Glimmer.from_pretrained(a.model, dtype=torch.bfloat16, device_map={"": "cuda"})
        teacher.eval()
        for p in teacher.parameters():
            p.requires_grad = False
        teacher.config.use_cache = False
        student.to("cuda")
    say("teacher", seconds=round(time.time() - t0, 1), deepspeed=bool(a.ds_config))

    args = TrainingArguments(
        # transformers 5 dropped warmup_ratio (LittleBit's main.py still passes it); a float below 1 here is the ratio.
        per_device_train_batch_size=a.batch, gradient_accumulation_steps=a.accum, warmup_steps=a.warmup_ratio,
        num_train_epochs=a.epochs, max_steps=a.max_steps, bf16=True, logging_steps=1, learning_rate=a.lr,
        lr_scheduler_type="cosine", optim="adamw_torch", adam_beta1=0.9, adam_beta2=0.999, deepspeed=a.ds_config,
        report_to="none", output_dir=os.path.join(a.out, "ckpt"), save_strategy="steps" if a.save_steps else "no",
        save_steps=a.save_steps or 10 ** 9, save_total_limit=2, seed=a.seed, dataloader_num_workers=2,
        gradient_checkpointing=False,  # already on (prepare_model_for_training)
    )

    class Pace(TrainerCallback):
        """Seconds and peak GPU memory per optimizer step, to pace.jsonl and the log."""

        def __init__(self):
            self.t = None
            self.rows = []

        def on_step_begin(self, args, state, control, **kw):
            if self.t is None:
                torch.cuda.synchronize()
                self.t = time.time()

        def on_step_end(self, args, state, control, **kw):
            torch.cuda.synchronize()
            now = time.time()
            row = {"step": state.global_step, "seconds": round(now - self.t, 3),
                   "peak_alloc_gb": round(torch.cuda.max_memory_allocated() / 1024 ** 3, 2),
                   "peak_reserved_gb": round(torch.cuda.max_memory_reserved() / 1024 ** 3, 2),
                   "loss": next((h.get("loss") for h in reversed(state.log_history) if "loss" in h), None),
                   "kd_loss": next((h.get("kd_loss") for h in reversed(state.log_history) if "kd_loss" in h), None),
                   "l2l_loss": next((h.get("l2l_loss") for h in reversed(state.log_history) if "l2l_loss" in h), None)}
            self.t = now
            self.rows.append(row)
            if MAIN:
                with open(os.path.join(a.out, "pace.jsonl"), "a") as f:
                    f.write(json.dumps(row) + "\n")
                if state.global_step <= 5 or state.global_step % 25 == 0:
                    say("step", of=state.max_steps, **row)

    class Trainer(KDTrainer):
        def _save_checkpoint(self, model, trial):
            # LittleBitLinear.state_dict() packs U and V to signs, which would lose the latent values a resumed run
            # needs (and can't pack ZeRO-3's empty partitions). Checkpoints save plain parameters instead; DeepSpeed
            # also writes the FP32 master weights and optimizer state, which is what resume_from_checkpoint reads.
            packed = LittleBitLinear.state_dict
            LittleBitLinear.state_dict = torch.nn.Module.state_dict
            try:
                return super()._save_checkpoint(model, trial)
            finally:
                LittleBitLinear.state_dict = packed

    pace = Pace()
    trainer = Trainer(model=student, teacher_model=teacher, l2l_loss_scale=a.l2l_loss_scale, processing_class=tok,
                      train_dataset=data, args=args, data_collator=default_data_collator, callbacks=[pace])
    resume = None
    ck = os.path.join(a.out, "ckpt")
    if os.path.isdir(ck) and any(d.startswith("checkpoint-") for d in os.listdir(ck)):
        resume = True
    began = time.time()
    stats = trainer.train(resume_from_checkpoint=resume)
    seconds = time.time() - began
    steps = pace.rows
    # The median step after the first: the first carries start-up, and a step that saved a checkpoint carries the save.
    later = sorted(r["seconds"] for r in steps[1:])
    summary = {"steps": int(trainer.state.global_step), "train_seconds": round(seconds, 1), "train_loss": getattr(stats, "training_loss", None),
               "seconds_per_step_steady": later[len(later) // 2] if later else None,
               "seconds_first_step": steps[0]["seconds"] if steps else None,
               "peak_alloc_gb": max((r["peak_alloc_gb"] for r in steps), default=None),
               "peak_reserved_gb": max((r["peak_reserved_gb"] for r in steps), default=None),
               "tokens_per_step": a.batch * a.accum * int(os.environ.get("WORLD_SIZE", "1")) * len(data[0]["input_ids"]),
               "gpu": torch.cuda.get_device_name(0), "world": int(os.environ.get("WORLD_SIZE", "1")), "quant": q,
               "batch": a.batch, "accum": a.accum, "lr": a.lr, "epochs": a.epochs, "max_steps": a.max_steps, **bits_report(student)}
    say("trained", **summary)
    save_packed(trainer, student, a, q, bool(a.ds_config))
    if MAIN:
        write_json(os.path.join(a.out, "model", "muse_littlebit.json"), {**summary, "model": os.path.abspath(a.model), "data": os.path.abspath(a.data),
                                                                       "init": a.init, "l2l_loss_scale": a.l2l_loss_scale, "license": "CC BY-NC 4.0 method code; non-commercial use only"})
    say("done", out=os.path.join(a.out, "model"))


def save_packed(trainer, model, a, q, zero3):
    """LittleBit's packed format, one piece at a time: under ZeRO-3 each decoder layer (then the rest) is gathered,
    rank 0 takes its state_dict (LittleBitLinear packs U and V to bits there) and the shards are written by rank 0."""
    import torch
    from safetensors.torch import save_file
    out = os.path.join(a.out, "model")
    if MAIN:
        os.makedirs(out, exist_ok=True)
    model.eval()
    pieces = [(f"{LAYER_PREFIX}{i}.", layer) for i, layer in enumerate(model.model.language_model.layers)]
    lm = model.model.language_model
    rest = [("model.language_model.embed_tokens.", lm.embed_tokens), ("model.language_model.norm.", lm.norm), ("lm_head.", model.lm_head)]
    rest += [(f"model.{name}.", mod) for name, mod in model.model.named_children() if name != "language_model"]
    shard, shard_bytes, index, files = {}, 0, {}, []

    def flush():
        nonlocal shard, shard_bytes
        if shard and MAIN:
            name = f"model-{len(files) + 1:05d}.safetensors"
            save_file(shard, os.path.join(out, name), metadata={"format": "pt"})
            files.append(name)
            for k in shard:
                index[k] = name
        shard, shard_bytes = {}, 0

    for prefix, mod in pieces + rest:
        params = list(mod.parameters())
        if zero3:
            import deepspeed
            ctx = deepspeed.zero.GatheredParameters(params, modifier_rank=None)
        else:
            import contextlib
            ctx = contextlib.nullcontext()
        with ctx:
            if MAIN:
                sd = mod.state_dict(prefix=prefix)
                for k, v in sd.items():
                    v = v.detach().cpu()
                    if v.dtype == torch.float32 and not k.endswith(("_packed", "_shape")) and not k.split(".")[-1].startswith("_"):
                        v = v.to(torch.bfloat16)
                    shard[k] = v.contiguous()
                    shard_bytes += v.numel() * v.element_size()
        if shard_bytes > 4 * 1024 ** 3:
            flush()
    flush()
    if MAIN:
        write_json(os.path.join(out, "model.safetensors.index.json"), {"metadata": {}, "weight_map": index})
        for f in TOKENIZER_FILES:
            if os.path.exists(os.path.join(a.model, f)):
                shutil.copy(os.path.join(a.model, f), os.path.join(out, f))
        write_json(os.path.join(out, "littlebit_config.json"), q)
        say("saved", out=out, files=len(files), tensors=len(index))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["slice", "data", "init", "train"])
    ap.add_argument("--model", required=True, help="the BF16 Glimmer folder (the merged, tuned model for the real run)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--layers", type=int, default=4)
    ap.add_argument("--train", action="append", default=[])
    ap.add_argument("--exclude", action="append", default=[], help="JSONL with a question field (eval probes, forget checks)")
    ap.add_argument("--general_ratio", type=float, default=1.0, help="c4_wiki blocks per own block; -1 all of it, 0 none")
    ap.add_argument("--max_own", type=int, default=0)
    ap.add_argument("--seqlen", type=int, default=2048)
    ap.add_argument("--num_proc", type=int, default=8)
    ap.add_argument("--shard", default="0/1")
    ap.add_argument("--data")
    ap.add_argument("--init")
    ap.add_argument("--ds_config")
    ap.add_argument("--teacher_ds_config")
    ap.add_argument("--max_blocks", type=int, default=0)
    ap.add_argument("--epochs", type=float, default=5.0)
    ap.add_argument("--max_steps", type=int, default=-1)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--accum", type=int, default=1)
    ap.add_argument("--lr", type=float, default=4e-5)
    ap.add_argument("--warmup_ratio", type=float, default=0.02)
    ap.add_argument("--l2l_loss_scale", type=float, default=10.0)
    ap.add_argument("--save_steps", type=int, default=0)
    ap.add_argument("--seed", type=int, default=42)
    # LittleBit's quantization settings (its README's example values as defaults).
    ap.add_argument("--quant_func", default="SmoothSign")
    ap.add_argument("--quant_mod", default="LittleBitLinear")
    ap.add_argument("--eff_bit", type=float, default=0.55)
    ap.add_argument("--residual", type=str2bool, default=True)
    ap.add_argument("--split_dim", type=int, default=1024)
    ap.add_argument("--kv_factor", type=float, default=1.0)
    ap.add_argument("--min_split_dim", type=int, default=8)
    ap.add_argument("--use_itq", type=str2bool, default=True)
    ap.add_argument("--itq_n_iter", type=int, default=50)
    ap.add_argument("--local_rank", type=int, default=-1)  # deepspeed passes it
    a = ap.parse_args()
    {"slice": cmd_slice, "data": cmd_data, "init": cmd_init, "train": cmd_train}[a.command](a)


if __name__ == "__main__":
    main()
