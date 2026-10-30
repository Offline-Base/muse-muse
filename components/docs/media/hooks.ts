"use client";

import { useEffect, useState } from "react";
import type { DocsSample } from "@/lib/docs/media/samples";

/** An object URL for a blob, revoked when the blob changes or the component goes away. Null on the server. */
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

/** A sample from our own origin as a File named after its path, for the same pipeline as an upload. */
export async function loadSample(sample: DocsSample, signal?: AbortSignal): Promise<File> {
  const res = await fetch(sample.src, { credentials: "same-origin", signal });
  if (!res.ok) throw new Error(`Couldn't load the sample "${sample.label}" (HTTP ${res.status}).`);
  const blob = await res.blob();
  return new File([blob], sample.src.split("/").pop() || sample.id, { type: sample.mime || blob.type });
}
