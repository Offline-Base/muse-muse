/**
 * The multipart and file-slot shapes from the kit contract (docs/DOCS_MIRROR.md, "Kit contract"). They live here so
 * the pure helpers (codegen, recording) can use them; components/docs/playgrounds/common/ApiConsole.tsx re-exports
 * them, which is where the contract says page groups import them from.
 */

/** One multipart field: a text `value`, or a file the reader picks (`file`). */
export interface FormSpec {
  name: string;
  /** The text value, or for a file field the file name to show in code (such as "photo.jpg"). */
  value?: string;
  file?: FileSlotSpec;
}

export interface FileSlot {
  /** A JSON Pointer (RFC 6901) into `body`, or a multipart field name when target is "form". */
  pointer: string;
  target?: "body" | "form";
  label: string;
  accept?: string;
  /** "dataUrl" puts data:<mime>;base64,... at the pointer, "base64" the bare base64, "file" the File (multipart). */
  as?: "dataUrl" | "base64" | "file";
}

export type FileSlotSpec = Omit<FileSlot, "pointer" | "target">;

/** A file name for code samples when the reader hasn't picked one, from what the field accepts. */
export function placeholderFileName(accept?: string): string {
  const a = (accept ?? "").toLowerCase();
  if (a.includes("wav") || a.startsWith("audio")) return "recording.wav";
  if (a.includes("pdf")) return "document.pdf";
  if (a.startsWith("video") || a.includes("mp4")) return "clip.mp4";
  if (a.includes("png")) return "image.png";
  if (a.startsWith("image") || a.includes("jpeg") || a.includes("jpg")) return "photo.jpg";
  if (a.startsWith("text") || a.includes("json")) return "notes.txt";
  return "file.bin";
}

/** A MIME type for a file name, for code samples (multipart parts carry one). */
export function mimeOfName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    pdf: "application/pdf",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    csv: "text/csv",
  };
  return types[ext] ?? "application/octet-stream";
}
