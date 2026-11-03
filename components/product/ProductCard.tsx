import Link from "next/link";
import { Icon } from "@/components/icons";
import { ModelChips, StatusPill } from "@/components/ui";
import type { ProductCardView } from "@/components/view-types";
import { DEVICE_RUNS } from "@/lib/devices/runs";
import { plural, shortDuration, truncate, usd } from "@/lib/format";

/** A shipped product in the gallery card style: demo video or placeholder, name, tagline, muse, models, meta. */
export function ProductCard({ p, compact = false }: { p: ProductCardView; compact?: boolean }) {
  const meta = [
    p.buildMs != null ? `Built in ${shortDuration(p.buildMs)}` : null,
    p.costUsd != null ? `${usd(p.costUsd)} est.` : null,
    p.fixRounds ? plural(p.fixRounds, "fix round") : null,
    // Recorded device runs (lib/devices/runs.ts): the product page shows each one on its device.
    DEVICE_RUNS[p.slug]?.length ? `Ran on ${plural(DEVICE_RUNS[p.slug]!.length, "device")}` : null,
  ].filter(Boolean);
  return (
    <article className="pcard">
      <div className="pcard-media">
        {p.demoVideoUrl ? (
          <video
            src={p.demoVideoUrl}
            poster={p.demoPosterUrl ?? undefined}
            preload="metadata"
            controls
            muted
            playsInline
            aria-label={`Demo of ${p.name}`}
          />
        ) : (
          <div className="pcard-placeholder" aria-hidden>
            <Icon name="sparkle" size={28} />
            <span>{p.name}</span>
          </div>
        )}
      </div>
      <div className="pcard-body">
        <div className="pcard-title">
          <h3>
            <Link href={`/p/${p.slug}`} className="stretched">
              {p.name}
            </Link>
          </h3>
          {p.status !== "live" ? <StatusPill status={p.status} /> : null}
        </div>
        {p.tagline ? <p className="muted pcard-tagline">{truncate(p.tagline, 110)}</p> : null}
        {!compact && p.muse ? (
          <p className="pcard-muse">
            <Icon name="sparkle" size={14} />
            <span>{truncate(p.muse, 120)}</span>
          </p>
        ) : null}
        {!compact ? <ModelChips models={p.models} /> : null}
        {meta.length ? <p className="pcard-meta">{meta.join(" · ")}</p> : null}
      </div>
    </article>
  );
}
