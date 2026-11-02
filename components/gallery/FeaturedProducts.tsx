"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { plural, truncate, usd } from "@/lib/format";
import type { FeaturedProduct } from "@/lib/gallery/featured";
import "./featured.css";

function minutes(ms: number) {
  return plural(Math.max(1, Math.round(ms / 60000)), "minute");
}

/** Moves to the Make page's composer, below this section. */
function MakeYours({ primary = false }: { primary?: boolean }) {
  return (
    <a
      className={primary ? "btn btn-primary" : "btn"}
      href="#make"
      onClick={() => document.querySelector<HTMLTextAreaElement>(".play .composer-input")?.focus({ preventScroll: true })}
    >
      <Icon name="sparkle" size={18} />
      <span>Make your own</span>
    </a>
  );
}

/**
 * Finished products to use on the spot (lib/gallery/featured.ts): choosing a card runs that product here, with how its
 * last build went beside it. Only live products with a link reach this row, so no card leads to "Not published".
 */
export function FeaturedProducts({ products, frameAllow, frameSandbox }: { products: FeaturedProduct[]; frameAllow: string; frameSandbox: string }) {
  const [slug, setSlug] = useState<string | null>(null);
  const player = useRef<HTMLDivElement>(null);
  const open = products.find((p) => p.slug === slug) ?? null;
  useEffect(() => {
    if (slug) player.current?.scrollIntoView({ block: "start" });
  }, [slug]);
  return (
    <section className="ft" aria-labelledby="ft-heading">
      <div className="ft-head">
        <div>
          <h2 id="ft-heading">Try something Muse made</h2>
          <p className="muted">Real products Muse Muse built and published. Pick one to use it here, with no sign-in.</p>
        </div>
        <MakeYours primary />
      </div>
      {open ? (
        <div className="ft-player" ref={player}>
          <div className="ft-player-bar">
            <p>
              <strong>{open.name}.</strong> {open.tryThis}
            </p>
            <button type="button" className="icon-btn icon-btn-plain" aria-label={`Close ${open.name}`} onClick={() => setSlug(null)}>
              <Icon name="close" size={20} />
            </button>
          </div>
          <iframe key={open.slug} src={open.liveUrl ?? undefined} title={`${open.name}, the live product`} allow={frameAllow} sandbox={frameSandbox} referrerPolicy="no-referrer" />
          <div className="ft-built">
            <h3>How it was built</h3>
            {open.muse ? (
              <p>
                <span className="muted">The request: </span>
                {truncate(open.muse, 260)}
              </p>
            ) : null}
            {open.buildMs != null || open.costUsd != null || open.fixRounds != null ? (
              <p>
                {`Its last build: ${[
                  open.buildMs != null ? minutes(open.buildMs) : null,
                  open.costUsd != null ? `${usd(open.costUsd)} in model calls` : null,
                  open.fixRounds != null ? plural(open.fixRounds, "fix round") : null,
                ]
                  .filter(Boolean)
                  .join(", ")}.`}
              </p>
            ) : null}
            <div className="ft-actions">
              {open.latestBuildId ? (
                <Link className="btn" href={`/b/${open.latestBuildId}`}>
                  <Icon name="terminal" size={18} />
                  <span>Watch the build</span>
                </Link>
              ) : null}
              <a className="btn" href={open.liveUrl ?? undefined} target="_blank" rel="noopener noreferrer">
                <Icon name="external" size={18} />
                <span>Open full screen</span>
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              <MakeYours primary />
            </div>
          </div>
        </div>
      ) : null}
      <ul className="ft-cards">
        {products.map((p) => (
          <li key={p.slug}>
            <button type="button" className="ft-card" aria-pressed={p.slug === slug} onClick={() => setSlug(p.slug)}>
              <span className="ft-media">
                {p.demoPosterUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.demoPosterUrl} alt="" />
                ) : null}
                <span className="ft-kind">{p.kind}</span>
              </span>
              <span className="ft-name">{p.name}</span>
              <span className="ft-tag muted">{truncate(p.tagline, 70)}</span>
              {p.buildMs != null ? <span className="ft-how muted">Last build took {minutes(p.buildMs)}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
