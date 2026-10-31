"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "@/components/composer/Composer";
import { CopyButton } from "@/components/CopyButton";
import { Icon } from "@/components/icons";
import { Menu } from "@/components/Menu";
import type { BuildSummary, BuildView, InspirationView, ProductView, RebuildRef } from "@/components/view-types";
import { BuildPanel } from "@/components/build/BuildPanel";
import { deriveRoom, railStates, refineSpot, type Segment } from "@/components/build/derive";
import { SteerBox } from "@/components/build/SteerBox";
import {
  BriefBody,
  CheckBody,
  MuseLog,
  Notes,
  ShipBody,
  Turn,
  UserTurn,
  museUsageText,
  segmentMeta,
  tokensText,
} from "@/components/build/turns";
import {
  duration,
  elapsedMs,
  isTerminalStatus,
  parseManifest,
  relativeTime,
  statusLabel,
  truncate,
  usd,
} from "@/lib/format";
import type { BuildEvent, BuildStatus } from "@/lib/types";

export interface BuildRoomProps {
  build: BuildView;
  product: ProductView | null;
  inspiration: InspirationView | null;
  events: BuildEvent[];
  history: BuildSummary[];
  tokens: { input: number; cached: number; output: number };
  /** The viewer owns the product or is an admin. */
  canRefine: boolean;
  /** The viewer may steer the build while Muse Code runs: owner powers as for canRefine, with steering switched on. */
  canSteer?: boolean;
  signedIn: boolean;
  origin: string;
  serverNow: number;
  focusRefine: boolean;
  rebuild: RebuildRef | null;
  maxFixRounds: number;
}

const WORKING: Partial<Record<BuildStatus, string>> = {
  queued: "Waiting to start",
  briefing: "Muse Wonder is reading your inspo and writing the brief",
  provisioning: "Setting up a sandbox for this product",
  building: "Muse Code is building",
  previewing: "Starting the live preview",
  verifying: "Checking it",
  fixing: "Muse Code is fixing what failed",
  recording: "Recording the demo",
  deploying: "Deploying it to its own link",
};

/** Copies known fields from an API reply onto a view, ignoring anything missing or mistyped. */
function mergeKnown<T extends object>(prev: T, next: unknown): T {
  if (!next || typeof next !== "object") return prev;
  const out = { ...prev } as Record<string, unknown>;
  for (const key of Object.keys(prev)) {
    const v = (next as Record<string, unknown>)[key];
    if (v === undefined) continue;
    const old = out[key];
    if (old === null || v === null || typeof v === typeof old) out[key] = v;
  }
  return out as T;
}

function useNow(initial: number, ticking: boolean): number {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  return now;
}

export function BuildRoom(props: BuildRoomProps) {
  const [build, setBuild] = useState(props.build);
  const [product, setProduct] = useState(props.product);
  const [events, setEvents] = useState(props.events);
  const [conn, setConn] = useState<"idle" | "live" | "reconnecting" | "closed">("idle");
  const buildId = props.build.id;

  const room = useMemo(() => deriveRoom(build, events), [build, events]);
  const rail = useMemo(() => railStates(room, build.kind), [room, build.kind]);
  const now = useNow(props.serverNow, !room.terminal);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/builds/${buildId}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { build?: unknown; product?: unknown };
      setBuild((prev) => mergeKnown(prev, data.build));
      if (data.product && typeof data.product === "object") {
        setProduct((prev) => {
          const next = prev
            ? mergeKnown(prev, data.product)
            : (data.product as ProductView).slug
              ? (data.product as ProductView)
              : prev;
          // The API sends the stored manifest as is, so check its shape like the server render does.
          return next && { ...next, manifest: parseManifest(next.manifest) };
        });
      }
    } catch {
      // The page still shows what the event stream delivered.
    }
  }, [buildId]);

  // Live events. EventSource resumes with Last-Event-ID on its own; when the server ends the stream for good
  // (a terminal build), stop instead of reconnecting forever. Incoming events are batched into one render.
  useEffect(() => {
    if (isTerminalStatus(props.build.status)) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let flush: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let attempts = 0;
    let sawTerminal = false;
    let lastId = props.events[props.events.length - 1]?.id ?? 0;
    let lastRefresh = 0;
    const buffer: BuildEvent[] = [];

    const drain = () => {
      flush = null;
      if (!buffer.length) return;
      const batch = buffer.splice(0);
      setEvents((list) => {
        const seen = new Set(list.map((e) => e.id));
        const fresh = batch.filter((e) => !seen.has(e.id));
        return fresh.length ? [...list, ...fresh] : list;
      });
    };

    const open = () => {
      if (stopped) return;
      es = new EventSource(`/api/builds/${buildId}/events?after=${lastId}`);
      es.addEventListener("open", () => {
        attempts = 0;
        setConn("live");
      });
      es.addEventListener("build", (msg) => {
        let ev: BuildEvent;
        try {
          ev = JSON.parse((msg as MessageEvent<string>).data) as BuildEvent;
        } catch {
          return;
        }
        if (typeof ev.id !== "number") ev = { ...ev, id: Number((msg as MessageEvent).lastEventId) || lastId + 1 };
        if (ev.id <= lastId) return;
        lastId = ev.id;
        if (!ev.at) ev = { ...ev, at: new Date().toISOString() };
        buffer.push(ev);
        if (ev.type === "status" && isTerminalStatus(ev.status)) sawTerminal = true;
        if (!flush) flush = setTimeout(drain, 80);
        // Columns such as the build model, session id and fix rounds change without an event of their own, so
        // reload the build row on every status change, and now and then while Muse Code is working.
        const now = Date.now();
        if (ev.type === "status" || now - lastRefresh > 30_000) {
          lastRefresh = now;
          void refresh();
        }
      });
      es.addEventListener("error", () => {
        if (sawTerminal) {
          es?.close();
          stopped = true;
          setConn("closed");
          drain();
          void refresh();
          return;
        }
        if (es?.readyState === EventSource.CLOSED) {
          // The server refused the stream (an error status). Back off and try again with the newest id.
          es.close();
          attempts++;
          setConn("reconnecting");
          retry = setTimeout(open, Math.min(30_000, 1500 * 2 ** Math.min(attempts, 5)));
        } else {
          setConn("reconnecting");
        }
      });
    };

    open();
    return () => {
      stopped = true;
      es?.close();
      if (retry) clearTimeout(retry);
      if (flush) clearTimeout(flush);
    };
    // Subscribe once per build. Later prop changes come from this component's own state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId]);

  // When the stream reports a terminal status, pull the final build row (finishedAt, product, live URL).
  const wasTerminal = useRef(room.terminal);
  useEffect(() => {
    if (room.terminal && !wasTerminal.current) void refresh();
    wasTerminal.current = room.terminal;
  }, [room.terminal, refresh]);

  // Keep the newest turn in view while the viewer is at the bottom; otherwise offer a jump button.
  const end = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    const el = end.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setAtBottom(entry.isIntersecting), {
      rootMargin: "0px 0px 120px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (atBottom && !room.terminal) end.current?.scrollIntoView({ block: "end", behavior: smooth() });
    // Only react to new events, not to scroll position changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length]);

  const brief = room.brief;
  const name = product?.name ?? brief?.name ?? (build.kind === "refine" ? "Change" : "New build");
  const slug = product?.slug ?? null;
  const connectorUrl = slug ? `${props.origin}/api/mcp/${slug}` : null;
  const liveUrl = room.liveUrl ?? product?.liveUrl ?? null;
  const demoUrl = room.recordingUrl ?? (room.terminal ? (product?.demoVideoUrl ?? null) : null);
  const demoPosterUrl = room.recordingUrl ? room.recordingPosterUrl : room.terminal ? (product?.demoPosterUrl ?? null) : null;
  const models = brief
    ? [...new Set(brief.capabilities.map((c) => c.model))]
    : (product?.manifest?.models.map((m) => m.id) ?? []);
  const finished = build.finishedAt ?? (room.terminal ? room.lastEventAt : null);
  const elapsed = elapsedMs(build.startedAt, finished, now);
  const openUrl = room.terminal ? (liveUrl ?? room.previewUrl) : (room.previewUrl ?? liveUrl);
  const shipped = room.status === "live" || room.status === "partial";
  const refine = refineSpot({
    buildId: build.id,
    terminal: room.terminal,
    canRefine: props.canRefine,
    product,
    history: props.history,
  });
  const isRefineBuild = build.kind === "refine";
  const showRefs = !isRefineBuild || (props.inspiration?.note ?? null) === build.message;
  // While Muse Code works, its owner gets the steer box where the refine composer shows once the build ends.
  const steering = Boolean(props.canSteer) && !room.terminal && (room.status === "building" || room.status === "fixing");

  // Only the newest turn can be live, and only while the build is in the matching phase. During "fixing", round 0
  // is finished even before the fix round logs its first line.
  const lastSeg = room.segments[room.segments.length - 1];
  const activeKey =
    !room.terminal && lastSeg
      ? (lastSeg.type === "muse" && (room.status === "building" || room.status === "fixing")) ||
        (lastSeg.type === "check" && room.status === "verifying")
        ? lastSeg.key
        : undefined
      : undefined;

  return (
    <div className="room">
      <div className="room-main">
        <div className="toolbar" aria-label="Build actions">
          <Link className="btn" href="/">
            <Icon name="plus" />
            <span>New muse</span>
          </Link>
          {openUrl ? (
            <a className="btn" href={openUrl} target="_blank" rel="noopener noreferrer">
              <Icon name="monitor" />
              <span>Open preview</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            <button type="button" className="btn" disabled title="The preview appears once the dev server starts">
              <Icon name="monitor" />
              <span>Open preview</span>
            </button>
          )}
          {connectorUrl ? (
            <CopyButton value={connectorUrl} label="Copy the Muse app connector URL" text="Get connector" icon="plug" />
          ) : (
            <button type="button" className="btn" disabled title="The connector is ready once a product exists">
              <Icon name="plug" />
              <span>Get connector</span>
            </button>
          )}
          <Menu text="History" label="This product's builds" icon="history" disabled={props.history.length < 1}>
            <ul className="menu-list">
              {props.history.map((h) => (
                <li key={h.id}>
                  <Link className="menu-item" href={`/b/${h.id}`} aria-current={h.id === build.id ? "page" : undefined}>
                    <span className={`pill-dot dot-${h.status}`} aria-hidden />
                    <span className="menu-item-text">
                      <span>{h.kind === "refine" ? truncate(h.message ?? "Change", 40) : "First build"}</span>
                      <span className="muted small">
                        {statusLabel(h.status)} · {relativeTime(h.startedAt, now)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Menu>
        </div>

        <p className="mobile-status" aria-hidden>
          <span className={`pill-dot dot-${room.status}`} />
          {statusLabel(room.status)} · {duration(elapsed)} · {usd(room.costUsd)} est.
        </p>

        <p className="sr-only" aria-live="polite">
          {`Status: ${statusLabel(room.status)}.`}
        </p>

        <ol className="convo" aria-label="Build conversation">
          <UserTurn
            inspiration={props.inspiration}
            message={isRefineBuild ? build.message : null}
            rebuild={props.rebuild}
            showReferences={showRefs}
          />

          {room.preNotes.length ? (
            <li className="turn turn-plain">
              <Notes notes={room.preNotes} />
            </li>
          ) : null}

          {room.segments.map((seg) => (
            <SegmentTurn
              key={seg.key}
              seg={seg}
              live={seg.key === activeKey}
              isRefine={isRefineBuild}
              status={room.status}
            />
          ))}

          {!room.terminal ? (
            <li className="turn turn-working" aria-hidden>
              <span className="working-dot" />
              <span>{WORKING[room.status] ?? statusLabel(room.status)}</span>
              <span className="muted">{duration(elapsed)}</span>
              {conn === "reconnecting" ? <span className="muted">· reconnecting to the live log</span> : null}
            </li>
          ) : null}

          {shipped ? (
            <Turn
              icon="rocket"
              title={room.status === "live" ? "Shipped" : "Shipped as partial"}
              tone={room.status === "live" ? "ok" : "warn"}
              meta={[duration(elapsed), tokensText(props.tokens), `${usd(room.costUsd)} est.`]}
            >
              <ShipBody
                status={room.status as "live" | "partial"}
                liveUrl={liveUrl}
                slug={slug}
                connectorUrl={connectorUrl}
                models={models}
                demoUrl={room.recordingUrl ? null : demoUrl}
                demoPosterUrl={demoPosterUrl}
              />
            </Turn>
          ) : null}

          {room.status === "failed" ? (
            <Turn
              icon="alert"
              title="This build didn't ship"
              tone="bad"
              meta={[duration(elapsed), `${usd(room.costUsd)} est.`]}
            >
              <div className="rich">
                <p>{room.lastError ?? room.lastStatusMessage ?? "The checks didn't pass after the last fix round."}</p>
                <p className="muted">
                  A broken product is never shown as working. Muse Code&apos;s notes are in the log above.
                </p>
                <div className="row-actions">
                  <Link className="btn btn-outline" href="/">
                    <Icon name="plus" size={18} />
                    Try another muse
                  </Link>
                </div>
              </div>
            </Turn>
          ) : null}

          {room.status === "refused" && !room.segments.some((s) => s.type === "brief") ? (
            <Turn icon="alert" title="Declined" tone="bad">
              <p>{room.lastError ?? room.lastStatusMessage ?? "Muse Muse can't make this one."}</p>
            </Turn>
          ) : null}
        </ol>
        <div ref={end} className="convo-end" />

        {!atBottom && !room.terminal ? (
          <button
            type="button"
            className="jump"
            aria-label="Jump to latest"
            onClick={() => end.current?.scrollIntoView({ block: "end", behavior: smooth() })}
          >
            <Icon name="arrowDown" size={18} />
          </button>
        ) : null}

        {steering ? (
          <SteerBox buildId={build.id} />
        ) : refine.show ? (
          <div id="refine">
            <Composer
              mode="refine"
              buildId={build.id}
              signedIn={props.signedIn}
              floating
              autoFocus={props.focusRefine}
            />
          </div>
        ) : refine.elsewhere ? (
          <p className="muted center">
            {refine.elsewhere.running ? "A change to this product is building." : "This isn't the current version."}{" "}
            <Link href={`/b/${refine.elsewhere.buildId}`}>
              {refine.elsewhere.running ? "Open it to follow along." : "Open the current version to make more changes."}
            </Link>
          </p>
        ) : null}
      </div>

      <BuildPanel
        name={name}
        room={room}
        rail={rail}
        models={models}
        buildModel={build.buildModel}
        sessionId={build.museSessionId}
        maxFixRounds={props.maxFixRounds}
        elapsedMs={elapsed}
        tokens={props.tokens}
        liveUrl={liveUrl}
        demoUrl={demoUrl}
        productSlug={slug}
        connectorUrl={connectorUrl}
      />
    </div>
  );
}

function smooth(): ScrollBehavior {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

function SegmentTurn({
  seg,
  live,
  isRefine,
  status,
}: {
  seg: Segment;
  live: boolean;
  isRefine: boolean;
  status: BuildStatus;
}) {
  switch (seg.type) {
    case "brief":
      return (
        <Turn icon="brief" title="Brief" meta={segmentMeta(seg)} tone={status === "refused" ? "bad" : undefined}>
          <BriefBody brief={seg.brief} />
          <Notes notes={seg.notes} />
        </Turn>
      );
    case "muse": {
      const title =
        seg.round === 0 ? (isRefine ? "Muse Code made the change" : "Muse Code built it") : `Fix round ${seg.round}`;
      return (
        <Turn
          icon="terminal"
          title={live ? title.replace(/ (built it|made the change)$/, " is working") : title}
          meta={segmentMeta(seg, [museUsageText(seg)])}
        >
          <MuseLog lines={seg.lines} live={live} />
          <Notes notes={seg.notes} />
        </Turn>
      );
    }
    case "check": {
      const passed = seg.verify?.summary.passed && seg.judge?.pass !== false;
      const failedCheck = seg.verify?.summary.passed === false || seg.judge?.pass === false;
      return (
        <Turn
          icon="clipboard"
          title={seg.index === 0 ? "Checks" : `Checks, try ${seg.index + 1}`}
          meta={segmentMeta(seg)}
          tone={passed && seg.judge ? "ok" : failedCheck ? "bad" : undefined}
        >
          <CheckBody seg={seg} live={live || (!seg.judge && status === "verifying")} />
          <Notes notes={seg.notes} />
        </Turn>
      );
    }
    case "record":
      return (
        <Turn icon="video" title="Recorded demo" meta={segmentMeta(seg)}>
          <video
            className="demo"
            src={seg.url}
            poster={seg.posterUrl ?? undefined}
            controls
            preload="metadata"
            playsInline
            aria-label="Recorded demo"
          />
          <Notes notes={seg.notes} />
        </Turn>
      );
    case "deploy":
      return (
        <Turn icon="rocket" title="Deployed" meta={segmentMeta(seg)}>
          <p>
            Live at{" "}
            <a href={seg.url} target="_blank" rel="noopener noreferrer">
              {seg.url.replace(/^https?:\/\//, "")}
            </a>
            <span className="sr-only"> (opens in a new tab)</span>
          </p>
          <Notes notes={seg.notes} />
        </Turn>
      );
  }
}
