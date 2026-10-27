// Proves the product template in a real Vercel Sandbox (the builder environment).
//   (a) bare template: npm ci + npm run verify (open egress, no model calls)
//   (b) template + an example product overlay: npm run verify with the brokered Meta key, real model calls
// Usage: npx tsx --env-file=.env.local scripts/dev/template-prove.ts [bare|product|all] [overlayDir] [outDir]
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { Sandbox } from "@vercel/sandbox";

const mode = process.argv[2] ?? "all";
const overlayDir = process.argv[3];
const outDir = process.argv[4] ?? path.resolve("scripts/dev/out");
const TEMPLATE = path.resolve(import.meta.dirname, "../../template");
const SKIP = new Set(["node_modules", ".next", "test-results", "playwright-report", "next-env.d.ts"]);
const timings: Record<string, number> = {};

function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(root, rel))) {
    if (SKIP.has(name) || name.endsWith(".tsbuildinfo") || name === ".DS_Store" || name.startsWith(".env")) continue;
    const r = path.join(rel, name);
    if (statSync(path.join(root, r)).isDirectory()) out.push(...listFiles(root, r));
    else out.push(r);
  }
  return out;
}

function filesFor(dest: string, ...roots: string[]) {
  const map = new Map<string, Buffer>();
  for (const root of roots) for (const rel of listFiles(root)) map.set(`${dest}/${rel}`, readFileSync(path.join(root, rel)));
  return [...map].map(([p, content]) => ({ path: p, content }));
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    timings[label] = Date.now() - t0;
    console.log(`[time] ${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}

async function sh(sandbox: Sandbox, script: string, opts: { cwd?: string; sudo?: boolean; env?: Record<string, string>; quiet?: boolean } = {}) {
  let out = "";
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString();
      if (!opts.quiet) process.stdout.write(chunk);
      cb();
    },
  });
  const cmd = await sandbox.runCommand({ cmd: "bash", args: ["-lc", script], cwd: opts.cwd, sudo: opts.sudo, env: opts.env, stdout: sink, stderr: sink });
  return { code: cmd.exitCode, out };
}

function lastJsonLine(out: string): unknown {
  const lines = out.trim().split("\n");
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

mkdirSync(outDir, { recursive: true });
const sandbox = await timed("create", () => Sandbox.create({ resources: { vcpus: 4 }, timeout: 40 * 60_000 }));
console.log("sandbox", sandbox.name);
const results: Record<string, unknown> = {};
try {
  await sh(sandbox, "node -v && npm -v && cat /etc/os-release | head -2");
  await timed("apt ffmpeg espeak-ng", () => sh(sandbox, "apt-get update -q >/dev/null && apt-get install -y -q ffmpeg espeak-ng >/dev/null && ffmpeg -version | head -1 && espeak-ng --version", { sudo: true }));
  await timed("playwright install-deps", () => sh(sandbox, "npx -y playwright@1.64.1 install-deps chromium >/dev/null && echo deps ok", { sudo: true }));

  if (mode === "bare" || mode === "all") {
    await sandbox.mkDir("/vercel/bare").catch(() => undefined);
    await timed("bare: write files", () => sandbox.writeFiles(filesFor("/vercel/bare", TEMPLATE)));
    await timed("bare: npm ci", () => sh(sandbox, "npm ci --no-audit --no-fund 2>&1 | tail -3", { cwd: "/vercel/bare" }));
    await timed("bare: playwright install chromium", () => sh(sandbox, "npx playwright install chromium 2>&1 | tail -2", { cwd: "/vercel/bare" }));
    const bare = await timed("bare: npm run verify", () => sh(sandbox, "npm run verify", { cwd: "/vercel/bare" }));
    results.bare = { exitCode: bare.code, summary: lastJsonLine(bare.out) };
    writeFileSync(path.join(outDir, "bare-verify.log"), bare.out);
  }

  if ((mode === "product" || mode === "all") && overlayDir) {
    const dir = "/vercel/product";
    await sandbox.mkDir(dir).catch(() => undefined);
    await timed("product: write files", () => sandbox.writeFiles(filesFor(dir, TEMPLATE, path.resolve(overlayDir))));
    await timed("product: npm ci", () => sh(sandbox, "npm ci --no-audit --no-fund 2>&1 | tail -3", { cwd: dir }));
    await sh(sandbox, "npx playwright install chromium 2>&1 | tail -2", { cwd: dir });
    // Speech fixtures, made the way AGENTS.md tells Muse Code to.
    await timed("product: speech fixtures", () =>
      sh(
        sandbox,
        [
          'espeak-ng -w /tmp/note-raw.wav "Three sparrows were at the feeder this morning, and one flew off toward the oak tree."',
          "ffmpeg -y -loglevel error -i /tmp/note-raw.wav -ar 16000 -ac 1 fixtures/note.wav",
          "ffmpeg -y -loglevel error -i fixtures/note.wav -c:a libopus -b:a 32k fixtures/note.webm",
          "ls -la fixtures",
        ].join(" && "),
        { cwd: dir },
      ),
    );
    await sandbox.writeFiles([{ path: `${dir}/.env.local`, content: Buffer.from("GATEWAY_URL=https://api.meta.ai\nPRODUCT_TOKEN=brokered\n") }]);
    const key = process.env.MODEL_API_KEY;
    if (!key) throw new Error("MODEL_API_KEY missing");
    await sandbox.updateNetworkPolicy({
      allow: {
        "api.meta.ai": [{ transform: [{ headers: { Authorization: `Bearer ${key}` } }] }],
        "registry.npmjs.org": [],
      },
    });
    const dns = await sh(sandbox, "curl -s -m 5 -o /dev/null -w '%{http_code}' https://example.com || echo blocked", { quiet: true });
    console.log("example.com under build policy:", dns.out.trim());

    // transcribeFile multipart path, called directly from Node (type stripping) with the brokered key.
    const direct = await timed("product: transcribeFile direct", () =>
      sh(
        sandbox,
        `node --input-type=module -e "import { readFileSync } from 'node:fs'; const { transcribeFile } = await import('./lib/meta/voice.ts'); const t0 = Date.now(); const r = await transcribeFile({ bytes: readFileSync('fixtures/note.wav') }); console.log(JSON.stringify({ ...r, ms: Date.now() - t0 }));"`,
        { cwd: dir, env: { GATEWAY_URL: "https://api.meta.ai", PRODUCT_TOKEN: "brokered" } },
      ),
    );
    results.transcribeDirect = { exitCode: direct.code, out: direct.out.trim().split("\n").pop() };

    const product = await timed("product: npm run verify", () => sh(sandbox, "npm run verify", { cwd: dir }));
    results.product = { exitCode: product.code, summary: lastJsonLine(product.out) };
    writeFileSync(path.join(outDir, "product-verify.log"), product.out);
    const shots = await sh(sandbox, "ls test-results/judge", { cwd: dir, quiet: true });
    for (const name of shots.out.split("\n").map((s) => s.trim()).filter((s) => s.endsWith(".png"))) {
      const buf = await sandbox.readFileToBuffer({ path: `${dir}/test-results/judge/${name}` });
      if (buf) writeFileSync(path.join(outDir, name), buf);
    }
    // The upload proxy: with GATEWAY_URL=https://api.meta.ai there is no /uploads upstream, so this only shows that
    // the route forwards the body and passes the upstream status and body through unchanged.
    const proxy = await sh(
      sandbox,
      `(npx next start -p 3200 >/tmp/up.log 2>&1 &) ; for i in $(seq 1 30); do curl -s -o /dev/null localhost:3200 && break; sleep 0.5; done; ` +
        `curl -s -w '\\nstatus=%{http_code}\\n' -X POST localhost:3200/api/upload -H 'content-type: application/json' ` +
        `-d '{"type":"blob.generate-client-token","payload":{"pathname":"uploads/x.wav","clientPayload":null,"multipart":false}}' | tail -c 300; ` +
        `curl -s -o /dev/null -w 'upstream direct=%{http_code}\\n' -X POST https://api.meta.ai/uploads -d '{}'; pkill -f 'next start -p 3200' || true`,
      { cwd: dir },
    );
    results.uploadProxy = proxy.out.trim().split("\n").slice(-3);
    const report = await sandbox.readFileToBuffer({ path: `${dir}/test-results/report.json` });
    if (report) writeFileSync(path.join(outDir, "report.json"), report);
  }
} finally {
  await sandbox.stop().catch((e) => console.error("stop failed", e));
  console.log("sandbox stopped");
}
console.log("\n=== RESULTS ===\n" + JSON.stringify({ results, timings }, null, 2));
writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ results, timings }, null, 2));
