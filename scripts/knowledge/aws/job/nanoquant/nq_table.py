"""The results table for a NanoQuant run folder (nq_run.sh's ROOT): one row per scored model.

    python nq_table.py ~/k/models/stage1-nanoquant [--stage-metrics ~/k/runs/stage1/out/metrics.json]
"""

import argparse
import glob
import json
import os


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except OSError:
        return None


def gb(n):
    return f"{n / 1e9:.2f} GB"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--stage-metrics", default="")
    a = ap.parse_args()
    rows = []
    bf = load(os.path.join(a.root, "bf16-merged", "score.json"))
    if bf:
        merged = os.path.join(a.root, "merged-bf16")
        size = sum(os.path.getsize(p) for p in glob.glob(os.path.join(merged, "*.safetensors")))
        rows.append(["BF16 merged (reference)", "16", gb(size), bf, None])
    for d in sorted(glob.glob(os.path.join(a.root, "nq-*")), key=lambda p: -float(p.rsplit("-", 1)[1])):
        q = load(os.path.join(d, "quant.json"))
        s = load(os.path.join(d, "score", "score.json"))
        if not q:
            continue
        b = q["bits"]
        bits = f"{b['bits_per_weight_quantized_layers']:.4f} ({b['bits_per_weight_text_model']:.3f} whole text model)"
        size = f"{gb(q['files']['nq-text.safetensors'])} quantized layers; {gb(q['files']['nq-full.pt'])} with BF16 embeddings, head and vision"
        rows.append([f"NanoQuant {q['bits_target']}", bits, size, s, q])
    print("| Setting | Avg bits per weight (with scales) | Size on disk | Probe accuracy (300) | Old-fact accuracy (40) | WikiText-2 PPL | Decode tok/s, batch 1 (eager / compiled) | Batch-32 gen tok/s |")
    print("|---|---|---|---|---|---|---|---|")
    for name, bits, size, s, q in rows:
        if not s:
            print(f"| {name} | {bits} | {size} | not scored | | | | |")
            continue
        ppl = s.get("wikitext2_ppl", {}).get("ppl")
        eager = s.get("bench", {}).get("decode_tokens_per_second")
        comp = s.get("bench_static", {}).get("decode_tokens_per_second")
        g32 = s["generation"]["probes"]["tokens_per_second_batch32"]
        print(f"| {name} | {bits} | {size} | {s['probe_accuracy']:.1%} ({s['probe_right']}/{s['probes']}) | "
              f"{s['forget_accuracy']:.1%} ({s['forget_right']}/{s['forget_items']}) | {ppl:.3f} | {eager} / {comp or '-'} | {g32} |"
              if ppl is not None else
              f"| {name} | {bits} | {size} | {s['probe_accuracy']:.1%} | {s['forget_accuracy']:.1%} | - | {eager} / {comp or '-'} | {g32} |")
    m = load(a.stage_metrics) if a.stage_metrics else None
    if m:
        print(f"\nStage 1 training's own eval (train_glimmer.py, Unsloth, 1,500 probes): base {m['base_probe_accuracy']:.1%}, "
              f"tuned {m['tuned_probe_accuracy']:.1%}; old facts base {m['base_forget_accuracy']:.0%}, tuned {m['tuned_forget_accuracy']:.0%}.")


if __name__ == "__main__":
    main()
