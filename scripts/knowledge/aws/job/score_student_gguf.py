"""Score a Jetson student GGUF (student_gguf.sh) on the held-out probes and the old-fact checks with llama-server, the way
train_student.py scores the BF16 model, so the numbers line up with its metrics.json. Also the imatrix calibration text
and the comparison table.

score: the probes are shuffled with random.Random(7) and the first N kept, as train_student.py and score_gguf.py do.
  Each prompt is rendered by train_student.Chat (the student's chat_template.jinja, thinking off, the system line "You
  are a helpful assistant.", one BOS); its token ids, from the student's own tokenizer, go to llama-server's
  /completion, greedy, at most 96 new tokens. The generated ids are decoded by the same tokenizer, cut by
  train_student.final_answer() and graded by train_glimmer's answered(). post(), healthy() and gpu_mem_used_mib() are
  score_gguf.py's. Checks on the first 8 prompts, recorded rather than fatal, make sure the fleet's path sees what
  training saw: llama.cpp's tokenizer gives the same ids (/tokenize), and the server's --jinja rendering of the
  template embedded in the GGUF, with enable_thinking false and --reasoning off as the fleet serves, gives the same
  text and, tokenized as a chat prompt, the same ids (/apply-template). Speed as in score_gguf.py: the 8 prompts one
  at a time (decode and prompt tokens per second, from llama-server's timings), then the scored set with --parallel
  requests in flight (aggregate generated tokens per second). These are one GPU's speeds (student_gguf.sh pins it), not a
  board's.
calib: calibration text for llama-imatrix from the student's training set (never the probes or the old facts), each
  example rendered as train_student.py renders training texts, without the BOS text (llama-imatrix starts every chunk
  with BOS), and joined; run llama-imatrix with --parse-special.
table: one row per scored file under DIR/scores, beside the BF16 base and tuned numbers from the run's metrics.json.

  python score_student_gguf.py score --gguf FILE --label NAME --out FILE.json --tokenizer MODEL_DIR --probes P
         --forget F [--train T] [--fixed-probes E] [--n-probes 2500] [--server .../llama-server] [--port 8092]
  python score_student_gguf.py calib --train T --tokenizer MODEL_DIR --probes P --forget F --out calib.txt [--tokens N]
  python score_student_gguf.py table --dir SCORES_DIR [--metrics RUN/out/metrics.json] [--base-dir BASE_SCORES_DIR]
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
from score_gguf import gpu_mem_used_mib, healthy, post, read_jsonl  # noqa: E402  (the llama-server helpers)
from train_glimmer import MAX_NEW_TOKENS, SYSTEM, answered, normalize  # noqa: E402  (same grading as every run)
from train_student import PROFILE_NAME, Chat, final_answer, fixed_questions, load_template, probe_split  # noqa: E402


def call(port, path, body, timeout=60):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def student_chat(folder):
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(folder)
    return Chat(tok, load_template(folder, tok))


def score(a):
    chat = student_chat(a.tokenizer)
    tok = chat.tok
    probes = read_jsonl(a.probes)
    random.Random(7).shuffle(probes)
    if a.n_probes:
        probes = probes[: a.n_probes]
    forget = read_jsonl(a.forget)
    fixed, fixed_from = fixed_questions(a.fixed_probes, a.probes)
    covered = set()
    if a.train:
        with open(a.train) as f:
            covered = {json.loads(line).get("source") for line in f if line.strip()}

    items = [("probe", p) for p in probes] + [("forget", f) for f in forget]
    texts = [chat.prompt(it["question"]) for _, it in items]
    prompts = [tok(t)["input_ids"] for t in texts]
    longest = max(len(p) for p in prompts)
    if longest + MAX_NEW_TOKENS > a.slot_ctx:
        raise RuntimeError(f"a prompt has {longest} tokens; raise --slot-ctx")

    log_path = a.server_log or a.out + ".server.log"
    cmd = [a.server, "-m", a.gguf, "--port", str(a.port), "--host", "127.0.0.1", "-ngl", "999", "-fa", "on",
           "-np", str(a.parallel), "-c", str(a.parallel * a.slot_ctx), "--no-webui", "--metrics", "--jinja", "--reasoning", "off"]
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

        bos_text = tok.bos_token or ""

        def unbos(s):
            return s.removeprefix(bos_text) if bos_text else s

        def llama_ids(s, add_special=True):
            return call(a.port, "/tokenize", {"content": s, "add_special": add_special, "parse_special": True}).get("tokens")

        # The fleet's path. llama.cpp's own tokenizer: the text without its BOS, which llama.cpp adds (the converter
        # sets add_bos_token), must give our ids. The template the GGUF carries, rendered by the server (--jinja,
        # enable_thinking false): the same text apart from BOS, and, tokenized the way the server tokenizes a chat
        # prompt, the same ids (a second BOS would show here).
        tokenizer_check = {"checked": 0, "same_ids": 0}
        template_check = {"checked": 0, "same_text": 0, "same_ids": 0}
        for (_, it), text, ids in list(zip(items, texts, prompts))[:8]:
            tokenizer_check["checked"] += 1
            tokenizer_check["same_ids"] += llama_ids(unbos(text)) == ids
            try:
                body = {"messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": it["question"]}],
                        "chat_template_kwargs": {"enable_thinking": False}}
                rendered = call(a.port, "/apply-template", body).get("prompt", "")
                template_check["checked"] += 1
                template_check["same_text"] += unbos(rendered) == unbos(text)
                template_check["same_ids"] += llama_ids(rendered) == ids
                template_check.setdefault("first_server_text", rendered[:200])
            except Exception as err:  # a server without /apply-template: recorded, not fatal
                template_check["error"] = f"{type(err).__name__}: {err}"[:200]
        print("SCORE checks " + json.dumps({"tokenizer": tokenizer_check, "template": template_check}), flush=True)

        def ask(ids):
            # Greedy: temperature 0 makes llama-server pick the top token. No stop strings: generation ends at an
            # end-of-generation token or after 96 tokens, as model.generate does, and final_answer() cuts the rest.
            return post(a.port, {"prompt": ids, "n_predict": MAX_NEW_TOKENS, "temperature": 0.0, "top_k": 1,
                                 "return_tokens": True, "cache_prompt": False, "stream": False})

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
        row = {"question": it["question"], "answer": it["answer"], "reply": reply, "right": answered(reply, it),
               "tokens": len(toks), "stop": r.get("stop_type")}
        if kind == "probe":
            row.update(passageId=it.get("passageId"), set="fixed" if it["question"] in fixed else "new",
                       covered=it.get("passageId") in covered)
        rows[kind].append(row)

    def acc(rs):
        return round(sum(x["right"] for x in rs) / max(1, len(rs)), 4)

    out = {
        "label": a.label, "gguf": a.gguf, "bytes": os.path.getsize(a.gguf), "gb": round(os.path.getsize(a.gguf) / 1e9, 2),
        "student": PROFILE_NAME, "n_probes": len(rows["probe"]), "n_forget": len(rows["forget"]),
        "probe_accuracy": acc(rows["probe"]), "forget_accuracy": acc(rows["forget"]),
        "probe_right": sum(x["right"] for x in rows["probe"]), "forget_right": sum(x["right"] for x in rows["forget"]),
        # Without --train every probe counts as not_covered; covered_known says which.
        "probe_split": probe_split({"gguf": rows["probe"]}, covered, fixed), "fixed_from": fixed_from, "covered_known": bool(a.train),
        "tokenizer_check": tokenizer_check, "template_check": template_check,
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
    print("SCORE " + json.dumps({k: v for k, v in out.items() if k not in ("rows", "server_cmd", "probe_split")}), flush=True)


# Calibration mix by tokens, as make_calibration.py mixes Glimmer's: facts, overviews (Wikipedia passages) and replay.
GROUPS = {"facts": ("source",), "overviews": ("article", "event"), "replay": ("replay",)}
SHARES = {"facts": 0.40, "overviews": 0.35, "replay": 0.25}


def calib(a):
    chat = student_chat(a.tokenizer)
    held_out = set()
    for path in (a.probes, a.forget):
        held_out |= {normalize(p["question"]).strip() for p in read_jsonl(path)}
    pools = {g: [] for g in GROUPS}
    with open(a.train) as f:
        for line in f:
            if line.strip():
                row = json.loads(line)
                prefix = row.get("source", "").split(":", 1)[0]
                for g, prefixes in GROUPS.items():
                    if prefix in prefixes:
                        pools[g].append(row)
    rng = random.Random(a.seed)
    chosen, stats, dropped = [], {}, 0
    for g, rows in pools.items():
        rng.shuffle(rows)
        quota, used, n = int(a.tokens * SHARES[g]), 0, 0
        for row in rows:
            if used >= quota:
                break
            if any(normalize(m["content"]).strip() in held_out for m in row["messages"] if m["role"] == "user"):
                dropped += 1
                continue
            # Without the BOS text: llama-imatrix puts a BOS at the start of every chunk, and one mid-chunk is wrong.
            text = chat.training_text(row["messages"])
            text = text.removeprefix(chat.tok.bos_token) if chat.tok.bos_token else text
            chosen.append(text)
            used += len(chat.ids(text))
            n += 1
        stats[g] = {"examples": n, "tokens": used, "pool": len(rows)}
    rng.shuffle(chosen)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as f:
        f.write("\n".join(chosen))
    report = {"out": a.out, "train": a.train, "seed": a.seed, "target_tokens": a.tokens, "examples": len(chosen), "groups": stats,
              "dropped_for_holding_an_eval_question": dropped, "held_out_questions_checked": len(held_out), "student": PROFILE_NAME}
    if a.report:
        with open(a.report, "w") as f:
            json.dump(report, f, indent=1)
    print("CALIB " + json.dumps(report), flush=True)


def table(a):
    def scores(d):
        out = {}
        folder = os.path.join(d, "scores") if d else ""
        for name in sorted(os.listdir(folder)) if folder and os.path.isdir(folder) else []:
            if name.endswith(".json"):
                with open(os.path.join(folder, name)) as f:
                    out[name[:-5]] = json.load(f)
        return out

    metrics = {}
    if a.metrics and os.path.exists(a.metrics):
        with open(a.metrics) as f:
            metrics = json.load(f)
    rows = []
    if metrics.get("tuned_probe_accuracy") is not None:
        ps = metrics.get("probe_split") or {}
        for who in ("base", "tuned"):
            rows.append({"file": f"BF16 {who} (train_student.py)", "gb": None, "probes": metrics[f"{who}_probe_accuracy"],
                         "fixed": (ps.get("fixed") or {}).get(f"{who}_accuracy"), "new": (ps.get("new") or {}).get(f"{who}_accuracy"),
                         "covered": (ps.get("covered") or {}).get(f"{who}_accuracy"),
                         "old_facts": f"{round(metrics[f'{who}_forget_accuracy'] * metrics['forget_items'])}/{metrics['forget_items']}",
                         "tok_s_single": None, "tok_s_parallel": None})
    for prefix, d in (("base ", a.base_dir), ("", a.dir)):
        for t, s in scores(d).items():
            ps = s.get("probe_split") or {}
            rows.append({"file": prefix + t, "gb": s["gb"], "probes": s["probe_accuracy"],
                         "fixed": (ps.get("fixed") or {}).get("gguf_accuracy"), "new": (ps.get("new") or {}).get("gguf_accuracy"),
                         "covered": (ps.get("covered") or {}).get("gguf_accuracy"), "old_facts": f"{s['forget_right']}/{s['n_forget']}",
                         "tok_s_single": s["decode_tokens_per_second_single"], "tok_s_parallel": s["aggregate_tokens_per_second"],
                         "tokenizer_same": f"{s['tokenizer_check'].get('same_ids', 0)}/{s['tokenizer_check']['checked']}",
                         "template_same": f"{s['template_check'].get('same_text', 0)}/{s['template_check'].get('checked', 0)} text, "
                                          f"{s['template_check'].get('same_ids', 0)} ids"})

    def pct(x):
        return f"{x:.1%}" if isinstance(x, float) else ""

    lines = ["| File | GB | Probes | Fixed | New | Covered | Old facts | tok/s, 1 stream | tok/s, parallel | llama.cpp ids; server template |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['file']} | {r['gb'] if r['gb'] is not None else ''} | {pct(r['probes'])} | {pct(r['fixed'])} | {pct(r['new'])} | "
                     f"{pct(r['covered'])} | {r['old_facts']} | {r['tok_s_single'] or ''} | {r['tok_s_parallel'] or ''} | "
                     f"{(r.get('tokenizer_same', '') + '; ' + r.get('template_same', '')) if 'tokenizer_same' in r else ''} |")
    text = "\n".join(lines) + "\n"
    with open(os.path.join(a.dir, "table.md"), "w") as f:
        f.write(text)
    with open(os.path.join(a.dir, "table.json"), "w") as f:
        json.dump(rows, f, indent=1)
    print(text, end="")


def main():
    ap = argparse.ArgumentParser(description="Score, calibrate or tabulate the Jetson student's GGUFs; see the module docstring.")
    ap.add_argument("command", choices=["score", "calib", "table"])
    ap.add_argument("--gguf")
    ap.add_argument("--label")
    ap.add_argument("--out")
    ap.add_argument("--tokenizer", help="the student's folder: tokenizer files and chat_template.jinja")
    ap.add_argument("--probes")
    ap.add_argument("--forget")
    ap.add_argument("--train", help="score: the training set, for the covered split; calib: the text source")
    ap.add_argument("--fixed-probes", default="", help="the fixed 1,500 (eval-probes.jsonl), for the probe split")
    ap.add_argument("--n-probes", type=int, default=2500)
    ap.add_argument("--server", default="/home/ubuntu/k/llama.cpp-b11970/build/bin/llama-server")
    ap.add_argument("--server-log", default="")
    ap.add_argument("--port", type=int, default=8092)
    ap.add_argument("--parallel", type=int, default=16)
    ap.add_argument("--slot-ctx", type=int, default=1024)
    ap.add_argument("--tokens", type=int, default=400000)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--report", default="")
    ap.add_argument("--dir")
    ap.add_argument("--metrics", default="")
    ap.add_argument("--base-dir", default="")
    a = ap.parse_args()
    need = {"score": ("gguf", "label", "out", "tokenizer", "probes", "forget"), "calib": ("train", "tokenizer", "probes", "forget", "out"),
            "table": ("dir",)}[a.command]
    missing = [n for n in need if not getattr(a, n)]
    if missing:
        raise SystemExit(f"{a.command} needs --{', --'.join(m.replace('_', '-') for m in missing)}")
    {"score": score, "calib": calib, "table": table}[a.command](a)


if __name__ == "__main__":
    main()
    # Written and renamed into place above. Leave without interpreter teardown, as score_gguf.py does: a finished run
    # once exited non-zero with no traceback, which the pipeline read as a failed step.
    sys.stdout.flush()
    os._exit(0)
