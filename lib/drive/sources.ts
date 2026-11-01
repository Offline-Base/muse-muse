/**
 * Where a board gets each file a drive plan doesn't carry inline (docs/DRIVE_EXPORT.md, "URLs: who signs them, how long
 * they last"), made at the moment the board needs them. A kit file is its public Blob URL. A lab model's GGUF in a public
 * repo is its resolve URL at the commit, and the board follows the Hub's redirect itself. One in a private repo is the
 * Location the Hub answers that resolve URL with, asked with HF_TOKEN and redirect "manual": a URL the Hub signed, which is
 * a secret while it lasts. The HF token never leaves the platform, and nothing here stores or logs a signed URL.
 */
import type { DriveKit } from "@/lib/drive/kit";
import { kitFileUrl } from "@/lib/drive/kit";
import type { DrivePlan } from "@/lib/drive/plan";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const HUB = "https://huggingface.co";
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class SourceError extends Error {}

function checked(repo: string, commit: string, name: string): void {
  if (!REPO.test(repo) || !COMMIT.test(commit) || !FILE.test(name)) throw new SourceError("That model's repo, commit or file name isn't one the Hub would have.");
}

/** A file in a GGUF repo at a commit, as the Hub serves it to anyone when the repo is public. */
export function resolveUrl(repo: string, commit: string, name: string): string {
  checked(repo, commit, name);
  return `${HUB}/${repo}/resolve/${commit}/${name}`;
}

/** Blanks anything that looks like a signed URL (one with a query) out of text, as lib/train/hub.ts does. */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]*\?[^\s"'<>]*/g, "[signed URL]");
}

/** A link that stops working: it carries a signature in its query. Such a file can't be armed, since a drive may come later. */
export function expiringUrl(url: string): boolean {
  return URL.canParse(url) && new URL(url).search.length > 1;
}

/**
 * The link the Hub signs for a file in a private repo: its answer to the resolve URL, asked with the token, without
 * following it. How long such a link lasts is unchecked (docs/TRAINING.md), so it is made only when the board needs it.
 */
export async function signedHubUrl(repo: string, commit: string, name: string, token: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const url = resolveUrl(repo, commit, name);
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", redirect: "manual", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new SourceError(`The Hub didn't answer for ${name}.`);
  }
  await res.body?.cancel().catch(() => {});
  const location = res.headers.get("location");
  if (res.status < 300 || res.status >= 400 || !location) throw new SourceError(`The Hub didn't give a link for ${name} (HTTP ${res.status}).`);
  const signed = new URL(location, url);
  if (signed.protocol !== "https:") throw new SourceError(`The Hub's link for ${name} isn't https.`);
  return signed.href;
}

/** Text from a GGUF repo at a commit: the model card or tuned.jinja. A private repo needs the token. */
export async function hubText(repo: string, commit: string, name: string, token: string | null, fetchImpl: FetchLike = fetch): Promise<string> {
  checked(repo, commit, name);
  const res = await fetchImpl(`${HUB}/${repo}/raw/${commit}/${name}`, {
    redirect: "follow",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res?.ok) throw new SourceError(`Couldn't read ${name} from the model's repo${res ? ` (HTTP ${res.status})` : ""}.`);
  return res.text();
}

/**
 * The link for every file of a plan the board downloads, by sha256: the kit's files from Blob, then the model's files from
 * the Hub, public or signed. `cloud` names each model file by sha256; a board source has none.
 */
export async function planUrls(
  plan: Pick<DrivePlan, "files">,
  kit: DriveKit,
  cloud: { repo: string; commit: string; public: boolean; files: Record<string, string> } | null,
  opts: { hfToken?: string | null; fetchImpl?: FetchLike } = {},
): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  for (const f of plan.files) {
    if ("kit" in f) {
      const url = kitFileUrl(kit, f.sha256);
      if (!url) throw new SourceError("The drive kit isn't uploaded yet. Run scripts/drive-kit.ts --upload.");
      urls[f.sha256] = url;
    } else if ("url" in f) {
      const name = cloud?.files[f.sha256];
      if (!cloud || !name) throw new SourceError(`Nothing says where ${f.path} comes from.`);
      if (cloud.public) urls[f.sha256] = resolveUrl(cloud.repo, cloud.commit, name);
      else if (opts.hfToken) urls[f.sha256] = await signedHubUrl(cloud.repo, cloud.commit, name, opts.hfToken, opts.fetchImpl);
      else throw new SourceError("This model's files are private, and HF_TOKEN isn't set, so the board can't be given a link to them.");
    }
  }
  return urls;
}
