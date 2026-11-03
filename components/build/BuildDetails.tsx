"use client";

import Link from "next/link";
import { useId } from "react";
import { CopyButton, CopyField } from "@/components/CopyButton";
import { Icon } from "@/components/icons";
import { ModelChips, StatusPill } from "@/components/ui";
import { RAIL, type RailStep, type RailState, type RoomState } from "@/components/build/derive";
import type { BuildSummary } from "@/components/view-types";
import { compact, duration, relativeTime, statusLabel, truncate, usd } from "@/lib/format";

const RAIL_STATE_LABEL: Record<RailState, string> = {
  pending: "Not started",
  active: "Running",
  done: "Done",
  failed: "Stopped here",
  skipped: "Skipped",
};

export interface BuildDetailsProps {
  name: string;
  room: RoomState;
  rail: Record<RailStep, RailState>;
  models: string[];
  buildModel: string | null;
  sessionId: string | null;
  maxFixRounds: number;
  elapsedMs: number;
  /** The whole build's time limit in minutes (builds.round_plan.wallMinutes), or null when it wasn't recorded. */
  timeLimitMinutes?: number | null;
  tokens: { input: number; cached: number; output: number };
  liveUrl: string | null;
  demoUrl: string | null;
  productSlug: string | null;
  connectorUrl: string | null;
  /** What opens now: the live product once the build ends, the preview before. */
  openUrl: string | null;
  buildId: string;
  history: BuildSummary[];
  now: number;
}

/**
 * The whole build's time limit as the room says it: "Up to 150 minutes, start to live". Null when none was recorded, so
 * an older build never shows a limit it didn't run under.
 */
export function timeLimitText(minutes: number | null | undefined): string | null {
  return typeof minutes === "number" && minutes > 0 ? `Up to ${minutes} minutes, start to live` : null;
}

/** The elapsed time in the room's running line, with the limit beside it while the build runs: "12 m of up to 150 min". */
export function elapsedText(elapsedMs: number, minutes: number | null | undefined, terminal: boolean): string {
  return !terminal && typeof minutes === "number" && minutes > 0 ? `${duration(elapsedMs)} of up to ${minutes} min` : duration(elapsedMs);
}

/**
 * The build's facts, in the More menu over the conversation (docs/UI_MUSE_APP.md, "Where it applies"): its status and the
 * stages still to come, the build model, the models in the product, the Muse Code session, fix rounds, elapsed time, cost,
 * tokens, its links and connector, this product's other builds, and a way to start a new muse.
 */
export function BuildDetails(p: BuildDetailsProps) {
  const id = useId();
  const { room } = p;
  return (
    <div className="room-details">
      <div className="panel-head">
        <h2>{p.name}</h2>
        <StatusPill status={room.status} />
      </div>

      <dl className="kv">
        <div>
          <dt>Model</dt>
          <dd>{p.buildModel ?? "Not chosen yet"}</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd>{duration(p.elapsedMs)}</dd>
        </div>
        {timeLimitText(p.timeLimitMinutes) ? (
          <div>
            <dt>Time limit</dt>
            <dd>{timeLimitText(p.timeLimitMinutes)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Cost</dt>
          <dd>{usd(room.costUsd)} est.</dd>
        </div>
        {p.tokens.input || p.tokens.output ? (
          <div>
            <dt>Tokens</dt>
            <dd>
              In {compact(p.tokens.input)} · Out {compact(p.tokens.output)}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="pfield-row">
        <span className="panel-label">
          Muse Code session
          {p.sessionId ? (
            <code className="pfield-code" title={p.sessionId}>
              {p.sessionId.slice(0, 8)}
            </code>
          ) : null}
        </span>
        {p.sessionId ? (
          <CopyButton value={p.sessionId} label="Copy Muse Code session id" className="round-btn" />
        ) : (
          <span className="muted">Not started</span>
        )}
      </div>

      <div className="pfield">
        <div className="pfield-row">
          <span className="panel-label">Fix rounds</span>
          <span className="numbox">
            {room.fixRounds} of {p.maxFixRounds}
          </span>
        </div>
        <span className="meter" aria-hidden>
          <span
            className="meter-fill"
            style={{ width: `${(Math.min(room.fixRounds, p.maxFixRounds) / Math.max(1, p.maxFixRounds)) * 100}%` }}
          />
        </span>
      </div>

      <section className="panel-section" aria-labelledby={`${id}-status`}>
        <h3 className="panel-label" id={`${id}-status`}>
          Status
        </h3>
        <ol className="rail">
          {RAIL.map((r) => {
            const state = p.rail[r.key];
            const sub =
              r.key === "check" && room.fixRounds > 0
                ? `${room.fixRounds} fix ${room.fixRounds === 1 ? "round" : "rounds"}`
                : RAIL_STATE_LABEL[state];
            return (
              <li key={r.key} className={`rail-step rail-${state}`} aria-current={state === "active" ? "step" : undefined}>
                <span className="rail-dot" aria-hidden>
                  {state === "done" ? <Icon name="check" size={12} /> : state === "failed" ? <Icon name="close" size={12} /> : null}
                </span>
                <span className="rail-text">
                  <span className="rail-label">{r.label}</span>
                  <span className="rail-sub">{sub}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      {p.models.length ? (
        <section className="panel-section">
          <h3 className="panel-label">Models in the product</h3>
          <ModelChips models={p.models} />
        </section>
      ) : null}

      <section className="panel-section">
        <h3 className="panel-label">Links</h3>
        {p.openUrl ? (
          <DetailLink href={p.openUrl} label="Open preview" external />
        ) : (
          <p className="panel-note">The preview appears once the dev server starts.</p>
        )}
        {p.liveUrl ? <DetailLink href={p.liveUrl} label="Live product" external /> : null}
        {p.productSlug && room.terminal ? <DetailLink href={`/p/${p.productSlug}`} label="Product page" /> : null}
        {p.demoUrl ? <DetailLink href={p.demoUrl} label="Demo video" external /> : null}
        <DetailLink href="/" label="New muse" />
      </section>

      <section className="panel-section">
        <h3 className="panel-label">Muse app connector</h3>
        {p.connectorUrl ? (
          <>
            <CopyField value={p.connectorUrl} label="Connector URL" />
            <p className="panel-note">Add it in the Muse app as a custom connector to use this product from chat.</p>
          </>
        ) : (
          <p className="panel-note">The connector is ready once a product exists.</p>
        )}
      </section>

      {p.history.length ? (
        <section className="panel-section">
          <h3 className="panel-label">This product&apos;s builds</h3>
          <ul className="menu-list">
            {p.history.map((h) => (
              <li key={h.id}>
                <Link className="menu-item" href={`/b/${h.id}`} aria-current={h.id === p.buildId ? "page" : undefined}>
                  <span className={`pill-dot dot-${h.status}`} aria-hidden />
                  <span className="menu-item-text">
                    <span>{h.kind === "refine" ? truncate(h.message ?? "Change", 40) : "First build"}</span>
                    <span className="muted small">
                      {statusLabel(h.status)} · {relativeTime(h.startedAt, p.now)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** A row with a round button on the right. */
function DetailLink({ href, label, external }: { href: string; label: string; external?: boolean }) {
  return (
    <div className="pfield-row">
      <span>{label}</span>
      {external ? (
        <a className="round-btn" href={href} aria-label={`${label} (opens in a new tab)`} target="_blank" rel="noopener noreferrer">
          <Icon name="external" size={18} />
        </a>
      ) : (
        <Link className="round-btn" href={href} aria-label={label}>
          <Icon name="chevronRight" size={18} />
        </Link>
      )}
    </div>
  );
}
