"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { ProductCardView } from "@/components/view-types";

function WallVideo({ p }: { p: ProductCardView }) {
  const ref = useRef<HTMLVideoElement>(null);
  // Plays only while on screen, and not at all for someone who asked for less motion.
  useEffect(() => {
    const video = ref.current;
    if (!video || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void video.play().catch(() => undefined);
        else video.pause();
      },
      { threshold: 0.4 },
    );
    seen.observe(video);
    return () => seen.disconnect();
  }, []);
  return (
    <article className="gx-wall-item">
      <video ref={ref} src={p.demoVideoUrl ?? undefined} poster={p.demoPosterUrl ?? undefined} preload="metadata" muted loop playsInline aria-label={`Demo of ${p.name}`} />
      <Link href={`/p/${p.slug}`} className="gx-wall-name stretched">
        {p.name}
      </Link>
    </article>
  );
}

/** Every product's demo video in a wall that fills the page. */
export function DemoWall({ products }: { products: ProductCardView[] }) {
  return (
    <div className="gx-wall">
      {products.map((p) => (
        <WallVideo key={p.slug} p={p} />
      ))}
    </div>
  );
}
