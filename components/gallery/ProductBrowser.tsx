"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { Menu } from "@/components/Menu";
import { truncate } from "@/lib/format";
import { filterProducts, PRODUCT_FILTERS, type ProductFilter } from "@/lib/gallery/filter";
import type { ProductCardView } from "@/components/view-types";

/** The Gallery's products: search, a filter menu, a size switch, and cards that are mostly the product's demo. */
export function ProductBrowser({ products }: { products: ProductCardView[] }) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProductFilter>("all");
  const [small, setSmall] = useState(false);
  const shown = useMemo(() => filterProducts(products, query, filter), [products, query, filter]);
  return (
    <section className="gx-section">
      <div className="gx-head">
        <h2 className="gx-heading">Products</h2>
        <div className="gx-tools">
          {searching ? <input type="search" autoFocus aria-label="Search products" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} /> : null}
          <button
            type="button"
            className="icon-btn icon-btn-plain"
            aria-label={searching ? "Close search" : "Search products"}
            onClick={() => {
              if (searching) setQuery("");
              setSearching(!searching);
            }}
          >
            <Icon name={searching ? "close" : "search"} size={20} />
          </button>
          <Menu label="Filter products" icon="sliders" align="end" closeOnSelect buttonClassName="icon-btn icon-btn-plain">
            {PRODUCT_FILTERS.map((f) => (
              <button key={f.id} type="button" className="menu-item" aria-pressed={f.id === filter} onClick={() => setFilter(f.id)}>
                {f.label}
                {f.id === filter ? <Icon name="check" size={18} className="gx-check" /> : null}
              </button>
            ))}
          </Menu>
          <button type="button" className="icon-btn icon-btn-plain" aria-label={small ? "Show larger cards" : "Show smaller cards"} aria-pressed={small} onClick={() => setSmall(!small)}>
            <Icon name="grid" size={20} />
          </button>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="muted">Nothing matches that.</p>
      ) : (
        <div className="gx-cards" data-size={small ? "small" : "large"}>
          {shown.map((p) => (
            <article key={p.slug} className="gx-card">
              <div className="gx-card-media">
                {p.demoVideoUrl ? (
                  <video src={p.demoVideoUrl} poster={p.demoPosterUrl ?? undefined} preload="metadata" muted playsInline aria-hidden tabIndex={-1} />
                ) : p.demoPosterUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.demoPosterUrl} alt="" loading="lazy" />
                ) : (
                  <span className="gx-card-empty" aria-hidden>
                    <Icon name="sparkle" size={28} />
                  </span>
                )}
              </div>
              <h3>
                <Link href={`/p/${p.slug}`} className="stretched">
                  {p.name}
                </Link>
              </h3>
              {p.tagline ? <p className="muted">{truncate(p.tagline, 90)}</p> : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
