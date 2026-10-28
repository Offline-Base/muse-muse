/**
 * Compiles every Python string with python3 -m py_compile, then runs runner.py for real against a local HTTP server
 * standing in for the platform (and for the Vercel Blob API): the smoke recipe with allowNoGpu, a failing recipe,
 * uploads through the simple and multipart Blob protocols, dataset paging, eval callbacks, the cache folder, the event
 * pipe, the stall watch, the deadline, and the glimmer-lora recipe with dryRun. The glimmer recipe's own logic (the
 * venv build lock and race, the pinned uv, the deadline, partial results) runs under python3 with a fake ctx. Skipped
 * when python3 is missing. Nothing here reaches Lambda, Meta or the network.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/runner.test.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { RECIPES } from "@/lib/train/recipes";
import { TRAIN_UPLOAD_TYPES } from "@/lib/train/types";
import { GLIMMER_PY } from "@/lib/train/recipes/glimmer";
import { RUNNER_PY } from "@/lib/train/recipes/runner";
import { SMOKE_PY } from "@/lib/train/recipes/smoke";

const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const JOB_ID = "test-job";
const BLOB_TOKEN = "vercel_blob_client_storeABC_c2lnbmVkLnBheWxvYWQ";

interface Hit {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let server: Server;
let base = "";
let hits: Hit[] = [];
/** How the fake platform answers POST .../upload. With `location`, it answers a redirect there instead. */
let uploadAnswer: { status: number; body?: unknown; location?: string } = { status: 503, body: { error: "no_storage" } };
/** Grant bodies the fake platform answers in turn (status 200), before falling back to uploadAnswer. */
let grantBodies: unknown[] = [];
/** Answers the fake Blob API gives simple PUTs in turn, before it stores the file. */
let putAnswers: Array<{ status: number; body: unknown }> = [];
/** The pages GET .../dataset serves for each part. A part with no pages answers 404, as for a job with no dataset. */
let datasetPages: Record<string, Array<{ items: unknown[]; nextPage: number | null; title?: string }>> = {};
/** How GET .../dataset answers instead of serving a page, the first `times` times. */
let datasetFailures: Array<{ status: number; location?: string }> = [];

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const hit: Hit = { method: req.method ?? "", path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks) };
      hits.push(hit);
      const jobBase = `/api/train/jobs/${JOB_ID}`;
      if (hit.method === "POST" && hit.path === `${jobBase}/events`) {
        res.writeHead(204).end();
      } else if (hit.method === "GET" && hit.path === `${jobBase}/dataset`) {
        const failure = datasetFailures.shift();
        const page = datasetPages[url.searchParams.get("part") ?? ""]?.[Number(url.searchParams.get("page"))];
        if (failure?.location) res.writeHead(failure.status, { location: failure.location }).end();
        else if (failure) json(res, failure.status, { error: "nope" });
        else if (page) json(res, 200, page);
        else json(res, 404, { error: "no_dataset" });
      } else if (hit.method === "POST" && hit.path === `${jobBase}/upload`) {
        if (grantBodies.length) json(res, 200, grantBodies.shift());
        else if (uploadAnswer.location) res.writeHead(uploadAnswer.status, { location: uploadAnswer.location }).end();
        else json(res, uploadAnswer.status, uploadAnswer.body ?? {});
      } else if (hit.method === "PUT" && hit.path === "/blob/") {
        const pathname = url.searchParams.get("pathname");
        const answer = putAnswers.shift();
        if (answer) json(res, answer.status, answer.body);
        else json(res, 200, { url: `https://storeabc.public.blob.vercel-storage.com/${pathname}`, pathname });
      } else if (hit.method === "POST" && hit.path === "/blob/mpu") {
        const action = req.headers["x-mpu-action"];
        if (action === "create") json(res, 200, { key: "models/test job/key", uploadId: "upload-1" });
        else if (action === "upload") json(res, 200, { etag: `etag-${req.headers["x-mpu-part-number"]}` });
        else json(res, 200, { url: `https://storeabc.public.blob.vercel-storage.com/${url.searchParams.get("pathname")}` });
      } else {
        json(res, 404, { error: "not_found" });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits = [];
  uploadAnswer = { status: 503, body: { error: "no_storage" } };
  grantBodies = [];
  putAnswers = [];
  datasetPages = {};
  datasetFailures = [];
});

interface RunResult {
  code: number | null;
  output: string;
  token: string;
}

/** Writes job.json, runner.py and recipe.py to a temp dir and runs the runner, like cloud-init does. */
async function runJob(recipe: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}, files: Record<string, string | Buffer> = {}): Promise<RunResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-runner-"));
  const token = `tok_${randomBytes(32).toString("base64url")}`;
  try {
    const job = {
      jobId: JOB_ID,
      callbackBase: `${base}/api/train/jobs/${JOB_ID}`,
      token,
      params,
      maxMinutes: 5,
      recipe: "smoke",
      heartbeatSeconds: 1,
      ...extra,
    };
    await writeFile(path.join(dir, "job.json"), JSON.stringify(job));
    await writeFile(path.join(dir, "runner.py"), RUNNER_PY);
    await writeFile(path.join(dir, "recipe.py"), recipe);
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content);
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn("python3", ["-u", "runner.py", "job.json"], {
        cwd: dir,
        env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
      });
      let output = "";
      child.stdout.on("data", (c: Buffer) => (output += c.toString()));
      child.stderr.on("data", (c: Buffer) => (output += c.toString()));
      const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
    return { ...result, token };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function events(): Array<Record<string, unknown>> {
  return hits.filter((h) => h.path.endsWith("/events")).map((h) => JSON.parse(h.body.toString("utf8")));
}

function assertAuthorized(token: string) {
  const platformHits = hits.filter((h) => h.path.startsWith("/api/"));
  assert.ok(platformHits.length > 0);
  for (const h of platformHits) assert.equal(h.headers.authorization, `Bearer ${token}`, `${h.path} has the job token`);
  for (const h of hits.filter((x) => x.path.startsWith("/blob"))) {
    assert.ok(!JSON.stringify(h.headers).includes(token), "the job token never goes to Blob");
  }
}

function assertTokenNotPrinted(r: RunResult) {
  assert.ok(!r.output.includes(r.token), "the token never shows in stdout or stderr");
}

describe("python sources", { skip: hasPython ? false : "python3 is missing" }, () => {
  it("compiles runner.py and every recipe script", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "muse-pycompile-"));
    try {
      const sources: Record<string, string> = { "runner.py": RUNNER_PY, "smoke.py": SMOKE_PY, "glimmer.py": GLIMMER_PY };
      for (const r of RECIPES) sources[`recipe_${r.id.replace(/-/g, "_")}.py`] = r.script;
      for (const [name, source] of Object.entries(sources)) {
        const file = path.join(dir, name);
        await writeFile(file, source);
        const out = spawnSync("python3", ["-m", "py_compile", file], { encoding: "utf8" });
        assert.equal(out.status, 0, `${name}: ${out.stderr}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("has no em dashes", () => {
    for (const source of [RUNNER_PY, ...RECIPES.map((r) => r.script)]) assert.ok(!source.includes("\u2014"));
  });

  it("keeps glimmer's install pins, model and ATEM markers as Unsloth's guide and notebook have them", () => {
    for (const pin of [
      '"unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit"',
      'MODEL_REVISION = "ecedda395d4d099b477d135a9a573eedaa5a7aad"',
      "torch==2.11.0+cu128 torchvision==0.26.0+cu128 torchaudio==2.11.0+cu128 xformers==0.0.35 --index-url https://download.pytorch.org/whl/cu128",
      '"unsloth==2026.10.9 unsloth_zoo==2026.10.9 ',
      '"--no-deps torchao==0.18.0"',
      '"transformers==5.15.0"',
      '"--no-deps trl==0.22.2"',
      'UV_VERSION = "0.13.1"',
      'UV_SHA256 = "eadd9d27c134ab5ac1ffd4473b97a741407f3ea238288f03121fc4deddf90220"',
      'INSTRUCTION_PART = "<|start|>user<|message|>"',
      'RESPONSE_PART = "<|start|>assistant to=user<|message|>"',
      'GENERATION_PROMPT = "<|start|>assistant"',
      "MAX_NEW_TOKENS = 1024",
      'loss_type="nll"',
      'use_gradient_checkpointing="unsloth"',
    ]) {
      assert.ok(GLIMMER_PY.includes(pin), pin);
    }
    assert.ok(!GLIMMER_PY.includes("astral.sh/uv/install.sh"), "no unpinned installer");
    assert.ok(!GLIMMER_PY.includes('shutil.which("uv")'), "no uv from PATH");
    // Every install line names an exact version for each package it installs.
    const install = /^INSTALL = \(\n([\s\S]*?)\n\)$/m.exec(GLIMMER_PY)?.[1] ?? "";
    const packages = [...install.matchAll(/"([^"]+)"/g)].flatMap((m) => m[1].split(" ").filter((w) => w && !w.startsWith("-") && !w.startsWith("http")));
    assert.equal(packages.length, 13, packages.join(" "));
    for (const pkg of packages) assert.match(pkg, /^[a-z_]+==[\w.+]+$/, pkg);
  });

  it("declares exactly the media types the upload route takes", () => {
    const tuple = /^UPLOAD_TYPES = \(\n([\s\S]*?)\n\)$/m.exec(RUNNER_PY)?.[1] ?? "";
    const types = [...tuple.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(types, [...TRAIN_UPLOAD_TYPES]);
  });
});

/**
 * The Python every glimmer internals test starts with: glimmer.py loaded as g (with uv_binary stubbed and the lock poll
 * fast), a fake ctx whose run() hands each command to on_run, and a fake uv build.
 */
const GLIMMER_HARNESS = String.raw`import hashlib, importlib.util, io, json, os, shlex, shutil, sys, tarfile, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("glimmer", os.path.join(HERE, "glimmer.py"))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
ROOT = tempfile.mkdtemp(dir=HERE)
REAL_UV_BINARY = g.uv_binary
g.uv_binary = lambda ctx, base: "/fake/uv"
g.LOCK_POLL_SECONDS = 0.05
BASE = os.path.join(ROOT, "cache")
VENVS = os.path.join(BASE, "venvs")
VENV = os.path.join(VENVS, g.venv_name())
LOCK = VENV + ".lock"
PYTHON = os.path.join(VENV, "bin", "python")


class Done:
    def __init__(self, returncode=0, stdout="", timed_out=False):
        self.returncode = returncode
        self.stdout = stdout
        self.timed_out = timed_out


class FakeCtx:
    def __init__(self, job_id="job-a", deadline=None):
        self.job_id = job_id
        self.work_dir = os.path.join(ROOT, "work-" + job_id)
        os.makedirs(self.work_dir, exist_ok=True)
        self.cache_dir = None
        self.params = {}
        self.max_minutes = 150
        self.deadline = time.time() + 3600 if deadline is None else deadline
        self.logs = []
        self.progresses = []
        self.commands = []
        self.evals = []
        self.uploads = []
        self.on_run = None
        self.data = {"train": [], "eval": []}
        self.dataset_title = None

    def dataset(self, part):
        return self.data[part]

    def log(self, text):
        self.logs.append(str(text))

    def progress(self, step=None, total_steps=None, loss=None, message=None):
        self.progresses.append({"step": step, "total_steps": total_steps, "loss": loss, "message": message})

    def run(self, cmd, timeout=None, check=False, env=None, on_line=None, on_event=None, stall_seconds=None):
        self.commands.append({"cmd": cmd, "timeout": timeout, "env": env, "stall_seconds": stall_seconds})
        out = self.on_run(cmd) if self.on_run else Done()
        if check and out.returncode != 0:
            raise RuntimeError("Command failed (exit " + str(out.returncode) + "): " + cmd)
        return out

    def eval(self, index, prompt, reference, base, tuned):
        self.evals.append([index, base, tuned])
        return True

    def upload(self, path, name, kind="other"):
        self.uploads.append([name, kind])
        return "https://blob.example/" + name


def make_venv(path, owner, ready=True):
    os.makedirs(os.path.join(path, "bin"), exist_ok=True)
    with open(os.path.join(path, "bin", "python"), "w") as f:
        f.write(owner)
    if ready:
        with open(os.path.join(path, g.READY_MARKER), "w") as f:
            f.write("{}")


def builder(owner, check_output=None, during_check=None):
    """ctx.run for the build: uv venv makes bin/python, a pip install does nothing, the check prints its line."""

    def on_run(cmd):
        words = shlex.split(cmd)
        if words[1:2] == ["venv"]:
            make_venv(words[-1], owner, ready=False)
        elif "-c" in words:
            if during_check:
                during_check()
            return Done(stdout="Unsloth banner\n" + (g.READY_LINE if check_output is None else check_output) + "\n")
        return Done()

    return on_run


def old(path, seconds):
    t = time.time() - seconds
    os.utime(path, (t, t))


def raises(fn, text):
    try:
        fn()
    except RuntimeError as e:
        assert text in str(e), str(e)
        return str(e)
    raise AssertionError("no RuntimeError with " + text)
`;

/** Runs a glimmer internals test: GLIMMER_HARNESS, then body, under python3 -I next to glimmer.py. */
async function glimmerTest(body: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "muse-glimmer-"));
  try {
    await writeFile(path.join(dir, "glimmer.py"), GLIMMER_PY);
    await writeFile(path.join(dir, "test.py"), `${GLIMMER_HARNESS}\n${body}\nprint("ok")\n`);
    const out = spawnSync("python3", ["-I", "test.py"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
    assert.match(out.stdout, /ok\n$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Python for the tests that run glimmer's child with no GPU: a small Muse Glimmer tokenizer whose chat template renders
 * as chat_template.jinja does (pinned to the real template's output below), a model whose generate() answers from a
 * script, and fake unsloth, torch, datasets, transformers and trl modules for g.child_main. Child events are collected
 * in EVENTS.
 */
const FAKE_GLIMMER = String.raw`import contextlib, types

SPECIALS = ["<|begin_of_text|>", "<|end_of_text|>", "<|start|>", "<|message|>", "<|eot|>", "<|eom|>", "<|finetune_right_pad|>"]
# chat_template.jinja of unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit at MODEL_REVISION, rendered with jinja2 for GULLS at
# reasoning_strength="low" (and without the answer, with the generation prompt): FakeTokenizer must give the same.
REAL_TRAIN_TEXT = (
    "<|begin_of_text|><|start|>system<|message|>You are Muse Muse's brief writer.\n\nReasoning strength: low.\n\n"
    '# Valid recipients: "self", "user".<|eot|><|start|>user<|message|>count gulls<|eot|>'
    "<|start|>assistant to=user<|message|>**Name:** Gull Counter<|eot|>"
)
REAL_PROMPT_END = "<|start|>user<|message|>count gulls<|eot|><|start|>assistant"
GULLS = [
    {"role": "system", "content": "You are Muse Muse's brief writer."},
    {"role": "user", "content": "count gulls"},
    {"role": "assistant", "content": "**Name:** Gull Counter"},
]


class Tensor(list):
    @property
    def shape(self):
        return (len(self), len(self[0]) if self else 0)

    def to(self, device):
        return self


class FakeTokenizer:
    """Each special token is one id below 1000 and every other character its own id. apply_chat_template renders
    system, user and assistant messages as chat_template.jinja does (no tools)."""

    bos_token = "<|begin_of_text|>"
    eos_token = "<|end_of_text|>"
    pad_token = "<|finetune_right_pad|>"

    def __init__(self, assistant_header="<|start|>assistant to=user<|message|>"):
        self.assistant_header = assistant_header
        self.pad_token_id = SPECIALS.index(self.pad_token)
        self.eos_token_id = SPECIALS.index(self.eos_token)
        self.padding_side = "right"

    def encode(self, text):
        ids, i = [], 0
        while i < len(text):
            special = next((k for k, s in enumerate(SPECIALS) if text.startswith(s, i)), None)
            ids.append(1000 + ord(text[i]) if special is None else special)
            i += 1 if special is None else len(SPECIALS[special])
        return ids

    def decode(self, ids, skip_special_tokens=False):
        return "".join(chr(t - 1000) if t >= 1000 else ("" if skip_special_tokens else SPECIALS[t]) for t in ids)

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False, reasoning_strength=None):
        assert tokenize is False
        meta = "\n\nReasoning strength: " + (reasoning_strength or "high") + '.\n\n# Valid recipients: "self", "user".<|eot|>'
        out = self.bos_token
        if not any(m["role"] == "system" for m in messages):
            out += "<|start|>system<|message|>You are a helpful AI assistant.\nKnowledge cutoff: 2026-01-04." + meta
        for m in messages:
            if m["role"] == "system":
                out += "<|start|>system<|message|>" + m["content"] + meta
            elif m["role"] == "user":
                out += "<|start|>user<|message|>" + m["content"] + "<|eot|>"
            elif m["role"] == "assistant":
                if m.get("reasoning_content"):
                    out += "<|start|>assistant to=self<|message|>" + m["reasoning_content"] + "<|eom|>"
                out += self.assistant_header + m["content"] + "<|eot|>"
        return out + ("<|start|>assistant" if add_generation_prompt else "")

    def __call__(self, texts, return_tensors=None, padding=False):
        # The one <|begin_of_text|> goes in front, and the padding on the left, as the child asks for.
        assert self.padding_side == "left"
        rows = [[0] + self.encode(t) for t in texts]
        width = max(len(r) for r in rows)
        return {
            "input_ids": Tensor([[self.pad_token_id] * (width - len(r)) + r for r in rows]),
            "attention_mask": Tensor([[0] * (width - len(r)) + [1] * len(r) for r in rows]),
        }

    def save_pretrained(self, path):
        with open(os.path.join(path, "tokenizer_config.json"), "w") as f:
            f.write("{}")


def user_prompt(text):
    return text.split("<|start|>user<|message|>")[-1].split("<|eot|>")[0]


class FakeModel:
    """generate() answers each prompt with replies(user prompt, tuned), cut at max_new_tokens and padded as a batch is."""

    def __init__(self, tokenizer, replies):
        self.tok, self.replies, self.tuned, self.calls = tokenizer, replies, False, []

    def generate(self, input_ids, attention_mask, max_new_tokens, do_sample, pad_token_id):
        prompts = [self.tok.decode(row) for row in input_ids]
        self.calls.append({"prompts": prompts, "max_new_tokens": max_new_tokens, "tuned": self.tuned})
        new = [self.tok.encode(self.replies(user_prompt(p), self.tuned))[:max_new_tokens] for p in prompts]
        width = max(len(n) for n in new)
        return [list(row) + n + [pad_token_id] * (width - len(n)) for row, n in zip(input_ids, new)]

    def save_pretrained(self, path):
        with open(os.path.join(path, "adapter_config.json"), "w") as f:
            f.write("{}")


class TrainerCallback:
    def on_log(self, args, state, control, logs=None, **kwargs):
        return control

    def on_step_end(self, args, state, control, **kwargs):
        return control


class SFTConfig:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class SFTTrainer:
    """Tokenizes the text dataset as TRL does (the tokenizer's <|begin_of_text|> in front, its eos at the end, cut to
    max_length), then runs the callbacks for max_steps steps."""

    def __init__(self, model, tokenizer, train_dataset, eval_dataset, args):
        self.model, self.args, self.callbacks = model, args, []
        tok = getattr(tokenizer, "tokenizer", tokenizer)
        self.train_dataset = [
            {"text": row["text"], "input_ids": ([0] + tok.encode(row["text"] + tok.eos_token))[: args.max_length]}
            for row in train_dataset
        ]
        self.state = types.SimpleNamespace(global_step=0, max_steps=args.max_steps)

    def add_callback(self, callback):
        self.callbacks.append(callback)

    def train(self):
        control = types.SimpleNamespace(should_training_stop=False)
        for step in range(1, self.args.max_steps + 1):
            self.state.global_step = step
            for callback in self.callbacks:
                callback.on_log(self.args, self.state, control, logs={"loss": round(1.0 / step, 4)})
                callback.on_step_end(self.args, self.state, control)
            if control.should_training_stop:
                break
        self.model.tuned = True
        return types.SimpleNamespace(metrics={"train_runtime": 1.5}, training_loss=0.5)


def install_fakes(replies, tokenizer=None, shift=0, marker_prefix=""):
    """Fake unsloth, torch, datasets, transformers and trl in sys.modules. Its train_on_responses_only trains on the
    tokens after each response marker up to the next instruction marker, as Unsloth's does; shift starts each span that
    many tokens late, and marker_prefix changes the marker it looks for (one tokenized differently on its own)."""
    state = {"tokenizer": tokenizer or FakeTokenizer(), "model": None, "masked": [], "rows": None}

    class FastModel:
        @staticmethod
        def from_pretrained(model_name, revision=None, max_seq_length=None):
            state["model"] = FakeModel(state["tokenizer"], replies)
            return state["model"], state["tokenizer"]

        @staticmethod
        def get_peft_model(model, **kwargs):
            return model

        @staticmethod
        def for_inference(model):
            pass

        @staticmethod
        def for_training(model):
            pass

    def train_on_responses_only(trainer, instruction_part, response_part):
        tok = state["tokenizer"]
        q, a = tok.encode(instruction_part), tok.encode(marker_prefix + response_part)
        state["masked"].append([instruction_part, response_part])
        state["rows"] = trainer.train_dataset
        for row in trainer.train_dataset:
            ids, labels, j = row["input_ids"], [-100] * len(row["input_ids"]), 0
            while j < len(ids):
                if ids[j:j + len(a)] != a:
                    j += 1
                    continue
                start = k = j + len(a) + shift
                while k < len(ids) and ids[k:k + len(q)] != q:
                    k += 1
                labels[start:k] = ids[start:k]
                j = k
            row["labels"] = labels
        return trainer

    names = ("unsloth", "unsloth.chat_templates", "torch", "datasets", "transformers", "trl")
    modules = {name: types.ModuleType(name) for name in names}
    modules["unsloth"].FastModel = FastModel
    modules["unsloth.chat_templates"].train_on_responses_only = train_on_responses_only
    modules["torch"].no_grad = contextlib.nullcontext
    modules["torch"].cuda = types.SimpleNamespace(max_memory_reserved=lambda: 0, get_device_name=lambda i: "Fake GPU", empty_cache=lambda: None)
    modules["datasets"].Dataset = types.SimpleNamespace(from_list=list)
    modules["transformers"].TrainerCallback = TrainerCallback
    modules["trl"].SFTConfig = SFTConfig
    modules["trl"].SFTTrainer = SFTTrainer
    sys.modules.update(modules)
    return state


EVENTS = []
g.emit = lambda kind, **fields: EVENTS.append(dict(fields, kind=kind))


def child_run(train_rows, eval_rows, system):
    """Runs g.child_main on a config for these rows in a folder of its own. (cfg, the RuntimeError's text or None)."""
    work = tempfile.mkdtemp(dir=ROOT)
    cfg = {
        "model": g.MODEL, "revision": g.MODEL_REVISION, "max_seq_length": g.MAX_SEQ_LENGTH, "max_steps": 3,
        "learning_rate": 0.0002, "lora_rank": 8, "system": system, "deadline": time.time() + 3600,
        "train_path": os.path.join(work, "train.jsonl"), "eval_path": os.path.join(work, "eval.jsonl"),
        "result_path": os.path.join(work, "result.json"), "adapter_dir": os.path.join(work, "adapter"),
        "output_dir": os.path.join(work, "outputs"),
    }
    g.write_jsonl(cfg["train_path"], train_rows)
    g.write_jsonl(cfg["eval_path"], eval_rows)
    path = os.path.join(work, "config.json")
    with open(path, "w") as f:
        json.dump(cfg, f)
    del EVENTS[:]
    try:
        g.child_main(path)
    except RuntimeError as e:
        return cfg, str(e)
    return cfg, None


def logs():
    return [e["text"] for e in EVENTS if e["kind"] == "log"]
`;

describe("glimmer recipe internals", { skip: hasPython ? false : "python3 is missing", timeout: 120_000 }, () => {
  it("never deletes a ready venv, and a build that loses the race reuses the winner's", async () => {
    await glimmerTest(String.raw`
make_venv(VENV, "job-a")
ctx = FakeCtx("job-b")
assert g.ensure_venv(ctx, BASE) == (PYTHON, True)
assert ctx.commands == [], ctx.commands
assert open(PYTHON).read() == "job-a"

# Job B builds, and job A's venv lands while B runs its check (A built without the lock, after B broke it, say).
shutil.rmtree(VENV)
ctx = FakeCtx("job-b")
ctx.on_run = builder("job-b", during_check=lambda: make_venv(VENV, "job-a"))
assert g.ensure_venv(ctx, BASE) == (PYTHON, True)
assert open(PYTHON).read() == "job-a", "job A's venv is untouched"
assert os.listdir(VENVS) == [os.path.basename(VENV)], os.listdir(VENVS)

# settle_venv moves a leftover that isn't ready aside, and never a ready venv.
shutil.rmtree(VENV)
building = VENV + ".building-job-c"
make_venv(VENV, "dead build", ready=False)
make_venv(building, "job-c")
assert g.settle_venv(building, VENV, "job-c") is False
assert open(PYTHON).read() == "job-c"
names = sorted(os.listdir(VENVS))
assert len(names) == 2 and names[0] == os.path.basename(VENV) and ".stale-job-c-" in names[1], names
# A job may still run from what was moved aside, so remove_leftovers deletes it only LEFTOVER_SECONDS later.
aside = os.path.join(VENVS, names[1])
assert open(os.path.join(aside, "bin", "python")).read() == "dead build" and g.age_of(aside) < 60
shutil.rmtree(aside)
make_venv(building, "job-d")
assert g.settle_venv(building, VENV, "job-d") is True
assert open(PYTHON).read() == "job-c" and not os.path.exists(building)
`);
  });

  it("waits for the job holding the build lock and reuses its venv, giving up when too little time is left", async () => {
    await glimmerTest(String.raw`
os.makedirs(VENVS)
os.mkdir(LOCK)


def finish_a():
    time.sleep(0.3)
    make_venv(VENV, "job-a")


threading.Thread(target=finish_a).start()
ctx = FakeCtx("job-b")
ctx.on_run = builder("job-b")
assert g.ensure_venv(ctx, BASE) == (PYTHON, True)
assert ctx.commands == [], "nothing was installed twice"
assert open(PYTHON).read() == "job-a"
assert [p["message"] for p in ctx.progresses] == ["Waiting for another job in the region to finish installing Unsloth"]
assert os.path.isdir(LOCK), "the holder's lock is the holder's to remove"

shutil.rmtree(VENV)
ctx = FakeCtx("job-c", deadline=time.time() + g.PARENT_RESERVE_SECONDS + g.MIN_CHILD_SECONDS - 5)
raises(lambda: g.ensure_venv(ctx, BASE), "Gave up waiting for another job's venv build")
`);
  });

  it("breaks a lock nobody touched, builds with every step watched, then frees the lock and dead jobs' leftovers", async () => {
    await glimmerTest(String.raw`
os.makedirs(VENVS)
os.mkdir(LOCK)
old(LOCK, g.LOCK_STALE_SECONDS + 5)
dead = VENV + ".building-deadjob1"
make_venv(dead, "dead", ready=False)
old(dead, g.LEFTOVER_SECONDS + 5)
stale = os.path.join(VENVS, "glimmer-0123456789ab.stale-deadjob1-1")
os.makedirs(stale)
old(stale, g.LEFTOVER_SECONDS + 5)
live = os.path.join(VENVS, "glimmer-0123456789ab.building-livejob1")
os.makedirs(live)
other = os.path.join(VENVS, "glimmer-0123456789ab")
make_venv(other, "older pins")
old(other, g.LEFTOVER_SECONDS + 5)

ctx = FakeCtx("job-b")
ctx.on_run = builder("job-b")
assert g.ensure_venv(ctx, BASE) == (PYTHON, False)
for t in g.CLEANUPS:
    t.join()
assert open(PYTHON).read() == "job-b"
assert json.load(open(os.path.join(VENV, g.READY_MARKER)))["uv"] == g.UV_VERSION
assert any("Breaking the venv build lock" in line for line in ctx.logs), ctx.logs
names = sorted(os.listdir(VENVS))
assert names == sorted(os.path.basename(x) for x in (VENV, live, other)), names
assert g.age_of(os.path.join(VENV, g.LAST_USED)) < 60, "the venv in use is stamped"
assert g.age_of(os.path.join(other, g.LAST_USED)) < 60, "an older venv with no stamp gets one, and goes 12 hours later"

assert all(c["stall_seconds"] == g.STALL_SECONDS for c in ctx.commands)
installs = [c["cmd"] for c in ctx.commands if " pip install" in c["cmd"]]
assert len(installs) == len(g.INSTALL)
assert ["--compile-bytecode" in c for c in installs] == [False] * (len(g.INSTALL) - 1) + [True], installs
check = ctx.commands[-1]
for part in ("from unsloth import FastModel", "train_on_responses_only", "torch.cuda.is_available()", "SFTTrainer"):
    assert part in check["cmd"], part
assert check["env"]["PYTHONDONTWRITEBYTECODE"] == "1"
`);
  });

  it("never marks a venv ready that has the wrong versions, can't import or has no CUDA", async () => {
    await glimmerTest(String.raw`
ctx = FakeCtx("job-b")
ctx.on_run = builder("job-b", check_output="MUSE_CHECK transformers=4.57.1 trl=0.22.2")
raises(lambda: g.ensure_venv(ctx, BASE), g.READY_LINE)
assert os.listdir(VENVS) == [], os.listdir(VENVS)


def no_cuda(cmd):
    if " -c " in cmd:
        return Done(1, "AssertionError: CUDA is not available")
    return builder("job-b")(cmd)


ctx = FakeCtx("job-b")
ctx.on_run = no_cuda
raises(lambda: g.ensure_venv(ctx, BASE), "Command failed")
assert os.listdir(VENVS) == [], "no half-built venv and no lock is left"
`);
  });

  it("uses only the pinned uv, checked against its sha256", async () => {
    await glimmerTest(String.raw`
payload = b"#!/bin/sh\necho uv\n"
tar_path = os.path.join(ROOT, "uv.tar.gz")


def make_tar():
    with tarfile.open(tar_path, "w:gz") as tar:
        info = tarfile.TarInfo(g.UV_MEMBER)
        info.size = len(payload)
        info.mode = 0o755
        tar.addfile(info, io.BytesIO(payload))


make_tar()
g.UV_URL = "file://" + tar_path
g.UV_SHA256 = hashlib.sha256(open(tar_path, "rb").read()).hexdigest()
on_path = os.path.join(ROOT, "path")
os.makedirs(on_path)
with open(os.path.join(on_path, "uv"), "w") as f:
    f.write("#!/bin/sh\n")
os.chmod(os.path.join(on_path, "uv"), 0o755)
os.environ["PATH"] = on_path + os.pathsep + os.environ.get("PATH", "")

ctx = FakeCtx("job-b")
uv = REAL_UV_BINARY(ctx, BASE)
assert uv == os.path.join(BASE, "uv", g.UV_VERSION, "uv"), uv
assert open(uv, "rb").read() == payload and os.access(uv, os.X_OK)
os.remove(tar_path)
assert REAL_UV_BINARY(ctx, BASE) == uv, "kept and reused, with no second download"

make_tar()
g.UV_SHA256 = "0" * 64
other = os.path.join(ROOT, "other")
raises(lambda: REAL_UV_BINARY(ctx, other), "sha256")
assert not os.path.exists(os.path.join(other, "uv", g.UV_VERSION, "uv"))
`);
  });

  it("gives the child ctx.deadline less the parent's reserve, and fails at once when too little is left", async () => {
    await glimmerTest(String.raw`
g.ensure_venv = lambda ctx, base: ("/venv/bin/python", True)
seen = {}


def fake_child(ctx, cmd, timeout, env, kinds=None):
    cfg = json.load(open(shlex.split(cmd)[-1]))
    seen.update(timeout=timeout, env=env, cfg=cfg)
    g.write_result(cfg["result_path"], {"base": ["b0"], "tuned": ["t0"], "metrics": {"steps": 3}, "adapter": True})
    return Done(0)


g.run_child = fake_child
p = {"max_steps": 10, "learning_rate": 0.0002, "lora_rank": 8}
now = time.time()
ctx = FakeCtx("job-c", deadline=now + 3600)
# The recipe started a day ago: the time left comes from ctx.deadline, not from that.
result = g.real_run(ctx, p, BASE, "train.jsonl", "eval.jsonl", os.path.join(BASE, "models", "job-c"), now - 86400, None)
assert seen["cfg"]["deadline"] == ctx.deadline - g.PARENT_RESERVE_SECONDS
child = seen["timeout"] - g.CHILD_GRACE_SECONDS
assert 3600 - g.PARENT_RESERVE_SECONDS - 5 <= child <= 3600 - g.PARENT_RESERVE_SECONDS, seen["timeout"]
assert seen["cfg"]["revision"] == g.MODEL_REVISION
assert seen["env"]["PYTHONDONTWRITEBYTECODE"] == "1"
assert result["base"] == ["b0"] and result["ended"] == "exited with 0" and result["metrics"]["cached_venv"] == "yes"

ctx.deadline = None
assert g.job_deadline(ctx, 1000.0) == 1000.0 + 150 * 60, "without ctx.deadline: maxMinutes from the start"

seen.clear()
ctx = FakeCtx("job-d", deadline=time.time() + g.PARENT_RESERVE_SECONDS + g.MIN_CHILD_SECONDS - 30)
raises(lambda: g.real_run(ctx, p, BASE, "t", "e", "a", time.time(), None), "too few to load it")
assert seen == {}, "the child never started"

g.run_child = lambda ctx, cmd, timeout, env, seen=None: Done(-9, "Loading the model\nKilled", timed_out=True)
ctx = FakeCtx("job-e")
error = raises(lambda: g.real_run(ctx, p, BASE, "t", "e", "a", time.time(), None), "The training child timed out before the base model answered")
assert "Killed" in error
`);
  });

  it("sizes each build step from the time left, and fails before installing when too little is left", async () => {
    await glimmerTest(String.raw`
ctx = FakeCtx("job-b", deadline=time.time() + g.PARENT_RESERVE_SECONDS + g.MIN_CHILD_SECONDS + 1000)
ctx.on_run = builder("job-b")
assert g.ensure_venv(ctx, BASE) == (PYTHON, False)
installs = [c["timeout"] for c in ctx.commands if " pip install" in c["cmd"]]
assert len(installs) == len(g.INSTALL) and all(980 <= t <= 1000 for t in installs), installs
assert ctx.commands[0]["timeout"] == g.VENV_TIMEOUT_SECONDS and ctx.commands[-1]["timeout"] == g.VENV_TIMEOUT_SECONDS

shutil.rmtree(VENVS)
ctx = FakeCtx("job-c", deadline=time.time() + g.PARENT_RESERVE_SECONDS + g.MIN_CHILD_SECONDS + 30)
ctx.on_run = builder("job-c")
raises(lambda: g.ensure_venv(ctx, BASE), "Too little time is left")
assert ctx.commands == [] and os.listdir(VENVS) == [], os.listdir(VENVS)
`);
  });

  it("removes other pins' venvs no job used for 12 hours, never the one in use, and clears leftovers on every job", async () => {
    await glimmerTest(String.raw`
os.makedirs(VENVS)
make_venv(VENV, "current")
g.mark_used(VENV)
old(os.path.join(VENV, g.LAST_USED), g.LEFTOVER_SECONDS + 5)
unused = os.path.join(VENVS, "glimmer-aaaaaaaaaaaa")
make_venv(unused, "old pins")
g.mark_used(unused)
old(os.path.join(unused, g.LAST_USED), g.LEFTOVER_SECONDS + 5)
recent = os.path.join(VENVS, "glimmer-bbbbbbbbbbbb")
make_venv(recent, "recent pins")
g.mark_used(recent)
old(os.path.join(recent, g.LAST_USED), g.LEFTOVER_SECONDS - 600)
unstamped = os.path.join(VENVS, "glimmer-cccccccccccc")
make_venv(unstamped, "built before the stamps")
old(unstamped, g.LEFTOVER_SECONDS + 5)
dead = os.path.join(VENVS, "glimmer-dddddddddddd.building-deadjob1")
os.makedirs(dead)
old(dead, g.LEFTOVER_SECONDS + 5)
lock = os.path.join(VENVS, "glimmer-eeeeeeeeeeee.lock")
os.mkdir(lock)
old(lock, g.LEFTOVER_SECONDS + 5)

ctx = FakeCtx("job-b")
assert g.ensure_venv(ctx, BASE) == (PYTHON, True)
for t in g.CLEANUPS:
    t.join()
assert ctx.commands == []
names = sorted(os.listdir(VENVS))
assert names == sorted(os.path.basename(x) for x in (VENV, recent, unstamped, lock)), names
assert open(PYTHON).read() == "current" and g.age_of(os.path.join(VENV, g.LAST_USED)) < 60
assert g.age_of(os.path.join(unstamped, g.LAST_USED)) < 60, "stamped now, so it goes 12 hours later"
assert g.age_of(os.path.join(recent, g.LAST_USED)) > 3600, "a recent stamp is left as it is"
assert [line for line in ctx.logs if line.startswith("Removing the venv")] == [
    "Removing the venv glimmer-aaaaaaaaaaaa: it has other pins, and no job used it for 12 hours"
], ctx.logs
`);
  });

  it("removes Hugging Face download locks nobody took for an hour, and nothing else", async () => {
    await glimmerTest(String.raw`
hf = os.path.join(BASE, "hf")
locks = os.path.join(hf, "hub", ".locks", "models--unsloth--Muse-Glimmer-30B-unsloth-bnb-4bit")
os.makedirs(locks)
for name in ("stale.lock", "fresh.lock", "old.incomplete"):
    open(os.path.join(locks, name), "w").close()
old(os.path.join(locks, "stale.lock"), g.HF_LOCK_STALE_SECONDS + 5)
old(os.path.join(locks, "old.incomplete"), g.HF_LOCK_STALE_SECONDS + 5)
ctx = FakeCtx("job-b")
assert g.remove_stale_hf_locks(ctx, hf) == 1
assert sorted(os.listdir(locks)) == ["fresh.lock", "old.incomplete"]
assert ctx.logs == ["Removed 1 Hugging Face download lock nobody took for an hour"], ctx.logs
assert g.remove_stale_hf_locks(ctx, os.path.join(ROOT, "nowhere")) == 0
`);
  });

  it("marks a reused venv broken only when the child couldn't import a module from it, and never deletes it", async () => {
    await glimmerTest(String.raw`
make_venv(VENV, "job-a")
p = {"max_steps": 10, "learning_rate": 0.0002, "lora_rank": 8}
missing = "Traceback (most recent call last):\nModuleNotFoundError: No module named 'unsloth_zoo'"


def child(code, out, kinds=(), timed_out=False):
    def fake(ctx, cmd, timeout, env, seen=None):
        seen.update(kinds)
        return Done(code, out, timed_out=timed_out)

    return fake


def attempt(job):
    ctx = FakeCtx(job)
    raises(lambda: g.real_run(ctx, p, BASE, "t", "e", "a", time.time(), None), "before the base model answered")
    return ctx


seen = set()
ctx = FakeCtx("job-r")
g.relay(ctx, seen)("\r 10%|# | junk" + g.EVENT_PREFIX + json.dumps({"kind": "imported"}))
assert seen == {"imported"} and ctx.progresses == []

for fake in (
    child(1, missing, kinds=("imported",)),
    child(-9, missing, timed_out=True),
    child(1, "ImportError: libcuda.so.1: cannot open shared object file"),
):
    g.run_child = fake
    attempt("job-b")
    assert g.venv_ready(VENV), "a failure after the imports, a timeout or a driver problem leaves the venv in use"

g.run_child = child(1, missing)
ctx = attempt("job-b")
assert not g.venv_ready(VENV) and os.path.isfile(os.path.join(VENV, g.BROKEN_MARKER))
assert open(PYTHON).read() == "job-a", "nothing is deleted"
assert any("marked broken" in line for line in ctx.logs), ctx.logs

# The next job builds the venv again; the broken one is moved aside, not deleted, since a job may still run from it.
ctx = FakeCtx("job-c")
ctx.on_run = builder("job-c")
assert g.ensure_venv(ctx, BASE) == (PYTHON, False)
assert open(PYTHON).read() == "job-c"
asides = [n for n in os.listdir(VENVS) if ".stale-" in n]
assert len(asides) == 1 and open(os.path.join(VENVS, asides[0], "bin", "python")).read() == "job-a", asides
`);
  });

  it("stops training in time, uploads the adapter when the tuned answers failed, and fails clearly with no adapter", async () => {
    await glimmerTest(String.raw`
assert abs(g.train_stop_time(10000.0, 100.0) - (10000.0 - 130.0 - g.SAVE_RESERVE_SECONDS)) < 1e-6
now = [0.0]
clock = g.StopClock(50.0, clock=lambda: now[0])
assert clock.check(3, 10) is False
now[0] = 50.0
assert clock.check(4, 10) is True and clock.stopped_at == 4
now[0] = 60.0
assert clock.check(5, 10) is True and clock.stopped_at == 4
assert g.StopClock(0.0, clock=lambda: 100.0).check(10, 10) is False, "the last step needs no stop"

result_path = os.path.join(ROOT, "result.json")
g.write_result(result_path, {"base": ["x"]})
assert g.read_result(result_path) == {"base": ["x"]} and not os.path.exists(result_path + ".part")
assert g.read_result(os.path.join(ROOT, "missing.json")) is None

adapter = os.path.join(BASE, "models", "job-f")
os.makedirs(adapter)
with open(os.path.join(adapter, "adapter_config.json"), "w") as f:
    f.write("{}")
evals = [{"prompt": "p0", "reference": "r0"}, {"prompt": "p1", "reference": "r1"}]
train = [{"messages": []}] * 3
p = {"dry_run": False, "lora_rank": 16}
metrics = {"train_loss_final": 1.25, "steps": 40, "max_steps": 120, "stopped_early": "yes"}

ctx = FakeCtx("job-f")
done = {"base": ["b0", "b1"], "tuned": ["t0", "t1"], "metrics": dict(metrics), "adapter": True}
out = g.finish(ctx, p, done, evals, train, adapter, True)
expected = "LoRA r=16 on Muse Glimmer 30B, 40 of 120 steps (stopped early to finish within the time limit), final loss 1.25, 2 eval items."
assert out["summary"] == expected, out["summary"]
assert ctx.evals == [[0, "b0", "t0"], [1, "b1", "t1"]]
assert out["adapter_uploaded"] == "yes" and out["eval_items"] == 2

ctx = FakeCtx("job-f")
partial = {"base": ["b0", "b1"], "tuned": None, "metrics": dict(metrics), "adapter": True, "tuned_error": "OutOfMemoryError: CUDA out of memory", "ended": "exited with 0"}
error = raises(lambda: g.finish(ctx, p, partial, evals, train, adapter, True), "The adapter was saved (uploaded)")
assert "OutOfMemoryError" in error and "no eval items were sent" in error
assert ctx.evals == [] and ctx.uploads == [["glimmer-lora-job-f.tar.gz", "adapter"]]
assert any(line.startswith("Training finished: ") and '"steps": 40' in line for line in ctx.logs), ctx.logs

ctx = FakeCtx("job-f")
cut = {"base": ["b0", "b1"], "tuned": None, "metrics": {}, "adapter": False, "ended": "timed out", "tail": "step 30 of 120"}
error = raises(lambda: g.finish(ctx, p, cut, evals, train, adapter, True), "Training didn't finish (the child timed out), so no adapter was saved")
assert "step 30 of 120" in error
assert ctx.evals == [] and ctx.uploads == []
`);
  });

  it("trains the answers on the final channel with no reasoning, and opens that channel in the eval prompts", async () => {
    await glimmerTest(String.raw`${FAKE_GLIMMER}
tok = FakeTokenizer()
assert tok.apply_chat_template(GULLS, add_generation_prompt=False, reasoning_strength="low") == REAL_TRAIN_TEXT
assert tok.apply_chat_template(GULLS[:2], add_generation_prompt=True, reasoning_strength="low").endswith(REAL_PROMPT_END)
assert g.GENERATION_PROMPT + g.FINAL_CHANNEL == g.RESPONSE_PART and g.FINAL_CHANNEL == " to=user<|message|>"

text = g.training_text(tok, GULLS, tok.bos_token)
assert text == REAL_TRAIN_TEXT[len(tok.bos_token):] and "to=self" not in text
assert text.count(g.INSTRUCTION_PART) == 1 and text.count(g.RESPONSE_PART) == 1
# The template's own generation prompt stops at "<|start|>assistant" and leaves the channel to the model.
assert g.render(tok, GULLS[:2], True, tok.bos_token).endswith(g.GENERATION_PROMPT)
prompt = g.eval_prompt(tok, GULLS[:2], tok.bos_token)
# The eval prompt is the training text up to the answer, so the model answers just where training taught it to.
assert text.startswith(prompt) and text[len(prompt):] == "**Name:** Gull Counter<|eot|>", prompt

other = FakeTokenizer(assistant_header="<|start|>assistant<|message|>")
error = raises(lambda: g.training_text(other, GULLS, other.bos_token), "The chat template didn't render this assistant message right after " + g.RESPONSE_PART)
assert "count gulls" in error, "the error shows the rendered text"


class NoPrompt(FakeTokenizer):
    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False, reasoning_strength=None):
        return FakeTokenizer.apply_chat_template(self, messages, reasoning_strength=reasoning_strength)


raises(lambda: g.eval_prompt(NoPrompt(), GULLS[:2], tok.bos_token), "The chat template's generation prompt doesn't end with <|start|>assistant")
`);
  });

  it("checks the masks: every example trains on some tokens, starting with its answer, or the job fails clearly", async () => {
    await glimmerTest(String.raw`${FAKE_GLIMMER}
tok = FakeTokenizer()
prefix = "<|start|>user<|message|>q<|eot|>" + g.RESPONSE_PART


def row(answer, shift=0, cut=None):
    ids = tok.encode(prefix + answer + "<|eot|>")[:cut]
    at = len(tok.encode(prefix)) + shift
    return {"input_ids": ids, "labels": [-100] * at + ids[at:]}


assert g.check_masking([row("Name: A"), row("Name: Bee")], ["Name: A", "Name: Bee"], tok.decode) == [8, 10]
# An answer max_seq_length cut short still starts the span.
assert g.check_masking([row("Name: A long answer", cut=len(tok.encode(prefix)) + 4)], ["Name: A long answer"], tok.decode) == [4]
none = {"input_ids": tok.encode(prefix + "A"), "labels": [-100] * len(tok.encode(prefix + "A"))}
error = raises(lambda: g.check_masking([row("A"), none], ["A", "A"], tok.decode), "Training example 1 has no trained tokens after train_on_responses_only: " + g.RESPONSE_PART + " wasn't found in its")
error = raises(lambda: g.check_masking([row("Name: A", shift=-3)], ["Name: A"], tok.decode), "Training example 0 trains on the wrong text")
assert '"er<|message|>Name: A' in error, "the span takes in the marker's end: " + error
raises(lambda: g.check_masking([row("Name: A", shift=2)], ["Name: A"], tok.decode), 'its first trained span starts "me: A<|eot|>", not with its answer "Name: A"')
raises(lambda: g.check_masking([row("A")], ["A", "B"], tok.decode), "The trainer holds 1 training examples, not the 2 written")
raises(lambda: g.check_masking([{"input_ids": [1]}], ["A"], tok.decode), "left no labels on training example 0")

assert g.trained_spans([-100, 5, 6, -100, 7]) == [(1, 3), (4, 5)] and g.trained_spans([-100]) == []
marked = g.marked_text(row("Name: A")["input_ids"], row("Name: A")["labels"], tok.decode)
assert marked == prefix + g.TRAIN_OPEN + "Name: A<|eot|>" + g.TRAIN_CLOSE, marked
line = g.example_diagnosis(row("Name: A"), tok.decode)
assert line == "First training example: 8 trained tokens of " + str(len(row("Name: A")["input_ids"])) + ", between [train] and [/train]:\n" + marked, line
long = g.example_diagnosis(row("x" * 5000), tok.decode)
assert len(long) < 1700 and " [...] " in long and long.endswith("x<|eot|>[/train]"), "kept short, with the answer's end"
`);
  });

  it("keeps an unfinished answer's raw text, marked for the judge, and cuts a finished one at its end", async () => {
    await glimmerTest(String.raw`
assert g.final_answer("Name: Gull Counter<|eot|>" + g.PAD_TOKEN * 3) == ("Name: Gull Counter", True)
assert g.final_answer("  Answer\n<|end_of_text|>") == ("Answer", True)
assert g.final_answer("Draft<|eom|><|start|>assistant to=user<|message|>Other<|eot|>") == ("Draft", True)
assert g.UNFINISHED == "[Unfinished: no complete final answer within 1024 new tokens. The raw output follows, with only the chat template's control tokens taken out.]"
# The token budget ran out mid-answer.
assert g.final_answer("Name: Gull Counter\nFlow: 1. Upload") == (g.UNFINISHED + "\n\nName: Gull Counter\nFlow: 1. Upload", False)
# The model left the final channel for reasoning and never came back: only the control tokens go.
raw = "<|start|>assistant to=self<|message|>Let me think<|eom|><|start|>assistant to=user<|message|>Name: X"
assert g.final_answer(raw) == (g.UNFINISHED + "\n\nassistant to=self\nLet me think\n\nassistant to=user\nName: X", False), g.final_answer(raw)
assert g.final_answer("<|eot|>" + g.PAD_TOKEN) == (g.UNFINISHED, False), "an empty answer"
assert g.strip_control("<|begin_of_text|>a<|message|>b" + g.PAD_TOKEN + "c<|end_of_text|>") == "a\nbc"
assert g.clip("abcdefghij", 8) == "ab [...] efghij" and g.clip("abc", 8) == "abc"

# The summary says when answers were unfinished.
adapter = os.path.join(BASE, "models", "job-u")
os.makedirs(adapter)
p = {"dry_run": False, "lora_rank": 16, "student_prompt": "short", "student_system": "You are X."}
done = {"base": ["b0"], "tuned": [g.UNFINISHED], "metrics": {"steps": 3, "base_unfinished": 0, "tuned_unfinished": 1}, "adapter": True}
out = g.finish(FakeCtx("job-u"), p, done, [{"prompt": "p0", "reference": "r0"}], [{"messages": []}], adapter, True)
assert out["summary"] == "LoRA r=16 on Muse Glimmer 30B, 3 steps, 1 eval items (unfinished answers: base 0, tuned 1).", out["summary"]
assert out["student_prompt"] == "short" and out["student_system"] == "You are X."
`);
  });

  it("answers under a short student prompt by default, or under the dataset's full task prompt", async () => {
    await glimmerTest(String.raw`
for given, want in ((None, "short"), ("", "short"), (" FULL ", "full"), ("short", "short")):
    params = {"datasetId": "ds"} if given is None else {"datasetId": "ds", "studentPrompt": given}
    assert g.read_params(params)["student_prompt"] == want, given
try:
    g.read_params({"datasetId": "ds", "studentPrompt": "long"})
    raise AssertionError("no ValueError")
except ValueError as e:
    assert str(e) == 'studentPrompt must be short or full, not "long"', str(e)

own = g.TASK_PROMPT_START + "Write a product brief for a Muse Muse app.\n\nAnswer the user's message directly."
assert g.student_system("Muse Muse's brief writer", own) == "You are Muse Muse's brief writer."
assert g.student_system("  You are   a calm tutor. ") == "You are a calm tutor."
assert g.student_system("Muse Muse brief writer", own) == "You are the Muse Muse brief writer."
for title in (None, "", "x" * 81, "Write a product brief for a Muse"):
    assert g.student_system(title, own) == "You are a helpful assistant.", title

g.ensure_venv = lambda ctx, base: ("/venv/bin/python", True)
seen = {}


def fake_child(ctx, cmd, timeout, env, kinds=None):
    cfg = json.load(open(shlex.split(cmd)[-1]))
    seen.update(cfg=cfg, train=g.read_jsonl(cfg["train_path"]))
    os.makedirs(cfg["adapter_dir"], exist_ok=True)
    g.write_result(cfg["result_path"], {"base": ["b0"], "tuned": ["t0"], "metrics": {"steps": 3}, "adapter": True})
    return Done(0)


g.run_child = fake_child


def convo(i, system=None):
    head = [{"role": "system", "content": system}] if system else []
    return {"messages": head + [{"role": "user", "content": "q" + str(i)}, {"role": "assistant", "content": "a" + str(i)}]}


def job(mode, train, title="Muse Muse's brief writer"):
    ctx = FakeCtx("job-" + str(mode))
    ctx.cache_dir = BASE
    ctx.params = {"datasetId": "ds-1"} if mode is None else {"datasetId": "ds-1", "studentPrompt": mode}
    ctx.data = {"train": train, "eval": [{"prompt": "e0", "reference": "r0"}]}
    ctx.dataset_title = title
    return ctx, g.run(ctx)


short = "You are Muse Muse's brief writer."
size = " (" + str(len(own)) + " characters)"
ctx, out = job(None, [convo(i, own) for i in range(3)])
assert seen["cfg"]["system"] == short, "both models answer under the short line"
assert seen["train"] == [convo(i, short) for i in range(3)], seen["train"]
assert out["student_prompt"] == "short" and out["student_system"] == short
assert ctx.logs[0] == (
    "dataset ds-1: 3 training conversations, 1 eval prompts. Student prompt short: training and both models' answers"
    ' use the system message "You are Muse Muse\'s brief writer." in place of the dataset\'s task prompt' + size
), ctx.logs[0]
assert ctx.evals == [[0, "b0", "t0"]], "the teacher's reference is sent as it was"

# Conversations with different system messages, or none: each gets the one short line.
ctx, out = job("short", [convo(0, "one"), convo(1)], title=None)
assert seen["cfg"]["system"] == "You are a helpful assistant." and seen["train"] == [convo(0, "You are a helpful assistant."), convo(1, "You are a helpful assistant.")]
assert ctx.logs[0].endswith("in place of the dataset's task prompt"), ctx.logs[0]

ctx, out = job("full", [convo(i, own) for i in range(3)])
assert seen["cfg"]["system"] == own and seen["train"] == [convo(i, own) for i in range(3)], "as the dataset has them"
assert out["student_prompt"] == "full" and out["student_system"] == "the dataset's own" + size
assert ctx.logs[0].endswith("Student prompt full: training keeps the dataset's task prompt" + size + ", and both models answer under it")

ctx, out = job("full", [convo(0, "one"), convo(1, "two")])
assert seen["cfg"]["system"] is None and seen["train"] == [convo(0, "one"), convo(1, "two")] and out["student_system"] == "none"
assert ctx.logs[0].endswith("Student prompt full: training keeps the dataset's system messages, which differ, so both models answer with none")
`);
  });

  it("runs the child on fake Unsloth: masks checked, the final channel, 1,024 new tokens, unfinished answers and diagnostics", async () => {
    await glimmerTest(String.raw`${FAKE_GLIMMER}
SYSTEM = "You are Muse Muse's brief writer."
TRAIN = [
    {"messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "q" + str(i)}, {"role": "assistant", "content": "**Name:** Brief " + str(i)}]}
    for i in range(3)
]
EVALS = [{"prompt": "e0", "reference": "r0"}, {"prompt": "e1", "reference": "r1"}]
THINKING = "Thinking it over. " * 100


def replies(prompt, tuned):
    if not tuned:
        return "Base answer to " + prompt + "<|eot|>"
    # 1,800 characters that never close the answer, so 1,024 new tokens cut them off.
    return THINKING if prompt == "e0" else "Tuned answer to " + prompt + "<|eot|>"


state = install_fakes(replies)
cfg, error = child_run(TRAIN, EVALS, SYSTEM)
assert error is None, error
result = g.read_result(cfg["result_path"])
assert result["base"] == ["Base answer to e0", "Base answer to e1"], result["base"]
assert result["tuned"][1] == "Tuned answer to e1" and result["adapter"] is True
assert result["tuned"][0] == g.UNFINISHED + "\n\n" + THINKING[:1024].strip(), result["tuned"][0]
answer_tokens = len("**Name:** Brief 0") + 2
m = result["metrics"]
assert m["base_unfinished"] == 0 and m["tuned_unfinished"] == 1 and m["max_new_tokens"] == 1024, m
assert m["trained_tokens_min"] == answer_tokens and m["trained_tokens_mean"] == answer_tokens, m

# Both passes ask for 1,024 new tokens, and every prompt ends on the final channel, under the system message given.
calls = state["model"].calls
assert [c["max_new_tokens"] for c in calls] == [1024, 1024] and [c["tuned"] for c in calls] == [False, True]
for call in calls:
    for p in call["prompts"]:
        assert p.startswith("<|begin_of_text|><|start|>system<|message|>" + SYSTEM + "\n\nReasoning strength: low.") and p.count("<|begin_of_text|>") == 1, p
        assert p.endswith(g.RESPONSE_PART) and "to=self" not in p, p

# Each training text is the template's, with its answer on the final channel and only the answer trained.
assert state["masked"] == [[g.INSTRUCTION_PART, g.RESPONSE_PART]]
for row, convo in zip(state["rows"], TRAIN):
    answer = convo["messages"][2]["content"]
    assert row["text"].endswith(g.RESPONSE_PART + answer + "<|eot|>") and not row["text"].startswith("<|begin_of_text|>"), row["text"]
    assert "to=self" not in row["text"]
    trained = [t for t, label in zip(row["input_ids"], row["labels"]) if label != -100]
    assert state["tokenizer"].decode(trained) == answer + "<|eot|><|end_of_text|>"

lines = logs()
assert lines[0] == "Base model's raw output for eval item 0 (first 600 characters): Base answer to e0<|eot|>", lines[0]
assert lines[1].startswith("First training example: " + str(answer_tokens) + " trained tokens of "), lines[1]
assert g.RESPONSE_PART + "[train]**Name:** Brief 0<|eot|><|end_of_text|>[/train]" in lines[1], lines[1]
assert lines[2] == "Tuned model's raw output for eval item 0 (first 600 characters): " + THINKING[:600], lines[2]
assert len(lines) == 3, lines
# The parent turns each of them into one job log line.
ctx = FakeCtx("job-l")
hook = g.relay(ctx)
for event in EVENTS:
    hook(g.EVENT_PREFIX + json.dumps(event))
assert ctx.logs == lines and any(p["message"] == "Training for 3 steps" for p in ctx.progresses)

# Unsloth looking for a marker the tokens don't hold: nothing would train, so the child stops before training, with
# the first example in the log.
state = install_fakes(replies, marker_prefix=" ")
cfg, error = child_run(TRAIN, EVALS, SYSTEM)
assert error is not None and error.startswith("Training example 0 has no trained tokens after train_on_responses_only: " + g.RESPONSE_PART), error
assert [c["tuned"] for c in state["model"].calls] == [False], "the base answers only"
assert logs()[1].startswith("First training example: 0 trained tokens of ") and "[train]" not in logs()[1].split("\n", 1)[1], logs()
result = g.read_result(cfg["result_path"])
assert result["adapter"] is False and len(result["base"]) == 2

# Spans that start a token late train on the wrong text.
state = install_fakes(replies, shift=1)
cfg, error = child_run(TRAIN, EVALS, SYSTEM)
assert error is not None and error.startswith("Training example 0 trains on the wrong text") and '"*Name:** Brief 0' in error, error

# A template that doesn't put the answers after RESPONSE_PART fails before a single answer is paid for.
state = install_fakes(replies, tokenizer=FakeTokenizer(assistant_header="<|start|>assistant<|message|>"))
cfg, error = child_run(TRAIN, EVALS, SYSTEM)
assert error is not None and error.startswith("The chat template didn't render this assistant message right after " + g.RESPONSE_PART), error
assert state["model"].calls == [] and g.read_result(cfg["result_path"]) is None
`);
  });
});

describe("runner.py against a fake platform", { skip: hasPython ? false : "python3 is missing", timeout: 240_000 }, () => {
  it("runs the smoke recipe: heartbeat, progress, log, then done with metrics", async () => {
    const r = await runJob(SMOKE_PY, { allowNoGpu: true, tickSeconds: 1 });
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assertAuthorized(r.token);
    assertTokenNotPrinted(r);

    const evs = events();
    const types = evs.map((e) => e.type);
    assert.equal(types[0], "heartbeat");
    assert.equal(types.at(-1), "done");
    assert.ok(types.filter((t) => t === "heartbeat").length >= 2, `the heartbeat thread ran: ${types.join(",")}`);
    assert.equal(types.filter((t) => t === "progress").length, 3);
    assert.ok(types.includes("log"));
    assert.ok(types.indexOf("heartbeat") < types.indexOf("progress"));
    assert.ok(types.lastIndexOf("progress") < types.indexOf("done"));
    assert.equal(types.filter((t) => t === "done").length, 1);
    assert.ok(!types.includes("failed"));

    const steps = evs.filter((e) => e.type === "progress").map((e) => e.step);
    assert.deepEqual(steps, [1, 2, 3]);
    for (const e of evs.filter((x) => x.type === "progress")) assert.equal(e.totalSteps, 3);

    const done = evs.at(-1) as { summary?: string; metrics: Record<string, unknown> };
    assert.equal(typeof done.summary, "string");
    assert.ok(!("summary" in done.metrics), "summary is lifted out of the metrics");
    for (const key of ["missing", "disk_free_gb", "disk_total_gb", "gpu_count", "torch", "net_huggingface_co", "net_pypi_org"]) {
      assert.ok(key in done.metrics, `metrics has ${key}`);
    }
    for (const v of Object.values(done.metrics)) assert.ok(typeof v === "string" || typeof v === "number");
    assert.ok(typeof done.metrics.disk_free_gb === "number" && done.metrics.disk_free_gb > 0);
  });

  it("posts failed with the end of the traceback when the recipe raises", async () => {
    const recipe = [
      "def run(ctx):",
      "    ctx.progress(step=1, total_steps=2, message='about to fail')",
      "    raise ValueError('boom ' + 'x' * 5000)",
      "",
    ].join("\n");
    const r = await runJob(recipe, {});
    assert.equal(r.code, 1);
    assertAuthorized(r.token);
    assertTokenNotPrinted(r);
    const evs = events();
    const types = evs.map((e) => e.type);
    assert.equal(types[0], "heartbeat");
    assert.equal(types.at(-1), "failed");
    assert.ok(!types.includes("done"));
    const error = String(evs.at(-1)?.error);
    assert.ok(error.includes("ValueError"));
    assert.ok(Buffer.byteLength(error, "utf8") <= 3072);
  });

  it("posts failed when recipe.py has no run(ctx)", async () => {
    const r = await runJob("VALUE = 1\n", {});
    assert.equal(r.code, 1);
    assertTokenNotPrinted(r);
    const last = events().at(-1);
    assert.equal(last?.type, "failed");
    assert.ok(String(last?.error).includes("has no run(ctx)"));
  });

  it("blanks the token when a recipe logs it, runs a command with it or returns it", async () => {
    const recipe = [
      "import json, os",
      "def run(ctx):",
      "    here = os.path.dirname(os.path.abspath(__file__))",
      "    token = json.load(open(os.path.join(here, 'job.json')))['token']",
      "    ctx.log('log ' + token)",
      "    out = ctx.run('echo ' + token)",
      "    ctx.progress(message='progress ' + token)",
      "    return {'t': token, 'exit': out.returncode, 'summary': 'summary ' + token}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {});
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assertTokenNotPrinted(r);
    const evs = events();
    assert.ok(!JSON.stringify(evs).includes(r.token));
    assert.ok(evs.some((e) => e.type === "log" && String(e.text).includes("[job token]")));
    const done = evs.at(-1) as { summary: string; metrics: Record<string, unknown> };
    assert.deepEqual(done.metrics, { t: "[job token]", exit: 0 });
    assert.equal(done.summary, "summary [job token]");
  });

  it("returns None and logs when the platform has no storage", async () => {
    const recipe = [
      "import os",
      "def run(ctx):",
      "    p = os.path.join(ctx.work_dir, 'a.bin')",
      "    open(p, 'wb').write(b'abc')",
      "    url = ctx.upload(p, 'a.bin', 'adapter')",
      "    return {'uploaded': 'no' if url is None else 'yes'}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {});
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    const evs = events();
    assert.ok(evs.some((e) => e.type === "log" && String(e.text).includes("storage not configured")));
    assert.ok(!evs.some((e) => e.type === "artifact"));
    assert.deepEqual((evs.at(-1) as { metrics: unknown }).metrics, { uploaded: "no" });
    assert.equal(hits.filter((h) => h.path.endsWith("/upload")).length, 1, "a 503 from /upload is not retried");
  });

  it("never follows a redirect, so the job token can't be sent anywhere else", async () => {
    uploadAnswer = { status: 302, location: "/stolen" };
    const recipe = [
      "import os",
      "def run(ctx):",
      "    p = os.path.join(ctx.work_dir, 'a.bin')",
      "    open(p, 'wb').write(b'abc')",
      "    ctx.upload(p, 'a.bin', 'adapter')",
      "    return {}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {});
    assert.equal(r.code, 1, "the upload fails, so the job fails");
    assert.equal(hits.filter((h) => h.path === "/stolen").length, 0, "the redirect was not followed");
    assert.equal(hits.filter((h) => h.path.endsWith("/upload")).length, 1, "a redirect is not retried");
    const failed = events().at(-1) as { type: string; error: string };
    assert.equal(failed.type, "failed");
    assert.match(failed.error, /HTTP 302/);
    assertTokenNotPrinted(r);
  });

  it("uploads like @vercel/blob put() with a client token, simple and multipart", async () => {
    uploadAnswer = { status: 200, body: { clientToken: BLOB_TOKEN, pathname: "models/test-job/adapter.safetensors" } };
    const small = Buffer.from("small adapter bytes");
    const big = randomBytes(10_000);
    const recipe = [
      "import os, shutil",
      "def run(ctx):",
      "    here = os.path.dirname(os.path.abspath(__file__))",
      "    a = ctx.upload(os.path.join(here, 'small.bin'), 'adapter.safetensors', 'adapter')",
      "    b = ctx.upload(os.path.join(here, 'big.bin'), 'checkpoint.bin', 'checkpoint')",
      "    return {'a': a, 'b': b}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {}, { blobApiUrl: `${base}/blob`, multipartOverBytes: 1024, partBytes: 4096 }, { "small.bin": small, "big.bin": big });
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assertAuthorized(r.token);
    assertTokenNotPrinted(r);
    assert.ok(!r.output.includes(BLOB_TOKEN), "the Blob client token isn't printed either");

    const grants = hits.filter((h) => h.path.endsWith("/upload")).map((h) => JSON.parse(h.body.toString("utf8")));
    assert.deepEqual(grants[0], { name: "adapter.safetensors", bytes: small.length, contentType: "application/octet-stream" });
    assert.deepEqual(grants[1], { name: "checkpoint.bin", bytes: big.length, contentType: "application/octet-stream" });

    const blobHits = hits.filter((h) => h.path.startsWith("/blob"));
    for (const h of blobHits) {
      assert.equal(h.headers.authorization, `Bearer ${BLOB_TOKEN}`);
      assert.equal(h.headers["x-api-version"], "13");
      assert.equal(h.headers["x-vercel-blob-access"], "public");
      assert.equal(h.headers["x-vercel-blob-store-id"], "storeABC");
      assert.equal(h.headers["x-content-type"], "application/octet-stream");
      assert.match(String(h.headers["x-api-blob-request-id"]), /^storeABC:\d+:[0-9a-f]+$/);
      assert.equal(h.headers["x-api-blob-request-attempt"], "0");
      assert.equal(h.query.get("pathname"), "models/test-job/adapter.safetensors");
    }

    const put = blobHits.find((h) => h.method === "PUT");
    assert.ok(put);
    assert.equal(put.path, "/blob/");
    assert.deepEqual(put.body, small);

    const mpu = blobHits.filter((h) => h.path === "/blob/mpu");
    const actions = mpu.map((h) => h.headers["x-mpu-action"]);
    assert.deepEqual(actions, ["create", "upload", "upload", "upload", "complete"]);
    const parts = mpu.filter((h) => h.headers["x-mpu-action"] === "upload");
    assert.deepEqual(parts.map((h) => h.headers["x-mpu-part-number"]), ["1", "2", "3"]);
    for (const h of [...parts, mpu.at(-1)!]) {
      assert.equal(h.headers["x-mpu-upload-id"], "upload-1");
      assert.equal(h.headers["x-mpu-key"], encodeURIComponent("models/test job/key"));
    }
    assert.deepEqual(Buffer.concat(parts.map((h) => h.body)), big);
    const complete = mpu.at(-1)!;
    assert.equal(complete.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(complete.body.toString("utf8")), [
      { partNumber: 1, etag: "etag-1" },
      { partNumber: 2, etag: "etag-2" },
      { partNumber: 3, etag: "etag-3" },
    ]);

    const artifacts = events().filter((e) => e.type === "artifact").map((e) => e.artifact);
    const url = "https://storeabc.public.blob.vercel-storage.com/models/test-job/adapter.safetensors";
    assert.deepEqual(artifacts, [
      { name: "adapter.safetensors", kind: "adapter", url, bytes: small.length },
      { name: "checkpoint.bin", kind: "checkpoint", url, bytes: big.length },
    ]);
    assert.deepEqual((events().at(-1) as { metrics: unknown }).metrics, { a: url, b: url });
  });
  it("declares a media type the platform takes, and octet-stream for any other", async () => {
    grantBodies = ["a", "b", "c", "d"].map((n) => ({ clientToken: BLOB_TOKEN, pathname: `models/test-job/${n}` }));
    const recipe = [
      "import os",
      "def run(ctx):",
      "    for name in ['notes.txt', 'scores.tsv', 'bundle.tar.gz', 'page.pdf']:",
      "        p = os.path.join(ctx.work_dir, name)",
      "        open(p, 'wb').write(b'abc')",
      "        ctx.upload(p, name, 'other')",
      "    return {}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {}, { blobApiUrl: `${base}/blob` });
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    const declared = hits.filter((h) => h.path.endsWith("/upload")).map((h) => JSON.parse(h.body.toString("utf8")).contentType);
    assert.deepEqual(declared, ["text/plain", "application/octet-stream", "application/octet-stream", "application/octet-stream"]);
    const sent = hits.filter((h) => h.method === "PUT").map((h) => h.headers["x-content-type"]);
    assert.deepEqual(sent, declared, "Blob gets the type the grant allows");
  });

  it("uploads once more under a fresh grant when Blob refuses a retried put", async () => {
    grantBodies = [
      { clientToken: BLOB_TOKEN, pathname: "models/test-job/first-a.bin" },
      { clientToken: BLOB_TOKEN, pathname: "models/test-job/second-a.bin" },
    ];
    // The first put may have stored the file before its 500; the retry finds the pathname taken.
    putAnswers = [
      { status: 500, body: { error: { code: "service_unavailable", message: "try again" } } },
      { status: 400, body: { error: { code: "bad_request", message: "This blob already exists" } } },
    ];
    const recipe = [
      "import os",
      "def run(ctx):",
      "    p = os.path.join(ctx.work_dir, 'a.bin')",
      "    open(p, 'wb').write(b'abc')",
      "    return {'url': ctx.upload(p, 'a.bin', 'adapter')}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {}, { blobApiUrl: `${base}/blob` });
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assert.equal(hits.filter((h) => h.path.endsWith("/upload")).length, 2, "one fresh grant");
    const puts = hits.filter((h) => h.method === "PUT");
    assert.deepEqual(
      puts.map((h) => [h.query.get("pathname"), h.headers["x-api-blob-request-attempt"]]),
      [
        ["models/test-job/first-a.bin", "0"],
        ["models/test-job/first-a.bin", "1"],
        ["models/test-job/second-a.bin", "0"],
      ],
    );
    const url = "https://storeabc.public.blob.vercel-storage.com/models/test-job/second-a.bin";
    assert.deepEqual(events().filter((e) => e.type === "artifact").map((e) => (e.artifact as { url: string }).url), [url]);
    assertTokenNotPrinted(r);
    assert.ok(!r.output.includes(BLOB_TOKEN));
  });

  it("fails the upload, with no second grant, when Blob refuses the first put", async () => {
    grantBodies = [{ clientToken: BLOB_TOKEN, pathname: "models/test-job/a.bin" }];
    putAnswers = [{ status: 400, body: { error: { code: "bad_request", message: "Content type mismatch" } } }];
    const recipe = [
      "import os",
      "def run(ctx):",
      "    p = os.path.join(ctx.work_dir, 'a.bin')",
      "    open(p, 'wb').write(b'abc')",
      "    ctx.upload(p, 'a.bin', 'adapter')",
      "    return {}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {}, { blobApiUrl: `${base}/blob` });
    assert.equal(r.code, 1);
    assert.equal(hits.filter((h) => h.path.endsWith("/upload")).length, 1);
    const failed = events().at(-1) as { type: string; error: string };
    assert.equal(failed.type, "failed");
    assert.match(failed.error, /Vercel Blob refused the upload \(HTTP 400, bad_request\)/);
  });

  it("pages the dataset with the job token, retries a 503 and refuses a redirect", async () => {
    datasetPages = {
      train: [
        { items: [{ n: 1 }, { n: 2 }], nextPage: 1 },
        { items: [{ n: 3 }], nextPage: null },
      ],
      eval: [{ items: [], nextPage: null }],
    };
    datasetFailures = [{ status: 503 }];
    const recipe = [
      "def run(ctx):",
      "    train = ctx.dataset('train')",
      "    evals = ctx.dataset('eval')",
      "    try:",
      "        ctx.get_json('/dataset?part=none&page=0')",
      "        missing = 'none'",
      "    except Exception as e:",
      "        missing = type(e).__name__ + ' ' + str(getattr(e, 'status', ''))",
      "    try:",
      "        ctx.dataset('test')",
      "        bad = 'none'",
      "    except ValueError:",
      "        bad = 'ValueError'",
      "    return {'train': ','.join(str(i['n']) for i in train), 'evals': len(evals), 'missing': missing, 'bad': bad}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {});
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assertAuthorized(r.token);
    assertTokenNotPrinted(r);
    const gets = hits.filter((h) => h.method === "GET");
    assert.deepEqual(
      gets.map((h) => `${h.query.get("part")}:${h.query.get("page")}`),
      ["train:0", "train:0", "train:1", "eval:0", "none:0"],
      "the 503 was retried, then each page asked for once",
    );
    assert.deepEqual((events().at(-1) as { metrics: unknown }).metrics, { train: "1,2,3", evals: 0, missing: "PlatformError 404", bad: "ValueError" });

    hits = [];
    datasetFailures = [{ status: 302, location: "/stolen" }];
    const again = await runJob("def run(ctx):\n    return {'n': len(ctx.dataset('train'))}\n", {});
    assert.equal(again.code, 1);
    assert.equal(hits.filter((h) => h.path === "/stolen").length, 0, "the redirect was not followed");
    assert.match(String((events().at(-1) as { error: string }).error), /HTTP 302 to GET \/dataset$/m);
  });

  it("posts eval items with each field cut to 3,500 characters, at most 60 a job", async () => {
    const recipe = [
      "def run(ctx):",
      "    ok = ctx.eval(0, 'p' * 5000, 'r', 'b' * 10, 't' * 3500)",
      "    sent = 1",
      "    for i in range(1, 70):",
      "        if ctx.eval(i, 'p', 'r', 'b', 't'):",
      "            sent += 1",
      "    big = ctx.eval(99, 'é' * 3500, 'é' * 3500, 'é' * 3500, 'é' * 3500)",
      "    return {'first': 'yes' if ok else 'no', 'sent': sent, 'big': 'yes' if big else 'no'}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {});
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    const evs = events().filter((e) => e.type === "eval") as Array<{ index: number; prompt: string; reference: string; base: string; tuned: string }>;
    assert.equal(evs.length, 60);
    assert.deepEqual(evs[0], { type: "eval", index: 0, prompt: "p".repeat(3500), reference: "r", base: "b".repeat(10), tuned: "t".repeat(3500) });
    assert.deepEqual(evs.map((e) => e.index), [...Array(60).keys()]);
    assert.deepEqual((events().at(-1) as { metrics: unknown }).metrics, { first: "yes", sent: 60, big: "no" });
    for (const h of hits.filter((x) => x.path.endsWith("/events"))) assert.ok(h.body.length <= 16 * 1024);
  });

  it("keeps eval bodies under the callback limit when the text is multibyte", async () => {
    const recipe = "def run(ctx):\n    return {'ok': 'yes' if ctx.eval(3, 'é' * 3500, '中' * 3500, 'b' * 3500, 't' * 3500) else 'no'}\n";
    const r = await runJob(recipe, {});
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    const hit = hits.find((h) => h.path.endsWith("/events") && JSON.parse(h.body.toString("utf8")).type === "eval");
    assert.ok(hit && hit.body.length <= 15000);
    const body = JSON.parse(hit.body.toString("utf8"));
    assert.equal(body.index, 3);
    for (const key of ["prompt", "reference", "base", "tuned"]) assert.ok(body[key].length <= 3500 && body[key].length > 0, key);
  });

  it("runs commands with extra env and hands each line to on_line, which can't break the run", async () => {
    const recipe = [
      "def run(ctx):",
      "    seen = []",
      "    def on_line(line):",
      "        if line == 'boom':",
      "            raise ValueError('bad line')",
      "        seen.append(line)",
      "    out = ctx.run('echo one; echo boom; echo \"two $MUSE_TEST_VALUE\"', env={'MUSE_TEST_VALUE': 'x1'}, on_line=on_line)",
      "    return {'seen': '|'.join(seen), 'exit': out.returncode}",
      "",
    ].join("\n");
    const r = await runJob(recipe, {});
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assert.deepEqual((events().at(-1) as { metrics: unknown }).metrics, { seen: "one|two x1", exit: 0 });
    assert.match(r.output, /on_line failed: ValueError/);
  });

  it("sets ctx.cache_dir to the mounted cacheDir, and to None when it is missing or not mounted", async () => {
    const cache = await mkdtemp(path.join(tmpdir(), "muse-cache-"));
    try {
      const recipe = "def run(ctx):\n    return {'cache': str(ctx.cache_dir)}\n";
      const metrics = async (extra: Record<string, unknown>) => {
        hits = [];
        const r = await runJob(recipe, {}, extra);
        assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
        return (events().at(-1) as { metrics: { cache: string } }).metrics.cache;
      };
      assert.equal(await metrics({}), "None");
      assert.equal(await metrics({ cacheDir: cache }), cache);
      assert.equal(await metrics({ cacheDir: path.join(cache, "not-mounted"), cacheWaitSeconds: 1 }), "None");
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("keeps only the text after a line's last carriage return, and says when its timeout killed a command", async () => {
    const recipe = String.raw`def run(ctx):
    seen = []
    ctx.run("printf 'bar 1\\rbar 2\\rdone\\nlast'", on_line=seen.append)
    slow = ctx.run("sleep 5", timeout=1)
    return {"seen": "|".join(seen), "timed_out": "yes" if slow.timed_out else "no", "code": slow.returncode}
`;
    const r = await runJob(recipe, {});
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assert.deepEqual((events().at(-1) as { metrics: unknown }).metrics, { seen: "done|last", timed_out: "yes", code: -9 });
  });

  it("sets ctx.deadline from job.json's deadlineEpoch, and to maxMinutes from now without one", async () => {
    const recipe = "def run(ctx):\n    return {'deadline': ctx.deadline}\n";
    const deadline = async (extra: Record<string, unknown>) => {
      hits = [];
      const r = await runJob(recipe, {}, extra);
      assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
      return (events().at(-1) as { metrics: { deadline: number } }).metrics.deadline;
    };
    assert.equal(await deadline({ deadlineEpoch: 2_000_000_000 }), 2_000_000_000);
    const now = Date.now() / 1000;
    const fallback = await deadline({});
    assert.ok(Math.abs(fallback - (now + 5 * 60)) < 60, `${fallback} is about 5 minutes from now`);
  });

  it("relays the glimmer child's events on their own pipe, whatever a progress bar does on stderr", async () => {
    const child = String.raw`import importlib.util, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("glimmer", os.path.join(here, "glimmer.py"))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
assert g.event_fd() is not None, "the runner gave the child an event pipe"
# What a tqdm bar does on stderr: a redraw with no newline, just before each event.
sys.stderr.write("\r 33%|###       | 10/30 [00:05<00:10]")
sys.stderr.flush()
g.emit("progress", step=10, total=30, loss=1.5)
sys.stderr.write("\r 50%|#####     | 15/30 [00:07<00:07]")
sys.stderr.flush()
g.emit("phase", message="Halfway")
time.sleep(0.5)
# Without the pipe an event falls back to stdout, glued after the bar, and still gets through.
del os.environ["MUSE_EVENT_FD"]
sys.stderr.write("\r 66%|######    | 20/30 [00:10<00:05]")
sys.stderr.flush()
g.emit("progress", step=20, total=30, loss=1.25)
sys.stderr.write("\r100%|##########| 30/30 [00:15<00:00]\n")
`;
    const recipe = String.raw`import importlib.util, os, sys
here = os.path.dirname(os.path.abspath(__file__))
def run(ctx):
    spec = importlib.util.spec_from_file_location("glimmer", os.path.join(here, "glimmer.py"))
    g = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(g)
    out = g.run_child(ctx, sys.executable + " -u " + os.path.join(here, "child.py"), 60, {})
    return {"exit": out.returncode}
`;
    const r = await runJob(recipe, {}, {}, { "glimmer.py": GLIMMER_PY, "child.py": child });
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    assert.deepEqual((events().at(-1) as { metrics: unknown }).metrics, { exit: 0 });
    assert.deepEqual(
      events().filter((e) => e.type === "progress"),
      [
        { type: "progress", step: 10, totalSteps: 30, loss: 1.5 },
        { type: "progress", message: "Halfway" },
        { type: "progress", step: 20, totalSteps: 30, loss: 1.25 },
      ],
    );
  });

  it("reports a watched command that goes quiet once, holds back heartbeats while it stays quiet, then resumes", async () => {
    const recipe = String.raw`import time
def run(ctx):
    ctx.run("for i in 1 2 3 4 5 6; do echo tick; sleep 0.5; done", stall_seconds=2)
    ctx.run("sleep 6", stall_seconds=2)
    time.sleep(3)
    return {}
`;
    const r = await runJob(recipe, {});
    assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
    const evs = events();
    const stalls = evs.flatMap((e, i) => (e.type === "log" && String(e.text).startsWith("Stalled:") ? [i] : []));
    assert.equal(stalls.length, 1, "one stall report, and none for the command that kept writing");
    assert.match(String(evs[stalls[0]].text), /^Stalled: no output for \d+ s from \$ sleep 6\. Heartbeats pause/);
    const ended = evs.findIndex((e) => e.type === "log" && String(e.text).startsWith("$ sleep 6\n"));
    assert.ok(ended > stalls[0], "reported while it ran");
    assert.equal(evs.slice(stalls[0], ended).filter((e) => e.type === "heartbeat").length, 0, "no heartbeat while it stayed quiet");
    const after = evs.slice(ended).filter((e) => e.type === "heartbeat");
    assert.equal(after[0]?.message, "No longer stalled");
    assert.ok(after.length >= 2, "heartbeats came back");
    assert.ok(evs.slice(0, stalls[0]).filter((e) => e.type === "heartbeat").length >= 3, "heartbeats ran while the first command wrote");
  });

  it("runs the glimmer-lora recipe with dryRun: dataset pages, progress, eval items, then done", async () => {
    const train = Array.from({ length: 5 }, (_, i) => ({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: `Question ${i}` },
        { role: "assistant", content: `Answer ${i}` },
      ],
    }));
    const evalItems = Array.from({ length: 3 }, (_, i) => ({ prompt: `Held-out prompt ${i}`, reference: `Reference ${i}` }));
    const title = "Muse Muse's brief writer";
    datasetPages = {
      train: [
        { items: train.slice(0, 3), nextPage: 1, title },
        { items: [...train.slice(3), { messages: "not a list" }], nextPage: null, title },
      ],
      eval: [
        { items: evalItems.slice(0, 2), nextPage: 1, title },
        { items: evalItems.slice(2), nextPage: null, title },
      ],
    };
    const cache = await mkdtemp(path.join(tmpdir(), "muse-cache-"));
    try {
      const params = { datasetId: "ds-1", maxSteps: 30, learningRate: 0.0002, loraRank: 8, dryRun: 1 };
      const r = await runJob(GLIMMER_PY, params, { recipe: "glimmer-lora", cacheDir: cache });
      assert.equal(r.code, 0, r.output.replaceAll(r.token, "[token]"));
      assertAuthorized(r.token);
      assertTokenNotPrinted(r);

      const gets = hits.filter((h) => h.method === "GET").map((h) => `${h.query.get("part")}:${h.query.get("page")}`);
      assert.deepEqual(gets, ["train:0", "train:1", "eval:0", "eval:1"]);

      const evs = events();
      const types = evs.map((e) => e.type);
      assert.equal(types[0], "heartbeat");
      assert.equal(types.at(-1), "done");
      assert.ok(!types.includes("failed"));
      const steps = evs.filter((e) => e.type === "progress" && e.step !== undefined);
      assert.deepEqual(steps.map((e) => e.step), [10, 20, 30]);
      for (const e of steps) {
        assert.equal(e.totalSteps, 30);
        assert.equal(typeof e.loss, "number");
      }

      const evals = evs.filter((e) => e.type === "eval") as Array<{ index: number; prompt: string; reference: string; base: string; tuned: string }>;
      assert.deepEqual(evals.map((e) => [e.index, e.prompt, e.reference]), evalItems.map((e, i) => [i, e.prompt, e.reference]));
      for (const e of evals) {
        assert.match(e.base, new RegExp(`^Dry run base answer ${e.index} \\([0-9a-f]{8}\\)$`));
        assert.match(e.tuned, new RegExp(`^Dry run tuned answer ${e.index} \\([0-9a-f]{8}\\)$`));
        assert.notEqual(e.base, e.tuned);
      }
      assert.ok(types.lastIndexOf("eval") < types.indexOf("done"), "eval items go before done");
      assert.ok(types.indexOf("eval") > types.lastIndexOf("progress") - 1);

      const done = evs.at(-1) as { summary: string; metrics: Record<string, unknown> };
      assert.match(done.summary, /^Dry run: LoRA r=8 on Muse Glimmer 30B, 30 steps, final loss [\d.]+, 3 eval items\.$/);
      for (const key of ["train_loss_final", "steps", "train_seconds", "peak_vram_gb", "eval_items", "cached_weights"]) {
        assert.ok(key in done.metrics, `metrics has ${key}`);
      }
      assert.equal(done.metrics.steps, 30);
      assert.equal(done.metrics.eval_items, 3);
      assert.equal(done.metrics.train_examples, 5, "the malformed conversation was skipped");
      const logs = evs.filter((e) => e.type === "log").map((e) => (e as { text: string }).text);
      assert.ok(
        logs.some((t) =>
          t.includes(
            `5 training conversations, 3 eval prompts. Student prompt short: training and both models' answers use the system message "You are ${title}." in place of the dataset's task prompt (9 characters)`,
          ),
        ),
        "the short student prompt, made from the dataset's title on its pages",
      );
      assert.equal(done.metrics.student_prompt, "short");
      assert.equal(done.metrics.student_system, `You are ${title}.`);
      assert.equal(done.metrics.cached_weights, "no");
      assert.equal(done.metrics.dry_run, "yes");
      assert.equal(done.metrics.cache_used, "yes");
      assert.equal(done.metrics.adapter_uploaded, "no", "the fake platform has no storage");
      assert.equal(done.metrics.adapter_dir, path.join(cache, "models", JOB_ID));
      assert.equal(hits.filter((h) => h.path.endsWith("/upload")).length, 1, "the adapter archive was offered for upload");

      // The same answers on a second run: the fakes are deterministic.
      const first = evals.map((e) => [e.base, e.tuned]);
      hits = [];
      const again = await runJob(GLIMMER_PY, params, { recipe: "glimmer-lora", cacheDir: cache });
      assert.equal(again.code, 0);
      assert.deepEqual(events().filter((e) => e.type === "eval").map((e) => [e.base, e.tuned]), first);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("fails the glimmer-lora recipe clearly when the job has no dataset", async () => {
    const r = await runJob(GLIMMER_PY, { datasetId: "ds-1", dryRun: 1 }, { recipe: "glimmer-lora" });
    assert.equal(r.code, 1);
    const failed = events().at(-1) as { type: string; error: string };
    assert.equal(failed.type, "failed");
    assert.match(failed.error, /PlatformError: The platform answered HTTP 404 to GET \/dataset$/m);
    assert.ok(!events().some((e) => e.type === "eval"));
  });
});
