import { Icon, type IconName } from "@/components/icons";
import { bytes, truncate } from "@/lib/format";
import type { Reference, ReferenceKind } from "@/lib/types";

export interface Attachment {
  id: string;
  file: File;
  kind: ReferenceKind;
  name: string;
  size: number;
  /** Object URL for image and video previews. */
  thumb: string | null;
  state: "waiting" | "preparing" | "uploading" | "done" | "error";
  progress: number;
  reference: Reference | null;
  error: string | null;
}

export const KIND_ICON: Record<ReferenceKind, IconName> = {
  image: "image",
  video: "film",
  audio: "mic",
  pdf: "file",
};

function stateText(it: Attachment): string {
  switch (it.state) {
    case "waiting":
      return "Waiting for sign-in";
    case "preparing":
      return it.kind === "audio" ? "Converting" : it.kind === "image" ? "Preparing" : "Starting";
    case "uploading":
      return `Uploading ${it.progress}%`;
    case "done":
      return bytes(it.size);
    case "error":
      return it.error ?? "Upload failed";
  }
}

/** One attached file in the composer: thumbnail or kind icon, name, progress, and remove or retry buttons. */
export function AttachmentChip({
  item,
  onRemove,
  onRetry,
}: {
  item: Attachment;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const busy = item.state === "preparing" || item.state === "uploading";
  return (
    <li className={`attach attach-${item.state}`} aria-busy={busy}>
      <span className="attach-thumb">
        {item.thumb && item.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.thumb} alt="" />
        ) : item.thumb && item.kind === "video" ? (
          <video src={item.thumb} muted playsInline preload="metadata" aria-hidden />
        ) : (
          <Icon name={KIND_ICON[item.kind]} size={20} />
        )}
        {busy ? (
          <span
            className="attach-progress"
            style={{ ["--p" as string]: `${item.state === "uploading" ? item.progress : 8}%` }}
            aria-hidden
          />
        ) : null}
      </span>
      <span className="attach-text">
        <span className="attach-name" title={item.name}>
          {truncate(item.name, 28)}
        </span>
        <span className="attach-meta" role={item.state === "error" ? "alert" : undefined}>
          {stateText(item)}
        </span>
      </span>
      {item.state === "error" ? (
        <button type="button" className="attach-btn" aria-label={`Retry ${item.name}`} onClick={onRetry}>
          <Icon name="refresh" size={16} />
        </button>
      ) : null}
      <button type="button" className="attach-btn" aria-label={`Remove ${item.name}`} onClick={onRemove}>
        <Icon name="close" size={16} />
      </button>
    </li>
  );
}
