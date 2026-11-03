// No silent fallbacks (the Nov 3 audits B and C): verify fails an action that answers the built-in sample with a fallback
// instead of the model, images Meta can't read are refused before the call, a failed model call says why, and two
// static checks catch media in localStorage and the model client in a client component. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/verify-honesty.test.mjs
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import OpenAI from "openai";
import { z } from "zod";
import { modelErrorResponse, modelFailure } from "../../lib/meta/errors";
import { RespondJsonError } from "../../lib/meta/json";
import { checkImageUrl, checkImageUrls, imagePart } from "../../lib/meta/parts";
import { actionFallbackProblems, fallbackMarks, storedMediaProblems } from "../smoke-report.mjs";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.env.MUSEMUSE_VERIFY_IMPORT_ONLY = "1";
const V = await import(pathToFileURL(path.join(TEMPLATE, "scripts/verify.mjs")).href);
if (!existsSync(path.join(TEMPLATE, "node_modules/@playwright/test/package.json"))) {
  const stub = `data:text/javascript,${encodeURIComponent("export const test = {}; export const expect = () => ({});")}`;
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) { return s === "@playwright/test" ? { url: ${JSON.stringify(stub)}, shortCircuit: true } : n(s, c); }`)}`);
}
const J = await import("../../tests/judge-shot.ts");

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("image inputs", () => {
  test("PNG, JPEG, WebP and GIF data URLs and ordinary links pass unchanged", () => {
    for (const url of [PNG, "data:image/jpeg;base64,/9j/", "data:image/jpg;base64,/9j/", "data:image/webp;base64,UklG", "data:IMAGE/GIF;base64,R0lG", "https://x.test/a.png", "https://x.test/svg-gallery/photo.jpg"]) {
      assert.equal(checkImageUrl(url), url);
    }
    assert.deepEqual(imagePart({ url: PNG }), { type: "input_image", detail: "auto", image_url: PNG });
  });

  test("an SVG data URL throws before the call, saying to draw it to a canvas and send PNG (sim-desk sent these)", () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
    assert.throws(() => imagePart(svg), /image\/svg\+xml data URL.*PNG, JPEG, WebP or GIF.*toDataURL\("image\/png"\)/s);
    assert.throws(() => imagePart("data:image/svg+xml,%3Csvg%2F%3E"), /svg/);
    assert.throws(() => imagePart("data:image/heic;base64,AAAA"), /image\/heic/);
    assert.throws(() => imagePart("data:,hello"), /text\/plain/);
    assert.throws(() => imagePart("https://x.test/desk.svg?v=2"), /SVG file/);
  });

  test("hand-built input_image parts get the same check (respondJson runs it on its input), and it reads as refused", () => {
    const svg = "data:image/svg+xml,%3Csvg%2F%3E";
    const input = [{ role: "user", content: [{ type: "input_text", text: "next step?" }, { type: "input_image", image_url: svg }] }];
    let thrown;
    try {
      checkImageUrls(input);
    } catch (err) {
      thrown = err;
    }
    assert.match(String(thrown?.message), /toDataURL\("image\/png"\)/);
    const f = modelFailure(thrown);
    assert.deepEqual([f.cause, f.status, f.code], ["refused", 422, "image_type"]);
    checkImageUrls([{ role: "user", content: [{ type: "input_image", image_url: PNG }] }, { role: "user", content: "text" }]);
    checkImageUrls("just text");
  });
});

const apiError = (status, error, headers = {}) => OpenAI.APIError.generate(status, { error }, undefined, new Headers(headers));

describe("model failures say why", () => {
  test("the gateway's run limit keeps its own message", () => {
    const f = modelFailure(apiError(429, { type: "rate_limit_error", code: "run_limit", message: "This run used its 8 tool calls." }));
    assert.deepEqual([f.cause, f.status, f.code, f.message], ["run_limit", 429, "run_limit", "This run used its 8 tool calls."]);
  });

  test("rate limits carry retry-after, budgets are their own cause", () => {
    const r = modelFailure(apiError(429, { code: "rate_limited", message: "Too many requests from this user: the limit is 20 per minute. Try again in 12 s." }, { "retry-after": "12" }));
    assert.deepEqual([r.cause, r.retryAfterS], ["rate_limit", 12]);
    assert.equal(modelFailure(apiError(429, { type: "insufficient_quota", code: "budget_exceeded", message: "This product used its $1.00 daily Meta budget." })).cause, "budget");
    assert.equal(modelFailure(apiError(503, { code: "platform_paused", message: "Muse Muse paused Meta calls for today." })).cause, "budget");
  });

  test("timeouts, refusals, bad shapes and server errors", () => {
    assert.equal(modelFailure(new OpenAI.APIConnectionTimeoutError()).cause, "timeout");
    assert.equal(modelFailure(Object.assign(new Error("x"), { name: "TimeoutError" })).cause, "timeout");
    const refused = modelFailure(apiError(400, { code: "invalid_image", message: "Unsupported image format: image/svg+xml" }));
    assert.deepEqual([refused.cause, refused.status], ["refused", 422]);
    assert.match(refused.message, /Unsupported image format/);
    assert.equal(modelFailure(new RespondJsonError("no match", "issues", "raw")).cause, "schema");
    assert.equal(modelFailure(z.object({ a: z.string() }).safeParse({}).error).cause, "schema");
    assert.equal(modelFailure(apiError(502, { code: "upstream_unreachable", message: "Couldn't reach the Meta Model API." })).cause, "upstream");
    assert.equal(modelFailure(new OpenAI.APIConnectionError({ message: "socket hang up" })).cause, "upstream");
    assert.equal(modelFailure("odd").cause, "unknown");
  });

  test("modelErrorResponse answers with the status and cause, and logs one [model] line", async () => {
    const logged = [];
    const original = console.error;
    console.error = (line) => logged.push(line);
    try {
      const res = modelErrorResponse(apiError(429, { code: "rate_limited", message: "Try again in 5 s." }, { "retry-after": "5" }), "prove_item");
      assert.equal(res.status, 429);
      assert.equal(res.headers.get("retry-after"), "5");
      assert.deepEqual(await res.json(), { error: "Try again in 5 s.", cause: "rate_limit", code: "rate_limited", retryAfterS: 5 });
      const timedOut = modelErrorResponse(new OpenAI.APIConnectionTimeoutError(), "file_memo");
      assert.equal(timedOut.status, 504);
      assert.equal((await timedOut.json()).cause, "timeout");
    } finally {
      console.error = original;
    }
    assert.match(logged[0], /^\[model\] prove_item failed: rate_limit \(rate_limited\), HTTP 429: /);
  });
});

const line = (over) => JSON.stringify({ t: 2000, project: "smoke", file: "smoke.spec.ts", action: "decide_next_step", method: "POST", status: 200, json: true, fields: {}, ...over });

describe("verify's fallback check", () => {
  test("fails sim-desk: 8 of 8 decide calls answered model: false with an error string", () => {
    const fields = { model: false, error: "An AI model is unavailable right now. Using the local plan instead." };
    const log = Array.from({ length: 8 }, () => line({ fields })).join("\n");
    const problems = actionFallbackProblems(log, { since: 1000 });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /The decide_next_step action answered 8 of 8 call\(s\) .* "model": false, "error": "An AI model is unavailable/);
    assert.match(problems[1], /modelErrorResponse.*role="alert"/);
  });

  test("fails fallback: true and estimate: true, one line per action", () => {
    const log = [line({ action: "rules", fields: { fallback: true } }), line({ action: "track_pet", fields: { estimate: true } }), line({ action: "track_pet", fields: { model: "muse-wonder-1.0" } })].join("\n");
    const problems = actionFallbackProblems(log);
    assert.match(problems[0], /rules action answered 1 of 1/);
    assert.match(problems[1], /track_pet action answered 1 of 2 .*"estimate": true/);
  });

  test("a product route outside /api/actions/ fails on the three flags, not on an error string (the game's /api/rules)", () => {
    const log = [line({ action: "/api/rules", method: "GET", fields: { fallback: true } }), line({ action: "/api/status", fields: { error: "No saved game yet." } })].join("\n");
    const problems = actionFallbackProblems(log);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^The \/api\/rules route answered 1 of 1 .*"fallback": true/);
  });

  test("passes real answers, error statuses, empty or null errors, other projects and older runs", () => {
    const log = [
      line({ fields: { model: true, error: null } }),
      line({ fields: { error: "" } }),
      line({ status: 502, fields: { error: "That proof call failed." } }),
      line({ status: 429, fields: { error: "Try again in 5 s.", cause: "rate_limit" } }),
      line({ project: "demo", fields: { fallback: true } }),
      line({ t: 10, fields: { fallback: true } }),
      "not json",
    ].join("\n");
    assert.deepEqual(actionFallbackProblems(log, { since: 1000 }), []);
    assert.deepEqual(actionFallbackProblems(null), []);
    assert.deepEqual(fallbackMarks({ model: "muse-wonder-1.0", fallback: false, estimate: 3 }), []);
  });

  test("judgeShot records only this product's action routes, and only the fallback fields", () => {
    assert.equal(J.actionNameOf("http://localhost:3100/api/actions/decide_next_step"), "decide_next_step");
    assert.equal(J.actionNameOf("http://localhost:3100/api/actions/file_memo/"), "file_memo");
    for (const url of ["http://localhost:3100/api/upload", "http://localhost:3100/api/actions/", "http://localhost:3100/_next/static/a.js", "nope"]) assert.equal(J.actionNameOf(url), null);
    assert.deepEqual(J.fallbackFields({ model: false, error: "x".repeat(500), estimate: { low: 1 }, plan: [1, 2] }), { model: false, error: "x".repeat(200), estimate: "object" });
    assert.equal(J.apiRouteOf("http://localhost:3100/api/actions/file_memo"), "file_memo");
    assert.equal(J.apiRouteOf("http://localhost:3100/api/rules/"), "/api/rules");
    for (const url of ["http://localhost:3100/api/upload", "http://localhost:3100/api/musemuse/health", "http://localhost:3100/api/actions/", "http://localhost:3100/api", "http://localhost:3100/rules"]) assert.equal(J.apiRouteOf(url), null);
    assert.deepEqual(J.fallbackFields([1]), {});
    assert.deepEqual(J.fallbackFields(null), {});
  });
});

describe("media in browser storage", () => {
  const shots = (storedMedia) => ({ names: ["01-start.png", "01-start.checked", "02-result.png", "02-result.checked"], read: (f) => JSON.stringify(f.startsWith("02") ? { storedMedia } : {}) });

  test("judgeShot's storage finding fails verify with IndexedDB as the fix (room restyle kept 540K-character webps)", () => {
    const { names, read } = shots([{ storage: "localStorage", key: "room-restyle-studio:v1", chars: 1_080_000 }]);
    const [problem] = storedMediaProblems(names, read);
    assert.match(problem, /localStorage "room-restyle-studio:v1" \(1,080K characters\).*IndexedDB/);
    const clean = shots([]);
    assert.deepEqual(storedMediaProblems(clean.names, clean.read), []);
  });

  test("the static check flags a setItem of a data URL or base64 media, and nothing else", () => {
    const bad = [
      { path: "app/page.tsx", text: 'localStorage.setItem("photo", canvas.toDataURL("image/png"));' },
      { path: "app/room.tsx", text: "window.localStorage.setItem(KEY, JSON.stringify({ versions: versions.map((v) => v.dataUrl) }));" },
      { path: "lib/save.ts", text: "sessionStorage.setItem('clip', `data:audio/wav;base64,${b64}`)" },
    ];
    const problems = V.storageMediaProblems(bad);
    assert.equal(problems.length, 3);
    assert.match(problems[0], /^app\/page\.tsx saves media in browser storage: localStorage\.setItem\("photo", canvas\.toDataURL\(.*IndexedDB/);
    const ok = [
      { path: "app/page.tsx", text: 'localStorage.setItem("todos", JSON.stringify(todos)); localStorage.setItem("theme", dark ? "dark" : "light");' },
      { path: "app/b.tsx", text: 'const url = canvas.toDataURL("image/png"); localStorage.setItem("count", String(n));' },
    ];
    assert.deepEqual(V.storageMediaProblems(ok), []);
  });
});

/** The template's own app, components and lib, as verify reads them. */
function templateSources() {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(TEMPLATE, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|mjs|jsx?)$/.test(e.name)) out.push({ path: p, text: readFileSync(path.join(TEMPLATE, p), "utf8") });
    }
  };
  for (const dir of ["app", "components", "lib"]) walk(dir);
  return out;
}

describe("the model client stays on the server", () => {
  const meta = templateSources().filter((s) => s.path.startsWith("lib/meta/"));

  test("the template's own files pass both static checks", () => {
    const sources = templateSources();
    assert.ok(sources.some((s) => s.path === "components/ConfirmButton.tsx") && sources.some((s) => s.path === "lib/meta/json.ts"));
    assert.deepEqual(V.clientModelImportProblems(sources), []);
    assert.deepEqual(V.storageMediaProblems(sources), []);
  });

  test("fails the game: a client component imports the rules schema from a file that calls respondJson", () => {
    const sources = [
      ...meta,
      { path: "lib/rules.ts", text: 'import { z } from "zod";\nimport { respondJson } from "./meta/json";\nexport const Rules = z.object({ text: z.string() });' },
      { path: "components/RulesCard.tsx", text: '"use client";\nimport { Rules } from "@/lib/rules";\nexport function RulesCard() { return null; }' },
      { path: "app/play/page.tsx", text: "'use client';\n// a note\nimport OpenAI from 'openai';\nexport default function P() { return null; }" },
      { path: "app/route-ok.tsx", text: '"use client";\nimport type { RespondJsonOptions } from "@/lib/meta/json";\nimport { type RequestLike } from "../lib/meta/client";\nimport { plain } from "@/lib/meta/text";\nimport { imagePart } from "@/lib/meta/parts";' },
      { path: "app/api/actions/rules/route.ts", text: 'import { respondJson } from "@/lib/meta/json";' },
    ];
    const problems = V.clientModelImportProblems(sources);
    assert.equal(problems.length, 2, problems.join("\n"));
    assert.match(problems[0], /^components\/RulesCard\.tsx is a client component \("use client"\) and imports lib\/meta\/json\.ts \(through lib\/rules\.ts\)\..*imports only zod/);
    assert.match(problems[1], /^app\/play\/page\.tsx .* imports the openai package\. /);
  });

  test("a lib/meta module that imports another one that calls the model counts, and text.ts and parts.ts don't", () => {
    const sources = [...meta, { path: "components/D.tsx", text: '"use client";\nimport { standInDecision } from "@/lib/meta/decide";' }, { path: "components/T.tsx", text: '"use client";\nimport { plain } from "@/lib/meta/text";' }];
    const problems = V.clientModelImportProblems(sources);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^components\/D\.tsx .* imports lib\/meta\/decide\.ts\./);
  });

  test("importsOf reads static, side-effect, re-export and dynamic imports, and marks type-only ones", () => {
    const got = V.importsOf(['import a, { type B } from "x";', 'import type { C } from "y";', 'import { type D, type E } from "z";', 'import "side";', 'export * from "re";', 'const m = await import("dyn");', '/* import q from "no" */'].join("\n"));
    assert.deepEqual(got, [
      { spec: "x", typeOnly: false },
      { spec: "y", typeOnly: true },
      { spec: "z", typeOnly: true },
      { spec: "re", typeOnly: false },
      { spec: "side", typeOnly: false },
      { spec: "dyn", typeOnly: false },
    ]);
  });
});
