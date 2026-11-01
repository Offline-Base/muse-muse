import list from "@/lib/caps/assets.json";

/**
 * The hosts of the media files' Blob mirror (lib/caps/assets.json), each once. A build's test browser follows the
 * gateway's /assets redirect there, so a media brief's build may reach them, for GET only (lib/caps/hosts.ts). Empty
 * until the files are mirrored. Reads the list's raw JSON, with no other import, so lib/caps/hosts.ts stays light.
 */
export function mediaMirrorHosts(raw: unknown = list, storeId: string | undefined = process.env.BLOB_STORE_ID): string[] {
  const assets = ((raw as { assets?: Array<{ cap?: unknown; mirror?: unknown }> })?.assets ?? []).filter((a) => a.cap === "media");
  const own = ownBlobHost(storeId);
  const hosts = assets.flatMap((a) => {
    if (typeof a.mirror !== "string") return [];
    try {
      const u = new URL(a.mirror);
      if (u.protocol !== "https:" || u.username || u.password || u.port) return [];
      const host = u.hostname.toLowerCase();
      return isOwnBlobHost(host, own) ? [host] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(hosts)];
}

/** A Vercel Blob public store's host: one label, then .public.blob.vercel-storage.com. Nothing else is a mirror host. */
export const BLOB_PUBLIC_HOST = /^[a-z0-9]+\.public\.blob\.vercel-storage\.com$/;

/**
 * The platform's own Blob store host, from BLOB_STORE_ID ("store_<id>" gives "<id, lowercased>.public.blob...."), or null
 * when the store is reached with a read-write token instead and its id isn't set here.
 */
export function ownBlobHost(storeId: string | undefined): string | null {
  const id = storeId?.trim().replace(/^store_/, "").toLowerCase();
  return id && /^[a-z0-9]+$/.test(id) ? `${id}.public.blob.vercel-storage.com` : null;
}

/**
 * Agreed with General (Oct 31): a mirror host opens the build firewall, so a bad edit to assets.json must not open an
 * arbitrary host. It must be a Blob public store, and the platform's own one whenever its id is known.
 */
function isOwnBlobHost(host: string, own: string | null): boolean {
  if (!BLOB_PUBLIC_HOST.test(host)) return false;
  return own === null || host === own;
}
