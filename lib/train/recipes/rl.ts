/**
 * The rl-grpo recipe's Python (docs/TRAINING.md, "rl-grpo recipe"; flag TUNE_RL, off): reinforcement learning on a LoRA
 * of r30b with TRL's GRPOTrainer. The task is made-up arithmetic, generated from a seed, and the reward is plain code
 * that reads the answer tag and compares it to the computed result. No model grades anything. Never put a dollar sign
 * followed by an opening brace, or a backtick, in the Python: this is a template literal.
 *
 * Like glimmer-serve, it reuses glimmer-lora's Python as it is (glimmerHelpers), so the venv, the cache, the pinned base
 * and the final-channel prompts are the ones training uses. Its pins already include trl 0.22.2, whose GRPOTrainer and
 * GRPOConfig this code was written against by reading that wheel's source, and first ran with them on a GPU on Nov 1, 2026.
 *
 * The child answers the held-out problems greedily before training, trains, saves the adapter and answers them again.
 * The parent returns the reward curve and the before and after scores as done metrics (lib/train/rl.ts reads them) and
 * sends no eval items, so the platform's judge never runs on this job and it costs no Meta call.
 */
import { glimmerHelpers } from "@/lib/train/recipes/serve";

const RL_HEAD = String.raw`"""GRPO on made-up arithmetic: trains a LoRA of r30b with a code-checked reward and scores held-out problems before and after."""

# glimmer-lora's own Python (lib/train/recipes/glimmer.ts) follows without its docstring and its __main__ block. Its
# run(ctx) is replaced below, and its child_main is never called.
`;

const RL_BODY = String.raw`

# ---------------------------------------------------------------------------------------------------------------
# rl-grpo: everything below is this recipe's own.

import gc
import random

RL_TRAIN_PROBLEMS = 2000
RL_HELD_OUT = 40
RL_MAX_COMPLETION = 128
RL_LOG_EVERY = 5
RL_PROMPTS_PER_STEP = 2
RL_CURVE_POINTS = 40
RL_METRIC_MAX = 480
RL_EXAMPLES = 8
RL_EXAMPLE_CHARS = 120
REWARD_CORRECT = 1.0
REWARD_WRONG_NUMBER = 0.1
REWARD_NO_ANSWER = 0.0
RL_SYSTEM = "You solve arithmetic problems carefully."
RL_ASK = "What is {}? Work in a few short steps, then give only the final whole number in answer tags, like <answer>42</answer>."
ANSWER_RE = re.compile(r"<answer>\s*(-?\d[\d,]*)\s*</answer>")


def make_problem(rng):
    """(text, result), both built from the same numbers, so the result never comes from evaluating text."""
    big = lambda: rng.randint(11, 99)
    small = lambda: rng.randint(3, 19)
    form = rng.randrange(5)
    if form == 0:
        a, b, c = big(), small(), small()
        return str(a) + " + " + str(b) + " * " + str(c), a + b * c
    if form == 1:
        a, b, c = big(), big(), small()
        return "(" + str(a) + " + " + str(b) + ") * " + str(c), (a + b) * c
    if form == 2:
        a, b, c = small(), big(), big()
        return str(a) + " * " + str(b) + " - " + str(c), a * b - c
    if form == 3:
        a, b, c, d = big(), big(), small(), big()
        return "(" + str(a) + " - " + str(b) + ") * " + str(c) + " + " + str(d), (a - b) * c + d
    a, b, c, d = small(), big(), small(), big()
    return str(a) + " * " + str(b) + " + " + str(c) + " * " + str(d), a * b + c * d


def make_problems(seed, count, avoid=()):
    """count different problems from a seed, none of them in avoid."""
    rng = random.Random(seed)
    seen, rows = set(avoid), []
    while len(rows) < count:
        text, result = make_problem(rng)
        if text not in seen:
            seen.add(text)
            rows.append({"problem": text, "answer": result, "ask": RL_ASK.format(text)})
    return rows


def parse_answer(text):
    """The whole number in the text's one answer tag, or None with no tag, or with more than one."""
    found = ANSWER_RE.findall(text or "")
    if len(found) != 1:
        return None
    try:
        return int(found[0].replace(",", ""))
    except ValueError:
        return None


def score_answer(text, answer):
    """The reward: the tag's number against the computed result."""
    got = parse_answer(text)
    if got is None:
        return REWARD_NO_ANSWER
    return REWARD_CORRECT if got == int(answer) else REWARD_WRONG_NUMBER


def completion_text(completion):
    """GRPO hands plain prompts' completions back as text, and conversational ones as messages."""
    if isinstance(completion, str):
        return completion
    return "".join(str(m.get("content") or "") for m in completion)


def arithmetic_reward(completions, answer, **kwargs):
    """GRPOTrainer's reward function. Its dataset's answer column arrives as answer, one per completion."""
    return [score_answer(completion_text(c), a) for c, a in zip(completions, answer)]


def scoreboard(rows, answers):
    """How many held-out answers are right, and the mean reward."""
    rewards = [score_answer(text, row["answer"]) for row, text in zip(rows, answers)]
    return {
        "correct": sum(1 for r in rewards if r == REWARD_CORRECT),
        "reward": round(sum(rewards) / len(rewards), 4) if rewards else 0.0,
    }


def rl_params(params):
    whole = lambda key, fallback, low, high: max(low, min(high, int(number(params, key, fallback))))
    return {
        "max_steps": whole("maxSteps", 200, 10, 1000),
        "learning_rate": max(1e-6, min(1e-3, number(params, "learningRate", 5e-5))),
        "lora_rank": whole("loraRank", 16, 4, 128),
        "num_generations": whole("numGenerations", 8, 2, 16),
        "seed": whole("seed", 3407, 0, 1000000),
        "dry_run": number(params, "dryRun", 0) >= 1,
    }


def curve_metric(curve):
    """The curve as "step:reward,step:reward", at most RL_CURVE_POINTS, always with the first and last, under the
    platform's 500 characters a metric."""
    points = list(curve)
    if len(points) > RL_CURVE_POINTS:
        last = len(points) - 1
        points = [points[round(i * last / (RL_CURVE_POINTS - 1))] for i in range(RL_CURVE_POINTS)]
    return ",".join(str(int(s)) + ":" + str(round(float(r), 3)) for s, r in points)


def example_metric(row, before, after):
    """One held-out problem's two answers as JSON under the platform's limit, answers shortened as far as it takes."""
    for chars in (RL_EXAMPLE_CHARS, 80, 40, 10):
        text = json.dumps(
            {
                "problem": row["problem"],
                "answer": row["answer"],
                "base": before[:chars],
                "tuned": after[:chars],
                "baseReward": score_answer(before, row["answer"]),
                "tunedReward": score_answer(after, row["answer"]),
            }
        )
        if len(text) <= RL_METRIC_MAX:
            return text
    return json.dumps({"problem": row["problem"], "answer": row["answer"], "base": "", "tuned": "", "baseReward": score_answer(before, row["answer"]), "tunedReward": score_answer(after, row["answer"])})


def pick_examples(rows, before, after):
    """Which held-out problems the page shows: ones that got better, ones that got worse, then the rest, so a run where
    training hurt can't look good."""
    gain = lambda i: score_answer(after[i], rows[i]["answer"]) - score_answer(before[i], rows[i]["answer"])
    order = range(len(rows))
    up = [i for i in order if gain(i) > 0][:RL_EXAMPLES // 2]
    down = [i for i in order if gain(i) < 0][:RL_EXAMPLES // 4]
    chosen = up + down
    chosen += [i for i in order if i not in chosen][:RL_EXAMPLES - len(chosen)]
    return sorted(chosen)


def rl_dry_run(ctx, p, held):
    """Made-up results with no venv, model or GPU, a check of the callbacks and the page. The metrics say dry_run."""
    total = p["max_steps"]
    curve = [(s, round(0.1 + 0.5 * s / total, 3)) for s in range(RL_LOG_EVERY, total + 1, RL_LOG_EVERY)]
    for step, reward in curve[-3:]:
        ctx.progress(step=step, total_steps=total, message="Mean reward " + str(reward))
    tag = lambda n: "<answer>" + str(n) + "</answer>"
    base = [tag(r["answer"] if i % 4 == 0 else r["answer"] + 1) for i, r in enumerate(held)]
    tuned = [tag(r["answer"] if i % 2 == 0 else r["answer"] + 1) for i, r in enumerate(held)]
    return {"base": base, "tuned": tuned, "curve": curve, "adapter": False, "metrics": {"steps_done": total, "cached_weights": "no", "cached_venv": "no", "dry_run": "yes"}}


def rl_real_run(ctx, p, base, train, held, adapter_dir, started):
    hf_home = os.path.join(base, "hf")
    os.makedirs(hf_home, exist_ok=True)
    python, venv_reused = ensure_venv(ctx, base)
    remove_stale_hf_locks(ctx, hf_home)
    cached = weights_cached(hf_home)
    result_path = os.path.join(ctx.work_dir, "rl-result.json")
    if os.path.exists(result_path):
        os.remove(result_path)
    deadline = job_deadline(ctx, started) - PARENT_RESERVE_SECONDS
    left = deadline - time.time()
    if left < MIN_CHILD_SECONDS:
        raise RuntimeError("Only " + minutes(left) + " are left for the model before the job's time limit, too few to load it, train and answer")
    train_path = os.path.join(ctx.work_dir, "rl-train.jsonl")
    held_path = os.path.join(ctx.work_dir, "rl-held.jsonl")
    write_jsonl(train_path, train)
    write_jsonl(held_path, held)
    config = {
        "model": MODEL,
        "revision": MODEL_REVISION,
        "max_seq_length": MAX_SEQ_LENGTH,
        "max_steps": p["max_steps"],
        "learning_rate": p["learning_rate"],
        "lora_rank": p["lora_rank"],
        "num_generations": p["num_generations"],
        "seed": p["seed"],
        "train_path": train_path,
        "held_path": held_path,
        "result_path": result_path,
        "adapter_dir": adapter_dir,
        "output_dir": os.path.join(ctx.work_dir, "outputs"),
        "deadline": deadline,
    }
    config_path = os.path.join(ctx.work_dir, "rl-config.json")
    with open(config_path, "w") as f:
        json.dump(config, f)
    env = {"HF_HOME": hf_home, "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false", "PYTHONDONTWRITEBYTECODE": "1"}
    cmd = shlex.quote(python) + " -u " + shlex.quote(os.path.abspath(__file__)) + " --rl " + shlex.quote(config_path)
    seen = set()
    out = run_child(ctx, cmd, int(left) + CHILD_GRACE_SECONDS, env, seen)
    timed_out = bool(getattr(out, "timed_out", False))
    ended = "timed out" if timed_out else "exited with " + str(out.returncode)
    result = read_result(result_path)
    if result is None:
        missing = "ModuleNotFoundError" in (out.stdout or "")
        if venv_reused and out.returncode != 0 and not timed_out and "imported" not in seen and missing:
            mark_broken(ctx, os.path.dirname(os.path.dirname(python)))
        raise RuntimeError("The training child " + ended + " before the base model answered:\n" + last_lines(out))
    if out.returncode != 0:
        ctx.log("The training child " + ended + " after writing part of its result:\n" + last_lines(out))
    result["metrics"] = dict(result.get("metrics") or {})
    result["metrics"]["cached_weights"] = "yes" if cached else "no"
    result["metrics"]["cached_venv"] = "yes" if venv_reused else "no"
    return result


def rl_finish(ctx, p, result, held, adapter_dir, cache_used):
    """The metrics lib/train/rl.ts reads. With no tuned answers the job fails, since it has no comparison to show, and
    says what it did get."""
    before = result.get("base")
    after = result.get("tuned")
    curve = result.get("curve") or []
    if not before or not after:
        got = "the base scored " + str(scoreboard(held, before)["correct"]) + " of " + str(len(held)) if before else "no base answers"
        raise RuntimeError("Training ended with no tuned answers to compare (" + got + ", " + str(len(curve)) + " reward points)")
    was, now = scoreboard(held, before), scoreboard(held, after)
    metrics = dict(result.get("metrics") or {})
    metrics.update(
        {
            "base_model": MODEL,
            "base_revision": MODEL_REVISION,
            "reward_curve": curve_metric(curve),
            "heldout_total": len(held),
            "heldout_base_correct": was["correct"],
            "heldout_tuned_correct": now["correct"],
            "heldout_base_reward": was["reward"],
            "heldout_tuned_reward": now["reward"],
            "cache_used": "yes" if cache_used else "no",
        }
    )
    for n, i in enumerate(pick_examples(held, before, after)):
        metrics["example_" + str(n)] = example_metric(held[i], before[i], after[i])
    path = os.path.join(ctx.work_dir, "rl-heldout.json")
    rows = [{"problem": r["problem"], "answer": r["answer"], "base": before[i], "tuned": after[i]} for i, r in enumerate(held)]
    with open(path, "w") as f:
        json.dump({"curve": curve, "rows": rows}, f)
    try:
        ctx.upload(path, "rl-heldout.json", "metrics")
    except Exception as e:
        ctx.log("Uploading the held-out answers failed (" + type(e).__name__ + ")")
    if result.get("adapter"):
        upload_adapter(ctx, adapter_dir, metrics)
    lead = "Dry run, made-up numbers: " if p["dry_run"] else ""
    metrics["summary"] = (
        lead + "On " + str(len(held)) + " held-out problems, the base got " + str(was["correct"]) + " right and the tuned model got "
        + str(now["correct"]) + " right, after " + str(metrics.get("steps_done", 0)) + " GRPO steps."
    )
    return metrics


def run(ctx):
    started = time.time()
    p = rl_params(ctx.params)
    held = make_problems(p["seed"] + 1, RL_HELD_OUT)
    train = make_problems(p["seed"], RL_TRAIN_PROBLEMS, avoid=[r["problem"] for r in held])
    base, cache_used = base_dir(ctx)
    adapter_dir = os.path.join(base, "models", str(ctx.job_id or "job"))
    if p["dry_run"]:
        result = rl_dry_run(ctx, p, held)
    else:
        result = rl_real_run(ctx, p, base, train, held, adapter_dir, started)
    return rl_finish(ctx, p, result, held, adapter_dir, cache_used)


def rl_child_main(config_path):
    """Base answers, GRPO, adapter, tuned answers. The result file is rewritten after each, so a child cut short still
    reports what it got."""
    with open(config_path) as f:
        cfg = json.load(f)
    # Unsloth patches transformers and trl, so it is imported first.
    from unsloth import FastModel
    import torch
    from datasets import Dataset
    from peft import PeftModel
    from transformers import TrainerCallback
    from trl import GRPOConfig, GRPOTrainer

    emit("imported")
    train_rows = read_jsonl(cfg["train_path"])
    held = read_jsonl(cfg["held_path"])
    total = int(cfg["max_steps"])
    rank = int(cfg["lora_rank"])
    generations = int(cfg["num_generations"])
    deadline = float(cfg.get("deadline") or 0) or None
    result = {"base": None, "tuned": None, "curve": [], "adapter": False, "metrics": {"steps_done": 0}}

    emit("phase", message="Loading " + cfg["model"])
    model, tokenizer = FastModel.from_pretrained(model_name=cfg["model"], revision=cfg.get("revision"), max_seq_length=cfg["max_seq_length"])
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
        random_state=cfg["seed"],
    )
    def text_side(full):
        """GRPOTrainer gets the text tokenizer: it would treat FastModel's processor as one that takes images."""
        text = getattr(full, "tokenizer", full)
        text.padding_side = "left"
        if text.pad_token is None:
            text.pad_token = text.eos_token
        # GRPOTrainer stops sampling and masks at the tokenizer's eos only, and an answer on the final channel ends at <|eot|>.
        text.eos_token = FINAL_ENDS[0]
        return text

    text_tokenizer = text_side(tokenizer)
    bos = getattr(tokenizer, "bos_token", None) or getattr(text_tokenizer, "bos_token", None) or ""

    def prompt_of(row):
        return eval_prompt(tokenizer, [{"role": "system", "content": RL_SYSTEM}, {"role": "user", "content": row["ask"]}], bos)

    def answer_all(label):
        """Greedy answers to the held-out problems. A raw output is cut at its first message end, and one with none is
        kept as it is: the reward reads the tag either way."""
        if hasattr(FastModel, "for_inference"):
            FastModel.for_inference(model)
        prompts = [prompt_of(r) for r in held]
        answers = []
        for start in range(0, len(prompts), GEN_BATCH):
            enc = text_tokenizer(prompts[start:start + GEN_BATCH], return_tensors="pt", padding=True)
            input_ids = enc["input_ids"].to("cuda")
            attention_mask = enc["attention_mask"].to("cuda")
            with torch.no_grad():
                out = model.generate(input_ids=input_ids, attention_mask=attention_mask, max_new_tokens=RL_MAX_COMPLETION, do_sample=False, pad_token_id=text_tokenizer.pad_token_id)
            width = input_ids.shape[1]
            for row in out:
                raw = text_tokenizer.decode(row[width:], skip_special_tokens=False)
                cut = min([raw.find(t) for t in FINAL_ENDS if t in raw] or [len(raw)])
                answers.append(raw[:cut].replace(PAD_TOKEN, "").strip())
            emit("phase", message=label + " answers: " + str(len(answers)) + " of " + str(len(prompts)))
        emit("log", text=label + " model's first held-out answer: " + answers[0][:RAW_CHARS])
        return answers

    # A fresh LoRA adds zero (its B matrices start at zero), so these are the base model's answers.
    began = time.time()
    result["base"] = answer_all("Base")
    answer_seconds = time.time() - began
    write_result(cfg["result_path"], result)

    if hasattr(FastModel, "for_training"):
        FastModel.for_training(model)
    # The trainer tokenizes these with no special tokens, so each brings its own <|begin_of_text|>.
    dataset = Dataset.from_list([{"prompt": bos + prompt_of(r), "answer": r["answer"]} for r in train_rows])
    keep_back = answer_seconds * TUNED_PASS_FACTOR + SAVE_RESERVE_SECONDS

    class Report(TrainerCallback):
        def on_log(self, args, state, control, logs=None, **kwargs):
            reward = (logs or {}).get("reward")
            if isinstance(reward, (int, float)) and math.isfinite(reward):
                result["curve"].append([state.global_step, round(float(reward), 4)])
                result["metrics"]["steps_done"] = state.global_step
                write_result(cfg["result_path"], result)
                emit("progress", step=state.global_step, total=total, loss=logs.get("loss"), message="Mean reward " + str(round(float(reward), 3)))

        def on_step_end(self, args, state, control, **kwargs):
            result["metrics"]["steps_done"] = state.global_step
            if deadline and time.time() > deadline - keep_back:
                result["metrics"]["stopped_early"] = "yes"
                emit("log", text="Stopping training at step " + str(state.global_step) + " to leave time for the tuned answers")
                control.should_training_stop = True

    trainer = GRPOTrainer(
        model=model,
        reward_funcs=[arithmetic_reward],
        args=GRPOConfig(
            output_dir=cfg["output_dir"],
            max_steps=total,
            learning_rate=float(cfg["learning_rate"]),
            num_generations=generations,
            # One prompt's generations a device step, and RL_PROMPTS_PER_STEP prompts an optimizer step.
            per_device_train_batch_size=generations,
            gradient_accumulation_steps=RL_PROMPTS_PER_STEP,
            max_completion_length=RL_MAX_COMPLETION,
            temperature=1.0,
            logging_steps=RL_LOG_EVERY,
            optim="adamw_8bit",
            seed=cfg["seed"],
            save_strategy="no",
            report_to="none",
            remove_unused_columns=False,
        ),
        train_dataset=dataset,
        processing_class=text_tokenizer,
        callbacks=[Report()],
    )
    emit("phase", message="GRPO training")
    trainer.train()
    write_result(cfg["result_path"], result)

    os.makedirs(cfg["adapter_dir"], exist_ok=True)
    model.save_pretrained(cfg["adapter_dir"])
    tokenizer.save_pretrained(cfg["adapter_dir"])
    fix_adapter_config(os.path.join(cfg["adapter_dir"], ADAPTER_CONFIG), cfg.get("revision"), cfg["model"])
    result["adapter"] = True
    write_result(cfg["result_path"], result)

    # The tuned answers come from a fresh load of the saved adapter and its own tokenizer, as people would use it. On the
    # first real run (Nov 1, 2026), answering after training in the same process scored 16 of 40, mostly stray channel
    # text, and did the same with only the model reloaded, while a new process, and this reload, scored 40 of 40. A single
    # prompt tokenized the same before and after training, so the cause looks like the trained tokenizer's batch padding.
    del trainer
    model = None
    gc.collect()
    torch.cuda.empty_cache()
    emit("phase", message="Loading the saved adapter for the tuned answers")
    fresh, tokenizer = FastModel.from_pretrained(model_name=cfg["model"], revision=cfg.get("revision"), max_seq_length=cfg["max_seq_length"])
    text_tokenizer = text_side(tokenizer)
    model = PeftModel.from_pretrained(fresh, cfg["adapter_dir"], is_trainable=False)
    result["tuned"] = answer_all("Tuned")
    write_result(cfg["result_path"], result)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--rl":
        rl_child_main(sys.argv[2])
    else:
        sys.stderr.write("usage: recipe.py --rl config.json\n")
        sys.exit(2)
`;

/** The rl-grpo recipe: glimmer-lora's helpers, then GRPO on arithmetic and its run(ctx). */
export const RL_PY = RL_HEAD + glimmerHelpers() + RL_BODY;
