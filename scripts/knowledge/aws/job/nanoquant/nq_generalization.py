"""How far does a NanoQuant Glimmer drift from its BF16 model on text it was not calibrated on?

KL(BF16 || quantized) per token, on three sets of 2048-token rows: the first rows of the calibration set, training
examples the calibration never used (same rendering, later in the same seeded order), and WikiText-2 test text.
A small KL on the first set and a large one on the others means the tuning fit the calibration text more than the
model. Uses NanoQuant's PyTorch path (same weights as the kernels, faster for whole rows).

    python nq_generalization.py --merged MERGED_DIR --base BASE_DIR --calib-cache calib.pt --train-jsonl train.jsonl \
        --nq 0.8=nq-0.8/nq-text.safetensors --nq 0.55=nq-0.55/nq-text.safetensors --rows 16 --out generalization.json
"""

import argparse
import json
import os
import random
import sys

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nq_glimmer as nqg  # noqa: E402


def held_out_rows(tok, jsonl, used, n, seqlen, seed):
    """The same seeded order build_calibration uses, skipping the examples the calibration took."""
    with open(jsonl) as f:
        rows = [json.loads(line) for line in f if line.strip()]
    order = list(range(len(rows)))
    random.Random(seed).shuffle(order)
    out, cur = [], []
    for k in order[used:]:
        ids = tok(nqg.render(tok, rows[k]["messages"], False), add_special_tokens=True).input_ids
        cur += ids[: seqlen - len(cur)]
        if len(cur) == seqlen:
            out.append(cur)
            cur = []
            if len(out) == n:
                return torch.tensor(out, dtype=torch.long)
    raise RuntimeError("ran out of examples")


def wikitext_rows(tok, n, seqlen):
    import datasets
    text = "\n\n".join(datasets.load_dataset("Salesforce/wikitext", "wikitext-2-raw-v1", split="test")["text"])
    ids = tok(text, return_tensors="pt", add_special_tokens=False).input_ids[0]
    width = seqlen - 1
    rows = [torch.cat([torch.tensor([tok.bos_token_id]), ids[i * width:(i + 1) * width]]) for i in range(n)]
    return torch.stack(rows).long()


@torch.no_grad()
def logits_of(model, rows):
    return [model(input_ids=rows[j:j + 1].cuda(), use_cache=False).logits[0].to(torch.bfloat16).cpu() for j in range(rows.shape[0])]


@torch.no_grad()
def kl_to(model, rows, teacher):
    """Mean per-token KL(teacher || model), and how often the two agree on the top token."""
    kls, agree = [], []
    for j in range(rows.shape[0]):
        s = model(input_ids=rows[j:j + 1].cuda(), use_cache=False).logits[0].float()
        t = teacher[j].cuda().float()
        lt, ls = torch.log_softmax(t, -1), torch.log_softmax(s, -1)
        kls.append(float((lt.exp() * (lt - ls)).sum(-1).mean()))
        agree.append(float((t.argmax(-1) == s.argmax(-1)).float().mean()))
    return {"kl_per_token": round(sum(kls) / len(kls), 4), "top_token_agreement": round(sum(agree) / len(agree), 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--merged", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--calib-cache", required=True)
    ap.add_argument("--train-jsonl", required=True)
    ap.add_argument("--nq", action="append", required=True, help="label=file")
    ap.add_argument("--rows", type=int, default=16)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    torch.backends.cuda.enable_cudnn_sdp(False)
    tok = nqg.load_tokenizer(a.merged)
    saved = torch.load(a.calib_cache, map_location="cpu", weights_only=False)
    calib, info = saved["ids"], saved["info"]
    seqlen = calib.shape[1]
    sets = {"calibration_rows": calib[: a.rows],
            "held_out_training_text": held_out_rows(tok, a.train_jsonl, info["examples_used"], a.rows, seqlen, info["seed"]),
            "wikitext2_test": wikitext_rows(tok, a.rows, seqlen)}
    bf = nqg.load_bf16(a.merged).cuda()
    teacher = {k: logits_of(bf, v) for k, v in sets.items()}
    del bf
    torch.cuda.empty_cache()
    report = {"rows_per_set": a.rows, "seqlen": seqlen, "models": {}}
    for spec in a.nq:
        label, path = spec.split("=", 1)
        from safetensors.torch import load_file
        model = nqg.load_bf16(a.base)
        nqg.install_quantized(model, load_file(path))
        model.cuda()
        report["models"][label] = {k: kl_to(model, sets[k], teacher[k]) for k in sets}
        nqg.say("generalization", label=label, **report["models"][label])
        del model
        torch.cuda.empty_cache()
    with open(a.out, "w") as f:
        json.dump(report, f, indent=1)


if __name__ == "__main__":
    main()
