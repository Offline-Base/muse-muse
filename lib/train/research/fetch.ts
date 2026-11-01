/**
 * The one way data research reads a file (docs/TRAINING.md "Data research"): GET over https only, public addresses only
 * (checked before the request and again in the socket's own DNS lookup, so a name can't rebind to a private address in
 * between, and at every redirect), a few redirects, a byte cap and a deadline. No credentials are ever sent.
 */
import { lookup as dnsLookup } from "node:dns";
import { lookup as dnsLookupAll } from "node:dns/promises";
import { get } from "node:https";
import type { LookupFunction } from "node:net";
import { isPrivateAddress, resolvesToPublic } from "@/lib/tools/args";
import { publicUrl } from "@/lib/train/research/logic";

const REDIRECTS_MAX = 3;

export class FetchRefused extends Error {}

export interface RawResponse {
  status: number;
  location: string | null;
  text: string;
}

export interface FetchDeps {
  lookupHost(host: string): Promise<string[]>;
  /** One GET with no redirect following, which throws FetchRefused past maxBytes. */
  request(url: string, i: { maxBytes: number; deadline: number }): Promise<RawResponse>;
}

/** The socket's lookup: refuses a name with any private address when it actually connects. */
const publicOnlyLookup: LookupFunction = (host, options, callback) => {
  dnsLookup(host, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = addresses as unknown as Array<{ address: string; family: number }>;
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      return callback(new FetchRefused("That address isn't public.") as NodeJS.ErrnoException, "", 4);
    }
    if (options.all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

function realRequest(url: string, i: { maxBytes: number; deadline: number }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const ms = i.deadline - Date.now();
    if (ms <= 0) return reject(new FetchRefused("The file took too long."));
    const req = get(url, { lookup: publicOnlyLookup, timeout: ms, signal: AbortSignal.timeout(ms), headers: { accept: "*/*", "user-agent": "MuseMuse-data-research" } }, (res) => {
      const declared = Number(res.headers["content-length"] ?? 0);
      if (declared > i.maxBytes) {
        res.destroy();
        return reject(new FetchRefused("The file is over the size limit."));
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (c: Buffer) => {
        bytes += c.length;
        if (bytes > i.maxBytes) {
          res.destroy();
          return reject(new FetchRefused("The file is over the size limit."));
        }
        chunks.push(c);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new FetchRefused("The file took too long.")));
    req.on("error", reject);
  });
}

export const realFetchDeps: FetchDeps = {
  lookupHost: async (host) => (await dnsLookupAll(host, { all: true, verbatim: true })).map((a) => a.address),
  request: realRequest,
};

/** The body at `url` after its redirects, or FetchRefused for a blocked address, too many redirects, or a non-200. */
export async function safeGet(url: string, i: { maxBytes: number; deadline: number }, deps: FetchDeps = realFetchDeps): Promise<string> {
  let at = url;
  for (let hop = 0; hop <= REDIRECTS_MAX; hop++) {
    const clean = publicUrl(at);
    if (!clean || new URL(clean).protocol !== "https:") throw new FetchRefused("That address isn't a public https one.");
    if (!(await resolvesToPublic(clean, deps.lookupHost))) throw new FetchRefused("That address isn't public.");
    const res = await deps.request(clean, i);
    if (res.status >= 300 && res.status < 400 && res.location) {
      at = new URL(res.location, clean).href;
      continue;
    }
    if (res.status !== 200) throw new FetchRefused(`It answered ${res.status}.`);
    return res.text;
  }
  throw new FetchRefused("It redirected too many times.");
}
