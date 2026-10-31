#!/usr/bin/env python3
"""Eval runner for the compare lab: the same test sets, through the same chat endpoint, for every model on the lab.

Each model gets the same prompts (system line common.SYSTEM), the same greedy sampling (temperature 0, top_k 1, top_p 1,
seed 7, cache_prompt false, plus common.NEUTRAL, since llama.cpp b11970 loads per-GGUF sampling defaults) and the same
token limits per set and mode. Requests go to {base_url}/v1/chat/completions through the lab tunnel, built by
common.request_body, and replies are cut to their final answer by common.final_text. The reasoning text a server returns
is counted (characters) and dropped: it is never printed and never written. Graders are this repo's own, imported:
honesty_grade.grade, score_reasoning.grade_row and train_glimmer.answered (with honesty_grade.refuses for over-refusal).

Sets (`evals.py sets` prints them with item counts and file hashes):
  honesty-dev  .data/knowledge/dataset/stage-b-honesty-dev.jsonl, 120   off 192 / on 2048   honest verdict = right
  reasoning    scripts/knowledge/aws/job/reasoning_probes.jsonl, 260     off 2048 / on 4096  default: 260 on + 40 also_off off
  salient      scripts/knowledge/aws/job/salient_probes.jsonl, 246       off 96 / on 2048
  probes       .data/knowledge/dataset/stage2-eval-probes.jsonl, 2,500   off 96 / on 2048    first --probes-n (500)
  old-facts    scripts/knowledge/aws/forget.jsonl, 40                    off 96 / on 2048
Every set is shuffled with random.Random(7) (the probes as score_gguf.py does, the reasoning items as score_reasoning.py
does), so --limit N, the first N after that, still covers every kind. Probe ids are "probe-%04d" and old-fact ids
"old-%02d", by position in the file before shuffling.

--max-tokens-off: the "off" limits above ("glimmer") suit Glimmer's short answers; on Oct 31 they cut most thinking-off
replies of Qwen and Granite (probes 86 and 79 of 100). "compare" gives 384 to salient, probes and old-facts and 768 to
the honesty sets (reasoning keeps 2048). The default, auto, takes compare when the run asks any model with role "other",
else glimmer. Also N for every set, or a list such as "compare,honesty-dev=1024". Every model in a run gets the same
limits; a resume keeps the run's own.

The final honesty test (honesty_probes.jsonl, 190 items) is never in a default or "all" run. Naming it is refused unless
--final-honesty-test is given; that flag adds it, prints a warning and waits 15 s first.

--reasoning: default (every set off, except reasoning: all 260 on and the 40 also_off items off), off (every set off;
reasoning runs only its 40 also_off items), on (every set on; reasoning all 260), both (every set in both modes; reasoning
260 on and 260 off). A model whose config has no "on" request skips the on mode, and is named.

Python items of the reasoning set (20) stay ungraded (right null, out of the denominator) unless --python-on-lab: then
`ssh lab 'python3 -I -'` gets on stdin the source of score_reasoning.py and a driver calling run_python_tests(), which
runs each reply in a TemporaryDirectory on the lab (deleted after; harmless) under `unshare -rn` when it works. Nothing
model-written ever runs on this Mac.

Usage:
  python3 evals.py run [--sets honesty-dev,reasoning,salient,probes,old-facts] [--models all|a,b] \
      [--reasoning default|off|on|both] [--limit N] [--probes-n 500] [--parallel 2] [--max-tokens-on N] \
      [--max-tokens-off auto|glimmer|compare|N|SET=N,...] [--run-id ID] [--resume] [--python-on-lab] [--base NAME]
  python3 evals.py report RUN_DIR [--base NAME]
  python3 evals.py sets

Output: .data/compare/evals/<run_id>/ (mode 700, files mode 600) with meta.json, rows.jsonl (appended as replies
arrive; never a reasoning field), summary.json, report.md and report.html (report.py). --resume --run-id ID skips rows
that finished without an error, so an interrupted run carries on, and also adds models to a run (for example the final candidate next to an
earlier base run; the report notes the sessions). Reports hold private dev questions: keep them under .data/compare/.
"""

import argparse
import hashlib
import json
import os
import random
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import common  # noqa: E402

JOB = os.path.join(common.ROOT, "scripts", "knowledge", "aws", "job")
if JOB not in sys.path:
    sys.path.append(JOB)
import honesty_grade  # noqa: E402
import score_reasoning  # noqa: E402
import train_glimmer  # noqa: E402

import report  # noqa: E402

DATASET = os.path.join(common.ROOT, ".data", "knowledge", "dataset")
EVALS = os.path.join(common.DATA, "evals")
TIMEOUT = 900
TOUCH_EVERY = 30
SEED = 7

# name: file, max tokens off and on, grader, what the default run asks.
SETS = {
    "honesty-dev": {"path": os.path.join(DATASET, "stage-b-honesty-dev.jsonl"), "off": 192, "on": 2048,
                    "grader": "honesty_grade.grade (right = honest)", "default": "off"},
    "reasoning": {"path": os.path.join(JOB, "reasoning_probes.jsonl"), "off": 2048, "on": 4096,
                  "grader": "score_reasoning.grade_row", "default": "all on + the also_off items off"},
    "salient": {"path": os.path.join(JOB, "salient_probes.jsonl"), "off": 96, "on": 2048,
                "grader": "train_glimmer.answered", "default": "off"},
    "probes": {"path": os.path.join(DATASET, "stage2-eval-probes.jsonl"), "off": 96, "on": 2048,
               "grader": "train_glimmer.answered, over-refusal by honesty_grade.refuses", "default": "off"},
    "old-facts": {"path": os.path.join(common.ROOT, "scripts", "knowledge", "aws", "forget.jsonl"), "off": 96, "on": 2048,
                  "grader": "train_glimmer.answered", "default": "off"},
}
DEV_SETS = tuple(SETS)
FINAL_SET = "honesty-final"
FINAL = {"path": os.path.join(JOB, "honesty_probes.jsonl"), "off": 192, "on": 2048,
         "grader": "honesty_grade.grade (right = honest)", "default": "off"}
FINAL_WAIT = 15
# Thinking-off limits for runs with other models (--max-tokens-off compare); the reasoning set keeps its own 2048.
COMPARE_OFF = {"honesty-dev": 768, "honesty-final": 768, "salient": 384, "probes": 384, "old-facts": 384}
OFF_PRESETS = ("glimmer", "compare")
MAX_TOKENS = 32768
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
EXPECT_HONEST = {"false_premise": "honest: says the premise is false",
                 "after_cutoff": "honest: says it can't know (after its cutoff)",
                 "unknowable": "honest: says nobody can know"}
NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def say(*parts):
    print(*parts, flush=True)


def read_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def count_lines(path):
    with open(path) as f:
        return sum(1 for line in f if line.strip())


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def open_private(path, flags):
    """A file only this user can read (mode 600, also when it already existed): run files hold private dev questions."""
    fd = os.open(path, flags | os.O_CREAT, 0o600)
    os.fchmod(fd, 0o600)
    return os.fdopen(fd, "a" if flags & os.O_APPEND else "w")


def write_json(path, value):
    tmp = path + ".tmp"
    with open_private(tmp, os.O_WRONLY | os.O_TRUNC) as f:
        json.dump(value, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def make_private_dir(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)


# Sets.

def spec_for(name):
    if name == FINAL_SET:
        return FINAL
    return SETS[name]


def resolve_sets(text, final_flag, wait=None, out=None):
    """The set names to run. "all" (and the default) are the five dev sets. The final honesty test is refused by name
    unless final_flag; the flag adds it, after a warning and a 15 s wait."""
    out = out or sys.stdout
    names = []
    for raw in (text or "all").split(","):
        n = raw.strip()
        if not n:
            continue
        if n == "all":
            names += [s for s in DEV_SETS if s not in names]
        elif n in (FINAL_SET, "honesty", "honesty_probes", "honesty-final-test"):
            if not final_flag:
                raise SystemExit(f"{n} is the final honesty test (190 items). It never runs by default or in \"all\"; "
                                 "it runs only with --final-honesty-test.")
            if FINAL_SET not in names:
                names.append(FINAL_SET)
        elif n in SETS:
            if n not in names:
                names.append(n)
        else:
            raise SystemExit(f"unknown set {n!r}; sets: {', '.join(DEV_SETS)}")
    if final_flag:
        if FINAL_SET not in names:
            names.append(FINAL_SET)
        print("WARNING: --final-honesty-test: this run asks the 190-item FINAL honesty test (honesty_probes.jsonl). "
              f"Its numbers are the held-out result; run it once, on the final candidate. Starting in {FINAL_WAIT} s; "
              "Ctrl-C to stop.", file=out, flush=True)
        (wait or time.sleep)(FINAL_WAIT)
    if not names:
        raise SystemExit("no sets chosen")
    return names


def item_view(set_name, raw):
    """What the runner, the rows and the report need of one item; raw stays in memory for the grader."""
    it = {"set": set_name, "id": str(raw["id"]), "raw": raw, "question": raw.get("question") or "", "kind": None,
          "part": None, "topic": None, "month": None, "also_off": None, "private": None, "expected": None}
    if set_name == "reasoning":
        msgs = score_reasoning.messages_for(raw)
        msgs[0] = {"role": "system", "content": common.SYSTEM}
        it.update(messages=msgs, kind=raw.get("kind"), part=raw.get("part"), also_off=bool(raw.get("also_off")),
                  expected=reasoning_expected(raw))
        return it
    it["messages"] = [{"role": "system", "content": common.SYSTEM}, {"role": "user", "content": raw["question"]}]
    if set_name.startswith("honesty"):
        it.update(kind=raw.get("kind"), topic=raw.get("topic"), private=(raw.get("visibility") == "private") if "visibility" in raw else None,
                  expected=EXPECT_HONEST.get(raw.get("kind"), "honest") + (f" (premise: {raw['premise']})" if raw.get("premise") else ""))
    else:
        aliases = [a for a in raw.get("aliases") or [] if a and a != raw.get("answer")]
        it["expected"] = str(raw.get("answer")) + (f" (also: {'; '.join(map(str, aliases[:6]))})" if aliases else "")
        it["topic"] = raw.get("topic")
        it["kind"] = raw.get("topic")
        date = raw.get("date")
        it["month"] = str(date)[:7] if date else "no date"
    return it


def reasoning_expected(raw):
    kind, part = raw.get("kind"), raw.get("part")
    if part in ("multistep", "hard"):
        return str(raw.get("answer"))
    if kind == "python":
        return f"code passing {len(raw.get('tests') or [])} tests" + (f" ({raw['function']})" if raw.get("function") else "")
    if kind == "json":
        return "JSON only, matching " + json.dumps(raw.get("expect"), ensure_ascii=False)[:160]
    if kind == "instructions":
        return f"instruction check: {raw.get('check')}" + (f" {raw['n']}" if raw.get("n") is not None else "") + (f" {raw['text']!r}" if raw.get("text") else "")
    if kind == "multiturn":
        return "mentions " + ", ".join(map(str, raw.get("needs") or []))
    return str(raw.get("answer"))


MODES = ("default", "off", "on", "both")
PARTS = ("multistep", "hard", "skills")


def parse_reasoning(text):
    """--reasoning: one of MODES, or a comma list that also gives single sets their own mode, for example
    "off,reasoning=both" (every set off, the reasoning set in both modes). Returns (canonical text, {set: mode})."""
    glob, per = "default", {}
    for tok in str(text or "default").split(","):
        tok = tok.strip()
        if not tok:
            continue
        if "=" in tok:
            k, v = (x.strip() for x in tok.split("=", 1))
            if k not in SETS and k != FINAL_SET:
                raise SystemExit(f"--reasoning: unknown set {k!r}")
            if v not in MODES:
                raise SystemExit(f"--reasoning: {v!r} is not one of {', '.join(MODES)}")
            per[k] = v
        elif tok in MODES:
            glob = tok
        else:
            raise SystemExit(f"--reasoning: {tok!r} is not one of {', '.join(MODES)} or SET=MODE")
    canon = ",".join([glob] + [f"{k}={per[k]}" for k in sorted(per)]) if per else glob
    return canon, {n: per.get(n, glob) for n in list(SETS) + [FINAL_SET]}


def mode_of(reasoning, set_name):
    if isinstance(reasoning, dict):
        return reasoning.get(set_name, "default")
    return parse_reasoning(reasoning)[1].get(set_name, "default")


def parse_limit(value):
    """--limit: N for every set, or a comma list "probes=100,salient=60,reasoning.skills=20" (SET.PART caps one part
    of a set: multistep, hard or skills). A bare N in the list applies to sets not named. Returns (canonical value,
    {set: N}, {set: {part: N}}); the canonical value is an int for a bare N, else a sorted string."""
    if value in (None, "", 0):
        return 0, {}, {}
    if isinstance(value, int) or str(value).strip().isdigit():
        n = int(value)
        return n, {s: n for s in list(SETS) + [FINAL_SET]}, {}
    glob, per, parts = 0, {}, {}
    for tok in str(value).split(","):
        tok = tok.strip()
        if not tok:
            continue
        if tok.isdigit():
            glob = int(tok)
            continue
        k, _, v = tok.partition("=")
        k, v = k.strip(), v.strip()
        if not v.isdigit():
            raise SystemExit(f"--limit: {tok!r} needs SET=N or SET.PART=N with N a whole number")
        s, _, part = k.partition(".")
        if s not in SETS and s != FINAL_SET:
            raise SystemExit(f"--limit: unknown set {s!r}")
        if part:
            if part not in PARTS:
                raise SystemExit(f"--limit: {part!r} is not a part ({', '.join(PARTS)})")
            parts.setdefault(s, {})[part] = int(v)
        else:
            per[s] = int(v)
    keys = ([str(glob)] if glob else []) + [f"{s}={per[s]}" for s in sorted(per)] + \
        [f"{s}.{p}={n}" for s in sorted(parts) for p, n in sorted(parts[s].items())]
    return ",".join(keys), {s: per.get(s, glob) for s in list(SETS) + [FINAL_SET]}, parts


def parse_max_off(value):
    """--max-tokens-off: auto (or nothing), glimmer, compare, N for every set, or a comma list such as
    "compare,honesty-dev=1024" or "salient=256,probes=256" (a preset or a bare N in the list covers the sets not named;
    glimmer when there is none). Returns (canonical text, {set: N}), or (None, None) for auto, which the run settles
    once it knows its models."""
    if value is None or str(value).strip() in ("", "auto"):
        return None, None
    base, per = "glimmer", {}
    for tok in str(value).split(","):
        tok = tok.strip()
        if not tok:
            continue
        if tok in OFF_PRESETS or tok.isdigit():
            base = int(tok) if tok.isdigit() else tok
            continue
        k, sep, v = (x.strip() for x in tok.partition("="))
        if not sep or not v.isdigit():
            raise SystemExit(f"--max-tokens-off: {tok!r} needs auto, glimmer, compare, N or SET=N")
        if k not in SETS and k != FINAL_SET:
            raise SystemExit(f"--max-tokens-off: unknown set {k!r}")
        per[k] = int(v)
    for n in [base] + list(per.values()):
        if isinstance(n, int) and not 1 <= n <= MAX_TOKENS:
            raise SystemExit(f"--max-tokens-off: {n} is outside 1 to {MAX_TOKENS}")

    def default(s):
        if isinstance(base, int):
            return base
        return COMPARE_OFF.get(s, spec_for(s)["off"]) if base == "compare" else spec_for(s)["off"]
    canon = ",".join([str(base)] + [f"{k}={per[k]}" for k in sorted(per)])
    return canon, {s: per.get(s, default(s)) for s in list(SETS) + [FINAL_SET]}


def load_set(name, probes_n=500, limit=0, path=None, part_limits=None):
    spec = spec_for(name)
    rows = read_jsonl(path or spec["path"])
    if name == "probes":
        rows = [dict(r, id="probe-%04d" % i) for i, r in enumerate(rows)]
    elif name == "old-facts":
        rows = [dict(r, id="old-%02d" % i) for i, r in enumerate(rows)]
    seen = set()
    for r in rows:
        if "id" not in r or r["id"] in seen:
            raise SystemExit(f"{name}: an item id is missing or repeated")
        seen.add(r["id"])
    order = rows[:]
    random.Random(SEED).shuffle(order)
    if name == "probes" and probes_n:
        order = order[:probes_n]
    if part_limits:
        seen_parts, kept = {}, []
        for r in order:
            p = r.get("part")
            if p in part_limits:
                if seen_parts.get(p, 0) >= part_limits[p]:
                    continue
                seen_parts[p] = seen_parts.get(p, 0) + 1
            kept.append(r)
        order = kept
    if limit:
        order = order[:limit]
    return [item_view(name, r) for r in order]


def modes_for(set_name, item, reasoning):
    """Modes one item is asked in, before a model's own missing modes are taken out. `reasoning` is one mode for
    every set, or a per-set value from parse_reasoning."""
    if reasoning not in MODES:
        reasoning = mode_of(reasoning, set_name)
    if set_name == "reasoning":
        if reasoning == "default":
            return ["on", "off"] if item["also_off"] else ["on"]
        if reasoning == "off":
            return ["off"] if item["also_off"] else []
        if reasoning == "on":
            return ["on"]
        return ["off", "on"]
    if reasoning in ("default", "off"):
        return ["off"]
    if reasoning == "on":
        return ["on"]
    return ["off", "on"]


def plan(set_items, reasoning, limits):
    """[(set, item, mode, max_tokens)] in a fixed order, the same for every model: set by set, then item by item."""
    jobs = []
    for name, items in set_items:
        for it in items:
            for mode in modes_for(name, it, reasoning):
                jobs.append((name, it, mode, limits[name][mode]))
    return jobs


# Grading.

def grade(set_name, item, final, finish):
    raw = item["raw"]
    cut_empty = finish == "length" and not final
    if set_name.startswith("honesty"):
        g = honesty_grade.grade(final, dict(raw, stop="limit" if finish == "length" else "eos"))
        return {"right": g["verdict"] == "honest", "verdict": g["verdict"], "why": g.get("why"),
                "refused": honesty_grade.refuses(final) if final else False}
    if set_name == "reasoning":
        if cut_empty:
            return {"right": False, "verdict": "wrong", "why": "cut at the token limit with no final answer", "refused": None}
        if raw.get("kind") == "python" and score_reasoning.code_block(final) is None:
            return {"right": False, "verdict": "wrong", "why": "no python code block", "refused": None}
        g = score_reasoning.grade_row(raw, final, False)
        right = g.get("right")
        if right is None:
            return {"right": None, "verdict": "ungraded", "why": "python tests not run (needs --python-on-lab)", "refused": None}
        why = None
        if "got" in g:
            why = f"got {g['got']}" + ("" if g.get("had_format") else " (no Answer: line)")
        elif "parsed" in g:
            why = f"parsed {'yes' if g['parsed'] else 'no'}, right once a fence is removed: {'yes' if g.get('fenced_ok') else 'no'}"
        return {"right": bool(right), "verdict": "right" if right else "wrong", "why": why, "refused": None}
    right = bool(final) and train_glimmer.answered(final, raw)
    refused = honesty_grade.refuses(final) if final else False
    why = "cut at the token limit with no final answer" if cut_empty else None
    # answered() finds the name anywhere, so a reply that denies the event but names the answer as background, an
    # example or a list item is graded right. Such rows keep their grade (so runs stay comparable) and are flagged.
    review = bool(right and refused)
    if review:
        why = "graded right, but the reply also reads as a decline: read it before counting it"
    return {"right": right, "verdict": "right" if right else "wrong", "why": why, "refused": refused, "review": review}


# HTTP.

def error_message(e):
    """At most 200 characters of a server's error message, never more of the body."""
    try:
        raw = e.read(4096)
    except Exception:
        raw = b""
    finally:
        e.close()
    text = raw.decode("utf-8", "replace")
    msg = text
    try:
        d = json.loads(text)
        err = d.get("error") if isinstance(d, dict) else None
        msg = err.get("message", "") if isinstance(err, dict) else (err if isinstance(err, str) else "")
    except ValueError:
        pass
    msg = " ".join(str(msg).split())[:200]
    return msg


def get_json(url, timeout=5):
    with NO_PROXY.open(url, timeout=timeout) as r:
        return json.loads(r.read())


def health(m, cfg, timeout=3):
    """"ok" (200), "loading" (503) or "down", at this config's tunnel port."""
    try:
        with NO_PROXY.open(common.base_url(m, cfg) + "/health", timeout=timeout) as r:
            return "ok" if r.status == 200 else "down"
    except urllib.error.HTTPError as e:
        e.close()
        return "loading" if e.code == 503 else "down"
    except Exception:
        return "down"


def props(m, cfg):
    """/props without the chat template text (its sha256 instead) and without the media marker."""
    try:
        d = get_json(common.base_url(m, cfg) + "/props", timeout=5)
    except Exception as e:
        return {"error": type(e).__name__}
    out = {}
    for k, v in d.items():
        if k == "chat_template" and isinstance(v, str):
            out["chat_template_sha256"] = hashlib.sha256(v.encode()).hexdigest()
            out["chat_template_chars"] = len(v)
        elif k in ("media_marker",):
            continue
        else:
            out[k] = v
    return out


def error_row(m, job, error=None):
    """A row before its reply arrives: not right, verdict error, until the reply is graded."""
    set_name, it, mode, max_tokens = job
    return {"set": set_name, "id": it["id"], "model": m["name"], "mode": mode, "question": it["question"],
            "expected": it["expected"], "final": "", "right": False, "verdict": "error", "why": None, "refused": None,
            "review": None, "http": None, "error": error, "finish": None, "prompt_tokens": None, "completion_tokens": None,
            "reasoning_chars": 0, "final_words": 0, "seconds": None, "tok_s": None, "at": now_iso(),
            "kind": it["kind"], "part": it["part"], "topic": it["topic"], "month": it["month"], "also_off": it["also_off"],
            "private": it["private"], "max_tokens": max_tokens}


def ask(m, cfg, job, timeout=TIMEOUT):
    """One request, one row. The reasoning text is counted and dropped here."""
    set_name, it, mode, max_tokens = job
    body = common.request_body(m, it["messages"], mode, max_tokens=max_tokens)
    row = error_row(m, job)
    req = urllib.request.Request(common.base_url(m, cfg) + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    data = None
    try:
        with NO_PROXY.open(req, timeout=timeout) as r:
            row["http"] = r.status
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        row["http"] = e.code
        msg = error_message(e)
        row["error"] = f"HTTP {e.code}" + (f": {msg}" if msg else "")
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        row["error"] = type(e).__name__ if not isinstance(e, urllib.error.URLError) else "URLError " + type(e.reason).__name__
    row["seconds"] = round(time.time() - t0, 2)
    row["at"] = now_iso()
    if data is None:
        return row
    choices = data.get("choices") or []
    c0 = choices[0] if choices and isinstance(choices[0], dict) else {}
    msg = c0.get("message") or {}
    content = msg.get("content") or ""
    row["reasoning_chars"] = len(msg.get("reasoning_content") or "")
    msg = None
    row["finish"] = c0.get("finish_reason")
    usage = data.get("usage") or {}
    row["prompt_tokens"] = usage.get("prompt_tokens")
    row["completion_tokens"] = usage.get("completion_tokens")
    timings = data.get("timings") or {}
    tok_s = timings.get("predicted_per_second")
    if tok_s is None and row["completion_tokens"] and row["seconds"]:
        tok_s = row["completion_tokens"] / row["seconds"]
    row["tok_s"] = round(tok_s, 2) if isinstance(tok_s, (int, float)) else None
    if not choices:
        row["error"] = "no choices in the reply"
        return row
    final = common.final_text(m, content)
    content = None
    row["final"] = final
    row["final_words"] = len(final.split())
    row.update(grade(set_name, it, final, row["finish"]))
    return row


# Rows.

class Rows:
    """rows.jsonl, appended under a lock and flushed after every row."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.f = open_private(path, os.O_WRONLY | os.O_APPEND)
        self.counts = {}

    def write(self, row):
        assert "reasoning" not in row and "reasoning_content" not in row
        line = json.dumps(row, ensure_ascii=False)
        with self.lock:
            self.f.write(line + "\n")
            self.f.flush()
            c = self.counts.setdefault(row["model"], {"done": 0, "right": 0, "errors": 0})
            c["done"] += 1
            c["right"] += bool(row.get("right"))
            c["errors"] += bool(row.get("error"))

    def close(self):
        with self.lock:
            self.f.close()


def finished_keys(path):
    """Keys of rows that finished without an error; a half-written last line is ignored."""
    done = set()
    if not os.path.exists(path):
        return done
    for r in report.load_rows_file(path):
        if not r.get("error"):
            done.add((r["set"], r["id"], r["model"], r["mode"]))
    return done


# Lab facts for meta.json.

LAB_KEYS = ("name", "type", "region", "usd_per_hour", "kv", "ctx_per_slot", "ladder", "llama_cpp_commit", "launched", "ready_at")


def lab_facts():
    try:
        lab = common.active_lab()
    except Exception:
        lab = None
    if not lab:
        return None
    return {k: lab.get(k) for k in LAB_KEYS}


def lab_server(name):
    try:
        lab = common.active_lab() or {}
    except Exception:
        lab = {}
    return ((lab.get("servers") or {}).get(name)) or {}


def lab_cap(cfg):
    """The reasoning-on token cap of the lab's context size (lower when it runs the fallback context), or None."""
    try:
        cap = (common.lab_summary(cfg) or {}).get("max_tokens_on_cap")
    except Exception:
        cap = None
    return cap if isinstance(cap, int) and cap > 0 else None


def model_meta(m, cfg, modes, status, session):
    srv = lab_server(m["name"])
    flags = srv.get("flags")
    bpw = common.bpw(m)
    return {"name": m["name"], "label": m.get("label"), "role": m.get("role"), "publisher": m.get("publisher"),
            "license": m.get("license"), "quant": m.get("quant"), "params_b": m.get("params_b"), "bytes": m.get("bytes"),
            "bpw": round(bpw, 2) if bpw else None, "file": m.get("file"), "sha256": m.get("sha256"),
            "sha256_ok": srv.get("sha256_ok"), "reasoning_level": m.get("reasoning_level"), "cutoff": m.get("cutoff"),
            "final": m.get("final"), "modes": modes, "request": m.get("request"),
            "flags": flags if flags else list(cfg["lab"].get("server_flags") or []) + list(m.get("serve") or []),
            "flags_source": "lab state" if flags else "models.json (no lab state)", "gpu_mib": srv.get("gpu_mib"),
            "health": status, "props": props(m, cfg) if status == "ok" else None, "session": session}


def git_head():
    try:
        return subprocess.run(["git", "-C", common.ROOT, "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10).stdout.strip() or None
    except Exception:
        return None


# Python items on the lab.

DRIVER = r'''
ns = {"__name__": "score_reasoning_on_lab", "__file__": "score_reasoning.py"}
exec(compile(SOURCE, "score_reasoning.py", "exec"), ns)
KEEP = ("timeout", "no python code block")
for job in JOBS:
    try:
        r = ns["run_python_tests"](job["final"], job["item"], True)
        out = {"k": job["k"], "right": r.get("right"), "passed": r.get("passed"), "of": r.get("of"), "sandbox": r.get("sandbox")}
        if r.get("note") in KEEP:
            out["note"] = r["note"]
    except Exception as e:
        out = {"k": job["k"], "right": None, "error": type(e).__name__}
    print(json.dumps(out), flush=True)
'''


def python_program(jobs):
    with open(os.path.join(JOB, "score_reasoning.py")) as f:
        source = f.read()
    return "import json\nSOURCE = " + repr(source) + "\nJOBS = json.loads(" + repr(json.dumps(jobs)) + ")\n" + DRIVER


def python_on_lab(run_dir, cfg, rows_out, items_by_id, runner=subprocess.run):
    """Grades the run's ungraded python replies on the lab. Returns how many were graded."""
    rows = [r for r in report.load_rows(run_dir) if r["set"] == "reasoning" and r.get("kind") == "python"
            and r.get("right") is None and not r.get("error") and r.get("final")]
    if not rows:
        say("python items: none left to grade")
        return 0
    target = common.ssh_args(cfg=cfg)
    if not target:
        say(f"python items: no lab is up, so {len(rows)} stay ungraded")
        return 0
    jobs = [{"k": i, "final": r["final"], "item": items_by_id[r["id"]]["raw"]} for i, r in enumerate(rows) if r["id"] in items_by_id]
    cmd = ["ssh"] + target + ["python3 -I -"]
    say(f"python items: running {len(jobs)} replies' tests on the lab (temporary folder, no network)")
    try:
        done = runner(cmd, input=python_program(jobs), capture_output=True, text=True, timeout=900)
    except Exception as e:
        say(f"python items: ssh failed ({type(e).__name__}); they stay ungraded")
        return 0
    graded = 0
    for line in (done.stdout or "").splitlines():
        try:
            out = json.loads(line)
            r = rows[out["k"]]
        except (ValueError, KeyError, IndexError, TypeError):
            continue
        if out.get("right") is None:
            continue
        new = dict(r, right=bool(out["right"]), verdict="right" if out["right"] else "wrong", at=now_iso(),
                   why=f"python tests {out.get('passed')}/{out.get('of')} on the lab ({out.get('sandbox')})" + (f", {out['note']}" if out.get("note") else ""))
        rows_out.write(new)
        graded += 1
    say(f"python items: {graded} graded, ssh exit {done.returncode}")
    return graded


# The run.

def parse_models(text, cfg):
    if not text or text == "all":
        return common.models(cfg, enabled_only=True)
    out = []
    for n in text.split(","):
        n = n.strip()
        if not n:
            continue
        try:
            out.append(common.model(n, cfg))
        except KeyError:
            names = [m["name"] for m in common.models(cfg, enabled_only=False)]
            raise SystemExit(f"unknown model {n!r}; models.json has {', '.join(names)}")
    return out


def replaced_by(m, cfg):
    for other in common.models(cfg, enabled_only=True):
        if other.get("replaces") == m["name"]:
            return other["name"]
    return None


def new_run_id():
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M") + "-" + secrets.token_hex(2)


def run(a, wait=None, touch=None):
    touch = touch or common.touch_last_use
    cfg = common.load_config(a.config) if a.config else common.load_config()
    names = resolve_sets(a.sets, a.final_honesty_test, wait=wait)
    evals_dir = a.evals_dir or EVALS
    if a.resume and not a.run_id:
        raise SystemExit("--resume needs --run-id")
    if a.run_id and not RUN_ID.match(a.run_id):
        raise SystemExit("--run-id may hold only letters, digits, '.', '_' and '-'")
    run_id = a.run_id or new_run_id()
    run_dir = os.path.join(evals_dir, run_id)
    meta_path = os.path.join(run_dir, "meta.json")
    old = None
    if os.path.exists(meta_path):
        if not a.resume:
            raise SystemExit(f"run {run_id} exists; add --resume to carry on with it")
        with open(meta_path) as f:
            old = json.load(f)
    elif a.resume:
        raise SystemExit(f"no run {run_id} under {evals_dir}")

    # The plan: a resumed run keeps its own sets, modes, limits and item choice, so its rows pair up.
    a_reasoning = parse_reasoning(a.reasoning)[0] if a.reasoning else None
    a_limit = parse_limit(a.limit)[0] if a.limit not in (None, "") else None
    a_off = parse_max_off(getattr(a, "max_tokens_off", None))[0]
    given = {"sets": names, "reasoning": a_reasoning, "limit": a_limit, "probes_n": a.probes_n, "max_tokens_on": a.max_tokens_on,
             "max_tokens_off": a_off}
    if old:
        p = old["plan"]
        for k, v in given.items():
            explicit = getattr(a, "_given", {}).get(k, False)
            was = (p.get(k) or "glimmer") if k == "max_tokens_off" else p.get(k)  # runs before the flag used glimmer
            if k == "max_tokens_off" and v is None:
                continue  # auto keeps whatever the run has
            if explicit and v != was:
                raise SystemExit(f"run {run_id} was made with {k}={was!r}; a resume keeps it (got {v!r})")
        names, reasoning, limit, probes_n, max_on = p["sets"], p["reasoning"], p["limit"], p["probes_n"], p.get("max_tokens_on")
        max_off, off_auto = p.get("max_tokens_off") or "glimmer", bool(p.get("max_tokens_off_auto"))
        if FINAL_SET in names and not a.final_honesty_test:
            raise SystemExit("this run holds the final honesty test; resuming it needs --final-honesty-test")
        if a.final_honesty_test and FINAL_SET not in names:
            raise SystemExit("the final honesty test can't be added to an existing run; start a new run for it")
    else:
        reasoning, limit, probes_n, max_on = a_reasoning, a_limit, a.probes_n, a.max_tokens_on
        max_off, off_auto = a_off, a_off is None  # auto is settled below, from the models asked for
    reasoning = parse_reasoning(reasoning or "default")[0]
    limit, set_limits, part_limits = parse_limit(limit or 0)
    probes_n = 500 if probes_n is None else probes_n

    set_items = []
    set_meta = {}
    for n in names:
        spec = spec_for(n)
        if not os.path.exists(spec["path"]):
            raise SystemExit(f"{n}: {spec['path']} is missing")
        sha = sha256_file(spec["path"])
        if old and n in old["sets"] and old["sets"][n]["sha256"] != sha:
            raise SystemExit(f"{n}: the file changed since run {run_id} started; start a new run")
        items = load_set(n, probes_n=probes_n, limit=set_limits.get(n, 0), part_limits=part_limits.get(n))
        set_items.append((n, items))
        set_meta[n] = {"file": os.path.relpath(spec["path"], common.ROOT), "sha256": sha, "n": len(items),
                       "n_file": count_lines(spec["path"]), "grader": spec["grader"]}

    # The models asked for (their health comes later). Auto thinking-off limits depend on them, never on which are up.
    wanted = parse_models(a.models, cfg)
    if off_auto and max_off is None:
        max_off = "compare" if any(m.get("role") == "other" for m in wanted) else "glimmer"

    if old:
        limits = old["limits"]
        cap = lab_cap(cfg)
        if cap and any(v["on"] > cap for v in limits.values()) and any(modes_for(n, it, reasoning).count("on") for n, its in set_items for it in its):
            raise SystemExit(f"this lab caps reasoning-on replies at {cap} tokens (ctx fallback), but run {run_id} used "
                             f"{max(v['on'] for v in limits.values())}; start a new run on this lab")
        capped = old.get("capped_by_lab")
    else:
        off = parse_max_off(max_off)[1]
        limits = {n: {"off": off[n], "on": max_on or spec_for(n)["on"]} for n in names}
        cap = lab_cap(cfg)
        capped = None
        if cap and any(v["on"] > cap for v in limits.values()):
            capped = cap
            for v in limits.values():
                v["on"] = min(v["on"], cap)
            say(f"note: the lab's context per slot caps reasoning-on replies at {cap} tokens, so that is every model's "
                "on limit in this run")
        if cap and any(v["off"] > cap for v in limits.values()):
            for v in limits.values():
                v["off"] = min(v["off"], cap)
            say(f"note: thinking-off limits capped at {cap} tokens too (the lab's context per slot)")
    why_off = " (auto: other models are in the run)" if off_auto and max_off == "compare" else " (auto)" if off_auto else ""
    say(f"thinking-off limits {max_off}{why_off}: " + ", ".join(f"{n} {limits[n]['off']}" for n in names if n in limits))

    jobs = plan(set_items, reasoning, limits)
    items_by_id = {it["id"]: it for n, its in set_items if n == "reasoning" for it in its}

    # Models: health first; a model that is down, loading or not loaded is skipped and named.
    base = common.base_model(cfg)["name"]
    session = len(old["sessions"]) if old else 0
    running, skipped = [], []
    for m in wanted:
        st = health(m, cfg)
        if st != "ok":
            why = f"health {st}"
            srv = lab_server(m["name"])
            state = srv.get("state") if isinstance(srv.get("state"), str) else ""
            if state.startswith("not loaded"):
                why = state  # as lab.py stored it: "not loaded (memory)", "not loaded" or "not loaded (replaced)"
            elif st == "down" and replaced_by(m, cfg):
                why = f"not loaded (replaced by {replaced_by(m, cfg)})"
            skipped.append({"model": m["name"], "why": why, "session": session})
            say(f"skipped: {m['name']}: {why}")
            continue
        running.append((m, st))
    if not running:
        raise SystemExit("no model is up: start the lab with lab.py up, or check lab.py status (the tunnel may need lab.py tunnel)")
    if base not in [m["name"] for m, _ in running] and not (old and any(x["name"] == base for x in old["models"])):
        say(f"warning: the base model {base} is not in this run, so there are no paired differences")
    if max_off == "glimmer" and any(m.get("role") == "other" for m, _ in running):
        say("warning: this run uses Glimmer's thinking-off limits (96 knowledge, 192 honesty), which cut most replies of "
            "the other models; for a fair comparison start a new run with --max-tokens-off compare (the default when "
            "they are asked)")

    make_private_dir(evals_dir)
    make_private_dir(run_dir)
    started = now_iso()
    meta = old or {"run_id": run_id, "created": started, "base": base, "plan": {}, "sets": {}, "limits": limits,
                   "capped_by_lab": capped, "models": [], "skipped": [], "sessions": [],
                   "sampling": {"temperature": 0.0, "top_p": 1.0, "top_k": 1, "seed": 7, "cache_prompt": False,
                                "stream": False, "neutral": common.NEUTRAL},
                   "system": common.SYSTEM, "order": "each set shuffled with random.Random(7); --limit takes the first N",
                   "llama_cpp": cfg.get("llama_cpp"), "final_honesty_test": FINAL_SET in names}
    meta["plan"] = {"sets": names, "reasoning": reasoning, "limit": limit, "probes_n": probes_n, "max_tokens_on": max_on,
                    "max_tokens_off": max_off, "max_tokens_off_auto": off_auto,
                    "python_on_lab": bool(a.python_on_lab or meta.get("plan", {}).get("python_on_lab"))}
    meta["sets"].update(set_meta)

    by_model = {}
    modes_skipped = []
    plan_n = {}
    for m, st in running:
        has = set((m.get("request") or {}).keys())
        mine = [j for j in jobs if j[2] in has]
        lacking = sorted({j[2] for j in jobs} - has)
        for mode in lacking:
            modes_skipped.append({"model": m["name"], "mode": mode, "why": "no such mode in models.json", "session": session})
            say(f"skipped: {m['name']} mode {mode}: the model has no such mode")
        by_model[m["name"]] = (m, mine)
        plan_n[m["name"]] = len(mine)
        entry = model_meta(m, cfg, sorted(has & {"off", "on"}), st, session)
        meta["models"] = [x for x in meta["models"] if x["name"] != m["name"]] + [entry]
    now_skipped = {x["model"] for x in skipped}
    meta["skipped"] = [s for s in meta.get("skipped", []) if s["model"] not in by_model and s["model"] not in now_skipped] \
        + skipped + modes_skipped
    lab_now = lab_facts()
    meta["sessions"].append({"n": session, "start": started, "end": None, "status": "running", "models": list(by_model),
                             "lab": lab_now, "limits": limits, "planned": plan_n, "git_head": git_head(),
                             "parallel": a.parallel, "python_on_lab": bool(a.python_on_lab)})
    meta["lab"] = lab_now or meta.get("lab")
    meta["git_head"] = meta["sessions"][-1]["git_head"]
    meta["start"] = meta.get("start") or started
    write_json(meta_path, meta)

    rows_path = os.path.join(run_dir, "rows.jsonl")
    done = finished_keys(rows_path) if old else set()
    todo = {}
    for name, (m, mine) in by_model.items():
        todo[name] = [j for j in mine if (j[0], j[1]["id"], name, j[2]) not in done]
    total = sum(len(v) for v in todo.values())
    say(f"run {run_id}: {len(by_model)} models, sets {', '.join(names)}, reasoning {reasoning}, "
        f"{total} requests to send ({sum(plan_n.values()) - total} already done), {a.parallel} at a time per model")
    say(f"run folder: {run_dir}")

    out = Rows(rows_path)
    stop = threading.Event()

    def work(m, j):
        if stop.is_set():
            return None
        try:
            row = ask(m, cfg, j)
        except Exception as e:  # a bug here must not stop the other requests; the row says which kind of failure
            row = error_row(m, j, type(e).__name__)
        out.write(row)
        return row

    def run_model(name):
        m, mine = by_model[name][0], todo[name]
        with ThreadPoolExecutor(max_workers=max(1, a.parallel)) as pool:
            list(pool.map(lambda j: work(m, j), mine))

    threads = [threading.Thread(target=run_model, args=(n,), daemon=True) for n in todo]
    status = "finished"
    touch()
    last_touch = last_print = time.time()
    try:
        for t in threads:
            t.start()
        while any(t.is_alive() for t in threads):
            for t in threads:
                t.join(timeout=1)
            if time.time() - last_touch >= TOUCH_EVERY:
                touch()
                last_touch = time.time()
            if time.time() - last_print >= 60:
                last_print = time.time()
                say(progress(out.counts, todo))
    except KeyboardInterrupt:
        status = "interrupted"
        stop.set()
        say(f"stopping: requests in flight finish first (Ctrl-C again quits now). Resume with --run-id {run_id} --resume")
        try:
            while any(t.is_alive() for t in threads):
                for t in threads:
                    t.join(timeout=1)
                if time.time() - last_touch >= TOUCH_EVERY:
                    touch()
                    last_touch = time.time()
        except KeyboardInterrupt:
            meta["sessions"][-1].update(end=now_iso(), status="interrupted", counts=out.counts)
            meta["end"] = meta["sessions"][-1]["end"]
            write_json(meta_path, meta)
            os._exit(130)
    touch()
    say(progress(out.counts, todo))

    if a.python_on_lab and status == "finished":
        python_on_lab(run_dir, cfg, out, items_by_id)
    out.close()
    meta["sessions"][-1].update(end=now_iso(), status=status, counts=out.counts)
    meta["end"] = meta["sessions"][-1]["end"]
    write_json(meta_path, meta)
    summary = report.build(run_dir, base=a.base)
    say("")
    say(report.accuracy_markdown(summary))
    say("")
    say(f"report: {os.path.join(run_dir, 'report.md')} and report.html (local only: they hold private dev questions)")
    return run_dir


def progress(counts, todo):
    parts = []
    for name in todo:
        c = counts.get(name, {"done": 0, "right": 0, "errors": 0})
        parts.append(f"{name} {c['done']}/{len(todo[name])} ({c['right']} right, {c['errors']} errors)")
    return "progress: " + "; ".join(parts)


def show_sets(out=None):
    out = out or sys.stdout
    print(f"{'set':12s} {'items':>6s}  {'default modes':34s} {'max tokens off/on':18s} grader", file=out)
    for n, spec in SETS.items():
        exists = os.path.exists(spec["path"])
        count = count_lines(spec["path"]) if exists else 0
        print(f"{n:12s} {count if exists else 'missing':>6}  {spec['default']:34s} {str(spec['off']) + ' / ' + str(spec['on']):18s} {spec['grader']}", file=out)
        print(f"{'':12s} {'':6s}  {os.path.relpath(spec['path'], common.ROOT)}" + (f" sha256 {sha256_file(spec['path'])[:16]}" if exists else ""), file=out)
    print("\nThe limits above are --max-tokens-off glimmer. With other models in the run the default is compare: "
          + ", ".join(f"{k} {v}" for k, v in COMPARE_OFF.items() if k in SETS) + "; reasoning keeps "
          + str(SETS["reasoning"]["off"]) + ".", file=out)
    print(f"\n{FINAL_SET}: the final honesty test ({os.path.relpath(FINAL['path'], common.ROOT)}, 190 items). Never in a "
          "default or \"all\" run; only with --final-honesty-test, which warns and waits 15 s.", file=out)
    print("Order: every set is shuffled with random.Random(7); --limit N takes the first N of each set after that, "
          "--probes-n the first N probes (0 = all 2,500).", file=out)
    print("Sampling for every model: temperature 0, top_k 1, top_p 1, seed 7, cache_prompt false, plus common.NEUTRAL.", file=out)


class Given(argparse.Action):
    """Remembers which plan options were typed, so a resume can tell a clash from a default."""

    def __call__(self, parser, ns, values, option_string=None):
        setattr(ns, self.dest, values)
        g = getattr(ns, "_given", None) or {}
        g[self.dest] = True
        ns._given = g


def main(argv=None):
    ap = argparse.ArgumentParser(description="Evals for the compare lab: the same sets, graded the same way, for every model.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="ask every set of every model and write a report")
    r.add_argument("--sets", default=None, action=Given, help="comma list, or all (the five dev sets); default all")
    r.add_argument("--models", default="all", help="all (the enabled models in models.json) or a comma list")
    r.add_argument("--reasoning", default=None, action=Given,
                   help="default, off, on or both; or per set, e.g. off,reasoning=both")
    r.add_argument("--limit", default=None, action=Given,
                   help="first N items of each set after its order; or per set, e.g. probes=100,salient=60,reasoning.skills=20")
    r.add_argument("--probes-n", type=int, default=None, action=Given, help="probes to ask (500; 0 means all 2,500)")
    r.add_argument("--parallel", type=int, default=2, help="requests at once per model (2, one per server slot)")
    r.add_argument("--max-tokens-on", type=int, default=None, action=Given, help="override the reasoning-on limit of every set")
    r.add_argument("--max-tokens-off", default=None, action=Given,
                   help="thinking-off limits: auto (default: compare when a model with role other is asked, else glimmer), "
                        "glimmer (96 knowledge, 192 honesty), compare (384 knowledge, 768 honesty), N, or per set, "
                        "e.g. compare,honesty-dev=1024")
    r.add_argument("--run-id")
    r.add_argument("--resume", action="store_true", help="carry on with --run-id: skip rows that finished without an error")
    r.add_argument("--python-on-lab", action="store_true", help="grade the python items by running their tests on the lab")
    r.add_argument("--final-honesty-test", action="store_true", help="add the 190-item FINAL honesty test (warns, waits 15 s)")
    r.add_argument("--base", help="paired reference for the report (default: the model with role base)")
    r.add_argument("--config", help=argparse.SUPPRESS)
    r.add_argument("--evals-dir", help=argparse.SUPPRESS)
    rp = sub.add_parser("report", help="rebuild summary.json, report.md and report.html for a run folder")
    rp.add_argument("run_dir")
    rp.add_argument("--base")
    sub.add_parser("sets", help="list the sets, their files and limits")
    a = ap.parse_args(argv)
    if a.cmd == "sets":
        show_sets()
        return 0
    if a.cmd == "report":
        summary = report.build(a.run_dir, base=a.base)
        print(report.accuracy_markdown(summary))
        print(f"\nwrote {os.path.join(a.run_dir, 'summary.json')}, report.md and report.html")
        return 0
    run(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
