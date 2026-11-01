/**
 * The rl-grpo recipe with made-up data: the flag's gates, the Python's problems and reward, its parent with a fake ctx
 * (dry run), its child on fake Unsloth, torch, datasets, transformers and trl, and lib/train/rl.ts. Nothing here reaches
 * Lambda, Meta, a GPU or the network, and real GRPO never runs.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/rl.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { offeredRecipes, recipeById, RECIPES, RL_GRPO_RECIPE } from "@/lib/train/recipes";
import { RL_PY } from "@/lib/train/recipes/rl";
import { isRlCardMetric, liveRewardCurve, parseRewardCurve, rlResults } from "@/lib/train/rl";
import type { TrainEventView } from "@/lib/train/types";

const HARNESS = String.raw`
import importlib.util, json, os, sys, types, tempfile
spec = importlib.util.spec_from_file_location("recipe", sys.argv[1])
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
out = {}

# Problems: no eval, held out never in training, and the same from the same seed.
held = g.make_problems(8, 40)
train = g.make_problems(7, 2000, avoid=[r["problem"] for r in held])
out["overlap"] = len(set(r["problem"] for r in held) & set(r["problem"] for r in train))
out["same"] = g.make_problems(8, 40) == held
out["forms"] = sorted(set(("(" in r["problem"]) for r in held))
# Each stated result checked by an independent reading of the text, in the test only.
out["results_right"] = all(eval(r["problem"], {"__builtins__": {}}) == r["answer"] for r in held + train)

# Reward.
s = g.score_answer
out["rewards"] = [
    s("3 * 4 = 12. <answer>12</answer>", 12), s("<answer> 1,234 </answer>", 1234), s("<answer>-5</answer>", -5),
    s("<answer>13</answer>", 12), s("12", 12), s("", 12), s("<answer>12</answer><answer>12</answer>", 12),
    s("<answer>twelve</answer>", 12), s("<answer>12.5</answer>", 12), s(None, 12),
]
out["reward_fn"] = g.arithmetic_reward(completions=["<answer>2</answer>", [{"role": "assistant", "content": "<answer>3</answer>"}]], answer=[2, 2], trainer_state=None, prompts=["a", "b"])

# Metrics stay under the platform's limit.
long_curve = [(i * 5, 0.123456) for i in range(1, 201)]
c = g.curve_metric(long_curve)
out["curve_len"] = len(c)
out["curve_ends"] = [c.split(",")[0], c.split(",")[-1]]
row = {"problem": "1 + 2", "answer": 3}
out["example_len"] = len(g.example_metric(row, '"\n' * 400, "é" * 400))
rows = [{"problem": str(i), "answer": i} for i in range(20)]
tag = lambda n: "<answer>" + str(n) + "</answer>"
before = [tag(i) if i >= 2 else tag(-1) for i in range(20)]
after = [tag(i) if i >= 18 or i < 2 else tag(-1) for i in range(20)]
picked = g.pick_examples(rows, before, after)
out["picked_has_worse"] = any(i >= 2 and i < 18 for i in picked)
out["picked_len"] = len(picked)

class Ctx:
    def __init__(self, params, folder):
        self.params, self.job_id, self.work_dir, self.cache_dir, self.max_minutes, self.deadline = params, "job-1", folder, None, 90, None
        self.events, self.uploads = [], []
    def log(self, text): self.events.append(["log", text])
    def progress(self, step=None, total_steps=None, loss=None, message=None): self.events.append(["progress", step, message])
    def upload(self, path, name, kind="other"):
        self.uploads.append([name, kind]); return "https://blob.example/" + name
    def eval(self, *a): raise AssertionError("rl-grpo must send no eval items")

folder = tempfile.mkdtemp()
ctx = Ctx({"dryRun": 1, "maxSteps": 20}, folder)
m = g.run(ctx)
out["dry"] = m
out["dry_uploads"] = ctx.uploads
out["longest_metric"] = max(len(v) for v in m.values() if isinstance(v, str))
out["metric_count"] = len(m)
out["params"] = g.rl_params({"maxSteps": 99999, "numGenerations": 1, "learningRate": "x"})

# No tuned answers: the job fails instead of showing half a comparison.
try:
    g.rl_finish(ctx, g.rl_params({}), {"base": ["x"] * 40, "tuned": None, "curve": [[5, 0.1]]}, g.make_problems(1, 40), folder, False)
    out["half"] = "no error"
except RuntimeError as e:
    out["half"] = str(e)

# The child on fakes.
calls = {}
class Cuda:
    def to(self, _): return self
    shape = (2, 3)
class FastModel:
    @staticmethod
    def from_pretrained(**k): calls["load"] = k; return Model(), Tok()
    @staticmethod
    def get_peft_model(model, **k): calls["peft"] = k; return model
    @staticmethod
    def for_inference(m): calls.setdefault("modes", []).append("inference")
    @staticmethod
    def for_training(m): calls.setdefault("modes", []).append("training")
class Tok:
    bos_token = "<|begin_of_text|>"; eos_token = "<|end_of_text|>"; pad_token = "<|pad|>"; pad_token_id = 0; padding_side = "right"
    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=True, reasoning_strength=None):
        return "<|begin_of_text|>" + messages[-1]["content"] + g.GENERATION_PROMPT
    def __call__(self, prompts, return_tensors=None, padding=None):
        calls["tokenized"] = list(prompts); self.n = len(prompts)
        return {"input_ids": Cuda(), "attention_mask": Cuda()}
    def decode(self, row, skip_special_tokens=False):
        calls["n"] = calls.get("n", 0) + 1
        return "<answer>1</answer><|eot|>junk" if not calls.get("trained") else "<answer>2</answer><|eot|>"
    def save_pretrained(self, d): pass
class Model:
    def generate(self, **k):
        calls["max_new"] = k["max_new_tokens"]; calls["do_sample"] = k["do_sample"]
        return [[0, 0, 0, 1]] * tok_batch()
    def save_pretrained(self, d):
        with open(os.path.join(d, "adapter_config.json"), "w") as f: json.dump({"base_model_name_or_path": "/tmp/x"}, f)
def tok_batch(): return len(calls["tokenized"])
class NoGrad:
    def __enter__(self): return self
    def __exit__(self, *a): return False
class Dataset:
    @staticmethod
    def from_list(rows): calls["rows"] = rows; return rows
class TrainerCallback: pass
class GRPOConfig:
    def __init__(self, **k): calls["config"] = k; self.k = k
class State: pass
class Control: should_training_stop = False
class GRPOTrainer:
    def __init__(self, model, reward_funcs, args, train_dataset, processing_class, callbacks): 
        calls["trainer"] = {"tok_eos": processing_class.eos_token, "side": processing_class.padding_side}
        self.cb = callbacks[0]; self.funcs = reward_funcs
    def train(self):
        calls["reward"] = self.funcs[0](completions=["<answer>7</answer>"], answer=[7], prompts=["p"])
        st = State(); ct = Control()
        for step, r in ((5, 0.2), (10, 0.4)):
            st.global_step = step
            self.cb.on_log(None, st, ct, logs={"reward": r, "loss": 1.5})
            self.cb.on_step_end(None, st, ct)
        calls["trained"] = True
def mod(name, **attrs):
    m = types.ModuleType(name); m.__dict__.update(attrs); sys.modules[name] = m
mod("unsloth", FastModel=FastModel)
mod("torch", no_grad=NoGrad, cuda=types.SimpleNamespace(empty_cache=lambda: None))
mod("datasets", Dataset=Dataset)
mod("transformers", TrainerCallback=TrainerCallback)
mod("trl", GRPOConfig=GRPOConfig, GRPOTrainer=GRPOTrainer)
class PeftModel:
    @staticmethod
    def from_pretrained(model, path, is_trainable=True): calls["fresh"] = {"saved": os.path.exists(os.path.join(path, "adapter_config.json")), "trainable": is_trainable}; return model
mod("peft", PeftModel=PeftModel)
sent = []
g.emit = lambda kind, **f: sent.append(dict(f, kind=kind))
adapter = os.path.join(folder, "adapter")
cfg = {"model": "m/x", "revision": "a" * 40, "max_seq_length": 2048, "max_steps": 10, "learning_rate": 5e-5, "lora_rank": 16, "num_generations": 8, "seed": 1,
       "train_path": os.path.join(folder, "t.jsonl"), "held_path": os.path.join(folder, "h.jsonl"), "result_path": os.path.join(folder, "r.json"),
       "adapter_dir": adapter, "output_dir": folder, "deadline": 0}
g.write_jsonl(cfg["train_path"], g.make_problems(1, 3))
g.write_jsonl(cfg["held_path"], g.make_problems(2, 3))
path = os.path.join(folder, "c.json")
json.dump(cfg, open(path, "w"))
g.rl_child_main(path)
res = g.read_result(cfg["result_path"])
config = dict(calls["config"])
out["child"] = {
    "result": res, "config": config, "trainer": calls["trainer"], "reward": calls["reward"], "modes": calls["modes"], "fresh": calls["fresh"], "first_prompt": calls["rows"][0]["prompt"][:17],
    "answer_type": type(calls["rows"][0]["answer"]).__name__, "max_new": calls["max_new"], "do_sample": calls["do_sample"],
    "revision": json.load(open(os.path.join(adapter, "adapter_config.json"))).get("revision"), "kinds": [e["kind"] for e in sent], "tokenized_bos": calls["tokenized"][0].startswith("<|begin"),
}
print(json.dumps(out))
`;

describe("rl-grpo recipe", () => {
  let dir: string;
  let out: Record<string, any>;

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rl-"));
    writeFileSync(path.join(dir, "recipe.py"), RL_PY);
    writeFileSync(path.join(dir, "harness.py"), HARNESS);
    const run = spawnSync("python3", ["-I", path.join(dir, "harness.py"), path.join(dir, "recipe.py")], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    out = JSON.parse(run.stdout.trim().split("\n").pop()!);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("is off by default: unlisted and not in RECIPES, but found for a job's page", () => {
    delete process.env.TUNE_RL;
    assert.ok(!RECIPES.some((r) => r.id === "rl-grpo"));
    assert.ok(!offeredRecipes().some((r) => r.id === "rl-grpo"));
    assert.equal(recipeById("rl-grpo"), RL_GRPO_RECIPE);
  });

  it("is offered with the flag on", () => {
    process.env.TUNE_RL = "1";
    try {
      assert.ok(offeredRecipes().some((r) => r.id === "rl-grpo"));
    } finally {
      delete process.env.TUNE_RL;
    }
  });

  it("refuses a new job with the flag off, before anything else is checked", async () => {
    delete process.env.TUNE_RL;
    const { launchJobRequest } = await import("@/lib/train/launch");
    const res = await launchJobRequest({ recipe: "rl-grpo" }, { userId: "made-up" } as never);
    assert.equal(res.ok, false);
    assert.deepEqual(res.ok ? null : [res.status, res.code], [400, "Pick a recipe."]);
  });

  it("has no em dash in its copy and no template literal hazards", () => {
    assert.ok(!JSON.stringify(RL_GRPO_RECIPE.params).includes("—"));
    assert.ok(!RL_GRPO_RECIPE.description.includes("—"));
    assert.ok(RL_PY.includes("def rl_child_main"));
  });

  it("makes problems with right results, held out from training", () => {
    assert.equal(out.overlap, 0);
    assert.equal(out.same, true);
    assert.equal(out.results_right, true);
    assert.deepEqual(out.forms, [false, true]);
  });

  it("rewards only one tag holding the right whole number", () => {
    assert.deepEqual(out.rewards, [1, 1, 1, 0.1, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(out.reward_fn, [1, 0.1]);
  });

  it("keeps metrics under the platform's limits", () => {
    assert.ok(out.curve_len <= 500, String(out.curve_len));
    assert.deepEqual(out.curve_ends, ["5:0.123", "1000:0.123"]);
    assert.ok(out.example_len <= 500, String(out.example_len));
    assert.ok(out.longest_metric <= 500);
    assert.ok(out.metric_count <= 50);
  });

  it("shows answers that got worse, so a bad run can't look good", () => {
    assert.equal(out.picked_has_worse, true);
    assert.equal(out.picked_len, 8);
  });

  it("clamps params", () => {
    assert.equal(out.params.max_steps, 1000);
    assert.equal(out.params.num_generations, 2);
    assert.equal(out.params.learning_rate, 5e-5);
  });

  it("labels a dry run and sends no eval items", () => {
    assert.equal(out.dry.dry_run, "yes");
    assert.match(out.dry.summary, /^Dry run, made-up numbers: /);
    assert.deepEqual(out.dry_uploads, [["rl-heldout.json", "metrics"]]);
    assert.equal(out.dry.heldout_total, 40);
  });

  it("fails when there are no tuned answers", () => {
    assert.match(out.half, /no tuned answers/);
  });

  it("runs the child on fakes: base, GRPO, adapter, tuned", () => {
    const c = out.child;
    assert.deepEqual(c.result.curve, [[5, 0.2], [10, 0.4]]);
    assert.deepEqual(c.result.base, ["<answer>1</answer>", "<answer>1</answer>", "<answer>1</answer>"]);
    assert.deepEqual(c.result.tuned, ["<answer>2</answer>", "<answer>2</answer>", "<answer>2</answer>"]);
    assert.equal(c.result.adapter, true);
    assert.equal(c.config.num_generations, 8);
    assert.equal(c.config.per_device_train_batch_size % c.config.num_generations, 0);
    assert.equal(c.config.remove_unused_columns, false);
    assert.equal(c.trainer.tok_eos, "<|eot|>");
    assert.equal(c.trainer.side, "left");
    assert.deepEqual(c.reward, [1]);
    assert.deepEqual(c.modes, ["inference", "training", "inference"]);
    assert.deepEqual(c.fresh, { saved: true, trainable: false });
    assert.equal(c.first_prompt, "<|begin_of_text|>");
    assert.equal(c.tokenized_bos, false);
    assert.equal(c.answer_type, "int");
    assert.equal(c.do_sample, false);
    assert.equal(c.revision, "a".repeat(40));
    assert.ok(c.kinds.includes("imported"));
    assert.ok(c.kinds.includes("progress"));
  });
});

describe("lib/train/rl", () => {
  const ev = (id: number, payload: TrainEventView["payload"]): TrainEventView => ({ id, type: payload.type, payload, at: "2026-11-01T00:00:00Z" });

  it("parses a curve and leaves out junk", () => {
    assert.deepEqual(parseRewardCurve("5:0.1,10:0.25,x,12:y"), [{ step: 5, reward: 0.1 }, { step: 10, reward: 0.25 }]);
    assert.deepEqual(parseRewardCurve(3), []);
  });

  it("reads the live curve from progress messages", () => {
    const events = [ev(1, { type: "progress", step: 5, message: "Mean reward 0.2" }), ev(2, { type: "progress", message: "GRPO training" })];
    assert.deepEqual(liveRewardCurve(events), [{ step: 5, reward: 0.2 }]);
    assert.equal(rlResults(events).heldOut, null);
  });

  it("prefers the done metrics, in example order, and says dry run", () => {
    const example = (p: string) => JSON.stringify({ problem: p, answer: 1, base: "a", tuned: "b", baseReward: 0, tunedReward: 1 });
    const r = rlResults([
      ev(1, { type: "progress", step: 5, message: "Mean reward 0.9" }),
      ev(2, {
        type: "done",
        metrics: { reward_curve: "5:0.2", heldout_total: 40, heldout_base_correct: 3, heldout_tuned_correct: 4, heldout_base_reward: 0.1, heldout_tuned_reward: 0.2, dry_run: "yes", example_10: example("b"), example_2: example("a"), example_3: "{bad" },
      }),
    ]);
    assert.deepEqual(r.curve, [{ step: 5, reward: 0.2 }]);
    assert.equal(r.heldOut?.tunedCorrect, 4);
    assert.deepEqual(r.examples.map((e) => e.problem), ["a", "b"]);
    assert.equal(r.dryRun, true);
  });

  it("keeps the card's metrics out of the raw table", () => {
    assert.ok(isRlCardMetric("reward_curve") && isRlCardMetric("example_3"));
    assert.ok(!isRlCardMetric("heldout_total"));
  });
});
