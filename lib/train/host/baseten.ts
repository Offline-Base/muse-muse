/**
 * Baseten: a custom vLLM server with the adapter, pushed with Truss in a sandbox, then watched and removed through the
 * Management API (api.baseten.co/v1/spec). Never run against the real service. Its model name is the endpoint's own, so it
 * can be found and deleted from the name alone. Min replicas 0 and max 1 are Baseten's defaults, and with no traffic it
 * scales down by itself.
 */
import { openAiChat, type Fetcher } from "@/lib/train/host/openai-chat";
import type { CliRunner } from "@/lib/train/host/cli-runner";
import { HostError, type HostAdapter, type HostFacts } from "@/lib/train/host/types";
import { needsTunedTemplate, TUNED_TEMPLATE, VLLM_IMAGE, vllmFlags, type ServeModel } from "@/lib/train/host/vllm";

const API = "https://api.baseten.co/v1";
export const BASETEN_HOSTS = ["pypi.org", "files.pythonhosted.org", "*.baseten.co", "*.amazonaws.com"];
export const HF_SECRET = "mm_host_hf_token";
const GLIMMER_PRICE = { hourlyUsd: 6.5, gpu: "H100" };
const SMALL_PRICE = { hourlyUsd: 0.85, gpu: "L4" };
/** Truss copies data/ into the image, under its default app home. */
const TEMPLATE_PATH = "/app/data/tuned.jinja";
const MODEL_ID = /model-([a-z0-9]+)\.api\.baseten\.co/;

const WAITING = new Set(["BUILDING", "DEPLOYING", "LOADING_MODEL", "UPDATING", "WAKING_UP"]);
const READY = new Set(["ACTIVE", "SCALED_TO_ZERO"]);

/** JSON is valid YAML, so the config is written as JSON and nothing a job recorded can break out of its value. */
export function trussConfig(input: { name: string; base: string; baseRevision: string; adapter: string; adapterRevision: string; gpu: string; withToken: boolean } & ServeModel): string {
  const auth = input.withToken ? { auth: { auth_method: "CUSTOM_SECRET", auth_secret_name: HF_SECRET } } : {};
  return JSON.stringify(
    {
      model_name: input.name,
      base_image: { image: VLLM_IMAGE },
      weights: [
        { source: `hf://${input.base}@${input.baseRevision}`, mount_location: "/models/base", ...auth },
        { source: `hf://${input.adapter}@${input.adapterRevision}`, mount_location: "/models/lora", ...auth },
      ],
      docker_server: {
        start_command: `vllm serve /models/base --enable-lora --lora-modules tuned=/models/lora ${vllmFlags(input, TEMPLATE_PATH).join(" ")} --host 0.0.0.0 --port 8000`,
        server_port: 8000,
        readiness_endpoint: "/health",
        liveness_endpoint: "/health",
        predict_endpoint: "/v1/chat/completions",
      },
      resources: { accelerator: input.gpu, use_gpu: true },
    },
    null,
    2,
  );
}

const TRUSSRC = `printf '[baseten]\\nremote_provider = baseten\\napi_key = %s\\nremote_url = https://app.baseten.co\\n' "$BASETEN_API_KEY" > ~/.trussrc`;

export function basetenAdapter(deps: { apiKey: () => string | undefined; hfToken: () => string | undefined; runner: CliRunner; fetch?: Fetcher }): HostAdapter {
  const send = deps.fetch ?? fetch;
  const call = (path: string, init: RequestInit = {}) => send(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${deps.apiKey()}`, "content-type": "application/json", ...init.headers } });
  const priceOf = (f: HostFacts) => (f.family === "glimmer" ? GLIMMER_PRICE : SMALL_PRICE);
  const findModel = async (name: string): Promise<string | null> => {
    const res = await call("/models");
    if (!res.ok) throw new Error(`Baseten answered ${res.status} listing models.`);
    const body = (await res.json()) as { models?: { id: string; name: string }[] };
    return body.models?.find((m) => m.name === name)?.id ?? null;
  };
  return {
    id: "baseten",
    label: "Baseten",
    missingKeys: () => (deps.apiKey() ? [] : ["BASETEN_API_KEY"]),
    cantServe(f) {
      if (!f.hubRepo || !f.hubCommit) return "Publish it to Hugging Face first: Baseten gets the adapter from there.";
      if (!f.servingBase) return "This model's job doesn't record a pinned base, so Baseten wouldn't load the right weights.";
      return null;
    },
    price: priceOf,
    async deploy({ name, facts }) {
      if (!facts.servingBase || !facts.hubRepo || !facts.hubCommit) throw new HostError(409, "cant_serve", "Baseten can't serve this model.");
      const hf = deps.hfToken();
      if (hf) {
        const saved = await call("/secrets", { method: "POST", body: JSON.stringify({ name: HF_SECRET, value: hf }) });
        if (!saved.ok) throw new HostError(502, "provider_refused", `Baseten refused the Hugging Face secret (${saved.status}).`);
      }
      const config = trussConfig({ name, base: facts.servingBase.repo, baseRevision: facts.servingBase.revision, adapter: facts.hubRepo, adapterRevision: facts.hubCommit, rank: facts.rank ?? 64, gpu: priceOf(facts).gpu, withToken: Boolean(hf), family: facts.family, trainChannel: facts.trainChannel });
      const output = await deps.runner.run({
        script: `python3 -m venv /tmp/v && . /tmp/v/bin/activate && pip install -q truss==0.18.37 && ${TRUSSRC} && truss push --promote --non-interactive --remote baseten .`,
        files: { "config.yaml": config, ...(needsTunedTemplate(facts) ? { "data/tuned.jinja": TUNED_TEMPLATE } : {}) },
        env: { BASETEN_API_KEY: deps.apiKey() ?? "" },
        hosts: BASETEN_HOSTS,
        timeoutMs: 240_000,
      });
      const modelId = output.match(MODEL_ID)?.[1] ?? (await findModel(name));
      if (!modelId) throw new HostError(502, "provider_refused", "Baseten took the push but gave no model id.");
      return { modelId };
    },
    async status(ref, name) {
      const modelId = ref.modelId ?? (await findModel(name));
      if (!modelId) return "starting";
      const res = await call(`/models/${modelId}/deployments/production`);
      if (res.status === 404) return "starting";
      if (!res.ok) return "starting";
      const status = ((await res.json()) as { status?: string }).status ?? "";
      if (READY.has(status)) return "ready";
      return WAITING.has(status) ? "starting" : "failed";
    },
    async stop(ref, name) {
      const modelId = ref.modelId ?? (await findModel(name));
      if (!modelId) return { done: true };
      const res = await call(`/models/${modelId}`, { method: "DELETE" });
      return { done: res.ok || res.status === 404 };
    },
    inferenceUrl: (ref) => (ref.modelId ? `https://model-${ref.modelId}.api.baseten.co/environments/production/sync/v1` : null),
    chat(ref, input) {
      if (!ref.modelId) throw new HostError(502, "endpoint_unavailable", "This endpoint has no address yet.");
      return openAiChat({ baseUrl: `https://model-${ref.modelId}.api.baseten.co/environments/production/sync/v1`, key: deps.apiKey() ?? "", model: input.variant === "base" ? "/models/base" : "tuned", input, fetch: deps.fetch });
    },
    async listOwned() {
      const res = await call("/models");
      if (!res.ok) throw new Error(`Baseten answered ${res.status} listing models.`);
      const body = (await res.json()) as { models?: { name: string }[] };
      return (body.models ?? []).map((m) => m.name).filter((n) => n.startsWith("mm-host-"));
    },
  };
}
