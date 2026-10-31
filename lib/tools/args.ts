import { isIP } from "node:net";
import type { CatalogFunction, CatalogTool, JsonSchema } from "@/lib/tools/composio/sync";
import { TOOL_LIMITS, USER_INPUT_URL_PARAMS } from "@/lib/tools/policy";

/**
 * The argument checks. The catalog only declares its rules, so they are enforced here: an argument that isn't in the
 * catalog is refused, not dropped, because it is how a call would reach Firecrawl's `actions` or `jsonOptions`, Slack's
 * `blocks`, or Gmail's `to`, which dodges the recipient count.
 */

const EMAIL = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]+$/;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".arpa"];

function privateIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  // WHATWG URL normalises ::ffff:1.2.3.4 to ::ffff:102:304, and both forms are this machine's IPv4 again.
  const mapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return privateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return privateIpv4(dotted[1]);
  return /^(fc|fd|fe[89ab]|ff)/.test(lower);
}

/** True when a URL is public http(s). Parsing first means 2130706433 and 0x7f.1 are read the way a client reads them. */
export function isPublicHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return false;
  const bare = host.replace(/^\[|\]$/g, "");
  const version = isIP(bare);
  if (version === 4) return !privateIpv4(bare);
  if (version === 6) return !privateIpv6(bare);
  // A single-label name only resolves inside some network.
  return host.includes(".");
}

/** The same address however it was typed: scheme, fragment and a bare trailing slash don't count. */
function comparableUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.host.toLowerCase()}${pathname}${url.search}`;
}

const INPUT_URLS = /\bhttps?:\/\/[^\s<>"'`]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#][^\s<>"'`]*)?/gi;

/** Every address in what the person wrote, with or without a scheme. */
export function urlsInInput(input: string): Set<string> {
  const found = new Set<string>();
  for (const raw of input.match(INPUT_URLS) ?? []) {
    const trimmed = raw.replace(/[.,;:!?)\]}]+$/, "");
    const comparable = comparableUrl(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (comparable) found.add(comparable);
  }
  return found;
}

/** Everyone a call reaches, from the tool's recipient fields. Strings and lists of strings. */
export function recipientsOf(tool: Pick<CatalogTool, "recipientFields">, args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const field of tool.recipientFields) {
    const value = args[field];
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) out.push(...value.filter((v): v is string => typeof v === "string"));
  }
  return out;
}

function typeProblem(name: string, value: unknown, schema: JsonSchema | undefined): string | null {
  if (!schema) return null;
  const type = schema.type;
  if (type === "string" && typeof value !== "string") return `${name} must be text.`;
  if (type === "boolean" && typeof value !== "boolean") return `${name} must be true or false.`;
  if (type === "integer" && !Number.isInteger(value)) return `${name} must be a whole number.`;
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `${name} must be a number.`;
  if (type === "array") {
    if (!Array.isArray(value)) return `${name} must be a list.`;
    for (const item of value) {
      const problem = typeProblem(`Each of ${name}`, item, schema.items as JsonSchema | undefined);
      if (problem) return problem;
    }
  }
  if (type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) return `${name} must be an object.`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${name} must be one of: ${schema.enum.join(", ")}.`;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${name} must be at least ${schema.minimum}.`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${name} must be at most ${schema.maximum}.`;
  }
  return null;
}

/** Whole-value URLs in the arguments. A body that merely mentions one is only text. */
function urlProblem(name: string, value: unknown): string | null {
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const text = v.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !isPublicHttpUrl(text)) return `${name} must be a public web address.`;
  }
  return null;
}

function recipientProblem(tool: CatalogTool, args: Record<string, unknown>): string | null {
  const recipients = recipientsOf(tool, args);
  if (recipients.length > TOOL_LIMITS.recipientsMax) {
    return `This can reach at most ${TOOL_LIMITS.recipientsMax} people at once, and this call names ${recipients.length}.`;
  }
  // Slack's one recipient field is a channel, not an address.
  if (tool.toolkit === "slack") {
    return recipients.some((r) => !r.trim() || /[\s,;]/.test(r.trim())) ? "Name one channel, by its ID or its name without the #." : null;
  }
  return recipients.every((r) => EMAIL.test(r)) ? null : "Give each person as one full email address, such as user@example.com.";
}

/** The message that says why these arguments are refused, or null when they pass. */
export function argumentsProblem(tool: CatalogTool, fn: CatalogFunction, args: Record<string, unknown>, userInput: string | null): string | null {
  if (Buffer.byteLength(JSON.stringify(args)) > TOOL_LIMITS.argumentsMaxBytes) {
    return `The arguments are over ${TOOL_LIMITS.argumentsMaxBytes / 1024} KB.`;
  }
  const properties = (fn.parameters.properties ?? {}) as Record<string, JsonSchema>;
  const unknown = Object.keys(args).filter((k) => !Object.hasOwn(properties, k));
  if (unknown.length) {
    return `${fn.name} doesn't take ${unknown.join(", ")}. It takes: ${Object.keys(properties).join(", ")}.`;
  }
  const required = (fn.parameters.required ?? []) as string[];
  const missing = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
  if (missing.length) return `${fn.name} needs ${missing.join(", ")}.`;
  for (const [name, value] of Object.entries(args)) {
    // An explicit null means the same as leaving it out, which is how a strict model says "not set".
    if (value === null) continue;
    const problem = typeProblem(name, value, properties[name]) ?? urlProblem(name, value);
    if (problem) return problem;
  }
  if (typeof args.subject === "string" && /[\r\n]/.test(args.subject)) return "subject must be one line.";
  const inputParam = USER_INPUT_URL_PARAMS[tool.id];
  if (inputParam) {
    const value = args[inputParam];
    if (typeof value !== "string" || !isPublicHttpUrl(value)) return `${inputParam} must be a public web address.`;
    const comparable = comparableUrl(value);
    if (!comparable || !urlsInInput(userInput ?? "").has(comparable)) {
      return `${tool.label} only opens an address the person gave. Use web_search to find pages.`;
    }
  }
  return recipientProblem(tool, args);
}

/** The arguments as they go to the provider: nulls are "not set", so they stay behind. */
export function cleanArguments(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== undefined));
}
