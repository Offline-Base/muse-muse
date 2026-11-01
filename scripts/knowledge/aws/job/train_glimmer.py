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
batch_size x grad_accum x N (4 x 1 x 8 = 32). Rank 0 alone answers the probes before and after training and saves
the adapter (the Trainer saves checkpoints from rank 0 only). Without torchrun nothing changes.

Stage 2 from stage 1: KNOWLEDGE_INIT_ADAPTER=<a saved adapter or checkpoint-N folder> loads those LoRA weights as the
starting adapter (same rank and modules), then trains on the new train.jsonl with a fresh optimizer and schedule.
If the run's own checkpoint folder already holds a checkpoint, that checkpoint wins (a restarted stage 2 resumes).
Extra hyperparameters: save_steps (250), tuned_eval (1; 0 skips the answers after training, for speed tests).

Reasoning rows: an assistant message with reasoning_content gets its whole turn trained, from just after the generation
prompt: ' to=self<|message|>THINK<|eom|><|start|>assistant to=user<|message|>ANSWER<|eot|>'. Training only the answer
left those control tokens with no loss (stage 1's P("=self") after " to" fell to 0.21, base 0.99999). Such a row may say
its reasoning_strength (low, medium or high) and tools; its text is rendered with them. Every other row keeps the final-only
labels and prompt, and a file with no reasoning rows runs exactly as before. A row must reach a to=user answer (Unsloth drops one
with nothing after RESPONSE_PART). A reasoning row is trained verbatim, so a control token written in its text would train as a
channel mark: that stops the run, as does a reasoning text the template changed. test_glimmer_labels.py checks all this against
the real tokenizer and template.

KNOWLEDGE_REQUIRE_TURNS=SHARE (0 to 1; 0 or unset means no check): a pilot of the labels on a file with no reasoning rows would train
nothing new and read as "the labels don't work", so this stops before the model loads unless at least this share of the rows in use
(after max_examples) has reasoning, and stops again if none of them reach the check.

KNOWLEDGE_SAVE_LIMIT=N: checkpoints kept in the run's checkpoint folder (unset or empty: 2, as every earlier run; 0 keeps every
one, for a run scored at each save). KNOWLEDGE_SCHEDULE=cosine|constant (unset or empty: cosine): constant holds the learning rate
after the same 3% warmup. Neither changes the labels; with both unset the run is exactly as before.
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
STRENGTHS = ("low", "medium", "high")
SELF_CHANNEL = " to=self<|message|>"
CONTROL_TOKEN = re.compile(r"<\|[a-z0-9_]+\|>")
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
INIT_ADAPTER = os.environ.get("KNOWLEDGE_INIT_ADAPTER", "")
REQUIRE_TURNS = float(os.environ.get("KNOWLEDGE_REQUIRE_TURNS") or 0)
SAVE_LIMIT_DEFAULT = 2
SCHEDULES = {"cosine": "cosine", "constant": "constant_with_warmup"}


def save_limit():
    """save_total_limit for the Trainer: KNOWLEDGE_SAVE_LIMIT unset or empty keeps 2, 0 keeps every checkpoint (None)."""
    raw = (os.environ.get("KNOWLEDGE_SAVE_LIMIT") or "").strip()
    if not raw:
        return SAVE_LIMIT_DEFAULT
    if not raw.isdigit():
        raise RuntimeError(f"KNOWLEDGE_SAVE_LIMIT must be a whole number (0 keeps every checkpoint), not {raw!r}")
    return int(raw) or None


def schedule():
    """lr_scheduler_type for the Trainer: KNOWLEDGE_SCHEDULE unset or empty is cosine; constant holds after warmup."""
    raw = (os.environ.get("KNOWLEDGE_SCHEDULE") or "").strip() or "cosine"
    if raw not in SCHEDULES:
        raise RuntimeError(f"KNOWLEDGE_SCHEDULE must be one of {sorted(SCHEDULES)}, not {raw!r}")
    return SCHEDULES[raw]


def say(event, **fields):
    if MAIN:
        print("MUSE " + json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def every_rank(event, **fields):
    """A line from each process (under torchrun), so the log shows which rank did what."""
    if WORLD > 1:
        print("MUSE " + json.dumps({"event": event, "rank": RANK, "world": WORLD, **fields}, ensure_ascii=False), flush=True)


def hyper():
    try:
        with open(HYPER) as f:
            raw = json.load(f)
    except OSError:
        raw = {}
    h = {"epochs": 2, "learning_rate": 1e-4, "lora_rank": 64, "batch_size": 8, "grad_accum": 4, "eval_probes": 1500, "max_examples": 0, "base_only": 0, "group_by_length": 0, "packing": 0,
         "save_steps": 250, "tuned_eval": 1}
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


def has_reasoning(row):
    """A row whose whole assistant turn trains: some assistant message of it carries reasoning_content."""
    return any(m["role"] == "assistant" and m.get("reasoning_content") for m in row["messages"])


def check_reasoning_row(row):
    """A reasoning row trains its whole turn verbatim, so its strength must be one the model uses and no message may spell a
    control token: most would train as channel marks without tripping the label check. The message says where, never the text."""
    strength = row.get("reasoning_strength", REASONING)
    if strength not in STRENGTHS:
        raise RuntimeError(f"A reasoning row has reasoning_strength {strength!r}, not one of {STRENGTHS}")
    for k, m in enumerate(row["messages"]):
        for field in ("content", "reasoning_content"):
            found = CONTROL_TOKEN.search(m.get(field) or "")
            if found:
                raise RuntimeError(f"A reasoning row has {found.group(0)} in the {field} of message {k} ({m['role']}); drop such rows when assembling")


def row_shape(row, index, text=None):
    """Where a row is and what it holds, for an error message: its index, kind and lengths, never any of its text."""
    kind = "reasoning" if has_reasoning(row) else "final-only"
    lengths = [len(m.get("content") or "") for m in row["messages"]]
    extra = f", rendered length {len(text)}" if text is not None else ""
    return f"row {index if index is not None else '?'} ({kind}, kind {row.get('kind', 'none')}, {len(row['messages'])} messages, content lengths {lengths}{extra})"


def training_text(row, render, index=None):
    """One training example, checked. render(messages, generation, [strength, tools]) is the template without the BOS text.
    A row without reasoning always renders at REASONING with no tools, as every earlier run did. index only names the row
    in an error."""
    turns = has_reasoning(row)
    if turns:
        check_reasoning_row(row)
    text = render(row["messages"], False, row.get("reasoning_strength", REASONING), row.get("tools")) if turns else render(row["messages"], False)
    for k, m in enumerate(row["messages"]):
        # Verbatim, whitespace included: a stripped or reworded reasoning wouldn't be the model's own tokens.
        if turns and m.get("reasoning_content") and SELF_CHANNEL + m["reasoning_content"] + "<|eom|>" not in text:
            raise RuntimeError("The template changed a reasoning message; it must render verbatim between its header and <|eom|>")
        if turns and m.get("tool_calls"):
            continue  # no content; the template writes the call on its own channel
        marker = {"user": INSTRUCTION_PART, "assistant": RESPONSE_PART}.get(m["role"])
        if marker and marker + m["content"] not in text:
            raise RuntimeError(f"The template didn't put a {m['role']} message right after {marker}: message {k}, {row_shape(row, index, text)}")
    return text


def channel_marks(text_tokenizer):
    """Token ids of the generation prompt and of the reasoning header that follows it, and the <|start|> id."""
    ids = lambda s: text_tokenizer(s, add_special_tokens=False)["input_ids"]
    return {"prompt": ids(GENERATION_PROMPT), "header": ids(GENERATION_PROMPT + SELF_CHANNEL), "start": text_tokenizer.convert_tokens_to_ids("<|start|>")}


def whole_turn_labels(ids, labels, marks):
    """labels with each reasoning turn trained whole. A turn opens at the header <|start|>assistant to=self<|message|> and
    runs through the assistant messages right after it, up to the next <|start|> of another role (a tool result, a user turn)
    or the end. Training starts just after the generation prompt, which the model is given. A row with no such header
    comes back untouched, so the labels of every other row stay what train_on_responses_only made them."""
    prompt, header, start = marks["prompt"], marks["header"], marks["start"]
    out, i, n = None, 0, len(ids)
    while i < n:
        if ids[i] != start or ids[i:i + len(header)] != header:
            i += 1
            continue
        begin = i + len(prompt)
        i = begin
        while i < n and not (ids[i] == start and ids[i:i + len(prompt)] != prompt):
            i += 1
        out = list(labels) if out is None else out
        out[begin:i] = ids[begin:i]
    return labels if out is None else out


def wanted_labels_text(row, text, render, index=None):
    """What a reasoning row must train, from the template alone: each reasoning message from the end of the generation
    prompt to the end of the message, and each other assistant message's answer and end token after RESPONSE_PART.
    index only names the row in an error."""
    strength, tools = row.get("reasoning_strength", REASONING), row.get("tools")
    want = []
    for k, m in enumerate(row["messages"]):
        if m["role"] != "assistant":
            continue
        prompt = render(row["messages"][:k], True, strength, tools)
        end = len(render(row["messages"][:k + 1], False, strength, tools))
        # A message can end in <|eom|> in the full text and <|eot|> where the prompt stops at it; they're the same length.
        if not text.replace("<|eom|>", "<|eot|>").startswith(prompt.replace("<|eom|>", "<|eot|>")):
            raise RuntimeError(f"A generation prompt isn't a prefix of its training text: before message {k}, prompt length {len(prompt)}, "
                               f"{row_shape(row, index, text)}")
        if m.get("reasoning_content"):
            want.append(text[len(prompt):end])
        elif not m.get("tool_calls"):
            want.append(text[len(prompt) + len(FINAL_CHANNEL):end])
    return "".join(want)


def check_whole_turns(dataset, texts, rows, render, text_tokenizer):
    """Every reasoning row in the trainer's tokenized set: its labels decode to wanted_labels_text() and every other token
    is masked. Rows are matched on their decoded text, because Unsloth drops rows with nothing to train. A row cut at
    MAX_SEQ_LENGTH is only counted. Returns the counts; any mismatch stops the run."""
    bos = text_tokenizer.bos_token or ""
    wanted = {bos + t: i for i, (t, r) in enumerate(zip(texts, rows)) if has_reasoning(r)}
    marks, seen, cut, trained_total, bad = channel_marks(text_tokenizer), 0, 0, 0, []
    for ex in dataset:
        ids, labels = list(ex["input_ids"]), list(ex["labels"])
        if not any(ids[j:j + len(marks["header"])] == marks["header"] for j, t in enumerate(ids) if t == marks["start"]):
            continue
        if len(ids) >= MAX_SEQ_LENGTH:
            cut += 1
            continue
        i = wanted.get(text_tokenizer.decode(ids, skip_special_tokens=False))
        if i is None:
            bad.append("a tokenized row with a reasoning header matches no rendered reasoning row")
            continue
        seen += 1
        kept = [t for t, label in zip(ids, labels) if label != -100]
        trained_total += len(kept)
        if any(label not in (-100, t) for t, label in zip(ids, labels)):
            bad.append(f"row {i} has labels that aren't its own tokens")
        if text_tokenizer.decode(kept, skip_special_tokens=False) != wanted_labels_text(rows[i], texts[i], render, i):
            bad.append(f"row {i} trains something other than its whole turn")
    if bad:
        raise RuntimeError(f"whole-turn labels failed on {len(bad)} rows, first: {bad[:3]}")
    return {"reasoning_rows": len(wanted), "checked": seen, "cut_at_max_length": cut, "dropped": len(wanted) - seen - cut,
            "mean_trained_tokens": round(trained_total / max(1, seen), 1)}


def load_adapter(model, path, rank):
    """Stage 2's start: the LoRA weights of a saved adapter (out/adapter, or a checkpoint-N folder) copied into the
    fresh LoRA of the same rank and modules. Every saved tensor must land on a LoRA weight, every LoRA weight must be
    covered and must then equal the saved tensor, or the run stops. The optimizer and schedule start fresh."""
    import torch
    from peft import set_peft_model_state_dict
    from safetensors.torch import load_file
    with open(os.path.join(path, "adapter_config.json")) as f:
        cfg = json.load(f)
    if int(cfg.get("r", -1)) != rank:
        raise RuntimeError(f"{path} has LoRA rank {cfg.get('r')}, this run {rank}")
    saved = load_file(os.path.join(path, "adapter_model.safetensors"))
    lora = {n: p for n, p in model.named_parameters() if "lora_" in n}
    before = sum(float(p.detach().float().abs().sum()) for n, p in lora.items() if "lora_B" in n)
    result = set_peft_model_state_dict(model, saved, adapter_name="default")
    unexpected = list(getattr(result, "unexpected_keys", []) or [])
    missing = [k for k in (getattr(result, "missing_keys", []) or []) if "lora_" in k]
    if unexpected or missing or len(saved) != len(lora):
        raise RuntimeError(f"adapter {path} doesn't fit: {len(saved)} saved tensors, {len(lora)} LoRA weights, "
                           f"unexpected {unexpected[:3]}, missing {missing[:3]}")
    differ = 0
    for key, value in saved.items():
        name = re.sub(r"\.(lora_[AB])\.weight$", r".\1.default.weight", key)
        p = lora.get(name)
        if p is None or not torch.equal(p.detach().to(value.dtype).cpu(), value):
            differ += 1
    if differ:
        raise RuntimeError(f"{differ} of {len(saved)} LoRA weights didn't match {path} after loading")
    after = sum(float(p.detach().float().abs().sum()) for n, p in lora.items() if "lora_B" in n)
    say("init_adapter", path=path, tensors=len(saved), lora_weights=len(lora), all_equal=True, rank=rank,
        lora_b_abs_sum_before=round(before, 4), lora_b_abs_sum_after=round(after, 4))


def main():
    h = hyper()
    say("start", **h, init_adapter=INIT_ADAPTER or None)
    keep, lr_schedule = save_limit(), schedule()  # read before the model loads, so a bad setting stops at once
    # Logged and kept in metrics.json only when not the default, so a default run's lines and files are as before.
    custom = {"lr_scheduler_type": lr_schedule, "save_total_limit": keep} if keep != SAVE_LIMIT_DEFAULT or lr_schedule != SCHEDULES["cosine"] else {}
    if custom:
        say("schedule", **custom)
    import torch
    if WORLD > 1:
        # Each rank's CUDA context on its own card from the start (Unsloth's import already touches CUDA).
        torch.cuda.set_device(LOCAL_RANK)
    every_rank("rank_up", device=f"cuda:{torch.cuda.current_device()}")
    from unsloth import FastModel  # Unsloth patches transformers and trl, so it comes before them.
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
    turn_rows = sum(has_reasoning(row) for row in train_rows)
    if REQUIRE_TURNS and (not turn_rows or turn_rows < REQUIRE_TURNS * len(train_rows)):
        raise RuntimeError(f"KNOWLEDGE_REQUIRE_TURNS={REQUIRE_TURNS}: {turn_rows} of the {len(train_rows)} rows in use have reasoning, "
                           f"share {turn_rows / max(1, len(train_rows)):.4f}")

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
    if INIT_ADAPTER:
        load_adapter(model, INIT_ADAPTER, rank)
    text_tokenizer = getattr(tokenizer, "tokenizer", tokenizer)
    bos = getattr(tokenizer, "bos_token", None) or getattr(text_tokenizer, "bos_token", None) or ""

    def render(messages, generation, strength=REASONING, tools=None):
        text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=generation, reasoning_strength=strength,
                                             **({"tools": tools} if tools else {}))
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
        every_rank("answering_base")
        base = {"probes": answer_all("base", probes), "forget": answer_all("base", forget), "seconds": round(time.time() - began, 1),
                # With a starting adapter, "base" is the model as that adapter left it (stage 1), not the original.
                "answered_by": INIT_ADAPTER or "base"}
        write_json(base_path, base)
    else:
        # Rank 0 answers the probes alone. The process group doesn't exist yet (the trainer's arguments create it),
        # so waiting here for its file can't time out, and no collective can pair up with one of rank 0's.
        # The model and tokenizer get the same settings answering gave rank 0, so every rank trains alike.
        ready_to_answer()
        every_rank("waiting_for_base_answers")
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
    texts = [training_text(row, render, i) for i, row in enumerate(train_rows)]
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
            num_train_epochs=float(h["epochs"]), learning_rate=float(h["learning_rate"]), lr_scheduler_type=lr_schedule,
            warmup_ratio=0.03, optim="adamw_8bit", weight_decay=0.001, logging_steps=10, seed=3407,
            # Batches of similar length waste less on padding; most examples here are short.
            group_by_length=bool(h["group_by_length"]),
            # Several short examples per sequence; the fixed cost of each step is what limits speed here.
            packing=bool(h["packing"]),
            output_dir=CKPT, save_strategy="steps", save_steps=int(h["save_steps"]), save_total_limit=keep, report_to="none",
            **distributed,
        ),
        callbacks=[pace],
    )
    trainer = train_on_responses_only(trainer, instruction_part=INSTRUCTION_PART, response_part=RESPONSE_PART)
    if any(has_reasoning(row) for row in train_rows):
        # On top of Unsloth's labels, keeping its tokenizing, its filter and its padding collator (which pads labels with
        # -100). train_on_responses_only can't do this itself: it knows one response marker, the same for every row.
        marks = channel_marks(text_tokenizer)
        trainer.train_dataset = trainer.train_dataset.map(
            lambda b: {"labels": [whole_turn_labels(i, x, marks) for i, x in zip(b["input_ids"], b["labels"])]}, batched=True)
        if MAIN:
            report = check_whole_turns(trainer.train_dataset, texts, train_rows, render, text_tokenizer)
            say("whole_turns", rows=len(train_rows), kept=len(trainer.train_dataset), share=round(turn_rows / len(train_rows), 4), **report)
            if REQUIRE_TURNS and not report["checked"]:
                raise RuntimeError(f"KNOWLEDGE_REQUIRE_TURNS={REQUIRE_TURNS}: no reasoning row reached the label check: {report}")
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
    peaks = [round(peak / 1024 ** 3, 2)]
    if WORLD > 1:
        # Every GPU's peak; then the group is closed, so rank 0's adapter save and answers run alone.
        import torch.distributed as dist
        t = torch.zeros(WORLD, dtype=torch.float64, device=f"cuda:{LOCAL_RANK}")
        t[RANK] = float(peak)
        dist.all_reduce(t, op=dist.ReduceOp.SUM)
        peaks = [round(float(x) / 1024 ** 3, 2) for x in t.tolist()]
        peak = int(max(t.tolist()))
        dist.barrier()
        dist.destroy_process_group()
        if not MAIN:
            every_rank("rank_done", saves=False, answers=False)
            return
    steady = pace.steady()
    say("trained", steps=int(trainer.state.global_step or 0), loss=getattr(stats, "training_loss", None), seconds=train_seconds,
        examples_per_second=round(len(train_rows) / max(train_seconds, 1e-9), 2), examples_per_second_steady=steady,
        gpus=WORLD, effective_batch=effective_batch, peak_vram_gb=round(peak / 1024 ** 3, 2), peak_vram_gb_per_gpu=peaks)

    adapter = os.path.join(OUT, "adapter")
    model.save_pretrained(adapter)
    tokenizer.save_pretrained(adapter)
    every_rank("adapter_saved", path=adapter)
    if not h["tuned_eval"]:
        write_json(os.path.join(OUT, "metrics.json"), {
            "train_examples": len(train_rows), "steps": int(trainer.state.global_step or 0), "train_loss": getattr(stats, "training_loss", None),
            "train_seconds": train_seconds, "peak_vram_gb": round(peak / 1024 ** 3, 2), "peak_vram_gb_per_gpu": peaks,
            "train_examples_per_second_steady": steady, "gpus": WORLD, "effective_batch": effective_batch,
            "gpu": torch.cuda.get_device_name(0), "hyperparameters": h, "init_adapter": INIT_ADAPTER or None, "tuned_eval": False, **custom,
        })
        say("done", tuned_eval=False)
        return
    every_rank("answering_tuned")
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
        "peak_vram_gb_per_gpu": peaks, "init_adapter": INIT_ADAPTER or None, **custom,
    }
    write_json(os.path.join(OUT, "metrics.json"), metrics)
    say("done", **{k: metrics[k] for k in ("base_probe_accuracy", "tuned_probe_accuracy", "base_forget_accuracy", "tuned_forget_accuracy")})


if __name__ == "__main__":
    main()
