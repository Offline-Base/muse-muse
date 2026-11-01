/**
 * The glimmer-quantize recipe (lib/train/recipes/quantize.ts) under python3, with no GPU, no network and no llama.cpp:
 * fake convert_hf_to_gguf.py, llama-quantize, llama-perplexity and llama-server scripts that write files starting
 * with the GGUF magic and print canned KL divergence and answers, a fake gguf-py that reads them, and fake Unsloth,
 * PEFT and torch modules for the merge child. It checks the pins (llama.cpp's tag and sha256s, Meta's revision and
 * files, tuned.jinja) against the platform's, the params allowlist, the early failures (disk, RAM, the clock, a
 * stand-in or a vision adapter), the pinned downloads, the converter venv's build lock, then run(ctx) end to end: the
 * merge on local disk with the cache's 4-bit model linked in, the tensor and shard checks, Meta's template in every
 * file, a build that fails its KL divergence left out, a failed channel or template check that publishes nothing, the
 * intermediates deleted as they finish, the upload with its small files, publish 0, and the deadline. Skipped when
 * python3 is missing.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/quantize.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ggufFileName, ggufParams, ggufSystemLine, META_REVISION, META_TEMPLATE_SHA256, TUNED_TEMPLATE_SHA256 } from "@/lib/train/hub-cards";
import { LOW_BIT_LEVEL, QUANT_LEVELS } from "@/lib/train/local-files";
import { LOW_BIT_KL_MAX, QUANT_CHANNEL_MIN, QUANT_KL_MAX } from "@/lib/train/logic";
import { QUANT_BASES } from "@/lib/train/quant-targets";
import { recipeById } from "@/lib/train/recipes";
import { GLIMMER_PY } from "@/lib/train/recipes/glimmer";
import { QUANT_PY } from "@/lib/train/recipes/quantize";
import { RUNNER_PY } from "@/lib/train/recipes/runner";
import { glimmerHelpers } from "@/lib/train/recipes/serve";

const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const FIXTURE = new URL("./fixtures/meta-chat-template.jinja", import.meta.url).pathname;
const ADAPTER = "83d71f74-d84b-40bf-925a-cd36c90b6de5";

/**
 * The Python every test starts with: quantize.py loaded as q, a fake ctx whose run() really runs the command (as the
 * runner's does: in work_dir, each line to on_line, a timeout), the fake tools in a bin folder, the fake Python
 * modules for the merge child, and stubs for what needs the network: the llama.cpp download, Meta's files and the
 * venvs.
 */
const QUANT_HARNESS = String.raw`import hashlib, importlib.util, json, os, shlex, shutil, subprocess, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("quantize", os.path.join(HERE, "quantize.py"))
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)
ROOT = tempfile.mkdtemp(dir=HERE)
ADAPTER = "83d71f74-d84b-40bf-925a-cd36c90b6de5"
PY = sys.executable
FAKES = os.path.join(HERE, "fakes")
BIN = os.path.join(FAKES, "bin")
SRC = os.path.join(FAKES, "src")
GGUF_PY = os.path.join(SRC, "gguf-py")
LOG = os.path.join(ROOT, "fake-log.jsonl")


class Done:
    def __init__(self, returncode=0, stdout="", timed_out=False):
        self.returncode = returncode
        self.stdout = stdout
        self.timed_out = timed_out


def logged():
    if not os.path.exists(LOG):
        return []
    with open(LOG) as f:
        return [json.loads(line) for line in f if line.strip()]


class FakeCtx:
    """What run(ctx) uses of the runner's ctx. run() runs the command for real; hub_upload reads the folder."""

    def __init__(self, params=None, deadline=None):
        self.job_id = "quant-job"
        self.work_dir = os.path.join(ROOT, "work")
        os.makedirs(self.work_dir, exist_ok=True)
        self.cache_dir = os.path.join(ROOT, "cache")
        os.makedirs(os.path.join(self.cache_dir, "models"), exist_ok=True)
        self.params = dict(params or {"adapterJobId": ADAPTER, "publish": 1, "levels": "Q3_K_M,Q4_K_M,Q6_K", "slug": "brief-writer", "trainChannel": 0})
        self.max_minutes = 110
        self.deadline = time.time() + 3 * 3600 if deadline is None else deadline
        self.logs, self.progresses, self.commands, self.uploads = [], [], [], []
        self.dataset_title = None
        self.title = "Muse Muse's brief writer"
        self.evals = [
            {"prompt": "App idea " + str(i) + ": count the gulls on the pier", "reference": ("A brief for idea " + str(i) + ". ") * 60, "tuned": "**Name:** Gull Counter " + str(i)}
            for i in range(10)
        ]
        self.train = [{"messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "Idea " + str(i)}, {"role": "assistant", "content": "A training brief. " * 60}]} for i in range(30)]
        self.hub_answer = None
        self.order = []

    def log(self, text):
        self.logs.append(str(text))

    def progress(self, step=None, total_steps=None, loss=None, message=None):
        self.progresses.append(message)

    def get_json(self, path):
        assert path == "/dataset?part=train&page=0", path
        system = "You are an assistant for this task: Write a short app brief."
        return {"items": [{"messages": [{"role": "system", "content": system}, {"role": "user", "content": "x"}, {"role": "assistant", "content": "y"}]}], "nextPage": None, "title": self.title}

    def dataset(self, part):
        if part == "train":
            return self.train
        assert part == "eval"
        return self.evals

    def run(self, cmd, timeout=None, check=False, env=None, on_line=None, on_event=None, stall_seconds=None):
        self.commands.append({"cmd": cmd, "env": env, "stall_seconds": stall_seconds, "timeout": timeout})
        words = shlex.split(cmd)
        tag = "merge" if "--merge" in words else "gguf-meta" if "--gguf-meta" in words else "convert" if any(w.endswith("convert_hf_to_gguf.py") for w in words) else os.path.basename(words[0])
        self.order.append(tag)
        full = dict(os.environ)
        full.update({str(k): str(v) for k, v in (env or {}).items()})
        try:
            out = subprocess.run(cmd, shell=True, cwd=self.work_dir, env=full, capture_output=True, text=True, timeout=timeout or 120)
            code, text, timed = out.returncode, out.stdout + out.stderr, False
        except subprocess.TimeoutExpired as e:
            code, text, timed = -9, str(e.stdout or ""), True
        for line in text.splitlines():
            if on_line:
                on_line(line)
        if check and code != 0:
            raise RuntimeError("Command failed (exit " + str(code) + "): " + cmd + "\n" + text[-2000:])
        return Done(code, "\n".join(text.splitlines()[-80:]), timed)

    def hub_upload(self, folder):
        self.order.append("hub_upload")
        names = sorted(os.listdir(folder))
        self.uploads.append({n: open(os.path.join(folder, n), "rb").read() for n in names})
        if self.hub_answer is not None:
            return self.hub_answer
        digests = {n: hashlib.sha256(open(os.path.join(folder, n), "rb").read()).hexdigest() for n in names}
        return {"uploaded": len([n for n in names if n.endswith(".gguf")]), "skipped": None, "failed": [], "repo": "muse-org/muse-glimmer-30b-brief-writer-gguf-83d71f74", "files": len(names), "bytes": 1, "sha256": digests}


def make_adapter(cache, config=None, weights=None):
    folder = os.path.join(cache, "models", ADAPTER)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "adapter_config.json"), "w") as f:
        json.dump(config if config is not None else {"base_model_name_or_path": q.MODEL, "revision": q.MODEL_REVISION, "r": 16, "target_modules": "(?:.*?(?:language|text).*?(?:self_attn|mlp).*?(?:q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj).*?)"}, f)
    names = weights if weights is not None else ["base_model.model.model.language_model.layers.0.self_attn.q_proj.lora_A.weight"]
    header = json.dumps({n: {"dtype": "BF16", "shape": [16, 64], "data_offsets": [0, 2048]} for n in names}).encode()
    with open(os.path.join(folder, "adapter_model.safetensors"), "wb") as f:
        f.write(len(header).to_bytes(8, "little") + header + b"\0" * 2048)
    return folder


# The fake merged checkpoint's tensors, and its 16-bit base's shards, which the parent checks against these pins.
TENSORS = {"model.language_model.layers.0.self_attn.q_proj.weight": [64, 32], "model.vision_tower.encoder.layers.0.mlp.fc1.weight": [8, 8], "lm_head.weight": [100, 32]}
q.BASE_TENSORS = len(TENSORS)
q.BASE_TENSORS_SHA256 = q.tensors_digest(TENSORS)
q.BASE_SHARDS = (("model-00001-of-00002.safetensors", "a" * 64), ("model-00002-of-00002.safetensors", "b" * 64))
META = os.path.join(HERE, "meta")
q.llamacpp_tools = lambda ctx, folder: {"bin": BIN, "convert": os.path.join(SRC, "convert_hf_to_gguf.py"), "gguf_py": GGUF_PY, "env": {"FAKE_LOG": LOG}}
q.meta_files = lambda ctx, folder: {name: os.path.join(META, name) for name, _ in q.META_FILES}
q.ensure_convert_venv = lambda ctx, base, started: (PY, True)
q.ensure_venv = lambda ctx, base: (os.path.join(BIN, "venv-python"), True)
REAL_MACHINE_PROBLEM = q.machine_problem
q.machine_problem = lambda work_dir, disk=None, ram=None: None
q.SERVER_START_SECONDS = 30


def fresh(params=None, deadline=None, env=None):
    """A new run's folders, its fake env (FAKE_* for the scripts) and its ctx with the adapter in the cache."""
    shutil.rmtree(ROOT, ignore_errors=True)
    os.makedirs(ROOT)
    os.environ.update({"FAKE_LOG": LOG, "FAKE_KLD": json.dumps({"Q3_K_M": [0.04, 0.3, 92.1], "Q4_K_M": [0.012, 0.11, 95.4], "Q6_K": [0.001, 0.01, 99.2]}), "FAKE_CHANNEL": "final", "FAKE_TEMPLATE_BUG": "", "FAKE_NO_GPU": "", "FAKE_MERGE": "good"})
    os.environ.update(env or {})
    ctx = FakeCtx(params, deadline)
    make_adapter(ctx.cache_dir)
    # The cache's 4-bit model, which the merge reads through a link from its local HF_HOME.
    os.makedirs(os.path.join(ctx.cache_dir, "hf", "hub", "models--" + q.MODEL.replace("/", "--"), "snapshots", q.MODEL_REVISION), exist_ok=True)
    return ctx


def raises(fn, text):
    try:
        fn()
    except (RuntimeError, ValueError) as e:
        assert text in str(e), str(e)
        return str(e)
    raise AssertionError("nothing raised " + text)
`;

/** The fake tools, gguf-py, converter and Python modules, as files under fakes/ (made executable where they run). */
const FAKE_FILES: Record<string, string> = {
  "fakes/gguf.py": String.raw`import json, os
MAGIC = b"GGUF\x03\x00\x00\x00"


def write(path, meta, size):
    body = MAGIC + json.dumps(meta).encode() + b"\0"
    with open(path, "wb") as f:
        f.write(body + b"\1" * max(0, size - len(body)))


def read(path):
    with open(path, "rb") as f:
        data = f.read(1 << 20)
    assert data.startswith(MAGIC), path
    return json.loads(data[len(MAGIC):data.index(b"\0", len(MAGIC))].decode())


def log(entry):
    with open(os.environ["FAKE_LOG"], "a") as f:
        f.write(json.dumps(entry) + "\n")
`,
  "fakes/src/convert_hf_to_gguf.py": String.raw`import argparse, json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from fakes import gguf
p = argparse.ArgumentParser()
p.add_argument("model")
p.add_argument("--outtype")
p.add_argument("--outfile")
p.add_argument("--model-name")
a = p.parse_args()
with open(os.path.join(a.model, "chat_template.jinja"), encoding="utf-8") as f:
    template = os.environ.get("FAKE_GGUF_TEMPLATE") or f.read()
with open(os.path.join(a.model, "tokenizer_config.json"), encoding="utf-8") as f:
    assert "chat_template" not in json.load(f), "a chat_template key would replace chat_template.jinja"
assert not os.path.exists(os.path.join(a.model, "chat_template.json"))
gguf.log({"tool": "convert", "outtype": a.outtype, "name": a.model_name})
gguf.write(a.outfile, {"general.architecture": os.environ.get("FAKE_ARCH", "muse-glimmer"), "tokenizer.chat_template": template, "tensors": int(os.environ.get("FAKE_GGUF_TENSORS", "731")), "level": "BF16"}, 4000)
print("INFO:hf-to-gguf:Model successfully exported to " + a.outfile)
`,
  "fakes/src/gguf-py/gguf/__init__.py": String.raw`import json


class Field:
    def __init__(self, value):
        self.value = value

    def contents(self):
        return self.value


class GGUFReader:
    def __init__(self, path):
        with open(path, "rb") as f:
            data = f.read(1 << 20)
        start = 8
        meta = json.loads(data[start:data.index(b"\0", start)].decode())
        self.meta = meta
        self.tensors = [None] * int(meta.get("tensors") or 0)

    def get_field(self, key):
        return Field(self.meta[key]) if key in self.meta else None
`,
  "fakes/bin/llama-quantize": String.raw`#!@PYTHON@
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from fakes import gguf
argv = sys.argv[1:]
matrix = None
if argv[0] == "--imatrix":
    matrix = argv[1]
    assert os.path.exists(matrix), "no importance matrix"
    argv = argv[2:]
src, dst, level = argv[:3]
# As llama.cpp b11669's src/llama-quant.cpp: IQ1_S throws without an importance matrix.
if level == "IQ1_S" and not matrix:
    print("this quantization requires an imatrix!")
    sys.exit(1)
meta = gguf.read(src)
meta["level"] = level
sizes = {"IQ1_S": 700, "Q8_0": 3000, "Q3_K_M": 1300, "Q4_K_M": 1600, "Q6_K": 2200}
gguf.log({"tool": "quantize", "level": level, "src": os.path.basename(src)})
gguf.write(dst, meta, sizes[level])
print("main: quantize time = 1.00 ms")
`,
  "fakes/bin/llama-imatrix": String.raw`#!@PYTHON@
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from fakes import gguf
args = sys.argv[1:]
text = open(args[args.index("-f") + 1], encoding="utf-8").read()
assert "--parse-special" in args and "--no-ppl" in args and args[args.index("--output-format") + 1] == "gguf", args
gguf.log({"tool": "imatrix", "level": gguf.read(args[args.index("-m") + 1])["level"], "text": text[:4000], "chars": len(text)})
if os.environ.get("FAKE_IMATRIX_FAIL"):
    print("failed to process")
    sys.exit(1)
with open(args[args.index("-o") + 1], "wb") as f:
    f.write(b"matrix")
`,
  "fakes/bin/llama-perplexity": String.raw`#!@PYTHON@
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from fakes import gguf
args = sys.argv[1:]
model = args[args.index("-m") + 1]
base = args[args.index("--kl-divergence-base") + 1]
level = gguf.read(model)["level"]
assert args[args.index("-c") + 1] == "512"
if "--kl-divergence" in args:
    assert os.path.exists(base), "no reference"
    mean, p99, top = json.loads(os.environ["FAKE_KLD"])[level]
    gguf.log({"tool": "kl", "level": level})
    print("chunk PPL ...")
    print("Mean    KLD: %10.6f ± %10.6f" % (mean, 0.0001))
    print("99.0%%   KLD: %10.6f" % p99)
    print("Same top p: %6.3f ± %5.3f %%" % (top, 0.1))
else:
    text = open(args[args.index("-f") + 1], encoding="utf-8").read()
    assert "<|" not in text, "plain text only"
    gguf.log({"tool": "kl-base", "level": level, "chars": len(text)})
    with open(base, "wb") as f:
        f.write(b"_logits_")
    print("Final estimate: PPL = 5.0000 +/- 0.1")
`,
  "fakes/bin/llama-server": String.raw`#!@PYTHON@
import http.server, json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from fakes import gguf
args = sys.argv[1:]
if "--list-devices" in args:
    print("Available devices:")
    print("  (none)" if os.environ.get("FAKE_NO_GPU") else "  CUDA0: NVIDIA A100-SXM4-40GB (40442 MiB, 39977 MiB free)")
    sys.exit(0)
model = args[args.index("-m") + 1]
port = int(args[args.index("--port") + 1])
tuned = args[args.index("--chat-template-file") + 1] if "--chat-template-file" in args else None
meta = gguf.read(model)
gguf.log({"tool": "server", "level": meta["level"], "args": args})
answered = {"n": 0}


def render(messages):
    if os.environ.get("FAKE_LLAMA"):
        # A Llama template writes today's date, so the check has to read past it.
        out = ""
        for m in messages:
            if m["role"] == "system":
                out += "<|start_header_id|>system<|end_header_id|>\n\nToday Date: 02 Nov 2026\n\n" + m["content"] + "<|eot_id|>"
            else:
                out += "<|start_header_id|>user<|end_header_id|>\n\n" + m["content"] + "<|eot_id|>"
        return out + "<|start_header_id|>assistant<|end_header_id|>\n\n"
    out = ""
    for m in messages:
        if m["role"] == "system":
            text = m["content"]
            line = "" if "reasoning strength" in text.lower() else "\n\nReasoning strength: high."
            tail = "" if os.environ.get("FAKE_TEMPLATE_BUG") else '\n\n# Valid recipients: "self", "user".'
            out += "<|start|>system<|message|>" + text + line + tail + "<|eot|>"
        else:
            out += "<|start|>user<|message|>" + m["content"] + "<|eot|>"
    return out + ("<|start|>assistant to=user<|message|>" if tuned else "<|start|>assistant")


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200, {"status": "ok"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])).decode())
        if self.path == "/apply-template":
            return self.reply(200, {"prompt": render(body["messages"])})
        gguf.log({"tool": "chat", "body": body})
        mode = os.environ.get("FAKE_CHANNEL", "final")
        if meta["level"] == "IQ1_S" and os.environ.get("FAKE_LOW_BIT"):
            mode = os.environ["FAKE_LOW_BIT"]
        prompt = body["messages"][-1]["content"]
        number = int(prompt.split(" ")[2].rstrip(":"))
        if mode == "thinking" or (mode.startswith("first:") and number >= int(mode.split(":")[1])):
            return self.reply(200, {"choices": [{"message": {"content": "", "reasoning_content": "Let me think"}, "finish_reason": "length"}]})
        return self.reply(200, {"choices": [{"message": {"content": "**Name:** Gull Counter " + str(number)}, "finish_reason": "stop"}]})


http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
`,
  "fakes/bin/venv-python": "#!/bin/sh\nPYTHONPATH=\"$(dirname \"$0\")/../mods\" exec @PYTHON@ \"$@\"\n",
  "fakes/mods/unsloth/__init__.py": String.raw`import json, os


class FakeTokenizer:
    bos_token = "<|begin_of_text|>"

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False, reasoning_strength=None):
        out = self.bos_token
        if os.environ.get("FAKE_LLAMA"):
            for m in messages:
                if m["role"] == "system":
                    out += "<|start_header_id|>system<|end_header_id|>\n\nToday Date: 01 Nov 2026\n\n" + m["content"] + "<|eot_id|>"
                else:
                    out += "<|start_header_id|>" + m["role"] + "<|end_header_id|>\n\n" + m["content"] + "<|eot_id|>"
            return out + ("<|start_header_id|>assistant<|end_header_id|>\n\n" if add_generation_prompt else "")
        for m in messages:
            if m["role"] == "system":
                out += "<|start|>system<|message|>" + m["content"] + "\n\nReasoning strength: " + (reasoning_strength or "high") + '.\n\n# Valid recipients: "self", "user".<|eot|>'
            elif m["role"] == "user":
                out += "<|start|>user<|message|>" + m["content"] + "<|eot|>"
            elif m["role"] == "assistant":
                out += "<|start|>assistant to=user<|message|>" + m["content"] + "<|eot|>"
        return out + ("<|start|>assistant" if add_generation_prompt else "")

    def save_pretrained(self, path):
        pass


def safetensors(path, tensors):
    header = json.dumps({n: {"dtype": "BF16", "shape": s, "data_offsets": [0, 0]} for n, s in tensors.items()}).encode()
    with open(path, "wb") as f:
        f.write(len(header).to_bytes(8, "little") + header)


class FakeConfig:
    _name_or_path = "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit"


class FakeModel:
    def __init__(self):
        self.adapter = None
        self.config = FakeConfig()

    def merge_and_unload(self):
        raise AssertionError("the 4-bit model is never merged in place")

    def save_pretrained_merged(self, save_directory, tokenizer, save_method="merged_16bit"):
        assert save_method == "merged_16bit", save_method
        # Unsloth resolves the 16-bit base from config._name_or_path; an nf4 name there would be refused.
        assert self.config._name_or_path == os.environ.get("FAKE_MERGE_BASE", "OfflineBase/Glimmer-30B-2026-Knowledge"), self.config._name_or_path
        hf = os.environ["HF_HOME"]
        cached = os.path.join(hf, "hub", "models--OfflineBase--Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit")
        with open(os.environ["FAKE_LOG"], "a") as f:
            f.write(json.dumps({"tool": "merge", "hf_home": hf, "linked": os.path.islink(cached), "adapter": self.adapter}) + "\n")
        mode = os.environ.get("FAKE_MERGE", "good")
        shards = (("model-00001-of-00002.safetensors", "a" * 64), ("model-00002-of-00002.safetensors", ("d" if mode == "badshard" else "b") * 64))
        os.makedirs(save_directory, exist_ok=True)
        if mode == "cache":
            # Copied from an HF cache under HF_HOME: snapshot links to blobs named by their SHA-256.
            snap = os.path.join(hf, "hub", "models--OfflineBase--Glimmer-30B-2026-Knowledge", "snapshots", "c" * 40)
            blobs = os.path.join(hf, "hub", "models--OfflineBase--Glimmer-30B-2026-Knowledge", "blobs")
            os.makedirs(snap, exist_ok=True)
            os.makedirs(blobs, exist_ok=True)
            for name, sha in shards:
                open(os.path.join(blobs, sha), "wb").write(b"x" * 10)
                os.symlink(os.path.join("..", "..", "blobs", sha), os.path.join(snap, name))
        elif mode != "norecord":
            # As Unsloth downloads them, snapshot_download(local_dir=save_directory): the shards land in the merged folder
            # itself, and huggingface_hub keeps each one's commit, etag (an LFS file's SHA-256) and time beside them.
            record = os.path.join(save_directory, ".cache", "huggingface", "download")
            os.makedirs(record, exist_ok=True)
            for name, sha in shards:
                with open(os.path.join(record, name + ".metadata"), "w") as f:
                    f.write("c" * 40 + "\n" + sha + "\n1793145600.0\n")
        tensors = {"model.language_model.layers.0.self_attn.q_proj.weight": [64, 32], "model.vision_tower.encoder.layers.0.mlp.fc1.weight": [8, 8], "lm_head.weight": [100, 32]}
        if mode == "lora":
            tensors["model.language_model.layers.0.self_attn.q_proj.lora_A.weight"] = [16, 32]
        safetensors(os.path.join(save_directory, "model-00001-of-00002.safetensors"), tensors)
        with open(os.path.join(save_directory, "tokenizer_config.json"), "w") as f:
            json.dump({"chat_template": "Unsloth's older template"}, f)
        with open(os.path.join(save_directory, "chat_template.json"), "w") as f:
            json.dump({"chat_template": "Unsloth's older template"}, f)


class FastLanguageModel:
    @staticmethod
    def from_pretrained(model_name, revision=None, max_seq_length=None, use_exact_model_name=False, load_in_4bit=True):
        assert model_name == "unsloth/Llama-3.2-3B-Instruct-bnb-4bit" and revision and use_exact_model_name and load_in_4bit is False, (model_name, revision)
        return FakeModel(), FakeTokenizer()


class FastModel:
    @staticmethod
    def from_pretrained(model_name, revision=None, max_seq_length=None, offload_layers=None):
        assert model_name == "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit" and revision, (model_name, revision)
        return FakeModel(), FakeTokenizer()
`,
  "fakes/mods/unsloth/save.py": String.raw`def unsloth_generic_save_pretrained_merged(self, save_directory, tokenizer, save_method="merged_16bit"):
    return self.save_pretrained_merged(save_directory, tokenizer, save_method=save_method)
`,
  "fakes/mods/peft/__init__.py": String.raw`class PeftModel:
    @staticmethod
    def from_pretrained(model, path, is_trainable=True):
        assert is_trainable is False
        model.adapter = path
        return model
`,
  "fakes/mods/torch/__init__.py": String.raw`class cuda:
    @staticmethod
    def get_device_name(i):
        return "Fake GPU"
`,
  "fakes/__init__.py": "",
};

/** Runs a quantize test: the harness, then body, under python3 -I next to quantize.py, the fakes and Meta's files. */
async function quantTest(body: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-quant-"));
  try {
    await writeFile(path.join(dir, "quantize.py"), QUANT_PY);
    const { mkdir, chmod } = await import("node:fs/promises");
    for (const [name, content] of Object.entries(FAKE_FILES)) {
      const file = path.join(dir, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content.replaceAll("@PYTHON@", pythonPath()));
      if (name.startsWith("fakes/bin/")) await chmod(file, 0o755);
    }
    await mkdir(path.join(dir, "meta"), { recursive: true });
    await writeFile(path.join(dir, "meta", "chat_template.jinja"), await readFile(FIXTURE));
    await writeFile(path.join(dir, "meta", "tokenizer_config.json"), JSON.stringify({ bos_token: "<|begin_of_text|>", tokenizer_class: "TokenizersBackend" }));
    for (const name of ["tokenizer.json", "processor_config.json", "generation_config.json"]) await writeFile(path.join(dir, "meta", name), "{}");
    await writeFile(path.join(dir, "test.py"), `${QUANT_HARNESS}\n${body}\nprint("ok")\n`);
    const out = spawnSync("python3", ["-I", "test.py"], { cwd: dir, encoding: "utf8", timeout: 120_000, env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
    assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
    assert.match(out.stdout, /ok\n$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let python = "";
function pythonPath(): string {
  if (!python) python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
  return python;
}

const SMALL_PARAMS = { quantBase: "llama-3.2-3b" };
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const pyConst = (name: string) => new RegExp(`^${name} = (.+)$`, "m").exec(QUANT_PY)?.[1];

describe("the glimmer-quantize recipe's source", { skip: hasPython ? false : "python3 is missing" }, () => {
  it("compiles, is built on glimmer-lora's helpers unchanged, and is registered with its GPUs, defaults and params", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "muse-quant-compile-"));
    try {
      await writeFile(path.join(dir, "quantize.py"), QUANT_PY);
      const out = spawnSync("python3", ["-m", "py_compile", path.join(dir, "quantize.py")], { encoding: "utf8" });
      assert.equal(out.status, 0, out.stderr);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    assert.ok(QUANT_PY.includes(glimmerHelpers(GLIMMER_PY)), "every glimmer helper, unchanged");
    assert.ok(QUANT_PY.startsWith('"""Muse Glimmer quantize:'));
    assert.equal(QUANT_PY.match(/^if __name__ == "__main__":$/gm)?.length, 1, "only its own __main__");
    assert.ok(!QUANT_PY.includes("${") && !QUANT_PY.includes("`") && !QUANT_PY.includes(String.fromCharCode(0x2014)), "no template literal syntax or em dash");
    // The merge is Unsloth's 16-bit one: never a 4-bit merge, never PEFT's merge of the 4-bit model in place.
    assert.ok(QUANT_PY.includes('save_method="merged_16bit"'));
    assert.ok(!QUANT_PY.includes("merged_4bit") && !/\.merge_and_unload\(/.test(QUANT_PY));

    const recipe = recipeById("glimmer-quantize");
    assert.ok(recipe);
    assert.equal(recipe.script, QUANT_PY);
    assert.equal(recipe.usesCache, true);
    assert.deepEqual(recipe.gpus.map((g) => g.instanceType), ["gpu_1x_a100_sxm4", "gpu_1x_a100", "gpu_1x_a10"]);
    assert.deepEqual([recipe.defaultMaxMinutes, recipe.defaultMaxUsd], [110, 3.7]);
    assert.deepEqual(
      recipe.params.map((f) => [f.key, f.kind, f.required ?? false, f.default, f.min, f.max]),
      [
        ["adapterJobId", "adapter", true, undefined, undefined, undefined],
        ["publish", "number", false, 1, 0, 1],
      ],
      "levels, slug and trainChannel are the platform's, never a field",
    );
    // $3.70 never stops a 110-minute job before its time limit on an A100 SXM4 ($1.99 an hour).
    assert.ok((recipe.defaultMaxUsd * 100 * 60) / 199 >= recipe.defaultMaxMinutes);
  });

  it("pins llama.cpp, Meta's files and tuned.jinja as the platform does, and checks the files against the platform's numbers", async () => {
    assert.equal(pyConst("LLAMACPP_TAG"), '"b11669"');
    assert.ok(Number(/b(\d+)/.exec(pyConst("LLAMACPP_TAG")!)![1]) >= 10353, "at or after the first build that knows Muse Glimmer");
    for (const [asset, digest] of [
      ["llama-b11669-bin-ubuntu-cuda-12.8-x64.tar.gz", "4703ed1a3cd6e8504affb6cb9866f501e96d634d68a002dc9a8251c9e2819b49"],
      ["cudart-llama-b11669-bin-ubuntu-cuda-12.8-x64.tar.gz", "ab3eda89a82096bcba00b6448218c3c11eec2016b0f38d64884dc29736549f26"],
      ["https://github.com/ggml-org/llama.cpp/archive/refs/tags/b11669.tar.gz", "e06ba4fa263e30fdb9f0e65f00a8965202ddaa0c51f548a67e1f9b2164d04efc"],
    ]) {
      assert.ok(QUANT_PY.includes(`"${asset}", "${digest}"`), asset);
    }
    assert.equal(pyConst("META_REVISION"), JSON.stringify(META_REVISION));
    assert.equal(pyConst("TUNED_TEMPLATE_SHA256"), JSON.stringify(TUNED_TEMPLATE_SHA256));
    assert.ok(QUANT_PY.includes(`("chat_template.jinja", "${META_TEMPLATE_SHA256}")`));
    const meta = await readFile(FIXTURE, "utf8");
    assert.equal(sha256(meta), META_TEMPLATE_SHA256, "the fixture is Meta's template at the pinned revision");
    assert.equal(pyConst("QUANT_LEVELS"), `(${QUANT_LEVELS.map((l) => JSON.stringify(l)).join(", ")})`);
    assert.equal(pyConst("QUANT_KL_MAX"), `{${Object.entries(QUANT_KL_MAX).map(([k, v]) => `"${k}": ${v}`).join(", ")}}`);
    assert.equal(pyConst("QUANT_CHANNEL_MIN"), String(QUANT_CHANNEL_MIN));
    // The converter's own venv names an exact version of each package it installs.
    const install = /^CONVERT_INSTALL = \(\n([\s\S]*?)\n\)$/m.exec(QUANT_PY)?.[1] ?? "";
    const packages = [...install.matchAll(/"([^"]+)"/g)].flatMap((m) => m[1]!.split(" ").filter((w) => w && !w.startsWith("-") && !w.startsWith("http")));
    assert.deepEqual(packages.map((p) => p.split("==")[0]), ["torch", "numpy", "sentencepiece", "transformers", "protobuf", "tqdm", "pyyaml", "requests"]);
    for (const pkg of packages) assert.match(pkg, /^[a-z_]+==[\w.+]+$/, pkg);
    // runner.py's GGUF rule takes exactly the platform's file names.
    const re = new RegExp(/^HUB_GGUF_RE = re\.compile\(r"(.+)"\)$/m.exec(RUNNER_PY)![1]!);
    for (const level of QUANT_LEVELS) assert.ok(re.test(`muse-glimmer-30b-brief-writer-${level}.gguf`), level);
    for (const bad of ["muse-glimmer-30b-brief-writer-Q8_0.gguf", "muse-glimmer-30b-brief-writer-BF16.gguf", "muse-glimmer-30b--Q4_K_M.gguf", "x.gguf"]) {
      assert.ok(!re.test(bad), bad);
    }
  });

  it("makes tuned.jinja from Meta's template, and the system and params files byte for byte as the platform checks them", async () => {
    const expect = { system: ggufSystemLine("You are Muse Muse's brief writer."), params0: ggufParams(0), params1: ggufParams(1) };
    await quantTest(String.raw`
expect = json.loads(${JSON.stringify(JSON.stringify(expect))})
meta = open(os.path.join(META, "chat_template.jinja"), encoding="utf-8").read()
tuned = q.tuned_template(meta)
assert hashlib.sha256(tuned.encode()).hexdigest() == q.TUNED_TEMPLATE_SHA256
assert "else 'low' -%}" in tuned and "{{- '<|start|>assistant to=user<|message|>' -}}" in tuned
assert tuned.count("<|start|>assistant to=user<|message|>") == 1
raises(lambda: q.tuned_template(meta.replace("else 'high' -%}", "")), "exactly one")
raises(lambda: q.tuned_template(meta + "\n{# a change upstream #}\n"), "not the pinned")
assert q.system_line("You are Muse Muse's brief writer.") == expect["system"]
assert q.params_file(0) == expect["params0"] and q.params_file(1) == expect["params1"]
assert q.gguf_name("brief-writer", "Q4_K_M") == "muse-glimmer-30b-brief-writer-Q4_K_M.gguf"
`);
  });

  it("takes only the platform's levels, slug and channel, and Q4_K_M must be among the levels", async () => {
    await quantTest(String.raw`
good = {"adapterJobId": ADAPTER.upper(), "levels": "Q6_K, Q3_K_M,Q4_K_M", "slug": "brief-writer", "trainChannel": 1}
p = q.read_quant_params(good)
assert p == {"adapter_job_id": ADAPTER, "levels": ["Q3_K_M", "Q4_K_M", "Q6_K"], "slug": "brief-writer", "train_channel": 1, "publish": True}, p
assert q.read_quant_params(dict(good, publish=0))["publish"] is False
raises(lambda: q.read_quant_params(dict(good, adapterJobId="../x")), "adapterJobId")
raises(lambda: q.read_quant_params(dict(good, levels="Q4_K_M,Q8_0")), "levels must name builds")
raises(lambda: q.read_quant_params(dict(good, levels="")), "levels must name builds")
raises(lambda: q.read_quant_params(dict(good, levels="Q3_K_M,Q6_K")), "must include Q4_K_M")
raises(lambda: q.read_quant_params(dict(good, slug="Brief Writer")), "slug")
raises(lambda: q.read_quant_params(dict(good, slug="a" * 41)), "slug")
raises(lambda: q.read_quant_params(dict(good, trainChannel=2)), "trainChannel")
`);
  });

  it("fails in seconds without an adapter, with a stand-in or one that reaches the vision tower, without the disk, RAM or time", async () => {
    await quantTest(String.raw`
ctx = fresh()
folder = os.path.join(ctx.cache_dir, "models", ADAPTER)
assert q.quant_adapter_problem(folder, ADAPTER) is None
assert "saved none in this region" in q.quant_adapter_problem(os.path.join(ctx.cache_dir, "models", "x"), "x")
make_adapter(ctx.cache_dir, {"dry_run": True})
assert "stand-in" in q.quant_adapter_problem(folder, ADAPTER)
make_adapter(ctx.cache_dir, {"target_modules": ["q_proj", "vision_tower.fc1"]})
assert "vision tower" in q.quant_adapter_problem(folder, ADAPTER)
make_adapter(ctx.cache_dir, {"target_modules": ".*(q_proj|fc1)"})
assert "vision tower" in q.quant_adapter_problem(folder, ADAPTER), "a regex that matches a vision module"
make_adapter(ctx.cache_dir, None, ["base_model.model.model.vision_tower.encoder.layers.0.mlp.fc1.lora_A.weight"])
assert "weights for the vision tower" in q.quant_adapter_problem(folder, ADAPTER)
os.remove(os.path.join(folder, "adapter_model.safetensors"))
assert "has no adapter_model.safetensors" in q.quant_adapter_problem(folder, ADAPTER)

assert "local disk" in REAL_MACHINE_PROBLEM(ctx.work_dir, disk=299 * 10 ** 9, ram=220 * 1024 ** 3)
assert "GiB of RAM" in REAL_MACHINE_PROBLEM(ctx.work_dir, disk=500 * 10 ** 9, ram=100 * 1024 ** 3)
assert REAL_MACHINE_PROBLEM(ctx.work_dir, disk=500 * 10 ** 9, ram=220 * 1024 ** 3) is None

ctx = fresh()
ctx.cache_dir = None
raises(lambda: q.run(ctx), "model cache isn't mounted")
ctx = fresh()
make_adapter(ctx.cache_dir, {"dry_run": True})
raises(lambda: q.run(ctx), "stand-in")
ctx = fresh(deadline=time.time() + 30 * 60)
raises(lambda: q.run(ctx), "too few to merge the adapter")
q.machine_problem = lambda work_dir, disk=None, ram=None: "Only 120 GB of local disk is free"
raises(lambda: q.run(fresh()), "Only 120 GB")
q.machine_problem = lambda work_dir, disk=None, ram=None: None
ctx = fresh()
ctx.evals = ctx.evals[:1]
raises(lambda: q.run(ctx), "holds out too little")
assert ctx.commands == [], "nothing ran"
`);
  });

  it("keeps a download only when its sha256 is the pinned one, and unpacks nothing outside its folder", async () => {
    await quantTest(String.raw`
import io, tarfile
src = os.path.join(ROOT, "served")
os.makedirs(src, exist_ok=True)


def tarball(path, members):
    with tarfile.open(path, "w:gz") as tar:
        for name, data, link in members:
            info = tarfile.TarInfo(name)
            if link:
                info.type = tarfile.SYMTYPE
                info.linkname = link
                tar.addfile(info)
            else:
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))


good = os.path.join(src, "good.tar.gz")
tarball(good, [("llama-b11669/llama-server", b"#!fake", None), ("llama-b11669/libggml.so", b"", "libggml.so.0"), ("llama-b11669/libggml.so.0", b"lib", None)])
q.fetch = lambda url, path, tries=3: shutil.copyfile(good if "good" in url else url, path)
digest = q.sha256_of(good)
dest = os.path.join(ROOT, "dl")
os.makedirs(dest, exist_ok=True)
assert q.pinned_fetch("good", digest, os.path.join(dest, "a.tar.gz"), "the build") == os.path.join(dest, "a.tar.gz")
raises(lambda: q.pinned_fetch("good", "0" * 64, os.path.join(dest, "b.tar.gz"), "the build"), "not the pinned " + "0" * 64)
assert not os.path.exists(os.path.join(dest, "b.tar.gz")), "a download that doesn't match isn't kept"
top = q.unpack(os.path.join(dest, "a.tar.gz"), os.path.join(dest, "out"), "llama-b11669")
assert os.path.isfile(os.path.join(top, "llama-server")) and os.path.islink(os.path.join(top, "libggml.so"))
evil = os.path.join(src, "evil.tar.gz")
tarball(evil, [("llama-b11669/ok", b"x", None), ("../escape", b"x", None)])
raises(lambda: q.unpack(evil, os.path.join(dest, "evil"), "llama-b11669"), "outside llama-b11669")
tarball(evil, [("llama-b11669/link", b"", "/etc/passwd")])
raises(lambda: q.unpack(evil, os.path.join(dest, "evil2"), "llama-b11669"), "link out of its folder")
source = os.path.join(src, "source.tar.gz")
tarball(source, [("llama.cpp-b11669/convert_hf_to_gguf.py", b"x", None), ("llama.cpp-b11669/gguf-py/gguf/__init__.py", b"x", None), ("llama.cpp-b11669/ggml/src/big.c", b"x", None)])
src_top = q.unpack(source, os.path.join(dest, "src"), "llama.cpp-b11669", q.LLAMACPP_SOURCE_PARTS)
assert os.path.isfile(os.path.join(src_top, "convert_hf_to_gguf.py")) and os.path.isfile(os.path.join(src_top, "gguf-py", "gguf", "__init__.py"))
assert not os.path.exists(os.path.join(src_top, "ggml")), "only the converter and gguf-py"

# The whole download: every asset checked, the CUDA runtime next to the build in LD_LIBRARY_PATH.
build = os.path.join(src, "build.tar.gz")
tarball(build, [("llama-b11669/llama-server", b"#!fake", None)])
runtime = os.path.join(src, "cudart.tar.gz")
tarball(runtime, [("cudart-llama-b11669-bin-ubuntu-cuda-12.8-x64/libcudart.so.12", b"lib", None)])
served = {q.LLAMACPP_BUILD[0]: build, q.LLAMACPP_CUDART[0]: runtime, q.LLAMACPP_SOURCE[0]: source}
q.fetch = lambda url, path, tries=3: shutil.copyfile(served[url.rsplit("/", 1)[-1]] if url.rsplit("/", 1)[-1] in served else served[url], path)
real = importlib.util.module_from_spec(spec)
spec.loader.exec_module(real)
real.fetch = q.fetch
real.LLAMACPP_BUILD = (q.LLAMACPP_BUILD[0], q.sha256_of(build), "llama-b11669")
real.LLAMACPP_CUDART = (q.LLAMACPP_CUDART[0], q.sha256_of(runtime), q.LLAMACPP_CUDART[2])
real.LLAMACPP_SOURCE = (q.LLAMACPP_SOURCE[0], q.sha256_of(source), "llama.cpp-b11669")
ctx = FakeCtx()
tools = real.llamacpp_tools(ctx, os.path.join(ROOT, "llamacpp"))
assert os.path.isfile(os.path.join(tools["bin"], "llama-server")) and os.path.isfile(tools["convert"])
assert tools["env"]["LD_LIBRARY_PATH"].split(":")[:2] == [tools["bin"], os.path.join(ROOT, "llamacpp", "cudart", q.LLAMACPP_CUDART[2])]
assert not [n for n in os.listdir(os.path.join(ROOT, "llamacpp")) if n.endswith(".tar.gz")], "the archives go once unpacked"
real.LLAMACPP_CUDART = (q.LLAMACPP_CUDART[0], "f" * 64, q.LLAMACPP_CUDART[2])
raises(lambda: real.llamacpp_tools(ctx, os.path.join(ROOT, "llamacpp2")), "not the pinned " + "f" * 64)
`);
  });

  it("builds the converter's venv once a region, holding its lock, while another job waits and reuses it", async () => {
    await quantTest(String.raw`
real = importlib.util.module_from_spec(spec)
spec.loader.exec_module(real)
real.uv_binary = lambda ctx, base: "/fake/uv"
real.LOCK_POLL_SECONDS = 0.05
base = os.path.join(ROOT, "cache2")
name = "llamacpp-" + hashlib.sha256("\n".join((real.PYTHON, real.UV_VERSION) + real.CONVERT_INSTALL).encode()).hexdigest()[:12]
venv = os.path.join(base, "venvs", name)


def builder(ctx):
    def run(cmd, timeout=None, check=False, env=None, on_line=None, on_event=None, stall_seconds=None):
        ctx.commands.append({"cmd": cmd, "stall_seconds": stall_seconds})
        words = shlex.split(cmd)
        if words[1:2] == ["venv"]:
            os.makedirs(os.path.join(words[-1], "bin"), exist_ok=True)
            open(os.path.join(words[-1], "bin", "python"), "w").write("")
        if "-c" in words:
            return Done(stdout=real.CONVERT_READY_LINE + "\n")
        return Done()
    return run


ctx = FakeCtx()
ctx.run = builder(ctx)
python, reused = real.ensure_convert_venv(ctx, base, time.time())
assert python == os.path.join(venv, "bin", "python") and reused is False
assert os.path.isfile(os.path.join(venv, real.READY_MARKER)) and not os.path.exists(venv + ".lock")
cmds = [c["cmd"] for c in ctx.commands]
assert "venv --relocatable --python-preference only-managed --python 3.12" in cmds[0]
assert "torch==2.11.0+cpu --index-url https://download.pytorch.org/whl/cpu" in cmds[1] and "transformers==4.57.6" in cmds[2]
assert all(c["stall_seconds"] == real.STALL_SECONDS for c in ctx.commands), "every build step is watched"
again = FakeCtx()
again.run = builder(again)
assert real.ensure_convert_venv(again, base, time.time()) == (python, True) and again.commands == [], "the next job reuses it"

# A job holding the lock: the other waits, then reuses what it built.
shutil.rmtree(venv)
os.makedirs(venv + ".lock")
waiter = FakeCtx()
waiter.run = builder(waiter)
out = {}
t = threading.Thread(target=lambda: out.update(r=real.ensure_convert_venv(waiter, base, time.time())))
t.start()
time.sleep(0.3)
os.makedirs(os.path.join(venv, "bin"))
open(os.path.join(venv, "bin", "python"), "w").write("")
open(os.path.join(venv, real.READY_MARKER), "w").write("{}")
t.join(5)
assert out["r"] == (python, True) and waiter.commands == []
assert "Waiting for another job in the region to finish installing llama.cpp's converter" in waiter.progresses
# A broken build leaves nothing behind.
shutil.rmtree(venv)
shutil.rmtree(venv + ".lock")
bad = FakeCtx()
bad.run = lambda cmd, **kw: Done(stdout="MUSE_CONVERT transformers=5.0.0\n") if " -c " in cmd else builder(bad)(cmd, **kw)
raises(lambda: real.ensure_convert_venv(bad, base, time.time()), "doesn't have " + real.CONVERT_READY_LINE)
assert not os.path.exists(venv) and not [n for n in os.listdir(os.path.dirname(venv)) if ".building-" in n or n.endswith(".lock")]
`);
  });
});

describe("the glimmer-quantize recipe, run(ctx) with fake tools", { skip: hasPython ? false : "python3 is missing", timeout: 240_000 }, () => {
  it("merges on local disk, makes and checks every build, deletes what it's done with, and uploads the ones that pass", async () => {
    await quantTest(String.raw`
ctx = fresh()
metrics = q.run(ctx)
log = logged()
merge = [e for e in log if e["tool"] == "merge"][0]
assert merge["hf_home"] == os.path.join(ctx.work_dir, "hf") and merge["linked"] is True, "the 16-bit base downloads to local disk, the 4-bit model is the cache's"
assert merge["adapter"] == os.path.join(ctx.cache_dir, "models", ADAPTER)
assert [e["level"] for e in log if e["tool"] == "quantize"] == ["Q8_0", "Q3_K_M", "Q4_K_M", "Q6_K"]
assert all(e["src"] == "bf16.gguf" for e in log if e["tool"] == "quantize"), "each build from the BF16 file"
assert [e["level"] for e in log if e["tool"] == "kl-base"] == ["Q8_0"] and [e["level"] for e in log if e["tool"] == "kl"] == ["Q3_K_M", "Q4_K_M", "Q6_K"]
server = [e for e in log if e["tool"] == "server"][0]
assert server["level"] == "Q4_K_M"
for flag in ("--jinja", "--no-mmproj", "--chat-template-file", "--skip-chat-parsing"):
    assert flag in server["args"], flag
chats = [e["body"] for e in log if e["tool"] == "chat"]
assert len(chats) == 10 and all(c["temperature"] == 0 and c["max_tokens"] == 1024 and c["stop"] == ["<|eom|>", "<|start|>"] for c in chats)
assert all(c["messages"][0] == {"role": "system", "content": "You are Muse Muse's brief writer.\n\nReasoning strength: low."} for c in chats)

for level, mean in (("q3_k_m", 0.04), ("q4_k_m", 0.012), ("q6_k", 0.001)):
    assert metrics[level + "_passed"] == "yes" and metrics[level + "_kl_mean"] == mean, (level, metrics)
assert metrics["q4_k_m_top_token_pct"] == 95.4 and metrics["q4_k_m_kl_p99"] == 0.11
assert (metrics["channel_final"], metrics["channel_total"], metrics["channel_passed"]) == (10, 10, "yes")
assert (metrics["agreement"], metrics["agreement_total"]) == (10, 10)
assert metrics["template_check"] == "passed" and metrics["checks_passed"] == "yes" and metrics["hub_uploaded"] == "yes"
assert metrics["system"] == "You are Muse Muse's brief writer." and metrics["train_channel"] == 0 and metrics["tuned_template"] == "yes"
assert metrics["llamacpp"] == "b11669" and metrics["gpu"] == "NVIDIA A100-SXM4-40GB" and metrics["merge_base_revision"] == "c" * 40
assert metrics["published_levels"] == "Q3_K_M,Q4_K_M,Q6_K" and metrics["tensors"] == len(TENSORS)
assert len([k for k in metrics if k != "summary"]) <= 48, "under the 50 metrics a done callback keeps"

sent = ctx.uploads[0]
assert sorted(sent) == ["muse-glimmer-30b-brief-writer-Q3_K_M.gguf", "muse-glimmer-30b-brief-writer-Q4_K_M.gguf", "muse-glimmer-30b-brief-writer-Q6_K.gguf", "params", "system", "tuned.jinja"]
assert sent["system"] == b"You are Muse Muse's brief writer.\n\nReasoning strength: low."
assert hashlib.sha256(sent["tuned.jinja"]).hexdigest() == q.TUNED_TEMPLATE_SHA256
for level in ("Q3_K_M", "Q4_K_M", "Q6_K"):
    data = sent["muse-glimmer-30b-brief-writer-" + level + ".gguf"]
    assert data.startswith(b"GGUF") and metrics[level.lower() + "_bytes"] == len(data)
    assert metrics[level.lower() + "_sha256"] == hashlib.sha256(data).hexdigest()
    assert json.loads(data[8:data.index(b"\0", 8)])["tokenizer.chat_template"] == open(os.path.join(META, "chat_template.jinja"), encoding="utf-8").read(), "Meta's template in every file"

# Every intermediate is gone, and the cache keeps only what it had.
left = sorted(os.listdir(ctx.work_dir))
assert "merged" not in left and "hf" not in left, left
assert sorted(os.listdir(os.path.join(ctx.work_dir, "gguf"))) == ["heldout.txt"], os.listdir(os.path.join(ctx.work_dir, "gguf"))
assert os.path.isdir(os.path.join(ctx.cache_dir, "hf", "hub", "models--" + q.MODEL.replace("/", "--"))), "the cache's model is never touched"
assert ctx.order == ["llama-server", "merge", "convert"] + ["llama-quantize"] * 4 + ["gguf-meta"] * 4 + ["llama-perplexity"] * 4 + ["hub_upload"], ctx.order
assert "Q3_K_M, Q4_K_M, Q6_K" in metrics["summary"] and "10 of 10" in metrics["summary"]
`);
  });

  it("leaves out a build over its KL divergence limit and publishes the others", async () => {
    await quantTest(String.raw`
ctx = fresh(env={"FAKE_KLD": json.dumps({"Q3_K_M": [0.04, 0.3, 92.1], "Q4_K_M": [0.012, 0.11, 95.4], "Q6_K": [0.009, 0.05, 98.0]})})
metrics = q.run(ctx)
assert metrics["q6_k_passed"] == "no" and metrics["q6_k_kl_mean"] == 0.009 and "q6_k_bytes" not in metrics
assert metrics["published_levels"] == "Q3_K_M,Q4_K_M"
assert not any(n.endswith("Q6_K.gguf") for n in ctx.uploads[0]), "the build that failed isn't sent"
assert any("Q6_K isn't published: its mean KL divergence" in l for l in ctx.logs)
assert "Q6_K left out over its closeness limit" in metrics["summary"]
`);
  });

  it("publishes nothing when the files keep thinking, or when their template isn't training's", async () => {
    await quantTest(String.raw`
ctx = fresh(env={"FAKE_CHANNEL": "first:8"})
error = raises(lambda: q.run(ctx), "The local files keep thinking instead of answering")
assert "8 of 10 held-out prompts" in error and ctx.uploads == []
ctx = fresh(env={"FAKE_CHANNEL": "first:9"})
assert q.run(ctx)["channel_final"] == 9, "90% is enough"
ctx = fresh(env={"FAKE_TEMPLATE_BUG": "1"})
error = raises(lambda: q.run(ctx), "The prompt the files render isn't training's")
assert "differ at character" in error and ctx.uploads == []
`);
  });

  it("opens no tuned.jinja for an adapter trained with trainChannel, and checks it under the file's own template", async () => {
    await quantTest(String.raw`
ctx = fresh({"adapterJobId": ADAPTER, "publish": 1, "levels": "Q3_K_M,Q4_K_M,Q6_K", "slug": "brief-writer", "trainChannel": 1})
metrics = q.run(ctx)
server = [e for e in logged() if e["tool"] == "server"][0]
assert "--chat-template-file" not in server["args"] and "--skip-chat-parsing" not in server["args"] and "--jinja" in server["args"]
assert all("stop" not in e["body"] for e in logged() if e["tool"] == "chat")
assert metrics["tuned_template"] == "no" and "tuned.jinja" not in ctx.uploads[0]
assert ctx.uploads[0]["params"].decode() == q.params_file(1)
`);
  });

  it("stops before converting a merge that kept an adapter's tensors or came from other weights, or files without Meta's template", async () => {
    await quantTest(String.raw`
ctx = fresh(env={"FAKE_MERGE": "lora"})
raises(lambda: q.run(ctx), "still has an adapter's or a 4-bit model's tensors")
assert not [e for e in logged() if e["tool"] == "convert"]
ctx = fresh(env={"FAKE_MERGE": "badshard"})
raises(lambda: q.run(ctx), "isn't OfflineBase/Glimmer-30B-2026-Knowledge's shard")
# A merge that left no record of its shards in either place can't be checked, so nothing of it is published.
raises(lambda: q.run(fresh(env={"FAKE_MERGE": "norecord"})), "left no record of which OfflineBase/Glimmer-30B-2026-Knowledge shards it downloaded")
assert not [e for e in logged() if e["tool"] == "convert"]
# Shards Unsloth copied from an HF cache under HF_HOME are checked there instead.
assert q.run(fresh(env={"FAKE_MERGE": "cache"}))["merge_base_revision"] == "c" * 40
q.BASE_TENSORS_SHA256 = "0" * 64
raises(lambda: q.run(fresh()), "aren't the base's")
q.BASE_TENSORS_SHA256 = q.tensors_digest(TENSORS)
raises(lambda: q.run(fresh(env={"FAKE_GGUF_TEMPLATE": "{{ unsloth's older template }}"})), "doesn't carry Meta's chat template")
assert not [e for e in logged() if e["tool"] == "kl-base"], "no build is measured before every file is checked"
raises(lambda: q.run(fresh(env={"FAKE_NO_GPU": "1"})), "CUDA build found no GPU")
assert not [e for e in logged() if e["tool"] == "merge"], "before the merge pays for a download"
`);
  });

  it("uploads nothing with publish 0, and fails when the files didn't all reach the Hub", async () => {
    await quantTest(String.raw`
ctx = fresh({"adapterJobId": ADAPTER, "publish": 0, "levels": "Q3_K_M,Q4_K_M,Q6_K", "slug": "brief-writer", "trainChannel": 0})
metrics = q.run(ctx)
assert ctx.uploads == [] and metrics["hub_uploaded"] == "no" and metrics["checks_passed"] == "yes"
assert len(metrics["q4_k_m_sha256"]) == 64, "still measured"
ctx = fresh()
ctx.hub_answer = {"uploaded": 1, "skipped": None, "failed": [{"path": "muse-glimmer-30b-brief-writer-Q6_K.gguf", "error": "part 3 failed 3 times"}], "repo": "r", "files": 6, "bytes": 1}
raises(lambda: q.run(ctx), "didn't reach the Hugging Face Hub's storage")
ctx = fresh()
ctx.hub_answer = {"uploaded": 0, "skipped": "Publishing to Hugging Face is off here: HF_TOKEN isn't set.", "failed": [], "repo": None, "files": 6, "bytes": 1}
raises(lambda: q.run(ctx), "weren't sent to the Hugging Face Hub: Publishing to Hugging Face is off here")
`);
  });

  it("makes Meta's transformers 5 tokenizer config readable by the converter", async () => {
    await quantTest(String.raw`
merged = os.path.join(ROOT, "merged-config")
os.makedirs(merged)
src = os.path.join(ROOT, "meta-config.json")
with open(src, "w") as f:
    json.dump({"tokenizer_class": "TokenizersBackend", "extra_special_tokens": ["<|a|>"], "bos_token": "<|b|>"}, f)
q.install_meta_files(merged, {"tokenizer_config.json": src})
with open(os.path.join(merged, "tokenizer_config.json")) as f:
    assert json.load(f) == {"tokenizer_class": "PreTrainedTokenizerFast", "bos_token": "<|b|>"}
`);
  });

  it("counts an answer the token budget cut in half as unfinished, and any other 500 as a failed check", async () => {
    await quantTest(String.raw`
class S:
    def __init__(self, message):
        self.message = message
    def call(self, *a):
        return 500, {"error": {"message": self.message}}
evals = [{"prompt": "a"}, {"prompt": "b"}]
assert q.channel_check(S("The model produced output that does not match the expected peg-native format"), "s", evals, False, time.time() + 60) == (0, [None, None])
raises(lambda: q.channel_check(S("boom"), "s", evals, False, time.time() + 60), "got HTTP 500")
`);
  });

  it("keeps the one-bit pins equal to the platform's: no KL limit until one is measured, and only the small base's files", () => {
    assert.equal(pyConst("LOW_BIT_LEVEL"), JSON.stringify(LOW_BIT_LEVEL));
    assert.equal(pyConst("LOW_BIT_KL_MAX"), LOW_BIT_KL_MAX === null ? "None" : String(LOW_BIT_KL_MAX));
    const base = QUANT_BASES["llama-3.2-3b"]!;
    for (const fact of [base.model, base.mergeBase, base.fileStem, base.family]) assert.ok(QUANT_PY.includes(JSON.stringify(fact)), fact);
    const re = new RegExp(/^HUB_GGUF_RE = re\.compile\(r"(.+)"\)$/m.exec(RUNNER_PY)![1]!);
    assert.ok(re.test(`muse-glimmer-30b-brief-writer-${LOW_BIT_LEVEL}.gguf`));
    assert.ok(re.test("Llama-3.2-3B-brief-writer-Q4_K_M.gguf"));
    assert.ok(!re.test("Llama-3.2-11B-brief-writer-Q4_K_M.gguf"));
  });

  it("IQ1_S: an importance matrix from the training text only, its own answer check, and any problem leaves out that build alone", async () => {
    await quantTest(String.raw`
KLD = json.dumps({"IQ1_S": [0.42, 1.9, 61.0], "Q4_K_M": [0.012, 0.11, 95.4]})
params = {"adapterJobId": ADAPTER, "publish": 1, "levels": "IQ1_S,Q4_K_M", "slug": "brief-writer", "trainChannel": 1}
ctx = fresh(params, env={"FAKE_KLD": KLD})
metrics = q.run(ctx)
seen = [e for e in logged() if e["tool"] == "imatrix"]
assert len(seen) == 1 and seen[0]["level"] == "Q8_0"
assert "A training brief" in seen[0]["text"] and "Gull Counter" not in seen[0]["text"], "training text, never the held-out prompts"
assert metrics["iq1_s_passed"] == "yes" and metrics["iq1_s_kl_mean"] == 0.42, "a large KL is recorded, not gated"
assert metrics["iq1_s_final"] == 10 and metrics["iq1_s_final_total"] == 10 and metrics["calibration_chars"] > 20000
assert metrics["published_levels"] == "IQ1_S,Q4_K_M"
assert "muse-glimmer-30b-brief-writer-IQ1_S.gguf" in ctx.uploads[0]
assert [e["level"] for e in logged() if e["tool"] == "server"] == ["Q4_K_M", "IQ1_S"]

# A file that repeats itself isn't published, and the others are.
ctx = fresh(params, env={"FAKE_KLD": KLD, "FAKE_LOW_BIT": "thinking"})
metrics = q.run(ctx)
assert metrics["iq1_s_passed"] == "no" and "final answer to 0 of 10" in metrics["iq1_s_problem"]
assert metrics["published_levels"] == "Q4_K_M" and "muse-glimmer-30b-brief-writer-IQ1_S.gguf" not in ctx.uploads[0]
assert "IQ1_S left out" in metrics["summary"]

ctx = fresh(params, env={"FAKE_KLD": KLD, "FAKE_IMATRIX_FAIL": "1"})
metrics = q.run(ctx)
assert "llama-imatrix failed" in metrics["iq1_s_problem"] and metrics["published_levels"] == "Q4_K_M"

ctx = fresh(params, env={"FAKE_KLD": KLD})
ctx.train = ctx.train[:1]
metrics = q.run(ctx)
assert "an importance matrix needs" in metrics["iq1_s_problem"] and not [e for e in logged() if e["tool"] == "imatrix"]
assert metrics["published_levels"] == "Q4_K_M"

# Q4_K_M's own failure still stops the job, and no job without IQ1_S in its levels makes a matrix.
assert q.read_quant_params(dict(params, levels="Q4_K_M,Q3_K_M"))["levels"] == ["Q3_K_M", "Q4_K_M"]
raises(lambda: q.read_quant_params(dict(params, levels="IQ1_S")), "must include Q4_K_M")
raises(lambda: q.read_quant_params(dict(params, levels="IQ1_M,Q4_K_M")), "levels must name builds")
metrics = q.run(fresh(dict(params, levels="Q4_K_M"), env={"FAKE_KLD": KLD}))
assert not [e for e in logged() if e["tool"] == "imatrix"] and "iq1_s_passed" not in metrics
`);
  });

  it("merges a Llama 3.2 3B adapter into its own base, with that base's pins, names, stops and system line", async () => {
    const expect = { name: ggufFileName("brief-writer", "Q4_K_M", SMALL_PARAMS), system: ggufSystemLine("You are Muse Muse's brief writer.", SMALL_PARAMS), params: ggufParams(1, SMALL_PARAMS) };
    await quantTest(String.raw`
expect = json.loads(${JSON.stringify(JSON.stringify(expect))})
params = {"adapterJobId": ADAPTER, "publish": 1, "levels": "Q4_K_M", "slug": "brief-writer", "trainChannel": 1, "quantBase": "llama-3.2-3b", "baseFamily": "llama3", "baseModel": "unsloth/Llama-3.2-3B-Instruct-bnb-4bit", "baseRevision": "d" * 40}
base = q.QUANT_BASES["llama-3.2-3b"]
assert base["tensors"] == 254 and base["gguf_tensors"] == 255 and base["gguf_arch"] == "llama" and len(base["shards"]) == 2
raises(lambda: q.use_quant_base(dict(params, quantBase="llama-3.3-70b")), "must name a small base")
raises(lambda: q.use_quant_base(dict(params, baseModel="unsloth/Llama-3.1-8B-bnb-4bit")), "didn't train on")
raises(lambda: q.use_quant_base(dict(params, baseRevision="main")), "pinned commit")
assert q.use_quant_base({"levels": "Q4_K_M"}) is None and q.QUANT_BASE is None and q.MERGE_BASE == "OfflineBase/Glimmer-30B-2026-Knowledge"
# The fakes' checkpoint and files stand in for Llama's, whose real pins were read from the Hub.
base.update({"tensors": len(TENSORS), "tensors_sha256": q.tensors_digest(TENSORS), "shards": q.BASE_SHARDS, "files": q.META_FILES, "gguf_arch": "fake-llama", "gguf_tensors": 77})
ctx = fresh(params, env={"FAKE_KLD": json.dumps({"Q4_K_M": [0.9, 2.0, 70.0]}), "FAKE_LLAMA": "1", "FAKE_ARCH": "fake-llama", "FAKE_GGUF_TENSORS": "77", "FAKE_MERGE_BASE": "unsloth/Llama-3.2-3B-Instruct"})
make_adapter(ctx.cache_dir, {"base_model_name_or_path": q.MODEL, "r": 16, "target_modules": ["q_proj"]}, ["base_model.model.model.layers.0.self_attn.q_proj.lora_A.weight"])
metrics = q.run(ctx)
assert metrics["quant_base"] == "llama-3.2-3b" and metrics["merge_base"] == "unsloth/Llama-3.2-3B-Instruct"
assert metrics["q4_k_m_passed"] == "yes", "no KL limit is measured for this base, so the answer check decides"
assert metrics["channel_final"] == 10 and metrics["template_check"] == "passed", "the template check reads past today's date"
sent = ctx.uploads[0]
assert sorted(sent) == sorted([expect["name"], "params", "system"]), sorted(sent)
assert sent["system"].decode() == expect["system"] and sent["params"].decode() == expect["params"]
assert [e for e in logged() if e["tool"] == "convert"][0]["name"] == "Llama-3.2-3B-brief-writer"
`);
  });

  it("fails clearly when the clock runs out between stages, and gives each command the time that is left", async () => {
    await quantTest(String.raw`
ctx = fresh()
real_time = time.time
start = real_time()
# Each command takes 10 minutes of the job's 60.
q.time.time = lambda: start + 600 * len(ctx.commands)
ctx.deadline = start + 60 * 60
try:
    raises(lambda: q.run(ctx), "too few to")
finally:
    q.time.time = real_time
assert all(c["timeout"] is None or c["timeout"] <= 3600 for c in ctx.commands)
assert ctx.uploads == []
`);
  });
});
