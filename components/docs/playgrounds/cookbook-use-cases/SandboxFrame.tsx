"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { makeNonce, readCapture, readLog, wrapPage, type CaptureResult, type LogLine, type Probe } from "@/components/docs/playgrounds/cookbook-use-cases/lib/harness";

/**
 * Model-written HTML, live in the page: an iframe with sandbox="allow-scripts" and srcdoc (no allow-same-origin), so
 * the code runs with an opaque origin and can't reach this page, its cookies or its storage. The harness inside
 * (lib/harness.ts) reports the console here and answers capture() with a screenshot and a text snapshot after
 * playing the input the demo asks for. Nothing it does leaves the browser.
 */

export interface SandboxHandle {
  /**
   * Plays the probes, then returns a screenshot and a snapshot. Resolves with an error after `timeoutMs`. Chrome
   * pauses animation frames in a hidden tab and in an off-screen cross-origin frame, so the capture first waits for
   * the tab to be visible (`onWait` says so) and scrolls the frame into view when it is fully off screen.
   */
  capture(probes?: Probe[], opts?: CaptureOptions): Promise<CaptureResult>;
  /** The console so far, for this load of the page. */
  logs(): LogLine[];
  /** Loads the page again from scratch. */
  reload(): void;
}

export interface CaptureOptions {
  maxSide?: number;
  timeoutMs?: number;
  /** Called with a short status line while the capture waits for the tab to be visible again. */
  onWait?: (status: string) => void;
}

/** Resolves once this tab is visible (at once when it already is). */
export function whenTabVisible(): Promise<void> {
  if (typeof document === "undefined" || !document.hidden) return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

export function SandboxFrame({
  html,
  title,
  height = 420,
  viewport,
  ref,
  onLog,
  showConsole = true,
}: {
  html: string;
  title: string;
  height?: number;
  /** Lay the page out at this size (the recipes' 1280 x 800 browser) and scale it down to fit the column. */
  viewport?: { width: number; height: number };
  ref?: Ref<SandboxHandle>;
  onLog?: (line: LogLine) => void;
  showConsole?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el || !viewport) return;
    // Measure now as well: a hidden tab delivers no ResizeObserver callbacks until it is shown.
    setBoxWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewport]);
  const scale = viewport && boxWidth ? Math.min(1, boxWidth / viewport.width) : 1;
  const [nonce, setNonce] = useState(() => makeNonce());
  const [lines, setLines] = useState<LogLine[]>([]);
  const linesRef = useRef<LogLine[]>([]);
  const pending = useRef(new Map<string, (r: CaptureResult) => void>());
  const ready = useRef(false);
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;

  const srcDoc = useMemo(() => wrapPage(html, nonce), [html, nonce]);

  useEffect(() => {
    ready.current = false;
    linesRef.current = [];
    setLines([]);
  }, [srcDoc]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const data = e.data as { __cuc?: unknown; type?: unknown; id?: unknown } | null;
      if (!data || data.__cuc !== nonce) return;
      if (data.type === "ready") {
        ready.current = true;
        return;
      }
      const log = readLog(data);
      if (log) {
        if (linesRef.current.length < 300) {
          linesRef.current = [...linesRef.current, log];
          setLines(linesRef.current);
        }
        onLogRef.current?.(log);
        return;
      }
      const result = readCapture(data);
      if (result && typeof data.id === "string") {
        const resolve = pending.current.get(data.id);
        pending.current.delete(data.id);
        resolve?.(result);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [nonce]);

  const capture = useCallback(
    async (probes: Probe[] = [], opts: CaptureOptions = {}): Promise<CaptureResult> => {
      const failed = (error: string): CaptureResult => ({ screenshot: null, snapshot: "", width: 0, height: 0, error });
      if (typeof document !== "undefined" && document.hidden) {
        opts.onWait?.("Waiting for this tab to be visible: the browser check plays input and takes screenshots in it.");
        await whenTabVisible();
      }
      const el = frame.current;
      const r = el?.getBoundingClientRect();
      if (el && r && (r.bottom <= 0 || r.top >= window.innerHeight)) {
        el.scrollIntoView({ block: "nearest" });
        await new Promise((done) => setTimeout(done, 300));
      }
      const win = frame.current?.contentWindow;
      if (!win) return failed("The page isn't loaded.");
      // Give a page that is still loading (a CDN script, a font) a moment before playing input into it.
      for (let i = 0; i < 30 && !ready.current; i++) await new Promise((r) => setTimeout(r, 100));
      const id = makeNonce();
      const budget = opts.timeoutMs ?? 25000;
      return new Promise<CaptureResult>((resolve) => {
        const timer = setTimeout(() => {
          pending.current.delete(id);
          resolve(failed("The page didn't answer the capture request in time."));
        }, budget);
        pending.current.set(id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        win.postMessage({ __cuc: nonce, type: "capture", id, probes, maxSide: opts.maxSide ?? 1024 }, "*");
      });
    },
    [nonce],
  );

  useImperativeHandle(ref, () => ({ capture, logs: () => linesRef.current, reload: () => setNonce(makeNonce()) }), [capture]);

  const errors = lines.filter((l) => l.level === "error").length;
  return (
    <div className={styles.frameWrap}>
      <div className={styles.frameBar}>
        <span className={styles.frameDots} aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span>{title}</span>
        <span className={styles.runbarSpacer} />
        <span>{viewport ? `${viewport.width} x ${viewport.height}, ` : ""}sandbox: allow-scripts only</span>
        <button type="button" className="btn btn-sm" onClick={() => setNonce(makeNonce())}>
          Reload
        </button>
      </div>
      <div ref={box} style={viewport ? { height: Math.round(viewport.height * scale), overflow: "hidden" } : undefined}>
        <iframe
          ref={frame}
          className={styles.frame}
          title={title}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          style={
            viewport
              ? // maxWidth: the site's global iframe { max-width: 100% } would squeeze the page back to the column width.
                { width: viewport.width, height: viewport.height, maxWidth: "none", transform: `scale(${scale})`, transformOrigin: "0 0" }
              : { height }
          }
          referrerPolicy="no-referrer"
        />
      </div>
      {showConsole ? (
        <details className={styles.console} open={errors > 0}>
          <summary>
            Console: {lines.length} line{lines.length === 1 ? "" : "s"}
            {errors ? `, ${errors} error${errors === 1 ? "" : "s"}` : ""}
          </summary>
          <div role="log" aria-live="polite">
            {lines.map((l, i) => (
              <span key={i} className={styles.consoleLine} data-level={l.level}>
                [{l.level}] {l.text}
              </span>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
