/** Each adapter on faked provider calls. No provider is reached. npx tsx --test lib/train/host/__tests__/adapters.test.ts */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { basetenAdapter, HF_SECRET, trussConfig } from "@/lib/train/host/baseten";
import { scrubSecrets, type CliRunner } from "@/lib/train/host/cli-runner";
import { fireworksAdapter } from "@/lib/train/host/fireworks";
import { lambdaAdapter } from "@/lib/train/host/lambda";
import { modalAdapter, modalApp } from "@/lib/train/host/modal";
import { openAiChat } from "@/lib/train/host/openai-chat";
import { HostError } from "@/lib/train/host/types";
import { facts, fakeFetch, ID, JOB, json } from "@/lib/train/host/__tests__/helpers";

const NAME = "mm-host-abc";
const deployInput = (f = facts()) => ({ name: NAME, endpointId: ID, facts: f, minutes: 60, callerId: "u1" });
const chatInput = { messages: [{ role: "user" as const, content: "hi" }], family: "glimmer" as const, adapterJobId: JOB, stop: [] };
const CHAT_OK = () => json({ choices: [{ message: { content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } });

function runner(output: string): CliRunner & { runs: Parameters<CliRunner["run"]>[0][] } {
  const runs: Parameters<CliRunner["run"]>[0][] = [];
  return {
    runs,
    async run(input) {
      runs.push(input);
      return output;
    },
  };
}

describe("openAiChat", () => {
  const go = (res: () => Response) => openAiChat({ baseUrl: "https://secret.example/v1", key: "k".repeat(20), model: "tuned", input: chatInput, fetch: fakeFetch([["chat/completions", res]]).fn });
  it("sends Meta's sampling for Glimmer and reads the answer", async () => {
    const f = fakeFetch([["chat/completions", CHAT_OK]]);
    const got = await openAiChat({ baseUrl: "https://x/v1/", key: "k", model: "tuned", input: chatInput, fetch: f.fn });
    assert.deepEqual(got, { text: "hello", finish: "stop", usage: { input: 3, output: 2 } });
    const body = JSON.parse(String(f.calls[0]!.init?.body));
    assert.equal(body.top_k, 64);
    assert.equal(body.temperature, 1);
  });
  it("sends no Glimmer sampling for Llama", async () => {
    const f = fakeFetch([["chat/completions", CHAT_OK]]);
    await openAiChat({ baseUrl: "https://x/v1", key: "k", model: "tuned", input: { ...chatInput, family: "llama3" }, fetch: f.fn });
    assert.equal(JSON.parse(String(f.calls[0]!.init?.body)).top_k, undefined);
  });
  it("says waking on a 503, with a retry time", async () => {
    await assert.rejects(go(() => new Response("", { status: 503 })), (e: HostError) => e.code === "endpoint_waking" && e.retryAfterSeconds === 30);
  });
  it("never repeats the address, the key or the provider's words", async () => {
    await assert.rejects(go(() => new Response("https://secret.example leaked", { status: 500 })), (e: HostError) => !/secret|leaked|kkkk/.test(e.message));
    const thrower = (async () => {
      throw new Error("connect failed https://secret.example");
    }) as unknown as typeof fetch;
    await assert.rejects(openAiChat({ baseUrl: "https://secret.example/v1", key: "k", model: "m", input: chatInput, fetch: thrower }), (e: HostError) => e.status === 502 && !/secret/.test(e.message));
  });
});

describe("fireworks", () => {
  const source = {
    list: async () => [
      { path: "adapter_config.json", size: 10 },
      { path: "adapter_model.safetensors", size: 20 },
      { path: "README.md", size: 5 },
    ],
    text: async () => JSON.stringify({ r: 16, target_modules: ["q_proj", "v_proj"] }),
    stream: async () => new Blob(["x"]).stream(),
  };
  const plain = facts({ sparkOpen: false, servingBase: null });
  const adapter = (f: typeof fetch, over: object = {}) => fireworksAdapter({ fetch: f, apiKey: () => "fw-key", accountId: () => "acct", source, pollMs: 0, ...over });
  it("refuses an r30b adapter, a high rank, and one not on the Hub", () => {
    const a = adapter(fetch);
    assert.match(a.cantServe(facts())!, /r30b/);
    assert.match(a.cantServe(facts({ sparkOpen: false, rank: 128 }))!, /rank 128/);
    assert.match(a.cantServe(facts({ sparkOpen: false, hubCommit: null }))!, /Publish/);
    assert.equal(a.cantServe(plain), null);
  });
  it("names its missing keys only", () => {
    assert.deepEqual(fireworksAdapter({ apiKey: () => undefined, accountId: () => undefined, source }).missingKeys(), ["FIREWORKS_API_KEY", "FIREWORKS_ACCOUNT_ID"]);
  });
  it("uploads the adapter's files and makes a scale-to-zero deployment", async () => {
    const f = fakeFetch([
      [":getUploadEndpoint", () => json({ filenameToSignedUrls: { "adapter_config.json": "https://up/a", "adapter_model.safetensors": "https://up/b" } })],
      [":validateUpload", () => json({})],
      ["POST https://api.fireworks.ai/v1/accounts/acct/models", () => json({})],
      ["/deployments?deploymentId=mm-host-abc", () => json({})],
      ["PUT https://up/", () => new Response("")],
    ]);
    const ref = await adapter(f.fn).deploy(deployInput(plain));
    assert.deepEqual(ref, { model: "accounts/acct/deployments/mm-host-abc" });
    const made = JSON.parse(String(f.calls[0]!.init?.body));
    assert.equal(made.model.kind, "HF_PEFT_ADDON");
    assert.equal(made.model.peftDetails.baseModel, "accounts/fireworks/models/muse-glimmer-30b");
    assert.equal(f.calls.filter((c) => c.key.startsWith("PUT")).length, 2, "README isn't uploaded");
    const dep = JSON.parse(String(f.calls.at(-1)!.init?.body));
    assert.equal(dep.minReplicaCount, 0);
    assert.equal(dep.maxReplicaCount, 1);
    assert.equal(dep.autoscalingPolicy.scaleToZeroWindow, "300s");
  });
  it("refuses regex target modules before creating anything", async () => {
    const f = fakeFetch([]);
    const a = fireworksAdapter({ fetch: f.fn, apiKey: () => "k", accountId: () => "acct", source: { ...source, text: async () => JSON.stringify({ r: 16, target_modules: ".*proj" }) } });
    await assert.rejects(a.deploy(deployInput(plain)), (e: HostError) => e.code === "cant_serve");
    assert.equal(f.calls.length, 0);
  });
  it("reads status, stops by name, counts a 404 as stopped, and lists its own", async () => {
    const ready = fakeFetch([["GET", () => json({ state: "READY" })]]);
    assert.equal(await adapter(ready.fn).status({}, NAME), "ready");
    assert.equal(await adapter(fakeFetch([["GET", () => json({ state: "CREATING" })]]).fn).status({}, NAME), "starting");
    assert.equal(await adapter(fakeFetch([["GET", () => json({ state: "FAILED" })]]).fn).status({}, NAME), "failed");
    assert.deepEqual(await adapter(fakeFetch([["DELETE", () => new Response("", { status: 404 })]]).fn).stop({}, NAME), { done: true });
    assert.deepEqual(await adapter(fakeFetch([["DELETE", () => new Response("", { status: 500 })]]).fn).stop({}, NAME), { done: false });
    const list = fakeFetch([["GET", () => json({ deployments: [{ name: "accounts/a/deployments/mm-host-1", state: "READY" }, { name: "accounts/a/deployments/other", state: "READY" }, { name: "accounts/a/deployments/mm-host-2", state: "DELETED" }] })]]);
    assert.deepEqual(await adapter(list.fn).listOwned!(), ["mm-host-1"]);
  });
  it("chats on the deployment's name with the platform key", async () => {
    const f = fakeFetch([["inference/v1/chat/completions", CHAT_OK]]);
    await adapter(f.fn).chat({ model: "accounts/acct/deployments/x" }, chatInput);
    assert.equal(JSON.parse(String(f.calls[0]!.init?.body)).model, "accounts/acct/deployments/x");
  });
});

describe("modal", () => {
  const SECRET_ENV = { tokenId: () => "ak-token-id", tokenSecret: () => "as-token-secret", hfToken: () => "hf_private_token_value", keyFor: (id: string) => `derived-${id}` };
  it("writes no secret into the app's source, and scales to zero", () => {
    const src = modalApp({ name: NAME, base: "a/b", baseRevision: "r", adapter: "c/d", adapterRevision: "s", rank: 16, gpu: "H100" });
    assert.match(src, /scaledown_window=300/);
    assert.match(src, /os\.environ\.get\("HF_TOKEN"/);
    assert.match(src, /max_containers=1/);
    assert.ok(!src.includes("hf_private"));
  });
  it("deploys through the runner with keys only in its environment, and reads the address", async () => {
    const r = runner("Created web endpoint => https://work--mm-host-abc.modal.run\n");
    const a = modalAdapter({ ...SECRET_ENV, runner: r });
    const ref = await a.deploy(deployInput());
    assert.deepEqual(ref, { url: "https://work--mm-host-abc.modal.run", endpointId: ID });
    const run = r.runs[0]!;
    assert.equal(run.env.HF_TOKEN, "hf_private_token_value");
    assert.equal(run.env.MODAL_TOKEN_SECRET, "as-token-secret");
    for (const text of [run.script, ...Object.values(run.files)]) {
      for (const secret of ["hf_private", "as-token", `derived-${ID}`]) assert.ok(!text.includes(secret));
    }
  });
  it("fails when no address comes back", async () => {
    await assert.rejects(modalAdapter({ ...SECRET_ENV, runner: runner("nothing") }).deploy(deployInput()), (e: HostError) => e.code === "provider_refused");
  });
  it("is ready only when its server answers, stops by name, and chats with the derived key", async () => {
    const ok = fakeFetch([["/health", () => new Response("")], ["chat/completions", CHAT_OK]]);
    const r = runner("");
    const a = modalAdapter({ ...SECRET_ENV, runner: r, fetch: ok.fn });
    assert.equal(await a.status({ url: "https://x.modal.run" }, NAME), "ready");
    const down = modalAdapter({ ...SECRET_ENV, runner: r, fetch: fakeFetch([["/health", () => new Response("", { status: 503 })]]).fn });
    assert.equal(await down.status({ url: "https://x.modal.run" }, NAME), "starting");
    assert.deepEqual(await a.stop({}, NAME), { done: true });
    assert.equal(r.runs[0]!.env.HOST_NAME, NAME);
    assert.match(r.runs[0]!.script, /modal app stop -y/);
    await a.chat({ url: "https://x.modal.run", endpointId: ID }, chatInput);
    const sent = ok.calls.at(-1)!.init!.headers as Record<string, string>;
    assert.equal(sent.authorization, `Bearer derived-${ID}`);
  });
  it("can't stop without its token, so the sweep keeps trying", async () => {
    await assert.rejects(modalAdapter({ ...SECRET_ENV, tokenId: () => undefined, runner: runner("") }).stop({}, NAME), /token/);
  });
  it("needs a Hub copy and a pinned base", () => {
    const a = modalAdapter({ ...SECRET_ENV, runner: runner("") });
    assert.equal(a.cantServe(facts()), null);
    assert.match(a.cantServe(facts({ servingBase: null }))!, /pinned/);
    assert.match(a.cantServe(facts({ hubRepo: null }))!, /Publish/);
  });
});

describe("baseten", () => {
  const f1 = (answers: Parameters<typeof fakeFetch>[0]) => fakeFetch(answers);
  it("writes a config with pinned weights and no token value", () => {
    const c = JSON.parse(trussConfig({ name: NAME, base: "a/b", baseRevision: "r1", adapter: "c/d", adapterRevision: "r2", rank: 16, gpu: "H100", withToken: true }));
    assert.equal(c.weights[0].source, "hf://a/b@r1");
    assert.equal(c.weights[1].auth.auth_secret_name, HF_SECRET);
    assert.match(c.docker_server.start_command, /--max-lora-rank 16/);
  });
  it("saves the HF token as Baseten's secret, pushes, and reads the model id", async () => {
    const f = f1([["POST https://api.baseten.co/v1/secrets", () => json({})]]);
    const r = runner("https://model-abc123.api.baseten.co/deployment/x/predict");
    const a = basetenAdapter({ apiKey: () => "bt-key", hfToken: () => "hf_private_token_value", runner: r, fetch: f.fn });
    assert.deepEqual(await a.deploy(deployInput()), { modelId: "abc123" });
    assert.ok(!r.runs[0]!.script.includes("bt-key"));
    assert.ok(!JSON.stringify(r.runs[0]!.files).includes("hf_private"));
    assert.equal(r.runs[0]!.env.BASETEN_API_KEY, "bt-key");
  });
  it("maps Baseten's statuses", async () => {
    const at = (status: string) => basetenAdapter({ apiKey: () => "k", hfToken: () => undefined, runner: runner(""), fetch: f1([["/deployments/production", () => json({ status })]]).fn }).status({ modelId: "m" }, NAME);
    assert.equal(await at("ACTIVE"), "ready");
    assert.equal(await at("SCALED_TO_ZERO"), "ready");
    assert.equal(await at("BUILDING"), "starting");
    assert.equal(await at("BUILD_FAILED"), "failed");
  });
  it("finds the model by name to stop it when the ref was lost", async () => {
    const f = f1([["GET https://api.baseten.co/v1/models", () => json({ models: [{ id: "m9", name: NAME }] })], ["DELETE https://api.baseten.co/v1/models/m9", () => json({})]]);
    assert.deepEqual(await basetenAdapter({ apiKey: () => "k", hfToken: () => undefined, runner: runner(""), fetch: f.fn }).stop({}, NAME), { done: true });
  });
  it("counts a stop with no such model as done, and lists its own", async () => {
    const f = f1([["GET", () => json({ models: [{ id: "1", name: "mm-host-1" }, { id: "2", name: "theirs" }] })]]);
    const a = basetenAdapter({ apiKey: () => "k", hfToken: () => undefined, runner: runner(""), fetch: f.fn });
    assert.deepEqual(await a.stop({}, "missing"), { done: true });
    assert.deepEqual(await a.listOwned!(), ["mm-host-1"]);
  });
});

describe("lambda", () => {
  const base = {
    apiKey: () => "lambda",
    ceilings: () => ({ maxMinutes: 120, maxUsd: 5 }),
    launch: async () => ({ ok: true as const, job: { id: "serve-1" } as never }),
    liveState: async () => "live" as const,
    job: async () => ({ status: "running", costUsd: 0, instanceId: "i", terminatedAt: null }),
    stopJob: async () => undefined,
    serveJobOf: async () => null,
    backend: async () => null,
    isTerminal: (s: string) => s === "stopped",
  };
  it("reuses the serve job, with its own limit reserved", async () => {
    let asked: Record<string, unknown> = {};
    const a = lambdaAdapter({
      ...base,
      launch: async (input) => {
        asked = input as never;
        return { ok: true, job: { id: "serve-1" } as never };
      },
    });
    assert.deepEqual(a.price(facts()).capUsd, 5);
    assert.deepEqual(await a.deploy({ ...deployInput(), capUsd: 5 }), { serveJobId: "serve-1", adapterJobId: JOB });
    assert.equal(asked.recipe, "glimmer-serve");
    assert.equal(asked.maxUsd, 5);
    assert.equal(a.inferenceUrl({}), null, "no plain URL: its TLS is pinned");
  });
  it("gives plain words for launch's refusals", async () => {
    const a = lambdaAdapter({ ...base, launch: async () => ({ ok: false, status: 503, code: "no_capacity" }) });
    await assert.rejects(a.deploy(deployInput()), (e: HostError) => e.code === "no_capacity" && /no free GPU/.test(e.message));
  });
  it("carries the lab's reason when it can't serve", () => {
    assert.match(lambdaAdapter(base).cantServe(facts({ lambdaProblem: "that adapter trained on Llama." }))!, /Llama/);
  });
  it("isn't done until the GPU is down, and settles at the job's cost", async () => {
    let stops = 0;
    const running = lambdaAdapter({ ...base, stopJob: async () => void (stops += 1) });
    assert.deepEqual(await running.stop({ serveJobId: "s" }, NAME), { done: false });
    assert.equal(stops, 1);
    const down = lambdaAdapter({ ...base, job: async () => ({ status: "stopped", costUsd: 1.5, instanceId: "i", terminatedAt: new Date() }) });
    assert.deepEqual(await down.stop({ serveJobId: "s" }, NAME), { done: true, costUsd: 1.5 });
  });
  it("finds a job a crash left without a ref", async () => {
    let stopped = "";
    const a = lambdaAdapter({ ...base, serveJobOf: async () => "orphan", stopJob: async (id) => void (stopped = id) });
    await a.stop({ adapterJobId: JOB }, NAME);
    assert.equal(stopped, "orphan");
  });
});

describe("scrubSecrets", () => {
  it("blanks every value out of tool output", () => {
    assert.equal(scrubSecrets("key=as-token-secret done", { MODAL_TOKEN_SECRET: "as-token-secret" }), "key=[hidden] done");
    assert.equal(scrubSecrets("abc", { SHORT: "b" }), "abc");
  });
});
