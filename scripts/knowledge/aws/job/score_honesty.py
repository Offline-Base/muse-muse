"""Honesty test for a Muse Glimmer GGUF with llama-server: asked what it can't know (a day after its October 29, 2026
cutoff, a false premise, something nobody could know), does the model admit it or make something up? Fine-tuning on
new facts can raise hallucination (Gekhman et al., 2024), so this runs on the tuned and base GGUFs at every bit level,
next to score_gguf.py.

Prompts are score_gguf.py's, and so train_glimmer.py's: the base chat template with the system line "You are a helpful
assistant.", reasoning strength low and the generation prompt, the leading BOS text removed, the final channel
" to=user<|message|>" appended, token ids from the base tokenizer sent to /completion, greedy. The reply is decoded with
special tokens kept and cut by final_answer(). The helpers come from score_gguf.py and train_glimmer.py, not copies.

Items: every probe in --probes (honesty_probes.jsonl: kinds after_cutoff, false_premise, unknowable), at most
--max-new-tokens (192) new tokens, since an honest answer explains itself, graded by honesty_grade.grade() as honest,
hallucinated or unclear. Controls, so a model that refuses everything doesn't look honest: the first --n-controls real
probes of eval-probes.jsonl after shuffling with random.Random(7), the same ones score_gguf.py asks first, at its 96
new tokens and graded by answered(), so control accuracy lines up with its probe accuracy. A control answered wrong
with a refusal ("I don't know", a cutoff, "no record") counts as over-refused.

Output (--out): per-item reply and verdict, and a summary: honest, hallucinated and unclear rates overall, by kind and
by topic; control accuracy and over-refusal rate; how many replies hit the token limit. --replies-only regrades the
replies already in one or more --out files with the current rules (no GPU, tokenizer or server) and prints a table.

Usage: python score_honesty.py --gguf FILE --label NAME --out FILE.json --tokenizer BASE_DIR --probes honesty_probes.jsonl
       --controls-file eval-probes.jsonl [--n-controls 300] [--max-new-tokens 192] [--server .../llama-server]
       [--port 8092] [--parallel 16]
       python score_honesty.py --replies-only --out A.json [B.json ...]
"""

import argparse
import json
import os
import random
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from honesty_grade import KINDS, TOPICS, VERDICTS, grade, refuses  # noqa: E402
from score_gguf import gpu_mem_used_mib, healthy, post, read_jsonl  # noqa: E402
from train_glimmer import FINAL_CHANNEL, GENERATION_PROMPT, MAX_NEW_TOKENS, REASONING, SYSTEM, answered, final_answer  # noqa: E402

PREFIX = {"after_cutoff": "ac-", "false_premise": "fp-", "unknowable": "uk-"}


def check_probes(probes):
    """Stops before the server starts if a probe doesn't follow the shared format."""
    seen = set()
    for p in probes:
        pid, kind = p.get("id"), p.get("kind")
        problem = None
        if not pid or pid in seen:
            problem = "id missing or repeated"
        elif kind not in KINDS or not pid.startswith(PREFIX[kind]):
            problem = f"kind {kind!r} doesn't fit the id"
        elif p.get("topic") not in TOPICS:
            problem = f"topic {p.get('topic')!r}"
        elif not str(p.get("question") or "").strip():
            problem = "no question"
        elif kind == "false_premise" and not str(p.get("premise") or "").strip():
            problem = "false_premise without a premise"
        elif (not isinstance(p.get("bait", []), list) or len(p.get("bait", [])) > 4
              or not all(isinstance(b, str) and b.strip() for b in p.get("bait", []))):
            problem = "bait must be a list of at most 4 strings"
        if problem:
            raise ValueError(f"honesty probe {pid}: {problem}")
        seen.add(pid)


def rates(rows):
    n = len(rows)
    count = {v: sum(r["verdict"] == v for r in rows) for v in VERDICTS}
    return {"n": n, **count, **{f"{v}_rate": round(count[v] / max(1, n), 4) for v in VERDICTS}}


def summarize(rows):
    h, c = rows["honesty"], rows["controls"]
    right = sum(x["right"] for x in c)
    refused = sum(x["refused"] and not x["right"] for x in c)
    return {
        **rates(h),
        "n_controls": len(c), "control_right": right, "control_accuracy": round(right / max(1, len(c)), 4),
        "control_refused": refused, "control_refusal_rate": round(refused / max(1, len(c)), 4),
        "by_kind": {k: rates([r for r in h if r["kind"] == k]) for k in KINDS if any(r["kind"] == k for r in h)},
        "by_topic": {t: rates([r for r in h if r["topic"] == t]) for t in TOPICS if any(r["topic"] == t for r in h)},
        "hit_token_limit": {"honesty": sum(r.get("stop") == "limit" for r in h), "controls": sum(r.get("stop") == "limit" for r in c)},
    }


def regrade(rows):
    """The stored replies graded again with the current rules; returns how many honesty verdicts changed."""
    changed = 0
    for r in rows["honesty"]:
        g = grade(r["reply"], r)
        changed += g["verdict"] != r.get("verdict")
        r.update(g)
    for r in rows["controls"]:
        r["right"] = answered(r["reply"], r)
        r["refused"] = refuses(r["reply"])
    return changed


def print_summaries(paths):
    def pct(x):
        return f"{100 * x:5.1f}"

    head = f"{'label':28s} {'n':>4s} {'honest':>6s} {'halluc':>6s} {'unclr':>6s} {'ctl_acc':>7s} {'ctl_ref':>7s} {'changed':>7s}"
    lines, kinds, topics = [head], [], []
    for path in paths:
        with open(path) as f:
            out = json.load(f)
        changed = regrade(out["rows"])
        s = summarize(out["rows"])
        label = out.get("label", os.path.basename(path))
        lines.append(f"{label[:28]:28s} {s['n']:4d} {pct(s['honest_rate']):>6s} {pct(s['hallucinated_rate']):>6s} "
                     f"{pct(s['unclear_rate']):>6s} {pct(s['control_accuracy']):>7s} {pct(s['control_refusal_rate']):>7s} {changed:7d}")
        for group, table in (("by_kind", kinds), ("by_topic", topics)):
            for name, r in s[group].items():
                table.append(f"{label[:28]:28s} {name:16s} {r['n']:4d} {pct(r['honest_rate']):>6s} "
                             f"{pct(r['hallucinated_rate']):>6s} {pct(r['unclear_rate']):>6s}")
    sub = f"{'label':28s} {'group':16s} {'n':>4s} {'honest':>6s} {'halluc':>6s} {'unclr':>6s}"
    print("\n".join(lines + ["", "By kind (percent)", sub] + kinds + ["", "By topic (percent)", sub] + topics))
    print("\nRates are percent of honesty probes; ctl_acc is control accuracy, ctl_ref the controls answered wrong with a "
          "refusal; changed counts verdicts the current rules grade differently from the stored ones.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gguf")
    ap.add_argument("--label")
    ap.add_argument("--out", required=True, nargs="+")
    ap.add_argument("--tokenizer")
    ap.add_argument("--probes", default=os.path.join(HERE, "honesty_probes.jsonl"))
    ap.add_argument("--controls-file")
    ap.add_argument("--n-controls", type=int, default=300)
    ap.add_argument("--max-new-tokens", type=int, default=192)
    ap.add_argument("--server", default="/home/ubuntu/writer/llama.cpp-b11970/build/bin/llama-server")
    ap.add_argument("--port", type=int, default=8092)
    ap.add_argument("--parallel", type=int, default=16)
    ap.add_argument("--slot-ctx", type=int, default=1024)
    ap.add_argument("--replies-only", action="store_true")
    a = ap.parse_args()
    if a.replies_only:
        print_summaries(a.out)
        return
    needed = ["gguf", "label", "tokenizer"] + (["controls_file"] if a.n_controls > 0 else [])
    missing = ["--" + n.replace("_", "-") for n in needed if not getattr(a, n)]
    if missing or len(a.out) != 1:
        ap.error(f"a scoring run needs {', '.join(missing) or 'exactly one --out'}")
    out_path = a.out[0]

    probes = read_jsonl(a.probes)
    check_probes(probes)
    controls = []
    if a.n_controls > 0:
        controls = read_jsonl(a.controls_file)
        random.Random(7).shuffle(controls)
        controls = controls[: a.n_controls]

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

    items = [("honesty", p, a.max_new_tokens) for p in probes] + [("control", c, MAX_NEW_TOKENS) for c in controls]
    prompts = [ids_for(it["question"]) for _, it, _ in items]
    longest = max(len(p) for p in prompts)
    if longest + max(a.max_new_tokens, MAX_NEW_TOKENS) > a.slot_ctx:
        raise RuntimeError(f"a prompt has {longest} tokens; raise --slot-ctx")

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    log_path = out_path + ".server.log"
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
        print(f"HONESTY {a.label} server up in {load_seconds}s, {len(probes)} probes + {len(controls)} controls, "
              f"longest {longest} tokens", flush=True)

        def ask(job):
            ids, n_predict = job
            # Greedy and no stop strings, as in score_gguf.py: generation ends at an end-of-generation token or the limit.
            return post(a.port, {"prompt": ids, "n_predict": n_predict, "temperature": 0.0, "top_k": 1,
                                 "return_tokens": True, "cache_prompt": False, "stream": False})

        t0 = time.time()
        with ThreadPoolExecutor(max_workers=a.parallel) as pool:
            results = list(pool.map(ask, [(p, n) for p, (_, _, n) in zip(prompts, items)]))
        wall = time.time() - t0
        mem = gpu_mem_used_mib()
    finally:
        server.terminate()
        try:
            server.wait(timeout=60)
        except subprocess.TimeoutExpired:
            server.kill()

    rows = {"honesty": [], "controls": []}
    generated = 0
    for (part, it, _), r in zip(items, results):
        toks = r.get("tokens") or []
        generated += len(toks)
        reply = final_answer(tok.decode(toks, skip_special_tokens=False)) if toks else final_answer(r.get("content", ""))
        ran = {"tokens": len(toks), "stop": r.get("stop_type")}
        if part == "honesty":
            rows["honesty"].append({k: it.get(k) for k in ("id", "kind", "topic", "question", "premise", "bait", "note")}
                                   | {"reply": reply, **grade(reply, it), **ran})
        else:
            rows["controls"].append({"question": it["question"], "answer": it["answer"], "aliases": it.get("aliases", []),
                                     "reply": reply, "right": answered(reply, it), "refused": refuses(reply), **ran})

    summary = summarize(rows)
    out = {
        "label": a.label, "gguf": a.gguf, "bytes": os.path.getsize(a.gguf), "gb": round(os.path.getsize(a.gguf) / 1e9, 2),
        "probes": os.path.abspath(a.probes), "controls_file": os.path.abspath(a.controls_file) if controls else None,
        "max_new_tokens": a.max_new_tokens, "control_max_new_tokens": MAX_NEW_TOKENS, "summary": summary,
        "aggregate_tokens_per_second": round(generated / max(wall, 1e-9), 1), "parallel": a.parallel,
        "generated_tokens": generated, "score_seconds": round(wall, 1), "server_load_seconds": load_seconds,
        "gpu_mem_used_mib": mem, "server_cmd": " ".join(cmd), "rows": rows,
    }
    with open(out_path + ".tmp", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(out_path + ".tmp", out_path)
    print("HONESTY " + json.dumps({"label": a.label, **{k: v for k, v in summary.items() if k not in ("by_topic",)}}), flush=True)


if __name__ == "__main__":
    main()
