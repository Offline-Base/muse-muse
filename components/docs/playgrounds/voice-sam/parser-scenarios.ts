import {
  decodeMaskToRaster,
  parseVideoStream,
  recordsOfKind,
  ResponsesStreamError,
  type ResponseStreamOutcome,
  type SegmentationDiagnostic,
} from "@meta-sam/parser";

/**
 * Stream lifecycles for @meta-sam/parser, run on the page with Meta's own parser and no API call
 * (sam/client-libraries: "Read snapshots and the final result", "Handle errors and diagnostics", "Consume the stream
 * once"). Each scenario feeds the parser a short event stream built from the page's own video line, whose mask
 * payloads are complete, and reports the outcome, the records and diagnostics, or the error class and its stable code.
 */

/** Frame 0 of a six-frame clip, prompt "button", 320 x 334, two objects (sam/reading-segmentation, "Video output grammar"). */
export const DOC_VIDEO_LINE =
  "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>," +
  "1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>\n";

/** The same objects one frame later with confidence, as include_confidence: "true" returns them. */
export const DOC_CONFIDENCE_LINE = DOC_VIDEO_LINE.replace("<0f>", "<1f>")
  .replace("h=334|><|mask;x=0;y=0;data=27,60", "h=334;c=0.9609375|><|mask;x=0;y=0;c=0.9609375;data=27,60")
  .replace("h=334|><|mask;x=0;y=0;data=27,48", "h=334;c=0.71875|><|mask;x=0;y=0;c=0.71875;data=27,48");

export type ScenarioId =
  | "completed"
  | "confidence"
  | "zero"
  | "eof"
  | "incomplete"
  | "bad_line"
  | "failed"
  | "error_event"
  | "refusal"
  | "lane"
  | "source"
  | "consumed"
  | "aborted"
  | "invalid_mask";

export interface Scenario {
  id: ScenarioId;
  label: string;
  /** What the page says should happen. */
  expect: string;
}

export const SCENARIOS: readonly Scenario[] = [
  { id: "completed", label: "Completed stream", expect: "outcome completed: a valid response.completed closed the finalized output-text lane." },
  { id: "confidence", label: "With confidence", expect: "Box and mask records carry confidence, read per frame." },
  { id: "zero", label: "Zero matches", expect: "An empty lane is a valid completed response with no records." },
  { id: "eof", label: "Source ends early", expect: 'outcome incomplete with reason "eof": parsed output is still returned.' },
  { id: "incomplete", label: "response.incomplete", expect: 'outcome incomplete with reason "response".' },
  { id: "bad_line", label: "Malformed line", expect: "The bad line becomes a diagnostic; the good line's records stay." },
  { id: "failed", label: "response.failed", expect: "ResponsesStreamFailedError, code response_failed." },
  { id: "error_event", label: "error event", expect: "ResponsesStreamEventError, code response_error." },
  { id: "refusal", label: "Refusal", expect: "ResponsesStreamRefusalError, code response_refusal." },
  { id: "lane", label: "Lane never finalized", expect: "The output-text lane is inconsistent: ResponsesStreamLaneError, code response_lane." },
  { id: "source", label: "Source fails", expect: "The event source fails: ResponsesStreamSourceError, code source_error." },
  { id: "consumed", label: "Read twice", expect: "ResponsesStreamConsumedError, code stream_consumed." },
  { id: "aborted", label: "Break early", expect: "finalResult rejects with ResponsesStreamAbortedError, code stream_aborted." },
  { id: "invalid_mask", label: "Corrupt mask", expect: "decodeMaskToRaster throws InvalidSegmentationMaskError, code invalid_mask_payload." },
];

export interface ScenarioResult {
  id: ScenarioId;
  /** The event types fed to the parser, in order. */
  fed: string[];
  /** Each snapshot's revision and record count. */
  snapshots: Array<{ revision: number; records: number }>;
  outcome?: ResponseStreamOutcome;
  records?: number;
  boxes?: Array<{ objectId: string; frame?: number; left: number; top: number; right: number; bottom: number; confidence?: number }>;
  diagnostics?: Array<Pick<SegmentationDiagnostic, "severity" | "code" | "message" | "line">>;
  error?: { name: string; code: string; message: string };
}

const LANE = { item_id: "msg_docs", output_index: 0, content_index: 0 } as const;

type Event = { type: string } & Record<string, unknown>;

function deltas(text: string): Event[] {
  // Split inside the first mask payload: chunk boundaries don't matter to the parser.
  const cut = text.indexOf("~!!!!M") + 4;
  return [
    { type: "response.output_text.delta", ...LANE, delta: text.slice(0, cut) },
    { type: "response.output_text.delta", ...LANE, delta: text.slice(cut) },
  ];
}

const done = (text: string): Event => ({ type: "response.output_text.done", ...LANE, text });
const COMPLETED: Event = { type: "response.completed" };

function eventsFor(id: ScenarioId): Event[] {
  switch (id) {
    case "completed":
      return [...deltas(DOC_VIDEO_LINE), done(DOC_VIDEO_LINE), COMPLETED];
    case "confidence":
      return [...deltas(DOC_CONFIDENCE_LINE), done(DOC_CONFIDENCE_LINE), COMPLETED];
    case "zero":
      return [done(""), COMPLETED];
    case "eof":
      return deltas(DOC_VIDEO_LINE);
    case "incomplete":
      return [...deltas(DOC_VIDEO_LINE), done(DOC_VIDEO_LINE), { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }];
    case "bad_line": {
      const text = `${DOC_VIDEO_LINE}<1f>0<|box;x1=211;y1=228;w=320;h=334|>\n`;
      return [{ type: "response.output_text.delta", ...LANE, delta: text }, done(text), COMPLETED];
    }
    case "failed":
      return [...deltas(DOC_VIDEO_LINE), { type: "response.failed", response: { error: { message: "The segmentation failed." } } }];
    case "error_event":
      return [{ type: "error", message: "The stream reported an error." }];
    case "refusal":
      return [{ type: "response.refusal.delta", ...LANE, delta: "I can't help with that." }];
    case "lane":
      // response.completed before any output_text.done: the lane was never finalized.
      return [...deltas(DOC_VIDEO_LINE), COMPLETED];
    case "source":
      // The first delta arrives, then the source itself throws (a dropped connection); see source() below.
      return deltas(DOC_VIDEO_LINE).slice(0, 1);
    default:
      return [...deltas(DOC_VIDEO_LINE), done(DOC_VIDEO_LINE), COMPLETED];
  }
}

async function* source(events: readonly Event[], fail = false): AsyncGenerator<Event> {
  for (const e of events) yield e;
  if (fail) throw new Error("The connection dropped.");
}

/** The page's error table: each stable code and its class. Read by code, since a minifier may rename classes. */
export const PARSER_ERRORS: Readonly<Record<string, string>> = {
  stream_consumed: "ResponsesStreamConsumedError",
  stream_aborted: "ResponsesStreamAbortedError",
  response_failed: "ResponsesStreamFailedError",
  response_error: "ResponsesStreamEventError",
  response_lane: "ResponsesStreamLaneError",
  response_refusal: "ResponsesStreamRefusalError",
  parser_error: "ResponsesStreamParserError",
  source_error: "ResponsesStreamSourceError",
  invalid_mask_payload: "InvalidSegmentationMaskError",
};

function errorOf(err: unknown): ScenarioResult["error"] {
  if (err instanceof ResponsesStreamError) return { name: PARSER_ERRORS[err.code] ?? "ResponsesStreamError", code: err.code, message: err.message };
  return { name: err instanceof Error ? err.name : "Error", code: "", message: err instanceof Error ? err.message : String(err) };
}

/** Runs one scenario through Meta's parser. Never throws: a thrown parser error is the result. */
export async function runScenario(id: ScenarioId): Promise<ScenarioResult> {
  const events = eventsFor(id);
  const result: ScenarioResult = { id, fed: events.map((e) => e.type), snapshots: [] };

  if (id === "invalid_mask") {
    // The first mask of DOC_VIDEO_LINE, cut short: a payload that ends mid-way can't finalize its decoder.
    result.fed = [];
    try {
      decodeMaskToRaster({ encoding: "lossless", width: 60, height: 27, payload: "~!!!!M!0c[0o91w?q1!pIH4" });
    } catch (err) {
      result.error = errorOf(err);
    }
    return result;
  }

  const parsed = parseVideoStream(source(events, id === "source"));
  try {
    if (id === "consumed") {
      for await (const s of parsed) result.snapshots.push({ revision: s.revision, records: s.records.length });
      // A second reader: the parser refuses it, at once or on the first read.
      await parsed[Symbol.asyncIterator]().next();
      return result;
    }
    if (id === "aborted") {
      for await (const s of parsed) {
        result.snapshots.push({ revision: s.revision, records: s.records.length });
        break;
      }
      await parsed.finalResult;
      return result;
    }
    for await (const s of parsed) result.snapshots.push({ revision: s.revision, records: s.records.length });
    const final = await parsed.finalResult;
    result.outcome = final.outcome;
    result.records = final.records.length;
    result.boxes = recordsOfKind(final.records, "box").map((b) => ({
      objectId: b.objectId,
      frame: b.frame?.frameIndex,
      left: b.left,
      top: b.top,
      right: b.right,
      bottom: b.bottom,
      ...(b.confidence !== undefined ? { confidence: b.confidence } : {}),
    }));
    result.diagnostics = final.diagnostics.map((d) => ({ severity: d.severity, code: d.code, message: d.message, line: d.line }));
  } catch (err) {
    result.error = errorOf(err);
    // A rejected finalResult would otherwise surface as an unhandled rejection.
    parsed.finalResult.catch(() => {});
  }
  return result;
}
