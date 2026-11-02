/**
 * A tiny product for the outage drills (`npm run drill`): one route that asks for a verdict on a Simulated cold-room
 * window through the product template's own fallback helper, template/lib/meta/edge.ts respondJsonOrEdge(), the same
 * code a product built with EDGE_BUILDS on gets. It is a plain Node server, not a Next build, so the drill needs no
 * build, no key and no network.
 *
 *   POST /api/actions/status  {"rows": "<a Simulated window>"}
 *     200 {verdict, by, label} when the cloud or the backup answered, or 503 {message} with the helper's plain line
 *   GET  /                    a one-line page, so the drill runner can tell the server is up
 *
 * Env, as a product reads it (scripts/drill/run.mjs and template/scripts/edge-drill.mjs set these on loopback):
 *   PORT, GATEWAY_URL, PRODUCT_TOKEN, EDGE_URL, EDGE_BOARD, EDGE_MODEL_NAME, EDGE_CLOUD_TIMEOUT_MS, EDGE_TIMEOUT_MS
 *
 * The data is invented. Nothing here is about a real freezer or store, and the product gives no food-safety advice.
 * It prints nothing on a failed answer, so any error line in its output is a real crash the drill should catch.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { respondJsonOrEdge } from "../../template/lib/meta/edge";

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
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Simulated cold room drill product. POST /api/actions/status\n");
      return;
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
