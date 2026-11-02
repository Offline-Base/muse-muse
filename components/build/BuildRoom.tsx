"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FloatButton, ScrollButton, ShowThinking, SourceList, StepList, StepsPanel, TitleChip, WorkingStep, type StepsTab } from "@/components/chat";
import { SegmentedTabs } from "@/components/chat/SegmentedTabs";
import { Composer } from "@/components/composer/Composer";
import { copyText } from "@/components/CopyButton";
import { Icon } from "@/components/icons";
import { Menu } from "@/components/Menu";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import type { BuildSummary, BuildView, InspirationView, ProductView, RebuildRef } from "@/components/view-types";
import { BuildDetails } from "@/components/build/BuildDetails";
import { OwnModelRow, type OwnModelOffer } from "@/components/build/OwnModelRow";
import { deriveRoom, railStates, refineSpot } from "@/components/build/derive";
import { PlanCard, planCardState, preloadPlanArt } from "@/components/build/PlanCard";
import { RequirementsChecklist } from "@/components/build/RequirementsChecklist";
import { latestChecklist } from "@/lib/full/requirements";
import { QuestionCard, SteerNote } from "@/components/build/session";
import { appsLine, nativeRows } from "@/components/build/apps";
import { proveRows } from "@/components/build/prove-rows";
import { conversationItems, currentStep, finalWords, roomSources, roomSteps, shareLink, stepsEnd, type ConvoItem } from "@/components/build/steps";
import { SteerBox } from "@/components/build/SteerBox";
import { StepsFeed } from "@/components/build/StepsFeed";
import { buildFeed } from "@/lib/steps-feed/facts";
import { BriefBody, BuildOutput, LivePreview, ShipBody, UserTurn, tokensText } from "@/components/build/turns";
import { duration, elapsedMs, isTerminalStatus, parseManifest, statusLabel, usd } from "@/lib/format";
import { proveRunning } from "@/lib/outputs/labels";
import { condenseNativeEvents, type BuildEvent } from "@/lib/types";

export interface BuildRoomProps {
  build: BuildView;
  product: ProductView | null;
  inspiration: InspirationView | null;
  events: BuildEvent[];
  history: BuildSummary[];
  tokens: { input: number; cached: number; output: number };
  /** The viewer owns the product or is an admin. */
  canRefine: boolean;
  /** Only this browser's edit pass lets the viewer refine (GUEST_EDITS), so the room says what ends that. */
  editsByPass?: boolean;
  /** The viewer may steer the build while Muse Code runs: owner powers as for canRefine, with steering switched on. */
  canSteer?: boolean;
  signedIn: boolean;
  origin: string;
  serverNow: number;
  focusRefine: boolean;
  rebuild: RebuildRef | null;
  maxFixRounds: number;
  /** BUILDS_ON_CONTRIBUTOR: the boxes in this room say what their text and files go to. */
  contributorNotice?: boolean;
  /** A native run can still add to this build's log (lib/native/active.ts), so a finished build's stream stays open. */
  nativeActive?: boolean;
  /** TUNE_FROM_BUILDS: the "Its own model" row's offer (components/build/OwnModelRow.tsx), or null. */
  ownModel?: OwnModelOffer | null;
  /** BUILD_ROOM_STEPS: two columns, a feed of simple steps on the left and the actual stuff on the right. */
  stepsFeed?: boolean;
}

/** Below this the steps panel covers the conversation, so it starts closed (components/chat/StepsPanel.tsx). */
const PANEL_COVERS = "(max-width: 1099.98px)";
/** The steps panel, for the button that opens it. */
const PANEL_ID = "room-steps-panel";
/** Within this of its end, the steps list counts as at its end, and follows the newest line. */
const PANEL_PINNED_PX = 80;
/** A finished build's stream that ends this soon after opening has nothing more coming. */
const QUICK_CLOSE_MS = 30_000;
/** How many of those may come in a row, with nothing new, before a native run counts as stopped. */
const MAX_QUICK_CLOSES = 3;

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

  // The server gave up on the run's steps, or the stream did: what's still unsettled in the log isn't moving.
  const [nativeEnded, setNativeEnded] = useState(isTerminalStatus(props.build.status) && !props.nativeActive);

  const room = useMemo(() => deriveRoom(build, events), [build, events]);
  const nativeRuns = useMemo(() => condenseNativeEvents(events), [events]);
  const nativeLive = !nativeEnded && nativeRuns.some((r) => r.active);
  const rail = useMemo(() => railStates(room, build.kind), [room, build.kind]);
  const now = useNow(props.serverNow, !room.terminal || proveRunning(events, props.serverNow));

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
  // (a terminal build with no native run going), stop instead of reconnecting forever. Incoming events are batched into
  // one render.
  useEffect(() => {
    const endedOnLoad = isTerminalStatus(props.build.status);
    // A Prove it run writes events after the build's end, so a page opened during one still listens.
    const proveEvents: BuildEvent[] = props.events.filter((e) => e.type === "prove");
    if (endedOnLoad && !props.nativeActive && !proveRunning(proveEvents, Date.now())) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let flush: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let attempts = 0;
    let sawTerminal = endedOnLoad;
    let lastId = props.events[props.events.length - 1]?.id ?? 0;
    const nativeLog: Array<{ type: string }> = props.events.filter((e) => e.type === "native");
    let openedAt = 0;
    let closesAtEnd = 0;
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
        openedAt = Date.now();
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
        closesAtEnd = 0;
        if (!ev.at) ev = { ...ev, at: new Date().toISOString() };
        buffer.push(ev);
        if (ev.type === "native") nativeLog.push(ev);
        if (ev.type === "status" && isTerminalStatus(ev.status)) sawTerminal = true;
        if (ev.type === "prove") proveEvents.push(ev);
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
        // A run that's still going means the server only ended this stream for its time limit, so the browser reconnects.
        // A stream the server ends soon after it opened means it sees nothing running, whatever the log's last word was.
        // A few of those in a row and the run counts as stopped.
        if (Date.now() - openedAt < QUICK_CLOSE_MS) closesAtEnd++;
        const nativeGoing = condenseNativeEvents(nativeLog).some((r) => r.active) && closesAtEnd <= MAX_QUICK_CLOSES;
        if (sawTerminal && !nativeGoing) setNativeEnded(true);
        if (sawTerminal && !nativeGoing && !proveRunning(proveEvents, Date.now())) {
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

  // The steps panel opens beside a running build, where it has the room, and from "Show thinking" otherwise. The server
  // can't know the window's width: until this effect has run, the stylesheet hides an open panel that would cover the
  // conversation (.room[data-settled="false"]), so a phone never sees it flash.
  // In the two column room the raw steps wait behind Show details.
  const [panelOpen, setPanelOpen] = useState(!props.stepsFeed && !isTerminalStatus(props.build.status));
  const [feedTab, setFeedTab] = useState<"steps" | "stuff">("steps");
  const [settled, setSettled] = useState(false);
  const [panelTab, setPanelTab] = useState<StepsTab>("steps");
  const [focusStep, setFocusStep] = useState<string | null>(null);
  useEffect(() => {
    if (window.matchMedia?.(PANEL_COVERS).matches) setPanelOpen(false);
    setSettled(true);
  }, []);
  const closePanel = useCallback(() => setPanelOpen(false), []);
  const panelRef = useRef<HTMLDivElement>(null);
  // Whether the steps list follows the newest line. A panel opening beside a running build starts at the end.
  const panelPinned = useRef(true);
  const showSteps = (step: string | null = null, follow = false) => {
    panelPinned.current = follow;
    setPanelTab("steps");
    setPanelOpen(true);
    setFocusStep(step);
  };
  useEffect(() => {
    if (!focusStep || !panelOpen) return;
    const row = panelRef.current?.querySelector(`[data-step="${CSS.escape(focusStep)}"]`);
    const body = row?.closest<HTMLElement>(".chat-panel-body");
    if (row && body) body.scrollTop += row.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
    setFocusStep(null);
  }, [focusStep, panelOpen]);
  // A reader who scrolls up, or opens a fold that pushes the end away, stays where they are until they're back at the end.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const onChange = () => {
      const body = panel.querySelector<HTMLElement>(".chat-panel-body:not([hidden])");
      if (!body?.querySelector('[role="log"]')) return;
      panelPinned.current = body.scrollHeight - body.scrollTop - body.clientHeight < PANEL_PINNED_PX;
    };
    // Neither event bubbles, so catch them on the way down.
    panel.addEventListener("scroll", onChange, true);
    panel.addEventListener("toggle", onChange, true);
    return () => {
      panel.removeEventListener("scroll", onChange, true);
      panel.removeEventListener("toggle", onChange, true);
    };
  }, []);
  const logRunning = !room.terminal || nativeLive;
  useEffect(() => {
    if (!panelOpen || panelTab !== "steps" || !logRunning || !panelPinned.current) return;
    const body = panelRef.current?.querySelector<HTMLElement>(".chat-panel-body:not([hidden])");
    if (body) body.scrollTop = body.scrollHeight;
  }, [events.length, panelOpen, panelTab, logRunning]);

  const items = useMemo(() => conversationItems(room), [room]);
  // An open question comes last, under the preview, so it sits beside the composer and not above a tall frame.
  const liveQuestions = items.filter((i) => i.type === "question" && i.live);
  const answering = Boolean(props.canSteer) && liveQuestions.length > 0;

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
  const seenEvents = useRef(events.length);
  useEffect(() => {
    if (seenEvents.current === events.length) return;
    seenEvents.current = events.length;
    if (atBottom && !room.terminal && !answering) end.current?.scrollIntoView({ block: "end", behavior: smooth() });
    // Only react to new events, not to scroll position changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length]);
  // A new question comes into view once. After that the page holds still, so the card doesn't move while it's answered.
  const convo = useRef<HTMLOListElement>(null);
  const newestQuestion = answering ? liveQuestions[liveQuestions.length - 1]?.key : undefined;
  useEffect(() => {
    if (!newestQuestion) return;
    const cards = convo.current?.querySelectorAll(".question-card");
    cards?.[cards.length - 1]?.scrollIntoView({ block: "start", behavior: smooth() });
  }, [newestQuestion]);

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

  const answer = useMemo(() => finalWords(room), [room]);
  const current = useMemo(() => currentStep(room), [room]);
  const plan = useMemo(() => planCardState(room), [room]);
  preloadPlanArt(room.status, isRefineBuild, room.planArtUrl);
  // The clock only matters to a Prove it run, so a build without one doesn't redraw its list each tick.
  const proveNow = events.some((e) => e.type === "prove") ? now : 0;
  const proveSteps = useMemo(() => proveRows(events, proveNow), [events, proveNow]);
  const proveStep = proveSteps[0];
  const panelList = useMemo(() => {
    if (!panelOpen) return null;
    const targets = [...nativeRows(nativeRuns, { live: nativeLive, slug: product?.slug ?? null }), ...proveSteps];
    const live = nativeLive || proveStep?.state === "running";
    return <StepList steps={roomSteps({ room, rail, isRefine: isRefineBuild, targets })} end={live ? undefined : stepsEnd(room)} />;
  }, [panelOpen, room, rail, isRefineBuild, nativeRuns, nativeLive, product?.slug, proveSteps, proveStep?.state]);
  const panelSources = useMemo(() => {
    if (!panelOpen) return null;
    return <SourceList sources={roomSources({ room, inspiration: props.inspiration, showReferences: showRefs, models })} empty="Nothing yet. What the build reads shows here." />;
    // `models` follows room and product, and is made new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen, room, props.inspiration, showRefs, product]);
  const lastCheck = [...room.segments].reverse().find((s) => s.type === "check" && s.verify?.screenshots.length);
  const lastShot = lastCheck?.type === "check" ? lastCheck.verify?.screenshots.at(-1)?.url : undefined;
  const apps = shipped ? appsLine(nativeRuns, nativeLive) : null;
  const feed = useMemo(() => (props.stepsFeed ? buildFeed(events) : null), [props.stepsFeed, events]);

  // The same rows in either room. Each keeps its own place in the list, since React's ids follow places.
  const planRow = plan ? (
    <li className="room-plan">
      <PlanCard brief={plan.brief} art={plan.art} running={!room.terminal} artUrl={room.planArtUrl} />
      <RequirementsChecklist items={latestChecklist(plan.brief, room.segments.flatMap((s) => (s.type === "check" ? [{ judge: s.judge, tests: s.verify?.summary.requirements ?? null }] : [])))} />
    </li>
  ) : null;
  const previewRow = room.previewUrl && !room.terminal ? (
    <li className="room-output">
      <LivePreview url={room.previewUrl} name={name} />
    </li>
  ) : null;
  const outputRow = shipped ? (
    <li className="room-output">
      <BuildOutput name={name} demoUrl={demoUrl} demoPosterUrl={demoPosterUrl} screenshotUrl={lastShot} />
    </li>
  ) : null;
  const answerRow = shipped ? (
    <li className="room-answer">
      {answer ? <MarkdownText className="say" text={answer} /> : null}
      <ShipBody status={room.status as "live" | "partial"} liveUrl={liveUrl} slug={slug} unpublished={feed?.unpublished} />
      <p className="room-meta">{[duration(elapsed), tokensText(props.tokens), `${usd(room.costUsd)} est.`].filter(Boolean).join(" · ")}</p>
    </li>
  ) : null;
  const appsRow = apps ? (
    <li className="room-working">
      <WorkingStep title={apps.title} description={apps.description} state={apps.state} />
      <p className="room-working-meta">
        {apps.costUsd ? `${usd(apps.costUsd)} est.` : null}
        <StepsToggle open={panelOpen} onClick={() => (panelOpen ? closePanel() : showSteps(`apps:${apps.runId}`, nativeLive))} />
      </p>
    </li>
  ) : null;
  const proveRow = shipped && proveStep ? (
    <li className="room-working">
      <WorkingStep title={proveStep.title} description={proveStep.description} state={proveStep.state} />
      <p className="room-working-meta">
        <StepsToggle open={panelOpen} onClick={() => (panelOpen ? closePanel() : showSteps(proveStep.id, proveStep.state === "running"))} />
      </p>
    </li>
  ) : null;
  const failedRow = room.status === "failed" ? (
    <li className="room-answer">
      <p>This build didn&apos;t ship.</p>
      <p>{room.lastError ?? room.lastStatusMessage ?? "The checks didn't pass after the last fix round."}</p>
      <p className="muted">A broken product is never shown as working. Muse Code&apos;s notes are in its steps.</p>
      <div className="row-actions">
        <Link className="btn btn-outline" href="/">
          <Icon name="plus" size={18} />
          Try another muse
        </Link>
      </div>
      <p className="room-meta">{[duration(elapsed), `${usd(room.costUsd)} est.`].join(" · ")}</p>
    </li>
  ) : null;
  const refusedRow = room.status === "refused" ? (
    <li className="room-answer">
      {brief ? <BriefBody brief={brief} /> : <p>{room.lastError ?? room.lastStatusMessage ?? "Muse Muse can't make this one."}</p>}
    </li>
  ) : null;

  if (feed) {
    const checks = items.filter((item) => item.type === "step");
    const notes = items.filter((item) => item.type === "owner" || (item.type === "say" && item.reply) || (item.type === "question" && !item.live));
    const panelToggle = <StepsToggle label="details" open={panelOpen} onClick={() => (panelOpen ? closePanel() : showSteps(null, !room.terminal))} />;
    return (
      <div className="room chat-split" data-settled={settled}>
        <div className="room-main room-main-feed">
          <div className="room-top">
            <TitleChip as="h1">{name}</TitleChip>
            <div className="room-top-actions">
              <ShareButton url={shareLink({ liveUrl, origin: props.origin, buildId: build.id })} />
              <Menu label="Build details" icon="more" iconSize={20} iconStrokeWidth={3} buttonClassName="chat-float">
                <BuildDetails
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
                  openUrl={openUrl}
                  buildId={build.id}
                  history={props.history}
                  now={now}
                />
              </Menu>
            </div>
          </div>

          <p className="sr-only" aria-live="polite">
            {`Status: ${feed.unpublished && shipped ? "Finished, not online" : statusLabel(room.status)}.`}
          </p>

          <div className="room-feed-switch">
            <SegmentedTabs
              label="What to show"
              idBase="room-feed"
              value={feedTab}
              onChange={setFeedTab}
              tabs={[
                { id: "steps", label: "Steps" },
                { id: "stuff", label: "The build" },
              ]}
            />
          </div>

          <div className="room-columns" data-show={feedTab}>
            <div className="room-feed-col">
              <ol ref={convo} className="convo" aria-label="Build conversation">
                <UserTurn inspiration={props.inspiration} message={isRefineBuild ? build.message : null} rebuild={props.rebuild} showReferences={showRefs} />
                <li className="room-working">
                  {current ? (
                    <WorkingStep title={current.title} />
                  ) : (
                    <WorkingStep title={feed.unpublished && shipped ? "Finished, not online" : statusLabel(room.status)} state={room.status === "failed" || room.status === "refused" ? "failed" : "done"} />
                  )}
                  <p className="room-working-meta">
                    {duration(elapsed)} · {usd(room.costUsd)} est.
                    {conn === "reconnecting" ? " · reconnecting to the live log" : ""}
                    {panelToggle}
                  </p>
                </li>
                <li>
                  <StepsFeed feed={feed} />
                </li>
                {notes.map((item) => (
                  <ConvoRow key={item.key} item={item} buildId={build.id} canAnswer={Boolean(props.canSteer)} onShow={showSteps} />
                ))}
                {failedRow}
                {refusedRow}
                {liveQuestions.map((item) => (
                  <ConvoRow key={item.key} item={item} buildId={build.id} canAnswer={Boolean(props.canSteer)} onShow={showSteps} />
                ))}
              </ol>
              <div ref={end} className="convo-end" />
              {!atBottom ? <ScrollButton className="room-jump" onClick={() => end.current?.scrollIntoView({ block: "end", behavior: smooth() })} /> : null}
              {steering ? (
                <div className="room-composer">
                  <SteerBox buildId={build.id} contributorNotice={props.contributorNotice} />
                </div>
              ) : refine.show ? (
                <div id="refine" className="room-composer">
                  <Composer mode="refine" buildId={build.id} signedIn={props.signedIn} floating autoFocus={props.focusRefine} contributorNotice={props.contributorNotice} />
                  {props.editsByPass ? (
                    <p className="muted small center">Guests share one account, so only this browser can change this product. Clearing its cookies ends that.</p>
                  ) : null}
                </div>
              ) : refine.elsewhere ? (
                <p className="muted center room-elsewhere">
                  {refine.elsewhere.running ? "A change to this product is building." : "This isn't the current version."}{" "}
                  <Link href={refine.elsewhere.running ? `/b/${refine.elsewhere.buildId}` : `/b/${refine.elsewhere.buildId}?refine=1#refine`}>
                    {refine.elsewhere.running ? "Open it to follow along." : "Keep editing the current version."}
                  </Link>
                </p>
              ) : null}
            </div>

            <aside className="room-stuff" aria-label="The build">
              <ol className="convo">
                {/* What's real comes first, then the plan it came from. Each keeps its place, so a preview doesn't reload. */}
                {previewRow}
                {outputRow}
                {answerRow}
                {planRow}
                {appsRow}
                {proveRow}
                {checks.map((item) => (
                  <ConvoRow key={item.key} item={item} buildId={build.id} canAnswer={Boolean(props.canSteer)} onShow={showSteps} />
                ))}
                <OwnModelRow offer={props.ownModel} brief={brief} status={room.status} buildId={build.id} />
                {!plan && !shipped ? <li className="room-stuff-empty muted">The plan, preview and demo show up here as they&apos;re made.</li> : null}
              </ol>
            </aside>
          </div>
        </div>

        <div ref={panelRef} className="room-panel">
          <StepsPanel
            id={PANEL_ID}
            open={panelOpen}
            onClose={closePanel}
            tab={panelTab}
            onTabChange={setPanelTab}
            steps={
              <div role={logRunning ? "log" : undefined} aria-relevant={logRunning ? "additions" : undefined} aria-label={logRunning ? "Muse Code activity" : undefined}>
                {panelList}
              </div>
            }
            sources={panelSources}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="room chat-split" data-settled={settled}>
      <div className="room-main">
        <div className="room-top">
          <TitleChip as="h1">{name}</TitleChip>
          <div className="room-top-actions">
            <ShareButton url={shareLink({ liveUrl, origin: props.origin, buildId: build.id })} />
            <Menu label="Build details" icon="more" iconSize={20} iconStrokeWidth={3} buttonClassName="chat-float">
              <BuildDetails
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
                openUrl={openUrl}
                buildId={build.id}
                history={props.history}
                now={now}
              />
            </Menu>
          </div>
        </div>

        <p className="sr-only" aria-live="polite">
          {`Status: ${statusLabel(room.status)}.`}
        </p>
        {/* The panel's log announces each line while it's open. */}
        <p className="sr-only" aria-live="polite">
          {current && !panelOpen ? (current.description ?? current.title) : ""}
        </p>

        <ol ref={convo} className="convo" aria-label="Build conversation">
          <UserTurn
            inspiration={props.inspiration}
            message={isRefineBuild ? build.message : null}
            rebuild={props.rebuild}
            showReferences={showRefs}
          />

          {items
            .filter((item) => !liveQuestions.includes(item))
            .map((item) => (
              <ConvoRow key={item.key} item={item} buildId={build.id} canAnswer={Boolean(props.canSteer)} onShow={showSteps} />
            ))}

          {current ? (
            <li className="room-working">
              <WorkingStep title={current.title} description={current.description}>
                {current.children.map((c) => (
                  <WorkingStep key={c.id} nested title={c.title} />
                ))}
              </WorkingStep>
              <p className="room-working-meta">
                {duration(elapsed)} · {usd(room.costUsd)} est.
                {conn === "reconnecting" ? " · reconnecting to the live log" : ""}
                <StepsToggle open={panelOpen} onClick={() => (panelOpen ? closePanel() : showSteps(null, true))} />
              </p>
            </li>
          ) : null}

          {/* The plan once the brief is written, under what the build is doing: the whole brief, once in the conversation. */}
          {planRow}

          {previewRow}

          {outputRow}

          {answerRow}

          {appsRow}

          {proveRow}

          {failedRow}

          {refusedRow}

          {liveQuestions.map((item) => (
            <ConvoRow key={item.key} item={item} buildId={build.id} canAnswer={Boolean(props.canSteer)} onShow={showSteps} />
          ))}
          {/* TUNE_FROM_BUILDS: its own model, once shipped. Last, so no row before it moves (React's ids follow places). */}
          <OwnModelRow offer={props.ownModel} brief={brief} status={room.status} buildId={build.id} />
        </ol>
        <div ref={end} className="convo-end" />

        {!atBottom ? (
          <ScrollButton className="room-jump" onClick={() => end.current?.scrollIntoView({ block: "end", behavior: smooth() })} />
        ) : null}

        {steering ? (
          <div className="room-composer">
            <SteerBox buildId={build.id} contributorNotice={props.contributorNotice} />
          </div>
        ) : refine.show ? (
          <div id="refine" className="room-composer">
            <Composer
              mode="refine"
              buildId={build.id}
              signedIn={props.signedIn}
              floating
              autoFocus={props.focusRefine}
              contributorNotice={props.contributorNotice}
            />
            {props.editsByPass ? (
              <p className="muted small center">Guests share one account, so only this browser can change this product. Clearing its cookies ends that.</p>
            ) : null}
          </div>
        ) : refine.elsewhere ? (
          <p className="muted center room-elsewhere">
            {refine.elsewhere.running ? "A change to this product is building." : "This isn't the current version."}{" "}
            <Link href={refine.elsewhere.running ? `/b/${refine.elsewhere.buildId}` : `/b/${refine.elsewhere.buildId}?refine=1#refine`}>
              {refine.elsewhere.running ? "Open it to follow along." : "Keep editing the current version."}
            </Link>
          </p>
        ) : null}
      </div>

      <div ref={panelRef} className="room-panel">
        <StepsPanel
          id={PANEL_ID}
          open={panelOpen}
          onClose={closePanel}
          tab={panelTab}
          onTabChange={setPanelTab}
          steps={
            <div role={logRunning ? "log" : undefined} aria-relevant={logRunning ? "additions" : undefined} aria-label={logRunning ? "Muse Code activity" : undefined}>
              {panelList}
            </div>
          }
          sources={panelSources}
        />
      </div>
    </div>
  );
}

/** Opens and closes the steps panel from the running step. It stays on the page, so the panel can give focus back to it. */
export function StepsToggle({ open, onClick, label = "steps" }: { open: boolean; onClick: () => void; label?: string }) {
  return (
    <button type="button" className="link-btn room-steps-link" aria-expanded={open} aria-controls={PANEL_ID} onClick={onClick}>
      {open ? `Hide ${label}` : `Show ${label}`}
      <Icon name="chevronRight" size={16} />
    </button>
  );
}

/** Copies the product's link, and confirms with a check for a moment. */
function ShareButton({ url }: { url: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <>
      <FloatButton
        icon={state === "copied" ? "check" : "share"}
        label={state === "failed" ? "Couldn't copy the link" : state === "copied" ? "Link copied" : "Copy this product's link"}
        onClick={async () => {
          const ok = await copyText(url);
          setState(ok ? "copied" : "failed");
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setState("idle"), 2000);
        }}
      />
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Link copied" : state === "failed" ? "Couldn't copy the link" : ""}
      </span>
    </>
  );
}

function smooth(): ScrollBehavior {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

function ConvoRow({
  item,
  buildId,
  canAnswer,
  onShow,
}: {
  item: ConvoItem;
  buildId: string;
  /** The viewer may steer, so can answer Muse Code's questions. */
  canAnswer: boolean;
  onShow: (step: string | null) => void;
}) {
  switch (item.type) {
    case "thinking":
      return (
        <li>
          <ShowThinking onClick={() => onShow(item.step)} />
        </li>
      );
    case "owner":
      return (
        <li>
          <SteerNote group={item.group} />
        </li>
      );
    case "say":
      return (
        <li className="room-answer">
          <MarkdownText className="say" text={item.text} />
        </li>
      );
    case "step":
      return (
        <li>
          <WorkingStep title={item.title} description={item.description} state={item.state} />
        </li>
      );
    case "question":
      return (
        <li>
          <QuestionCard question={item.question} buildId={buildId} canAnswer={canAnswer} live={item.live} />
        </li>
      );
  }
}
