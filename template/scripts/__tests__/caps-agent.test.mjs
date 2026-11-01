// The core cap overlay next to the agent target overlay (docs/CAPABILITIES.md, 2.5): core ships lib/platform/identity.ts
// as an exact copy of the agent kit's, the two overlays write no other path in common, and in one product with both
// applied the platform's static route (app/api/musemuse/health) and the agent kit's catch-all
// (app/api/musemuse/[...path]) both answer. Next serves a static segment before a catch-all, so the two never touch.
// Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AGENT = path.join(TEMPLATE, "targets/agent/files");
const CORE = path.join(TEMPLATE, "caps/core/files");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join("/")],
  );
}

test("core's lib/platform/identity.ts is the agent kit's, byte for byte, and is a platform file in both", () => {
  assert.equal(readFileSync(path.join(CORE, "lib/platform/identity.ts"), "utf8"), readFileSync(path.join(AGENT, "lib/platform/identity.ts"), "utf8"));
  for (const overlay of ["targets/agent", "caps/core"]) {
    assert.ok(JSON.parse(readFileSync(path.join(TEMPLATE, overlay, "platform-files.json"), "utf8")).includes("lib/platform/identity.ts"), overlay);
  }
});

test("the agent overlay and the core overlay share no other path", () => {
  const agent = new Set(walk(AGENT));
  assert.deepEqual(walk(CORE).filter((f) => agent.has(f)), ["lib/platform/identity.ts"]);
});

const modules = path.join(TEMPLATE, "node_modules");
test("with both applied, the health route and the agent kit's catch-all both answer", { skip: existsSync(modules) ? false : "needs template/node_modules" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mm-caps-agent-"));
  dirs.push(dir);
  for (const f of ["tsconfig.json", "package.json"]) cpSync(path.join(TEMPLATE, f), path.join(dir, f));
  cpSync(path.join(TEMPLATE, "lib"), path.join(dir, "lib"), { recursive: true });
  cpSync(AGENT, dir, { recursive: true });
  cpSync(CORE, dir, { recursive: true });
  symlinkSync(modules, path.join(dir, "node_modules"));
  const script = path.join(dir, "call.mts");
  writeFileSync(
    script,
    `const health = await import("./app/api/musemuse/health/route.ts");
const kit = await import("./app/api/musemuse/[...path]/route.ts");
const at = (p: string, method = "GET") => new Request("http://localhost:3100/api/musemuse/" + p, { method });
const params = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const out = {
  health: await (await health.GET()).json(),
  signOut: await kit.POST(at("sign-out", "POST"), params("sign-out")).then((r: Response) => ({ status: r.status, cookie: r.headers.get("set-cookie") })),
  kitHealth: (await kit.GET(at("health"), params("health"))).status,
};
console.log(JSON.stringify(out));
`,
  );
  // tsx from the repo, run in the product folder so "@/..." resolves to the product's own files.
  const tsx = fileURLToPath(import.meta.resolve("tsx/esm"));
  const res = spawnSync(process.execPath, ["--import", tsx, script], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GATEWAY_URL: "https://platform.example/api/gateway", PRODUCT_TOKEN: "mm_build_sample" },
  });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout.trim().split("\n").at(-1));
  assert.deepEqual(out.health, { ok: true, gateway: true });
  assert.equal(out.signOut.status, 204);
  assert.match(out.signOut.cookie, /^mm_owner=; Path=\/; Max-Age=0/);
  assert.equal(out.kitHealth, 404, "the catch-all has no health route of its own, so the static one is the only answer");
});
