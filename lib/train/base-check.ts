/**
 * Reads the Hub for a base someone picked (lib/train/bases.ts holds the rules): the repo at a commit, its files' sizes,
 * and for a gated repo whether HF_TOKEN may open it. Server only. A repo id reaches a URL here only after repoProblem
 * passed it, and a redirect may only stay on the Hub (a renamed repo's old name redirects to the new).
 */
import { COMMIT_RE, checkFacts, GATED_REFUSAL, repoProblem, type BaseCheck, type HubFacts } from "@/lib/train/bases";

const HUB = "https://huggingface.co";
const TIMEOUT_MS = 15_000;

type Fetcher = typeof fetch;

export interface BaseCheckDeps {
  fetch?: Fetcher;
  /** HF_TOKEN, read by the caller. */
  token?: string | null;
}

const hubToken = () => process.env.HF_TOKEN?.trim() || null;

function read(fetcher: Fetcher, url: string, init: RequestInit = {}) {
  return fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
}

/** The repo's own facts, from the Hub's public API, or the sentence why not. */
async function hubFacts(fetcher: Fetcher, repo: string, revision: string | null): Promise<HubFacts | string> {
  const res = await read(fetcher, `${HUB}/api/models/${repo}${revision ? `/revision/${revision}` : ""}`);
  if (res.url && new URL(res.url).hostname !== "huggingface.co") return "The Hub sent that repo somewhere else, so it isn't accepted.";
  if (res.status === 401 || res.status === 403 || res.status === 404) return "Hugging Face has no public repo by that id at that commit.";
  if (!res.ok) return "Hugging Face didn't answer, so that base can't be checked. Try again in a moment.";
  const d = (await res.json()) as {
    id?: unknown;
    sha?: unknown;
    gated?: unknown;
    private?: unknown;
    cardData?: { license?: unknown } | null;
    config?: { architectures?: unknown; quantization_config?: unknown } | null;
    safetensors?: { total?: unknown } | null;
  };
  const id = typeof d.id === "string" ? d.id : "";
  const sha = typeof d.sha === "string" ? d.sha : "";
  // The Hub's own id is the one held to the allowlist again, before it goes into another URL.
  const problem = repoProblem(id);
  if (problem) return problem;
  if (!COMMIT_RE.test(sha)) return "The Hub didn't give a full commit for that repo, so it can't be pinned.";
  if (revision && sha !== revision) return "The Hub answered with another commit than the one pinned.";
  const tree = await read(fetcher, `${HUB}/api/models/${id}/tree/${sha}`);
  if (!tree.ok) return "Hugging Face didn't list that repo's files, so its size can't be checked.";
  const files = (await tree.json()) as { path?: unknown; size?: unknown }[];
  const bytes = files.reduce((sum, f) => sum + (typeof f.path === "string" && f.path.endsWith(".safetensors") && typeof f.size === "number" ? f.size : 0), 0);
  const license = d.cardData?.license;
  const architectures = d.config?.architectures;
  return {
    id,
    sha,
    gated: Boolean(d.gated),
    private: d.private === true,
    license: typeof license === "string" ? license : null,
    architectures: Array.isArray(architectures) ? architectures.filter((a): a is string => typeof a === "string") : [],
    quantized: Boolean(d.config?.quantization_config),
    params: typeof d.safetensors?.total === "number" ? d.safetensors.total : 0,
    bytes,
  };
}

/** Whether HF_TOKEN opens a gated repo at this commit: 401 or 403 means its license wasn't accepted, or the token can't. */
async function gatedOpens(fetcher: Fetcher, repo: string, sha: string, token: string | null): Promise<string | null> {
  if (!token) return GATED_REFUSAL;
  const res = await read(fetcher, `${HUB}/${repo}/resolve/${sha}/config.json`, { method: "HEAD", redirect: "manual", headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) return GATED_REFUSAL;
  if (res.status >= 400) return "Hugging Face didn't answer about that gated model, so it can't be checked. Try again in a moment.";
  return null;
}

/**
 * The base a person asked for, pinned and checked, or the sentence that refuses it. Every plan, every Start and every
 * launch goes through here, so nothing but a checked repo at a 40-hex commit reaches a GPU.
 */
export async function resolveBase(asked: { repo: string; revision?: string | null }, deps: BaseCheckDeps = {}): Promise<BaseCheck> {
  const problem = repoProblem(asked.repo);
  if (problem) return { ok: false, error: problem };
  const fetcher = deps.fetch ?? fetch;
  try {
    const facts = await hubFacts(fetcher, asked.repo, asked.revision ?? null);
    if (typeof facts === "string") return { ok: false, error: facts };
    const checked = checkFacts(facts);
    if (!checked.ok) return checked;
    if (checked.base.gated) {
      const closed = await gatedOpens(fetcher, checked.base.repo, checked.base.revision, deps.token === undefined ? hubToken() : deps.token);
      if (closed) return { ok: false, error: closed };
    }
    return checked;
  } catch (err) {
    console.error("[train/bases] check", err instanceof Error ? err.name : "error");
    return { ok: false, error: "Hugging Face didn't answer, so that base can't be checked. Try again in a moment." };
  }
}

/** What the GPU may download of a gated base. Nothing else leaves the repo. */
const GATED_FILE = /^(.*\.safetensors|model\.safetensors\.index\.json|config\.json|generation_config\.json|tokenizer(_config)?\.json|special_tokens_map\.json|chat_template\.jinja)$/;
const INLINE_MAX = 3_000_000;

export type GatedFile = { path: string; size: number; sha256: string | null; url?: string; inline?: string };

/**
 * A gated base's files for its GPU: a short-lived link the Hub made for each large file, and each small one inline, so
 * HF_TOKEN never leaves the platform. Null when the Hub won't list them.
 */
export async function gatedBaseFiles(repo: string, revision: string, deps: BaseCheckDeps = {}): Promise<GatedFile[] | null> {
  const token = deps.token === undefined ? hubToken() : deps.token;
  if (!token || repoProblem(repo) || !COMMIT_RE.test(revision)) return null;
  const fetcher = deps.fetch ?? fetch;
  const auth = { authorization: `Bearer ${token}` };
  const tree = await read(fetcher, `${HUB}/api/models/${repo}/tree/${revision}`, { headers: auth });
  if (!tree.ok) return null;
  const listed = (await tree.json()) as { type?: string; path: string; size: number; lfs?: { oid?: string } }[];
  const out: GatedFile[] = [];
  let inlined = 0;
  for (const f of listed) {
    if (f.type !== "file" || !GATED_FILE.test(f.path)) continue;
    const res = await read(fetcher, `${HUB}/${repo}/resolve/${revision}/${f.path}`, { redirect: "manual", headers: auth });
    const to = res.headers.get("location");
    const sha256 = f.lfs?.oid ?? null;
    if (res.status >= 300 && res.status < 400 && to) {
      out.push({ path: f.path, size: f.size, sha256, url: new URL(to, HUB).toString() });
    } else if (res.ok) {
      const bytes = Buffer.from(await res.arrayBuffer());
      inlined += bytes.length;
      if (inlined > INLINE_MAX) return null;
      out.push({ path: f.path, size: bytes.length, sha256, inline: bytes.toString("base64") });
    } else return null;
  }
  return out.length ? out : null;
}

/** Each Llama version's license and use policy, in Meta's own repo, read with HF_TOKEN since those repos are gated. */
const LLAMA_LICENSE_SOURCES: Readonly<Record<string, { repo: string; license: string }>> = {
  "3.1": { repo: "meta-llama/Llama-3.1-8B-Instruct", license: "LICENSE" },
  "3.2": { repo: "meta-llama/Llama-3.2-3B-Instruct", license: "LICENSE.txt" },
  "3.3": { repo: "meta-llama/Llama-3.3-70B-Instruct", license: "LICENSE" },
  "4": { repo: "meta-llama/Llama-4-Scout-17B-16E-Instruct", license: "LICENSE" },
};

/**
 * The LICENSE and USE_POLICY.md a Llama model's repo must ship, or the sentence why they can't be read. An upload without
 * them is refused, never sent without them.
 */
export async function llamaLicenseFiles(baseRepo: string, deps: BaseCheckDeps = {}): Promise<{ license: string; policy: string } | string> {
  const source = LLAMA_LICENSE_SOURCES[/llama-(\d(?:\.\d)?)/i.exec(baseRepo)?.[1] ?? ""];
  const token = deps.token === undefined ? hubToken() : deps.token;
  if (!source) return "This Llama version's license isn't mapped, so its model can't be published.";
  if (!token) return GATED_REFUSAL;
  const fetcher = deps.fetch ?? fetch;
  const text = async (path: string) => {
    const res = await read(fetcher, `${HUB}/${source.repo}/resolve/main/${path}`, { headers: { authorization: `Bearer ${token}` } });
    return res.ok ? res.text() : null;
  };
  const [license, policy] = await Promise.all([text(source.license), text("USE_POLICY.md")]);
  if (!license?.trim() || !policy?.trim() || !/llama/i.test(license)) return GATED_REFUSAL;
  return { license, policy };
}
