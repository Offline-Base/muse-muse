/**
 * The page logic behind the cookbook-use-cases demos: the alert feed and its validators, chart checks, grounding
 * points and the overlay file, slide outline normalization, the Glimmer gate's digests and ledger, the recipe
 * browser, the game prompts, and the real replies saved in fixtures/replies.json (ids kept, opaque blobs removed).
 * No network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-use-cases/__tests__/recipes.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as A from "@/components/docs/playgrounds/cookbook-use-cases/lib/alerts";
import * as C from "@/components/docs/playgrounds/cookbook-use-cases/lib/chart";
import * as G from "@/components/docs/playgrounds/cookbook-use-cases/lib/grounding-overlay";
import * as S from "@/components/docs/playgrounds/cookbook-use-cases/lib/slides";
import * as L from "@/components/docs/playgrounds/cookbook-use-cases/lib/glimmer";
import * as R from "@/components/docs/playgrounds/cookbook-use-cases/lib/recipes";
import * as GD from "@/components/docs/playgrounds/cookbook-use-cases/lib/gamedev";
import { retryPlan } from "@/components/docs/playgrounds/cookbook-use-cases/lib/retry";
import { responseText } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { parseStrictJson } from "@/components/docs/playgrounds/cookbook-use-cases/lib/strict-json";

const FIX = JSON.parse(readFileSync(new URL("./fixtures/replies.json", import.meta.url), "utf8"));

describe("alert fatigue", () => {
  const alerts = A.syntheticAlerts();
  const d = A.digestOf(alerts);
  it("bakes in the recipe's patterns", () => {
    assert.equal(d.total, 42);
    assert.equal(d.recurring, 28);
    assert.equal(d.silenced, 3);
    assert.equal(d.spike_2_4am, 28);
    assert.deepEqual(d.top_owners[0], ["alex", 31]);
    assert.equal(d.alerts_per_day, 1.4);
    assert.equal(d.top_components.length, 7);
    assert.ok(d.top_components.every(([, n]) => n === 6), "all seven components tie at 6");
    assert.ok(alerts.every((a) => a.host.endsWith(".example") && a.runbook.includes(".example/")), ".example domains only");
  });
  it("validates the real probe and self-assessment", () => {
    assert.ok(A.validateProbe(FIX.alerts.probe).every((c) => c.ok));
    assert.ok(A.validateAssessment(FIX.alerts.assess).every((c) => c.ok));
    assert.match(A.validateProbe({ patterns: [{ text: "x", salience: "high" }], refined_purpose: { statement: "" }, signals: [] })[1].text, /statement is empty/);
    assert.match(A.validateProbe({ patterns: [{ text: "x", salience: "high" }], refined_purpose: { statement: "s" }, signals: [{ name: "a", role: "leading", proxy_strength: "weak" }] })[2].text, /signals\[0\] missing direction/);
    assert.match(A.validateAssessment({ narrative: "n", proposals: [{ kind: "budget", risk: "low" }] })[1].text, /not in the allowlist/);
  });
  it("traces every number in the real chat answer to the digest, and flags invented ones", () => {
    assert.ok(A.numberCheck(FIX.alerts.chat, d).every((n) => n.grounded), FIX.alerts.chat);
    assert.deepEqual(A.numberCheck("30 days, 42 alerts", d).map((n) => n.grounded), [true, true]);
    assert.equal(A.numberCheck("about 55% of alerts", d)[0].grounded, false);
  });
  it("builds the three requests", () => {
    const probe = A.probeRequest({ model: "m", effort: "low", schema: true, sendDigest: true, alerts, digest: d });
    assert.match(String(probe.input), /Digest \(computed by the harness\):\ntotal alerts: 42/);
    assert.deepEqual((probe.text as { format: { name: string } }).format.name, "probe_result");
    const files = A.probeStateFiles(FIX.alerts.probe, d);
    assert.deepEqual(Object.keys(files), ["purpose.json", "signals.json", "memory.jsonl"]);
    assert.equal(JSON.parse(files["purpose.json"]).version, 1);
    assert.match(String(A.chatRequest({ model: "m", effort: null, files, digest: d }).input), /state\/purpose\.json:/);
    assert.equal(A.assessRequest({ model: "m", effort: null, schema: false, files }).text, undefined);
  });
});

describe("chart analysis", () => {
  it("checks the real structured reply against the true values", () => {
    const parsed = parseStrictJson(responseText(FIX.chart_structured));
    assert.ok(parsed.ok);
    const a = C.readBarAnalysis(parsed.ok ? parsed.value : null)!;
    const checks = C.checkBars(a.bars);
    assert.equal(checks.length, 6);
    assert.ok(checks.every((c) => c.status === "close" || c.status === "exact"), JSON.stringify(checks));
  });
  it("labels exact, close, wrong, missing, unreadable and extra", () => {
    const checks = C.checkBars(
      [
        { label: "Latte", value: 412 },
        { label: "cold brew", value: 335 },
        { label: "Cappuccino", value: 250 },
        { label: "Americano", value: null },
        { label: "Matcha", value: 90 },
      ],
      C.SAMPLE_CHART.bars,
      0.03,
      ["Tea"],
    );
    assert.deepEqual(
      checks.map((c) => `${c.label}:${c.status}`),
      ["Latte:exact", "Cold brew:close", "Cappuccino:wrong", "Americano:unreadable", "Mocha:missing", "Tea:unreadable", "Matcha:extra"],
    );
    assert.equal(C.checkSummary(checks), "1 of 6 exact, 1 within 3%, 1 wrong, 2 marked unreadable, 1 missing, 1 not on the chart");
  });
  it("covers each printed value and patches the gridline it crosses", () => {
    const rects = C.valueLabelRects();
    assert.equal(rects.length, 6);
    assert.ok(rects.every((r) => r.y > 120 && r.y + r.h < C.SAMPLE_CHART.geometry.zeroY));
    assert.deepEqual(C.gridlinePatches(), [{ x: 499, y: 347, w: 96, h: 2 }]);
    const f = C.summaryFacts({ title: "", unit: "", trend: "down", bars: C.SAMPLE_CHART.bars.map((b) => ({ ...b })), unreadable: [] });
    assert.equal(f.leader?.label, "Latte");
    assert.equal(f.total, 1516);
    assert.equal(f.gap, 71);
  });
});

describe("perception grounding", () => {
  it("reads the real points reply, clamped and deduped", () => {
    const pts = G.readFoodPoints(FIX.grounding);
    assert.ok(pts.length >= 8);
    assert.ok(pts.every((p) => p.x >= 0 && p.x <= 1000 && p.y >= 0 && p.y <= 1000 && p.health_score <= 10));
    const twice = G.dedupePoints([...pts, { ...pts[0], x: pts[0].x + 5 }]);
    assert.equal(twice.removed, 1);
  });
  it("keeps tooltips inside the image", () => {
    assert.deepEqual(G.tooltipBox(10, 10, 200, 100, 400, 600), { left: 4, top: 26 });
    assert.deepEqual(G.tooltipBox(390, 500, 200, 100, 400, 600), { left: 196, top: 384 });
  });
  it("writes a self-contained, escaped overlay", () => {
    const html = G.overlayHtml([{ name: "<b>Milk</b>", x: 500, y: 100, recommended: false, health_score: 3, justification: "Full fat & sugar", calories: 150, carbs_g: 12, protein_g: 8, fat_g: 8 }], "data:image/jpeg;base64,AAAA");
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /left:50%;top:10%;background:#d93025/);
    assert.match(html, /&lt;b&gt;Milk&lt;\/b&gt;/);
    assert.match(html, /tip below/, "a dot near the top opens its tooltip below");
    assert.doesNotMatch(html, /<script/, "no script in the file");
    assert.match(G.pointsPrompt("Keto."), /^Keto\.\n\nFind every distinct food item/);
    assert.match(G.htmlPrompt("Keto.", 853, 1280), /853 x 1280 image/);
  });
});

describe("generating slides", () => {
  it("normalizes the key names models vary", () => {
    const n = S.normalizeOutline({ deck_title: "Agents", sections: [{ heading: "Why", points: "- one\n- two", citations: ["https://a.example/x", "not a url"], code_block: { lang: "py", content: "print(1)" } }] });
    assert.equal(n.outline.title, "Agents");
    assert.deepEqual(n.outline.slides[0].bullets, ["one", "two"]);
    assert.deepEqual(n.outline.slides[0].code, { language: "py", code: "print(1)" });
    assert.deepEqual(n.outline.slides[0].sources, [{ url: "https://a.example/x", title: "a.example" }]);
    assert.deepEqual(n.renamed, ["deck_title -> title", "sections -> slides", "heading -> title", "points -> bullets", "code_block -> code", "citations -> sources"]);
    assert.deepEqual(S.normalizeOutline({ title: "t", slides: [{ title: "s", bullets: ["b"] }] }).renamed, []);
    assert.equal(S.deckFileName("AI Agents in Production"), "ai_agents_in_production_slides.html");
    assert.equal(S.deckSources({ title: "", subtitle: "", slides: [n.outline.slides[0], n.outline.slides[0]] }).length, 1);
  });
});

describe("glimmer gate", () => {
  const q = "How does the US wash sale rule adjust the cost basis of replacement shares?";
  it("matches the page's example: 75 bytes, digest 25db24bf", async () => {
    assert.equal(L.utf8Bytes(q), 75);
    const digest = await L.sha256Hex(q);
    assert.ok(digest.startsWith("25db24bf"));
    assert.equal(L.ruleKey(digest), `remote_model:${digest.slice(0, 16)}`);
    assert.match(L.approvalText(q, "needs current tax-rule specifics beyond local knowledge", "muse-spark-1.3-contributor"), /75 bytes leaves this device\n {4}reason: needs current/);
    assert.equal(L.utf8Bytes("café"), 5, "bytes, not characters");
  });
  it("scopes approvals to one text and keeps content out of the ledger", async () => {
    const key = L.ruleKey(await L.sha256Hex(q));
    const other = L.ruleKey(await L.sha256Hex(`${q} Also, what about IRAs?`));
    let ap: L.Approvals = { session: [], always: [] };
    assert.equal(L.coveredBy(ap, key), null);
    ap = L.remember(ap, key, "session");
    assert.equal(L.coveredBy(ap, key), "session");
    assert.equal(L.coveredBy(ap, other), null, "a different text prompts again");
    assert.deepEqual(L.remember(ap, other, "once"), ap, "once remembers nothing");
    const line = L.ledgerLine({ event: "sent", bytes: 75, digest: "25db24bf70129fc7", model: "muse-spark-1.3-contributor", ms: 1840, ts: "2026-10-30T12:00:00" });
    assert.equal(line, '{"event":"sent","bytes":75,"digest":"25db24bf…","model":"muse-spark-1.3-contributor","ms":1840,"ts":"2026-10-30T12:00:00"}');
    assert.doesNotMatch(line, /wash sale/);
    assert.deepEqual(L.remoteBody("m", q), { model: "m", input: q }, "the approved string, nothing else");
    assert.match(L.notSentMessage("timeout"), /Do not retry/);
  });
  it("has the scenarios the page walks through", () => {
    const wash = L.scenarioById("wash-sale");
    assert.equal(wash.drafts[1].question, q);
    assert.ok(L.scenarioById("secret").drafts[0].question.includes("token="));
    assert.ok(!L.scenarioById("secret").drafts[1].question.includes("token="));
    assert.equal(L.scenarioById("local").drafts.length, 0);
  });
});

describe("recipe browser", () => {
  it("lists the page's fourteen recipes and filters them", () => {
    assert.equal(R.RECIPES.length, 14);
    assert.deepEqual(R.filterRecipes(["computer-use"], "", null).map((r) => r.slug), ["computer-use", "computer-use-macos"]);
    assert.deepEqual(R.filterRecipes([], "", "Hermes").map((r) => r.slug), ["multi-agent-orchestration", "glimmer-api-agent"]);
    assert.equal(R.filterRecipes(["voice"], "glasses", null)[0].slug, "rayban-openclaw");
    const schema = R.pickSchema() as { properties: { picks: { items: { properties: { slug: { enum: string[] } } } } } };
    assert.equal(schema.properties.picks.items.properties.slug.enum.length, 14);
    assert.match(R.pickInstructions(), /- github-agent: GitHub agent\./);
  });
});

describe("game prompts", () => {
  it("swaps the assets section and keeps the fixed shape", () => {
    const text = GD.sectionsText(GD.CROSSY_SECTIONS, true);
    assert.match(text, /^Build a Crossy Road game as a single self-contained index\.html/);
    assert.match(text, /no asset files are available in this environment/);
    assert.doesNotMatch(text, /load the REAL Kenney GLB models/);
    assert.match(GD.sectionsText(GD.CROSSY_SECTIONS, false), /load the REAL Kenney GLB models/);
    assert.match(GD.agentsInstructions(GD.CROSSY_AGENTS_MD), /^The project's AGENTS\.md \(follow it exactly\):\n\n# AGENTS\.md: Crossy Road/);
    assert.equal(GD.agentsInstructions(""), GD.SINGLE_FILE_OUTPUT);
    const check = GD.checkText("Check it.", ["[error] boom"], "title: x");
    assert.match(check, /Browser console:\n\[error\] boom\n\nPage snapshot:\ntitle: x/);
    assert.equal(GD.reviewText("I see a sun.\n```html\n<!doctype html><html></html>\n```"), "I see a sun.");
    assert.equal(GD.SITE_LOOP.probes.length, GD.SITE_LOOP.probeLabels.length);
  });

  it("says what a one-shot build is doing, including the long silence while it thinks", () => {
    const p = { total: 0, callChars: 0, continued: 0, elapsed: "1 min 30 s", usual: "usually four to six minutes in all" };
    assert.equal(GD.buildProgress(p), "Thinking first, which shows no text until the file starts, 1 min 30 s, usually four to six minutes in all");
    assert.equal(GD.buildProgress({ ...p, total: 17503, callChars: 17503, elapsed: "", usual: "" }), "Writing the file: 17,503 characters");
    assert.match(GD.buildProgress({ ...p, total: 17503, continued: 1 }), /^Reached the output limit at 17,503 characters, thinking before it continues the file, 1 min 30 s/);
    assert.match(GD.buildProgress({ ...p, total: 20000, callChars: 2497, continued: 1 }), /^Writing the rest of the file: 20,000 characters, /);
  });
});

describe("retries", () => {
  const none = { transient: 0, rate_limit: 0 };
  it("retries transient errors twice and rate limits up to a minute away", () => {
    assert.deepEqual(retryPlan({ ok: false, status: 503, error: { message: "persistence service error", type: "server_error" } }, none), { kind: "transient", waitMs: 1500 });
    assert.equal(retryPlan({ ok: false, status: 503, error: { message: "x" } }, { transient: 2, rate_limit: 0 }), null, "two retries at most");
    assert.deepEqual(retryPlan({ ok: false, status: 429, error: { message: "busy", code: "model_busy", retryAfterSec: 3 } }, none), { kind: "rate_limit", waitMs: 3400 });
    for (const after of [16, 40, 59, 60]) {
      const plan = retryPlan({ ok: false, status: 429, error: { message: "Live demos are limited to 20 runs a minute.", code: "rate_limited", retryAfterSec: after } }, none);
      assert.deepEqual(plan, { kind: "rate_limit", waitMs: after * 1000 + 400 }, `retry-after ${after} s is waited out`);
    }
    assert.equal(retryPlan({ ok: false, status: 429, error: { message: "a day", code: "rate_limited", retryAfterSec: 3600 * 5 } }, none), null, "the day's limit ends the run");
    assert.equal(retryPlan({ ok: false, status: 429, error: { message: "busy", code: "rate_limited", retryAfterSec: 30 } }, { transient: 0, rate_limit: 3 }), null, "three waits at most");
    assert.equal(retryPlan({ ok: false, status: 429, error: { message: "spent", code: "ip_budget", retryAfterSec: 3 } }, none), null);
    assert.equal(retryPlan({ ok: false, status: 400, error: { message: "bad" } }, none), null);
    assert.equal(retryPlan({ ok: false, status: 0, error: { message: "Stopped", code: "aborted" } }, none), null);
  });
});
