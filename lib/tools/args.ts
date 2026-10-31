import { isIP } from "node:net";
import type { CatalogFunction, CatalogTool, JsonSchema } from "@/lib/tools/composio/sync";
import { TOOL_LIMITS, USER_INPUT_URL_PARAMS } from "@/lib/tools/policy";

/**
 * The argument checks. The catalog only declares its rules, so they are enforced here: an argument that isn't in the
 * catalog is refused, not dropped, because it is how a call would reach Firecrawl's `actions` or `jsonOptions`, Slack's
 * `blocks`, or Gmail's `to`, which dodges the recipient count.
 */

const EMAIL = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]+$/;
/** The longest address mail can carry. The limit also keeps EMAIL's backtracking small. */
const EMAIL_MAX_CHARS = 254;
/** Printable ASCII only, so no invisible, right-to-left or lookalike character reaches a confirmation card. */
const PLAIN_ASCII = /^[\x21-\x7e]+$/;
const SLACK_CHANNEL = /^[A-Za-z0-9_.-]+$/;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".arpa", ".svc"];
/** The words read for addresses. Longer ones are no address anyone typed. */
const INPUT_WORD_MAX_CHARS = 2048;

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

/** The address's eight groups, however it was written. Only for what isIP already called IPv6. */
function ipv6Groups(ip: string): number[] {
  let text = ip.toLowerCase().split("%")[0];
  const dotted = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const groupsOf = (part?: string) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const front = groupsOf(head);
  const back = groupsOf(tail);
  return [...front, ...new Array<number>(Math.max(0, 8 - front.length - back.length)).fill(0), ...back];
}

function privateIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  const ipv4At = (i: number) => `${g[i] >> 8}.${g[i] & 255}.${g[i + 1] >> 8}.${g[i + 1] & 255}`;
  const zeroUpTo = (n: number, from = 0) => g.slice(from, n).every((v) => v === 0);
  // Forms that carry an IPv4 address: compatible (with :: and ::1), mapped, translated, NAT64 and 6to4.
  if (zeroUpTo(6) || (zeroUpTo(5) && g[5] === 0xffff) || (zeroUpTo(4) && g[4] === 0xffff && g[5] === 0)) return privateIpv4(ipv4At(6));
  if (g[0] === 0x64 && g[1] === 0xff9b) return zeroUpTo(6, 2) ? privateIpv4(ipv4At(6)) : true;
  if (g[0] === 0x2002) return privateIpv4(ipv4At(1));
  // Teredo hides its IPv4 address, and the rest are discard, documentation, unique local, link or site local, and multicast.
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true;
  if (g[0] === 0x100 && zeroUpTo(4, 1)) return true;
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xff80) === 0xfe80 || (g[0] & 0xff00) === 0xff00;
}

/** True for anything that isn't a public IP address, which is what a host must resolve only to. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return privateIpv4(ip);
  return version === 6 ? privateIpv6(ip) : true;
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
  if (isIP(bare)) return !isPrivateAddress(bare);
  // A single-label name only resolves inside some network.
  return host.includes(".");
}

/** Walks back instead of using a regex: `[...]+$` is quadratic on a long run that doesn't reach the end. */
function stripEnd(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

/** The same address however it was typed: scheme, fragment and a bare trailing slash don't count. */
function comparableUrl(url: URL): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.host.toLowerCase()}${stripEnd(url.pathname, "/")}${url.search}`;
}

function parsedUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const SCHEME = /https?:\/\//i;
/** A name with no scheme counts only if it ends in something like a top-level domain, so "v1.5" isn't an address. */
const BARE_HOST = /\.[a-z][a-z0-9-]*[a-z0-9]$/;

/** The address in one word, or null. A word with a sign-in part is an email address, which authorizes no site. */
function addressInWord(raw: string): string | null {
  const word = stripEnd(raw, ".,;:!?)]}");
  const start = word.search(SCHEME);
  const bare = start < 0 ? word.replace(/^[([{*_~-]+/, "").replace(/^[^/?#]*:(?!\d)/, "") : "";
  const url = parsedUrl(start < 0 ? `https://${bare}` : word.slice(start));
  if (!url || url.username || url.password) return null;
  if (start < 0 && !BARE_HOST.test(url.hostname)) return null;
  return comparableUrl(url);
}

/**
 * Every address in what the person wrote, with or without a scheme. This runs on up to 64 KB from a visitor before any
 * rate limit, so it splits into words and parses each one, which stays linear. A regex over the whole text didn't.
 */
export function urlsInInput(input: string): Set<string> {
  const found = new Set<string>();
  for (const word of input.split(/[\s<>"'`]+/)) {
    if ((!word.includes(".") && !word.includes("://")) || word.length > INPUT_WORD_MAX_CHARS) continue;
    // The whole word first, since a URL can hold a comma, then each part of a list like a.example,b.example.
    for (const part of [word, ...(/[,;]/.test(word) ? word.split(/[,;]/) : [])]) {
      const address = addressInWord(part);
      if (address) found.add(address);
    }
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

const isEmailAddress = (value: string) => value.length <= EMAIL_MAX_CHARS && PLAIN_ASCII.test(value) && EMAIL.test(value);

function recipientProblem(tool: CatalogTool, args: Record<string, unknown>): string | null {
  const recipients = recipientsOf(tool, args);
  if (recipients.length > TOOL_LIMITS.recipientsMax) {
    return `This can reach at most ${TOOL_LIMITS.recipientsMax} people at once, and this call names ${recipients.length}.`;
  }
  // Slack's one recipient field is a channel, not an address.
  if (tool.toolkit === "slack") {
    return recipients.every((r) => SLACK_CHANNEL.test(r)) ? null : "Name one channel, by its ID or its name without the #.";
  }
  return recipients.every(isEmailAddress) ? null : "Give each person as one full email address, such as user@example.com.";
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
  if (typeof args.subject === "string" && /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(args.subject)) return "subject must be one line, with no hidden characters.";
  const inputParam = USER_INPUT_URL_PARAMS[tool.id];
  if (inputParam) {
    const value = args[inputParam];
    if (typeof value !== "string" || !isPublicHttpUrl(value)) return `${inputParam} must be a public web address.`;
    const parsed = parsedUrl(value);
    const comparable = parsed && comparableUrl(parsed);
    if (!comparable || !urlsInInput(userInput ?? "").has(comparable)) {
      return "This tool only opens an address the person gave. Use web_search to find pages.";
    }
  }
  return recipientProblem(tool, args);
}

/** The arguments as they go to the provider: nulls are "not set", so they stay behind. */
export function cleanArguments(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== undefined));
}

/**
 * read_page's address as it goes to the provider: the parsed form, so a backslash or a tab can't be read differently
 * downstream from how it was checked here. Only for arguments that passed argumentsProblem.
 */
export function withParsedUrl(tool: Pick<CatalogTool, "id">, args: Record<string, unknown>): Record<string, unknown> {
  const param = USER_INPUT_URL_PARAMS[tool.id];
  return param ? { ...args, [param]: new URL(args[param] as string).href } : args;
}

/**
 * True when every address the host resolves to is public, which a name like 127.0.0.1.nip.io isn't. It can't stop a
 * rebind later, so the provider's fetch is still the real boundary. A name that doesn't resolve counts as not public.
 */
export async function resolvesToPublic(url: string, lookup: (host: string) => Promise<string[]>): Promise<boolean> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !isPrivateAddress(host);
  const addresses = await lookup(host);
  return addresses.length > 0 && !addresses.some(isPrivateAddress);
}
