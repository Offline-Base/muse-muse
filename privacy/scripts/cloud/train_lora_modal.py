"""QLoRA for the Glimmer router on one Modal H100, returned as a GGUF LoRA. Costs money: needs Ethan's go-ahead.

Dreaming's lora backend writes a training JSONL; this script trains a LoRA on Glimmer from it with
transformers + peft (4-bit base, bf16 compute), converts the adapter with llama.cpp's
convert_lora_to_gguf.py, and writes the .gguf locally. The dreaming gate decides whether to keep it.

    uv run python scripts/cloud/train_lora_modal.py --check --data train.jsonl          # no compute
    uv run --with modal python scripts/cloud/train_lora_modal.py --run --data train.jsonl

Each JSONL line is either
    {"messages": [{"role": "system", ...}, {"role": "user", ...}, {"role": "assistant", ...}], "weight": 3}
or a dreaming example
    {"request": ..., "result_kind": ..., "tagged_text": ..., "label": "refuse", "weight": 1}

--check and --run refuse a file with an email, phone number, SSN or card number, or a name from the
roster, in any line. modal is imported only for --run.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LLAMA_CPP_REF = "b10353"
GPU = "H100"
DECISIONS = ("share_tagged", "share_summary", "ask_user", "refuse")
DEFAULT_BASE = "meta-models/Muse-Glimmer-30B"  # Hugging Face repo with the bf16 weights

IDENTIFIERS = {
    "email": re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
    "phone": re.compile(r"(?<!\d)(?:\+1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)"),
    "ssn": re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)"),
    "card": re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)"),
}


def target_modules(value: str):
    """A regex string (peft matches it on full module names) or a list of name suffixes."""
    return value if any(ch in value for ch in "().*$^|") else [m.strip() for m in value.split(",") if m.strip()]


def split_labels(tok, full: str, prefix: str, max_len: int) -> tuple[list[int], list[int]]:
    """Token ids for `full` and labels that train only on what comes after `prefix`."""
    if not full.startswith(prefix):
        raise ValueError("the chat template does not extend the generation prompt")
    full_ids = tok(full, add_special_tokens=False)["input_ids"]
    n_prefix = len(tok(prefix, add_special_tokens=False)["input_ids"])
    labels = [-100] * n_prefix + full_ids[n_prefix:]
    return full_ids[-max_len:], labels[-max_len:]


def router_messages(row: dict) -> list[dict]:
    """Turn a dreaming example into a chat. dreaming/train.py should prefer writing `messages`."""
    return [
        {"role": "system", "content": "Reasoning strength: low\nYou are the privacy router on the user's device. "
         "Decide how this result may leave for Muse: share_tagged, share_summary, ask_user or refuse. "
         "Answer with JSON {\"decision\": ..., \"reason\": ...}."},
        {"role": "user", "content": f"Request: {row['request']}\nResult kind: {row['result_kind']}\n"
         f"Result (tagged):\n{row['tagged_text']}"},
        {"role": "assistant", "content": json.dumps({"decision": row["label"], "reason": "Learned from your decisions."})},
    ]


def roster_names(path: Path) -> list[str]:
    try:
        roster = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    names: list[str] = []
    for p in [roster.get("teacher") or {}, *(roster.get("students") or [])]:
        names += [n for n in (p.get("name"), p.get("first"), p.get("last"), *(p.get("nicknames") or [])) if n]
    return names


def _strings(value) -> list[str]:
    """Every string inside a decoded JSON value."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [t for v in value.values() for t in _strings(v)]
    if isinstance(value, list):
        return [t for v in value for t in _strings(v)]
    return []


def guard_checker(roster_path: Path, tagmap_path: Path | None):
    """base.guard.leaks with the roster (and the device's tag map when given): lowercase names,
    slugs, Unicode dashes and spellings the plain regexes here miss. None if base is not importable."""
    sys.path.insert(0, str(REPO))
    try:
        from base import guard
    except Exception:
        return None
    try:
        roster = guard.load_roster(roster_path)
    except (OSError, ValueError, KeyError):
        roster = None
    tagmap = guard.TagMap.load(tagmap_path) if tagmap_path and Path(tagmap_path).is_file() else None
    return lambda text: [h.kind for h in guard.leaks(text, roster, tagmap)]


def load_rows(
    path: Path, names: list[str], checker=None
) -> tuple[list[dict], list[str], dict[str, int]]:
    """Validate the JSONL. Returns (examples as {messages, weight}, problems, label counts).

    Each line is decoded first, so escaped non-ASCII (a phone with U+2011 dashes, a name with an
    accent) is checked as the text it really is, then NFKC-normalized.
    """
    rows: list[dict] = []
    problems: list[str] = []
    labels: dict[str, int] = {}
    name_res = [re.compile(rf"(?<![^\W\d_]){re.escape(n)}(?![^\W\d_])", re.IGNORECASE)
                for n in sorted(set(names), key=len, reverse=True)]
    try:
        lines = path.read_text().splitlines()
    except OSError as exc:
        return [], [f"cannot read {path.name} ({type(exc).__name__})"], {}
    for n, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError:
            problems.append(f"line {n}: not JSON")
            continue
        text = unicodedata.normalize("NFKC", "\n".join(_strings(row))).replace("_", " ")
        text = re.sub(r"[\u2010-\u2015\u2212]", "-", text)
        for kind, rx in IDENTIFIERS.items():
            if rx.search(text):
                problems.append(f"line {n}: looks like it holds a {kind}")
        if any(rx.search(text) for rx in name_res):
            problems.append(f"line {n}: holds a roster name")
        if checker is not None:
            found = sorted(set(checker(text)))
            if found:
                problems.append(f"line {n}: the guard found {', '.join(found)}")
        weight = row.get("weight", 1)
        if not isinstance(weight, int | float) or weight <= 0:
            problems.append(f"line {n}: weight must be a positive number")
            continue
        if "messages" in row:
            msgs = row["messages"]
            ok = isinstance(msgs, list) and len(msgs) >= 2 and all(
                isinstance(m, dict) and m.get("role") in ("system", "user", "assistant") and isinstance(m.get("content"), str)
                for m in msgs)
            if not ok or msgs[-1]["role"] != "assistant":
                problems.append(f"line {n}: messages must be role/content pairs ending with the assistant")
                continue
            try:
                label = json.loads(msgs[-1]["content"]).get("decision", "?")
            except (ValueError, AttributeError):
                label = "?"
        else:
            missing = [k for k in ("request", "result_kind", "tagged_text", "label") if not isinstance(row.get(k), str)]
            if missing:
                problems.append(f"line {n}: missing {', '.join(missing)}")
                continue
            if row["label"] not in DECISIONS:
                problems.append(f"line {n}: label must be one of {', '.join(DECISIONS)}")
                continue
            label, msgs = row["label"], router_messages(row)
        labels[label] = labels.get(label, 0) + 1
        rows.append({"messages": msgs, "weight": float(weight)})
    if not rows and not problems:
        problems.append(f"{path.name} has no examples")
    return rows, problems, labels


def remote_train(rows: list[dict], config: dict) -> bytes:
    """Runs on the GPU: QLoRA on the base model, then convert the adapter to GGUF."""
    import random
    import subprocess

    import torch
    from huggingface_hub import snapshot_download
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    base_dir = snapshot_download(config["base_model"], cache_dir="/cache")
    tok = AutoTokenizer.from_pretrained(base_dir, trust_remote_code=config["trust_remote_code"])
    model = AutoModelForCausalLM.from_pretrained(
        base_dir,
        quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                               bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True),
        torch_dtype=torch.bfloat16,
        device_map={"": 0},
        trust_remote_code=config["trust_remote_code"],
    )
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    model = get_peft_model(model, LoraConfig(r=config["rank"], lora_alpha=2 * config["rank"], lora_dropout=0.05,
                                             target_modules=config["target_modules"], task_type="CAUSAL_LM"))

    def encode(messages: list[dict]) -> tuple[list[int], list[int]]:
        # The whole chat from Glimmer's own template, so the answer carries the same header and end
        # token ("<|start|>assistant to=user<|message|>...<|eot|>") that llama-server parses.
        full = tok.apply_chat_template(messages, tokenize=False)
        prefix = tok.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True)
        return split_labels(tok, full, prefix, config["max_len"])

    data = [(*encode(r["messages"]), r["weight"]) for r in rows]
    params = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(params, lr=config["lr"])
    accum = config["grad_accum"]
    random.seed(0)
    model.train()
    step = 0
    for epoch in range(config["epochs"]):
        random.shuffle(data)
        total = 0.0
        for i, (ids, labels, weight) in enumerate(data, 1):
            batch = torch.tensor([ids], device="cuda")
            out = model(input_ids=batch, labels=torch.tensor([labels], device="cuda"))
            (out.loss * weight / accum).backward()
            total += out.loss.item()
            if i % accum == 0 or i == len(data):
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                optimizer.step()
                optimizer.zero_grad()
                step += 1
        print(f"epoch {epoch + 1}: mean loss {total / len(data):.4f}, {step} optimizer steps", flush=True)

    model.save_pretrained("/tmp/adapter")
    subprocess.run([sys.executable, "/llama.cpp/convert_lora_to_gguf.py", "--base", base_dir, "--outtype", "f16",
                    "--outfile", "/tmp/router.gguf", "/tmp/adapter"], check=True)
    return Path("/tmp/router.gguf").read_bytes()


def build_app():
    """Define the Modal app. Only called for --run, so modal is not needed otherwise."""
    import modal

    image = (
        modal.Image.debian_slim(python_version="3.12")
        .apt_install("git")
        .pip_install("torch", "transformers", "peft", "bitsandbytes", "accelerate", "huggingface_hub",
                     "sentencepiece", "protobuf", "numpy", "safetensors")
        .run_commands(
            f"git clone --depth 1 --branch {LLAMA_CPP_REF} https://github.com/ggml-org/llama.cpp /llama.cpp",
            "pip install /llama.cpp/gguf-py",
        )
    )
    cache = modal.Volume.from_name("muse-privacy-hf-cache", create_if_missing=True)
    app = modal.App("muse-privacy-train-lora")
    fn = app.function(image=image, gpu=GPU, timeout=4 * 3600, volumes={"/cache": cache},
                      secrets=[modal.Secret.from_name("huggingface")], serialized=True)(remote_train)
    return app, fn


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="QLoRA router adapter for Glimmer on Modal (paid; needs Ethan's go-ahead).")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="validate the training file locally; no network, no compute")
    mode.add_argument("--run", action="store_true", help="train on Modal (costs money)")
    parser.add_argument("--data", help="training JSONL written by dreaming (lora backend)")
    parser.add_argument("--roster", default=os.environ.get("ROSTER_PATH", str(REPO / "eval" / "roster.json")),
                        help="names that must not appear (default: ROSTER_PATH or eval/roster.json)")
    parser.add_argument("--out", default=str(Path(os.environ.get("BASE_HOME", "~/.base")) / "adapters" / "router-candidate.gguf"),
                        help="where to write the adapter (default: BASE_HOME/adapters/router-candidate.gguf)")
    parser.add_argument("--base-model", default=DEFAULT_BASE)
    parser.add_argument("--trust-remote-code", action="store_true", help="allow the base model's own Python code")
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--grad-accum", type=int, default=8)
    parser.add_argument("--max-len", type=int, default=2048)
    # Language-model attention only: the bare suffixes also match the vision tower's q/k/v_proj.
    parser.add_argument("--target-modules", default=r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj)$",
                        help="a regex peft matches against module names, or a comma list of suffixes")
    parser.add_argument("--tagmap", default=str(Path(os.environ.get("BASE_HOME", "~/.base")) / "tagmap.json"),
                        help="the device's tag map, so names the model pass found are checked too")
    args = parser.parse_args(argv)
    if not (args.check or args.run):
        parser.print_help()
        return 0
    if not args.data:
        parser.error("--data is required")

    checker = guard_checker(Path(args.roster), Path(args.tagmap).expanduser() if args.tagmap else None)
    if checker is None:
        print("problem: base.guard could not be imported, so the file cannot be checked", file=sys.stderr)
        return 1
    rows, problems, labels = load_rows(Path(args.data), roster_names(Path(args.roster)), checker)
    print(f"examples: {len(rows)}, by label: {json.dumps(labels, sort_keys=True)}")
    print(f"total weight: {sum(r['weight'] for r in rows):g}, epochs: {args.epochs}, base: {args.base_model}, GPU: {GPU}")
    if problems:
        for p in problems[:50]:
            print(f"problem: {p}", file=sys.stderr)
        return 1
    if args.check:
        print("training file ok")
        return 0

    config = {
        "base_model": args.base_model, "trust_remote_code": args.trust_remote_code, "epochs": args.epochs,
        "rank": args.rank, "lr": args.lr, "grad_accum": args.grad_accum, "max_len": args.max_len,
        "target_modules": target_modules(args.target_modules),
    }
    app, fn = build_app()
    with app.run():
        adapter = fn.remote(rows, config)
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(adapter)
    print(f"wrote {out} ({len(adapter) / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
