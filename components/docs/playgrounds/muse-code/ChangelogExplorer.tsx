"use client";

import { Fragment, useCallback, useDeferredValue, useEffect, useId, useMemo, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { Field, PresetPills, TextInput, Toggle } from "@/components/docs/kit";
import {
  filterChangelog,
  inlineParts,
  isSecurity,
  ITEM_TYPES,
  parseChangelog,
  queryWords,
  toMarkdown,
  type ItemType,
  type Release,
} from "@/components/docs/playgrounds/muse-code/changelog";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import { Chip, Highlight, SelectField, type Tone } from "@/components/docs/playgrounds/muse-code/ui";

/**
 * The changelog page's demo: every Muse Code release, filtered as you type by version range, type of change
 * (New, Improvements, Fixes, Performance, patch notes), security fixes and keywords, with each result linked to its
 * place on the page and the filtered set copyable as Markdown. It fetches the page's Markdown from the docs' own copy
 * route once and parses it in the browser, so the page doesn't carry 240 KB twice.
 */

export interface ChangelogExplorerProps {
  slug: string;
  /** Where the Markdown comes from. Defaults to the copy route for this page. */
  source?: string;
  query?: string;
}

const PAGE_SIZE = 120;

const TYPE_TONE: Record<ItemType, Tone> = { New: "accent", Improvements: "ok", Fixes: "plain", Performance: "warn", Notes: "plain" };
const TYPE_LABEL: Record<ItemType, string> = { New: "New", Improvements: "Improvements", Fixes: "Fixes", Performance: "Performance", Notes: "Patch notes" };

const QUICK = [{ label: "Latest release" }, { label: "Last 3 releases" }, { label: "Everything" }, { label: "Security fixes" }, { label: "Rewind" }, { label: "Workflows" }];

function Item({ text, words }: { text: string; words: string[] }) {
  return (
    <>
      {inlineParts(text).map((p, i) => {
        if (p.kind === "code") {
          return (
            <code key={i} className={styles.code}>
              <Highlight text={p.text} words={words} />
            </code>
          );
        }
        if (p.kind === "strong") {
          return (
            <strong key={i}>
              <Highlight text={p.text} words={words} />
            </strong>
          );
        }
        if (p.kind === "link") {
          const href = p.href.startsWith("https://dev.meta.ai/docs/") ? p.href.replace("https://dev.meta.ai", "") : p.href;
          return (
            <a key={i} href={href} {...(href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              <Highlight text={p.text} words={words} />
            </a>
          );
        }
        return (
          <Fragment key={i}>
            <Highlight text={p.text} words={words} />
          </Fragment>
        );
      })}
    </>
  );
}

export function ChangelogExplorer({ slug, source, query: startQuery }: ChangelogExplorerProps) {
  const idBase = useId();
  const url = source ?? `/docs/md/${slug}`;
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState(startQuery ?? "");
  const [newest, setNewest] = useState(0);
  const [oldest, setOldest] = useState<number | null>(null);
  const [types, setTypes] = useState<ItemType[]>([...ITEM_TYPES]);
  const [securityOnly, setSecurityOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [quick, setQuick] = useState<number | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setFailed(null);
    fetch(url, { signal: ctrl.signal, cache: "force-cache" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`The changelog didn't load (HTTP ${res.status}).`);
        const parsed = parseChangelog(await res.text());
        if (!parsed.length) throw new Error("The changelog loaded but had no releases in it.");
        setReleases(parsed);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setFailed(err instanceof Error ? err.message : "The changelog didn't load.");
      });
    return () => ctrl.abort();
  }, [url, attempt]);

  const deferred = useDeferredValue(query);
  const words = useMemo(() => queryWords(deferred), [deferred]);
  const last = releases ? releases.length - 1 : 0;
  const oldestIndex = oldest ?? last;
  const filtered = useMemo(
    () => (releases ? filterChangelog(releases, { newest, oldest: oldestIndex, types, securityOnly, query: deferred }) : { results: [], total: 0 }),
    [releases, newest, oldestIndex, types, securityOnly, deferred],
  );
  const stats = useMemo(() => {
    if (!releases) return null;
    const items = releases.flatMap((r) => r.sections.flatMap((s) => s.items));
    return { releases: releases.length, items: items.length, security: items.filter(isSecurity).length };
  }, [releases]);

  useEffect(() => setLimit(PAGE_SIZE), [newest, oldestIndex, types, securityOnly, deferred]);

  const pickQuick = useCallback(
    (i: number) => {
      setQuick(i);
      const reset = () => {
        setTypes([...ITEM_TYPES]);
        setSecurityOnly(false);
      };
      if (i === 0) {
        reset();
        setNewest(0);
        setOldest(0);
        setQuery("");
      } else if (i === 1) {
        reset();
        setNewest(0);
        setOldest(Math.min(2, last));
        setQuery("");
      } else if (i === 2) {
        reset();
        setNewest(0);
        setOldest(null);
        setQuery("");
      } else if (i === 3) {
        setTypes([...ITEM_TYPES]);
        setSecurityOnly(true);
        setNewest(0);
        setOldest(null);
        setQuery("");
      } else {
        reset();
        setNewest(0);
        setOldest(null);
        setQuery(QUICK[i].label.toLowerCase());
      }
    },
    [last],
  );

  if (failed) {
    return (
      <div className="pg">
        <div className="pg-error" role="alert">
          <div className="pg-error-body">
            <p className="pg-error-title">The changelog didn&apos;t load</p>
            <p className="pg-error-message">{failed}</p>
          </div>
        </div>
        <div className="pg-actions">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!releases || !stats) {
    return (
      <div className="pg">
        <p className="pg-wait" role="status">
          Loading the changelog...
        </p>
      </div>
    );
  }

  const versionOptions = releases.map((r, i) => ({ value: String(i), label: r.version }));
  let shown = 0;

  return (
    <div className="pg">
      <p className="pg-hint">
        {stats.items.toLocaleString("en-US")} changes in {stats.releases} releases, {stats.security} of them security fixes. The page lists versions, not dates, so
        the version range is the timeline: pick the version you run as the oldest to see what changed since.
      </p>
      <PresetPills presets={QUICK} active={quick} onPick={pickQuick} label="Show" />
      <div className={styles.row}>
        <Field id={`${idBase}-q`} label="Search the changes" className={styles.grow}>
          <TextInput
            id={`${idBase}-q`}
            type="search"
            value={query}
            placeholder="Try: sandbox, --yolo, MCP, compaction, Windows"
            onChange={(e) => {
              setQuery(e.target.value);
              setQuick(null);
            }}
          />
        </Field>
        <SelectField
          id={`${idBase}-from`}
          label="Oldest version"
          className={styles.narrow}
          value={String(oldestIndex)}
          options={versionOptions}
          onChange={(v) => {
            setOldest(Number(v));
            setQuick(null);
          }}
        />
        <SelectField
          id={`${idBase}-to`}
          label="Newest version"
          className={styles.narrow}
          value={String(newest)}
          options={versionOptions}
          onChange={(v) => {
            setNewest(Number(v));
            setQuick(null);
          }}
        />
      </div>
      <div className="pg-bar">
        <div className="pg-presets" role="group" aria-label="Types of change">
          <span className="pg-presets-label" aria-hidden>
            Types
          </span>
          {ITEM_TYPES.map((t) => {
            const on = types.includes(t);
            return (
              <button
                key={t}
                type="button"
                className="pg-pill"
                aria-pressed={on}
                onClick={() => {
                  setTypes((cur) => (on ? cur.filter((x) => x !== t) : ITEM_TYPES.filter((x) => x === t || cur.includes(x))));
                  setQuick(null);
                }}
              >
                {TYPE_LABEL[t]}
              </button>
            );
          })}
        </div>
        <Toggle
          id={`${idBase}-sec`}
          label="Security fixes only"
          checked={securityOnly}
          onChange={(v) => {
            setSecurityOnly(v);
            setQuick(null);
          }}
        />
      </div>
      <div className="pg-bar">
        <p className="pg-hint" role="status" aria-live="polite">
          {filtered.total.toLocaleString("en-US")} {filtered.total === 1 ? "change" : "changes"} in {filtered.results.length} {filtered.results.length === 1 ? "release" : "releases"}
        </p>
        {filtered.total ? <CopyButton value={toMarkdown(filtered.results)} label="Copy these changes as Markdown" text="Copy as Markdown" className="btn btn-outline btn-sm" /> : null}
      </div>

      <div className={styles.scroll} tabIndex={0} aria-label="Matching changes">
        {filtered.results.map((r) => {
          if (shown >= limit) return null;
          return (
            <section key={r.release.version} aria-label={`Release ${r.release.version}`}>
              <h3 className={`${styles.itemHead} ${styles.releaseHead}`}>
                <a href={`#${r.release.anchor}`}>{r.release.version}</a>
                <span className="pg-muted pg-small">
                  {r.count} {r.count === 1 ? "change" : "changes"}
                </span>
              </h3>
              {r.sections.map((s) => {
                if (shown >= limit) return null;
                const items = s.items.slice(0, Math.max(0, limit - shown));
                shown += items.length;
                return (
                  <div key={s.section.anchor}>
                    <p className={styles.itemHead}>
                      <Chip tone={TYPE_TONE[s.section.type]}>{TYPE_LABEL[s.section.type]}</Chip>
                      <a className="pg-small" href={`#${s.section.anchor}`}>
                        On the page
                      </a>
                    </p>
                    <ul className={styles.list}>
                      {items.map((item, i) => (
                        <li key={i} className={styles.itemText}>
                          {isSecurity(item) ? <Chip tone="bad">Security</Chip> : null} <Item text={item.replace(/^\*\*Security:?\*\*\s*/i, "")} words={words} />
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </section>
          );
        })}
        {!filtered.total ? <p className="pg-empty">No change matches. Widen the version range, turn on more types, or try fewer words.</p> : null}
      </div>
      {filtered.total > limit ? (
        <div className="pg-actions">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setLimit((l) => l + PAGE_SIZE * 2)}>
            Show more ({(filtered.total - limit).toLocaleString("en-US")} left)
          </button>
        </div>
      ) : null}
    </div>
  );
}
