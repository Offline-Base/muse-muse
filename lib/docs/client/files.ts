import type { DocsSample, SampleKind } from "@/lib/docs/media/samples";

/**
 * Reading a picked file or a sample for a request: as a data URL, bare base64, or the File itself for multipart.
 * Uploads stay under 3 MB so the base64 (a third bigger) fits the proxy's 4.5 MB body limit.
 */

export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

/** Which samples suit a file input's accept list (lib/docs/media/samples.ts kinds), or null for any. */
export function sampleKindOf(accept?: string): SampleKind | null {
  const a = (accept ?? "").toLowerCase();
  if (!a || a === "*/*") return null;
  if (a.includes("image")) return "image";
  if (a.includes("video")) return "video";
  if (a.includes("audio") || a.includes(".wav")) return "audio";
  if (a.includes("pdf")) return "pdf";
  if (a.includes("text") || a.includes(".txt") || a.includes(".md") || a.includes("json")) return "text";
  return null;
}

/** "1.2 MB", "340 KB". */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** Why a file can't be sent, or null when it can. */
export function uploadProblem(file: { size: number; name?: string }): string | null {
  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name || "This file"} is ${sizeLabel(file.size)}. Live demos take files up to ${sizeLabel(MAX_UPLOAD_BYTES)}.`;
  }
  return null;
}

/** A file's contents as a data URL (data:<mime>;base64,...) or bare base64. */
export function readFileAs(file: Blob, as: "dataUrl" | "base64"): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."));
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(as === "dataUrl" ? url : url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** A sample from our own origin as a File, named after its path. */
export async function fetchSample(sample: DocsSample): Promise<File> {
  const res = await fetch(sample.src, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Couldn't load the sample ${sample.label} (HTTP ${res.status}).`);
  const blob = await res.blob();
  const name = sample.src.split("/").pop() || sample.id;
  return new File([blob], name, { type: sample.mime || blob.type });
}
