#!/usr/bin/env python3
"""Fine-tunes a small model with a LoRA adapter on this board's own GPU.

It runs in a venv with torch, transformers, peft and accelerate (setup-train.sh), not the server's system python, because
it needs them. It writes progress to a status file as JSON, so server.py can report on a run that outlasts any tool call.

  train.py --model DIR --dataset FILE --out DIR --status FILE --gguf-out FILE --converter FILE
           [--steps 60] [--rank 8] [--lr 0.0002] [--max-length 512]

The dataset is JSON lines of {"messages": [{"role": ..., "content": ...}, ...]}, ending in the assistant's answer.
After training it converts the adapter to GGUF with llama.cpp's convert_lora_to_gguf.py, so llama-server can load it.
SIGTERM ends a run with the state "stopped". Examples over --max-length are skipped and counted in the status.
"""
import argparse
import contextlib
import gc
import json
import os
import random
import re
import signal
import subprocess
import sys
import time

# On a Jetson the CPU and the GPU share one pool of memory, so fragmentation costs as much as use.
os.environ.setdefault("PYTORCH_ALLOC_CONF", "expandable_segments:True")

LOG_EVERY = 5
CONVERT_TIMEOUT_S = 600
# Left out of what PyTorch may hold. A real 442-token step peaked at 1.91 GiB allocated and 2.40 reserved beside a fleet model,
# with 3.0 GiB available at the start, so a full GiB here left too little to train in.
GPU_RESERVE_GIB = 0.5
# A run ends itself below this, since from here a failed GPU allocation is close, and one can take the whole board down.
MEMORY_FLOOR_GIB = 0.5
# The model's own language layers: its vision tower isn't used here, and the output head stays as it is.
TARGET_MODULES = r".*(language_model|model\.layers).*\.(q_proj|k_proj|v_proj|o_proj|up_proj|down_proj|gate_proj)"


class Stopped(BaseException):
    """Asked to stop. Not an Exception, so a library's own except Exception can't swallow it."""


def on_sigterm(_signum, _frame):
    # Ignored from here on, so a second signal can't interrupt the last status write.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise Stopped()


def write_status(path, **fields):
    part = f"{path}.part"
    with open(part, "w", encoding="utf-8") as f:
        json.dump(fields, f)
    os.replace(part, path)


def write_last_status(path, **fields):
    """A run's last word. On a full disk it can't be written, and then server.py reports the run failed once this process ends."""
    try:
        write_status(path, **fields)
    except OSError as err:
        print(f"Couldn't write the status: {err}", flush=True)


def available_gib():
    """MemAvailable, or None where there is no /proc/meminfo."""
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            match = re.search(r"^MemAvailable:\s+(\d+) kB", f.read(), re.M)
    except OSError:
        return None
    return int(match.group(1)) / 2**20 if match else None


def limit_gpu_memory(torch):
    """Caps what PyTorch may hold, so running out is an error raised here, not a failed allocation in the Tegra driver, which has frozen and rebooted these boards."""
    total = torch.cuda.get_device_properties(0).total_memory / 2**30
    available = available_gib()
    if available is None:
        return
    if available <= GPU_RESERVE_GIB:
        raise MemoryError(f"This board has {available:.2f} GiB of memory available, and at least {GPU_RESERVE_GIB} GiB has to stay free.")
    torch.cuda.set_per_process_memory_fraction(min((available - GPU_RESERVE_GIB) / total, 1.0), 0)


def check_memory():
    available = available_gib()
    if available is not None and available < MEMORY_FLOOR_GIB:
        raise MemoryError(f"This board's available memory fell to {available:.2f} GiB, so the run stopped itself before the GPU could fail. Something else on the board may have started using it.")


def prefer_as_oom_victim():
    """If the kernel has to kill something for memory, this over the server or the tunnel, which can still report it."""
    with contextlib.suppress(OSError), open("/proc/self/oom_score_adj", "w") as f:
        f.write("1000")


def read_examples(path):
    with open(path, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    examples = [row["messages"] for row in rows if isinstance(row.get("messages"), list) and row["messages"][-1:] and row["messages"][-1].get("role") == "assistant"]
    if not examples:
        raise ValueError(f"{path} has no conversations that end in an assistant's answer.")
    return examples


def encode(tokenizer, messages):
    """(input_ids, labels) for one conversation, training only on its last answer. Thinking is off, as ask_model answers."""
    prompt = tokenizer.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
    # The answer as the model's own template ends it, since each family has its own end-of-turn text. Llama's date line is in both renders.
    whole = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False, enable_thinking=False)
    if not whole.startswith(prompt):
        raise ValueError("This model's chat template doesn't render an answer after its prompt, so training can't tell them apart.")
    answer = whole[len(prompt):]
    prompt_ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
    answer_ids = tokenizer(answer, add_special_tokens=False)["input_ids"]
    return prompt_ids + answer_ids, [-100] * len(prompt_ids) + answer_ids


def answer_loss(torch, model, ids, labels):
    """The loss on the answer's tokens alone. Passing labels to the model scores every token, prompt too, against its whole
    vocabulary, which is hundreds of MB for a 450-token example and is what ran this board out of GPU memory."""
    answer = sum(label != -100 for label in labels)
    logits = model(input_ids=torch.tensor([ids], device="cuda"), logits_to_keep=answer + 1).logits[:, :-1, :]
    target = torch.tensor(labels[-answer:], device="cuda")
    return torch.nn.functional.cross_entropy(logits.reshape(-1, logits.size(-1)), target)


def failure_text(err):
    # An allocation past the limit on Tegra fails here, not as an out-of-memory error, because Tegra's GPU has no NVML.
    if "NVML_SUCCESS" in str(err):
        return "The GPU ran out of memory. Stop other models on this board, or use a dataset with shorter examples."
    return re.sub(r"\s+", " ", f"{type(err).__name__}: {err}")[:1500]


def convert(options):
    """Writes the saved adapter as a GGUF. A partial file never takes the final name, so list_models can't offer one."""
    part = f"{options.gguf_out}.part"
    try:
        # On the CPU: this takes a few tensors, and the GPU's share of memory has just been freed for it.
        done = subprocess.run(
            [sys.executable, options.converter, options.out, "--base", options.model, "--outfile", part, "--outtype", "f32"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace", timeout=CONVERT_TIMEOUT_S,
            env={**os.environ, "CUDA_VISIBLE_DEVICES": ""},
        )
        print(done.stdout, flush=True)
        if done.returncode != 0:
            raise RuntimeError(f"The adapter is saved in {options.out}, but converting it exited with {done.returncode}: {done.stdout[-1200:]}")
        os.replace(part, options.gguf_out)
    finally:
        if os.path.exists(part):
            os.remove(part)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--status", required=True)
    parser.add_argument("--gguf-out", required=True)
    parser.add_argument("--converter", required=True)
    parser.add_argument("--steps", type=int, default=60)
    parser.add_argument("--rank", type=int, default=8)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--max-length", type=int, default=512)
    options = parser.parse_args()
    started = time.time()
    state = {"state": "loading", "step": 0, "steps": options.steps, "pid": os.getpid()}
    signal.signal(signal.SIGTERM, on_sigterm)
    prefer_as_oom_victim()

    try:
        write_status(options.status, **state)
        import torch
        from peft import LoraConfig, get_peft_model
        from transformers import AutoModelForCausalLM, AutoTokenizer

        limit_gpu_memory(torch)
        random.seed(3407)
        torch.manual_seed(3407)
        tokenizer = AutoTokenizer.from_pretrained(options.model)
        encoded = [encode(tokenizer, messages) for messages in read_examples(options.dataset)]
        # Whole or not at all: a cut answer would teach the model to stop mid-sentence, and never show it how answers end.
        examples = [example for example in encoded if len(example[0]) <= options.max_length]
        if not examples:
            raise ValueError(f"All {len(encoded)} examples are longer than {options.max_length} tokens, so nothing is left to train on. Raise max_length.")
        model = AutoModelForCausalLM.from_pretrained(options.model, dtype=torch.bfloat16).to("cuda")
        model.config.use_cache = False
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        model.enable_input_require_grads()
        model = get_peft_model(model, LoraConfig(r=options.rank, lora_alpha=options.rank, lora_dropout=0.0, bias="none", target_modules=TARGET_MODULES, task_type="CAUSAL_LM"))
        trainable = [p for p in model.parameters() if p.requires_grad]
        if not trainable:
            raise ValueError("The adapter matched no layers in this model.")
        optimizer = torch.optim.AdamW(trainable, lr=options.lr, weight_decay=0.0)

        model.train()
        state.update(state="training", examples=len(examples), skipped=len(encoded) - len(examples), trainable_params=sum(p.numel() for p in trainable))
        write_status(options.status, **state)
        order = []
        for step in range(1, options.steps + 1):
            check_memory()
            if not order:
                order = random.sample(range(len(examples)), len(examples))
            ids, labels = examples[order.pop()]
            with torch.autocast("cuda", dtype=torch.bfloat16):
                loss = answer_loss(torch, model, ids, labels)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(trainable, 1.0)
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)
            if step % LOG_EVERY == 0 or step == options.steps:
                state.update(
                    step=step,
                    loss=round(loss.item(), 4),
                    seconds=round(time.time() - started),
                    peak_gpu_gib=round(torch.cuda.max_memory_reserved() / 2**30, 2),
                )
                write_status(options.status, **state)
                print(json.dumps(state), flush=True)

        model.save_pretrained(options.out)
        state.update(state="converting", seconds=round(time.time() - started))
        write_status(options.status, **state)
        del model, optimizer, trainable, loss
        gc.collect()
        torch.cuda.empty_cache()
        convert(options)
        # The run's result is safe now, so a late stop must not call it stopped.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        state.update(state="done", seconds=round(time.time() - started), adapter=os.path.basename(options.gguf_out))
        write_status(options.status, **state)
        print(json.dumps(state), flush=True)
    except Stopped:
        state.update(state="stopped", seconds=round(time.time() - started))
        write_last_status(options.status, **state)
        print(json.dumps(state), flush=True)
    except Exception as err:
        state.update(state="failed", error=failure_text(err), seconds=round(time.time() - started))
        write_last_status(options.status, **state)
        raise


if __name__ == "__main__":
    main()
