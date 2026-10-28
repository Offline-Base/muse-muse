import { env } from "@/lib/env";
import type { GpuChoice } from "@/lib/train/types";

/**
 * Lambda Cloud REST client for fine-tuning jobs (docs/TRAINING.md "Lambda client"). Platform only: LAMBDA_API_KEY is
 * read on every call, sent only in the Authorization header and scrubbed from every error message.
 *
 * Endpoints: GET /instance-types, GET /instances (paged), GET /instances/{id}, POST /instance-operations/launch,
 * POST /instance-operations/terminate. Lambda bills from launch until terminate, so terminate is idempotent.
 */

const API = "https://cloud.lambda.ai/api/v1";
/** The largest page Lambda serves for GET /instances. */
const PAGE_SIZE = 100;
/** Stops a page_token loop that never ends. 20 pages is 2,000 instances, far more than this account holds. */
const MAX_PAGES = 20;
/** Lambda refuses user data over 1 MB. */
const MAX_USER_DATA_BYTES = 1_000_000;
/** Lambda's rules for a tag key on launch. Keys starting with "lambda-ai-" are reserved for Lambda. */
const TAG_KEY = /^[a-z][a-z0-9-:]+$/;
const GONE: readonly LambdaInstance["status"][] = ["terminated", "terminating"];

/** Per-call timeout and the wait before the one retry. Tests shorten these; nothing else should change them. */
export const lambdaTiming = { timeoutMs: 20_000, retryWaitMs: 2_000 };

/** An instance type from GET /instance-types, with the regions that have capacity right now (`us-` first). */
export interface LambdaInstanceType {
  name: string;
  description: string;
  priceCentsPerHour: number;
  gpus: number;
  regionsWithCapacity: string[];
}

/** An instance from GET /instances. `instanceType` and `region` are Lambda's names, such as gpu_1x_a10 and us-east-1. */
export interface LambdaInstance {
  id: string;
  name: string | null;
  status: "booting" | "active" | "unhealthy" | "terminated" | "terminating" | "preempted";
  ip: string | null;
  instanceType: string;
  region: string;
  /** The instance's tags, when Lambda sent any. The sweep matches the "muse-muse-job" tag to a job. */
  tags?: Array<{ key: string; value: string }>;
}

/**
 * A failed Lambda call. `status` is the HTTP status, or 0 when Lambda couldn't be reached or the call timed out.
 * `code` is Lambda's error code, such as "global/object-does-not-exist", when it sent one.
 */
export class LambdaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "LambdaApiError";
  }
}

interface RawRegion {
  name: string;
  description?: string;
}

interface RawInstanceType {
  name: string;
  description?: string;
  gpu_description?: string;
  price_cents_per_hour: number;
  specs?: { gpus?: number };
}

interface RawInstance {
  id: string;
  name?: string | null;
  ip?: string | null;
  status: LambdaInstance["status"];
  region?: RawRegion | null;
  instance_type?: RawInstanceType | null;
  tags?: unknown;
}

interface RawError {
  error?: { code?: string; message?: string };
}

/** Which failures get the one retry. Launch retries only 429, since a 5xx may have launched an instance anyway. */
type RetryOn = "rate-limit-and-server" | "rate-limit";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Replaces the key wherever it shows up, so no message built from a response or a network error can leak it. */
function scrub(text: string, key: string): string {
  return key ? text.split(key).join("[redacted]") : text;
}

function unreachable(err: unknown, what: string, key: string): LambdaApiError {
  const name = (err as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new LambdaApiError(0, "timeout", `Lambda API ${what} timed out after ${Math.round(lambdaTiming.timeoutMs / 1000)} s`);
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new LambdaApiError(0, "network", scrub(`Lambda API ${what} could not reach Lambda: ${detail}`, key));
}

function apiError(status: number, text: string, what: string, key: string): LambdaApiError {
  let code: string | null = null;
  let detail = text.slice(0, 300);
  try {
    const json = JSON.parse(text) as RawError | null;
    code = json?.error?.code ?? null;
    if (json?.error?.message) detail = json.error.message;
  } catch {
    // Not JSON, such as an HTML page from the edge: keep the start of the text.
  }
  const message = `Lambda API ${what} failed (${status}${code ? ` ${code}` : ""})${detail ? `: ${detail}` : ""}`;
  return new LambdaApiError(status, code, scrub(message, key));
}

/** One Lambda call with the key, a 20 s timeout and one retry after 2 s on 429 or 5xx. Returns the parsed body. */
async function lambda<T>(method: "GET" | "POST", path: string, opts: { body?: unknown; retryOn?: RetryOn } = {}): Promise<T> {
  const key = env.lambdaApiKey;
  const what = `${method} ${path.split("?")[0]}`;
  const retryOn = opts.retryOn ?? "rate-limit-and-server";
  for (let attempt = 1; ; attempt++) {
    let status: number;
    let text: string;
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(lambdaTiming.timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      throw unreachable(err, what, key);
    }
    if (status >= 200 && status < 300) {
      try {
        return (text ? JSON.parse(text) : {}) as T;
      } catch {
        throw new LambdaApiError(status, "bad-response", `Lambda API ${what} answered with a body that isn't JSON`);
      }
    }
    const retryable = status === 429 || (retryOn === "rate-limit-and-server" && status >= 500);
    if (retryable && attempt === 1) {
      await wait(lambdaTiming.retryWaitMs);
      continue;
    }
    throw apiError(status, text, what, key);
  }
}

/** Regions starting with `us-` first, otherwise in Lambda's order. */
function usFirst(regions: string[]): string[] {
  return [...regions].sort((a, b) => Number(!a.startsWith("us-")) - Number(!b.startsWith("us-")));
}

/** The well-formed {key, value} string pairs in Lambda's tags, or none. */
function tagsOf(raw: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) => {
    const { key, value } = (t ?? {}) as { key?: unknown; value?: unknown };
    return typeof key === "string" && typeof value === "string" ? [{ key, value }] : [];
  });
}

function toInstance(raw: RawInstance): LambdaInstance {
  const tags = tagsOf(raw.tags);
  return {
    id: raw.id,
    name: raw.name || null,
    status: raw.status,
    ip: raw.ip || null,
    instanceType: raw.instance_type?.name ?? "",
    region: raw.region?.name ?? "",
    ...(tags.length ? { tags } : {}),
  };
}

/** Every instance type on the account, with its price and the regions that have capacity right now. */
export async function listInstanceTypes(): Promise<LambdaInstanceType[]> {
  const res = await lambda<{ data?: Record<string, { instance_type: RawInstanceType; regions_with_capacity_available?: RawRegion[] }> }>(
    "GET",
    "/instance-types",
  );
  return Object.entries(res.data ?? {}).map(([name, item]) => ({
    name: item.instance_type?.name || name,
    description: item.instance_type?.description || item.instance_type?.gpu_description || name,
    priceCentsPerHour: item.instance_type?.price_cents_per_hour ?? 0,
    gpus: item.instance_type?.specs?.gpus ?? 0,
    regionsWithCapacity: usFirst((item.regions_with_capacity_available ?? []).map((r) => r.name)),
  }));
}

/** Every instance on the account, terminated ones included while Lambda still lists them. Follows every page. */
export async function listInstances(): Promise<LambdaInstance[]> {
  const out: LambdaInstance[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ page_size: String(PAGE_SIZE) });
    if (pageToken) query.set("page_token", pageToken);
    const res: { data?: RawInstance[]; page_token?: string | null } = await lambda("GET", `/instances?${query}`);
    out.push(...(res.data ?? []).map(toInstance));
    pageToken = res.page_token || null;
    if (!pageToken) return out;
  }
  // A partial list could hide a running instance from the sweep, so refuse instead of returning it.
  throw new LambdaApiError(0, "too-many-pages", `Lambda API GET /instances returned more than ${MAX_PAGES} pages`);
}

/** One instance, or null when Lambda doesn't know the id. */
export async function getInstance(id: string): Promise<LambdaInstance | null> {
  try {
    const res = await lambda<{ data: RawInstance }>("GET", `/instances/${encodeURIComponent(id)}`);
    return toInstance(res.data);
  } catch (err) {
    if (err instanceof LambdaApiError && err.status === 404) return null;
    throw err;
  }
}

/** The instance with this exact name that isn't terminated or terminating, or null. Launch and sweep use it. */
export async function findInstanceByName(name: string): Promise<LambdaInstance | null> {
  const instances = await listInstances();
  return instances.find((i) => i.name === name && !GONE.includes(i.status)) ?? null;
}

/** Checks what Lambda would refuse, so a bad launch fails before anything is billed. */
function launchProblem(input: Parameters<typeof launchInstance>[0]): string | null {
  if (!input.name || input.name.length > 64) return "the name must be 1 to 64 characters";
  if (!input.instanceType || !input.region) return "an instance type and a region are required";
  if (!input.sshKeyName) return "an SSH key name is required";
  if (Buffer.byteLength(input.userData, "utf8") > MAX_USER_DATA_BYTES) return "user data must be under 1 MB";
  for (const tag of input.tags) {
    if (!TAG_KEY.test(tag.key) || tag.key.length > 55 || tag.key.startsWith("lambda-ai-")) return `tag key "${tag.key}" isn't allowed`;
    if (tag.value.length > 128) return `tag "${tag.key}" has a value over 128 characters`;
  }
  return null;
}

/**
 * Launches one instance with the default Lambda Stack image and returns its id. Billing starts here. A 429 is
 * retried once; a 5xx is not, because the instance may exist anyway: callers look it up by name before launching again.
 */
export async function launchInstance(input: {
  name: string;
  instanceType: string;
  region: string;
  userData: string;
  sshKeyName: string;
  tags: Array<{ key: string; value: string }>;
}): Promise<string> {
  const problem = launchProblem(input);
  if (problem) throw new LambdaApiError(400, "invalid-input", `Not sent to Lambda: ${problem}`);
  const res = await lambda<{ data?: { instance_ids?: string[] } }>("POST", "/instance-operations/launch", {
    body: {
      region_name: input.region,
      instance_type_name: input.instanceType,
      ssh_key_names: [input.sshKeyName],
      name: input.name,
      user_data: input.userData,
      tags: input.tags,
    },
    retryOn: "rate-limit",
  });
  const id = res.data?.instance_ids?.[0];
  if (!id) throw new LambdaApiError(200, "no-instance-id", "Lambda accepted the launch but returned no instance id");
  return id;
}

/** True when Lambda refused a terminate because the instance is already gone. */
function alreadyGone(err: unknown): boolean {
  if (!(err instanceof LambdaApiError)) return false;
  if (err.status === 404) return true;
  if (err.status !== 400 && err.status !== 409) return false;
  return err.code === "global/object-does-not-exist" || /already\s+(been\s+)?terminat/i.test(err.message);
}

/**
 * Terminates instances. Safe to call again: an empty list does nothing, and an instance that is already gone counts
 * as terminated. When Lambda refuses a batch over one gone instance, the rest are terminated one by one.
 */
export async function terminateInstances(ids: string[]): Promise<void> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return;
  try {
    await lambda("POST", "/instance-operations/terminate", { body: { instance_ids: unique } });
  } catch (err) {
    if (!alreadyGone(err)) throw err;
    if (unique.length === 1) return;
    let failure: unknown = null;
    for (const id of unique) {
      try {
        await terminateInstances([id]);
      } catch (one) {
        failure ??= one;
      }
    }
    if (failure) throw failure;
  }
}

/**
 * Picks the GPU and region for a job: the asked type when it is one of the recipe's choices and has capacity,
 * otherwise the first choice with capacity. Regions starting with `us-` come first. Null when nothing is free. A type
 * with no positive price is skipped, since a job's dollar limit and the daily cap are worked out from the price.
 */
export function pickGpu(
  choices: GpuChoice[],
  types: LambdaInstanceType[],
  asked?: string,
): { instanceType: string; region: string; priceCentsPerHour: number } | null {
  const byName = new Map(types.map((t) => [t.name, t]));
  const allowed = choices.map((c) => c.instanceType);
  const order = asked && allowed.includes(asked) ? [asked, ...allowed.filter((name) => name !== asked)] : allowed;
  for (const name of order) {
    const type = byName.get(name);
    if (!type || type.regionsWithCapacity.length === 0 || !(type.priceCentsPerHour > 0)) continue;
    return { instanceType: type.name, region: usFirst(type.regionsWithCapacity)[0], priceCentsPerHour: type.priceCentsPerHour };
  }
  return null;
}
