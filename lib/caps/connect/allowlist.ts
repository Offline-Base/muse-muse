import { createHash } from "node:crypto";
import apisJson from "@/lib/caps/connect/apis.json";
import servicesJson from "@/lib/caps/connect/services.json";

/**
 * The connect cap's allowlists (docs/CAPABILITIES.md, section 11), read from lib/caps/connect/apis.json and
 * services.json, and the matching both routes use. Nothing outside these files is reachable: an API's base URL, its
 * paths and parameters, a service's hosts, methods and paths are fixed here, never taken from a request.
 */

export interface ApiPath {
  id: string;
  /** Relative to the API's base, with {name} segments, like /points/{lat},{lon}. */
  path: string;
  does: string;
  /** Each {name} in `path` and the pattern its value must match (after decoding). */
  params?: Record<string, string>;
  /** Query parameters allowed, and the pattern each must match. Others are refused by name. */
  query?: Record<string, string>;
  required?: string[];
  /** Query parameters the gateway always sends and a request can't change. */
  fixed?: Record<string, string>;
  cacheSeconds: number;
}

export interface PublicApi {
  id: string;
  label: string;
  base: string;
  terms: string;
  termsRead: string;
  license: string;
  attribution: string;
  headers?: Record<string, string>;
  /** The most calls the whole platform makes to it a minute, under its own rate. Cached answers don't count. */
  perMinute: number;
  paths: ApiPath[];
}

export type ServiceAuth = { type: "bearer" } | { type: "query"; param: string } | { type: "url"; prefix: string };

export interface ServiceCall {
  method: "GET" | "POST";
  /** `*` is one path segment, `**` (last only) is the rest of the path. */
  path: string;
}

export interface Service {
  id: string;
  label: string;
  hosts: string[];
  auth: ServiceAuth;
  headers?: Record<string, string>;
  keyHint: string;
  docs: string;
  /** Brokered calls (POST /vault/call). Empty for a service that only sends. */
  calls: ServiceCall[];
  /** The send channel this service's key sends on (POST /send), if any. */
  send?: SendChannel;
  /** Whether a visitor's call may use the owner's key. False: only the owner. */
  visitors: boolean;
}

export const SEND_CHANNELS = ["email", "sms", "chat", "social", "payment"] as const;
export type SendChannel = (typeof SEND_CHANNELS)[number];

export const PUBLIC_APIS: Readonly<Record<string, PublicApi>> = Object.fromEntries(
  Object.entries(apisJson as unknown as Record<string, Omit<PublicApi, "id">>).map(([id, a]) => [id, { id, ...a }]),
);
export const SERVICES: Readonly<Record<string, Service>> = Object.fromEntries(
  Object.entries(servicesJson as unknown as Record<string, Omit<Service, "id">>).map(([id, s]) => [id, { id, ...s }]),
);

export const PUBLIC_API_IDS = Object.keys(PUBLIC_APIS) as [string, ...string[]];
/** Services whose keys products call through the gateway. */
export const CALL_SERVICE_IDS = Object.values(SERVICES)
  .filter((s) => s.calls.length)
  .map((s) => s.id) as [string, ...string[]];
/** Channels with a service that sends on them today. The others stay in the stored brief's shape only. */
export const SEND_CHANNELS_LIVE = SEND_CHANNELS.filter((c) => Object.values(SERVICES).some((s) => s.send === c));

export const serviceForChannel = (channel: SendChannel): Service[] => Object.values(SERVICES).filter((s) => s.send === channel);

/**
 * JSON with sorted keys at every depth, the same as lib/tools/sign.ts's canonicalJson. Written again here because this
 * file is imported by the brief schema, which lib/env.ts reads, and lib/tools/sign.ts imports lib/env.ts.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const CONTROL = /[\u0000-\u001f\u007f]/;

function segmentRegex(path: string): { re: RegExp; names: string[] } {
  const names: string[] = [];
  const source = path
    .split(/(\{[a-z_]+\})/)
    .map((part) => {
      const m = part.match(/^\{([a-z_]+)\}$/);
      if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(m[1]!);
      // A value never holds a slash, a comma, a query or a fragment; its own pattern decides the rest.
      return "([^/,?#]+)";
    })
    .join("");
  return { re: new RegExp(`^${source}$`), names };
}

export interface FetchRequest {
  api: string;
  path: string;
  query?: Record<string, string | number | boolean>;
}

export interface FetchTarget {
  api: PublicApi;
  route: ApiPath;
  /** The URL the gateway calls, built from the base and checked values only. */
  url: string;
  /** The normalized request: the same request in any order or spelling gives the same key. */
  normalized: { api: string; path: string; query: Record<string, string> };
  cacheKey: string;
}

/** The API, path and query a request names, checked against apis.json, or why not, in plain words. */
export function matchFetch(req: FetchRequest): FetchTarget | string {
  const api = typeof req.api === "string" ? PUBLIC_APIS[req.api] : undefined;
  if (!api || !Object.hasOwn(PUBLIC_APIS, req.api)) return `${String(req.api).slice(0, 40)} isn't one of the public APIs products can use: ${PUBLIC_API_IDS.join(", ")}.`;
  if (typeof req.path !== "string" || !req.path.startsWith("/") || req.path.length > 300 || CONTROL.test(req.path)) return "path starts with / and is up to 300 characters.";
  if (req.path.includes("?") || req.path.includes("#")) return "Put query parameters in query, not in path.";
  let decodedPath: string[];
  try {
    decodedPath = req.path.split("/").map((s) => decodeURIComponent(s));
  } catch {
    return "path isn't valid.";
  }
  if (decodedPath.some((s) => s === ".." || s === "." || s.includes("/") || s.includes("\\"))) return "path can't climb out of the API.";
  for (const route of api.paths) {
    const { re, names } = segmentRegex(route.path);
    const m = decodedPath.join("/").match(re);
    if (!m) continue;
    const values: Record<string, string> = {};
    for (const [i, name] of names.entries()) {
      const value = m[i + 1]!;
      const pattern = route.params?.[name];
      if (!pattern || !new RegExp(pattern).test(value) || CONTROL.test(value)) return `${name} in the path isn't a value ${api.id} takes.`;
      values[name] = value;
    }
    const query: Record<string, string> = {};
    for (const [k, raw] of Object.entries(req.query ?? {})) {
      if (raw === undefined || raw === null) continue;
      const pattern = route.query?.[k];
      if (!pattern) return `${api.id} ${route.id} doesn't take ${k.slice(0, 40)}.${route.query ? ` It takes ${Object.keys(route.query).join(", ")}.` : ""}`;
      const value = String(raw).trim();
      if (!new RegExp(pattern).test(value) || CONTROL.test(value)) return `${k} isn't a value ${api.id} takes.`;
      query[k] = value;
    }
    for (const k of route.required ?? []) if (!(k in query)) return `${api.id} ${route.id} needs ${k}.`;
    const built = route.path.replace(/\{([a-z_]+)\}/g, (_, name: string) => encodeURIComponent(values[name]!).replace(/%2C/g, ","));
    const sorted = Object.fromEntries(Object.entries(query).sort(([a], [b]) => (a < b ? -1 : 1)));
    const url = new URL(`${api.base}${built}`);
    for (const [k, v] of Object.entries({ ...sorted, ...(route.fixed ?? {}) })) url.searchParams.set(k, v);
    const normalized = { api: api.id, path: built, query: sorted };
    return { api, route, url: url.toString(), normalized, cacheKey: createHash("sha256").update(canonicalJson(normalized)).digest("hex") };
  }
  return `${api.id} has no path like that. Its paths: ${api.paths.map((p) => p.path).join(", ")}.`;
}

/** True for a path pattern of a service call: `*` is one segment, `**` the rest. */
function callMatches(pattern: string, path: string): boolean {
  const a = pattern.split("/");
  const b = path.split("/");
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "**") return i === a.length - 1 && b.length > i && b.slice(i).every((s) => s.length > 0);
    if (i >= b.length) return false;
    if (a[i] === "*") {
      if (!b[i]) return false;
      continue;
    }
    if (a[i] !== b[i]) return false;
  }
  return a.length === b.length;
}

export interface CallTarget {
  service: Service;
  call: ServiceCall;
  method: "GET" | "POST";
  /** Host, path and query, without the key. The key is added at the last moment, inside the gateway. */
  url: URL;
}

/** A brokered call checked against services.json, or why not. Only the service's own hosts, methods and paths. */
export function matchCall(serviceId: string, method: string, path: string): CallTarget | string {
  const service = Object.hasOwn(SERVICES, serviceId) ? SERVICES[serviceId] : undefined;
  if (!service) return "That key is for a service products can't call.";
  if (!service.calls.length) return `${service.label} keys only send messages, through /send.`;
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "POST") return "method is GET or POST.";
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.length > 1000 || CONTROL.test(path) || path.includes("\\") || path.includes("#")) {
    return "path starts with one / and is up to 1,000 characters.";
  }
  if (/%2f|%5c|%2e/i.test(path.split("?")[0]!)) return "path can't climb out of the API.";
  const url = new URL(path, `https://${service.hosts[0]}`);
  if (url.host !== service.hosts[0]) return "path must stay on the service's own host.";
  if (/%2f|%5c|%2e/i.test(url.pathname) || url.pathname.split("/").some((s) => s === ".." || s === ".")) return "path can't climb out of the API.";
  const call = service.calls.find((c) => c.method === m && callMatches(c.path, url.pathname));
  if (!call) return `${service.label} calls go only to: ${service.calls.map((c) => `${c.method} ${c.path}`).join(", ")}.`;
  if (service.auth.type === "query") url.searchParams.delete(service.auth.param);
  return { service, call, method: m as "GET" | "POST", url };
}

/** The canned pick for a build: hash(normalized arguments) % n, so the same call gets the same sample every run. */
export function pickSample<T>(list: readonly T[], args: unknown): T | undefined {
  if (!list.length) return undefined;
  const hash = createHash("sha256").update(canonicalJson(args)).digest();
  return list[hash.readUInt32BE(0) % list.length];
}

/** A key's name in the vault: lowercase letters, digits and underscores, up to 40. */
export const KEY_NAME = /^[a-z][a-z0-9_]{0,39}$/;
