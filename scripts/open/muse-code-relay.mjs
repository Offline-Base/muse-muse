// Runs Muse Code on Muse Spark Open, Meta's open-weight model, served by a partner (Baseten by default, or Fireworks).
//
// Muse Code asks its endpoint for a model catalog at GET /muse-code/models, then posts to /responses. Partners don't
// serve the catalog, so this relay answers that one request with a single Spark Open entry and forwards every other
// request to the partner's OpenAI-compatible /v1 API unchanged, Authorization header included. It never logs headers
// or bodies, only method, path, status and size.
//
//   node scripts/open/muse-code-relay.mjs [port]            # SPARK_OPEN_PROVIDER=baseten (default) or fireworks
//
// Then give Muse Code a settings file that points at it and pins bearer auth (a --base-url flag alone is refused):
//   {"schema_version":1,"endpoint_transport":{"base_url":"http://127.0.0.1:18791","auth":"bearer"}}
// and run, with the partner's key on stdin:
//   muse exec --api-key-stdin --model meta-models/muse-spark-open --json --yolo "<task>"
// Steps measured Nov 2, 2026: docs/BUILD_LOG.md, "Muse Code runs on Muse Spark Open".
import http from "node:http";

const PROVIDERS = {
  baseten: { upstream: "https://inference.baseten.co", model: "meta-models/muse-spark-open" },
  fireworks: { upstream: "https://api.fireworks.ai/inference", model: "accounts/fireworks/models/muse-spark-open" },
};
const provider = PROVIDERS[process.env.SPARK_OPEN_PROVIDER || "baseten"];
if (!provider) throw new Error("SPARK_OPEN_PROVIDER must be baseten or fireworks");
const PORT = Number(process.argv[2] || 18791);

const catalog = {
  object: "list",
  data: [{
    id: provider.model, object: "model", created: 1792022400, owned_by: "meta",
    metadata: { "muse-code": {
      name: "muse-spark-open", family: "muse-spark-open", release_date: "2026-10-15", is_hidden: false,
      attachment: false, reasoning: false, temperature: true, tool_call: true,
      modalities: { input: ["text"], output: ["text"] }, limit: { context: 1048576, output: 32768 },
      options: {}, description: "Muse Spark Open, served by a partner", variants: {},
      cost: { currency: "USD", input: "0", output: "0", cached: "0" },
    } },
  }],
};

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.method === "GET" && req.url.startsWith("/muse-code/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(catalog));
    return;
  }
  const path = req.url.startsWith("/v1/") ? req.url : "/v1" + req.url;
  const headers = { "content-type": req.headers["content-type"] || "application/json", accept: req.headers.accept || "*/*" };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  try {
    const r = await fetch(provider.upstream + path, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    console.log(req.method, path, r.status, `${body.length} B in`);
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" });
    if (!r.body) return res.end();
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    console.log(req.method, path, "relay error", String(err).slice(0, 200));
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "The relay couldn't reach the partner." } }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`relay on 127.0.0.1:${PORT}, ${process.env.SPARK_OPEN_PROVIDER || "baseten"}`));
