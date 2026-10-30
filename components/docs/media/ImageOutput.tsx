"use client";

import { useState } from "react";
import { Icon } from "@/components/icons";
import styles from "@/components/docs/media/media.module.css";
import { base64ImageMime, formatBytes } from "@/lib/docs/media/base64";

export interface OutputImage {
  /** Bare base64, as Muse Image returns it (data[].b64_json, image_generation_call.result). */
  b64?: string;
  /** A URL instead (data[].url with response_format "url", or a data URL). */
  url?: string;
  /** Read from the bytes when missing. */
  mime?: string;
  /** A caption above the actions, such as "Turn 2". */
  label?: string;
  alt?: string;
  id?: string;
}

export interface ImageOutputProps {
  images: readonly OutputImage[];
  /** File name stem for downloads: "muse-image" gives muse-image-1.webp. */
  name?: string;
  /** Shown when there are no images yet. */
  emptyText?: string;
}

const EXT: Record<string, string> = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" };

function srcOf(img: OutputImage): { src: string; mime: string; bytes: number | null } | null {
  if (img.b64) {
    const mime = img.mime ?? base64ImageMime(img.b64);
    return { src: `data:${mime};base64,${img.b64}`, mime, bytes: Math.floor((img.b64.length * 3) / 4) };
  }
  if (img.url) {
    const m = /^data:([^;,]+)/.exec(img.url);
    const mime = img.mime ?? m?.[1] ?? "image/webp";
    const comma = img.url.indexOf(",");
    return { src: img.url, mime, bytes: m && comma > 0 ? Math.floor(((img.url.length - comma - 1) * 3) / 4) : null };
  }
  return null;
}

/** Shows generated images (base64 or URL) with their size and a download button for each. */
export function ImageOutput({ images, name = "muse-image", emptyText }: ImageOutputProps) {
  if (!images.length) return emptyText ? <p className={styles.note}>{emptyText}</p> : null;
  return (
    <div className={styles.images}>
      {images.map((img, i) => {
        const s = srcOf(img);
        return s ? <Card key={img.id ?? i} img={img} src={s.src} mime={s.mime} bytes={s.bytes} file={`${name}-${i + 1}.${EXT[s.mime] ?? "img"}`} /> : null;
      })}
    </div>
  );
}

function Card({ img, src, mime, bytes, file }: { img: OutputImage; src: string; mime: string; bytes: number | null; file: string }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const isRemote = !src.startsWith("data:");
  return (
    <figure className={styles.imageCard}>
      {/* The generator picks the pixel size; the request's size sets only the aspect ratio (image-generation). */}
      <img src={src} alt={img.alt ?? img.label ?? "Generated image"} onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      <figcaption className={styles.imageCaption}>
        <span>
          {img.label ? `${img.label} · ` : ""}
          {size ? `${size.w} x ${size.h}` : mime.replace("image/", "").toUpperCase()}
          {bytes ? ` · ${formatBytes(bytes)}` : ""}
        </span>
        <a className="btn btn-outline btn-sm" href={src} download={isRemote ? undefined : file} target={isRemote ? "_blank" : undefined} rel={isRemote ? "noreferrer" : undefined}>
          <Icon name="download" size={16} />
          {isRemote ? "Open" : "Download"}
        </a>
      </figcaption>
    </figure>
  );
}

