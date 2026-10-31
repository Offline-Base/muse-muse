// The trust overlay (template/caps/trust, docs/CAPABILITIES.md, section 7): it writes no path the template or another
// overlay writes except components/Footer.tsx, its Footer keeps the template's contract, and in a product with it
// applied: the proxy blocks restricted territories by header, the age gate sends a page visit to /age (and is off under
// MUSEMUSE_BUILD=1), the age route remembers the tap, the pages render from the platform's two files, and the product
// typechecks. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TRUST = path.join(TEMPLATE, "caps/trust");
const FILES = path.join(TRUST, "files");
const modules = path.join(TEMPLATE, "node_modules");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isSymbolicLink() ? [] : e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join("/")],
  );
}

/** The template's own files, without the overlays, its tests' fixtures and anything installed. */
function templateFiles() {
  const skip = ["node_modules/", "targets/", "caps/", "scripts/__tests__/", ".next/", "test-results/"];
  return walk(TEMPLATE).filter((f) => !skip.some((s) => f.startsWith(s)));
}

const SAMPLE_TRUST = {
  v: 1,
  product: { name: "Bird Count", slug: "bird-count" },
  termsVersion: "2026-10-31",
  updated: "October 31, 2026",
  ageGate: true,
  legalPages: true,
  geo: ["CU", "UA-43"],
  reportUrl: "https://musemuse.example/report/bird-count",
};
const SAMPLE_PRIVACY = {
  v: 1,
  models: [{ id: "sam-3.1", label: "SAM 3.1", does: "Finds each bird in the photo.", gets: ["what you type", "the photos you add"] }],
  keeps: ["Nothing on a server. Anything it saves stays in your browser, and clearing the site's data removes it."],
  services: [],
  uploads: true,
};

describe("the trust overlay's files", () => {
  test("write no path the template or another overlay writes, except the Footer it replaces", () => {
    const own = walk(FILES);
    const template = new Set(templateFiles());
    assert.deepEqual(own.filter((f) => template.has(f)), ["components/Footer.tsx"]);
    for (const dir of [...readdirSync(path.join(TEMPLATE, "targets")).map((t) => `targets/${t}`), ...readdirSync(path.join(TEMPLATE, "caps")).filter((c) => c !== "trust").map((c) => `caps/${c}`)]) {
      const theirs = new Set(walk(path.join(TEMPLATE, dir, "files")));
      assert.deepEqual(own.filter((f) => theirs.has(f)), [], dir);
    }
  });

  test("are all platform files, and have no deps", () => {
    const listed = JSON.parse(readFileSync(path.join(TRUST, "platform-files.json"), "utf8"));
    assert.deepEqual([...listed].sort(), walk(FILES).sort());
    assert.deepEqual(JSON.parse(readFileSync(path.join(TRUST, "deps.json"), "utf8")), { dependencies: {}, devDependencies: {} });
  });

  test("keep the template Footer's contract: the same export, the credit line and the required sentence", () => {
    const base = readFileSync(path.join(TEMPLATE, "components/Footer.tsx"), "utf8");
    const mine = readFileSync(path.join(FILES, "components/Footer.tsx"), "utf8");
    const signature = "export function Footer({ credit }: { credit?: string })";
    assert.ok(base.includes(signature) && mine.includes(signature));
    for (const line of ["Built with Muse Muse. Not an official Meta product.", "a Meta developer video", 'font: "var(--type-meta)"', 'color: "var(--fg-2)"']) {
      assert.ok(base.includes(line) && mine.includes(line), line);
    }
  });

  test("say nothing with an em dash", () => {
    for (const f of walk(FILES)) assert.ok(!readFileSync(path.join(FILES, f), "utf8").includes("—"), f);
  });
});

describe("a product with the trust overlay", { skip: existsSync(modules) ? false : "needs template/node_modules" }, () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-trust-"));
    dirs.push(dir);
    for (const f of templateFiles()) cpSync(path.join(TEMPLATE, f), path.join(dir, f));
    cpSync(FILES, dir, { recursive: true });
    writeFileSync(path.join(dir, "musemuse.trust.json"), `${JSON.stringify(SAMPLE_TRUST, null, 2)}\n`);
    writeFileSync(path.join(dir, "musemuse.privacy.json"), `${JSON.stringify(SAMPLE_PRIVACY, null, 2)}\n`);
    symlinkSync(modules, path.join(dir, "node_modules"));
  });

  function run(source, env = {}) {
    const script = path.join(dir, `run-${Math.random().toString(36).slice(2)}.mts`);
    writeFileSync(script, source);
    const tsx = fileURLToPath(import.meta.resolve("tsx/esm"));
    const res = spawnSync(process.execPath, ["--import", tsx, script], { cwd: dir, encoding: "utf8", env: { ...process.env, MUSEMUSE_BUILD: "", ...env } });
    rmSync(script, { force: true });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout.trim().split("\n").at(-1));
  }

  const PROXY = `
import { NextRequest } from "next/server";
const { proxy } = await import("./proxy.ts");
const at = (p: string, h: Record<string, string> = {}, method = "GET") => new NextRequest("https://bird-count.example" + p, { method, headers: { accept: "text/html", ...h } });
const see = (r: Response) => ({ status: r.status, location: r.headers.get("location"), next: r.headers.get("x-middleware-next") });
const out = {
  cuba: see(proxy(at("/", { "x-vercel-ip-country": "CU" }))),
  cubaApi: see(proxy(at("/api/actions/count_birds", { "x-vercel-ip-country": "CU", accept: "application/json" }, "POST"))),
  crimea: see(proxy(at("/", { "x-vercel-ip-country": "UA", "x-vercel-ip-country-region": "43" }))),
  kyiv: see(proxy(at("/", { "x-vercel-ip-country": "UA", "x-vercel-ip-country-region": "30", cookie: "mm_age=2026-10-31" }))),
  firstVisit: see(proxy(at("/results?photo=2"))),
  confirmed: see(proxy(at("/", { cookie: "mm_age=2026-10-31" }))),
  oldTerms: see(proxy(at("/", { cookie: "mm_age=2025-01-01" }))),
  api: see(proxy(at("/api/actions/count_birds", { accept: "application/json" }, "POST"))),
  privacy: see(proxy(at("/privacy"))),
  age: see(proxy(at("/age?next=/"))),
  script: see(proxy(at("/", { accept: "*/*" }))),
};
console.log(JSON.stringify(out));
`;

  test("blocks restricted territories with 451, and sends a first page visit to the age gate", () => {
    const out = run(PROXY);
    assert.equal(out.cuba.status, 451);
    assert.equal(out.cubaApi.status, 451, "routes too");
    assert.equal(out.crimea.status, 451, "a listed region");
    assert.equal(out.kyiv.next, "1", "the rest of Ukraine isn't blocked");
    assert.equal(out.firstVisit.status, 307);
    assert.equal(out.firstVisit.location, "https://bird-count.example/age?next=%2Fresults%3Fphoto%3D2");
    assert.equal(out.confirmed.next, "1");
    assert.equal(out.oldTerms.status, 307, "a tap for older terms asks again");
    for (const k of ["api", "privacy", "age", "script"]) assert.equal(out[k].next, "1", k);
  });

  test("has the age gate off while the platform's tests run (MUSEMUSE_BUILD=1), and keeps the geo block", () => {
    const out = run(PROXY, { MUSEMUSE_BUILD: "1" });
    assert.equal(out.firstVisit.next, "1");
    assert.equal(out.oldTerms.next, "1");
    assert.equal(out.cuba.status, 451);
  });

  test("the age route remembers the tap for these terms and goes back, never to another site", () => {
    const out = run(`
const { POST } = await import("./app/api/musemuse/age/route.ts");
const post = async (url: string, next: string) => {
  const r = await POST(new Request(url, { method: "POST", body: new URLSearchParams({ next }) }));
  return { status: r.status, location: r.headers.get("location"), cookie: r.headers.get("set-cookie") };
};
console.log(JSON.stringify({ https: await post("https://bird-count.example/api/musemuse/age", "/results?photo=2"), http: await post("http://localhost:3100/api/musemuse/age", "//evil.example") }));
`);
    assert.equal(out.https.status, 303);
    assert.equal(out.https.location, "/results?photo=2");
    assert.match(out.https.cookie, /^mm_age=2026-10-31; Path=\/; Max-Age=31536000; HttpOnly; Secure; SameSite=None; Partitioned$/);
    assert.equal(out.http.location, "/");
    assert.match(out.http.cookie, /SameSite=Lax$/);
  });

  test("renders the footer, privacy, terms and age pages from the platform's files", () => {
    const out = run(`
import { renderToStaticMarkup } from "react-dom/server";
const { Footer } = await import("./components/Footer.tsx");
const privacy = (await import("./app/(musemuse)/privacy/page.tsx")).default;
const terms = (await import("./app/(musemuse)/terms/page.tsx")).default;
const age = (await import("./app/(musemuse)/age/page.tsx")).default;
console.log(JSON.stringify({
  footer: renderToStaticMarkup(Footer({ credit: "https://www.youtube.com/watch?v=x" })),
  privacy: renderToStaticMarkup(privacy()),
  terms: renderToStaticMarkup(terms()),
  age: renderToStaticMarkup(await age({ searchParams: Promise.resolve({ next: "/results" }) })),
  under: renderToStaticMarkup(await age({ searchParams: Promise.resolve({ under: "1" }) })),
}));
`);
    assert.match(out.footer, /Built with Muse Muse\. Not an official Meta product\./);
    assert.match(out.footer, /Idea from <a href="https:\/\/www\.youtube\.com\/watch\?v=x"/);
    assert.match(out.footer, /<a href="\/privacy"[^>]*>Privacy<\/a>/);
    assert.match(out.footer, /<a href="\/terms"[^>]*>Terms<\/a>/);
    assert.match(out.footer, /<a href="https:\/\/musemuse\.example\/report\/bird-count"[^>]*>Report<\/a>/);
    assert.match(out.privacy, /<strong>SAM 3\.1<\/strong>: Finds each bird in the photo\. It gets what you type, the photos you add\./);
    assert.match(out.privacy, /deleted after 24 hours/);
    assert.match(out.privacy, /18 or older/);
    assert.match(out.terms, /not an official Meta product/);
    assert.match(out.terms, /Version 2026-10-31/);
    assert.match(out.age, /<input type="hidden" name="next" value="\/results"\/>/);
    assert.match(out.age, /I&#x27;m 18 or older/);
    assert.match(out.under, /only for people 18 and older/);
  });

  test("typechecks with the template's TypeScript", () => {
    const tsc = path.join(modules, "typescript/bin/tsc");
    const res = spawnSync(process.execPath, [tsc, "--noEmit", "-p", dir], { cwd: dir, encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });
});
