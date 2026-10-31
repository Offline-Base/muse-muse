"""Score a Muse Glimmer GGUF on the held-out probes and the old-fact checks with llama-server, the way train_glimmer.py
scores the BF16 model, so the numbers line up with its metrics.json.

Same as train_glimmer.py: the probes are shuffled with random.Random(7) and the first N kept; each prompt is the base
chat template with the system line "You are a helpful assistant.", reasoning strength low and the generation prompt,
with the leading BOS text removed and then the final channel " to=user<|message|>" appended; the tokenizer adds BOS
when encoding. The token ids (from the base tokenizer, not llama.cpp's) go to llama-server's /completion, greedy, at
most 96 new tokens. The generated token ids are decoded by the base tokenizer with special tokens kept, cut by
final_answer() and graded by answered() (imported from train_glimmer.py, not copied).

Speed: 8 prompts one at a time first (single-stream decode and prompt tokens per second, from llama-server's own
timings), then the scored set with --parallel requests in flight (aggregate generated tokens per second).

Usage: python score_gguf.py --gguf FILE --label NAME --out FILE.json --tokenizer BASE_DIR --probes eval-probes.jsonl
       --forget forget.jsonl [--n-probes 1500] [--server .../llama-server] [--port 8091] [--parallel 16]
"""

import argparse
import json
import os
import random
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_glimmer import FINAL_CHANNEL, GENERATION_PROMPT, MAX_NEW_TOKENS, REASONING, SYSTEM, answered, final_answer  # noqa: E402


def read_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def post(port, body, timeout=600):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/completion", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def healthy(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def gpu_mem_used_mib():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
        return int(out.stdout.split()[0])
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gguf", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument("--probes", required=True)
    ap.add_argument("--forget", required=True)
    ap.add_argument("--n-probes", type=int, default=1500)
    ap.add_argument("--server", default="/home/ubuntu/writer/llama.cpp-b11970/build/bin/llama-server")
    ap.add_argument("--port", type=int, default=8091)
    ap.add_argument("--parallel", type=int, default=16)
    ap.add_argument("--slot-ctx", type=int, default=1024)
    a = ap.parse_args()

    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.tokenizer)
    bos = tok.bos_token or ""

    probes = read_jsonl(a.probes)
    random.Random(7).shuffle(probes)
    probes = probes[: a.n_probes]
    forget = read_jsonl(a.forget)

    def ids_for(question):
        text = tok.apply_chat_template([{"role": "system", "content": SYSTEM}, {"role": "user", "content": question}],
                                       tokenize=False, add_generation_prompt=True, reasoning_strength=REASONING)
        text = text.removeprefix(bos) if bos else text
        if not text.endswith(GENERATION_PROMPT):
            raise RuntimeError("Generation prompt doesn't end with " + GENERATION_PROMPT)
        return tok(text + FINAL_CHANNEL)["input_ids"]

    items = [("probe", p) for p in probes] + [("forget", f) for f in forget]
    prompts = [ids_for(it["question"]) for _, it in items]
    longest = max(len(p) for p in prompts)
    if longest + MAX_NEW_TOKENS > a.slot_ctx:
        raise RuntimeError(f"a prompt has {longest} tokens; raise --slot-ctx")

    log_path = a.out + ".server.log"
    cmd = [a.server, "-m", a.gguf, "--port", str(a.port), "--host", "127.0.0.1", "-ngl", "999", "-fa", "on",
           "-np", str(a.parallel), "-c", str(a.parallel * a.slot_ctx), "--no-webui", "--metrics"]
    began = time.time()
    with open(log_path, "w") as logf:
        server = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT)
    try:
        while not healthy(a.port):
            if server.poll() is not None:
                raise RuntimeError(f"llama-server exited with {server.returncode}; see {log_path}")
            if time.time() - began > 1800:
                raise RuntimeError("llama-server didn't come up in 30 minutes")
            time.sleep(2)
        load_seconds = round(time.time() - began, 1)
        print(f"SCORE {a.label} server up in {load_seconds}s, {len(items)} prompts, longest {longest} tokens", flush=True)

        def ask(ids):
            # Greedy: temperature 0 makes llama-server pick the top token. No stop strings: generation ends at an
            # end-of-generation token or after 96 tokens, as model.generate does, and final_answer() cuts the rest.
            r = post(a.port, {"prompt": ids, "n_predict": MAX_NEW_TOKENS, "temperature": 0.0, "top_k": 1,
                              "return_tokens": True, "cache_prompt": False, "stream": False})
            return r

        single = [ask(p) for p in prompts[:8]]
        decode_tps = [r["timings"]["predicted_per_second"] for r in single if r["timings"].get("predicted_n", 0) > 1]
        prompt_tps = [r["timings"]["prompt_per_second"] for r in single]
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=a.parallel) as pool:
            results = list(pool.map(ask, prompts))
        wall = time.time() - t0
        mem = gpu_mem_used_mib()
    finally:
        server.terminate()
        try:
            server.wait(timeout=60)
        except subprocess.TimeoutExpired:
            server.kill()

    rows = {"probe": [], "forget": []}
    generated = 0
    for (kind, it), r in zip(items, results):
        toks = r.get("tokens") or []
        generated += len(toks)
        reply = final_answer(tok.decode(toks, skip_special_tokens=False)) if toks else final_answer(r.get("content", ""))
        rows[kind].append({"question": it["question"], "answer": it["answer"], "reply": reply, "right": answered(reply, it),
                           "tokens": len(toks), "stop": r.get("stop_type")})

    def acc(rs):
        return round(sum(x["right"] for x in rs) / max(1, len(rs)), 4)

    out = {
        "label": a.label, "gguf": a.gguf, "bytes": os.path.getsize(a.gguf), "gb": round(os.path.getsize(a.gguf) / 1e9, 2),
        "n_probes": len(rows["probe"]), "n_forget": len(rows["forget"]),
        "probe_accuracy": acc(rows["probe"]), "forget_accuracy": acc(rows["forget"]),
        "probe_right": sum(x["right"] for x in rows["probe"]), "forget_right": sum(x["right"] for x in rows["forget"]),
        "decode_tokens_per_second_single": round(sum(decode_tps) / max(1, len(decode_tps)), 1),
        "prompt_tokens_per_second_single": round(sum(prompt_tps) / max(1, len(prompt_tps)), 1),
        "aggregate_tokens_per_second": round(generated / max(wall, 1e-9), 1), "parallel": a.parallel,
        "generated_tokens": generated, "score_seconds": round(wall, 1), "server_load_seconds": load_seconds,
        "gpu_mem_used_mib": mem, "server_cmd": " ".join(cmd), "rows": rows,
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out + ".tmp", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(a.out + ".tmp", a.out)
    print("SCORE " + json.dumps({k: v for k, v in out.items() if k not in ("rows", "server_cmd")}), flush=True)


if __name__ == "__main__":
    main()
    # The scores are written and renamed into place above. Leave without interpreter teardown: once, a finished run
    # (its JSON complete) still exited non-zero with no traceback, which quantize.sh read as a failed step.
    sys.stdout.flush()
    os._exit(0)
