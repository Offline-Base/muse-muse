#!/usr/bin/env node
// The simulated board (docs/BOARD_LOOP.md): a real, tiny process that answers the small part of the fleet control plane's
// API the board loop uses (~/jetson-infra/docs/api.md), so the fleet driver's own code runs against it. It serves canned
// text. It holds no model, runs no llama.cpp, and never executes a command it is sent: an "exec" job only reads which of the
// loop's three commands it is and pretends. Every reply says simulated. Listens on 127.0.0.1 only, behind a bearer token,
// and exits by itself after SIM_BOARD_IDLE_S with no calls. No dependencies.
//   SIM_BOARD_TOKEN=... node scripts/sim-board.mjs      prints {"port":N} on its first line
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const TOKEN = process.env.SIM_BOARD_TOKEN ?? "";
if (TOKEN.length < 16) {
  console.error("sim-board: SIM_BOARD_TOKEN must be at least 16 characters.");
  process.exit(2);
}
const IDLE_MS = Number(process.env.SIM_BOARD_IDLE_S || 1800) * 1000;
const TOKENS_PER_SECOND = Number(process.env.SIM_BOARD_TPS || 40);
const JOB_MS = Number(process.env.SIM_BOARD_JOB_MS || 400);
/** Which command fails, for tests: install, serve, or nothing. */
const FAIL = process.env.SIM_BOARD_FAIL || "";
const NODE_ID = "nd_simulated";
const NODE_NAME = "simulated-board";

const CANNED = [
  "This is the simulated board, so this is canned text and not a model. On a real board the tuned model would answer here.",
  "Canned text from the simulated board: no model is running. It lets the loop test sending, serving, queueing and limits.",
  "The simulated board always says something like this. It proves the plumbing around a model, and nothing about a model.",
];

const jobs = new Map();
/** The name the loop serves, once its serve command has finished. */
let served = null;
let chats = 0;
let idleTimer = null;

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), IDLE_MS);
  idleTimer.unref?.();
}

function metrics() {
  // Real numbers, for this small process and not for any board.
  const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
  return { mem: { used_mb: rss, total_mb: 8192 }, temps_c: {}, power_mw: {}, llm: { inflight: chats, tokens_per_s: null } };
}

function nodeSummary() {
  return {
    id: NODE_ID,
    name: NODE_NAME,
    status: "online",
    maintenance: false,
    pool: null,
    labels: { simulated: "true" },
    facts: { hostname: NODE_NAME, model: "Simulated board (not a Jetson)" },
    capabilities: ["exec"],
    metrics: metrics(),
    metrics_ts: Date.now() / 1000,
    loaded_models: served ? [served] : [],
    simulated: true,
  };
}

/** Which of the loop's commands this is, by the unit name each one carries. Nothing is ever run. */
function commandKind(command) {
  const match = /\bmm-board-(install|serve|stop)\b/.exec(String(command));
  return match ? match[1] : null;
}

function startJob(action, params) {
  const kind = action === "exec" ? commandKind(params?.command) : null;
  const id = `jb_${randomUUID().slice(0, 12)}`;
  const known = kind !== null;
  const job = {
    id,
    action,
    params: { simulated: true },
    created_by: "simulated",
    created_at: Date.now() / 1000,
    status: "running",
    tasks: [{ id: `tk_${id}`, node_id: NODE_ID, node_name: NODE_NAME, status: "running", output: "", result: null, error: null, started_at: Date.now() / 1000, finished_at: null }],
  };
  jobs.set(id, job);
  setTimeout(() => {
    const failed = !known || FAIL === kind;
    const [task] = job.tasks;
    job.status = failed ? "failed" : "succeeded";
    task.status = failed ? "failed" : "succeeded";
    task.finished_at = Date.now() / 1000;
    task.error = known ? (failed ? `simulated failure of ${kind}` : null) : "the simulated board only knows the board loop's commands";
    task.result = { exit_code: failed ? 1 : 0, output: `simulated ${kind ?? "nothing"}: nothing was run` };
    task.output = task.result.output;
    if (!failed && kind === "serve") served = /--alias\s+'?([^'\s]+)'?/.exec(String(params.command))?.[1] ?? null;
    if (!failed && kind === "stop") served = null;
  }, JOB_MS);
  return job;
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "x-simulated-board": "1" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (part) => {
      text += part;
      if (text.length > 256 * 1024) reject(new Error("too large"));
    });
    req.on("end", () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function chat(req, res, body) {
  if (!served || body.model !== served) {
    return send(res, 503, { error: { message: "No board has this model.", type: "no_capacity" }, simulated: true });
  }
  const words = CANNED[chats++ % CANNED.length].split(" ").map((w, i) => (i ? ` ${w}` : w));
  const parts = words.slice(0, Math.max(1, Math.min(words.length, Number(body.max_tokens) || words.length)));
  const usage = { prompt_tokens: 0, completion_tokens: parts.length, total_tokens: parts.length };
  const delay = 1000 / TOKENS_PER_SECOND;
  if (!body.stream) {
    await pause(delay * parts.length);
    return send(res, 200, { simulated: true, model: served, choices: [{ message: { role: "assistant", content: parts.join("") }, finish_reason: "stop" }], usage });
  }
  res.writeHead(200, { "content-type": "text/event-stream", "x-simulated-board": "1", "x-jcp-node": NODE_ID });
  for (const part of parts) {
    await pause(delay);
    res.write(`data: ${JSON.stringify({ simulated: true, choices: [{ delta: { content: part }, finish_reason: null }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ simulated: true, choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function authorized(req) {
  const given = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

const server = createServer(async (req, res) => {
  touch();
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/^\/admin/, "");
  try {
    if (path === "/healthz") return send(res, 200, { ok: true, simulated: true });
    if (!authorized(req)) return send(res, 401, { detail: "Not authenticated." });
    if (req.method === "GET" && path === "/api/nodes") return send(res, 200, [nodeSummary()]);
    if (req.method === "PATCH" && path === `/api/nodes/${NODE_ID}`) return send(res, 200, nodeSummary());
    if (req.method === "POST" && path === `/api/nodes/${NODE_ID}/actions`) {
      const body = await readBody(req);
      return send(res, 200, startJob(body.action, body.params));
    }
    const job = /^\/api\/jobs\/([\w-]+)$/.exec(path);
    if (req.method === "GET" && job) {
      const found = jobs.get(job[1]);
      return found ? send(res, 200, found) : send(res, 404, { detail: "No such job." });
    }
    if (req.method === "POST" && path === "/v1/chat/completions") return await chat(req, res, await readBody(req));
    return send(res, 404, { detail: "The simulated board doesn't have this." });
  } catch (err) {
    if (!res.headersSent) send(res, 400, { detail: String(err?.message ?? err) });
    else res.destroy();
  }
});

touch();
server.listen(Number(process.env.SIM_BOARD_PORT || 0), "127.0.0.1", () => {
  console.log(JSON.stringify({ port: server.address().port, simulated: true }));
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
