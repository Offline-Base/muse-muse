import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { SERIES_COLORS, StackedBars, type ChartSeries } from "@/components/charts/StackedBars";
import { Icon } from "@/components/icons";
import { Menu } from "@/components/Menu";
import { SelectNav } from "@/components/SelectNav";
import { InfoTip, NotConnected, PageHeader, StatusPill } from "@/components/ui";
import { compact, dayLabel, groupThousands, modelLabel, usd } from "@/lib/format";
import {
  addDays,
  getUsage,
  parseUsageFilters,
  safeQuery,
  todayUtc,
  type UsageData,
  type UsageFilters,
  type UsageSeries,
} from "@/lib/queries";

export const metadata: Metadata = { title: "Usage" };

const SOURCE_COLORS: Record<string, string> = {
  gateway: "var(--chart-1)",
  building: "var(--chart-2)",
  docs: "var(--chart-3)",
  shipped: "var(--chart-1)",
  failed: "var(--chart-4)",
};

function hrefFor(f: UsageFilters, patch: Partial<UsageFilters>): string {
  const next = { ...f, ...patch };
  const q = new URLSearchParams();
  if (next.productId) q.set("product", next.productId);
  if (next.model) q.set("model", next.model);
  if (next.view !== "total") q.set("view", next.view);
  if (next.rangeDays !== 7) q.set("range", String(next.rangeDays));
  if (next.end !== todayUtc()) q.set("end", next.end);
  const s = q.toString();
  return s ? `/usage?${s}` : "/usage";
}

function colored(series: UsageSeries[], byModel: boolean): ChartSeries[] {
  return series.map((s, i) => ({
    ...s,
    label: byModel ? modelLabel(s.label) : s.label,
    color: byModel
      ? SERIES_COLORS[i % SERIES_COLORS.length]
      : (SOURCE_COLORS[s.key] ?? SERIES_COLORS[i % SERIES_COLORS.length]),
  }));
}

function toCsv(d: UsageData): string {
  const head = [
    "day",
    ...d.tokens.map((s) => `tokens_${s.key}`),
    ...d.spend.map((s) => `usd_${s.key}`),
    ...d.builds.map((s) => `builds_${s.key}`),
  ];
  const rows = d.days.map((day, i) => [
    day,
    ...d.tokens.map((s) => s.values[i] ?? 0),
    ...d.spend.map((s) => (s.values[i] ?? 0).toFixed(4)),
    ...d.builds.map((s) => s.values[i] ?? 0),
  ]);
  return [head, ...rows].map((r) => r.join(",")).join("\n");
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const f = parseUsageFilters(await searchParams);
  const result = await safeQuery(() => getUsage(f));
  const startDay = addDays(f.end, -(f.rangeDays - 1));
  const isToday = f.end >= todayUtc();
  const rangeText = `${dayLabel(startDay)} – ${dayLabel(f.end)}`;

  return (
    <div className="page">
      <PageHeader
        title="Usage"
        subtitle="Counts every Meta Model API call made by Muse Muse, the products it shipped and the live docs demos."
      />

      {!result.ok ? (
        <NotConnected reason={result.reason} what="usage" />
      ) : (
        <UsageBody f={f} d={result.data} rangeText={rangeText} isToday={isToday} />
      )}
    </div>
  );
}

function UsageBody({
  f,
  d,
  rangeText,
  isToday,
}: {
  f: UsageFilters;
  d: UsageData;
  rangeText: string;
  isToday: boolean;
}) {
  const byModel = f.view === "model";
  const t = d.totals;
  const cacheRate = t.input ? (t.cached / t.input) * 100 : 0;
  const csv = `data:text/csv;charset=utf-8,${encodeURIComponent(toCsv(d))}`;
  const productOptions = [
    { value: "all", label: "All products", href: hrefFor(f, { productId: null }) },
    ...d.options.products.map((p) => ({ value: p.id, label: p.name, href: hrefFor(f, { productId: p.id }) })),
  ];
  const modelOptions = [
    { value: "all", label: "All models", href: hrefFor(f, { model: null }) },
    ...d.options.models.map((m) => ({ value: m, label: modelLabel(m), href: hrefFor(f, { model: m }) })),
  ];
  if (f.productId && !productOptions.some((o) => o.value === f.productId)) {
    productOptions.push({ value: f.productId, label: "This product", href: hrefFor(f, {}) });
  }
  if (f.model && !modelOptions.some((o) => o.value === f.model)) {
    modelOptions.push({ value: f.model, label: modelLabel(f.model), href: hrefFor(f, {}) });
  }

  return (
    <>
      <div className="filters" role="group" aria-label="Filters">
        <div className="filters-left">
          <SelectNav label="Product" value={f.productId ?? "all"} options={productOptions} />
          <SelectNav label="Model" value={f.model ?? "all"} options={modelOptions} />
          <div className="segmented" role="group" aria-label="Breakdown">
            <Link href={hrefFor(f, { view: "total" })} aria-current={!byModel ? "true" : undefined} scroll={false}>
              Total
            </Link>
            <Link href={hrefFor(f, { view: "model" })} aria-current={byModel ? "true" : undefined} scroll={false}>
              By model
            </Link>
          </div>
        </div>
        <div className="filters-right">
          <a
            className="icon-btn icon-btn-outline"
            href={csv}
            download={`muse-muse-usage-${d.days[0]}-${d.days[d.days.length - 1]}.csv`}
            aria-label="Download as CSV"
            title="Download as CSV"
          >
            <Icon name="download" size={18} />
          </a>
          <Menu text={rangeText} label="Date range" icon="calendar" buttonClassName="btn btn-outline">
            <ul className="menu-list">
              {([7, 14, 30, 90] as const).map((r) => (
                <li key={r}>
                  <Link
                    className="menu-item"
                    href={hrefFor(f, { rangeDays: r })}
                    aria-current={f.rangeDays === r ? "true" : undefined}
                    scroll={false}
                  >
                    Last {r} days
                  </Link>
                </li>
              ))}
            </ul>
          </Menu>
          <Link
            className="icon-btn icon-btn-fill"
            href={hrefFor(f, { end: addDays(f.end, -f.rangeDays) })}
            aria-label="Earlier range"
            scroll={false}
          >
            <Icon name="chevronLeft" size={18} />
          </Link>
          {isToday ? (
            <span className="icon-btn icon-btn-fill is-disabled" aria-hidden>
              <Icon name="chevronRight" size={18} />
            </span>
          ) : (
            <Link
              className="icon-btn icon-btn-fill"
              href={hrefFor(f, { end: [addDays(f.end, f.rangeDays), todayUtc()].sort()[0] })}
              aria-label="Later range"
              scroll={false}
            >
              <Icon name="chevronRight" size={18} />
            </Link>
          )}
        </div>
      </div>

      <div className="usage-grid">
        <section className="card stat-card stat-wide" aria-labelledby="tokens-label">
          <p className="stat-num">{compact(t.tokens)}</p>
          <div className="stat-label">
            <h2 id="tokens-label">Meta tokens driven</h2>
            <InfoTip label="About Meta tokens driven">
              Input plus output tokens across every Meta Model API call: products through the gateway, building
              (briefs, Muse Code and the screenshot judge), and the live docs demos. {groupThousands(t.tokens)} in this
              range.
            </InfoTip>
          </div>
          <p className="stat-sub">
            Products {compact(t.productTokens)} · Building {compact(t.buildingTokens)}
            {t.docsTokens ? ` · Docs demos ${compact(t.docsTokens)}` : ""} · Cache hit rate{" "}
            {cacheRate.toFixed(1)}%
          </p>
          <StackedBars
            days={d.days}
            series={colored(d.tokens, byModel)}
            unit="tokens"
            label={`Meta tokens per day, ${rangeText}, ${byModel ? "by model" : "products and building"}`}
          />
        </section>

        <section className="card stat-card" aria-labelledby="spend-label">
          <p className="stat-num">{usd(t.costUsd)}</p>
          <div className="stat-label">
            <h2 id="spend-label">Spend (est.)</h2>
            <InfoTip label="About spend">
              Estimated from Meta&apos;s listed prices. Some prices are reported rather than confirmed, so treat these
              as estimates.
            </InfoTip>
          </div>
          <p className="stat-sub">{groupThousands(t.calls)} calls</p>
          <StackedBars
            days={d.days}
            series={colored(d.spend, byModel)}
            unit="usd"
            label={`Estimated spend per day, ${rangeText}`}
          />
        </section>

        <section className="card stat-card" aria-labelledby="builds-label">
          <p className="stat-num">{groupThousands(t.builds)}</p>
          <div className="stat-label">
            <h2 id="builds-label">Builds</h2>
            <InfoTip label="About builds">
              Builds started in this range, by how they ended. Running builds aren&apos;t in the chart yet.
            </InfoTip>
          </div>
          <p className="stat-sub">
            Shipped {t.shipped} · Failed {t.failed}
            {t.refused ? ` · Declined ${t.refused}` : ""}
            {t.inProgress ? ` · Running ${t.inProgress}` : ""}
          </p>
          <StackedBars
            days={d.days}
            series={d.builds.map((s) => ({ ...s, color: SOURCE_COLORS[s.key] ?? "var(--chart-5)" }))}
            unit="count"
            label={`Builds per day, ${rangeText}, shipped and failed`}
          />
        </section>
      </div>

      <section className="section" aria-labelledby="products-title">
        <div className="section-head">
          <h2 id="products-title">By product</h2>
        </div>
        {d.products.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Tokens
                  </th>
                  <th scope="col" className="num">
                    Calls
                  </th>
                  <th scope="col" className="num">
                    Cost (est.)
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.products.map((p) => (
                  <tr key={p.productId ?? (p.docs ? "docs" : "none")}>
                    <td>
                      {p.slug ? (
                        <Link href={`/p/${p.slug}`} className="row-title">
                          {p.name}
                        </Link>
                      ) : p.docs ? (
                        <Link href="/docs" className="row-title">
                          Docs demos
                        </Link>
                      ) : (
                        <span className="muted">Platform calls not tied to a product</span>
                      )}
                    </td>
                    <td>{p.status ? <StatusPill status={p.status} /> : null}</td>
                    <td className="num">{compact(p.tokens)}</td>
                    <td className="num">{groupThousands(p.calls)}</td>
                    <td className="num">{usd(p.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No calls in this range.</p>
        )}
      </section>
    </>
  );
}
