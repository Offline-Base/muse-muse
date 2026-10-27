import type { VerifySummary } from "@/lib/types";

/**
 * Pure helpers for what the sandbox produces: verify.mjs's summary line, judge screenshot captions, and the demo
 * video's caption timeline and ffmpeg filter graph. No SDK calls here, so they are easy to test.
 */

export const VERIFY_FAILURE_MAX = 6000;

interface RawVerifySummary {
  musemuse_verify: 1;
  passed: boolean;
  steps?: Array<{ name?: unknown; ok?: unknown; ms?: unknown; detail?: unknown }>;
  failure?: unknown;
}

/**
 * Finds the summary verify.mjs prints as the last line of stdout:
 * {"musemuse_verify":1,"passed":boolean,"steps":[{name,ok,ms,detail}],"failure":"..."}.
 * Scans from the end so trailing noise doesn't hide it. Null when there is none.
 */
export function parseVerifySummary(stdout: string): VerifySummary | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{") || !line.includes("musemuse_verify")) continue;
    let raw: RawVerifySummary;
    try {
      raw = JSON.parse(line) as RawVerifySummary;
    } catch {
      continue;
    }
    if (raw?.musemuse_verify !== 1 || typeof raw.passed !== "boolean") continue;
    const steps = (Array.isArray(raw.steps) ? raw.steps : []).map((s) => ({
      name: typeof s.name === "string" ? s.name : "step",
      ok: s.ok === true,
      ...(typeof s.ms === "number" ? { ms: s.ms } : {}),
      ...(typeof s.detail === "string" && s.detail ? { detail: s.detail } : {}),
    }));
    const failure = typeof raw.failure === "string" ? raw.failure : "";
    return { passed: raw.passed, steps, failureOutput: failure.slice(-VERIFY_FAILURE_MAX) };
  }
  return null;
}

/**
 * Combines the parsed summary (if any) with the command's exit code. A missing summary falls back to the exit code;
 * a summary that says passed while the command failed counts as a failure.
 */
export function verifyOutcome(parsed: VerifySummary | null, exitCode: number | null, outputTail: string): VerifySummary {
  const tail = outputTail.trim().slice(-VERIFY_FAILURE_MAX);
  if (parsed) {
    if (parsed.passed && exitCode !== null && exitCode !== 0) {
      return { ...parsed, passed: false, failureOutput: `verify reported passed but exited with code ${exitCode}.\n${tail}`.slice(-VERIFY_FAILURE_MAX) };
    }
    if (!parsed.passed && !parsed.failureOutput) return { ...parsed, failureOutput: tail };
    return parsed;
  }
  const passed = exitCode === 0;
  return {
    passed,
    steps: [],
    failureOutput: passed
      ? ""
      : `npm run verify ${exitCode === null ? "did not finish" : `exited with code ${exitCode}`} without a summary line.\n${tail}`.slice(-VERIFY_FAILURE_MAX),
  };
}

/** "01-start.png" -> "Start", "03_upload-the-photo.png" -> "Upload the photo". */
export function captionFromFileName(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, "").replace(/^[\d]+[-_. ]*/, "").replace(/[-_]+/g, " ").trim();
  return base ? base[0].toUpperCase() + base.slice(1) : name;
}

/** Wraps text to lines of at most `width` characters, breaking at spaces. At most `maxLines` lines. */
export function wrapText(text: string, width: number, maxLines = 3): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, width - 1)}…`;
    return kept.join("\n");
  }
  return lines.join("\n");
}

// Playwright's JSON reporter, only the fields used here.
interface JsonStep {
  title: string;
  duration: number;
}
interface JsonResult {
  startTime?: string;
  duration?: number;
  status?: string;
  steps?: JsonStep[];
  attachments?: Array<{ name: string; path?: string; contentType?: string }>;
}
interface JsonTest {
  projectName?: string;
  results?: JsonResult[];
}
interface JsonSpec {
  title?: string;
  tests?: JsonTest[];
}
interface JsonSuite {
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

export interface DemoRun {
  /** Absolute path of the recorded WebM, from the result's video attachment. */
  videoPath: string | null;
  status: string;
  /** Top-level test.step titles and durations in ms, in order. */
  steps: JsonStep[];
}

/** Finds the demo project's last result in test-results/report.json. */
export function demoRunFromReport(reportJson: string, project = "demo"): DemoRun | null {
  let report: { suites?: JsonSuite[] };
  try {
    report = JSON.parse(reportJson) as { suites?: JsonSuite[] };
  } catch {
    return null;
  }
  const runs: DemoRun[] = [];
  const visit = (suite: JsonSuite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.projectName !== project) continue;
        const r = t.results?.[t.results.length - 1];
        if (!r) continue;
        const video = r.attachments?.find((a) => a.name === "video" && a.path);
        runs.push({
          videoPath: video?.path ?? null,
          status: r.status ?? "unknown",
          steps: (r.steps ?? []).filter((s) => typeof s.title === "string").map((s) => ({ title: s.title, duration: Number(s.duration) || 0 })),
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const s of report.suites ?? []) visit(s);
  return runs.find((r) => r.videoPath) ?? runs[0] ?? null;
}

export interface Caption {
  text: string;
  start: number;
  end: number;
}

/**
 * Caption timeline in seconds on the recording's own clock. The recording starts when the page opens, right before
 * the first step, so steps are laid end to end from zero. Each caption stays up until the next one starts, and the
 * last one until the video ends.
 */
export function captionTimeline(steps: JsonStep[], videoSeconds: number): Caption[] {
  const out: Caption[] = [];
  let t = 0;
  for (const s of steps) {
    const title = s.title.trim();
    if (title && t < videoSeconds) out.push({ text: title, start: t, end: videoSeconds });
    t += Math.max(0, s.duration) / 1000;
  }
  for (let i = 0; i < out.length - 1; i++) out[i].end = out[i + 1].start;
  return out.filter((c) => c.end - c.start >= 0.05);
}

export const DEMO = { width: 1280, height: 720, fps: 30, titleSeconds: 2.5, background: "0x0f1115" } as const;

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

export interface TextBlock {
  /** One file per line. drawtext in ffmpeg 8 draws a newline as a missing-glyph box, so lines are drawn one by one. */
  lineFiles: string[];
}

/**
 * ffmpeg filter graph: input 0 is the title card's color source, input 1 the recording. Text comes from files
 * (textfile=..., expansion=none), so nothing in a title or caption needs escaping. Every line is centered on its own.
 */
export function demoFilterGraph(opts: {
  title: TextBlock;
  subtitle: TextBlock;
  footerFile: string;
  captions: Array<TextBlock & { start: number; end: number }>;
}): string {
  const { width: W, height: H, fps, background } = DEMO;
  const text = (font: string, file: string, size: number, color: string, y: number, extra = "") =>
    `drawtext=fontfile=${font}:textfile=${file}:expansion=none:fontsize=${size}:fontcolor=${color}:x=(w-text_w)/2:y=${y}${extra}`;

  const titleTop = 240;
  const titleLine = 78;
  const subtitleTop = titleTop + opts.title.lineFiles.length * titleLine + 34;
  const card = [
    `[0:v]format=yuv420p`,
    `drawbox=x=${(W - 120) / 2}:y=${titleTop - 28}:w=120:h=6:color=0x0064e0:t=fill`,
    ...opts.title.lineFiles.map((f, i) => text(FONT_BOLD, f, 64, "white", titleTop + i * titleLine)),
    ...opts.subtitle.lineFiles.map((f, i) => text(FONT, f, 30, "0xc9ced6", subtitleTop + i * 44)),
    text(FONT, opts.footerFile, 22, "0x8a93a0", H - 70),
    `setsar=1[card]`,
  ].join(",");

  const captionLine = 48;
  const captions = opts.captions.flatMap((c) =>
    c.lineFiles.map((f, i) =>
      text(
        FONT,
        f,
        30,
        "white",
        H - 64 - (c.lineFiles.length - i) * captionLine + 16,
        `:box=1:boxcolor=black@0.62:boxborderw=12:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'`,
      ),
    ),
  );
  const rec = [
    `[1:v]scale=${W}:${H}:force_original_aspect_ratio=decrease`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${background}`,
    `fps=${fps}`,
    `format=yuv420p`,
    ...captions,
    `setsar=1[rec]`,
  ].join(",");
  return `${card};\n${rec};\n[card][rec]concat=n=2:v=1:a=0,format=yuv420p[v]`;
}
