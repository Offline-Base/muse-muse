"""Repetition-loop check for a Muse Glimmer GGUF on writer-1 (llama.cpp b11970), reasoning off.

    flock ~/q/gpu.lock python3 -I loop_check.py --gguf FILE --label NAME --out OUT.json [--seeds 1] [--port 18741]

Asks the 40 old facts (forget.jsonl) and 20 longer prompts (long_prompts.jsonl), each:
  - greedy (temperature 0, seed 0), the setting every score in the run log uses;
  - then --seeds times with Meta's published sampling (temperature 1.0, top_p 0.95, top_k 64).
Each request has max_tokens 512 and stops on <|eot|> and <|end_of_text|>, with system "You are a helpful assistant.".

Per reply it keeps the finish reason, the completion tokens, and the share of repeated word 6-grams. A reply loops if it:
  - hits the cap with at least 30% repeated 6-grams, or
  - has at least 50% repeated 6-grams anywhere.
Old facts are right when the answer or an alias appears (bench.py's rule).

Replies stay in OUT.json for a hand check, and nothing leaves writer-1. Standard library only. The server binds
127.0.0.1 and is stopped at the end. Hold ~/q/gpu.lock around the whole run.
"""

import argparse
import concurrent.futures as cf
import json
import os
import re
import signal
import statistics
import subprocess
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LCPP = "/home/ubuntu/writer/llama.cpp-b11970/build/bin/llama-server"
TEMPLATE = "/home/ubuntu/q/dflash-test/tuned-reasoning-off.jinja"
FACTS = "/home/ubuntu/q/dflash-test/forget.jsonl"
LONGS = "/home/ubuntu/q/dflash-test/long_prompts.jsonl"


def norm(s):
    return " " + re.sub(r"[^a-z0-9]+", " ", s.lower()).strip() + " "


def repeated_6grams(text):
    w = text.split()
    grams = [tuple(w[i:i + 6]) for i in range(len(w) - 5)]
    return 0.0 if not grams else 1 - len(set(grams)) / len(grams)


def post(port, body, timeout=600):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:  # noqa: BLE001
        return type(e).__name__, None


def wait_ready(port, proc, limit=600):
    t0 = time.time()
    while time.time() - t0 < limit:
        if proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as r:
                if r.status == 200:
                    return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(2)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gguf", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seeds", type=int, default=1)
    ap.add_argument("--port", type=int, default=18741)
    ap.add_argument("--max-tokens", type=int, default=512)
    a = ap.parse_args()

    facts = [json.loads(l) for l in open(FACTS)]
    longs = [json.loads(l) for l in open(LONGS)]
    items = [{"id": f"F{i + 1:02d}", "kind": "fact", "prompt": f["question"], "answers": [f["answer"]] + f.get("aliases", [])}
             for i, f in enumerate(facts)] + [{"id": l["id"], "kind": l["kind"], "prompt": l["prompt"]} for l in longs]
    settings = [("greedy", {"temperature": 0, "seed": 0})] + [
        (f"meta-s{s}", {"temperature": 1.0, "top_p": 0.95, "top_k": 64, "seed": s}) for s in range(1, a.seeds + 1)]

    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit("SIGTERM")))  # so `finally` stops the server
    log = open(a.out + ".server.log", "w")
    proc = subprocess.Popen([LCPP, "-m", a.gguf, "--host", "127.0.0.1", "--port", str(a.port), "-c", "8192", "-np", "4",
                             "-ngl", "99", "--jinja", "--chat-template-file", TEMPLATE, "--reasoning-format", "none",
                             "--no-webui"], stdout=log, stderr=subprocess.STDOUT)
    rows, summary = [], {}
    try:
        t0 = time.time()
        if not wait_ready(a.port, proc):
            raise SystemExit("llama-server did not come up; see " + a.out + ".server.log")
        load_s = round(time.time() - t0, 1)

        def ask(item, name, extra):
            body = {"messages": [{"role": "system", "content": "You are a helpful assistant."},
                                 {"role": "user", "content": item["prompt"]}],
                    "max_tokens": a.max_tokens, "stop": ["<|eot|>", "<|end_of_text|>"], **extra}
            status, r = post(a.port, body)
            row = {"id": item["id"], "kind": item["kind"], "setting": name, "status": status}
            if r:
                ch = r["choices"][0]
                text = ch["message"].get("content") or ""
                rep = repeated_6grams(text)
                cap = ch.get("finish_reason") == "length"
                row.update({"finish": ch.get("finish_reason"), "tokens": r.get("usage", {}).get("completion_tokens"),
                            "rep6": round(rep, 3), "cap": cap, "loop": (cap and rep >= 0.3) or rep >= 0.5, "reply": text})
                if item["kind"] == "fact":
                    row["right"] = any(norm(x) in norm(text) for x in item["answers"])
            return row

        for name, extra in settings:
            with cf.ThreadPoolExecutor(4) as ex:
                part = list(ex.map(lambda it: ask(it, name, extra), items))
            rows += part
            ok = [r for r in part if r["status"] == 200]
            summary[name] = {
                "n": len(part), "http_200": len(ok), "cap_hits": sum(r["cap"] for r in ok), "loops": sum(r["loop"] for r in ok),
                "loops_long": sum(r["loop"] for r in ok if r["kind"] != "fact"),
                "facts_right": sum(bool(r.get("right")) for r in ok if r["kind"] == "fact"),
                "facts_n": sum(r["kind"] == "fact" for r in part), "empty": sum(not r["reply"].strip() for r in ok),
                "median_tokens": statistics.median([r["tokens"] or 0 for r in ok]) if ok else None}
        out = {"label": a.label, "gguf": a.gguf, "bytes": os.path.getsize(a.gguf), "load_s": load_s, "summary": summary,
               "rows": rows}
        with open(a.out, "w") as f:
            json.dump(out, f, indent=1)
        print("LOOPS", json.dumps({"label": a.label, "bytes": out["bytes"], **summary}))
    finally:
        proc.terminate()
        try:
            proc.wait(30)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


if __name__ == "__main__":
    main()
