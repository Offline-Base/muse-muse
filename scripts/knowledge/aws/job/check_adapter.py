"""Checks, without a GPU or the model, that one saved LoRA adapter has the same layout as another one that is known
to load (train_glimmer.py's KNOWLEDGE_INIT_ADAPTER path): the same rank, alpha and target modules in
adapter_config.json, and the same tensor names, shapes and dtypes in adapter_model.safetensors (read from the file
headers only, so it is quick and light even next to a training run).

    python -I check_adapter.py KNOWN_GOOD_DIR CANDIDATE_DIR
"""

import json
import os
import struct
import sys


def header(path):
    with open(os.path.join(path, "adapter_model.safetensors"), "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        h = json.loads(f.read(n))
    h.pop("__metadata__", None)
    return {k: (v["dtype"], tuple(v["shape"])) for k, v in h.items()}


def config(path):
    with open(os.path.join(path, "adapter_config.json")) as f:
        c = json.load(f)
    return {k: (sorted(c[k]) if isinstance(c.get(k), list) else c.get(k)) for k in ("r", "lora_alpha", "target_modules", "peft_type", "task_type")}


def main(good, cand):
    hg, hc = header(good), header(cand)
    cg, cc = config(good), config(cand)
    problems = []
    if cg != cc:
        problems.append({"config": {"known_good": cg, "candidate": cc}})
    only_good, only_cand = sorted(set(hg) - set(hc)), sorted(set(hc) - set(hg))
    if only_good or only_cand:
        problems.append({"missing_in_candidate": only_good[:5], "extra_in_candidate": only_cand[:5]})
    differ = [k for k in set(hg) & set(hc) if hg[k] != hc[k]]
    if differ:
        problems.append({"shape_or_dtype_differs": [(k, hg[k], hc[k]) for k in sorted(differ)[:5]]})
    print(json.dumps({"known_good": good, "candidate": cand, "tensors": len(hc), "config": cc, "same_layout": not problems, "problems": problems}, indent=1))
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
