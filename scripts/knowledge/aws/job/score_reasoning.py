"""Reasoning and general-skills test for any Muse Glimmer GGUF, with llama-server. Every earlier score (score_gguf.py,
score_honesty.py) prefills the final channel, so reasoning was never measured. This one leaves the channel to the model,
so we can see whether tuning hurt it, compared with base at the same quantization.

Prompts: the base chat template with the system line "You are a helpful assistant.", the chosen reasoning strength
(medium by default) and the generation prompt, leading BOS text removed, token ids from the base tokenizer sent to
/completion, greedy, up to 2,048 new tokens. The model chooses its own channel: <|start|>assistant to=self<|message|>
reasoning <|eom|><|start|>assistant to=user<|message|> final <|eot|>. <|eom|> is not an end token in llama.cpp, so one
request carries both channels; the reply is split on the token ids. Items marked also_off are asked a second time with
reasoning off: the final channel " to=user<|message|>" appended, as score_gguf.py does, same 2,048 limit.

Reports: structure (a reasoning channel appears, its length, reaches a final answer, hits the limit, loops), multi-step
accuracy by kind, a harder set with room above base, the 40 items on and off, general skills (python tests, JSON parsing, instructions by code, a multi-turn
detail), and with --mmproj a vision smoke test on 5 generated images, in a second server after the main run.

Model-written code only runs with --allow-code-exec, never on macOS, in a subprocess with a timeout, CPU, memory and file
limits, an empty environment, a temporary directory, and no network (a new network namespace when `unshare -rn` works,
and sockets disabled in Python either way). Without the flag python items are left ungraded. --table never runs code.

--deadline-epoch: no new item starts after it, and requests still running are cut 120 s later; what's done is saved and
the JSON says complete: false. Replies also go to OUT.partial.jsonl as they finish.

Usage (one command, any GGUF):
  python -I score_reasoning.py --gguf FILE.gguf --label "stage2 Q4_K_M" --out DIR/Q4_K_M-medium.json --tokenizer BASE_HF \
      --allow-code-exec [--strength medium] [--mmproj mmproj.gguf] [--parallel 32] [--port 8094] [--deadline-epoch N]
Hold ~/q/gpu.lock around it (flock ~/q/gpu.lock python ...). Then, on any machine:
  python score_reasoning.py --table A.json B.json [C.json ...]
which regrades stored replies (python verdicts stay as stored), prints the table, and pairs each file with the first.

Two verdicts per item. right: strict, on the to=user channel with exactly that header, which is what llama-server's chat
endpoint and any app can parse. right_lenient: any header spelling; if no header names the user, the last text in the
reply. The gap between them is channel damage; what's lost in both is lost thinking. --prefill-reasoning puts the correct
reasoning header in the prompt, to see what the model does when the first header can't go wrong.
"""

import argparse
import base64
import json
import os
import random
import re
import shutil
import signal
import statistics
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from math import comb, sqrt

HERE = os.path.dirname(os.path.abspath(__file__))
SYSTEM = "You are a helpful assistant."
GENERATION_PROMPT = "<|start|>assistant"
FINAL_CHANNEL = " to=user<|message|>"
PREFILL = " to=self<|message|>"
SERVER = "/home/ubuntu/writer/llama.cpp-b11970/build/bin/llama-server"


# Grading. Each function takes the final-channel text only.

def answer_line(final):
    """The text after the last "Answer:" in the reply, markdown removed, or None."""
    hits = re.findall(r"(?im)answer\s*[:=]\s*(.+?)\s*$", final.replace("*", "").replace("`", ""))
    return hits[-1].strip() if hits else None


NUMBER = r"-?\d[\d,]*(?:\.\d+)?"


def to_fraction(text):
    return Fraction(text.replace(",", ""))


def grade_number(final, expected):
    line = answer_line(final)
    found = re.findall(NUMBER, (line or final).replace("$", ""))
    if not found:
        return {"right": False, "got": None, "had_format": line is not None}
    # On the answer line the first number is the value ("29 dollars (50 - 21)"); with no such line, the last in the reply.
    got = found[0] if line is not None else found[-1]
    try:
        return {"right": to_fraction(got) == Fraction(str(expected)), "got": got, "had_format": line is not None}
    except (ValueError, ZeroDivisionError):
        return {"right": False, "got": got, "had_format": line is not None}


MONTH = {m: i + 1 for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"])}


def find_dates(text):
    out = [f"{y}-{int(m):02d}-{int(d):02d}" for y, m, d in re.findall(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b", text)]
    for mon, d, y in re.findall(r"\b([A-Za-z]+) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})\b", text):
        if mon.lower() in MONTH:
            out.append(f"{y}-{MONTH[mon.lower()]:02d}-{int(d):02d}")
    return out


def grade_date(final, expected):
    line = answer_line(final)
    found = find_dates(line) if line else []
    had = bool(found)
    found = found or find_dates(final)
    got = found[0] if had else (found[-1] if found else None)
    return {"right": got == expected, "got": got, "had_format": line is not None}


def grade_option(final, expected, options):
    """Right if exactly the expected option is named on the answer line, or, with no answer line, it's the last one named."""
    line = answer_line(final)
    def named(text):
        hits = []
        for o in options:
            hits += [(m.start(), o) for m in re.finditer(rf"\b{re.escape(o)}\b", text, re.I)]
        return [o for _, o in sorted(hits)]
    if line is not None:
        hits = set(named(line))
        return {"right": hits == {expected}, "got": sorted(hits), "had_format": True}
    hits = named(final)
    got = hits[-1] if hits else None
    return {"right": got == expected, "got": got, "had_format": False}


def grade_final(item, final):
    if item["answer_type"] == "number":
        return grade_number(final, item["answer"])
    if item["answer_type"] == "date":
        return grade_date(final, item["answer"])
    return grade_option(final, item["answer"], item["options"])


def match_spec(value, spec):
    if isinstance(spec, dict) and "$list_of" in spec:
        return isinstance(value, list) and len(value) == spec["$len"] and all(isinstance(v, str) and v.strip() for v in value)
    if isinstance(spec, dict):
        return isinstance(value, dict) and set(value) == set(spec) and all(match_spec(value[k], spec[k]) for k in spec)
    if isinstance(spec, list):
        return isinstance(value, list) and len(value) == len(spec) and all(match_spec(v, s) for v, s in zip(value, spec))
    if isinstance(spec, bool) or isinstance(value, bool):
        return value is spec
    return value == spec


def grade_json(item, final):
    """right: the whole reply parses as JSON and matches. fenced_ok: same after removing a code fence, which the prompt forbids."""
    text = final.strip()
    def parses(t):
        try:
            return True, json.loads(t)
        except ValueError:
            return False, None
    ok, value = parses(text)
    right = ok and match_spec(value, item["expect"])
    bare = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text).strip()
    ok2, value2 = parses(bare)
    return {"right": right, "parsed": ok, "fenced_ok": ok2 and match_spec(value2, item["expect"])}


def check_instruction(item, final):
    text = final.strip()
    words = re.findall(r"[A-Za-z0-9'-]+", text)
    c = item["check"]
    if not words:
        return False
    if c == "max_words":
        return 3 <= len(words) <= item["n"]
    if c == "phrase":
        return item["text"] in text
    if c == "bullets":
        lines = [ln for ln in text.splitlines() if ln.strip()]
        return len(lines) == item["n"] and all(ln.startswith("- ") for ln in lines)
    if c == "lowercase":
        return text == text.lower() and len(words) >= 4
    if c == "forbid":
        return not re.search(rf"\b(?:{item['text']})s?\b", text, re.I) and len(words) >= 4
    if c == "starts":
        return text.replace("*", "").startswith(item["text"])
    if c == "ends":
        return text.replace("*", "").rstrip().endswith(item["text"])
    if c == "sentences":
        return len(re.findall(r"[^.!?]+[.!?]+(?:\s|$)", text)) == item["n"] and text[-1] in ".!?"
    raise ValueError(c)


def grade_multiturn(item, final):
    return all(re.search(rf"(?<![A-Za-z0-9]){re.escape(n)}(?:st|nd|rd|th)?(?![A-Za-z0-9])", final, re.I) for n in item["needs"])


# Model-written code runs only through here.

GUARD = """
import resource, socket, sys
for lim, val in ((resource.RLIMIT_CPU, 5), (resource.RLIMIT_AS, 1 << 30), (resource.RLIMIT_FSIZE, 1 << 20), (resource.RLIMIT_NPROC, 64)):
    resource.setrlimit(lim, (val, val))
class _Blocked(socket.socket):
    def __init__(self, *a, **k):
        raise OSError("network disabled")
def _refuse(*a, **k):
    raise OSError("network disabled")
socket.socket = _Blocked
socket.create_connection = _refuse
"""

RUNNER = """
_passed = 0
_tests = {tests!r}
for _t in _tests:
    try:
        if eval(_t):
            _passed += 1
        else:
            print("FAILED", _t)
    except Exception as _e:
        print("ERROR", _t, repr(_e)[:200])
print("PASSED", _passed, "OF", len(_tests))
"""


def code_block(final):
    blocks = re.findall(r"```(?:python|py)?\s*\n(.*?)```", final, re.S)
    return blocks[-1] if blocks else None


def run_python_tests(final, item, allow):
    if not allow:
        return {"right": None, "note": "code not run (--allow-code-exec not given)"}
    if sys.platform == "darwin":
        raise RuntimeError("Model-written code never runs on this Mac")
    code = code_block(final)
    if code is None:
        return {"right": False, "note": "no python code block", "passed": 0, "of": len(item["tests"])}
    # The code runs inside this file as a whole, with the test loop after it, so one wrong test doesn't hide the others.
    source = GUARD + "\n" + code + "\n" + RUNNER.format(tests=item["tests"])
    with tempfile.TemporaryDirectory(prefix="reasoning-code-") as d:
        path = os.path.join(d, "attempt.py")
        with open(path, "w") as f:
            f.write(source)
        cmd = [sys.executable, "-I", "-S", path]
        sandbox = "sockets-off"
        if UNSHARE_OK():
            cmd = ["unshare", "-rn"] + cmd
            sandbox = "netns+sockets-off"
        try:
            run = subprocess.run(cmd, cwd=d, env={"PATH": "/usr/bin:/bin"}, capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            return {"right": False, "note": "timeout", "passed": 0, "of": len(item["tests"]), "sandbox": sandbox}
    found = re.search(r"PASSED (\d+) OF (\d+)\s*$", run.stdout)
    passed = int(found.group(1)) if found else 0
    of = len(item["tests"])
    return {"right": passed == of and run.returncode == 0, "passed": passed, "of": of, "sandbox": sandbox,
            "note": (run.stdout[-300:] + run.stderr[-300:]).strip()[:600]}


_unshare = {}


def UNSHARE_OK():
    if "ok" not in _unshare:
        try:
            _unshare["ok"] = shutil.which("unshare") is not None and subprocess.run(["unshare", "-rn", "true"], capture_output=True, timeout=10).returncode == 0
        except Exception:
            _unshare["ok"] = False
    return _unshare["ok"]


def grade_row(item, final, allow_exec):
    kind = item["kind"]
    if item["part"] in ("multistep", "hard"):
        return grade_final(item, final)
    if kind == "python":
        return run_python_tests(final, item, allow_exec)
    if kind == "json":
        return grade_json(item, final)
    if kind == "instructions":
        return {"right": check_instruction(item, final)}
    return {"right": grade_multiturn(item, final)}


# Splitting a reply into channels, on the token ids.

def split_channels(tokens, tok):
    ids = {n: tok.convert_tokens_to_ids(n) for n in ("<|start|>", "<|message|>", "<|eom|>", "<|eot|>", "<|end_of_text|>")}
    ends = {ids["<|eom|>"], ids["<|eot|>"], ids["<|end_of_text|>"]}
    segments, i, n = [], 0, len(tokens)
    while i < n:
        at = next((j for j in range(i, n) if tokens[j] == ids["<|message|>"] or tokens[j] in ends), None)
        if at is not None and tokens[at] in ends:
            # Text with no header before an end token: not a channel any parser would accept.
            segments.append({"to": None, "tokens": tokens[i:at], "closed": True})
            i = at + 1
            while i < n and tokens[i] == ids["<|start|>"]:
                i += 1
            continue
        if at is None:
            if i == 0 or any(t not in ends and t != ids["<|start|>"] for t in tokens[i:]):
                segments.append({"to": None, "tokens": tokens[i:], "closed": False})
            break
        header = tok.decode(tokens[i:at], skip_special_tokens=True)
        found = re.fullmatch(r"\s*(?:assistant)?\s*to=(\S+)\s*", header)
        j = at + 1
        while j < n and tokens[j] not in ends and tokens[j] != ids["<|start|>"]:
            j += 1
        segments.append({"to": found.group(1) if found else None, "tokens": tokens[at + 1:j], "closed": j < n and tokens[j] in ends, "end": tok.decode([tokens[j]]) if j < n else None})
        i = j + 1 if j < n and tokens[j] in ends else j
        while i < n and tokens[i] != ids["<|message|>"] and tokens[i] in {ids["<|start|>"]}:
            i += 1
    return segments


ENDS_TEXT = ("<|eom|>", "<|eot|>", "<|end_of_text|>")


def analyze_raw(raw):
    """Reads a reply's text the forgiving way, so a misspelled channel header (" toself", " to self") isn't taken for lost
    reasoning. Returns the first header as written, how the reply is shaped, the reasoning-like text's length in words and
    the final text: the last segment whose header names the user, else the last text in the reply."""
    segs = []
    for part in raw.split("<|start|>"):
        head, body = part.split("<|message|>", 1) if "<|message|>" in part else (None, part)
        cuts = [(body.find(e), e) for e in ENDS_TEXT if e in body]
        at, end = min(cuts) if cuts else (len(body), None)
        segs.append({"head": head.strip() if head is not None else None, "body": body[:at].strip(), "end": end})
    segs = [x for x in segs if x["head"] is not None or x["body"]]
    def name(x):
        h = x["head"]
        if h is None:
            return "none"
        m = re.fullmatch(r"(?:assistant\s*)?to=(self|user)", h)
        return m.group(1) if m else "misspelled"
    def is_user(x):
        return x["head"] is not None and "user" in x["head"].lower() and "self" not in x["head"].lower()
    names = [name(x) for x in segs]
    users = [x for x in segs if is_user(x)]
    closed = any(x["end"] in ("<|eot|>", "<|end_of_text|>") for x in users)
    if names == ["self", "user"] and closed:
        shape = "well formed: to=self, then to=user"
    elif names == ["user"] and closed:
        shape = "straight to to=user"
    elif "user" in names and closed:
        shape = "first header wrong, to=user right"
    elif users and closed:
        shape = "to=user header misspelled"
    elif names and names[0] == "self":
        shape = "to=self, then no final channel"
    elif names and names[0] == "misspelled":
        shape = "header misspelled, then no final channel"
    elif names:
        shape = "no header, no final channel"
    else:
        shape = "empty"
    thinking = " ".join(x["body"] for x in segs if not is_user(x))
    last = users[-1]["body"] if users else (segs[-1]["body"] if segs else "")
    first = segs[0]["head"] if segs and segs[0]["head"] is not None else (segs[0]["body"][:24] if segs else "")
    return {"channels": names, "shape": shape, "header_first": first, "final_lenient": last, "reasoning_words": len(thinking.split())}


def add_lenient(row, item, allow_exec):
    a = analyze_raw(row["raw"])
    row.update({k: a[k] for k in ("shape", "header_first", "final_lenient", "reasoning_words")})
    if row["mode"] == "on":
        row["channels"] = a["channels"]
    if a["final_lenient"] == row["final"]:
        row["right_lenient"] = row.get("right")
    elif item["kind"] == "python" and not allow_exec:
        row["right_lenient"] = row.get("right_lenient")
    else:
        row["right_lenient"] = grade_row(item, a["final_lenient"], allow_exec)["right"]


# What llama-server's chat endpoint parses. Inferred: base's 5 vision replies, all well formed, gave HTTP 200; stage 1's 5, each
# with a wrong first header, gave HTTP 500 ("does not match the expected peg-native format"). A reply going straight to the
# final channel is taken to parse too, though no base reply has done it. Stage 1's multi-step: 20 right and well formed.
CHAT_SHAPES = ("well formed: to=self, then to=user", "straight to to=user")


def chat_counts(rows):
    """Replies with reasoning on that the chat endpoint would accept, overall and among the right multi-step answers."""
    on = [r for r in rows if r["mode"] == "on"]
    return {"all": sum(r.get("shape") in CHAT_SHAPES for r in on), "n": len(on),
            "multistep_right": sum(r.get("shape") in CHAT_SHAPES and bool(r.get("right")) for r in on if r["part"] == "multistep"),
            "multistep_n": sum(r["part"] == "multistep" for r in on)}


def looped(tokens, shortest=8, longest=300, repeats=3):
    """The reply's tail repeats some stretch of 8 to 300 tokens at least 3 times in a row."""
    n = len(tokens)
    for p in range(shortest, min(longest, n // repeats) + 1):
        if tokens[-p:] == tokens[-2 * p:-p] == tokens[-3 * p:-2 * p]:
            return True
    # One- to seven-token cycles need more turns to count: a run of "the the the" shouldn't hide behind the minimum.
    for p in range(1, shortest):
        if n >= 12 * p and all(tokens[-p:] == tokens[-(k + 1) * p: (-k * p) or None] for k in range(1, 12)):
            return True
    return False


def messages_for(it):
    msgs = [{"role": "system", "content": SYSTEM}]
    if it.get("turns"):
        for i, t in enumerate(it["turns"]):
            msgs.append({"role": "assistant" if i % 2 else "user", "content": t})
    else:
        msgs.append({"role": "user", "content": it["question"]})
    return msgs


def prompt_ids(tok, it, mode, strength, prefill=False):
    """Token ids of one prompt: the base chat template, BOS text removed (the tokenizer adds it), with the final channel opened
    for mode "off", or the reasoning header for prefill."""
    bos = tok.bos_token or ""
    text = tok.apply_chat_template(messages_for(it), tokenize=False, add_generation_prompt=True, reasoning_strength=strength)
    text = text.removeprefix(bos) if bos else text
    if not text.endswith(GENERATION_PROMPT):
        raise RuntimeError("Generation prompt doesn't end with " + GENERATION_PROMPT)
    return tok(text + (FINAL_CHANNEL if mode == "off" else PREFILL if prefill else ""))["input_ids"]


def channel_parts(toks, mode, tok):
    """(reasoning tokens, final tokens, channel names, reached a closed final) of a reply's token ids, the strict way."""
    if mode == "off":
        # The prompt already opened the final channel, so the reply is its body.
        end = next((i for i, t in enumerate(toks) if t in {tok.convert_tokens_to_ids("<|eot|>"), tok.convert_tokens_to_ids("<|end_of_text|>"), tok.convert_tokens_to_ids("<|eom|>")}), None)
        return [], toks if end is None else toks[:end], ["user"], end is not None
    segs = split_channels(toks, tok)
    user = [s for s in segs if s["to"] == "user"]
    return [t for s in segs if s["to"] == "self" for t in s["tokens"]], [t for s in user for t in s["tokens"]], [s["to"] or "none" for s in segs], any(s["closed"] for s in user)


def reply_row(it, mode, ids, toks, full, stop, tok, allow_exec):
    """One row of a run's JSON, graded. toks is the reply with any prefilled header put back; full is what the model generated."""
    reasoning_toks, final_toks, channels, reached = channel_parts(toks, mode, tok)
    final = tok.decode(final_toks, skip_special_tokens=False).strip()
    row = {"id": it["id"], "part": it["part"], "kind": it["kind"], "subkind": it.get("subkind"), "steps": it.get("steps"), "mode": mode, "question": it["question"],
           "answer": it.get("answer"), "prompt_tokens": len(ids), "tokens": len(full), "stop": stop, "hit_limit": stop == "limit", "looped": looped(full),
           "channels": channels, "has_reasoning": bool(reasoning_toks), "reached_final": reached, "reasoning_tokens": len(reasoning_toks), "final_tokens": len(final_toks),
           "reasoning": tok.decode(reasoning_toks, skip_special_tokens=False), "final": final, "raw": tok.decode(toks, skip_special_tokens=False)}
    # A reply cut by the limit still gets graded on the final text it has, which is empty when it never got there.
    row.update(grade_row(it, final, allow_exec))
    add_lenient(row, it, allow_exec)
    return row


def post(port, path, body, timeout):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def healthy(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def die_with_parent():
    """The server gets SIGTERM if this script dies, so a kill by `timeout` can't leave it on the GPU."""
    try:
        import ctypes
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)
    except Exception:
        pass


def start_server(cmd, port, log_path):
    began = time.time()
    with open(log_path, "w") as logf:
        server = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT, preexec_fn=die_with_parent)
    while not healthy(port):
        if server.poll() is not None:
            raise RuntimeError(f"llama-server exited with {server.returncode}; see {log_path}")
        if time.time() - began > 600:
            server.terminate()
            raise RuntimeError("llama-server didn't come up in 10 minutes")
        time.sleep(2)
    return server, round(time.time() - began, 1)


def stop_server(server):
    server.terminate()
    try:
        server.wait(timeout=60)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait(timeout=30)


def gpu_mem_used_mib():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
        return int(out.stdout.split()[0])
    except Exception:
        return None


# Images for the vision smoke test, pure standard library.

GLYPHS = {"T": "11111 00100 00100 00100 00100 00100 00100", "I": "11111 00100 00100 00100 00100 00100 11111", "G": "01110 10001 10000 10111 10001 10001 01110",
          "E": "11111 10000 10000 11110 10000 10000 11111", "R": "11110 10001 10001 11110 10100 10010 10001"}


def png(pixels):
    h, w = len(pixels), len(pixels[0])
    raw = b"".join(b"\x00" + bytes(c for px in row for c in px) for row in pixels)
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def vision_items():
    size = 224
    white, black = (255, 255, 255), (0, 0, 0)
    def solid(c):
        return [[c] * size for _ in range(size)]
    def word(text):
        s = 6
        img = solid(white)
        x0, y0 = (size - len(text) * 6 * s + s) // 2, (size - 7 * s) // 2
        for i, ch in enumerate(text):
            for y, row in enumerate(GLYPHS[ch].split()):
                for x, bit in enumerate(row):
                    if bit == "1":
                        for yy in range(s):
                            for xx in range(s):
                                img[y0 + y * s + yy][x0 + (i * 6 + x) * s + xx] = black
        return img
    def circle():
        c, r2 = size // 2, (size // 3) ** 2
        return [[black if (x - c) ** 2 + (y - c) ** 2 <= r2 else white for x in range(size)] for y in range(size)]
    def triangle():
        top, bottom, c = size // 6, 5 * size // 6, size // 2
        return [[black if top <= y <= bottom and abs(x - c) <= (y - top) * 0.6 else white for x in range(size)] for y in range(size)]
    return [
        {"id": "solid-blue", "image": solid((20, 60, 220)), "question": "What single color fills this image? Answer in one word.", "accept": ["blue"]},
        {"id": "solid-yellow", "image": solid((245, 225, 20)), "question": "What single color fills this image? Answer in one word.", "accept": ["yellow"]},
        {"id": "word-tiger", "image": word("TIGER"), "question": "What word is printed in this image? Answer with the word only.", "accept": ["tiger"]},
        {"id": "shape-circle", "image": circle(), "question": "What shape is drawn in this image? Answer in one word.", "accept": ["circle"]},
        {"id": "shape-triangle", "image": triangle(), "question": "What shape is drawn in this image? Answer in one word.", "accept": ["triangle"]},
    ]


def run_vision(a, out_dir_prefix, tok):
    """Each image twice: through /v1/chat/completions, as an app would call it, and through /completion, which returns the
    raw reply whatever its header looks like. The right count is on the raw reply; chat_ok counts the chat endpoint's answers."""
    # llama-server draws a random media marker unless this pins it; /completion needs to know it.
    os.environ["LLAMA_MEDIA_MARKER"] = "<__media__>"
    cmd = [a.server, "-m", a.gguf, "--mmproj", a.mmproj, "--port", str(a.port), "--host", "127.0.0.1", "-ngl", "999", "-fa", "on", "-np", "1", "-c", "8192", "--no-webui"]
    server, load = start_server(cmd, a.port, out_dir_prefix + ".vision.server.log")
    bos = tok.bos_token or ""
    rows = []
    try:
        for it in vision_items():
            b64 = base64.b64encode(png(it["image"])).decode()
            row = {"id": it["id"], "question": it["question"], "accept": it["accept"]}
            body = {"messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}}, {"type": "text", "text": it["question"]}]}],
                "max_tokens": 1024, "temperature": 0, "top_k": 1, "chat_template_kwargs": {"reasoning_strength": a.strength}, "cache_prompt": False}
            try:
                r = post(a.port, "/v1/chat/completions", body, timeout=300)
                msg = r["choices"][0]["message"]
                row.update({"chat_ok": True, "chat_final": (msg.get("content") or "").strip(), "chat_reasoning": msg.get("reasoning_content") or ""})
            except urllib.error.HTTPError as e:
                row.update({"chat_ok": False, "chat_error": f"HTTP {e.code}: {e.read()[:200].decode(errors='replace')}"})
            except (urllib.error.URLError, KeyError, TimeoutError) as e:
                row.update({"chat_ok": False, "chat_error": repr(e)})
            text = tok.apply_chat_template([{"role": "system", "content": SYSTEM}, {"role": "user", "content": "<__media__>" + it["question"]}],
                                           tokenize=False, add_generation_prompt=True, reasoning_strength=a.strength)
            text = text.removeprefix(bos) if bos else text
            t0 = time.time()
            try:
                r = post(a.port, "/completion", {"prompt": {"prompt_string": text, "multimodal_data": [b64]}, "n_predict": 1024, "temperature": 0.0, "top_k": 1, "cache_prompt": False, "stream": False,
                                                 "return_tokens": True}, timeout=300)
                raw = tok.decode(r.get("tokens") or [], skip_special_tokens=False) or r.get("content", "")
                seen = analyze_raw(raw)
                row.update({"raw": raw, "final": seen["final_lenient"], "shape": seen["shape"], "header_first": seen["header_first"], "tokens": len(r.get("tokens") or []),
                            "seconds": round(time.time() - t0, 1), "right": any(re.search(rf"\b{w}\b", seen["final_lenient"], re.I) for w in it["accept"])})
            except (urllib.error.URLError, KeyError, TimeoutError) as e:
                row.update({"raw": "", "final": "", "right": False, "error": repr(e)})
            rows.append(row)
            print(f"VISION {a.label} {row['id']}: {row['final'][:80]!r} right={row['right']} chat_ok={row['chat_ok']} shape={row.get('shape')}", flush=True)
    finally:
        stop_server(server)
    return {"mmproj": a.mmproj, "server_load_seconds": load, "n": len(rows), "right": sum(r["right"] for r in rows), "chat_ok": sum(r["chat_ok"] for r in rows), "rows": rows}


# Summaries.

def wilson(k, n):
    if n == 0:
        return [0.0, 0.0]
    z, p = 1.96, k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [round((c - m) / d, 3), round((c + m) / d, 3)]


def rate(rows):
    graded = [r for r in rows if r.get("right") is not None]
    k = sum(bool(r["right"]) for r in graded)
    return {"n": len(graded), "right": k, "rate": round(k / max(1, len(graded)), 4), "ci95": wilson(k, len(graded))}


def pctl(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else 0


def summarize(rows):
    on = [r for r in rows if r["mode"] == "on"]
    off = [r for r in rows if r["mode"] == "off"]
    rt = [r["reasoning_tokens"] for r in on]
    ft = [r["final_tokens"] for r in on if r["reached_final"]]
    s = {
        "structure": {
            "n": len(on), "has_reasoning": sum(r["has_reasoning"] for r in on), "reached_final": sum(r["reached_final"] for r in on),
            "direct_to_final": sum(r["channels"][:1] == ["user"] for r in on), "hit_limit": sum(r["hit_limit"] for r in on), "looped": sum(r["looped"] for r in on),
            "reasoning_tokens_median": statistics.median(rt) if rt else 0, "reasoning_tokens_p90": pctl(rt, 0.9), "reasoning_tokens_mean": round(statistics.mean(rt), 1) if rt else 0,
            "final_tokens_median": statistics.median(ft) if ft else 0, "total_tokens_mean": round(statistics.mean(r["tokens"] for r in on), 1) if on else 0,
            "other_channels": sorted({c for r in on for c in r["channels"] if c not in ("self", "user")}),
        },
        "multistep": rate([r for r in on if r["part"] == "multistep"]),
        "multistep_answered": rate([r for r in on if r["part"] == "multistep" and r["reached_final"]]),
        "by_kind": {}, "by_steps": {}, "skills": {},
    }
    for k in ("arithmetic", "calendar", "units", "logic"):
        s["by_kind"][k] = rate([r for r in on if r["kind"] == k])
    for st in (2, 3, 4, 5):
        s["by_steps"][str(st)] = rate([r for r in on if r.get("steps") == st])
    s["hard"] = rate([r for r in on if r["part"] == "hard"])
    def lenient(rows_):
        rows_ = [r for r in rows_ if r.get("right_lenient") is not None]
        k = sum(bool(r["right_lenient"]) for r in rows_)
        return {"n": len(rows_), "right": k, "rate": round(k / max(1, len(rows_)), 4), "ci95": wilson(k, len(rows_))}
    words = [r["reasoning_words"] for r in on if "reasoning_words" in r]
    shapes = {}
    for r in on:
        shapes[r.get("shape", "?")] = shapes.get(r.get("shape", "?"), 0) + 1
    s["lenient"] = {"multistep": lenient([r for r in on if r["part"] == "multistep"]), "hard": lenient([r for r in on if r["part"] == "hard"]),
                    "skills": lenient([r for r in on if r["part"] == "skills"]), "by_skill": {k: lenient([r for r in on if r["kind"] == k]) for k in ("python", "json", "instructions", "multiturn")},
                    "by_kind": {k: lenient([r for r in on if r["kind"] == k]) for k in ("arithmetic", "calendar", "units", "logic")},
                    "reasoning_words_median": statistics.median(words) if words else 0, "reasoning_words_p90": pctl(words, 0.9), "shapes": shapes}
    s["hard_by"] = {}
    for sub in ("long_arith", "mod_power", "weekday_cold", "chain", "knights"):
        s["hard_by"][sub] = rate([r for r in on if r["part"] == "hard" and r.get("subkind") == sub])
    off_ids = {r["id"] for r in off}
    s["off40"] = {"off": rate(off), "on_same": rate([r for r in on if r["id"] in off_ids]),
                  "off_final_tokens_median": statistics.median([r["final_tokens"] for r in off]) if off else 0, "off_hit_limit": sum(r["hit_limit"] for r in off)}
    for k in ("python", "json", "instructions", "multiturn"):
        s["skills"][k] = rate([r for r in on if r["kind"] == k])
    s["skills"]["all"] = rate([r for r in on if r["part"] == "skills"])
    js = [r for r in on if r["kind"] == "json"]
    s["skills"]["json_fenced_ok"] = sum(bool(r.get("fenced_ok")) for r in js)
    return s


def regrade(rows, probes, allow_exec=False):
    """Stored replies graded again. Python verdicts stay as stored unless allow_exec (writer-1 only) lets the lenient text run."""
    changed = 0
    for r in rows:
        it = probes.get(r["id"])
        if not it:
            continue
        if it["kind"] != "python":
            g = grade_row(it, r["final"], False)
            changed += g["right"] != r.get("right")
            r.update(g)
        add_lenient(r, it, allow_exec)
    return changed


def discordance(a_rows, b_rows):
    """Paired on the same item and mode: right only in A, right only in B, and an exact two-sided sign test."""
    a = {(r["id"], r["mode"]): r for r in a_rows if r.get("right") is not None}
    b = {(r["id"], r["mode"]): r for r in b_rows if r.get("right") is not None}
    keys = sorted(set(a) & set(b))
    only_a = sum(bool(a[k]["right"]) and not b[k]["right"] for k in keys)
    only_b = sum(bool(b[k]["right"]) and not a[k]["right"] for k in keys)
    n = only_a + only_b
    p = min(1.0, 2 * sum(comb(n, i) for i in range(0, min(only_a, only_b) + 1)) / 2 ** n) if n else 1.0
    return {"pairs": len(keys), "both": sum(bool(a[k]["right"]) and bool(b[k]["right"]) for k in keys), "only_a": only_a, "only_b": only_b, "sign_p": round(p, 4)}


def print_table(paths, probes_path):
    probes = {}
    if os.path.exists(probes_path):
        with open(probes_path) as f:
            probes = {x["id"]: x for x in map(json.loads, filter(str.strip, f))}
    runs = []
    for p in paths:
        with open(p) as f:
            d = json.load(f)
        changed = regrade(d["rows"], probes)
        runs.append((d, summarize(d["rows"]), changed))
    def cell(r):
        return f"{r['right']}/{r['n']} {100 * r['rate']:.1f}%"
    def line(name, fn):
        return "| " + name + " | " + " | ".join(str(fn(s, d)) for d, s, _ in runs) + " |"
    head = "| | " + " | ".join(f"{d['label']} ({d.get('strength')})" for d, _, _ in runs) + " |"
    out = [head, "|---|" + "---|" * len(runs)]
    out.append(line("complete run", lambda s, d: f"{d.get('complete')} ({d.get('n_skipped', 0)} skipped)"))
    out.append(line("replies with reasoning on", lambda s, d: s["structure"]["n"]))
    out.append(line("reasoning channel appears", lambda s, d: s["structure"]["has_reasoning"]))
    out.append(line("reached a final answer", lambda s, d: s["structure"]["reached_final"]))
    shapes = sorted({k for _, s, _ in runs for k in s["lenient"]["shapes"]})
    for sh in shapes:
        out.append(line("shape: " + sh, lambda s, d, sh=sh: s["lenient"]["shapes"].get(sh, 0)))
    out.append(line("reasoning-like words, any header, median / p90", lambda s, d: f"{s['lenient']['reasoning_words_median']:.0f} / {s['lenient']['reasoning_words_p90']}"))
    out.append(line("chat endpoint would accept (shape, not called)", lambda s, d: f"{chat_counts(d['rows'])['all']}/{chat_counts(d['rows'])['n']}"))
    out.append(line("multi-step right and chat endpoint would accept", lambda s, d: f"{chat_counts(d['rows'])['multistep_right']}/{chat_counts(d['rows'])['multistep_n']}"))
    if any(d.get("channel") for d, _, _ in runs):
        for name, key in (('P("=self") after " to"', "p_self"), ('P(<|eom|>) closing reasoning', "p_eom"), ('P(<|eot|>) closing reasoning', "p_eot"), ('P("assistant") after <|start|>', "p_assistant"), ('P("=user") after the second " to"', "p_user")):
            out.append(line(name, lambda s, d, key=key: (d.get("channel") or {}).get(key, "not measured")))
    out.append(line("hit the 2,048 limit", lambda s, d: s["structure"]["hit_limit"]))
    out.append(line("looping at the end", lambda s, d: s["structure"]["looped"]))
    out.append(line("reasoning tokens, median / p90 / mean", lambda s, d: f"{s['structure']['reasoning_tokens_median']:.0f} / {s['structure']['reasoning_tokens_p90']} / {s['structure']['reasoning_tokens_mean']}"))
    out.append(line("final tokens, median", lambda s, d: f"{s['structure']['final_tokens_median']:.0f}"))
    out.append(line("**multi-step, reasoning on**", lambda s, d: cell(s["multistep"])))
    out.append(line("95% interval", lambda s, d: f"{100 * s['multistep']['ci95'][0]:.0f} to {100 * s['multistep']['ci95'][1]:.0f}%"))
    for k in ("arithmetic", "calendar", "units", "logic"):
        out.append(line(k, lambda s, d, k=k: cell(s["by_kind"][k])))
    for st in ("2", "3", "4", "5"):
        out.append(line(f"arithmetic {st} steps", lambda s, d, st=st: cell(s["by_steps"][st])))
    out.append(line("**multi-step, any header spelling**", lambda s, d: cell(s["lenient"]["multistep"])))
    for k in ("arithmetic", "calendar", "units", "logic"):
        out.append(line(k + ", any header", lambda s, d, k=k: cell(s["lenient"]["by_kind"][k])))
    out.append(line("**hard set, reasoning on**", lambda s, d: cell(s["hard"])))
    out.append(line("hard set, any header", lambda s, d: cell(s["lenient"]["hard"])))
    for sub in ("long_arith", "mod_power", "weekday_cold", "chain", "knights"):
        out.append(line("hard: " + sub, lambda s, d, sub=sub: cell(s["hard_by"][sub])))
    out.append(line("**the 40, reasoning off**", lambda s, d: cell(s["off40"]["off"])))
    out.append(line("the same 40, reasoning on", lambda s, d: cell(s["off40"]["on_same"])))
    out.append(line("off: final tokens median / hit limit", lambda s, d: f"{s['off40']['off_final_tokens_median']:.0f} / {s['off40']['off_hit_limit']}"))
    out.append(line("**all skills**", lambda s, d: cell(s["skills"]["all"])))
    for k in ("python", "json", "instructions", "multiturn"):
        out.append(line(k, lambda s, d, k=k: cell(s["skills"][k])))
    out.append(line("**all skills, any header**", lambda s, d: cell(s["lenient"]["skills"])))
    for k in ("python", "json", "instructions", "multiturn"):
        out.append(line(k + ", any header", lambda s, d, k=k: cell(s["lenient"]["by_skill"][k])))
    out.append(line("json right if a fence were allowed", lambda s, d: s["skills"]["json_fenced_ok"]))
    out.append(line("vision (5 images)", lambda s, d: f"{d['vision']['right']}/{d['vision']['n']}, chat endpoint answered {d['vision'].get('chat_ok', '?')}" if d.get("vision") else "not run"))
    out.append(line("tok/s all slots / wall s", lambda s, d: f"{d.get('aggregate_tokens_per_second')} / {d.get('score_seconds')}"))
    print("\n".join(out))
    if len(runs) > 1:
        print(f"\nPaired with {runs[0][0]['label']} ({runs[0][0].get('strength')}), same item and mode. a = right only there, b = right only in the other, sign_p = exact two-sided sign test.")
        first = runs[0][0]["rows"]
        for d, _, _ in runs[1:]:
            for name, flt in (("multistep on", lambda r: r["part"] == "multistep" and r["mode"] == "on"), ("hard", lambda r: r["part"] == "hard"), ("off", lambda r: r["mode"] == "off"), ("skills", lambda r: r["part"] == "skills")):
                x = discordance([r for r in first if flt(r)], [r for r in d["rows"] if flt(r)])
                print(f"  {d['label']} ({d.get('strength')}) {name}: {x}")
        for d, _, _ in runs[1:]:
            lens = lambda rows_: [{**r, "right": r.get("right_lenient")} for r in rows_ if r["mode"] == "on"]
            print(f"  {d['label']} ({d.get('strength')}) any header, all reasoning-on items: {discordance(lens(first), lens(d['rows']))}")
    if any(c for _, _, c in runs):
        print("Regrading changed verdicts:", [c for _, _, c in runs])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gguf")
    ap.add_argument("--label")
    ap.add_argument("--out")
    ap.add_argument("--tokenizer")
    ap.add_argument("--probes", default=os.path.join(HERE, "reasoning_probes.jsonl"))
    ap.add_argument("--strength", default="medium")
    ap.add_argument("--mmproj")
    ap.add_argument("--server", default=SERVER)
    ap.add_argument("--port", type=int, default=8094)
    ap.add_argument("--parallel", type=int, default=32)
    ap.add_argument("--slot-ctx", type=int, default=2600)
    ap.add_argument("--max-new-tokens", type=int, default=2048)
    ap.add_argument("--allow-code-exec", action="store_true")
    ap.add_argument("--deadline-epoch", type=float, default=0)
    ap.add_argument("--limit", type=int, default=0, help="only the first N items after shuffling, to look at replies before a full run")
    ap.add_argument("--no-off", action="store_true", help="skip the reasoning-off pass")
    ap.add_argument("--table", nargs="+")
    ap.add_argument("--regrade-lenient", nargs="+", help="add the any-header fields to stored runs and rewrite them; python text runs, so writer-1 only with --allow-code-exec")
    ap.add_argument("--prefill-reasoning", action="store_true", help="append the ' to=self<|message|>' header to the prompt, so a misspelled first header can't happen; implies --no-off")
    ap.add_argument("--vision-only", action="store_true", help="only the vision test (needs --mmproj)")
    a = ap.parse_args()
    if a.table:
        print_table(a.table, a.probes)
        return
    if a.regrade_lenient:
        with open(a.probes) as f:
            items = {x["id"]: x for x in map(json.loads, filter(str.strip, f))}
        for path in a.regrade_lenient:
            with open(path) as f:
                d = json.load(f)
            changed = regrade(d["rows"], items, a.allow_code_exec)
            d["summary"] = summarize(d["rows"])
            with open(path + ".tmp", "w") as f:
                json.dump(d, f, ensure_ascii=False, indent=1)
            os.replace(path + ".tmp", path)
            print(path, "rewritten; strict verdicts changed:", changed, flush=True)
        return
    missing = [n for n in ("gguf", "label", "out", "tokenizer") if not getattr(a, n)]
    if missing:
        ap.error("a scoring run needs " + ", ".join("--" + m for m in missing))

    # A kill by `timeout` must run the finally blocks that stop the server.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))

    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.tokenizer)

    with open(a.probes) as f:
        probes = [json.loads(line) for line in f if line.strip()]
    # A fixed order, the same for every model, so a run cut short still covers every kind and pairs with the others by id.
    order = probes[:]
    random.Random(7).shuffle(order)
    if a.limit:
        order = order[: a.limit]

    def ids_for(it, mode):
        return prompt_ids(tok, it, mode, a.strength, a.prefill_reasoning)

    if a.vision_only:
        if not a.mmproj:
            ap.error("--vision-only needs --mmproj")
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        vision = run_vision(a, a.out, tok)
        with open(a.out + ".tmp", "w") as f:
            json.dump({"label": a.label, "gguf": a.gguf, "strength": a.strength, "vision": vision}, f, ensure_ascii=False, indent=1)
        os.replace(a.out + ".tmp", a.out)
        return

    jobs = [(it, "off") for it in order if it.get("also_off") and not (a.no_off or a.prefill_reasoning)] + [(it, "on") for it in order]
    prompts = [ids_for(it, mode) for it, mode in jobs]
    longest = max(len(p) for p in prompts)
    if longest + a.max_new_tokens > a.slot_ctx:
        raise RuntimeError(f"a prompt has {longest} tokens; raise --slot-ctx")

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    cmd = [a.server, "-m", a.gguf, "--port", str(a.port), "--host", "127.0.0.1", "-ngl", "999", "-fa", "on",
           "-np", str(a.parallel), "-c", str(a.parallel * a.slot_ctx), "--no-webui", "--metrics"]
    partial = open(a.out + ".partial.jsonl", "w")
    lock = threading.Lock()
    done = [0]
    generated = [0]
    deadline = a.deadline_epoch or float("inf")

    prefill_ids = tok(PREFILL, add_special_tokens=False)["input_ids"]

    def ask(job):
        (it, mode), ids = job
        now = time.time()
        if now > deadline:
            return None
        timeout = 1500 if deadline == float("inf") else max(5, deadline + 120 - now)
        try:
            r = post(a.port, "/completion", {"prompt": ids, "n_predict": a.max_new_tokens, "temperature": 0.0, "top_k": 1, "return_tokens": True, "cache_prompt": False, "stream": False}, timeout)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            print(f"REASONING request failed for {it['id']} {mode}: {e!r}", flush=True)
            return None
        toks = r.get("tokens") or []
        full = toks
        if a.prefill_reasoning:
            # The header is in the prompt, not the reply; put it back so the reply reads and splits like any other.
            toks = prefill_ids + toks
        row = reply_row(it, mode, ids, toks, full, r.get("stop_type"), tok, a.allow_code_exec)
        with lock:
            done[0] += 1
            generated[0] += len(full)
            partial.write(json.dumps(row, ensure_ascii=False) + "\n")
            partial.flush()
            if done[0] % 25 == 0:
                print(f"REASONING {a.label} {done[0]}/{len(jobs)} {round(generated[0] / max(time.time() - t0, 1e-9), 1)} tok/s", flush=True)
        return row

    server, load_seconds = start_server(cmd, a.port, a.out + ".server.log")
    try:
        print(f"REASONING {a.label} {a.strength} server up in {load_seconds}s, {len(jobs)} requests, longest prompt {longest}", flush=True)
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=a.parallel) as pool:
            results = list(pool.map(ask, zip(jobs, prompts)))
        wall = time.time() - t0
        mem = gpu_mem_used_mib()
    finally:
        stop_server(server)

    rows = [r for r in results if r]
    out = {"label": a.label, "gguf": a.gguf, "bytes": os.path.getsize(a.gguf), "gb": round(os.path.getsize(a.gguf) / 1e9, 2), "strength": a.strength + (", header prefilled" if a.prefill_reasoning else ""), "prefill_reasoning": a.prefill_reasoning, "probes": os.path.abspath(a.probes),
           "max_new_tokens": a.max_new_tokens, "parallel": a.parallel, "complete": len(rows) == len(jobs), "n_requests": len(jobs), "n_skipped": len(jobs) - len(rows),
           "aggregate_tokens_per_second": round(generated[0] / max(wall, 1e-9), 1), "generated_tokens": generated[0], "score_seconds": round(wall, 1),
           "server_load_seconds": load_seconds, "gpu_mem_used_mib": mem, "server_cmd": " ".join(cmd), "summary": summarize(rows), "rows": rows}
    def save():
        with open(a.out + ".tmp", "w") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        os.replace(a.out + ".tmp", a.out)
    save()
    if a.mmproj and time.time() < deadline:
        # Saved first: a vision failure or a kill by `timeout` can't lose the main run.
        try:
            out["vision"] = run_vision(a, a.out, tok)
        except Exception as e:
            out["vision"] = {"n": 0, "right": 0, "chat_ok": 0, "rows": [], "error": repr(e)}
        save()
    print("REASONING " + json.dumps({"label": a.label, "strength": a.strength, "complete": out["complete"], "seconds": out["score_seconds"], "tok_s": out["aggregate_tokens_per_second"], **out["summary"]}), flush=True)


if __name__ == "__main__":
    main()
