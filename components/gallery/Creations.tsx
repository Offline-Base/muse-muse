"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { Menu } from "@/components/Menu";
import { CREATION_FILTERS, type Creation, type CreationFilter, filterCreations } from "@/lib/gallery/filter";

/** What the products made, with a filter menu: All, Images and Videos. */
export function Creations({ items }: { items: Creation[] }) {
  const [filter, setFilter] = useState<CreationFilter>("all");
  const shown = useMemo(() => filterCreations(items, filter), [items, filter]);
  return (
    <section className="gx-section">
      <div className="gx-head">
        <h2 className="gx-heading">Creations</h2>
        <div className="gx-tools">
          <Menu label="Filter creations" icon="sliders" align="end" closeOnSelect buttonClassName="icon-btn icon-btn-plain">
            {CREATION_FILTERS.map((f) => (
              <button key={f.id} type="button" className="menu-item" aria-pressed={f.id === filter} onClick={() => setFilter(f.id)}>
                <Icon name={f.icon} size={18} />
                {f.label}
                {f.id === filter ? <Icon name="check" size={18} className="gx-check" /> : null}
              </button>
            ))}
          </Menu>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="muted">Nothing here yet.</p>
      ) : (
        <div className="gx-tiles">
          {shown.map((item) => (
            <Link key={item.key} href={item.href} className="gx-tile" aria-label={`${item.name}, ${item.kind}`}>
              {item.kind === "video" ? (
                <>
                  <video src={item.src} poster={item.poster ?? undefined} preload="metadata" muted playsInline aria-hidden tabIndex={-1} />
                  <span className="gx-tile-play" aria-hidden>
                    <Icon name="play" size={22} />
                  </span>
                </>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.src} alt="" loading="lazy" />
              )}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
