"""The 2026 knowledge fine-tune of Muse Glimmer 30B, run as a SageMaker training job (docs/KNOWLEDGE_UPDATE.md).

It answers held-out probes with the base model, trains a LoRA (Unsloth, 4-bit base) on the knowledge dataset, then
answers the same probes with the tuned model. It follows the glimmer-lora recipe (lib/train/recipes/glimmer.ts) for
the model, pins, chat-template markers and the final-channel answers, so training texts and eval prompts match.

Inputs: /opt/ml/input/data/data/{train.jsonl, probes.jsonl, forget.jsonl}. Hyperparameters (all optional):
epochs, learning_rate, lora_rank, batch_size, grad_accum, eval_probes, max_examples. Writes the adapter, answers and
metrics.json to /opt/ml/model (S3 as model.tar.gz). Checkpoints go to /opt/ml/checkpoints, which SageMaker syncs to
S3, so a restarted job resumes; the base answers are kept there too, so they aren't paid for twice.

Several GPUs: `torchrun --standalone --nproc_per_node N train_glimmer.py` (job/run_multi.sh) trains data-parallel
with Unsloth's DDP support. Each GPU holds the whole model; batch_size is per GPU, so the effective batch is
batch_size x grad_accum x N (4 x 1 x 8 = 32). Rank 0 alone answers the probes before and after training. Without
torchrun nothing changes.
"""

import json
import os
import random
import re
import time

DEFAULT_MODEL = "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit"
DEFAULT_REVISION = "ecedda395d4d099b477d135a9a573eedaa5a7aad"
# Overrides for other machines (the GH200 has room for a BF16 LoRA: KNOWLEDGE_MODEL=meta-models/Muse-Glimmer-30B,
# KNOWLEDGE_MODEL_REVISION=cec94fcfd6512f2cfe708138c32533b346ea4f69, KNOWLEDGE_4BIT=0). Defaults keep the A100 recipe.
MODEL = os.environ.get("KNOWLEDGE_MODEL", DEFAULT_MODEL)
MODEL_REVISION = os.environ.get("KNOWLEDGE_MODEL_REVISION", DEFAULT_REVISION if MODEL == DEFAULT_MODEL else "main")
LOAD_IN_4BIT = os.environ.get("KNOWLEDGE_4BIT", "1") != "0"
GRAD_CKPT = {"true": True, "false": False}.get(os.environ.get("KNOWLEDGE_GRAD_CKPT", "unsloth"), "unsloth")
INSTRUCTION_PART = "<|start|>user<|message|>"
RESPONSE_PART = "<|start|>assistant to=user<|message|>"
GENERATION_PROMPT = "<|start|>assistant"
FINAL_CHANNEL = RESPONSE_PART[len(GENERATION_PROMPT):]
FINAL_ENDS = ("<|eot|>", "<|eom|>", "<|end_of_text|>")
PAD_TOKEN = "<|finetune_right_pad|>"
REASONING = "low"
MAX_SEQ_LENGTH = 2048
MAX_NEW_TOKENS = 96
GEN_BATCH = 32
SYSTEM = "You are a helpful assistant."
# SageMaker's folders by default; a plain GPU machine (Lambda) sets these.
DATA = os.environ.get("KNOWLEDGE_DATA", "/opt/ml/input/data/data")
OUT = os.environ.get("KNOWLEDGE_OUT", "/opt/ml/model")
CKPT = os.environ.get("KNOWLEDGE_CKPT", "/opt/ml/checkpoints")
HYPER = os.environ.get("KNOWLEDGE_HYPER", "/opt/ml/input/config/hyperparameters.json")
# torchrun sets these; a plain `python train_glimmer.py` leaves them unset and runs on one GPU as before.
WORLD = int(os.environ.get("WORLD_SIZE", "1"))
RANK = int(os.environ.get("RANK", "0"))
LOCAL_RANK = int(os.environ.get("LOCAL_RANK", "0"))
MAIN = RANK == 0


def say(event, **fields):
    if MAIN:
        print("MUSE " + json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def hyper():
    try:
        with open(HYPER) as f:
            raw = json.load(f)
    except OSError:
        raw = {}
    h = {"epochs": 2, "learning_rate": 1e-4, "lora_rank": 64, "batch_size": 8, "grad_accum": 4, "eval_probes": 1500, "max_examples": 0, "base_only": 0, "group_by_length": 0, "packing": 0}
    for k, v in raw.items():
        h[k] = type(h[k])(float(v)) if k in h else v
    return h


def read_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Written whole, then renamed: other ranks wait for base.json to appear and must never see half of it.
    with open(path + ".tmp", "w") as f:
        json.dump(value, f, ensure_ascii=False, indent=1)
    os.replace(path + ".tmp", path)


def normalize(s):
    """lib/knowledge/qa.ts normalizeAnswer: lowercase words, no articles, single spaces, padded."""
    s = re.sub(r"[^a-z0-9]+", " ", s.lower())
    s = re.sub(r"\b(the|a|an)\b", " ", s)
    return " " + re.sub(r"\s+", " ", s).strip() + " "


def answered(reply, probe):
    """lib/knowledge/qa.ts probeAnswered: the reply holds the answer or an alias as whole words."""
    said = normalize(reply)
    return any(len(w) > 0 and (" " + w + " ") in said for w in (normalize(a).strip() for a in [probe["answer"], *probe.get("aliases", [])]))


def final_answer(raw):
    cut = len(raw)
    for token in FINAL_ENDS + ("<|start|>",):
        at = raw.find(token)
        if 0 <= at < cut:
            cut = at
    return raw[:cut].replace(PAD_TOKEN, "").strip()


def main():
    h = hyper()
    say("start", **h)
    from unsloth import FastModel  # Unsloth patches transformers and trl, so it comes first.
    import torch
    from datasets import Dataset
    from trl import SFTConfig, SFTTrainer
    from unsloth.chat_templates import train_on_responses_only

    train_rows = read_jsonl(os.path.join(DATA, "train.jsonl"))
    if h["max_examples"]:
        train_rows = train_rows[: int(h["max_examples"])]
    probes = read_jsonl(os.path.join(DATA, "probes.jsonl"))
    random.Random(7).shuffle(probes)
    probes = probes[: int(h["eval_probes"])]
    forget = read_jsonl(os.path.join(DATA, "forget.jsonl"))
    say("data", train=len(train_rows), probes=len(probes), forget=len(forget))

    say("model", model=MODEL, revision=MODEL_REVISION, load_in_4bit=LOAD_IN_4BIT, gradient_checkpointing=GRAD_CKPT)
    model, tokenizer = FastModel.from_pretrained(
        model_name=MODEL, revision=MODEL_REVISION, max_seq_length=MAX_SEQ_LENGTH, load_in_4bit=LOAD_IN_4BIT,
    )
    rank = int(h["lora_rank"])
    model = FastModel.get_peft_model(
        model, finetune_vision_layers=False, finetune_language_layers=True, finetune_attention_modules=True,
        finetune_mlp_modules=True, r=rank, lora_alpha=rank, lora_dropout=0, bias="none",
        use_gradient_checkpointing=GRAD_CKPT, random_state=3407,
    )
    text_tokenizer = getattr(tokenizer, "tokenizer", tokenizer)
    bos = getattr(tokenizer, "bos_token", None) or getattr(text_tokenizer, "bos_token", None) or ""

    def render(messages, generation):
        text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=generation, reasoning_strength=REASONING)
        return text.removeprefix(bos) if bos else text

    def ready_to_answer():
        if hasattr(FastModel, "for_inference"):
            FastModel.for_inference(model)
        text_tokenizer.padding_side = "left"
        if text_tokenizer.pad_token is None:
            text_tokenizer.pad_token = text_tokenizer.eos_token

    def answer_all(label, items):
        ready_to_answer()
        prompts = []
        for it in items:
            text = render([{"role": "system", "content": SYSTEM}, {"role": "user", "content": it["question"]}], True)
            if not text.endswith(GENERATION_PROMPT):
                raise RuntimeError("Generation prompt doesn't end with " + GENERATION_PROMPT)
            prompts.append(text + FINAL_CHANNEL)
        out_answers = []
        for start in range(0, len(prompts), GEN_BATCH):
            enc = text_tokenizer(prompts[start:start + GEN_BATCH], return_tensors="pt", padding=True)
            with torch.no_grad():
                out = model.generate(
                    input_ids=enc["input_ids"].to("cuda"), attention_mask=enc["attention_mask"].to("cuda"),
                    max_new_tokens=MAX_NEW_TOKENS, do_sample=False, pad_token_id=text_tokenizer.pad_token_id,
                )
            width = enc["input_ids"].shape[1]
            out_answers += [final_answer(text_tokenizer.decode(row[width:], skip_special_tokens=False)) for row in out]
            if (start // GEN_BATCH) % 10 == 0:
                say("answering", model=label, done=len(out_answers), of=len(prompts))
        return [{"question": it["question"], "answer": it["answer"], "reply": r, "right": answered(r, it)} for it, r in zip(items, out_answers)]

    def score(rows):
        return round(sum(r["right"] for r in rows) / max(1, len(rows)), 4)

    base_path = os.path.join(CKPT, "base.json")
    if os.path.exists(base_path):
        with open(base_path) as f:
            base = json.load(f)
        say("base_reused")
    elif MAIN:
        began = time.time()
        base = {"probes": answer_all("base", probes), "forget": answer_all("base", forget), "seconds": round(time.time() - began, 1)}
        write_json(base_path, base)
    else:
        # Rank 0 answers the probes alone. The process group doesn't exist yet (the trainer's arguments create it),
        # so waiting here for its file can't time out, and no collective can pair up with one of rank 0's.
        # The model and tokenizer get the same settings answering gave rank 0, so every rank trains alike.
        ready_to_answer()
        while not os.path.exists(base_path):
            time.sleep(5)
        with open(base_path) as f:
            base = json.load(f)
    say("base", probes=score(base["probes"]), forget=score(base["forget"]))
    # Scores the base model ahead of the run, so training reuses base.json and starts straight away.
    if h["base_only"]:
        return

    if hasattr(FastModel, "for_training"):
        FastModel.for_training(model)
    texts = []
    for row in train_rows:
        text = render(row["messages"], False)
        for m in row["messages"]:
            marker = {"user": INSTRUCTION_PART, "assistant": RESPONSE_PART}.get(m["role"])
            if marker and marker + m["content"] not in text:
                raise RuntimeError("The template didn't put a " + m["role"] + " message right after " + marker + ": " + text[:400])
        texts.append(text)
    from transformers import TrainerCallback

    effective_batch = int(h["batch_size"]) * int(h["grad_accum"]) * WORLD

    class Pace(TrainerCallback):
        """Step times, for the steady training rate (after start-up) and a progress line every 50 steps."""

        def __init__(self):
            self.at = {}

        def on_step_end(self, args, state, control, **kwargs):
            step, t = state.global_step, time.time()
            self.at[step] = t
            if step % 50 == 0 and step - 50 in self.at:
                rate = 50 * effective_batch / max(t - self.at[step - 50], 1e-9)
                say("progress", step=step, of=state.max_steps, examples_per_second=round(rate, 2),
                    eta_minutes=round((state.max_steps - step) * effective_batch / rate / 60, 1))

        def steady(self):
            steps = sorted(self.at)
            if len(steps) < 6:
                return None
            first = steps[len(steps) // 5]
            return round((steps[-1] - first) * effective_batch / max(self.at[steps[-1]] - self.at[first], 1e-9), 2)

    pace = Pace()
    # Under torchrun: every LoRA weight gets a gradient each step, and the long timeout covers rank 0 saving a
    # checkpoint while the others wait.
    distributed = {"ddp_find_unused_parameters": False, "ddp_timeout": 10800} if WORLD > 1 else {}
    trainer = SFTTrainer(
        model=model, tokenizer=tokenizer, train_dataset=Dataset.from_list([{"text": t} for t in texts]), eval_dataset=None,
        args=SFTConfig(
            dataset_text_field="text", max_length=MAX_SEQ_LENGTH, loss_type="nll",
            per_device_train_batch_size=int(h["batch_size"]), gradient_accumulation_steps=int(h["grad_accum"]),
            num_train_epochs=float(h["epochs"]), learning_rate=float(h["learning_rate"]), lr_scheduler_type="cosine",
            warmup_ratio=0.03, optim="adamw_8bit", weight_decay=0.001, logging_steps=10, seed=3407,
            # Batches of similar length waste less on padding; most examples here are short.
            group_by_length=bool(h["group_by_length"]),
            # Several short examples per sequence; the fixed cost of each step is what limits speed here.
            packing=bool(h["packing"]),
            output_dir=CKPT, save_strategy="steps", save_steps=250, save_total_limit=2, report_to="none",
            **distributed,
        ),
        callbacks=[pace],
    )
    trainer = train_on_responses_only(trainer, instruction_part=INSTRUCTION_PART, response_part=RESPONSE_PART)
    first = trainer.train_dataset[0]
    trained = sum(1 for label in first["labels"] if label != -100)
    if not trained:
        raise RuntimeError("train_on_responses_only left nothing to train in the first example")
    say("masking", first_example_trained_tokens=trained, of=len(first["input_ids"]))
    resume = any(d.startswith("checkpoint-") for d in os.listdir(CKPT)) if os.path.isdir(CKPT) else False
    began = time.time()
    stats = trainer.train(resume_from_checkpoint=True if resume else None)
    train_seconds = round(time.time() - began, 1)
    peak = torch.cuda.max_memory_reserved()
    if WORLD > 1:
        # The highest peak on any GPU; then the group is closed, so rank 0's adapter save and answers run alone.
        import torch.distributed as dist
        t = torch.tensor([float(peak)], dtype=torch.float64, device=f"cuda:{LOCAL_RANK}")
        dist.all_reduce(t, op=dist.ReduceOp.MAX)
        peak = int(t.item())
        dist.barrier()
        dist.destroy_process_group()
        if not MAIN:
            return
    steady = pace.steady()
    say("trained", steps=int(trainer.state.global_step or 0), loss=getattr(stats, "training_loss", None), seconds=train_seconds,
        examples_per_second=round(len(train_rows) / max(train_seconds, 1e-9), 2), examples_per_second_steady=steady,
        gpus=WORLD, effective_batch=effective_batch, peak_vram_gb=round(peak / 1024 ** 3, 2))

    adapter = os.path.join(OUT, "adapter")
    model.save_pretrained(adapter)
    tokenizer.save_pretrained(adapter)
    tuned = {"probes": answer_all("tuned", probes), "forget": answer_all("tuned", forget)}
    write_json(os.path.join(OUT, "answers.json"), {"base": base, "tuned": tuned})
    metrics = {
        "train_examples": len(train_rows), "probes": len(probes), "forget_items": len(forget),
        "base_probe_accuracy": score(base["probes"]), "tuned_probe_accuracy": score(tuned["probes"]),
        "base_forget_accuracy": score(base["forget"]), "tuned_forget_accuracy": score(tuned["forget"]),
        "steps": int(trainer.state.global_step or 0), "train_loss": getattr(stats, "training_loss", None),
        "train_seconds": train_seconds, "peak_vram_gb": round(peak / 1024 ** 3, 2),
        "gpu": torch.cuda.get_device_name(0), "hyperparameters": h, "model": MODEL, "revision": MODEL_REVISION,
        "load_in_4bit": LOAD_IN_4BIT, "gradient_checkpointing": GRAD_CKPT,
        "train_examples_per_second": round(len(train_rows) / max(train_seconds, 1e-9), 2),
        "train_examples_per_second_steady": steady, "gpus": WORLD, "effective_batch": effective_batch,
    }
    write_json(os.path.join(OUT, "metrics.json"), metrics)
    say("done", **{k: metrics[k] for k in ("base_probe_accuracy", "tuned_probe_accuracy", "base_forget_accuracy", "tuned_forget_accuracy")})


if __name__ == "__main__":
    main()
