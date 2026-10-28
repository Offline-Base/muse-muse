/**
 * The glimmer-lora recipe's Python (docs/TRAINING.md, "glimmer-lora recipe"): a LoRA fine-tune of Muse Glimmer 30B
 * (4-bit) with Unsloth on one dataset, with the held-out prompts answered by the base and the tuned model as eval
 * items. It follows Unsloth's Muse Glimmer guide and its Conversational notebook for the install pins, the model, the
 * ATEM chat template, the LoRA targets, the SFT trainer and train-on-responses-only. Never put a dollar sign followed
 * by an opening brace, or a backtick, in the Python: this is a template literal.
 *
 * The runner imports this file with the system python (standard library only). The heavy work runs in a child process,
 * this same file run as "python recipe.py --child config.json" inside a uv venv kept on the cache filesystem, so the
 * venv and the weights (HF_HOME) are reused by the next job in the region. Params: datasetId, maxSteps, learningRate,
 * loraRank, dryRun (1 skips the venv, the model and the GPU and fakes the answers, for tests).
 */
export const GLIMMER_PY = String.raw`"""Muse Glimmer LoRA: fine-tunes Muse Glimmer 30B with Unsloth and answers held-out prompts before and after."""

import hashlib
import json
import math
import os
import shlex
import shutil
import sys
import tarfile
import time

MODEL = "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit"
# The Conversational notebook's install cell, as uv pip installs. Changing any line makes a new venv.
INSTALL = (
    "torch torchvision torchaudio xformers --index-url https://download.pytorch.org/whl/cu128",
    "unsloth",
    "--no-deps --upgrade 'torchao>=0.16.0'",
    "transformers==5.15.0",
    "--no-deps trl==0.22.2",
)
TRANSFORMERS_VERSION = "5.15.0"
PYTHON = "3.12"
UV_INSTALLER = "https://astral.sh/uv/install.sh"
READY_MARKER = ".muse-ready"
# The ATEM markers the notebook passes to train_on_responses_only.
INSTRUCTION_PART = "<|start|>user<|message|>"
RESPONSE_PART = "<|start|>assistant to=user<|message|>"
USER_CHANNEL = "to=user<|message|>"
STOP_MARKERS = ("<|eot|>", "<|eom|>", "<|end_of_text|>", "<|start|>")
NO_ANSWER = "[no final answer within 512 new tokens]"
# Reasoning tokens count against max_new_tokens, and the template defaults to high, so both the training text and the
# eval prompts use low.
REASONING = "low"
MAX_SEQ_LENGTH = 2048
MAX_NEW_TOKENS = 512
GEN_BATCH = 8
PROGRESS_EVERY = 10
EVAL_MAX = 60
EVENT_PREFIX = "MUSE_EVENT "
UPLOAD_MAX_BYTES = 1024 * 1024 * 1024
JOB_DIR = "/opt/muse"


def number(params, key, fallback):
    try:
        value = float(params.get(key, fallback))
    except (TypeError, ValueError):
        return float(fallback)
    return value if math.isfinite(value) else float(fallback)


def read_params(params):
    dataset_id = str(params.get("datasetId") or "").strip()
    if not dataset_id:
        raise ValueError("datasetId is required")
    p = {
        "dataset_id": dataset_id,
        "max_steps": int(min(2000, max(10, round(number(params, "maxSteps", 120))))),
        "learning_rate": number(params, "learningRate", 0.0002),
        "lora_rank": int(min(128, max(4, round(number(params, "loraRank", 16))))),
        "dry_run": number(params, "dryRun", 0) >= 1,
    }
    if not (0 < p["learning_rate"] <= 0.01):
        raise ValueError("learningRate must be above 0 and at most 0.01")
    return p


def writable(path):
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, ".muse-write-" + str(os.getpid()))
        with open(probe, "w") as f:
            f.write("ok")
        os.remove(probe)
        return True
    except OSError:
        return False


def base_dir(ctx):
    """(folder, cached): the cache filesystem, or the job folder (/opt/muse on the instance) without a usable cache."""
    if ctx.cache_dir and writable(ctx.cache_dir):
        return ctx.cache_dir, True
    if ctx.cache_dir:
        ctx.log("The cache folder " + ctx.cache_dir + " isn't writable, so this job runs without the cache")
    parent = os.path.dirname(os.path.abspath(ctx.work_dir))
    return parent or JOB_DIR, False


def train_examples(items):
    """The dataset's well-formed conversations: a messages list of role and content strings with an assistant turn."""
    out = []
    for item in items:
        messages = item.get("messages") if isinstance(item, dict) else None
        if not isinstance(messages, list):
            continue
        clean = [
            {"role": m["role"], "content": m["content"]}
            for m in messages
            if isinstance(m, dict) and m.get("role") in ("system", "user", "assistant") and isinstance(m.get("content"), str)
        ]
        if any(m["role"] == "assistant" for m in clean):
            out.append({"messages": clean})
    return out


def shared_system(train):
    """The system message every training conversation starts with, or None when they don't share one.

    The eval prompts are answered under it too, so the base and the tuned model see what training saw.
    """
    found = None
    for row in train:
        first = row["messages"][0] if row["messages"] else None
        text = first["content"] if first and first["role"] == "system" else None
        if text is None or (found is not None and text != found):
            return None
        found = text
    return found


def eval_examples(items):
    out = []
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("prompt"), str) and item["prompt"].strip():
            out.append({"prompt": item["prompt"], "reference": str(item.get("reference") or "")})
    return out[:EVAL_MAX]


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def venv_name():
    spec = "\n".join((PYTHON,) + INSTALL)
    return "glimmer-" + hashlib.sha256(spec.encode("utf-8")).hexdigest()[:12]


def uv_binary(ctx, base):
    """uv from PATH, or installed once into the cache with Astral's installer (no shell profile changes)."""
    found = shutil.which("uv")
    if found:
        return found
    folder = os.path.join(base, "uv", "bin")
    path = os.path.join(folder, "uv")
    if os.access(path, os.X_OK):
        return path
    os.makedirs(folder, exist_ok=True)
    cmd = "curl -LsSf " + UV_INSTALLER + " | env UV_UNMANAGED_INSTALL=" + shlex.quote(folder) + " sh"
    ctx.run(cmd, timeout=600, check=True)
    return path


def ensure_venv(ctx, base):
    """The venv's python and whether it was reused. A new venv is built aside and renamed into place once it works."""
    venv = os.path.join(base, "venvs", venv_name())
    python = os.path.join(venv, "bin", "python")
    if os.path.isfile(os.path.join(venv, READY_MARKER)) and os.path.exists(python):
        return python, True
    ctx.progress(message="Installing Unsloth into a new venv")
    uv = uv_binary(ctx, base)
    building = venv + ".building-" + str(ctx.job_id or "job")[:8]
    shutil.rmtree(building, ignore_errors=True)
    env = {
        # The interpreter lives in the cache too, since the venv points at it.
        "UV_PYTHON_INSTALL_DIR": os.path.join(base, "uv", "python"),
        "UV_CACHE_DIR": os.path.join(ctx.work_dir, "uv-cache"),
        "UV_LINK_MODE": "copy",
    }
    q = shlex.quote
    # A uv-managed interpreter, so a cached venv never points at one image's system python.
    venv_cmd = q(uv) + " venv --relocatable --python-preference only-managed --python " + PYTHON + " " + q(building)
    ctx.run(venv_cmd, timeout=900, check=True, env=env)
    target = q(os.path.join(building, "bin", "python"))
    for line in INSTALL:
        ctx.run(q(uv) + " pip install --python " + target + " " + line, timeout=2400, check=True, env=env)
    check = "import transformers, trl, peft, bitsandbytes; print(transformers.__version__)"
    out = ctx.run(target + " -c " + q(check), timeout=600, check=True)
    if TRANSFORMERS_VERSION not in (out.stdout or ""):
        raise RuntimeError("The venv has the wrong transformers: " + (out.stdout or "")[-200:])
    with open(os.path.join(building, READY_MARKER), "w") as f:
        f.write(json.dumps({"install": INSTALL, "python": PYTHON, "at": int(time.time())}))
    if os.path.isdir(venv):
        shutil.rmtree(venv, ignore_errors=True)
    try:
        os.rename(building, venv)
    except OSError:
        # Another job in the region finished the same venv first.
        if not os.path.isfile(os.path.join(venv, READY_MARKER)):
            raise
        shutil.rmtree(building, ignore_errors=True)
    return python, False


def weights_cached(hf_home):
    snapshots = os.path.join(hf_home, "hub", "models--" + MODEL.replace("/", "--"), "snapshots")
    return os.path.isdir(snapshots) and any(os.scandir(snapshots))


def relay(ctx):
    """The ctx.run on_line hook: the child's MUSE_EVENT lines become progress events, and nothing else does."""

    def on_line(line):
        if not line.startswith(EVENT_PREFIX):
            return
        event = json.loads(line[len(EVENT_PREFIX):])
        if event.get("kind") == "progress":
            ctx.progress(step=event.get("step"), total_steps=event.get("total"), loss=event.get("loss"), message=event.get("message"))
        elif event.get("kind") == "phase":
            ctx.progress(message=str(event.get("message") or "")[:200])

    return on_line


def archive(adapter_dir, path):
    with tarfile.open(path, "w:gz") as tar:
        tar.add(adapter_dir, arcname="adapter")
    return os.path.getsize(path)


def upload_adapter(ctx, adapter_dir, metrics):
    """Uploads the adapter folder as one tar.gz. A failed or skipped upload is logged; the adapter stays in the cache."""
    name = "glimmer-lora-" + str(ctx.job_id or "job")[:8] + ".tar.gz"
    path = os.path.join(ctx.work_dir, name)
    try:
        size = archive(adapter_dir, path)
        metrics["adapter_mb"] = round(size / 1e6, 1)
        if size > UPLOAD_MAX_BYTES:
            ctx.log("The adapter archive is over 1 GB, so it was kept in " + adapter_dir + " and not uploaded")
            metrics["adapter_uploaded"] = "no"
            return
        url = ctx.upload(path, name, "adapter")
    except Exception as e:
        ctx.log("Uploading the adapter failed (" + type(e).__name__ + ": " + str(e)[:300] + "); it is kept in " + adapter_dir)
        metrics["adapter_uploaded"] = "no"
        return
    metrics["adapter_uploaded"] = "yes" if url else "no"
    if url:
        metrics["adapter_url"] = url


def fake_answer(kind, index, prompt):
    digest = hashlib.sha256((kind + ":" + prompt).encode("utf-8")).hexdigest()[:8]
    return "Dry run " + kind + " answer " + str(index) + " (" + digest + ")"


def dry_run(ctx, p, evals, adapter_dir):
    """Everything but the model: progress ticks, deterministic answers and a stand-in adapter folder."""
    total = p["max_steps"]
    every = max(PROGRESS_EVERY, PROGRESS_EVERY * math.ceil(total / 300.0))
    for step in range(every, total + 1, every):
        ctx.progress(step=step, total_steps=total, loss=round(2.0 * 0.99 ** step, 4))
    if total % every:
        ctx.progress(step=total, total_steps=total, loss=round(2.0 * 0.99 ** total, 4))
    os.makedirs(adapter_dir, exist_ok=True)
    with open(os.path.join(adapter_dir, "adapter_config.json"), "w") as f:
        json.dump({"dry_run": True, "base_model_name_or_path": MODEL, "r": p["lora_rank"], "lora_alpha": p["lora_rank"]}, f)
    return {
        "base": [fake_answer("base", i, e["prompt"]) for i, e in enumerate(evals)],
        "tuned": [fake_answer("tuned", i, e["prompt"]) for i, e in enumerate(evals)],
        "metrics": {"train_loss_final": round(2.0 * 0.99 ** total, 4), "steps": total, "train_seconds": 0, "peak_vram_gb": 0},
    }


def real_run(ctx, p, base, train_path, eval_path, adapter_dir, started, system):
    hf_home = os.path.join(base, "hf")
    os.makedirs(hf_home, exist_ok=True)
    python, venv_reused = ensure_venv(ctx, base)
    cached = weights_cached(hf_home)
    ctx.log("venv " + ("reused" if venv_reused else "installed") + ", weights " + ("cached" if cached else "not cached yet"))
    result_path = os.path.join(ctx.work_dir, "glimmer-result.json")
    config = {
        "model": MODEL,
        "max_seq_length": MAX_SEQ_LENGTH,
        "max_steps": p["max_steps"],
        "learning_rate": p["learning_rate"],
        "lora_rank": p["lora_rank"],
        "train_path": train_path,
        "eval_path": eval_path,
        "system": system,
        "result_path": result_path,
        "adapter_dir": adapter_dir,
        "output_dir": os.path.join(ctx.work_dir, "outputs"),
    }
    config_path = os.path.join(ctx.work_dir, "glimmer-config.json")
    with open(config_path, "w") as f:
        json.dump(config, f)
    env = {"HF_HOME": hf_home, "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false"}
    budget = float(ctx.max_minutes or 120) * 60 - (time.time() - started) - 300
    cmd = shlex.quote(python) + " -u " + shlex.quote(os.path.abspath(__file__)) + " --child " + shlex.quote(config_path)
    ctx.run(cmd, timeout=max(600, int(budget)), check=True, env=env, on_line=relay(ctx))
    with open(result_path, encoding="utf-8") as f:
        result = json.load(f)
    result["metrics"]["cached_weights"] = "yes" if cached else "no"
    result["metrics"]["cached_venv"] = "yes" if venv_reused else "no"
    return result


def run(ctx):
    started = time.time()
    p = read_params(ctx.params)
    ctx.progress(message="Fetching the dataset")
    train = train_examples(ctx.dataset("train"))
    evals = eval_examples(ctx.dataset("eval"))
    if not train:
        raise RuntimeError("The dataset has no usable training conversations")
    system = shared_system(train)
    ctx.log(
        "dataset " + p["dataset_id"] + ": " + str(len(train)) + " training conversations, " + str(len(evals))
        + " eval prompts, answered " + ("under the dataset's system message" if system else "with no system message")
    )
    base, cache_used = base_dir(ctx)
    adapter_dir = os.path.join(base, "models", str(ctx.job_id or "job"))
    train_path = os.path.join(ctx.work_dir, "train.jsonl")
    eval_path = os.path.join(ctx.work_dir, "eval.jsonl")
    write_jsonl(train_path, train)
    write_jsonl(eval_path, evals)

    if p["dry_run"]:
        result = dry_run(ctx, p, evals, adapter_dir)
        result["metrics"].update({"cached_weights": "no", "cached_venv": "no", "dry_run": "yes"})
    else:
        result = real_run(ctx, p, base, train_path, eval_path, adapter_dir, started, system)

    base_answers, tuned_answers = result["base"], result["tuned"]
    if len(base_answers) != len(evals) or len(tuned_answers) != len(evals):
        raise RuntimeError("The model answered " + str(len(base_answers)) + " and " + str(len(tuned_answers)) + " of " + str(len(evals)) + " eval prompts")
    ctx.progress(message="Sending " + str(len(evals)) + " eval items")
    sent = 0
    for i, item in enumerate(evals):
        if ctx.eval(i, item["prompt"], item["reference"], base_answers[i], tuned_answers[i]):
            sent += 1

    metrics = dict(result["metrics"])
    metrics["cache_used"] = "yes" if cache_used else "no"
    metrics["eval_items"] = sent
    metrics["train_examples"] = len(train)
    metrics["adapter_dir"] = adapter_dir
    upload_adapter(ctx, adapter_dir, metrics)
    loss = metrics.get("train_loss_final")
    metrics["summary"] = (
        ("Dry run: " if p["dry_run"] else "")
        + "LoRA r=" + str(p["lora_rank"]) + " on Muse Glimmer 30B, " + str(metrics.get("steps")) + " steps"
        + (", final loss " + str(round(loss, 4)) if isinstance(loss, (int, float)) else "")
        + ", " + str(sent) + " eval items."
    )
    return metrics


# ---------------------------------------------------------------------------------------------------------------
# The child process: runs inside the venv, with the GPU. Prints MUSE_EVENT lines that the parent turns into progress.


def emit(kind, **fields):
    fields["kind"] = kind
    sys.stdout.write(EVENT_PREFIX + json.dumps(fields) + "\n")
    sys.stdout.flush()


def final_answer(raw):
    """The text the model sent on the to=user channel, without the to=self reasoning before it."""
    at = raw.rfind(USER_CHANNEL)
    if at < 0:
        return NO_ANSWER
    text = raw[at + len(USER_CHANNEL):]
    for stop in STOP_MARKERS:
        cut = text.find(stop)
        if cut >= 0:
            text = text[:cut]
    return text.strip() or NO_ANSWER


def child_main(config_path):
    with open(config_path) as f:
        cfg = json.load(f)
    # Unsloth patches transformers and trl, so it is imported first, as in the notebook.
    from unsloth import FastModel
    import torch
    from datasets import Dataset
    from transformers import TrainerCallback
    from trl import SFTConfig, SFTTrainer
    from unsloth.chat_templates import train_on_responses_only

    train_rows = read_jsonl(cfg["train_path"])
    eval_rows = read_jsonl(cfg["eval_path"])
    total = int(cfg["max_steps"])
    rank = int(cfg["lora_rank"])

    emit("phase", message="Loading " + cfg["model"])
    model, tokenizer = FastModel.from_pretrained(model_name=cfg["model"], max_seq_length=cfg["max_seq_length"])
    model = FastModel.get_peft_model(
        model,
        finetune_vision_layers=False,
        finetune_language_layers=True,
        finetune_attention_modules=True,
        finetune_mlp_modules=True,
        r=rank,
        lora_alpha=rank,
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=3407,
    )
    # FastModel hands back a processor; plain strings go through its text tokenizer.
    text_tokenizer = getattr(tokenizer, "tokenizer", tokenizer)
    bos = getattr(tokenizer, "bos_token", None) or getattr(text_tokenizer, "bos_token", None) or ""

    def render(messages, generation):
        text = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=generation, reasoning_strength=REASONING
        )
        # The tokenizer adds the one <|begin_of_text|> the model expects, so the template's own is dropped.
        return text.removeprefix(bos) if bos else text

    def answer_all(label):
        if hasattr(FastModel, "for_inference"):
            FastModel.for_inference(model)
        text_tokenizer.padding_side = "left"
        if text_tokenizer.pad_token is None:
            text_tokenizer.pad_token = text_tokenizer.eos_token
        head = [{"role": "system", "content": cfg["system"]}] if cfg.get("system") else []
        prompts = [render(head + [{"role": "user", "content": r["prompt"]}], True) for r in eval_rows]
        answers = []
        for start in range(0, len(prompts), GEN_BATCH):
            enc = text_tokenizer(prompts[start:start + GEN_BATCH], return_tensors="pt", padding=True)
            input_ids = enc["input_ids"].to("cuda")
            attention_mask = enc["attention_mask"].to("cuda")
            with torch.no_grad():
                out = model.generate(
                    input_ids=input_ids,
                    attention_mask=attention_mask,
                    max_new_tokens=MAX_NEW_TOKENS,
                    do_sample=False,
                    pad_token_id=text_tokenizer.pad_token_id,
                )
            width = input_ids.shape[1]
            for row in out:
                answers.append(final_answer(text_tokenizer.decode(row[width:], skip_special_tokens=False)))
            emit("phase", message=label + " answers: " + str(len(answers)) + " of " + str(len(prompts)))
        return answers

    # A fresh LoRA adds zero (its B matrices start at zero), so these are the base model's answers.
    base_answers = answer_all("Base")

    if hasattr(FastModel, "for_training"):
        FastModel.for_training(model)
    dataset = Dataset.from_list([{"text": render(row["messages"], False)} for row in train_rows])

    class Progress(TrainerCallback):
        def __init__(self):
            self.loss = None
            self.sent = 0

        def on_log(self, args, state, control, logs=None, **kwargs):
            if logs and isinstance(logs.get("loss"), (int, float)):
                self.loss = float(logs["loss"])
            step = int(state.global_step or 0)
            if step and step != self.sent and (step % PROGRESS_EVERY == 0 or step >= state.max_steps):
                self.sent = step
                emit("progress", step=step, total=state.max_steps, loss=self.loss)

    progress = Progress()
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        eval_dataset=None,
        args=SFTConfig(
            dataset_text_field="text",
            max_length=cfg["max_seq_length"],
            # Gradient accumulation invariant, as the notebook explains.
            loss_type="nll",
            per_device_train_batch_size=1,
            gradient_accumulation_steps=4,
            warmup_steps=5,
            max_steps=total,
            learning_rate=float(cfg["learning_rate"]),
            logging_steps=1,
            optim="adamw_8bit",
            weight_decay=0.001,
            lr_scheduler_type="linear",
            seed=3407,
            output_dir=cfg["output_dir"],
            save_strategy="no",
            report_to="none",
        ),
    )
    trainer = train_on_responses_only(trainer, instruction_part=INSTRUCTION_PART, response_part=RESPONSE_PART)
    trainer.add_callback(progress)
    emit("phase", message="Training for " + str(total) + " steps")
    stats = trainer.train()

    tuned_answers = answer_all("Tuned")

    os.makedirs(cfg["adapter_dir"], exist_ok=True)
    model.save_pretrained(cfg["adapter_dir"])
    tokenizer.save_pretrained(cfg["adapter_dir"])

    loss = progress.loss if progress.loss is not None else getattr(stats, "training_loss", None)
    metrics = {
        "train_loss_final": round(float(loss), 4) if loss is not None else "unknown",
        "steps": int(trainer.state.global_step or total),
        "train_seconds": round(float(stats.metrics.get("train_runtime", 0)), 1),
        "peak_vram_gb": round(torch.cuda.max_memory_reserved() / 1024 ** 3, 2),
        "gpu": torch.cuda.get_device_name(0),
    }
    with open(cfg["result_path"], "w", encoding="utf-8") as f:
        json.dump({"base": base_answers, "tuned": tuned_answers, "metrics": metrics}, f, ensure_ascii=False)
    emit("phase", message="Adapter saved")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--child":
        child_main(sys.argv[2])
    else:
        sys.stderr.write("usage: recipe.py --child config.json\n")
        sys.exit(2)
`;
