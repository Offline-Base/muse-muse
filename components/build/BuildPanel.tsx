"use client";

import { useId, useState } from "react";
import { CopyButton, CopyField } from "@/components/CopyButton";
import { Icon } from "@/components/icons";
import { ModelChips, StatusPill } from "@/components/ui";
import { RAIL, type RailStep, type RailState, type RoomState } from "@/components/build/derive";
import { compact, duration, statusLabel, usd } from "@/lib/format";

const RAIL_STATE_LABEL: Record<RailState, string> = {
  pending: "Not started",
  active: "Running",
  done: "Done",
  failed: "Stopped here",
  skipped: "Skipped",
};

export interface PanelProps {
  name: string;
  room: RoomState;
  rail: Record<RailStep, RailState>;
  models: string[];
  buildModel: string | null;
  sessionId: string | null;
  maxFixRounds: number;
  elapsedMs: number;
  tokens: { input: number; cached: number; output: number };
  liveUrl: string | null;
  demoUrl: string | null;
  productSlug: string | null;
  connectorUrl: string | null;
}

/** The playground's right panel, read-only: step rail, models, run facts, links and the live preview. */
export function BuildPanel(p: PanelProps) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const { room } = p;
  const showPreview = Boolean(room.previewUrl) && !room.terminal;

  return (
    <aside className="panel" aria-label="Build details">
      <button
        type="button"
        className="panel-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="panel-toggle-text">
          <strong>Build details</strong>
          <span className="muted">
            {statusLabel(room.status)} · {duration(p.elapsedMs)} · {usd(room.costUsd)} est.
          </span>
        </span>
        <Icon name="chevronDown" className="panel-chevron" />
      </button>

      <div className="panel-body" id={bodyId} data-open={open}>
        <div className="panel-head">
          <h2>{p.name}</h2>
          <StatusPill status={room.status} />
        </div>

        <div className="pfield">
          <span className="panel-label">Model</span>
          <div className="pbox pbox-off" aria-disabled="true">
            <span>{p.buildModel ?? "Not chosen yet"}</span>
            <Icon name="chevronDown" size={18} />
          </div>
        </div>

        <section className="panel-section" aria-labelledby={`${bodyId}-status`}>
          <h3 className="panel-label" id={`${bodyId}-status`}>
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
                <li
                  key={r.key}
                  className={`rail-step rail-${state}`}
                  aria-current={state === "active" ? "step" : undefined}
                >
                  <span className="rail-dot" aria-hidden>
                    {state === "done" ? (
                      <Icon name="check" size={12} />
                    ) : state === "failed" ? (
                      <Icon name="close" size={12} />
                    ) : null}
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

        <dl className="kv">
          <div>
            <dt>Elapsed</dt>
            <dd>{duration(p.elapsedMs)}</dd>
          </div>
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

        <section className="panel-section">
          <h3 className="panel-label">Links</h3>
          {room.previewUrl ? (
            <PanelLink href={room.previewUrl} label="Preview" external />
          ) : (
            <p className="panel-note">The preview appears once the dev server starts.</p>
          )}
          {p.liveUrl ? <PanelLink href={p.liveUrl} label="Live product" external /> : null}
          {p.productSlug && room.terminal ? <PanelLink href={`/p/${p.productSlug}`} label="Product page" /> : null}
          {p.demoUrl ? <PanelLink href={p.demoUrl} label="Demo video" external /> : null}
          {p.connectorUrl ? (
            <div className="pfield">
              <span className="panel-label">Connector URL</span>
              <CopyField value={p.connectorUrl} label="Connector URL" />
            </div>
          ) : null}
        </section>

        {showPreview && room.previewUrl ? (
          <section className="preview-card" aria-label="Live preview">
            <div className="preview-head">
              <span>
                <span className="live-dot" aria-hidden /> Live preview
              </span>
              <a href={room.previewUrl} target="_blank" rel="noopener noreferrer">
                Open
                <Icon name="external" size={14} className="ext-icon" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </div>
            <iframe
              src={room.previewUrl}
              title={`Live preview of ${p.name}`}
              loading="lazy"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
              referrerPolicy="no-referrer"
            />
          </section>
        ) : null}
      </div>
    </aside>
  );
}

/** A panel row with a round button on the right, like the playground's "System instructions" row. */
function PanelLink({ href, label, external }: { href: string; label: string; external?: boolean }) {
  return (
    <div className="pfield-row">
      <span>{label}</span>
      <a
        className="round-btn"
        href={href}
        aria-label={external ? `${label} (opens in a new tab)` : label}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        <Icon name={external ? "external" : "chevronRight"} size={18} />
      </a>
    </div>
  );
}
