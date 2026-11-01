/**
 * Test harness for the glimmer-quantize recipe on a rented GPU, with no platform: the real RUNNER_PY and QUANT_PY against a
 * small stand-in for the callback routes on the GPU itself (publish 0, so nothing leaves the machine). It proves the merge,
 * the files and their checks. It doesn't prove launch, callbacks over https or the Hub steps. Made-up data only.
 *
 *   npx tsx scripts/dev/quant-harness.ts <outDir> <paramsJson> <title> <train.json> <eval.json> <maxMinutes> <cacheDir>
 *
 * train.json and eval.json are as scripts/dev/tune-harness.ts writes them. eval rows may carry the adapter's own "tuned" answers.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QUANT_PY } from "@/lib/train/recipes/quantize";
import { RUNNER_PY } from "@/lib/train/recipes/runner";

const STUB_PY = String.raw`import json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
HERE = os.path.dirname(os.path.abspath(__file__))
data = {p: json.load(open(os.path.join(HERE, p + ".json"))) for p in ("train", "eval")}
title = json.load(open(os.path.join(HERE, "dataset.json")))["title"]
PAGE = 100
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def reply(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path.endswith("/dataset"):
            part, page = q["part"][0], int(q["page"][0])
            more = (page + 1) * PAGE < len(data[part])
            return self.reply(200, {"title": title, "items": data[part][page * PAGE:(page + 1) * PAGE], "nextPage": page + 1 if more else None})
        self.reply(404, {"error": "not_found"})
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        if self.path.endswith("/events"):
            with open(os.path.join(HERE, "events.jsonl"), "ab") as f:
                f.write(raw.replace(b"\n", b" ") + b"\n")
            return self.reply(200, {"ok": True})
        self.reply(503, {"error": "no_storage"})
ThreadingHTTPServer(("127.0.0.1", 8099), H).serve_forever()
`;

const [out, paramsJson, title, trainPath, evalPath, maxMinutes, cacheDir] = process.argv.slice(2);
if (!out || !paramsJson || !title || !trainPath || !evalPath || !maxMinutes || !cacheDir) throw new Error("See the usage at the top of this file");
mkdirSync(out, { recursive: true });
const jobId = randomUUID();
writeFileSync(
  join(out, "job.json"),
  JSON.stringify({
    jobId,
    callbackBase: `http://127.0.0.1:8099/api/train/jobs/${jobId}`,
    token: randomBytes(32).toString("base64url"),
    params: { publish: 0, ...JSON.parse(paramsJson) },
    maxMinutes: Number(maxMinutes),
    recipe: "glimmer-quantize",
    deadlineEpoch: Math.floor(Date.now() / 1000) + Number(maxMinutes) * 60,
    cacheDir,
  }),
);
writeFileSync(join(out, "runner.py"), RUNNER_PY);
writeFileSync(join(out, "recipe.py"), QUANT_PY);
writeFileSync(join(out, "stub.py"), STUB_PY);
writeFileSync(join(out, "dataset.json"), JSON.stringify({ title }));
copyFileSync(trainPath, join(out, "train.json"));
copyFileSync(evalPath, join(out, "eval.json"));
console.log(jobId);
