// Built-in samples that work for visitors (the Nov 3 targets audit, issue 3): the aisle build's "Try the sample shelf
// photo" fetched /fixtures/..., which production never serves, and verify missed it because the smoke test used
// setInputFiles. These cover verify's static checks, judgeShot's record of files that answered 404, and verify's reading
// of that record. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/samples.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { missingFileProblems } from "../smoke-report.mjs";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.env.MUSEMUSE_VERIFY_IMPORT_ONLY = "1";
const V = await import(pathToFileURL(path.join(TEMPLATE, "scripts/verify.mjs")).href);
if (!existsSync(path.join(TEMPLATE, "node_modules/@playwright/test/package.json"))) {
  const stub = `data:text/javascript,${encodeURIComponent("export const test = {}; export const expect = () => ({});")}`;
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) { return s === "@playwright/test" ? { url: ${JSON.stringify(stub)}, shortCircuit: true } : n(s, c); }`)}`);
}
const J = await import("../../tests/judge-shot.ts");

const client = (body) => `"use client";\n\nimport { useState } from "react";\n\n${body}`;

describe("a page never loads fixtures/", () => {
  test("the aisle build's fetch of /fixtures/ fails, with what to do instead", () => {
    const [problem, ...rest] = V.fixtureUrlProblems([
      { path: "app/page.tsx", text: client('const res = await fetch("/fixtures/sample-2-eye-level-phone-photo-of.jpg");') },
    ]);
    assert.equal(rest.length, 0);
    assert.match(problem, /^app\/page\.tsx loads "\/fixtures\/sample-2-eye-level-phone-photo-of\.jpg" in the browser/);
    assert.match(problem, /public\/samples\//);
  });

  test("an img src, a template string and a relative path in a client file are caught too", () => {
    const problems = V.fixtureUrlProblems([
      { path: "components/Door.tsx", text: client("return <img src=\"/fixtures/door.jpg\" alt=\"Door\" />;") },
      { path: "components/Pick.tsx", text: client("const url = `/fixtures/${name}`;") },
      { path: "components/Rel.tsx", text: client('fetch("fixtures/note.wav")') },
    ]);
    assert.deepEqual(problems.map((p) => p.split(" ")[0]), ["components/Door.tsx", "components/Pick.tsx", "components/Rel.tsx"]);
  });

  test("a server route reading fixtures/ from disk, comments, tests and /samples/ are left alone", () => {
    const problems = V.fixtureUrlProblems([
      { path: "app/api/actions/scan/route.ts", text: 'const file = await readFile(path.join(process.cwd(), "fixtures", "a.jpg"));\nconst b = readFileSync("fixtures/b.jpg");' },
      { path: "app/page.tsx", text: client('// Old: fetch("/fixtures/a.jpg")\n/* src="/fixtures/b.jpg" */\nconst res = await fetch("/samples/a.jpg");\nconst site = "https://example.com//fixtures/";') },
      { path: "lib/samples.ts", text: 'export const NOTE = "fixtures/notes.txt";' },
      // A path on disk, in a route or a server file that reads the disk, even when it starts with a slash.
      { path: "app/api/sample/route.ts", text: 'export async function GET() { return new Response(await readFile(process.cwd() + "/fixtures/shelf.jpg")); }' },
      { path: "app/report/page.tsx", text: 'import { readFileSync } from "node:fs";\nconst rows = readFileSync(process.cwd() + "/fixtures/rows.csv", "utf8");' },
    ]);
    assert.deepEqual(problems, []);
  });
});

describe("samples the code names are in public/samples/", () => {
  const exists = (p) => p === "samples/shelf.jpg";
  test("a missing one fails, a present one and a built name pass", () => {
    const problems = V.sampleFileProblems(
      [
        { path: "app/page.tsx", text: client('fetch("/samples/shelf.jpg"); fetch("/samples/door-open.jpg"); fetch(`/samples/${id}.jpg`);') },
        { path: "lib/glasses-samples.ts", text: 'export const SAMPLES = { photos: ["/samples/pov-1.jpg"] };' },
      ],
      exists,
    );
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^app\/page\.tsx loads "\/samples\/door-open\.jpg", but public\/samples\/door-open\.jpg isn't there/);
    assert.match(problems[1], /lib\/glasses-samples\.ts loads "\/samples\/pov-1\.jpg"/);
  });
});

describe("the smoke test presses the sample button", () => {
  const page = { path: "app/page.tsx", text: client('return <button className="secondary" onClick={loadSample}>Try the sample shelf photo</button>;') };
  const uploadOnly = `import { test, expect } from "@playwright/test";
test("adds a shelf photo", async ({ page }) => {
  await test.step("Add a photo of the shelf", async () => {
    // We could press Try the sample here.
    await page.getByLabel("Shelf photo").setInputFiles("fixtures/shelf.jpg");
  });
  await test.step("Read the shelf", async () => {
    await page.getByRole("button", { name: "Read the shelf" }).click();
  });
});`;

  test("the aisle build's setInputFiles-only smoke test fails, naming the button", () => {
    const [problem, ...rest] = V.sampleClickProblems([page], uploadOnly, ["web", "phone"]);
    assert.equal(rest.length, 0);
    assert.match(problem, /^app\/page\.tsx offers "Try the sample", but tests\/smoke\.spec\.ts never presses it/);
    assert.match(problem, /getByRole\("button", \{ name: \/try the sample\/i \}\)\.click\(\)/);
  });

  test("a click on a locator that names the sample passes, however it is written", () => {
    const specs = [
      'await page.getByRole("button", { name: "Try the sample shelf photo" }).click();',
      'await page\n    .getByRole("button", { name: /try the sample/i })\n    .click();',
      'const sample = page.getByRole("button", { name: "Use a sample" });\nawait sample.click();',
      'const tryIt = page.getByText("Try the sample");\nawait expect(tryIt).toBeVisible();\nawait tryIt.click();',
    ];
    for (const spec of specs) assert.deepEqual(V.sampleClickProblems([page], spec), [], spec);
  });

  test("a step title about the sample around a click on another button doesn't count", () => {
    const spec = 'await test.step("Try the sample", async () => {\n  await page.getByRole("button", { name: "Read the shelf" }).click();\n});';
    assert.equal(V.smokeClicksSample(spec), false);
  });

  test("no sample button, no smoke test yet, or a glasses or VR product: nothing to check", () => {
    const plain = { path: "app/page.tsx", text: client("return <button>Read the shelf</button>;") };
    assert.deepEqual(V.sampleClickProblems([plain], uploadOnly), []);
    assert.deepEqual(V.sampleClickProblems([page], null), []);
    assert.deepEqual(V.sampleClickProblems([page], uploadOnly, ["web", "glasses"]), []);
    assert.deepEqual(V.sampleClickProblems([page], uploadOnly, ["vr"]), []);
    // Words in a comment, or an id like useSample, aren't a button.
    const quiet = { path: "components/Tip.tsx", text: client("// Try the sample later\nconst useSample = () => null;") };
    assert.deepEqual(V.sampleClickProblems([quiet], uploadOnly), []);
    // A sentence that mentions a sample isn't a control.
    const prose = { path: "app/page.tsx", text: client("return <p>You can use a sample to see how it works.</p>;") };
    assert.deepEqual(V.sampleClickProblems([prose], uploadOnly), []);
  });

  test("a label in JSX on its own line, or in a string, still counts as the control", () => {
    const multi = { path: "app/page.tsx", text: client("return (\n  <button onClick={go}>\n    Use a sample photo\n  </button>\n);") };
    const [problem] = V.sampleClickProblems([multi], uploadOnly);
    assert.match(problem, /offers "Use a sample", but/);
    const label = { path: "components/Start.tsx", text: client('const LABEL = "Load the sample receipt";') };
    assert.equal(V.sampleClickProblems([label], uploadOnly).length, 1);
  });

  test("verify runs all three checks in its manifest step", () => {
    const source = readFileSync(path.join(TEMPLATE, "scripts/verify.mjs"), "utf8");
    assert.match(source, /fixtureUrlProblems\(sources\)/);
    assert.match(source, /sampleFileProblems\(sources,/);
    assert.match(source, /sampleClickProblems\(sources, readText\("tests\/smoke\.spec\.ts"\), productTargets\(readText\)\)/);
    assert.match(source, /\.\.\.missingFileProblems\(shots, read\)/);
  });
});

describe("files that answered 404 in the smoke run", () => {
  const PAGE = "http://localhost:3100/";
  test("judgeShot notes samples and media on the product's own origin, not icons, routes or other sites", () => {
    assert.equal(J.missingFileOf("http://localhost:3100/fixtures/shelf.jpg", 404, PAGE), "/fixtures/shelf.jpg");
    assert.equal(J.missingFileOf("http://localhost:3100/samples/note", 404, PAGE), "/samples/note");
    assert.equal(J.missingFileOf("http://localhost:3100/img/hero.webp", 404, PAGE), "/img/hero.webp");
    assert.equal(J.missingFileOf("http://localhost:3100/samples/shelf.jpg", 200, PAGE), null);
    for (const url of ["http://localhost:3100/favicon.ico", "http://localhost:3100/apple-touch-icon.png", "http://localhost:3100/api/actions/x", "http://localhost:3100/_next/static/a.png", "http://localhost:3100/data.json", "https://cdn.example/fixtures/a.jpg"]) {
      assert.equal(J.missingFileOf(url, 404, PAGE), null, url);
    }
  });

  test("verify fails a run that asked for one, and says to copy fixtures to public/samples/", () => {
    const checked = { "01-start.checked": { missingFiles: [] }, "02-result.checked": { missingFiles: ["/fixtures/shelf.jpg"] } };
    const read = (f) => JSON.stringify(checked[f]);
    const [problem, ...rest] = missingFileProblems(["01-start.png", "02-result.png"], read);
    assert.equal(rest.length, 0);
    assert.match(problem, /asked for \/fixtures\/shelf\.jpg and got 404/);
    assert.match(problem, /public\/samples\//);
    assert.match(missingFileProblems(["02-result.png"], () => JSON.stringify({ missingFiles: ["/img/a.png"] }))[0], /Put the file under public\//);
    assert.deepEqual(missingFileProblems(["01-start.png"], () => JSON.stringify({ problems: [] })), []);
  });

  test("the build-range copy of smoke-report.mjs has the same check", () => {
    const copy = readFileSync(path.join(TEMPLATE, "targets/build-range/files/scripts/smoke-report.mjs"), "utf8");
    const own = readFileSync(path.join(TEMPLATE, "scripts/smoke-report.mjs"), "utf8");
    const fn = (s) => s.slice(s.indexOf("export function missingFileProblems"), s.indexOf("export function glassesProblems"));
    assert.ok(fn(own).length > 100);
    assert.equal(fn(copy), fn(own));
  });
});
