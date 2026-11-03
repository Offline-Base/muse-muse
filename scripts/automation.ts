/**
 * Shared by the scripts that drive the live site with the admin automation key (demo-batch, demo-tunes): the --name=value
 * flags, the site's origin, an authorized JSON POST and the timestamped results file in .data/. The key is sent only as
 * the Authorization header and never printed.
 */
import { mkdirSync, writeFileSync } from "node:fs";

/** The site the scripts call by default. musemuse.dev redirects to www, and a redirect would drop the key. */
export const DEFAULT_SITE = "https://www.musemuse.dev";

/** The value of --name=value, or undefined when it isn't given. */
export function arg(name: string, argv: readonly string[] = process.argv): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

/** The bare words on the command line: the ids to run. */
export function words(argv: readonly string[] = process.argv): string[] {
  return argv.slice(2).filter((a) => !a.startsWith("--"));
}

/** --url as an origin with no trailing slash, or the default. Throws on an empty or malformed value. */
export function siteArg(argv: readonly string[] = process.argv): string {
  const raw = arg("url", argv);
  if (raw === undefined) return DEFAULT_SITE;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--url=${raw} isn't a full address. Give one like --url=${DEFAULT_SITE}.`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`--url must be https (or localhost), not ${url.protocol}`);
  }
  return url.origin;
}

/** The ids asked for, checked against the known ones. Throws on an unknown id, so a typo never "succeeds" with nothing. */
export function pickIds<T extends { id: string }>(all: readonly T[], asked: readonly string[]): T[] {
  if (!asked.length) return [...all];
  const unknown = asked.filter((a) => !all.some((x) => x.id === a));
  if (unknown.length) throw new Error(`${unknown.join(", ")} isn't a known id. Ids: ${all.map((x) => x.id).join(", ")}`);
  return all.filter((x) => asked.includes(x.id));
}

export interface PostResult {
  status: number;
  json: Record<string, unknown>;
}

/**
 * POST JSON with the automation key. Redirects aren't followed: a 301 or 302 would turn the POST into a GET, and a
 * cross-origin hop drops the key, so a redirect comes back as an error that names where it pointed.
 */
export async function postJson(site: string, path: string, body: unknown, secret: string): Promise<PostResult> {
  const res = await fetch(`${site}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  if (res.status >= 300 && res.status < 400) {
    return { status: res.status, json: { error: "redirected", message: `${site}${path} redirects to ${res.headers.get("location") ?? "another address"}. Pass that origin with --url.` } };
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json: json && typeof json === "object" ? json : {} };
}

/** What a refusal said, for the results file: the error code, its message or refusal text, and when to retry. */
export function refusalOf(r: PostResult): Record<string, unknown> {
  const { error, message, refusal, retryAfterSeconds } = r.json as Record<string, unknown>;
  return { status: r.status, ...(error !== undefined ? { error } : {}), ...(message !== undefined ? { message } : {}), ...(refusal !== undefined ? { refusal } : {}), ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) };
}

/** A results file in .data/, named for the script and the time it started. Written again on each save. */
export function resultsFile(prefix: string, startedAt = new Date()): { path: string; save(data: unknown): void } {
  const path = `.data/${prefix}-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
  return {
    path,
    save(data: unknown) {
      mkdirSync(".data", { recursive: true });
      writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
    },
  };
}
