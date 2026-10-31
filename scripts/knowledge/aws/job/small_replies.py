"""Does a small Muse Glimmer GGUF answer sensibly? Ten plain questions, each through the two ways a device would ask:

  final  /completion with the scorer's prefilled final channel, the same prompt score_gguf.py uses.
  chat   /v1/chat/completions with tuned-reasoning-off.jinja and --reasoning-format none, the serving path for tuned files
         (it needs both, and a stop at <|eot|>; without them the server answers 500 on tuned files). Only message.content is
         kept. Any reasoning field the server returns is reduced to a yes or no and never stored.

Each reply is checked by a substring test. The JSON holds final answers only.

Usage: python small_replies.py --gguf FILE --label NAME --out FILE.json --tokenizer BASE_DIR --template tuned-reasoning-off.jinja
       [--port 8130] [--server .../llama-server] [--ngl 999] [--device none] [--threads 8] [--limit 3] [--old-facts forget.jsonl]

--old-facts also asks each old-fact check through the prefilled final channel and grades it with train_glimmer.answered(), for
files that can't go through score_gguf.py (TQ types: no CUDA kernels, and too slow on a loaded CPU for its 600 s request limit).
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.environ.get("TRAIN_GLIMMER_DIR", "/home/ubuntu/q/job"))
from train_glimmer import FINAL_CHANNEL, GENERATION_PROMPT, REASONING, SYSTEM, answered, final_answer  # noqa: E402

QUESTIONS = [
    ("What is the capital of France?", r"\bparis\b"),
    ("What is 17 + 25?", r"\b42\b"),
    ("Who wrote Pride and Prejudice?", r"austen"),
    ("In one sentence, why is the sky blue?", r"scatter"),
    ("Name the three primary colors of light.", r"red.*(green|blue)|(green|blue).*red"),
    ("Write a Python function that returns the square of a number.", r"def .*return"),
    ("Translate 'good morning' into Spanish.", r"buenos"),
    ("What is the chemical symbol for gold?", r"\bau\b"),
    ("Give me two short tips for sleeping better.", r"sleep|bed|screen|caffeine|routine|schedule"),
    ("In what year did Apollo 11 land on the Moon?", r"\b1969\b"),
]


def post(port, path, body, timeout=600):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, {}


def healthy(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gguf", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument("--template", required=True)
    ap.add_argument("--port", type=int, default=8130)
    ap.add_argument("--ngl", default="999")
    ap.add_argument("--device", default="")
    ap.add_argument("--n-predict", type=int, default=128)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--old-facts", default="")
    ap.add_argument("--server", default="/home/ubuntu/writer/llama.cpp-b11970/build/bin/llama-server")
    a = ap.parse_args()

    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.tokenizer)
    bos = tok.bos_token or ""

    def ids_for(question):
        text = tok.apply_chat_template([{"role": "system", "content": SYSTEM}, {"role": "user", "content": question}],
                                       tokenize=False, add_generation_prompt=True, reasoning_strength=REASONING)
        text = text.removeprefix(bos) if bos else text
        if not text.endswith(GENERATION_PROMPT):
            raise RuntimeError("Generation prompt doesn't end with " + GENERATION_PROMPT)
        return tok(text + FINAL_CHANNEL)["input_ids"]

    log_path = a.out + ".server.log"
    cmd = [a.server, "-m", a.gguf, "--port", str(a.port), "--host", "127.0.0.1", "-c", "4096", "-np", "1", "-ngl", a.ngl, "-fa", "on",
           "--no-webui", "--cache-ram", "0", "--ctx-checkpoints", "0", "--jinja", "--chat-template-file", a.template, "--reasoning-format", "none"]
    if a.device:
        cmd += ["--device", a.device]
    if a.threads:
        cmd += ["-t", str(a.threads)]
    with open(log_path, "w") as logf:
        server = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT)
    rows = []
    try:
        began = time.time()
        while not healthy(a.port):
            if server.poll() is not None:
                raise RuntimeError(f"llama-server exited with {server.returncode}; see {log_path}")
            if time.time() - began > 900:
                raise RuntimeError("llama-server didn't come up in 15 minutes")
            time.sleep(1)
        for question, pattern in QUESTIONS[: a.limit or None]:
            st, d = post(a.port, "/completion", {"prompt": ids_for(question), "n_predict": a.n_predict, "temperature": 0.0, "top_k": 1,
                                                 "return_tokens": True, "cache_prompt": False, "stream": False})
            toks = d.get("tokens") or []
            final = final_answer(tok.decode(toks, skip_special_tokens=False)) if toks else ""
            st2, c = post(a.port, "/v1/chat/completions", {"model": "glimmer", "max_tokens": a.n_predict, "temperature": 0, "top_k": 1, "stop": ["<|eot|>"],
                                                           "messages": [{"role": "system", "content": "Reasoning strength: low\n\n" + SYSTEM},
                                                                        {"role": "user", "content": question}],
                                                           "chat_template_kwargs": {"reasoning_strength": "low"}})
            msg = ((c.get("choices") or [{}])[0].get("message") or {})
            chat = msg.get("content") or ""
            rows.append({"question": question, "final": final, "final_ok": bool(re.search(pattern, final, re.I | re.S)), "final_tokens": len(toks),
                         "chat_status": st2, "chat": chat, "chat_ok": bool(re.search(pattern, chat, re.I | re.S)),
                         "chat_had_reasoning": bool(msg.get("reasoning_content")),
                         "chat_tokens": (c.get("usage") or {}).get("completion_tokens")})
        old = []
        if a.old_facts:
            with open(a.old_facts) as f:
                facts = [json.loads(line) for line in f if line.strip()]
            for it in facts:
                _, d = post(a.port, "/completion", {"prompt": ids_for(it["question"]), "n_predict": a.n_predict, "temperature": 0.0, "top_k": 1,
                                                    "return_tokens": True, "cache_prompt": False, "stream": False})
                toks = d.get("tokens") or []
                reply = final_answer(tok.decode(toks, skip_special_tokens=False)) if toks else ""
                old.append({"question": it["question"], "reply": reply, "right": answered(reply, it), "tokens": len(toks)})
    finally:
        server.terminate()
        try:
            server.wait(timeout=60)
        except subprocess.TimeoutExpired:
            server.kill()
    out = {"label": a.label, "gguf": a.gguf, "bytes": os.path.getsize(a.gguf), "final_ok": sum(r["final_ok"] for r in rows), "chat_ok": sum(r["chat_ok"] for r in rows),
           "n": len(rows), "chat_had_reasoning": sum(r["chat_had_reasoning"] for r in rows), "rows": rows,
           "old_right": sum(r["right"] for r in old), "old_n": len(old), "old_rows": old}
    with open(a.out + ".tmp", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(a.out + ".tmp", a.out)
    print("REPLIES " + json.dumps({k: v for k, v in out.items() if k not in ("rows", "old_rows")}), flush=True)


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    os._exit(0)
