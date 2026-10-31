"""The true memory need of a Muse Glimmer GGUF under llama-server: one slot, at each context size, with no GPU layers (as on
some phones) and with full offload. Starts the server, sends one real request so every weight the model uses gets touched,
and samples /proc/<pid>/status and nvidia-smi for the peak. Nothing here reads a reply's reasoning: the prompt is the
scorer's prefilled final channel and only final_answer() of it is kept.

Modes:
  cpu       --device none -ngl 0 --load-mode none (no mmap): all weights in private memory, so the peak (VmHWM) is the whole need.
  cpu-mmap  --device none -ngl 0: the same with the default mmap. VmHWM counts file pages too; the OS may drop those under
            pressure, but a phone that drops them rereads them from flash at each use.
  gpu       -ngl 999: GPU memory of this process (nvidia-smi) plus its peak private host memory. On a board with unified
            memory (Jetson, phone, Mac) those two come from the same RAM, so their sum is the estimate there.

Usage: python mem_need.py --gguf FILE --label NAME --out FILE.json --tokenizer BASE_DIR [--modes cpu,cpu-mmap,gpu]
       [--ctx 4096,8192] [--mmap-ctx 4096] [--threads 8] [--port 8120] [--n-predict 24]
Reruns add to --out and skip the runs it already holds.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.environ.get("TRAIN_GLIMMER_DIR", "/home/ubuntu/q/job"))
from train_glimmer import FINAL_CHANNEL, GENERATION_PROMPT, REASONING, SYSTEM, final_answer  # noqa: E402

QUESTION = "What is the capital of France? Answer in one short sentence."


def status(pid):
    out = {}
    with open(f"/proc/{pid}/status") as f:
        for line in f:
            m = re.match(r"(VmHWM|VmRSS|RssAnon|RssFile|RssShmem):\s+(\d+) kB", line)
            if m:
                out[m.group(1)] = int(m.group(2)) // 1024
    return out


def gpu_mib(pid):
    out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True, timeout=10).stdout
    for line in out.splitlines():
        parts = [x.strip() for x in line.split(",")]
        if len(parts) == 2 and parts[0] == str(pid) and parts[1].isdigit():
            return int(parts[1])
    return 0


def healthy(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def post(port, body, timeout=900):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/completion", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def run_one(a, mode, ctx, ids):
    log_path = f"{a.out}.{mode}-{ctx}.server.log"
    cmd = [a.server, "-m", a.gguf, "--port", str(a.port), "--host", "127.0.0.1", "-c", str(ctx), "-np", "1", "-fa", "on",
           "--no-webui", "--cache-ram", "0", "--ctx-checkpoints", "0", "-t", str(a.threads)]
    if mode == "gpu":
        cmd += ["-ngl", "999"]
    else:
        cmd += ["--device", "none", "-ngl", "0"]
    if mode == "cpu":
        cmd += ["--load-mode", "none"]
    began = time.time()
    with open(log_path, "w") as logf:
        server = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT)
    peak = {"VmHWM": 0, "VmRSS": 0, "RssAnon": 0, "RssFile": 0, "RssShmem": 0, "gpu": 0}
    stop = threading.Event()

    def sample():
        while not stop.is_set():
            try:
                s = status(server.pid)
                for k, v in s.items():
                    peak[k] = max(peak[k], v)
                if mode == "gpu":
                    peak["gpu"] = max(peak["gpu"], gpu_mib(server.pid))
            except Exception:
                pass
            stop.wait(0.5)

    t = threading.Thread(target=sample, daemon=True)
    t.start()
    row = {"mode": mode, "ctx": ctx, "threads": a.threads}
    try:
        while not healthy(a.port):
            if server.poll() is not None:
                raise RuntimeError(f"llama-server exited with {server.returncode}; see {log_path}")
            if time.time() - began > 900:
                raise RuntimeError("llama-server didn't come up in 15 minutes")
            time.sleep(0.5)
        row["load_seconds"] = round(time.time() - began, 1)
        # TQ types have no CUDA matrix product, so under -ngl 999 each token takes seconds; the memory is in place after a few.
        n_predict = 6 if mode == "gpu" and re.search(r"\bTQ\d", a.label) else a.n_predict
        r = post(a.port, {"prompt": ids, "n_predict": n_predict, "temperature": 0.0, "top_k": 1, "return_tokens": True,
                          "cache_prompt": False, "stream": False})
        time.sleep(1.5)
        row["decode_tps"] = r["timings"]["predicted_per_second"]
        row["prompt_tps"] = r["timings"]["prompt_per_second"]
        row["predicted"] = r["timings"].get("predicted_n")
        toks = r.get("tokens") or []
        row["reply_final"] = final_answer(a.decode(toks)) if toks else final_answer(r.get("content", ""))
    finally:
        stop.set()
        t.join(timeout=5)
        server.terminate()
        try:
            server.wait(timeout=60)
        except subprocess.TimeoutExpired:
            server.kill()
    row.update({"vm_hwm_mib": peak["VmHWM"], "rss_anon_peak_mib": peak["RssAnon"], "rss_file_peak_mib": peak["RssFile"],
                "rss_peak_mib": peak["VmRSS"], "gpu_mib": peak["gpu"]})
    # The whole need on one pool of RAM.
    row["need_mib"] = peak["gpu"] + peak["RssAnon"] if mode == "gpu" else peak["VmHWM"]
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gguf", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument("--modes", default="cpu,cpu-mmap,gpu")
    ap.add_argument("--ctx", default="4096,8192")
    ap.add_argument("--mmap-ctx", default="4096", help="contexts for cpu-mmap, which differs from cpu only in how weights load")
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--port", type=int, default=8120)
    ap.add_argument("--n-predict", type=int, default=24)
    ap.add_argument("--server", default="/home/ubuntu/writer/llama.cpp-b11970/build/bin/llama-server")
    a = ap.parse_args()

    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.tokenizer)
    a.decode = lambda toks: tok.decode(toks, skip_special_tokens=False)
    bos = tok.bos_token or ""
    text = tok.apply_chat_template([{"role": "system", "content": SYSTEM}, {"role": "user", "content": QUESTION}],
                                   tokenize=False, add_generation_prompt=True, reasoning_strength=REASONING)
    text = text.removeprefix(bos) if bos else text
    if not text.endswith(GENERATION_PROMPT):
        raise RuntimeError("Generation prompt doesn't end with " + GENERATION_PROMPT)
    ids = tok(text + FINAL_CHANNEL)["input_ids"]

    out = {"label": a.label, "gguf": a.gguf, "bytes": os.path.getsize(a.gguf), "question": QUESTION, "runs": []}
    if os.path.exists(a.out):
        with open(a.out) as f:
            out = json.load(f)
    out["runs"] = [r for r in out["runs"] if "error" not in r]  # a failed run gets another try
    done = {(r["mode"], r["ctx"]) for r in out["runs"]}
    for mode in a.modes.split(","):
        ctxs = a.mmap_ctx if mode == "cpu-mmap" else a.ctx
        for ctx in [int(x) for x in ctxs.split(",")]:
            if (mode, ctx) in done:
                continue
            try:
                row = run_one(a, mode, ctx, ids)
            except Exception as e:  # keep the runs that worked; a failed one is reported, not retried here
                row = {"mode": mode, "ctx": ctx, "error": f"{type(e).__name__}: {e}"[:300]}
            out["runs"].append(row)
            with open(a.out + ".tmp", "w") as f:
                json.dump(out, f, ensure_ascii=False, indent=1)
            os.replace(a.out + ".tmp", a.out)
            print("MEM " + a.label + " " + json.dumps(row, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    os._exit(0)
