import type { ReferenceKind } from "@/lib/types";
import { toWav16k } from "@/lib/client/audio";
import { prepareImage } from "@/lib/client/image";

/** Matches the server's limits (lib/pipeline/references.ts): 100 MB per file, at most 8 references per muse. */
export const MAX_INSPO_BYTES = 100 * 1024 * 1024;
export const MAX_INSPO_FILES = 8;
/** The file input's accept list. Audio of any type is accepted here and converted to WAV before upload. */
export const INSPO_ACCEPT = "image/*,video/mp4,video/quicktime,audio/*,.m4a,.mp3,.wav,.aac,.ogg,.opus,application/pdf";

const AUDIO_EXT = /\.(m4a|mp3|wav|aac|ogg|oga|opus|flac|caf|amr|weba)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?)$/i;

/** Which kind of reference a picked file becomes, or null when it isn't supported. */
export function referenceKind(file: { type: string; name: string }): ReferenceKind | null {
  const type = file.type.toLowerCase();
  if (type.startsWith("image/") || (!type && IMAGE_EXT.test(file.name))) return "image";
  if (type === "video/mp4" || type === "video/quicktime" || (!type && /\.(mp4|mov)$/i.test(file.name))) return "video";
  if (type.startsWith("audio/") || AUDIO_EXT.test(file.name)) return "audio";
  if (type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  return null;
}

export function unsupportedMessage(name: string): string {
  return `${name} isn't supported. Use a photo, an MP4 or MOV video, a voice memo or a PDF.`;
}

export interface PreparedFile {
  blob: Blob;
  fileName: string;
  contentType: string;
  kind: ReferenceKind;
  /** For audio: the converted length. */
  durationMs?: number;
}

function renameExt(name: string, ext: string): string {
  const base = name.replace(/\.[^.]+$/, "") || "file";
  return `${base}.${ext}`;
}

function videoType(file: File): string {
  if (file.type) return file.type;
  return /\.mov$/i.test(file.name) ? "video/quicktime" : "video/mp4";
}

/**
 * Gets a picked file ready for upload: audio becomes 16 kHz mono WAV, images over 1600 px become JPEG, everything
 * else passes through. Throws a user-facing message when the file can't be used.
 */
export async function prepareInspoFile(file: File): Promise<PreparedFile> {
  const kind = referenceKind(file);
  if (!kind) throw new Error(unsupportedMessage(file.name));

  let prepared: PreparedFile;
  if (kind === "audio") {
    const { blob, durationMs } = await toWav16k(file);
    prepared = { blob, fileName: renameExt(file.name, "wav"), contentType: "audio/wav", kind, durationMs };
  } else if (kind === "image") {
    const img = await prepareImage(file);
    prepared = {
      blob: img.blob,
      fileName: img.changed ? renameExt(file.name, "jpg") : file.name,
      contentType: img.contentType,
      kind,
    };
  } else if (kind === "video") {
    prepared = { blob: file, fileName: file.name, contentType: videoType(file), kind };
  } else {
    prepared = { blob: file, fileName: file.name, contentType: "application/pdf", kind };
  }

  if (prepared.blob.size > MAX_INSPO_BYTES) {
    throw new Error(
      kind === "audio"
        ? `${file.name} is too long. Voice memos can be up to about 50 minutes.`
        : `${file.name} is over 100 MB. Try a shorter clip or a smaller file.`,
    );
  }
  return prepared;
}
