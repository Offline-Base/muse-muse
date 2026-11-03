/**
 * The owner's shared service accounts for builds (docs/BUILD_KEYS.md). With BUILD_SHARED_KEYS on, a build or change
 * started by someone signed in with the builder code gets the owner's dedicated keys in its sandbox's .env.local, and
 * the product it publishes gets the same keys in its own Vercel project as sensitive vars.
 *
 * Values come only from BUILD_SHARED_* vars, which the owner creates with dedicated, revocable keys. The platform's own
 * keys (MODEL_API_KEY, VERCEL_TOKEN, HF_TOKEN and the rest) are never read here, and a BUILD_SHARED_* value that equals
 * one of them is refused. Inside the sandbox and the product each value goes under its service's usual name.
 *
 * Nothing in this file prints, logs or returns a value to a browser. A SharedGrant holds values: keep it inside the
 * step that made it, and never return it from a "use step" function, since a step's result is stored in the workflow
 * run's log.
 */
import { isPowerChild } from "@/lib/caps/platform/child";
import { redactBytes, redactText } from "@/lib/caps/code/musecode/redact";
import { isReservedEmail } from "@/lib/train/public/reserved";

/** The master switch. Off (the default) leaves every build, prompt and product exactly as before. */
export const SHARED_KEYS_FLAG = "BUILD_SHARED_KEYS";

/** The line in .env.local that lists the secret names this build has, so the platform's checks know what to look for. */
export const SHARED_KEYS_LIST_VAR = "MUSEMUSE_SHARED_KEYS";

export type SharedServiceId = "vercel" | "aws" | "lambda" | "hf" | "fleet" | "composio" | "fireworks" | "baseten" | "modal";

export interface SharedVar {
  /** The platform's env var the owner sets. Always BUILD_SHARED_*. */
  from: string;
  /** The name it has in the sandbox's .env.local and the product's env. */
  as: string;
  /** A key or token: redacted everywhere and looked for in the product's files. False for a region or team id. */
  secret: boolean;
  /** The service is passed only when every required var is set. */
  required: boolean;
}

export interface SharedService {
  id: SharedServiceId;
  /** Its name in the prompt, the build room and the docs. */
  name: string;
  vars: readonly SharedVar[];
  /** The API hosts the build sandbox may reach while it has this service's key. */
  hosts(values: Readonly<Record<string, string>>): string[];
}

const key = (from: string, as: string): SharedVar => ({ from, as, secret: true, required: true });
const setting = (from: string, as: string): SharedVar => ({ from, as, secret: false, required: false });

/** An AWS region name, such as us-east-1 or us-gov-west-1. */
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const DEFAULT_AWS_REGION = "us-east-1";

export const SHARED_SERVICES: readonly SharedService[] = [
  {
    id: "vercel",
    name: "Vercel",
    vars: [key("BUILD_SHARED_VERCEL_TOKEN", "VERCEL_TOKEN"), setting("BUILD_SHARED_VERCEL_TEAM_ID", "VERCEL_TEAM_ID")],
    hosts: () => ["api.vercel.com"],
  },
  {
    id: "aws",
    name: "AWS",
    vars: [
      key("BUILD_SHARED_AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
      key("BUILD_SHARED_AWS_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
      setting("BUILD_SHARED_AWS_REGION", "AWS_REGION"),
    ],
    // The global endpoints (STS, IAM, S3's old one) and every service in the one region. A wildcard is written both as
    // one label and as S3's two, since the firewall's docs don't say whether "*" spans dots.
    hosts: (v) => {
      const region = v.AWS_REGION && AWS_REGION.test(v.AWS_REGION) ? v.AWS_REGION : DEFAULT_AWS_REGION;
      return ["sts.amazonaws.com", "iam.amazonaws.com", "s3.amazonaws.com", "*.s3.amazonaws.com", `*.${region}.amazonaws.com`, `*.s3.${region}.amazonaws.com`];
    },
  },
  {
    id: "lambda",
    name: "Lambda",
    vars: [key("BUILD_SHARED_LAMBDA_API_KEY", "LAMBDA_API_KEY")],
    hosts: () => ["cloud.lambda.ai", "cloud.lambdalabs.com"],
  },
  {
    id: "hf",
    name: "Hugging Face",
    vars: [key("BUILD_SHARED_HF_TOKEN", "HF_TOKEN")],
    // The Hub, its API subdomains, and the hosts its file downloads redirect to.
    hosts: () => ["huggingface.co", "*.huggingface.co", "*.hf.co"],
  },
  {
    id: "fleet",
    name: "Jetson fleet",
    vars: [key("BUILD_SHARED_FLEET_URL", "FLEET_URL"), key("BUILD_SHARED_FLEET_KEY", "FLEET_KEY")],
    hosts: (v) => {
      const host = fleetHost(v.FLEET_URL);
      return host ? [host] : [];
    },
  },
  {
    id: "composio",
    name: "Composio",
    vars: [key("BUILD_SHARED_COMPOSIO_API_KEY", "COMPOSIO_API_KEY")],
    hosts: () => ["backend.composio.dev"],
  },
  {
    id: "fireworks",
    name: "Fireworks",
    vars: [key("BUILD_SHARED_FIREWORKS_API_KEY", "FIREWORKS_API_KEY")],
    hosts: () => ["api.fireworks.ai"],
  },
  {
    id: "baseten",
    name: "Baseten",
    vars: [key("BUILD_SHARED_BASETEN_API_KEY", "BASETEN_API_KEY")],
    hosts: () => ["api.baseten.co", "inference.baseten.co", "*.api.baseten.co"],
  },
  {
    id: "modal",
    name: "Modal",
    vars: [key("BUILD_SHARED_MODAL_TOKEN_ID", "MODAL_TOKEN_ID"), key("BUILD_SHARED_MODAL_TOKEN_SECRET", "MODAL_TOKEN_SECRET")],
    hosts: () => ["api.modal.com", "*.modal.run"],
  },
];

/** Every name a shared value can have in a sandbox or a product, for removal and the kill switch. */
export const SHARED_ENV_NAMES: readonly string[] = SHARED_SERVICES.flatMap((s) => s.vars.map((v) => v.as));

/** Every BUILD_SHARED_* var the platform reads, for the docs and tests. */
export const SHARED_SOURCE_NAMES: readonly string[] = SHARED_SERVICES.flatMap((s) => s.vars.map((v) => v.from));

export type EnvSource = Readonly<Record<string, string | undefined>>;

function on(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/** BUILD_SHARED_KEYS. Off by default. */
export function sharedKeysOn(source: EnvSource = process.env): boolean {
  return on(source[SHARED_KEYS_FLAG]);
}

/** The fleet URL's host when it is a public https URL, else null. */
export function fleetHost(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !host.includes(".") || host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$/.test(host) || host.includes(":")) return null;
  return host;
}

/**
 * Characters a value may have. .env.local is read by Next's loader, which cuts an unquoted value at "#" and expands "$",
 * so a value with anything else would arrive changed. Every key these services issue fits.
 */
const SAFE_VALUE = /^[A-Za-z0-9_\-+/=.:~@%,?&]+$/;

/** Names of the platform's own vars whose values a shared key must never equal: keys, tokens, secrets, codes. */
const PLATFORM_SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PEPPER|CODE)(?:_ID)?$|^(?:DATABASE|POSTGRES)_URL$/;

/** What a build gets: the services, their values under their usual names, and the hosts the firewall opens for them. */
export interface SharedGrant {
  services: SharedServiceId[];
  /** Usual name to value. Every value is a real key: never log, print, store or return it. */
  env: Record<string, string>;
  /** The names in `env` that are secrets (SharedVar.secret). */
  secretNames: string[];
  hosts: string[];
}

export interface SharedSkip {
  service: SharedServiceId;
  /** A plain reason with var names only, never a value. */
  reason: string;
}

/**
 * The services the owner set up, from BUILD_SHARED_* only. A service is left out, with a reason, when a required var is
 * missing, a value has characters .env.local can't hold, a value equals one of the platform's own keys, or (Vercel) the
 * team is the platform's own. Reads no flag and no principal: sharedKeysForBuild does those.
 */
export function sharedServicesFrom(source: EnvSource = process.env): { grant: SharedGrant; skipped: SharedSkip[] } {
  const platformValues = new Set(
    Object.entries(source)
      .filter(([name, value]) => !name.startsWith("BUILD_SHARED_") && PLATFORM_SECRET_NAME.test(name) && value?.trim())
      .map(([, value]) => value!.trim()),
  );
  const grant: SharedGrant = { services: [], env: {}, secretNames: [], hosts: [] };
  const skipped: SharedSkip[] = [];
  for (const service of SHARED_SERVICES) {
    const values: Record<string, string> = {};
    for (const v of service.vars) {
      const value = source[v.from]?.trim();
      if (value) values[v.as] = value;
    }
    if (!Object.keys(values).length) continue;
    const missing = service.vars.filter((v) => v.required && !values[v.as]).map((v) => v.from);
    const unsafe = service.vars.filter((v) => values[v.as] && !SAFE_VALUE.test(values[v.as])).map((v) => v.from);
    const reused = service.vars.filter((v) => v.secret && values[v.as] && platformValues.has(values[v.as])).map((v) => v.from);
    const sameTeam = service.id === "vercel" && values.VERCEL_TEAM_ID && values.VERCEL_TEAM_ID === source.VERCEL_TEAM_ID?.trim();
    const hosts = service.hosts(values);
    let reason: string | null = null;
    if (missing.length) reason = `${missing.join(" and ")} ${missing.length === 1 ? "isn't" : "aren't"} set`;
    else if (unsafe.length) reason = `${unsafe.join(" and ")} has characters .env.local can't hold`;
    else if (reused.length) reason = `${reused.join(" and ")} is one of the platform's own keys. Use a dedicated key`;
    else if (sameTeam) reason = "BUILD_SHARED_VERCEL_TEAM_ID is the platform's own team. Use a token for a separate team";
    else if (!hosts.length) reason = `${service.vars[0].from} isn't a public https URL`;
    if (reason) {
      skipped.push({ service: service.id, reason });
      continue;
    }
    grant.services.push(service.id);
    for (const v of service.vars) {
      if (!values[v.as]) continue;
      grant.env[v.as] = values[v.as];
      if (v.secret) grant.secretNames.push(v.as);
    }
    for (const h of hosts) if (!grant.hosts.includes(h)) grant.hosts.push(h);
  }
  return { grant, skipped };
}

const warned = new Set<string>();

/** Says once per process why a set-up service is left out. Names only. */
export function warnSkipped(skipped: readonly SharedSkip[]): void {
  for (const s of skipped) {
    const line = `[build keys] builds don't get ${serviceName(s.service)}: ${s.reason}.`;
    if (warned.has(line)) continue;
    warned.add(line);
    console.warn(line);
  }
}

export function serviceName(id: SharedServiceId): string {
  return SHARED_SERVICES.find((s) => s.id === id)?.name ?? id;
}

/** "Vercel", "Vercel and AWS", "Vercel, AWS and Modal". */
export function serviceList(ids: readonly SharedServiceId[]): string {
  const names = ids.map(serviceName);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Who gets them

/** What the principal check reads about the person who started a build or change. Null when the row is gone. */
export interface SharedPrincipalUser {
  email: string;
  /** users.is_admin. Counts only with an ADMIN_EMAILS address. */
  isAdmin: boolean;
  bannedAt: Date | null;
  /** users.password_hash is set, which only a sign-in with an access code does (lib/auth.ts checkSignIn). */
  hasPassword: boolean;
}

export interface SharedPrincipal {
  kind: "build" | "refine";
  rebuildOf: string | null;
  user: SharedPrincipalUser | null;
}

/**
 * True for a build or change started by someone signed in with the builder code: a real account, not the shared guest
 * or any other address the platform keeps (isReservedEmail), not banned, that either signed in with a code (it has a
 * password) or is a listed admin. A new build a product started itself (a power child) never counts, since no person
 * started it. A change to such a product does, when the person who asked for it does.
 */
export function principalMayUseSharedKeys(p: SharedPrincipal, adminEmails: readonly string[]): boolean {
  const u = p.user;
  if (!u || u.bannedAt || isReservedEmail(u.email)) return false;
  if (p.kind === "build" && isPowerChild(p.rebuildOf)) return false;
  const admin = u.isAdmin && adminEmails.includes(u.email.toLowerCase());
  return admin || u.hasPassword;
}

// ---------------------------------------------------------------------------------------------------------------
// The sandbox

/** .env.local's shared part: the list of secret names, then each value under its usual name. Empty for no grant. */
export function sharedEnvText(grant: SharedGrant | null): string {
  if (!grant?.services.length) return "";
  const lines = [
    "# The owner's shared accounts (.agents/skills/shared-keys). Server code only. Never print, log, return or copy these.",
    `${SHARED_KEYS_LIST_VAR}=${grant.secretNames.join(",")}`,
    ...Object.entries(grant.env).map(([k, v]) => `${k}=${v}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** A bash line that takes every shared name out of a .env.local, for a copy of a sandbox that must not have them. */
export function stripSharedEnvScript(file: string): string {
  const names = [SHARED_KEYS_LIST_VAR, ...SHARED_ENV_NAMES].join("|");
  const quoted = `'${file.replace(/'/g, `'\\''`)}'`;
  const tmp = `'${`${file}.strip`.replace(/'/g, `'\\''`)}'`;
  // grep, not sed -i, so it runs the same with GNU and BSD tools. grep exits 1 when no line is left, which is fine.
  return `if [ -f ${quoted} ]; then { grep -Ev '^(# The owner.s shared accounts|(${names})=)' ${quoted} || true; } > ${tmp} && cat ${tmp} > ${quoted} && rm -f ${tmp}; fi`;
}

/** The section the build or change prompt ends with when it has shared accounts. Empty without, so the prompt is today's. */
export function sharedKeysPromptSection(grant: SharedGrant | null, when: "build" | "change"): string {
  if (!grant?.services.length) return "";
  const names = SHARED_SERVICES.filter((s) => grant.services.includes(s.id)).map(
    (s) => `- ${s.name}: ${s.vars.filter((v) => grant.env[v.as] !== undefined).map((v) => `\`${v.as}\``).join(", ")}`,
  );
  return [
    "",
    "## The owner's service accounts",
    "",
    `This ${when === "build" ? "build" : "change"} can use the owner's own accounts below, and the build machine can reach their APIs. Their keys are in \`.env.local\` under these names, and the live product gets the same names. Use one only when the brief needs it, and read \`.agents/skills/shared-keys/SKILL.md\` first when it is there.`,
    "",
    ...names,
    "",
    "- Server code only: read each key from `process.env` at run time, in a route handler or a server action. Never in a client component, never under a `NEXT_PUBLIC_` name, and never in `next.config.ts`.",
    "- Never print, log, return to the browser or write a key's value into any file, test, screenshot, BUILD_NOTES.md or message. A check reads the product's files, `public/` and `.next/static` for the values, and a build with one fails.",
    "- The model rule in AGENTS.md still holds: every model the product calls is a Meta model. Fireworks, Baseten and Modal are only for Muse Spark Open, which runs there. When the brief lists `muse-spark-open`, call it through the gateway as `.agents/skills/meta-spark-open` says, which is metered and capped, and use these accounts only for what that can't do. Never call another company's model on any account.",
    "- The live product is public, so anyone can use what its routes do with these accounts. Keep each route to what the brief needs, and never let a visitor choose what an account does.",
    "",
  ].join("\n");
}

/** One build room line naming the services, with no values. */
export function sharedKeysRoomLine(grant: SharedGrant): string {
  return `This build can use the owner's ${serviceList(grant.services)} ${grant.services.length === 1 ? "account" : "accounts"}. Their keys stay on the server and are kept out of the logs.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Leak guards

/** Values shorter than this aren't looked for, as in redact.ts: they would match ordinary text. */
const MIN_SECRET_CHARS = 12;
/** An encoding shorter than this isn't looked for. */
const MIN_ENCODED_CHARS = 16;

export interface SharedNeedle {
  text: string;
  /** The usual name of the value it comes from, for a message that never shows the value. */
  name: string;
}

/**
 * The value and its obvious encodings: base64 and base64url at each of the three alignments it can sit at inside a
 * longer encoded string (so a Basic auth header or a JWT that holds it is found too), percent-encoding, hex, and the
 * JSON or JS spelling with "\/". Each base64 form is the part that doesn't depend on the bytes around the value.
 */
export function valueEncodings(value: string): string[] {
  const raw = Buffer.from(value, "utf8");
  const out = new Set<string>([value]);
  for (const k of [0, 1, 2]) {
    const buf = Buffer.concat([Buffer.alloc(k), raw]);
    const end = Math.floor(buf.length / 3) * 4;
    for (const enc of ["base64", "base64url"] as const) {
      const core = buf.toString(enc).slice(k ? 4 : 0, end);
      if (core.length >= MIN_ENCODED_CHARS) out.add(core);
    }
  }
  out.add(encodeURIComponent(value));
  out.add(raw.toString("hex"));
  out.add(value.replace(/\//g, "\\/"));
  return [...out].filter((s) => s.length >= MIN_SECRET_CHARS);
}

let needleCache: { sig: string; needles: SharedNeedle[] } | null = null;

/**
 * Every secret BUILD_SHARED_* value that is set and each of its encodings, longest first, whatever the flag says, so a
 * value is kept out of the logs from the moment it exists. Empty when none is set, which makes every redaction a no-op.
 */
export function sharedNeedles(source: EnvSource = process.env): SharedNeedle[] {
  const pairs: Array<[string, string]> = [];
  for (const s of SHARED_SERVICES) {
    for (const v of s.vars) {
      const value = source[v.from]?.trim();
      if (v.secret && value && value.length >= MIN_SECRET_CHARS) pairs.push([v.as, value]);
    }
  }
  if (!pairs.length) return [];
  const sig = pairs.map(([n, v]) => `${n}\u0000${v}`).join("\u0001");
  if (needleCache?.sig === sig) return needleCache.needles;
  const seen = new Set<string>();
  const needles: SharedNeedle[] = [];
  for (const [name, value] of pairs) {
    for (const text of valueEncodings(value)) {
      if (seen.has(text)) continue;
      seen.add(text);
      needles.push({ text, name });
    }
  }
  needles.sort((a, b) => b.text.length - a.text.length);
  needleCache = { sig, needles };
  return needles;
}

const texts = (needles: readonly SharedNeedle[]) => needles.map((n) => n.text);

/** `text` with every shared value, in any of its encodings, replaced by [redacted]. The same string when none is set. */
export function redactShared(text: string, source: EnvSource = process.env): string {
  const needles = sharedNeedles(source);
  return needles.length ? redactText(text, texts(needles)).text : text;
}

/**
 * A JSON value with every string in it redacted, keys included. Only arrays and plain objects are walked, so a Date or
 * a Buffer inside comes back as it was. The same object when no shared value is set.
 */
export function redactSharedValue<T>(value: T, source: EnvSource = process.env): T {
  const needles = sharedNeedles(source);
  if (!needles.length) return value;
  const list = texts(needles);
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return redactText(v, list).text;
    if (depth > 64 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactText(k, list).text, walk(x, depth + 1)]));
  };
  return walk(value, 0) as T;
}

/** Bytes with every shared value replaced. The same buffer when none is set. */
export function redactSharedBytes(bytes: Buffer, source: EnvSource = process.env): Buffer {
  const needles = sharedNeedles(source);
  return needles.length ? redactBytes(bytes, texts(needles)).bytes : bytes;
}

/** True when these bytes hold a shared value in any of its encodings. latin1 keeps every byte, as holdsSecret does. */
export function holdsSharedValue(content: Buffer, source: EnvSource = process.env): boolean {
  const needles = sharedNeedles(source);
  if (!needles.length) return false;
  const text = content.toString("latin1");
  return needles.some((n) => text.includes(n.text));
}

export interface SharedLeak {
  file: string;
  /** The usual name of the key, or of the var a file names in a way that would publish it. */
  name: string;
  why: "value" | "public-name" | "next-config";
}

const NEXT_CONFIG = /^next\.config\.(?:js|cjs|mjs|ts|mts|cts)$/;

/**
 * What a product's files would leak: a shared value in any encoding in any file, and, for a product that has the keys,
 * a `NEXT_PUBLIC_` spelling of one of their names anywhere or one of their names in next.config, either of which puts
 * the value into the browser's bundle when Vercel builds it. At most `max` findings.
 */
export function sharedLeaksIn(
  files: ReadonlyArray<{ file: string; content: Buffer }>,
  opts: { names?: readonly string[]; source?: EnvSource; max?: number } = {},
): SharedLeak[] {
  const needles = sharedNeedles(opts.source ?? process.env);
  const names = opts.names ?? [];
  const max = opts.max ?? 20;
  const out: SharedLeak[] = [];
  if (!needles.length && !names.length) return out;
  const publicNames = names.map((n) => ({ n, re: new RegExp(`NEXT_PUBLIC_${n}\\b`) }));
  const configNames = names.map((n) => ({ n, re: new RegExp(`\\b${n}\\b`) }));
  for (const f of files) {
    if (out.length >= max) break;
    const text = f.content.toString("latin1");
    const hit = needles.find((needle) => text.includes(needle.text));
    if (hit) {
      out.push({ file: f.file, name: hit.name, why: "value" });
      continue;
    }
    const pub = publicNames.find(({ re }) => re.test(text));
    if (pub) {
      out.push({ file: f.file, name: pub.n, why: "public-name" });
      continue;
    }
    const base = f.file.split("/").pop() ?? f.file;
    const conf = NEXT_CONFIG.test(base) ? configNames.find(({ re }) => re.test(text)) : undefined;
    if (conf) out.push({ file: f.file, name: conf.n, why: "next-config" });
  }
  return out;
}

/** One plain line per leak, naming the file and the var, never the value. */
export function sharedLeakLines(leaks: readonly SharedLeak[]): string[] {
  return leaks.map((l) =>
    l.why === "value"
      ? `${l.file} holds the value of ${l.name}. Read it from process.env in server code at run time instead.`
      : l.why === "public-name"
        ? `${l.file} names NEXT_PUBLIC_${l.name}, which would put the key in the browser's code. Read ${l.name} in server code only.`
        : `${l.file} names ${l.name} in next.config, which can put the key in the browser's code. Read it in server code only.`,
  );
}
