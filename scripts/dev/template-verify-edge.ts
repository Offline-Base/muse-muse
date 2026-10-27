// Edge cases for template/scripts/verify.mjs in a real Vercel Sandbox: busy port, stale .next types, failures, SIGTERM.
// Usage: npx tsx --env-file=.env.local scripts/dev/template-verify-edge.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { Sandbox } from "@vercel/sandbox";

const TEMPLATE = path.resolve(import.meta.dirname, "../../template");
const SKIP = new Set(["node_modules", ".next", "test-results", "playwright-report", "next-env.d.ts"]);
const DIR = "/vercel/app";
const only = process.argv[2]?.split(",");
const want = (c: string) => !only || only.includes(c);

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

async function sh(sandbox: Sandbox, script: string, opts: { sudo?: boolean; quiet?: boolean } = {}) {
  let out = "";
  const sink = new Writable({ write(c, _e, cb) { out += c.toString(); if (!opts.quiet) process.stdout.write(c); cb(); } });
  const cmd = await sandbox.runCommand({ cmd: "bash", args: ["-lc", script], cwd: DIR, sudo: opts.sudo, stdout: sink, stderr: sink });
  return { code: cmd.exitCode, out };
}

function summary(out: string) {
  const last = out.trim().split("\n").pop() ?? "";
  try {
    const s = JSON.parse(last);
    return { passed: s.passed, steps: s.steps.map((x: { name: string; ok: boolean; detail: string }) => `${x.name}:${x.ok ? "ok" : "FAIL"}(${x.detail})`), failureChars: s.failure.length };
  } catch {
    return { lastLine: last.slice(0, 200) };
  }
}

const write = (sandbox: Sandbox, files: Record<string, string>) =>
  sandbox.writeFiles(Object.entries(files).map(([p, c]) => ({ path: `${DIR}/${p}`, content: Buffer.from(c) })));

const sandbox = await Sandbox.create({ resources: { vcpus: 4 }, timeout: 30 * 60_000 });
const report: Record<string, unknown> = {};
let r: { code: number | null; out: string };
try {
  await sandbox.mkDir(DIR).catch(() => undefined);
  await sandbox.writeFiles(listFiles(TEMPLATE).map((rel) => ({ path: `${DIR}/${rel}`, content: readFileSync(path.join(TEMPLATE, rel)) })));
  await sh(sandbox, "npx -y playwright@1.64.1 install-deps chromium >/dev/null 2>&1; echo deps", { sudo: true, quiet: true });
  await sh(sandbox, "npm ci --no-audit --no-fund >/dev/null && npx playwright install chromium >/dev/null && echo ready");

  // 1. Port 3100 already taken by a stale server.
  if (want("port")) {
  await sandbox.runCommand({ cmd: "node", args: ["-e", "require('http').createServer((q,s)=>s.end('stale')).listen(3100)"], cwd: DIR, detached: true });
  await sh(sandbox, "sleep 1; curl -s localhost:3100; echo", { quiet: true });
  r = await sh(sandbox, "npm run verify 2>&1", { quiet: true });
  report.busyPort = { exit: r.code, ...summary(r.out) };
  await sh(sandbox, "pkill -f 'listen.3100' || true", { quiet: true });
  }

  // 2. Stale .next types: build with an extra route, delete it, verify again.
  if (want("stale")) {
  await write(sandbox, { "app/api/actions/gone/route.ts": "export async function POST() { return Response.json({ ok: true }); }\n" });
  await sh(sandbox, "npx next build >/dev/null 2>&1; rm -rf app/api/actions; grep -c gone .next/types/validator.ts || true", { quiet: true });
  r = await sh(sandbox, "npm run verify 2>&1", { quiet: true });
  report.staleTypes = { exit: r.code, ...summary(r.out) };
  }

  const page = readFileSync(path.join(TEMPLATE, "app/page.tsx"), "utf8");
  const smoke = readFileSync(path.join(TEMPLATE, "tests/smoke.spec.ts"), "utf8");
  // 3. Console error and a failing smoke test.
  if (want("console")) {
  await write(sandbox, {
    "app/page.tsx": `"use client";\nimport { useEffect } from "react";\nexport default function Home() {\n  useEffect(() => { console.error("boom from the page"); }, []);\n  return <main><h1>Hi</h1></main>;\n}\n`,
    "tests/smoke.spec.ts": `import { test, expect } from "@playwright/test";\ntest("finds a missing result", async ({ page }) => {\n  await page.goto("/");\n  await expect(page.getByText("A result that never appears")).toBeVisible({ timeout: 2000 });\n});\n`,
  });
  r = await sh(sandbox, "npm run verify 2>&1", { quiet: true });
  report.consoleAndSmoke = { exit: r.code, ...summary(r.out), printedSections: r.out.match(/----- \w+ output -----/g), failure: JSON.parse(r.out.trim().split("\n").pop() ?? "{}").failure };
  }

  // 4. Type error plus a manifest that names a missing route and fixture.
  if (want("type")) {
  await write(sandbox, {
    "app/page.tsx": `export default function Home() {\n  const n: number = "not a number";\n  return <main>{n}</main>;\n}\n`,
    "tests/smoke.spec.ts": smoke,
    "musemuse.json": JSON.stringify({ name: "X", slug: "x", tagline: "t", inspiration: "i", models: [{ id: "muse-spark-1.3", usedFor: "u" }], actions: [{ name: "count", description: "d", input: {}, output: {} }], fixtures: [{ path: "fixtures/missing.jpg", description: "d" }], limits: [], estimatedCostPerRunUsd: 0 }),
  });
  r = await sh(sandbox, "npm run verify 2>&1", { quiet: true });
  report.typeAndManifest = { exit: r.code, ...summary(r.out), tail: r.out.slice(-1200) };
  }

  // 5. SIGTERM mid-run must stop the server and still print the summary.
  if (want("sigterm")) {
  await write(sandbox, { "app/page.tsx": page, "musemuse.json": readFileSync(path.join(TEMPLATE, "musemuse.json"), "utf8") });
  await write(sandbox, {
    "tests/smoke.spec.ts": `import { test } from "@playwright/test";\ntest("slow", async ({ page }) => { await page.goto("/"); await page.waitForTimeout(60000); });\n`,
  });
  r = await sh(sandbox, `node scripts/verify.mjs > /tmp/v.log 2>&1 & VP=$!; for i in $(seq 1 60); do grep -q "smoke ..." /tmp/v.log && break; sleep 1; done; sleep 3; kill -TERM $VP; wait $VP; echo "exit=$?"; tail -1 /tmp/v.log | cut -c1-400; sleep 1; echo "lines after summary: $(awk '/musemuse_verify/{f=1;next} f' /tmp/v.log | wc -l)"; ps -eo pid,args | grep -E "next-server|next start" | grep -v -E "grep|bash -lc" || echo "no server left"`, { quiet: true });
  report.sigterm = r.out.trim().split("\n").slice(-4);
  }
} finally {
  await sandbox.stop().catch((e) => console.error("stop failed", e));
}
console.log(JSON.stringify(report, null, 2));
