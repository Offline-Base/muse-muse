"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDocsPage, type RecordedRequest } from "@/components/docs/kit/DocsPageContext";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { DocsResult } from "@/lib/docs/client/api";
import { trimForRecord } from "@/lib/docs/client/record";
import {
  SamStreamParser,
  objectIds,
  samDelta,
  samTextOfResponse,
  type SamDiagnostic,
  type SamFrame,
  type SamRecord,
} from "@/lib/docs/media/sam";

/**
 * One SAM 3.1 request through the docs proxy (useDocsRun), read the way the SAM pages describe: each
 * `response.output_text.delta` is one line, parsed as it arrives (lib/docs/media/sam.ts), and the stream ends on
 * `response.completed`, whose response carries the usage (images_processed or video_frames_processed). A
 * non-streamed reply is parsed from its output text. Keeps the event sequence for the anatomy views and hands every
 * event to `onEvent`, so Meta's own parser can read the same stream.
 *
 * A streamed request can also fail after its HTTP 200: checks that need the media (a prompt's w and h against the
 * image's aspect ratio) run once the stream has started, and arrive as an `error` event, then `response.failed`
 * (checked on Oct 30, 2026; the same request unstreamed gets a 400). That is a failure, not zero matches, so it is
 * kept in `error` and every view and the copy prompt say so.
 */

/** A failure a stream reported under HTTP 200. */
export interface SamStreamError {
  code?: string;
  message: string;
}

export interface SamRunOutput {
  records: SamRecord[];
  /** Frames in arrival order. */
  frames: SamFrame[];
  raw: string;
  diagnostics: SamDiagnostic[];
  usage: Record<string, unknown> | null;
  /** The final response object, for the JSON tab. */
  response: unknown;
  /** Event types in order, consecutive repeats folded: [["response.output_text.delta", 120], ...]. */
  events: Array<[string, number]>;
  deltas: number;
  /** An `error` event or `response.failed` the stream carried, or null. */
  error: SamStreamError | null;
  done: boolean;
}

export const EMPTY_SAM_OUTPUT: SamRunOutput = {
  records: [],
  frames: [],
  raw: "",
  diagnostics: [],
  usage: null,
  response: null,
  events: [],
  deltas: 0,
  error: null,
  done: false,
};

/**
 * The failure one stream event reports: an `error` event (its code and message, top level or under `error`) or a
 * `response.failed` (the response's error). Null for every other event.
 */
export function samStreamError(event: Record<string, unknown>): SamStreamError | null {
  const read = (v: unknown): SamStreamError | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o.message !== "string" || !o.message) return null;
    return { ...(typeof o.code === "string" && o.code ? { code: o.code } : {}), message: o.message };
  };
  if (event.type === "error") return read(event) ?? read(event.error) ?? { message: "The stream reported an error." };
  if (event.type === "response.failed") {
    return read((event.response as Record<string, unknown> | undefined)?.error) ?? { message: "The response failed." };
  }
  return null;
}

/**
 * The result for ResponseView: a stream that failed under HTTP 200 carries its error, so the status shows as a
 * failure rather than a green 200.
 */
export function samResultView(result: DocsResult | null, out: SamRunOutput | null): DocsResult | null {
  if (!result || !result.ok || !out?.error || result.error) return result;
  return { ...result, error: { code: out.error.code, message: out.error.message } };
}

export interface SamRunInit {
  body: Record<string, unknown>;
  stream: boolean;
  /** Every event as it arrives (stream), or the whole reply once (no stream). */
  onEvent?: (event: Record<string, unknown>) => void;
  /** What to record for the copy prompt. */
  describe?: (out: SamRunOutput, result: DocsResult) => Partial<RecordedRequest>;
}

/** The failure events a stream carried, in words: "an error event, then response.failed". */
export function failureEvents(out: Pick<SamRunOutput, "events">): string {
  const seen = new Set(out.events.map(([type]) => type));
  if (seen.has("error") && seen.has("response.failed")) return "an error event, then response.failed";
  return seen.has("response.failed") ? "response.failed" : "an error event";
}

/** "2 objects (ids 0, 1) on 1 frame", for the copy prompt. A stream that failed under HTTP 200 says so. */
export function samOutcome(out: SamRunOutput, result: DocsResult): string {
  if (!result.ok) return `error ${result.status}: ${result.error?.message ?? ""}`.trim();
  if (out.error) {
    const kept = out.records.length ? ` after ${objectIds(out.records).length} objects` : "";
    return `HTTP 200, then the stream failed${kept} (${failureEvents(out)}): ${out.error.code ? `${out.error.code}: ` : ""}${out.error.message}`;
  }
  const ids = objectIds(out.records);
  const frames = new Set(out.records.map((r) => r.frame)).size;
  return ids.length
    ? `${ids.length} object${ids.length === 1 ? "" : "s"} (ids ${ids.join(", ")}) on ${frames} frame${frames === 1 ? "" : "s"}, as box and mask tokens in output_text`
    : "no matches: an empty output_text, which is a normal result";
}

export function useSamRun() {
  const runner = useDocsRun();
  const { run: docsRun, reset: docsReset } = runner;
  const { recordRequest } = useDocsPage();
  const record = useRef(recordRequest);
  record.current = recordRequest;
  const [out, setOut] = useState<SamRunOutput | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const run = useCallback(
    async ({ body, stream, onEvent, describe }: SamRunInit): Promise<{ result: DocsResult; out: SamRunOutput }> => {
      const parser = new SamStreamParser();
      let current: SamRunOutput = { ...EMPTY_SAM_OUTPUT, events: [] };
      let sawDelta = false;
      const note = (type: string) => {
        const last = current.events.at(-1);
        current.events = last && last[0] === type ? [...current.events.slice(0, -1), [type, last[1] + 1]] : [...current.events, [type, 1]];
      };
      const snapshot = (done = false): SamRunOutput => {
        const o = parser.output();
        return { ...current, records: o.records, frames: o.frames, diagnostics: o.diagnostics, raw: parser.raw, done };
      };
      const draw = () => {
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          setOut(snapshot());
        });
      };
      setOut(current);

      const result = await docsRun("responses", {
        body,
        stream,
        record: false,
        onEvent: (e) => {
          const json = e.json;
          if (!json) return;
          onEvent?.(json);
          const type = typeof json.type === "string" ? json.type : (e.event ?? "message");
          note(type);
          const failure = samStreamError({ ...json, type });
          if (failure) {
            current.error ??= failure;
            if (type === "response.failed") current.response = (json.response as Record<string, unknown> | undefined) ?? null;
            return;
          }
          const delta = samDelta(json);
          if (delta !== null) {
            sawDelta = true;
            current.deltas++;
            if (parser.push(delta).length) draw();
            return;
          }
          // A lane finalized without deltas carries the whole text once.
          if (type === "response.output_text.done" && !sawDelta && typeof json.text === "string") {
            sawDelta = true;
            parser.push(json.text);
          }
          if (type === "response.completed" || type === "response.incomplete") {
            const final = json.response as Record<string, unknown> | undefined;
            current.response = final ?? null;
            current.usage = (final?.usage as Record<string, unknown> | undefined) ?? null;
            if (!sawDelta && final) parser.push(samTextOfResponse(final));
          }
        },
      });
      if (!stream && result.json) {
        const json = result.json as Record<string, unknown>;
        onEvent?.(json);
        current.response = json;
        current.usage = (json.usage as Record<string, unknown> | undefined) ?? null;
        note("response (not streamed)");
        parser.push(samTextOfResponse(json));
      }
      parser.end();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      const final = snapshot(true);
      setOut(final);
      const extra = describe?.(final, result) ?? {};
      record.current({
        method: "POST",
        path: "responses",
        body: trimForRecord(body),
        status: result.status,
        outcome: samOutcome(final, result),
        ...extra,
      });
      return { result, out: final };
    },
    [docsRun],
  );

  const clear = useCallback(() => {
    docsReset();
    setOut(null);
  }, [docsReset]);

  return { ...runner, out, run, clear };
}
