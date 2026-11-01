// Platform file (Muse Muse platform services). Don't edit: call it from route handlers and server actions.
//
// The vetted public datasets ({GATEWAY_URL}/datasets): files a product can read, each with a license that allows it.
// Show the license where the data is used: <Citation citation={datasetCitation(info)} /> from
// components/platform/Citation.tsx. Every file's sha256 is checked after it is read.
import { createHash } from "node:crypto";
import type { RequestLike } from "@/lib/meta/client";
import { FilesError, gatewayCall } from "@/lib/platform/files";

export interface DatasetInfo {
  id: string;
  title: string;
  why: string;
  license: { spdx: string; url: string };
  source: { name: string; url: string };
  attribution: string;
  files: Array<{ name: string; contentType: string; bytes: number; sha256: string; url: string }>;
}

/** Every vetted dataset. */
export async function datasets(request?: RequestLike | null): Promise<DatasetInfo[]> {
  return (await gatewayCall<{ datasets: DatasetInfo[] }>(request, "GET", "/datasets")).datasets;
}

/** One vetted dataset by id. */
export function dataset(request: RequestLike | null | undefined, id: string) {
  const info = async (): Promise<DatasetInfo> => {
    const found = (await datasets(request)).find((d) => d.id === id);
    if (!found) throw new FilesError("not_found", 404, `There's no dataset called ${id} on the platform's list.`);
    return found;
  };
  const bytes = async (file: string): Promise<Buffer> => {
    const d = await info();
    const f = d.files.find((x) => x.name === file);
    if (!f) throw new FilesError("not_found", 404, `${id} has no file called ${file}.`);
    const base = process.env.GATEWAY_URL?.replace(/\/+$/, "");
    const res = await fetch(`${base}/datasets/${id}/${file}`, {
      headers: { authorization: `Bearer ${process.env.PRODUCT_TOKEN ?? ""}` },
      // Never Next's data cache: it would keep a copy across builds and hide a read from the gateway's record of a build.
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    if (!res || !res.ok) throw new FilesError("unreachable", res?.status ?? 502, `The ${d.title} data couldn't be read right now. Try again in a minute.`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length !== f.bytes || createHash("sha256").update(body).digest("hex") !== f.sha256) {
      throw new FilesError("checksum", 502, `The ${d.title} data didn't match its checksum, so it wasn't used.`);
    }
    return body;
  };
  return {
    info,
    bytes,
    /** A text file (CSV, JSON, text) as a string. */
    async text(file: string): Promise<string> {
      return (await bytes(file)).toString("utf8");
    },
  };
}
