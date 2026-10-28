import { env } from "@/lib/env";
import { SERVE_PORT, type GpuChoice } from "@/lib/train/types";

/**
 * Lambda Cloud REST client for fine-tuning jobs (docs/TRAINING.md "Lambda client"). Platform only: LAMBDA_API_KEY is
 * read on every call, sent only in the Authorization header and scrubbed from every error message.
 *
 * Endpoints: GET /instance-types, GET /instances (paged), GET /instances/{id}, POST /instance-operations/launch,
 * POST /instance-operations/terminate, GET /filesystems, POST /filesystems, GET /firewall-rulesets, POST
 * /firewall-rulesets and PATCH /firewall-rulesets/{id}. Lambda bills from launch until terminate, so terminate is
 * idempotent. Filesystems (the model cache) are only ever listed and created, never deleted. Firewall rulesets (the
 * live demo's port) are listed, created and corrected, never deleted, and only ever the platform's own by name.
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
/** Lambda's rules for a filesystem name (FilesystemCreateRequest). */
const FILESYSTEM_NAME = /^[a-zA-Z]+[0-9a-zA-Z-]*$/;
const FILESYSTEM_NAME_MAX = 60;
/** The model cache's filesystem in a region is named this plus the region, such as muse-muse-cache-us-east-1. */
export const CACHE_FILESYSTEM_PREFIX = "muse-muse-cache-";
/** The live demo's firewall ruleset in a region is named this plus the region, such as muse-muse-serve-us-east-1. */
export const SERVE_FIREWALL_PREFIX = "muse-muse-serve-";
/** Lambda's limit on a firewall ruleset name (FirewallRulesetCreateRequest). */
const FIREWALL_NAME_MAX = 64;
/** Lambda's region names, such as us-east-1. Anything else is refused before it is sent. */
const REGION_NAME = /^[a-z][a-z0-9-]*[a-z0-9]$/;
/** A firewall ruleset id as Lambda writes them (32 hex characters), kept loose so a longer id still passes. */
const FIREWALL_ID = /^[A-Za-z0-9-]{1,64}$/;
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

/** One inbound rule of a firewall ruleset, as Lambda writes it (FirewallRule). */
export interface LambdaFirewallRule {
  protocol: "tcp" | "udp" | "icmp" | "all";
  /** An inclusive [min, max]; none for icmp. */
  port_range?: [number, number];
  /** CIDR, such as 0.0.0.0/0. */
  source_network: string;
  description: string;
}

/** A firewall ruleset from GET /firewall-rulesets. It lives in one region and attaches only to instances there. */
export interface LambdaFirewallRuleset {
  id: string;
  name: string;
  region: string;
  rules: LambdaFirewallRule[];
  instanceIds: string[];
}

/** A persistent filesystem from GET /filesystems. It lives in one region and only mounts on instances there. */
export interface LambdaFilesystem {
  id: string;
  name: string;
  region: string;
  /** Where instances mount it by default: /lambda/nfs/<name>. */
  mountPoint: string;
  inUse: boolean;
  /** Lambda's estimate, updated every few hours; null when it sent none. */
  bytesUsed: number | null;
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

interface RawFilesystem {
  id: string;
  name: string;
  mount_point?: string | null;
  is_in_use?: boolean;
  region?: RawRegion | null;
  bytes_used?: number | null;
}

interface RawFirewallRuleset {
  id: string;
  name: string;
  region?: RawRegion | null;
  rules?: unknown;
  instance_ids?: unknown;
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
async function lambda<T>(method: "GET" | "POST" | "PATCH", path: string, opts: { body?: unknown; retryOn?: RetryOn } = {}): Promise<T> {
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
  for (const name of input.fileSystemNames ?? []) {
    if (!FILESYSTEM_NAME.test(name) || name.length > FILESYSTEM_NAME_MAX) return `filesystem name "${name}" isn't allowed`;
  }
  for (const id of input.firewallRulesetIds ?? []) {
    if (!FIREWALL_ID.test(id)) return `firewall ruleset id "${id}" isn't allowed`;
  }
  for (const tag of input.tags) {
    if (!TAG_KEY.test(tag.key) || tag.key.length > 55 || tag.key.startsWith("lambda-ai-")) return `tag key "${tag.key}" isn't allowed`;
    if (tag.value.length > 128) return `tag "${tag.key}" has a value over 128 characters`;
  }
  return null;
}

/**
 * Launches one instance with the default Lambda Stack image and returns its id. Billing starts here. A 429 is
 * retried once; a 5xx is not, because the instance may exist anyway: callers look it up by name before launching again.
 * `fileSystemNames` are mounted at their default mount points; they must be in the instance's region. So must
 * `firewallRulesetIds` (sent as firewall_rulesets only when non-empty): only a glimmer-serve job gets one, which opens
 * its demo port (ensureServeFirewall).
 */
export async function launchInstance(input: {
  name: string;
  instanceType: string;
  region: string;
  userData: string;
  sshKeyName: string;
  tags: Array<{ key: string; value: string }>;
  fileSystemNames?: string[];
  firewallRulesetIds?: string[];
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
      ...(input.fileSystemNames?.length ? { file_system_names: input.fileSystemNames } : {}),
      ...(input.firewallRulesetIds?.length ? { firewall_rulesets: input.firewallRulesetIds.map((id) => ({ id })) } : {}),
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

/** The model cache's filesystem name in a region, such as muse-muse-cache-us-east-1. */
export function cacheFilesystemName(region: string): string {
  return `${CACHE_FILESYSTEM_PREFIX}${region}`;
}

function toFilesystem(raw: RawFilesystem): LambdaFilesystem {
  return {
    id: raw.id,
    name: raw.name,
    region: raw.region?.name ?? "",
    mountPoint: raw.mount_point || `/lambda/nfs/${raw.name}`,
    inUse: raw.is_in_use === true,
    bytesUsed: typeof raw.bytes_used === "number" ? raw.bytes_used : null,
  };
}

/** Every persistent filesystem on the account. */
export async function listFilesystems(): Promise<LambdaFilesystem[]> {
  const res = await lambda<{ data?: RawFilesystem[] }>("GET", "/filesystems");
  return (res.data ?? []).map(toFilesystem);
}

/** The cache filesystem for `region` in a listing, or null. One with the right name in another region is refused. */
function cacheIn(listed: LambdaFilesystem[], region: string): LambdaFilesystem | null {
  const name = cacheFilesystemName(region);
  const found = listed.find((f) => f.name === name);
  if (found && found.region && found.region !== region) {
    throw new LambdaApiError(409, "filesystem-in-wrong-region", `Filesystem ${name} is in ${found.region}, not ${region}`);
  }
  return found ?? null;
}

/**
 * The model cache filesystem for a region, created when the account has none there. Idempotent: it lists first, and
 * creates with one POST /filesystems (a 429 is retried once, since nothing was made). When the create fails as a
 * duplicate, or ambiguously (timeout, network or 5xx), the listing is read once more and an existing one is returned.
 * Otherwise the error is thrown and nothing retries the create. Only launchStep calls it. Never deleted.
 */
export async function ensureFilesystem(region: string): Promise<LambdaFilesystem> {
  const name = cacheFilesystemName(region);
  if (!region || !FILESYSTEM_NAME.test(name) || name.length > FILESYSTEM_NAME_MAX) {
    throw new LambdaApiError(400, "invalid-input", `Not sent to Lambda: no cache filesystem name for region "${region}"`);
  }
  const existing = cacheIn(await listFilesystems(), region);
  if (existing) return existing;
  try {
    const res = await lambda<{ data?: RawFilesystem }>("POST", "/filesystems", { body: { name, region }, retryOn: "rate-limit" });
    if (!res.data?.id) throw new LambdaApiError(200, "no-filesystem", "Lambda accepted the filesystem but returned none");
    return toFilesystem(res.data);
  } catch (err) {
    const settle =
      err instanceof LambdaApiError &&
      (err.code === "global/duplicate" || err.code === "no-filesystem" || err.status === 0 || err.status >= 500);
    if (!settle) throw err;
    const made = cacheIn(await listFilesystems(), region);
    if (made) return made;
    throw err;
  }
}

/**
 * The model cache filesystem a region already has, or null when it has none. Only lists, never creates: a glimmer-serve
 * job must mount the filesystem its adapter was saved on, and a new empty one wouldn't hold it. A cache name found in
 * another region is refused as ensureFilesystem refuses it.
 */
export async function findCacheFilesystem(region: string): Promise<LambdaFilesystem | null> {
  const name = cacheFilesystemName(region);
  if (!region || !FILESYSTEM_NAME.test(name) || name.length > FILESYSTEM_NAME_MAX) {
    throw new LambdaApiError(400, "invalid-input", `Not sent to Lambda: no cache filesystem name for region "${region}"`);
  }
  return cacheIn(await listFilesystems(), region);
}

/** Regions that already have a model cache filesystem, in Lambda's order. Throws LambdaApiError like the other calls. */
export async function cacheRegions(): Promise<string[]> {
  const listed = await listFilesystems();
  const regions = listed.filter((f) => f.region && f.name === cacheFilesystemName(f.region)).map((f) => f.region);
  return [...new Set(regions)];
}

/**
 * Picks the GPU and region for a job. The asked type wins when it is one of the recipe's choices and has capacity.
 * Otherwise the first choice with capacity in one of `preferRegions` (where the model cache already is) is taken,
 * then the first choice with capacity anywhere. Within a type, a preferred region comes first, then regions starting
 * with `us-`. Null when nothing is free. A type with no positive price is skipped, since a job's dollar limit and the
 * daily cap are worked out from the price. With `onlyRegion`, capacity anywhere else doesn't count: a glimmer-serve
 * job must launch where its adapter's cache filesystem is.
 */
export function pickGpu(
  choices: GpuChoice[],
  types: LambdaInstanceType[],
  asked?: string,
  preferRegions: string[] = [],
  onlyRegion?: string,
): { instanceType: string; region: string; priceCentsPerHour: number } | null {
  if (onlyRegion !== undefined) {
    const pinned = types.map((t) => ({ ...t, regionsWithCapacity: t.regionsWithCapacity.filter((r) => r === onlyRegion) }));
    return pickGpu(choices, pinned, asked, [onlyRegion]);
  }
  const byName = new Map(types.map((t) => [t.name, t]));
  const allowed = choices.map((c) => c.instanceType);
  const preferred = new Set(preferRegions);
  const usable = (name: string): LambdaInstanceType | null => {
    const type = byName.get(name);
    return type && type.regionsWithCapacity.length > 0 && type.priceCentsPerHour > 0 ? type : null;
  };
  const cached = (type: LambdaInstanceType) => usFirst(type.regionsWithCapacity).filter((r) => preferred.has(r));
  const pick = (type: LambdaInstanceType, regions: string[]) => ({
    instanceType: type.name,
    region: regions[0],
    priceCentsPerHour: type.priceCentsPerHour,
  });

  const wanted = asked && allowed.includes(asked) ? usable(asked) : null;
  if (wanted) return pick(wanted, cached(wanted).length ? cached(wanted) : usFirst(wanted.regionsWithCapacity));
  for (const name of allowed) {
    const type = usable(name);
    if (type && cached(type).length) return pick(type, cached(type));
  }
  for (const name of allowed) {
    const type = usable(name);
    if (type) return pick(type, usFirst(type.regionsWithCapacity));
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The live demo's firewall ruleset (docs/TRAINING.md "Live demo").

/** The live demo's firewall ruleset name in a region, such as muse-muse-serve-us-east-1. */
export function serveFirewallName(region: string): string {
  return `${SERVE_FIREWALL_PREFIX}${region}`;
}

/**
 * The rules the live demo's ruleset must hold: only the demo's HTTPS port, from every address. SSH and everything else
 * stay as the account's global ruleset has them (the spec's GlobalFirewallRuleset: "Firewall rules that apply across
 * all regions"), so an owner who narrowed SSH there keeps it narrowed on a demo's GPU. The demo port is open to every
 * address because the platform's proxy runs on Vercel, whose outbound addresses aren't fixed; the server answers only
 * with the serving key, over TLS the proxy pins.
 */
export function serveFirewallRules(): LambdaFirewallRule[] {
  return [
    {
      protocol: "tcp",
      port_range: [SERVE_PORT, SERVE_PORT],
      source_network: "0.0.0.0/0",
      description: "Muse Muse live demo: HTTPS with a serving key, certificate pinned by the platform",
    },
  ];
}

function toFirewallRule(raw: unknown): LambdaFirewallRule | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const protocol = r.protocol;
  if (protocol !== "tcp" && protocol !== "udp" && protocol !== "icmp" && protocol !== "all") return null;
  if (typeof r.source_network !== "string") return null;
  const ports = r.port_range;
  const range = Array.isArray(ports) && ports.length === 2 && ports.every((p) => Number.isInteger(p)) ? ([ports[0], ports[1]] as [number, number]) : undefined;
  return {
    protocol,
    ...(range ? { port_range: range } : {}),
    source_network: r.source_network,
    description: typeof r.description === "string" ? r.description : "",
  };
}

function toFirewallRuleset(raw: RawFirewallRuleset): LambdaFirewallRuleset {
  const rules = Array.isArray(raw.rules) ? raw.rules.map(toFirewallRule).filter((r): r is LambdaFirewallRule => r !== null) : [];
  const ids = Array.isArray(raw.instance_ids) ? raw.instance_ids.filter((i): i is string => typeof i === "string") : [];
  return { id: raw.id, name: raw.name, region: raw.region?.name ?? "", rules, instanceIds: ids };
}

/** Every firewall ruleset on the account (the global one isn't listed here). */
export async function listFirewallRulesets(): Promise<LambdaFirewallRuleset[]> {
  const res = await lambda<{ data?: RawFirewallRuleset[] }>("GET", "/firewall-rulesets");
  return (res.data ?? []).map(toFirewallRuleset);
}

/** A source network that lets every IPv4 address in. A bare address is a /32 to Lambda, so "0.0.0.0" isn't one. */
function everyone(source: string): boolean {
  return source.trim() === "0.0.0.0/0";
}

/** True when `rules` let in what every wanted rule lets in: the same protocol and ports, from everywhere. */
function covers(rules: LambdaFirewallRule[], wanted: LambdaFirewallRule[]): boolean {
  return wanted.every((w) =>
    rules.some(
      (r) =>
        (r.protocol === w.protocol || r.protocol === "all") &&
        everyone(r.source_network) &&
        (r.protocol === "all" ||
          (r.port_range !== undefined && w.port_range !== undefined && r.port_range[0] <= w.port_range[0] && r.port_range[1] >= w.port_range[1])),
    ),
  );
}

/** The demo ruleset for `region` in a listing, or null. Only one with exactly the platform's name, in that region. */
function serveRulesetIn(listed: LambdaFirewallRuleset[], region: string): LambdaFirewallRuleset | null {
  const name = serveFirewallName(region);
  return listed.find((r) => r.name === name && r.region === region) ?? null;
}

/**
 * The live demo's firewall ruleset for a region, which lets in the demo's HTTPS port from everywhere
 * (serveFirewallRules). Idempotent like ensureFilesystem: it lists first; a ruleset of that name in the region is
 * reused as it is while it lets that port in from everywhere, whatever else the owner put in it. When it no longer
 * does (someone edited it in the console), one PATCH /firewall-rulesets/{id} sends its rules with the demo's rule added,
 * so the owner's other rules stay. Only when the region has none is it created, with one POST /firewall-rulesets
 * { name, region, rules } (a 429 is retried once, since nothing was made). When the create fails as a duplicate or a
 * conflict, or ambiguously (timeout, network or 5xx), the listing is read once more and a ruleset that is there is
 * returned; otherwise the error is thrown and nothing retries the create. Only launchStep calls it, for a
 * glimmer-serve job. Never deleted.
 */
export async function ensureServeFirewall(region: string): Promise<LambdaFirewallRuleset> {
  const name = serveFirewallName(region);
  if (!region || !REGION_NAME.test(region) || name.length > FIREWALL_NAME_MAX) {
    throw new LambdaApiError(400, "invalid-input", `Not sent to Lambda: no firewall ruleset name for region "${region}"`);
  }
  const rules = serveFirewallRules();
  const existing = serveRulesetIn(await listFirewallRulesets(), region);
  if (existing) {
    const missing = rules.filter((rule) => !covers(existing.rules, [rule]));
    if (!missing.length) return existing;
    const patched = [...existing.rules, ...missing];
    const res = await lambda<{ data?: RawFirewallRuleset }>("PATCH", `/firewall-rulesets/${encodeURIComponent(existing.id)}`, {
      body: { rules: patched },
    });
    return res.data?.id ? toFirewallRuleset(res.data) : { ...existing, rules: patched };
  }
  try {
    const res = await lambda<{ data?: RawFirewallRuleset }>("POST", "/firewall-rulesets", {
      body: { name, region, rules },
      retryOn: "rate-limit",
    });
    if (!res.data?.id) throw new LambdaApiError(200, "no-firewall-ruleset", "Lambda accepted the firewall ruleset but returned none");
    return toFirewallRuleset(res.data);
  } catch (err) {
    const settle =
      err instanceof LambdaApiError &&
      (err.code === "global/duplicate" ||
        err.code === "no-firewall-ruleset" ||
        err.status === 409 ||
        err.status === 0 ||
        err.status >= 500);
    if (!settle) throw err;
    const made = serveRulesetIn(await listFirewallRulesets(), region);
    if (made) return made;
    throw err;
  }
}
