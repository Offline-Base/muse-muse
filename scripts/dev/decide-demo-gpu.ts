/**
 * A stand-in for a decision model's demo server (glimmer-serve's POST /decide, docs/DECISION_MODELS.md "On the lab's
 * GPU"), for looking at the Try it live box on a local dev server with no GPU. It is not a model: its scores are made
 * up by rule from the words each option shares with the state (base Glimmer a little sure, the "tuned" side more so),
 * as log-probabilities of the shown letters that hold 80% and 97% of the probability. HTTPS on 127.0.0.1:8443 with a
 * self-signed certificate made by openssl in the folder given, whose SHA-256 it prints for decide-fixtures.ts:
 *
 *   npx tsx scripts/dev/decide-demo-gpu.ts <folder for its certificate>
 *   DEMO_CERT_SHA256=<printed> DATABASE_URL=pglite:.data/decide npx tsx scripts/dev/decide-fixtures.ts
 *
 * It takes any serving key and keeps nothing it is sent. Stop it with Ctrl-C.
 */
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { promptWords } from "@/lib/train/logic";

const folder = process.argv[2];
if (!folder) throw new Error("Pass a folder for the stand-in's certificate.");
const keyPath = join(folder, "demo-gpu.key");
const certPath = join(folder, "demo-gpu.crt");
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"], {
  stdio: "ignore",
});
const cert = readFileSync(certPath, "utf8");
const sha256 = new X509Certificate(cert).fingerprint256.replace(/:/g, "").toLowerCase();

type Item = { messages: Array<{ role: string; content: string }>; letters: string[] };

/** One side's log-probabilities for an item: a softmax of `sharpness` times the shared words, scaled to `mass`. */
function scores(item: Item, sharpness: number, mass: number): number[] {
  const user = item.messages[1]?.content ?? "";
  const task = JSON.parse(user.slice(0, user.indexOf("\n\nHere is the same task again:"))) as {
    state: string;
    options: Array<{ option: string; description?: string }>;
  };
  const words = promptWords(task.state);
  const raw = task.options.map((o) => {
    if (o.option === "None of the listed options matches") return 0.5;
    let shared = 0;
    for (const w of promptWords(`${o.option} ${o.description ?? ""}`)) if (words.has(w)) shared += 1;
    return shared;
  });
  const e = raw.map((x) => Math.exp(sharpness * x));
  const sum = e.reduce((s, x) => s + x, 0);
  return e.map((x) => Math.log((mass * x) / sum));
}

const server = createServer({ key: readFileSync(keyPath, "utf8"), cert }, (req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true, busy: false, mode: "decide", served: 0 });
    if (req.method !== "POST" || req.url !== "/decide") return reply(404, { error: "not_found" });
    try {
      const { items } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { items: Item[] };
      const base = items.map((i) => scores(i, 0.6, 0.8));
      const tuned = items.map((i) => scores(i, 2.2, 0.97));
      setTimeout(() => reply(200, { base, tuned, baseMass: items.map(() => 0.8), tunedMass: items.map(() => 0.97), ms: 640 }), 300);
    } catch {
      reply(400, { error: "bad_json" });
    }
  });
});
server.listen(8443, "127.0.0.1", () => console.log(JSON.stringify({ listening: "127.0.0.1:8443", certSha256: sha256 })));
