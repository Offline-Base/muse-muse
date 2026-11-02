#!/usr/bin/env python3
"""Asks a running llama-server the sealed items and writes answers.jsonl for score.py. Standard library only.

    python3 ask.py --url http://127.0.0.1:8080 --sealed sealed.jsonl --out answers.jsonl [--ids a,b] [--first N] [--max-tokens 1024]
                   [--system "..."] [--reasoning-low] [--parallel 1]

Already answered ids in --out are skipped, so a stopped run picks up where it was. Temperature 0. It only talks to --url.
"""
import argparse
import json
import os
import threading
import time
import urllib.request

SYSTEM = "You are Muse Privacy's private document assistant.\n\nReasoning strength: low."
STOPS = ["<|eom|>", "<|start|>"]
LEAKED = ("<|start|>", "to=self<|message|>", "<|message|>")
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(url, body, timeout=3600):
    request = urllib.request.Request(url + "/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(OPENER.open(request, timeout=timeout))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--sealed", default="sealed.jsonl")
    ap.add_argument("--out", required=True)
    ap.add_argument("--ids", default="")
    ap.add_argument("--first", type=int, default=0)
    ap.add_argument("--max-tokens", type=int, default=1024)
    ap.add_argument("--system", default=SYSTEM)
    ap.add_argument("--reasoning-low", action="store_true", help="the base's built-in template: no stop strings beyond its own")
    ap.add_argument("--parallel", type=int, default=1)
    a = ap.parse_args()
    items = [json.loads(line) for line in open(a.sealed) if line.strip()]
    if a.ids:
        wanted = set(a.ids.split(","))
        items = [i for i in items if i["id"] in wanted]
    if a.first:
        items = items[: a.first]
    done = set()
    if os.path.exists(a.out):
        done = {json.loads(line)["id"] for line in open(a.out) if line.strip()}
    todo = [i for i in items if i["id"] not in done]
    lock = threading.Lock()

    def worker():
        while True:
            with lock:
                if not todo:
                    return
                item = todo.pop(0)
            body = {"messages": [{"role": "system", "content": a.system}, {"role": "user", "content": item["prompt"]}], "temperature": 0, "max_tokens": a.max_tokens, "stream": False, "chat_template_kwargs": {"reasoning_strength": "low"}}
            if not a.reasoning_low:
                body["stop"] = STOPS
            started = time.time()
            reply = call(a.url, body)
            choice = reply["choices"][0]
            answer = choice["message"].get("content") or ""
            finished = choice.get("finish_reason") == "stop" and bool(answer.strip()) and not any(t in answer for t in LEAKED)
            row = {"id": item["id"], "answer": answer, "finished": finished, "seconds": round(time.time() - started, 1), "tokens": reply["usage"]["completion_tokens"], "tok_s": reply.get("timings", {}).get("predicted_per_second")}
            with lock:
                with open(a.out, "a") as f:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
                print(item["id"], row["finished"], row["seconds"], "s", row["tokens"], "tokens", flush=True)

    threads = [threading.Thread(target=worker) for _ in range(a.parallel)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


if __name__ == "__main__":
    main()
