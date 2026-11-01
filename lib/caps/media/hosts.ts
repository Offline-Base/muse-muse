import list from "@/lib/caps/assets.json";

/**
 * The hosts of the media files' Blob mirror (lib/caps/assets.json), each once. A build's test browser follows the
 * gateway's /assets redirect there, so a media brief's build may reach them, for GET only (lib/caps/hosts.ts). Empty
 * until the files are mirrored. Reads the list's raw JSON, with no other import, so lib/caps/hosts.ts stays light.
 */
export function mediaMirrorHosts(raw: unknown = list): string[] {
  const assets = ((raw as { assets?: Array<{ cap?: unknown; mirror?: unknown }> })?.assets ?? []).filter((a) => a.cap === "media");
  const hosts = assets.flatMap((a) => {
    if (typeof a.mirror !== "string") return [];
    try {
      const u = new URL(a.mirror);
      return u.protocol === "https:" ? [u.hostname] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(hosts)];
}
