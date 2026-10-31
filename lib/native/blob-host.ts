import { env } from "@/lib/env";

/** The public host of this platform's Blob store, from either credential, or null with no store. */
export function blobStoreHost(): string | null {
  const id = env.blobStoreId || env.blobReadWriteToken?.split("_")[3];
  return id ? `${id.replace(/^store_/, "").toLowerCase()}.public.blob.vercel-storage.com` : null;
}

/** True for an https address on this platform's Blob store. Another store's address ends the same way, so it's the whole host. */
export function isOwnBlobUrl(url: URL): boolean {
  return url.protocol === "https:" && url.hostname.toLowerCase() === blobStoreHost();
}
