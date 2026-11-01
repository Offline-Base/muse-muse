/**
 * Reading an adapter's files from Hugging Face with the platform's HF token, so private repos work. The token is read
 * here for each call, and goes only to the Hub. Nothing here returns or logs it.
 */
import { env } from "@/lib/env";
import { listFiles, redact, type HubTreeFile } from "@/lib/train/hub";

export interface AdapterSource {
  list(repo: string): Promise<{ path: string; size: number }[]>;
  text(repo: string, commit: string, path: string): Promise<string>;
  stream(repo: string, commit: string, path: string): Promise<ReadableStream<Uint8Array>>;
}

const base = () => process.env.HF_ENDPOINT?.trim() || "https://huggingface.co";
const auth = (): Record<string, string> => (process.env.HF_TOKEN?.trim() ? { authorization: `Bearer ${env.hfToken}` } : {});

async function open(repo: string, commit: string, path: string): Promise<Response> {
  const res = await fetch(`${base()}/${repo}/resolve/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`, { headers: auth(), redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(redact(`Hugging Face answered ${res.status} for ${path}.`));
  return res;
}

export const hubAdapterSource: AdapterSource = {
  async list(repo) {
    const files: HubTreeFile[] = await listFiles({ type: "model", id: repo });
    return files.map((f) => ({ path: f.path, size: f.size }));
  },
  async text(repo, commit, path) {
    return (await open(repo, commit, path)).text();
  },
  async stream(repo, commit, path) {
    return (await open(repo, commit, path)).body!;
  },
};
