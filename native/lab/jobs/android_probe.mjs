// A one-time check on the first Android run: does window.MuseNative exist when a page's first inline script runs?
// react-native-webview injects the shim from onPageStarted, which is asynchronous, and the selftest's handshake runs after
// load, so a normal check can't see this. So the lab serves its own page to the lab shell, and that page's head script
// records what it saw in document.title, which comes back in the shell's health report. It never affects the job's verdict.
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { adbAmStart, adbForceStop, adbLogcatClear, adbLogcatDump, selftestFromLogcat } from "../lib/commands.mjs";
import { waitFor } from "./common.mjs";

/** Written once the lab has an answer, so each box asks once. */
export const PROBE_FILE = "android-bridge-timing.json";
const TITLE = "muse-bridge-timing ";
/** Cold start, load, and the selftest's 8 s scroll. */
const PROBE_WAIT_MS = 45_000;
/** The job needs this much of its time limit after the probe, for the recording and the report. */
const KEEP_FOR_JOB_MS = 240_000;
const MAX_BODY_BYTES = 256_000;
/** The emulator's name for the machine it runs on. */
const HOST_FROM_EMULATOR = "10.0.2.2";

/** The page. Its first script goes before anything else, and keeps looking until the bridge shows up. */
export function probePage() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${TITLE}{}</title>
<script>
(function () {
  var started = Date.now();
  var inHead = !!window.MuseNative;
  function note(seenMs) {
    document.title = ${JSON.stringify(TITLE)} + JSON.stringify({ inHead: inHead, seenMs: seenMs });
  }
  note(inHead ? 0 : null);
  if (inHead) return;
  (function look() {
    if (window.MuseNative) return note(Date.now() - started);
    if (Date.now() - started < 30000) setTimeout(look, 5);
  })();
})();
</script>
</head>
<body><h1>Bridge timing</h1><p>The device lab uses this page to see when the app's bridge shows up.</p></body>
</html>
`;
}

/** What the page saw, from a health report's title. Null when the report didn't come from the page's script. */
export function probeFromReport(report) {
  const title = typeof report?.title === "string" ? report.title : "";
  if (!title.startsWith(TITLE)) return null;
  try {
    const { inHead, seenMs } = JSON.parse(title.slice(TITLE.length));
    return typeof inHead === "boolean" ? { inHead, seenMs: typeof seenMs === "number" ? seenMs : null } : null;
  } catch {
    return null;
  }
}

/** The sentence for the job's checks. */
export function probeNote(seen) {
  if (!seen) return "The Android bridge timing check got no answer, so it runs again on the next Android check.";
  if (seen.inHead) return "Android bridge timing: window.MuseNative was there when the page's first script ran.";
  return seen.seenMs === null
    ? "Android bridge timing: window.MuseNative wasn't there when the page's first script ran, and hadn't shown up when the page reported."
    : `Android bridge timing: window.MuseNative wasn't there when the page's first script ran. It showed up ${seen.seenMs} ms later.`;
}

/** Serves the page, and takes the report the shell posts. Only this machine can reach it. */
async function serveProbe() {
  let report = null;
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/native/selftest") {
      const chunks = [];
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          // Then the device log has it, or there's no answer.
        }
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(probePage());
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    report: () => report,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * Runs the probe if this box has no answer yet, a lab shell is installed and the job has the time. Any failure is only a
 * note. An abort still ends the job.
 *
 * @param {object} ctx
 * @param {{ serial: string, component: string, pkg: string, jobStartedMs: number }} target
 * @returns {Promise<{ id: string, ok: null, detail: string } | null>} the note for the job's checks
 */
export async function runProbeOnce(ctx, { serial, component, pkg, jobStartedMs }) {
  const file = path.join(ctx.config.dataDir, PROBE_FILE);
  if (ctx.input.app.variant !== "lab" || existsSync(file)) return null;
  if (ctx.now() - jobStartedMs > ctx.input.limitSeconds * 1000 - KEEP_FOR_JOB_MS) {
    ctx.logLine("The Android bridge timing check waits for the next job: this one is short of time.");
    return null;
  }

  ctx.setPhase("probe");
  let seen = null;
  let probe = null;
  try {
    probe = await serveProbe();
    const origin = `http://${HOST_FROM_EMULATOR}:${probe.port}`;
    await ctx.exec(adbLogcatClear(serial), { timeoutMs: 15_000 });
    await ctx.exec(adbAmStart(serial, component, { url: `${origin}/`, selftest: { platformUrl: origin }, variant: "lab" }), { timeoutMs: 60_000 });
    const report = await waitFor(
      ctx,
      async () => probe.report() ?? selftestFromLogcat(String((await ctx.exec(adbLogcatDump(serial), { timeoutMs: 20_000 })).stdout)),
      { timeoutMs: PROBE_WAIT_MS, everyMs: 1000 },
    );
    seen = probeFromReport(report);
    await ctx.exec(adbForceStop(serial, pkg), { timeoutMs: 15_000 });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.logLine(`The Android bridge timing check failed: ${String(err?.message ?? err)}`);
  } finally {
    probe?.close();
  }

  const detail = probeNote(seen);
  ctx.logLine(detail);
  if (seen) await writeFile(file, `${JSON.stringify({ ...seen, at: new Date(ctx.now()).toISOString(), detail })}\n`).catch(() => {});
  return { id: "bridge_timing", ok: null, detail };
}
