/**
 * A tiny product for the outage drills (`npm run drill`): one route that asks for a verdict on a Simulated cold-room
 * window through the product template's own fallback helper, template/lib/meta/edge.ts respondJsonOrEdge(), the same
 * code a product built with EDGE_BUILDS on gets. It is a plain Node server, not a Next build, so the drill needs no
 * build, no key and no network.
 *
 *   POST /api/actions/status  {"rows": "<a Simulated window>"}
 *     200 {verdict, by, label} when the cloud or the backup answered, or 503 {message} with the helper's plain line
 *   POST /api/actions/look    {"photo": "<a JPEG or PNG data URL>", "prompt": "open door"}
 *     through segmentOrEdge(), Meta SAM 3.1 in the cloud, else on the board: 200 {count, objects, by, label}, 503
 *     {message} with the helper's plain "Can't see right now" line, or 400 {message} for a photo it can't read
 *   GET  /api/board-status    the template's own board status check (template/lib/meta/board-status.ts), the route
 *                             template/app/api/board-status/route.ts serves: {connected, line, detail}. ?looks=1 adds
 *                             the photo board. It asks no model.
 *   GET  /samples/door-open.jpg  the invented sample photo (scripts/drill/samples/), standing in for a product's
 *                             public/samples/ file that its "Try the sample" button loads
 *   GET  /                    a small page with the board status line (data-board-status, like components/BoardStatus.tsx)
 *   GET  /health              one plain line, so the drill runner can tell the server is up
 *
 * Env, as a product reads it (scripts/drill/run.mjs and template/scripts/edge-drill.mjs set these on loopback):
 *   PORT, GATEWAY_URL, PRODUCT_TOKEN, EDGE_URL, EDGE_SAM_URL, EDGE_BOARD, EDGE_MODEL_NAME, EDGE_SAM_MODEL_NAME,
 *   EDGE_CLOUD_TIMEOUT_MS, EDGE_TIMEOUT_MS
 *
 * The data is invented. Nothing here is about a real freezer or store, and the product gives no food-safety advice.
 * It prints nothing on a failed answer, so any error line in its output is a real crash the drill should catch.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { boardStatus } from "../../template/lib/meta/board-status";
import { respondJsonOrEdge, segmentOrEdge } from "../../template/lib/meta/edge";

/** The drill bench's verdict (scripts/dev/drill-bench.py, FIELDS, STATUSES and CAUSES). */
export const Verdict = z.object({
  status: z.enum(["normal", "watch", "alert"]),
  trust_controller: z.boolean(),
  likely_cause: z.enum(["none", "door_open", "defrost_stuck", "setpoint_changed", "controller_probe_mismatch", "probe_dropout", "power_gap", "cloud_down"]),
  actions: z.array(z.string().min(3)).min(1),
  escalate: z.boolean(),
});

const INSTRUCTIONS =
  "You watch a Simulated cold room's log. Read the window and answer with the verdict. When the controller and the independent probe differ by more than 3.0 C, never trust the controller. Never give temperatures or food-safety rules as advice.";

/** The filming window from eval/drill: a controller that holds steady while the probe climbs, with the cloud down at the end. */
export function demoRows(): string {
  try {
    return readFileSync(new URL("../../eval/drill/demo-spoofed-controller.csv", import.meta.url), "utf8");
  } catch {
    return "source,record,time,setpoint_c,controller_c,probe_c,door,defrost,power,cloud\nSimulated,1,02:00,-18.0,-18.0,-18.3,shut,off,on,down";
  }
}

/** The invented sample photo, a drawing of an open cold-room door. No real place or person. */
const SAMPLE_PHOTO = new URL("./samples/door-open.jpg", import.meta.url);

/**
 * The page with the board status line. Like components/BoardStatus.tsx, it starts at "checking" and asks
 * /api/board-status from the browser, so loading the page asks no model and no board.
 */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Simulated cold room drill product</title></head>
<body>
<p>Simulated cold room drill product, invented data. POST /api/actions/status, POST /api/actions/look.</p>
<div role="status" aria-live="polite" data-board-status="checking"><span id="line">Checking for a board</span></div>
<img src="/samples/door-open.jpg" alt="Invented sample photo: an open cold-room door" width="320" height="240">
<script>
fetch("/api/board-status?looks=1", { cache: "no-store" })
  .then((r) => r.json())
  .then((s) => {
    const el = document.querySelector("[data-board-status]");
    el.dataset.boardStatus = s.connected ? "connected" : "not-connected";
    document.getElementById("line").textContent = s.line;
  })
  .catch(() => { document.getElementById("line").textContent = "Not connected to a board"; });
</script>
</body></html>
`;

async function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function startDemoProduct(port: number) {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Simulated cold room drill product. POST /api/actions/status, POST /api/actions/look\n");
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/board-status") {
      const status = await boardStatus({ looks: url.searchParams.get("looks") === "1" });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(status));
      return;
    }
    if (req.method === "GET" && url.pathname === "/samples/door-open.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(readFileSync(SAMPLE_PHOTO));
      return;
    }
    if (req.method === "POST" && req.url === "/api/actions/look") {
      const body = await readBody(req);
      const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt : "open door";
      const seen = await segmentOrEdge({ image: typeof body.photo === "string" ? body.photo : "", prompt });
      if (seen.ok) return send(200, { count: seen.count, objects: seen.objects, by: seen.by, label: seen.label });
      return send(seen.reasons.cloud.kind === "input" ? 400 : 503, { message: seen.message });
    }
    if (req.method !== "POST" || req.url !== "/api/actions/status") return send(404, { message: "Not here." });
    const body = await readBody(req);
    const rows = typeof body.rows === "string" && body.rows.trim() ? body.rows : demoRows();
    const answer = await respondJsonOrEdge({ schema: Verdict, schemaName: "drill_verdict", instructions: INSTRUCTIONS, input: `Simulated cold-room log, invented data.\n${rows}`, maxOutputTokens: 600 });
    if (answer.ok) return send(200, { verdict: answer.data, by: answer.by, label: answer.label });
    return send(503, { message: answer.message });
  });
  return new Promise<typeof server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3101);
  startDemoProduct(port).then(
    () => console.log(`Simulated drill product on http://127.0.0.1:${port}`),
    (err: Error) => {
      console.log(`demo-product: couldn't listen on ${port}: ${err.message}`);
      process.exit(2);
    },
  );
  const stop = () => process.exit(0);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
