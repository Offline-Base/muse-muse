/**
 * Fireworks: upload the adapter from Hugging Face to the platform's account, then a dedicated scale-to-zero deployment of
 * it, by REST (docs.fireworks.ai: uploading-custom-models-api, create-model, create-deployment). Never run against the real
 * service: the first paid test may change details. Only Fireworks' own bases are documented for an adapter, so an adapter
 * trained on r30b is refused here: it would load onto plain Glimmer and answer as a model nobody evaluated. Full merged
 * weights aren't offered, since the platform publishes none and 60 GB can't pass through a server function.
 */
import { openAiChat, type Fetcher } from "@/lib/train/host/openai-chat";
import type { AdapterSource } from "@/lib/train/host/hf-files";
import { FIREWORKS_MAX_RANK, FIREWORKS_MIN_RANK, fireworksConfigProblem } from "@/lib/train/host/fireworks-config";
import { HostError, type HostAdapter, type HostFacts } from "@/lib/train/host/types";

const API = "https://api.fireworks.ai/v1";
const INFERENCE = "https://api.fireworks.ai/inference/v1";
export { FIREWORKS_MAX_RANK, FIREWORKS_MIN_RANK, fireworksConfigProblem };
/** Dedicated deployments only, H100 at $8 an hour (fireworks.ai/pricing). The real shape isn't known until the first test. */
export const FIREWORKS_HOURLY_USD = 8;
const SCALE_TO_ZERO_WINDOW = "300s";
const ADAPTER_FILES = new Set(["adapter_config.json", "adapter_model.safetensors", "adapter_model.bin"]);

/**
 * The Fireworks-owned base an adapter may name: Muse Glimmer 30B only. It isn't on Fireworks' list of addon bases
 * (peft-addon/requirements-and-limits), which says others need an enterprise account, though Glimmer's model page offers
 * LoRA. So it is unproven. A Llama adapter gets no base: the organizers ruled on Nov 2 that Llama doesn't count as a Meta
 * model in this hackathon, so it is never served.
 */
function fireworksBase(f: HostFacts): string | null {
  if (f.sparkOpen) return null;
  if (f.family === "glimmer") return "accounts/fireworks/models/muse-glimmer-30b";
  return null;
}

/** The sentence for an adapter trained on Llama, on every host. */
export const LLAMA_HOST_REFUSAL = "This model trained on Llama, and only Muse Glimmer models are served here.";

export function fireworksAdapter(deps: { fetch?: Fetcher; apiKey: () => string | undefined; accountId: () => string | undefined; source: AdapterSource; pollMs?: number }): HostAdapter {
  const send = deps.fetch ?? fetch;
  const account = () => deps.accountId() ?? "";
  const call = async (path: string, init: RequestInit = {}): Promise<Response> =>
    send(`${API}/accounts/${account()}${path}`, { ...init, headers: { authorization: `Bearer ${deps.apiKey()}`, "content-type": "application/json", ...init.headers } });
  const need = async (what: string, res: Response): Promise<Response> => {
    if (!res.ok) throw new HostError(502, "provider_refused", `Fireworks refused ${what} (${res.status}).`);
    return res;
  };

  return {
    id: "fireworks",
    label: "Fireworks",
    missingKeys: () => [...(deps.apiKey() ? [] : ["FIREWORKS_API_KEY"]), ...(deps.accountId() ? [] : ["FIREWORKS_ACCOUNT_ID"])],
    cantServe(f) {
      if (f.family !== "glimmer") return LLAMA_HOST_REFUSAL;
      // Trained on Fireworks: the adapter is already on the account, on Fireworks' own Glimmer 30B, with its chat template.
      if (f.fireworksModel) return null;
      if (f.sparkOpen) return "Fireworks documents adapters only on its own bases, and has no copy of the 2026 Glimmer (r30b) this model trained on.";
      if (!fireworksBase(f)) return "Fireworks has no matching base for this model.";
      if (f.family === "glimmer" && f.trainChannel === 0) return "This model answers on a final channel the prompt must open, and a Fireworks deployment can't be given that template.";
      if (f.rank !== null && f.rank > FIREWORKS_MAX_RANK) return `Fireworks takes adapters up to rank ${FIREWORKS_MAX_RANK}, and this one is rank ${f.rank}.`;
      if (!f.hubRepo || !f.hubCommit) return "Publish it to Hugging Face first: Fireworks gets the adapter from there.";
      return null;
    },
    price: () => ({ hourlyUsd: FIREWORKS_HOURLY_USD, gpu: "H100" }),
    async deploy({ name, facts }) {
      if (facts.fireworksModel) {
        // Nothing is uploaded: a deployment of the trained adapter itself. The stop deletes only this deployment and a
        // model named `name`, which doesn't exist here, so the trained adapter is never deleted.
        const model = `accounts/${account()}/models/${facts.fireworksModel}`;
        await need(
          "the deployment",
          await call(`/deployments?deploymentId=${name}`, {
            method: "POST",
            body: JSON.stringify({ baseModel: model, deploymentShape: "default", minReplicaCount: 0, maxReplicaCount: 1, autoscalingPolicy: { scaleToZeroWindow: SCALE_TO_ZERO_WINDOW } }),
          }),
        );
        return { model };
      }
      const base = fireworksBase(facts);
      if (!base || !facts.hubRepo || !facts.hubCommit) throw new HostError(409, "cant_serve", "Fireworks can't serve this model.");
      const repo = facts.hubRepo;
      const commit = facts.hubCommit;
      const config = JSON.parse(await deps.source.text(repo, commit, "adapter_config.json")) as { r?: unknown; target_modules?: string[] };
      // Fireworks describes a list of module names. A regex string is what Glimmer training saves, and it isn't documented as accepted.
      const refused = fireworksConfigProblem(config);
      if (refused) throw new HostError(409, "cant_serve", refused);
      const r = Number(config.r);
      const files = (await deps.source.list(repo)).filter((f) => ADAPTER_FILES.has(f.path));
      await need(
        "the model",
        await call("/models", {
          method: "POST",
          body: JSON.stringify({ modelId: name, model: { kind: "HF_PEFT_ADDON", peftDetails: { baseModel: base, r, targetModules: config.target_modules } } }),
        }),
      );
      const upload = (await (
        await need("the upload", await call(`/models/${name}:getUploadEndpoint`, { method: "POST", body: JSON.stringify({ filenameToSize: Object.fromEntries(files.map((f) => [f.path, f.size])), enableResumableUpload: false }) }))
      ).json()) as { filenameToSignedUrls?: Record<string, string> };
      for (const file of files) {
        const url = upload.filenameToSignedUrls?.[file.path];
        if (!url) throw new HostError(502, "provider_refused", "Fireworks gave no upload address.");
        const put = await send(url, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream", "content-length": String(file.size), "x-goog-content-length-range": `${file.size},${file.size}` },
          body: await deps.source.stream(repo, commit, file.path),
          duplex: "half",
        } as RequestInit);
        if (!put.ok) throw new HostError(502, "provider_refused", `Fireworks refused the upload of ${file.path} (${put.status}).`);
      }
      // 200 once READY; FAILED_PRECONDITION while the files are still landing.
      let valid = false;
      for (let i = 0; i < 30 && !valid; i += 1) {
        valid = (await call(`/models/${name}:validateUpload`)).ok;
        if (!valid) await new Promise((r2) => setTimeout(r2, deps.pollMs ?? 2_000));
      }
      if (!valid) throw new HostError(502, "provider_refused", "Fireworks didn't accept the uploaded adapter.");
      await need(
        "the deployment",
        await call(`/deployments?deploymentId=${name}`, {
          method: "POST",
          body: JSON.stringify({ baseModel: `accounts/${account()}/models/${name}`, deploymentShape: "default", minReplicaCount: 0, maxReplicaCount: 1, autoscalingPolicy: { scaleToZeroWindow: SCALE_TO_ZERO_WINDOW } }),
        }),
      );
      // A live-merge deployment is called by the adapter's model name, with no "#deployment" (fine-tuning/deploying-loras).
      return { model: `accounts/${account()}/models/${name}` };
    },
    async status(_ref, name) {
      const res = await call(`/deployments/${name}`);
      if (res.status === 404) return "failed";
      if (!res.ok) return "starting";
      const state = ((await res.json()) as { state?: string }).state;
      if (state === "READY") return "ready";
      return state === "FAILED" || state === "DELETED" || state === "DELETING" ? "failed" : "starting";
    },
    async stop(_ref, name) {
      // Without ignoreChecks Fireworks can refuse to delete a deployment still in use, and it would go on billing.
      const gone = await call(`/deployments/${name}?ignoreChecks=true`, { method: "DELETE" });
      if (!gone.ok && gone.status !== 404) return { done: false };
      // The uploaded adapter costs nothing to keep, and this is only tidying, so its failure doesn't hold the stop up.
      await call(`/models/${name}`, { method: "DELETE" }).catch(() => undefined);
      return { done: true };
    },
    inferenceUrl: () => INFERENCE,
    chat(ref, input) {
      if (input.variant === "base") throw new HostError(409, "base_unavailable", "Fireworks serves only the tuned model here, so there's no base answer to compare.");
      return openAiChat({ baseUrl: INFERENCE, key: deps.apiKey() ?? "", model: ref.model ?? "", input, fetch: deps.fetch });
    },
    async listOwned() {
      const res = await call("/deployments?pageSize=200");
      if (!res.ok) throw new Error(`Fireworks answered ${res.status} listing deployments.`);
      const body = (await res.json()) as { deployments?: { name?: string; state?: string }[] };
      return (body.deployments ?? [])
        .filter((d) => d.state !== "DELETED" && d.state !== "DELETING")
        .map((d) => d.name?.split("/").pop() ?? "")
        .filter((n) => n.startsWith("mm-host-"));
    },
  };
}
