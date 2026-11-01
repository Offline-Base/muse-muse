"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { buildIdOfPath, HISTORY_IDS_KEY, HISTORY_OPEN_KEY, type HistoryRow, rememberId } from "@/lib/shell/history";

function readIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_IDS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveIds(ids: string[]): void {
  try {
    localStorage.setItem(HISTORY_IDS_KEY, JSON.stringify(ids));
  } catch {
    // Private windows can refuse storage. History then only holds what the account has.
  }
}

// The sidebar and the phone sheet both render this, so one navigation asks once.
let inflight: { query: string; rows: Promise<HistoryRow[]> } | null = null;

function loadRows(ids: string[]): Promise<HistoryRow[]> {
  const query = ids.join(",");
  if (inflight?.query === query) return inflight.rows;
  const rows = fetch(`/api/builds/history?ids=${encodeURIComponent(query)}`)
    .then((res) => (res.ok ? (res.json() as Promise<{ builds: HistoryRow[] }>) : { builds: [] }))
    .then((body) => body.builds)
    .catch(() => [] as HistoryRow[])
    .finally(() => {
      inflight = null;
    });
  inflight = { query, rows };
  return rows;
}

/** The sidebar's History section. It stays out of the page until there's something to list. */
export function History({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? "/";
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [closed, setClosed] = useState(false);
  const current = buildIdOfPath(pathname);

  useEffect(() => {
    try {
      setClosed(localStorage.getItem(HISTORY_OPEN_KEY) === "1");
    } catch {
      // Open is the default.
    }
  }, []);

  // The root layout doesn't re-render on client navigation, so a new build appears from here when its room opens.
  useEffect(() => {
    let live = true;
    let ids = readIds();
    if (current) {
      ids = rememberId(ids, current);
      saveIds(ids);
    }
    void loadRows(ids).then((next) => {
      if (live) setRows(next);
    });
    return () => {
      live = false;
    };
  }, [pathname, current]);

  if (rows.length === 0) return null;

  function toggle() {
    const next = !closed;
    setClosed(next);
    try {
      localStorage.setItem(HISTORY_OPEN_KEY, next ? "1" : "0");
    } catch {
      // It still toggles for this page.
    }
  }

  return (
    <section className="history" aria-label="History">
      <button type="button" className="history-head" aria-expanded={!closed} onClick={toggle}>
        <span>History</span>
        <Icon name={closed ? "chevronRight" : "chevronDown"} size={16} className="history-chevron" />
      </button>
      {closed ? null : (
        <ul className="nav-group">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/b/${row.id}`}
                className="nav-link history-row"
                title={row.title}
                aria-current={row.id === current ? "page" : undefined}
                onClick={onNavigate}
              >
                <span>{row.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
