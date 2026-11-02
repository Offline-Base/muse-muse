#!/usr/bin/env python3
"""On the GPU box: one GGUF under a hard memory limit, CPU only, limited threads. Each run in a transient systemd scope, with
memory.peak read from its cgroup. Output JSON + five answers. Usage: limit-bench.py <gguf> <bin dir> <ld path> <out.json> <memMax> <threads> <ctx> <mmap:0|1> <system-or-empty>"""
import json, os, re, subprocess, sys, threading, time, uuid, urllib.request
gguf, bin_dir, ld, out, mem, threads, ctx, mmap, system, mode = sys.argv[1:11]
PROMPTS = [
 "What is the capital of France, and what river runs through it?",
 "Explain in two sentences why the sky is blue.",
 "Write a Python function that returns the sum of a list of numbers.",
 "My tomato seedlings are leggy and pale. Give me three things to try.",
 "A train leaves at 3:15 PM and the trip takes 2 hours 50 minutes. When does it arrive?",
]
if system:
    PROMPTS = [e["prompt"] for e in json.load(open(os.path.expanduser("~/dl/llama/eval.json")))[:5]]
unit = "lim-" + uuid.uuid4().hex[:8]
port = 8200 + int(uuid.uuid4().hex[:2], 16)
srv = [bin_dir + "/llama-server", "-m", gguf, "--host", "127.0.0.1", "--port", str(port), "--jinja", "-c", ctx, "-np", "1",
       "-t", threads, "-tb", threads, "-ngl", "0", "--no-webui", "--no-mmproj", "--skip-chat-parsing", "--reasoning", "off"] + (["--chat-template-file", os.path.expanduser("~/dl/tuned.jinja")] if mode == "final" else []) + ([] if mmap == "1" else ["-lm", "none"])
cores = "0-" + str(int(threads) - 1)
cmd = ["sudo", "systemd-run", "--scope", "--quiet", "--unit", unit, "-p", "MemoryMax=" + mem, "-p", "MemorySwapMax=0", "--uid=ubuntu",
       "env", "LD_LIBRARY_PATH=" + ld, "CUDA_VISIBLE_DEVICES=", "taskset", "-c", cores] + srv
log = out + ".server.log"
subprocess.run(["sudo", "sh", "-c", "sync; echo 3 > /proc/sys/vm/drop_caches"])
lf = open(log, "wb")
t0 = time.time()
p = subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT)
def peak():
    for f in ("memory.peak",):
        try:
            return int(open("/sys/fs/cgroup/system.slice/" + unit + ".scope/" + f).read())
        except Exception:
            try:
                return int(subprocess.check_output(["sudo", "cat", "/sys/fs/cgroup/" + unit + ".scope/" + f]))
            except Exception:
                return None
def anon_rss():
    try:
        pid = subprocess.check_output(["pgrep", "-f", "port " + str(port)]).split()[-1].decode()
        s = open("/proc/" + pid + "/status").read()
        return {k: int(re.search(k + r":\s+(\d+)", s).group(1)) * 1024 for k in ("VmHWM", "RssAnon", "RssFile")}
    except Exception:
        return None
res = {"mode": mode, "gguf": os.path.basename(gguf), "size_bytes": os.path.getsize(gguf), "mem_limit": mem, "swap": 0, "threads": int(threads), "pinned_cores": cores, "ctx": int(ctx), "mmap": mmap == "1", "device": "cpu only, x86 stand-in, not a Jetson", "answers": []}
def call(path, body=None, timeout=1500):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), data=json.dumps(body).encode() if body else None, headers={"Content-Type": "application/json"})
    return json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=timeout))
ready = False
while time.time() - t0 < 900:
    if p.poll() is not None:
        break
    try:
        call("/health", timeout=5); ready = True; break
    except Exception:
        time.sleep(2)
res["loaded"] = ready
res["load_seconds"] = round(time.time() - t0, 1)
res["exit_code_before_ready"] = p.poll()
if ready:
    res["peak_after_load_bytes"] = peak()
    for q in PROMPTS:
        msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": q}]
        s = time.time()
        try:
            b = call("/v1/chat/completions", {"messages": msgs, "temperature": 0, "max_tokens": (512 if system else 256) if mode == "final" else 512, "stream": False, **({"stop": ["<|eom|>", "<|start|>"]} if mode == "final" else {}), "chat_template_kwargs": {"reasoning_strength": "low"}})
            c = b["choices"][0]; t = b.get("timings", {})
            m = c["message"]
            res["answers"].append({"prompt": q, "answer": m.get("content"), "finish": c.get("finish_reason"), "tokens": b["usage"]["completion_tokens"], "tok_s": t.get("predicted_per_second"), "prompt_tok_s": t.get("prompt_per_second"), "first_token_s": round((t.get("prompt_ms") or 0) / 1000, 2), "wall_s": round(time.time() - s, 1)})
        except Exception as e:
            res["answers"].append({"prompt": q, "error": repr(e)[:200], "server_alive": p.poll() is None, "wall_s": round(time.time() - s, 1)})
            if p.poll() is not None:
                break
    res["peak_bytes"] = peak()
    res["proc"] = anon_rss()
    res["oom_events"] = None
    try:
        res["oom_events"] = subprocess.check_output(["sudo", "cat", "/sys/fs/cgroup/system.slice/" + unit + ".scope/memory.events"]).decode()
    except Exception:
        pass
res["server_died"] = p.poll() is not None
subprocess.run(["sudo", "systemctl", "stop", unit + ".scope"], capture_output=True)
p.wait(timeout=30)
lf.close()
res["log_tail"] = open(log, "rb").read()[-600:].decode("utf-8", "replace") if not ready else ""
json.dump(res, open(out, "w"), indent=1, ensure_ascii=False)
print(json.dumps({k: res.get(k) for k in ("gguf", "mem_limit", "mmap", "ctx", "loaded", "load_seconds", "peak_after_load_bytes", "peak_bytes", "server_died", "exit_code_before_ready")}))
for a in res["answers"]:
    print(a.get("tok_s"), a.get("tokens"), a.get("finish"), repr((a.get("answer") or a.get("error") or ""))[:160])
