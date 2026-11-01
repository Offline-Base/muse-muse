import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { MiniBars } from "@/components/charts/MiniBars";
import { ConnectCard } from "@/components/dashboard/ConnectCard";
import { Icon } from "@/components/icons";
import { OwnerNotices } from "@/components/jobs/OwnerNotices";
import { NotConnected } from "@/components/ui";
import { env } from "@/lib/env";
import { compact, groupThousands, usd } from "@/lib/format";
import {
  getUsage,
  listShippedProducts,
  platformOrigin,
  safeQuery,
  todayUtc,
  type UsageFilters,
} from "@/lib/queries";

export const metadata: Metadata = { title: "Dashboard" };

const RANGES = [7, 30, 90] as const;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const sp = await searchParams;
  const asked = Number(Array.isArray(sp.range) ? sp.range[0] : sp.range);
  const rangeDays = RANGES.find((r) => r === asked) ?? 7;
  const f: UsageFilters = { productId: null, model: null, view: "total", rangeDays, end: todayUtc() };
  const [usage, products, origin] = await Promise.all([
    safeQuery(() => getUsage(f)),
    safeQuery(() => listShippedProducts(60)),
    platformOrigin(),
  ]);
  const shipped = products.ok ? products.data : [];
  // A connector only answers for a published product (lib/mcp/store.ts), so unpublished ones aren't offered.
  const published = shipped.filter((p) => p.liveUrl);
  const connect = published.slice(0, 3).map((p) => ({
    slug: p.slug,
    name: p.name,
    connectorUrl: `${origin}/api/mcp/${p.slug}`,
  }));

  return (
    <div className="page dash">
      {/* Wave 3, unit 6: renders and reads nothing while the jobs cap is off. */}
      <OwnerNotices />
      <ConnectCard products={connect} unpublished={shipped.length - published.length} publishOff={env.publishOffReason} />

      <nav className="range" aria-label="Date range">
        {RANGES.map((r) => (
          <Link key={r} href={r === 7 ? "/dashboard" : `/dashboard?range=${r}`} aria-current={r === rangeDays ? "true" : undefined} scroll={false}>
            {r}d
          </Link>
        ))}
      </nav>

      {!usage.ok ? (
        <NotConnected reason={usage.reason} what="the dashboard" />
      ) : (
        <>
          <div className="dash-grid">
            <section className="dash-card" aria-label="Requests">
              <p className="dash-num">{groupThousands(usage.data.totals.calls)}</p>
              <h2 className="dash-label">Requests</h2>
              <MiniBars
                days={usage.data.days}
                values={usage.data.perDay.calls}
                format={(v) => `${groupThousands(v)} requests`}
                label={`Meta Model API requests per day, last ${rangeDays} days`}
              />
            </section>
            <section className="dash-card" aria-label="Input tokens">
              <p className="dash-num">{compact(usage.data.totals.input)}</p>
              <h2 className="dash-label">Input tokens</h2>
              <MiniBars
                days={usage.data.days}
                values={usage.data.perDay.input}
                format={(v) => `${compact(v)} input tokens`}
                label={`Input tokens per day, last ${rangeDays} days`}
              />
            </section>
            <section className="dash-card" aria-label="Output tokens">
              <p className="dash-num">{compact(usage.data.totals.output)}</p>
              <h2 className="dash-label">Output tokens</h2>
              <MiniBars
                days={usage.data.days}
                values={usage.data.perDay.output}
                format={(v) => `${compact(v)} output tokens`}
                label={`Output tokens per day, last ${rangeDays} days`}
              />
            </section>
          </div>

          <div className="dash-grid">
            <Link className="dash-card" href="/gallery">
              <span className="dash-icon" aria-hidden>
                <Icon name="image" />
              </span>
              <span className="dash-label-muted">Products</span>
              <span className="dash-num">{groupThousands(shipped.length)}</span>
              <span className="dash-foot">Open the gallery</span>
            </Link>
            <section className="dash-card" aria-label="Spend">
              <p className="dash-num">{usd(usage.data.totals.costUsd)}</p>
              <h2 className="dash-label">Spend (est.)</h2>
              <MiniBars
                days={usage.data.days}
                values={usage.data.days.map((_, i) => usage.data.spend.reduce((s, x) => s + (x.values[i] ?? 0), 0))}
                format={(v) => usd(v)}
                label={`Estimated spend per day, last ${rangeDays} days`}
              />
            </section>
            <Link className="dash-card" href="/how-it-works">
              <span className="dash-icon dash-icon-fill" aria-hidden>
                <Icon name="doc" />
              </span>
              <span className="dash-title">How it works</span>
              <span className="dash-foot">The pipeline, checks and costs</span>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
