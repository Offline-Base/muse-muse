/**
 * Fireworks' REST API for training (docs.fireworks.ai/api-reference). The key is only ever a header here, and no
 * response text leaves this file: an error says what was refused, its status, and whether it looks like billing.
 */
import { FW_BASE_MODEL, FW_MODELS_URL, FW_PRICING_URL, FW_SERVERLESS_PRICING_URL, quoteFrom, type FireworksQuote } from "@/lib/train/fireworks/quote";

const API = "https://api.fireworks.ai/v1";
const TIMEOUT_MS = 20_000;
export type Fetcher = typeof fetch;

export class FireworksError extends Error {
  constructor(
    what: string,
    readonly status: number,
    /** The refusal talks about a payment method, credits or billing. */
    readonly billing: boolean,
  ) {
    super(billing ? `Fireworks refused ${what}: the account's billing needs attention (${status}).` : `Fireworks refused ${what} (${status}).`);
  }
}

export interface FwJob {
  state?: string;
  estimatedCost?: { currencyCode?: string; units?: string | number; nanos?: number };
  jobProgress?: { percent?: number };
}

export function fireworksApi(deps: { apiKey: () => string | undefined; accountId?: () => string | undefined; fetch?: Fetcher }) {
  const send = deps.fetch ?? fetch;
  let known: string | null = null;
  const auth = () => ({ authorization: `Bearer ${deps.apiKey()}` });

  async function need(what: string, res: Response, okStatuses: number[] = []): Promise<Response> {
    if (res.ok || okStatuses.includes(res.status)) return res;
    const text = await res.text().catch(() => "");
    throw new FireworksError(what, res.status, res.status === 402 || /payment|billing|credit card|insufficient (funds|credit)/i.test(text));
  }
  async function account(): Promise<string> {
    if (known) return known;
    const set = deps.accountId?.();
    if (set) return (known = set);
    const res = await need("the account lookup", await send(`${API}/accounts?pageSize=1`, { headers: auth(), signal: AbortSignal.timeout(TIMEOUT_MS) }));
    const name = ((await res.json()) as { accounts?: { name?: string }[] }).accounts?.[0]?.name?.split("/").pop();
    if (!name) throw new FireworksError("the account lookup", 404, false);
    return (known = name);
  }
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    return send(`${API}/accounts/${await account()}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), ...init, headers: { ...auth(), ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init.headers } });
  }
  const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
  /** Deleting what's already gone is done. */
  const remove = async (what: string, path: string) => {
    await need(what, await call(path, { method: "DELETE" }), [404]);
  };

  return {
    account,
    /** Makes a dataset and uploads its one file. Safe to run again: a dataset that exists is kept. */
    async uploadDataset(id: string, jsonl: string): Promise<void> {
      const made = await need("the dataset", await call("/datasets", json({ datasetId: id, dataset: { userUploaded: {} } })), [409]);
      if (made.status === 409) return;
      const form = new FormData();
      form.append("file", new Blob([jsonl], { type: "application/jsonl" }), `${id}.jsonl`);
      await need("the upload", await call(`/datasets/${id}:upload`, { method: "POST", body: form }));
    },
    /** Creates the managed job, or reads it back when an earlier try made it. */
    async createSftJob(id: string, body: Record<string, unknown>): Promise<FwJob> {
      const res = await need("the training job", await call(`/supervisedFineTuningJobs?supervisedFineTuningJobId=${id}`, json(body)), [409]);
      return res.status === 409 ? this.getSftJob(id) : ((await res.json()) as FwJob);
    },
    async getSftJob(id: string): Promise<FwJob> {
      return (await (await need("the job's status", await call(`/supervisedFineTuningJobs/${id}`))).json()) as FwJob;
    },
    deleteSftJob: (id: string) => remove("deleting the job", `/supervisedFineTuningJobs/${id}`),
    /** One batch inference job. Billed per token, with no deployment of ours to leave running. */
    async createBatch(id: string, model: string, input: string, output: string, maxTokens: number): Promise<void> {
      const a = await account();
      await need(
        "the batch job",
        await call(`/batchInferenceJobs?batchInferenceJobId=${id}`, json({ model, inputDatasetId: `accounts/${a}/datasets/${input}`, outputDatasetId: `accounts/${a}/datasets/${output}`, inferenceParameters: { maxTokens, temperature: 0 } })),
        [409],
      );
    },
    async getBatch(id: string): Promise<FwJob> {
      return (await (await need("the batch's status", await call(`/batchInferenceJobs/${id}`))).json()) as FwJob;
    },
    deleteBatch: (id: string) => remove("deleting the batch", `/batchInferenceJobs/${id}`),
    /** Every file of a dataset, read from its signed addresses, joined. */
    async readDataset(id: string): Promise<string> {
      const res = await need("the download", await call(`/datasets/${id}:getDownloadEndpoint`));
      const urls = ((await res.json()) as { filenameToSignedUrls?: Record<string, string> }).filenameToSignedUrls ?? {};
      const parts: string[] = [];
      for (const url of Object.values(urls)) parts.push(await (await need("the download", await send(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }))).text());
      return parts.join("\n");
    },
    deleteDataset: (id: string) => remove("deleting the dataset", `/datasets/${id}`),
    /** The adapter's file names, from Fireworks' download endpoint. Its signed addresses stay here. */
    async modelFiles(id: string): Promise<string[]> {
      const res = await need("the model's files", await call(`/models/${id}:getDownloadEndpoint`));
      return Object.keys(((await res.json()) as { filenameToSignedUrls?: Record<string, string> }).filenameToSignedUrls ?? {});
    },
    deleteModel: (id: string) => remove("deleting the model", `/models/${id}`),
    /** The base's catalog entry says it can be LoRA tuned. */
    async baseTunable(): Promise<boolean> {
      const res = await send(`${API}/${FW_BASE_MODEL}`, { headers: auth(), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return false;
      return ((await res.json()) as { supervisedLoraTunable?: unknown }).supervisedLoraTunable === true;
    },
  };
}

export type FireworksApi = ReturnType<typeof fireworksApi>;

/** The API with the platform's key. FIREWORKS_ACCOUNT_ID is optional: the key's own account is looked up without it. */
export function platformApi(): FireworksApi {
  return fireworksApi({ apiKey: () => process.env.FIREWORKS_API_KEY?.trim() || undefined, accountId: () => process.env.FIREWORKS_ACCOUNT_ID?.trim() || undefined });
}

/** A quote read fresh from Fireworks. Any failure to read is no quote. */
export async function liveQuote(api: Pick<FireworksApi, "baseTunable">, send: Fetcher = fetch, now: Date = new Date()): Promise<FireworksQuote> {
  try {
    const page = async (url: string) => {
      const res = await send(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(String(res.status));
      return res.text();
    };
    const [modelsPage, pricingPage, serverlessPage, tunable] = await Promise.all([page(FW_MODELS_URL), page(FW_PRICING_URL), page(FW_SERVERLESS_PRICING_URL), api.baseTunable()]);
    return quoteFrom({ modelsPage, pricingPage, serverlessPage, tunable, now });
  } catch {
    return { ok: false, reason: "Fireworks' pages couldn't be read, so this training's cost isn't confirmed." };
  }
}
