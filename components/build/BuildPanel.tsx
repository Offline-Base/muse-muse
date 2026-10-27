"use client";

import { useId, useState } from "react";
import { CopyButton, CopyField } from "@/components/CopyButton";
import { Icon } from "@/components/icons";
import { ExternalLink, ModelChips, StatusPill } from "@/components/ui";
import { RAIL, type RailStep, type RailState, type RoomState } from "@/components/build/derive";
import { compact, duration, modelLabel, statusLabel, usd } from "@/lib/format";

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
            <h3 className="panel-label">Models</h3>
            <ModelChips models={p.models} />
          </section>
        ) : null}

        <dl className="kv">
          <div>
            <dt>Build model</dt>
            <dd>{p.buildModel ? modelLabel(p.buildModel) : "Not chosen yet"}</dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd className="kv-session">
              {p.sessionId ? (
                <>
                  <code title={p.sessionId}>{p.sessionId.slice(0, 8)}</code>
                  <CopyButton value={p.sessionId} label="Copy Muse Code session id" className="icon-btn icon-btn-sm" />
                </>
              ) : (
                <span className="muted">Not started</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Fix rounds</dt>
            <dd>
              {room.fixRounds} of {p.maxFixRounds}
            </dd>
          </div>
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
          <ul className="link-list">
            <li>
              {room.previewUrl ? (
                <ExternalLink href={room.previewUrl}>Preview</ExternalLink>
              ) : (
                <span className="muted">Preview appears once the dev server starts</span>
              )}
            </li>
            {p.liveUrl ? (
              <li>
                <ExternalLink href={p.liveUrl}>Live product</ExternalLink>
              </li>
            ) : null}
            {p.productSlug && room.terminal ? (
              <li>
                <a href={`/p/${p.productSlug}`}>Product page</a>
              </li>
            ) : null}
            {p.demoUrl ? (
              <li>
                <ExternalLink href={p.demoUrl}>Demo video</ExternalLink>
              </li>
            ) : null}
          </ul>
          {p.connectorUrl ? (
            <div className="field-block">
              <span className="field-label">Connector URL</span>
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
              <ExternalLink href={room.previewUrl}>Open</ExternalLink>
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
