/**
 * Modal: a small generated app that runs vLLM with the adapter on a GPU, scaled to zero when idle, deployed under the
 * endpoint's own name by Modal's CLI in a sandbox. vLLM checks a key derived per endpoint, so only this platform can reach
 * it. Never run against the real service, and Glimmer LoRA on vLLM 0.29 has no report of working yet.
 *
 * Fail-safe: past its stop, or if `modal app stop` can't run, this platform sends it no traffic, so it scales to zero by
 * itself within SCALEDOWN_SECONDS. That is why it has no listOwned: a sandbox every 5 minutes to list isn't worth it.
 */
import { openAiChat, type Fetcher } from "@/lib/train/host/openai-chat";
import type { CliRunner } from "@/lib/train/host/cli-runner";
import { HostError, type HostAdapter, type HostFacts } from "@/lib/train/host/types";

export const SCALEDOWN_SECONDS = 300;
export const MODAL_HOSTS = ["pypi.org", "files.pythonhosted.org", "api.modal.com", "*.modal.com", "*.modal.host"];
/** Modal's per-second prices with the CPU and memory a server holds: my estimates from modal.com/pricing. */
const GLIMMER_PRICE = { hourlyUsd: 4.85, gpu: "H100" };
const SMALL_PRICE = { hourlyUsd: 1, gpu: "L4" };
const VLLM_IMAGE = "vllm/vllm-openai:v0.29.0";
const MODAL_URL = /https:\/\/[a-z0-9-]+--[a-z0-9-]+\.modal\.run/;

/** What vLLM's flags need of a model, checked: a repo id and a commit from the job's record, never free text. */
export function modalApp(input: { name: string; base: string; baseRevision: string; adapter: string; adapterRevision: string; rank: number; gpu: string }): string {
  const py = JSON.stringify;
  return `import os
import subprocess

import modal

image = modal.Image.from_registry(${py(VLLM_IMAGE)}, add_python="3.12").pip_install("modal", "huggingface_hub")
app = modal.App(${py(input.name)})
cache = modal.Volume.from_name("mm-host-hf-cache", create_if_missing=True)
secret = modal.Secret.from_dict({"HF_TOKEN": os.environ.get("HF_TOKEN", ""), "HOST_KEY": os.environ.get("HOST_KEY", "")})


@app.server(port=8000, gpu=${py(input.gpu)}, image=image, volumes={"/root/.cache/huggingface": cache}, secrets=[secret], scaledown_window=${SCALEDOWN_SECONDS}, startup_timeout=1500, max_containers=1, unauthenticated=True)
class Server:
    @modal.enter()
    def start(self):
        from huggingface_hub import snapshot_download

        adapter = snapshot_download(${py(input.adapter)}, revision=${py(input.adapterRevision)})
        subprocess.Popen(
            [
                "vllm", "serve", ${py(input.base)},
                "--revision", ${py(input.baseRevision)},
                "--enable-lora",
                "--lora-modules", "tuned=" + adapter,
                "--max-lora-rank", ${py(String(input.rank))},
                "--api-key", os.environ["HOST_KEY"],
                "--host", "0.0.0.0",
                "--port", "8000",
            ]
        )
`;
}

function gpuFor(f: HostFacts) {
  return f.family === "glimmer" ? GLIMMER_PRICE : SMALL_PRICE;
}

export function modalAdapter(deps: {
  tokenId: () => string | undefined;
  tokenSecret: () => string | undefined;
  hfToken: () => string | undefined;
  /** The key vLLM checks for this endpoint, derived, never stored. */
  keyFor: (endpointId: string) => string;
  runner: CliRunner;
  fetch?: Fetcher;
}): HostAdapter {
  const modalEnv = () => ({ MODAL_TOKEN_ID: deps.tokenId() ?? "", MODAL_TOKEN_SECRET: deps.tokenSecret() ?? "" });
  return {
    id: "modal",
    label: "Modal",
    missingKeys: () => [...(deps.tokenId() ? [] : ["MODAL_TOKEN_ID"]), ...(deps.tokenSecret() ? [] : ["MODAL_TOKEN_SECRET"])],
    cantServe(f) {
      if (!f.hubRepo || !f.hubCommit) return "Publish it to Hugging Face first: Modal gets the adapter from there.";
      if (!f.servingBase) return "This model's job doesn't record a pinned base, so Modal wouldn't load the right weights.";
      return null;
    },
    price: gpuFor,
    async deploy({ name, endpointId, facts }) {
      if (!facts.servingBase || !facts.hubRepo || !facts.hubCommit) throw new HostError(409, "cant_serve", "Modal can't serve this model.");
      const source = modalApp({ name, base: facts.servingBase.repo, baseRevision: facts.servingBase.revision, adapter: facts.hubRepo, adapterRevision: facts.hubCommit, rank: facts.rank ?? 64, gpu: gpuFor(facts).gpu });
      const output = await deps.runner.run({
        script: "pip install -q modal && modal deploy --name \"$HOST_NAME\" app.py",
        files: { "app.py": source },
        env: { ...modalEnv(), HOST_NAME: name, HF_TOKEN: deps.hfToken() ?? "", HOST_KEY: deps.keyFor(endpointId) },
        hosts: MODAL_HOSTS,
        timeoutMs: 240_000,
      });
      const url = output.match(MODAL_URL)?.[0];
      if (!url) throw new HostError(502, "provider_refused", "Modal deployed it but gave no address.");
      return { url, endpointId };
    },
    /** The first request is what starts a scaled-to-zero server, so this also wakes it. Only called before it first answers. */
    async status(ref) {
      if (!ref.url) return "failed";
      const res = await (deps.fetch ?? fetch)(`${ref.url}/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
      return res?.ok ? "ready" : "starting";
    },
    async stop(_ref, name) {
      if (!deps.tokenId() || !deps.tokenSecret()) throw new Error("Modal's token isn't set, so this can't be stopped from here.");
      await deps.runner.run({ script: "pip install -q modal && modal app stop -y \"$HOST_NAME\"", files: {}, env: { ...modalEnv(), HOST_NAME: name }, hosts: MODAL_HOSTS, timeoutMs: 90_000 });
      return { done: true };
    },
    inferenceUrl: (ref) => (ref.url ? `${ref.url}/v1` : null),
    chat(ref, input) {
      if (!ref.url || !ref.endpointId) throw new HostError(502, "endpoint_unavailable", "This endpoint has no address yet.");
      return openAiChat({ baseUrl: `${ref.url}/v1`, key: deps.keyFor(ref.endpointId), model: "tuned", input, fetch: deps.fetch });
    },
  };
}
