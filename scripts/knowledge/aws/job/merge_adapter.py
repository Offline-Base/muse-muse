"""Merge a knowledge LoRA adapter into Muse Glimmer 30B's BF16 weights, on CPU (docs/KNOWLEDGE_UPDATE.md, Glimmer outputs).

The adapter was trained by Unsloth (train_glimmer.py) on the language layers of the full conditional-generation model:
its keys read base_model.model.model.language_model.layers.N.{self_attn,mlp}.*_proj.lora_{A,B}.weight and its
target_modules regex only matches module names that hold "language" or "text". So it is loaded with PEFT onto
MuseGlimmerForConditionalGeneration (the class in its auto_mapping), never onto the bare text model, whose module
names would not match. Then merge_and_unload, save as BF16 safetensors, and copy the base's tokenizer, chat template
and configs over the saved ones, so the merged folder differs from the base only in weights.

Checks, all of which must pass or the script exits non-zero:
- every saved LoRA tensor landed on a LoRA weight of the model, and every LoRA weight equals its saved tensor;
- the merged folder has exactly the base's tensor names, shapes and dtypes;
- every tensor the adapter targets differs from the base, and every other tensor is bit-identical to the base;
- for a sample of targeted tensors, merged equals base + (alpha / r) * B @ A, to within one BF16 rounding step.

Usage: python merge_adapter.py --base DIR --adapter DIR --out DIR [--report FILE]
"""

import argparse
import json
import os
import re
import shutil
import sys
import time

COPY_FROM_BASE = ("config.json", "generation_config.json", "processor_config.json", "tokenizer.json", "tokenizer_config.json",
                  "chat_template.jinja", "LICENSE", "USAGE_POLICY.md")


def say(event, **fields):
    print("MERGE " + json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def shard_index(folder):
    """Tensor name -> shard file for a safetensors folder (sharded or single file)."""
    idx = os.path.join(folder, "model.safetensors.index.json")
    if os.path.exists(idx):
        with open(idx) as f:
            return json.load(f)["weight_map"]
    from safetensors import safe_open
    with safe_open(os.path.join(folder, "model.safetensors"), "pt") as f:
        return {k: "model.safetensors" for k in f.keys()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--report", default="")
    ap.add_argument("--samples", type=int, default=24, help="targeted tensors whose merge is recomputed by hand")
    a = ap.parse_args()

    import torch
    torch.set_num_threads(os.cpu_count() or 8)
    from peft import PeftModel
    from safetensors import safe_open
    from safetensors.torch import load_file
    from transformers import MuseGlimmerForConditionalGeneration

    began = time.time()
    with open(os.path.join(a.adapter, "adapter_config.json")) as f:
        acfg = json.load(f)
    rank, alpha = int(acfg["r"]), float(acfg["lora_alpha"])
    scale = alpha / rank
    saved = load_file(os.path.join(a.adapter, "adapter_model.safetensors"))
    say("adapter", path=a.adapter, tensors=len(saved), rank=rank, alpha=alpha, scale=scale,
        base_class=acfg.get("auto_mapping", {}).get("base_model_class"), dtypes=sorted({str(v.dtype) for v in saved.values()}))

    model = MuseGlimmerForConditionalGeneration.from_pretrained(a.base, dtype=torch.bfloat16, device_map="cpu", low_cpu_mem_usage=True)
    say("base_loaded", seconds=round(time.time() - began, 1))
    model = PeftModel.from_pretrained(model, a.adapter, is_trainable=False)
    lora = {n: p for n, p in model.named_parameters() if "lora_" in n}
    # PEFT names a loaded weight ...lora_A.default.weight; the file has ...lora_A.weight.
    unmatched = []
    for key, value in saved.items():
        name = re.sub(r"\.(lora_[AB])\.weight$", r".\1.default.weight", key)
        p = lora.get(name)
        if p is None or not torch.equal(p.detach().to(value.dtype), value):
            unmatched.append(key)
    if unmatched or len(saved) != len(lora):
        say("adapter_mismatch", saved=len(saved), lora_weights=len(lora), unmatched=unmatched[:5])
        sys.exit(1)
    # Base module names the adapter touches, as they appear in the base checkpoint (….q_proj.weight).
    targeted = sorted({re.sub(r"^base_model\.model\.", "", k).rsplit(".lora_", 1)[0] + ".weight" for k in saved})
    say("adapter_loaded", lora_weights=len(lora), all_equal=True, targeted_modules=len(targeted),
        sample=targeted[:3], seconds=round(time.time() - began, 1))

    merged = model.merge_and_unload()
    say("merged", seconds=round(time.time() - began, 1))
    os.makedirs(a.out, exist_ok=True)
    merged.save_pretrained(a.out, safe_serialization=True, max_shard_size="5GB")
    for name in COPY_FROM_BASE:
        src = os.path.join(a.base, name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(a.out, name))
    del merged, model
    say("saved", out=a.out, seconds=round(time.time() - began, 1))

    # Tensor-by-tensor comparison of the saved folder against the base checkpoint.
    base_map, out_map = shard_index(a.base), shard_index(a.out)
    problems = []
    if set(base_map) != set(out_map):
        problems.append({"missing": sorted(set(base_map) - set(out_map))[:5], "extra": sorted(set(out_map) - set(base_map))[:5]})
    targeted_set = set(targeted)
    missing_targets = sorted(targeted_set - set(base_map))
    if missing_targets:
        problems.append({"targeted_not_in_base": missing_targets[:5]})
    sample = set(targeted[:: max(1, len(targeted) // max(1, a.samples))][: a.samples])
    stats = {"identical_untargeted": 0, "changed_targeted": 0, "unchanged_targeted": 0, "changed_untargeted": 0}
    changed_fraction, sample_err = [], []
    handles = {}

    def tensor(folder, mapping, key):
        path = os.path.join(folder, mapping[key])
        if path not in handles:
            handles[path] = safe_open(path, "pt")
        return handles[path].get_tensor(key)

    for key in sorted(set(base_map) & set(out_map)):
        b, m = tensor(a.base, base_map, key), tensor(a.out, out_map, key)
        if b.shape != m.shape or b.dtype != m.dtype:
            problems.append({"key": key, "base": [list(b.shape), str(b.dtype)], "merged": [list(m.shape), str(m.dtype)]})
            continue
        same = torch.equal(b, m)
        if key in targeted_set:
            if same:
                stats["unchanged_targeted"] += 1
                problems.append({"key": key, "issue": "targeted but unchanged"})
            else:
                stats["changed_targeted"] += 1
                changed_fraction.append(float((b != m).float().mean()))
            if key in sample:
                stem = "base_model.model." + key[: -len(".weight")]
                delta = (saved[stem + ".lora_B.weight"].float() @ saved[stem + ".lora_A.weight"].float()) * scale
                want = (b.float() + delta)
                err = (m.float() - want).abs()
                # One BF16 step at the largest of |base|, |delta|, |result| for each element: 2^(exponent - 7).
                # PEFT rounds the delta to BF16 and then the sum, so the error stays within that step.
                mag = torch.maximum(torch.maximum(b.float().abs(), delta.abs()), want.abs()).clamp_min(1e-30)
                ulp = torch.pow(2.0, torch.floor(torch.log2(mag)) - 7)
                ratio = float((err / ulp).max())
                sample_err.append({"key": key, "max_err_in_bf16_steps": round(ratio, 3), "delta_abs_mean": float(delta.abs().mean()),
                                   "weight_abs_mean": float(b.float().abs().mean())})
                if ratio > 1.01:
                    problems.append({"key": key, "issue": "merged != base + scale*B@A", "max_err_in_bf16_steps": ratio})
        else:
            if same:
                stats["identical_untargeted"] += 1
            else:
                stats["changed_untargeted"] += 1
                problems.append({"key": key, "issue": "not targeted but changed"})
    report = {
        "base": a.base, "adapter": a.adapter, "out": a.out, "rank": rank, "alpha": alpha, "scale": scale,
        "adapter_tensors": len(saved), "targeted_tensors": len(targeted), "base_tensors": len(base_map), "merged_tensors": len(out_map),
        **stats,
        "changed_fraction_of_elements": {"min": round(min(changed_fraction), 4), "mean": round(sum(changed_fraction) / len(changed_fraction), 4),
                                         "max": round(max(changed_fraction), 4)} if changed_fraction else None,
        "sampled_merge_checks": sample_err, "problems": problems[:20], "ok": not problems,
        "seconds": round(time.time() - began, 1),
    }
    if a.report:
        with open(a.report, "w") as f:
            json.dump(report, f, indent=1)
    say("check", **{k: v for k, v in report.items() if k != "sampled_merge_checks"},
        worst_sample_steps=max((s["max_err_in_bf16_steps"] for s in sample_err), default=None))
    if problems:
        sys.exit(1)


if __name__ == "__main__":
    main()
