/**
 * A decision model's Try it live box (docs/DECISION_MODELS.md "On the lab's GPU", D7), server-rendered with made-up
 * tickets outside Next: the box in each state, both picks with every label's probability and honest confidence, the
 * public result page and the admin job page choosing it over the chat box, Start a live demo's wording, the New job
 * card's adapter select, and the browser call to POST /api/lab/{id}/decide against a faked fetch. The router and Link
 * are stand-ins. Nothing reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/train/__tests__/decide-try.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import type { DecideTryAnswer, DecideTryPick } from "@/lib/decide/types";
import type { AdapterOption } from "@/lib/train/types";
import { ticketDecision } from "./decision-fixture";

mock.module("next/navigation", {
  namedExports: { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/fine-tuning" },
});
mock.module("next/link", {
  defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
});

const t0 = Date.parse("2026-10-31T14:00:00.000Z");
const iso = (ms: number) => new Date(t0 + ms).toISOString();
const JOB = "d0d0d0d0-0000-4000-8000-000000000001";
const SERVE = "5e7e5e7e-0000-4000-8000-00000000000a";
const tickets = ticketDecision();

let render: (c: ComponentType<never>, props: object) => string;
let C: Record<string, ComponentType<never>>;
let f: typeof import("@/components/train/format");
let tryLive: typeof import("@/components/train/tryLive");
let adaptersFor: typeof import("@/components/train/NewJobCard").adaptersFor;

before(async () => {
  const { renderToString } = await import("react-dom/server");
  render = (c, props) => renderToString(createElement(c, props as never)).replace(/<!-- -->/g, "");
  const box = await import("@/components/train/DecideTry");
  const live = await import("@/components/train/LiveDemo");
  const card = await import("@/components/train/NewJobCard");
  C = {
    DecideTryCard: box.DecideTryCard as ComponentType<never>,
    DecideAnswers: box.DecideAnswers as ComponentType<never>,
    AdapterLiveDemo: live.AdapterLiveDemo as ComponentType<never>,
    StartLiveDemo: live.StartLiveDemo as ComponentType<never>,
    JobResults: (await import("@/components/train/JobResults")).JobResults as ComponentType<never>,
  };
  f = await import("@/components/train/format");
  tryLive = await import("@/components/train/tryLive");
  adaptersFor = card.adaptersFor;
});

function clean(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(html, /\/api\/train|8443|serveKey|certSha256|203\.0\.113\.9/, "nothing about the GPU");
  for (const row of tickets.rows.test.slice(0, 5)) assert.ok(!html.includes(row.input), "never a row of the dataset");
}

const model = () => f.decideTryModel(tickets.spec, tickets.summary)!;

const pick = (over: Partial<DecideTryPick> = {}): DecideTryPick => ({
  decision: "Billing",
  id: "billing",
  confidence: 0.91,
  probabilities: [
    { option: "Billing", id: "billing", p: 0.91 },
    { option: "Shipping", id: "shipping", p: 0.04 },
    { option: "Account", id: "account", p: 0.02 },
    { option: "Returns", id: "returns", p: 0.01 },
  ],
  none: 0.02,
  calibrated: true,
  mass: 0.97,
  ...over,
});

describe("a decision model's Try it live box", () => {
  const card = (demo: object, extra: object = {}) => render(C.DecideTryCard, { adapterJobId: JOB, demo, model: model(), serverNow: t0, ...extra });

  it("opens while the demo is live: the question, the labels and none, an input of up to 3,000 characters", () => {
    const html = card({ state: "live", minutes: 30, endsAt: iso(23 * 60_000) });
    clean(html);
    assert.match(html, /<h2 id="[^"]+">Try it live<\/h2>/);
    assert.match(html, /class="pill pill-live">.*Live<\/span>/);
    assert.match(html, /23 minutes left/);
    assert.match(html, /Base Muse Glimmer 30B and this decision model each pick one label for it on the same GPU/);
    assert.match(html, /<span class="train-label">The question<\/span><span>Which team should handle this support ticket\?<\/span>/);
    assert.deepEqual([...html.matchAll(/<li class="chip[^"]*">([^<]+)<\/li>/g)].map((m) => m[1]), ["Billing", "Shipping", "Account", "Returns", "None of the listed options matches"]);
    assert.match(html, /<label class="train-label" for="([^"]+)">Your input<\/label><textarea id="\1"/);
    assert.match(html, /maxLength="3000"/);
    assert.match(html, /0 \/ 3,000/);
    assert.match(html, /<button type="submit" class="btn btn-primary" disabled="">.*Decide<\/span>/);
    assert.doesNotMatch(html, /action=|method=|Ask both models|app idea/);
    // The honest line: a small model, its own test rows, and that it can be wrong.
    const right = tickets.summary.tuned!.accuracy;
    assert.match(html, new RegExp(`A small model trained on ${tickets.spec.split.train} of its dataset&#x27;s examples\\. On ${right.total} held-out examples it never saw, it was right on ${right.right} \\(${Math.round(right.rate * 100)}%\\); base Glimmer on ${tickets.summary.base.accuracy.right}\\. It can be wrong: check anything that matters\\.`));
    assert.doesNotMatch(html, /Open the demo/, "no serve job link on the public page");
    assert.match(card({ state: "live", minutes: 30, endsAt: iso(60_000) }, { serveJobId: SERVE }), new RegExp(`href="/fine-tuning/${SERVE}">Open the demo`));
  });

  it("waits while it starts, and closes once its time is up", () => {
    const starting = card({ state: "starting", minutes: 20, endsAt: null });
    assert.match(starting, /pill-building.*Starting/);
    assert.match(starting, /this box opens for 20 minutes/);
    assert.match(starting, /<button type="submit" class="btn btn-primary" disabled="">/);
    const ended = card({ state: "live", minutes: 30, endsAt: iso(-1000) });
    assert.match(ended, /pill-neutral.*Ended/);
    assert.match(ended, /This live demo has ended/);
    assert.match(ended, /<textarea[^>]*disabled=""/);
  });

  it("shows both picks side by side with every label's probability, and says confidence honestly", () => {
    const answer: DecideTryAnswer & { input: string } = {
      input: "<b>charged twice</b>",
      base: pick({ decision: "Shipping", id: "shipping", confidence: 0.55, calibrated: false, probabilities: pick().probabilities.map((p) => ({ ...p, p: p.id === "shipping" ? 0.55 : 0.1 })), none: 0.15 }),
      tuned: pick(),
      ms: 840,
    };
    const html = render(C.DecideAnswers, { idBase: "d", answer });
    clean(html);
    assert.match(html, /<p class="train-text lab-decide-input">&lt;b&gt;charged twice&lt;\/b&gt;<\/p>/, "the input is text, never HTML");
    assert.ok(html.indexOf("Base Glimmer") < html.indexOf("Decision model"), "base on the left");
    assert.match(html, /<section class="lab-try-answer lab-try-tuned" aria-labelledby="d-tuned"><h3 class="train-role" id="d-tuned">Decision model<\/h3><p class="lab-decide-pick">Billing<\/p><p class="muted small">Confidence: about 9 in 10\.<\/p>/);
    assert.match(html, /<p class="lab-decide-pick">Shipping<\/p><p class="muted small">Confidence: 55%, the model&#x27;s own probability, not calibrated\.<\/p>/);
    assert.match(html, /<li class="lab-decide-picked"><span class="lab-decide-name">Billing<\/span><span class="lab-decide-track" aria-hidden="true"><span class="lab-decide-fill" style="width:91%"><\/span><\/span><span class="lab-decide-p">91%<\/span><\/li>/);
    assert.match(html, /<span class="lab-decide-name">None of the listed options matches<\/span>.*<span class="lab-decide-p">2%<\/span>/);
    assert.match(html, /Both decided in 0\.8 s on the demo&#x27;s GPU\./);
    assert.match(html, /style="width:55%"/, "widths to one decimal");

    // When none wins, it says so.
    const declined = render(C.DecideAnswers, { idBase: "n", answer: { ...answer, tuned: pick({ decision: null, id: null, confidence: 0.7, none: 0.7 }) } });
    assert.match(declined, /<p class="lab-decide-pick">None of the listed options matches<\/p>/);
    assert.match(declined, /<li class="lab-decide-picked"><span class="lab-decide-name">None of the listed options matches/);
  });

  it("replaces the chat box on a decision model's public result page, and nothing else changes", () => {
    const result = {
      id: JOB,
      title: "Ticket router LoRA",
      recipe: "glimmer-lora",
      recipeTitle: "Muse Glimmer LoRA",
      model: "Muse Glimmer 30B",
      gpu: "1x A100 SXM4 (40 GB)",
      gpuMinutes: 25,
      costUsd: 0.83,
      finishedAt: iso(0),
      summary: tickets.summary,
      decision: tickets.summary,
      settings: [],
      datasetId: null,
    };
    const live = { state: "live", minutes: 30, endsAt: iso(600_000) };
    const html = render(C.JobResults, { result, rows: [], dataset: null, live, serverNow: t0, decideTry: model() });
    clean(html);
    assert.match(html, /Your input/);
    assert.doesNotMatch(html, /Your app idea|Ask both models/);
    // A chat model's page is as it was.
    const chat = render(C.JobResults, { result: { ...result, decision: undefined }, rows: [], dataset: null, live, serverNow: t0 });
    assert.match(chat, /Your app idea/);
    assert.doesNotMatch(chat, /Your input/);
  });

  it("gives an admin the box with its serve job, and Start a live demo in a decision model's words", () => {
    const demo = { serveJobId: SERVE, state: "live", minutes: 30, endsAt: iso(600_000) };
    const html = render(C.AdapterLiveDemo, { jobId: JOB, live: { kind: "demo", demo, decideTry: model() }, serverNow: t0 });
    assert.match(html, /Your input/);
    assert.match(html, new RegExp(`/fine-tuning/${SERVE}`));
    const chat = render(C.AdapterLiveDemo, { jobId: JOB, live: { kind: "demo", demo }, serverNow: t0 });
    assert.match(chat, /Your app idea/);

    const props = { adapterJobId: JOB, adapterTitle: "Ticket router", ceilings: { maxMinutes: 120, maxUsd: 5 }, maxActive: 1, dailyUsd: 20 };
    const start = render(C.StartLiveDemo, { ...props, decide: true });
    clean(start);
    assert.match(start, /Anyone with this page&#x27;s link can then type an input and see base Glimmer and this decision model each pick a label for it, with no sign-in\./);
    assert.match(render(C.StartLiveDemo, { ...props, decide: true, publicPage: false }), /This job isn&#x27;t scored yet/);
    assert.match(render(C.StartLiveDemo, props), /type an app idea and see base and tuned Glimmer answer it side by side/, "a chat adapter's words are as they were");
  });
});

describe("the box's helpers and its call", () => {
  it("builds its model from a spec and a summary, numbers and names only", () => {
    const m = model();
    assert.deepEqual(m.labels, tickets.spec.labels.map((l) => ({ id: l.id, name: l.name })));
    assert.equal(m.trainRows, tickets.spec.split.train);
    assert.deepEqual(m.accuracy, { tuned: tickets.summary.tuned!.accuracy, base: tickets.summary.base.accuracy });
    assert.equal(f.decideTryModel(tickets.spec, null)!.accuracy, null, "not scored yet");
    assert.equal(f.decideTryNote(f.decideTryModel(tickets.spec, null)!), `A small model trained on ${tickets.spec.split.train} of its dataset's examples. It can be wrong: check anything that matters.`);
    assert.equal(f.decideTryModel(null, tickets.summary), null);
  });

  it("says confidence as about N in 10 only when T was fit", () => {
    assert.deepEqual(
      [0.91, 0.55, 0.96, 0.03, 0.149].map((p) => f.confidenceText(p, true)),
      ["about 9 in 10", "about 6 in 10", "more than 9 in 10", "less than 1 in 10", "about 1 in 10"],
    );
    assert.equal(f.confidenceText(0.62, false), "62%, the model's own probability, not calibrated");
    assert.equal(f.confidenceText(Number.NaN, false), "0%, the model's own probability, not calibrated");
  });

  it("reads the route's refusals as sentences, and only whole answers as answers", () => {
    assert.match(f.decideTryErrorText(409, { error: "busy" }), /deciding someone else's input right now/);
    assert.match(f.decideTryErrorText(429, { error: "rate_limited", scope: "ip", retryAfterSeconds: 300 }), /as many inputs as the demo takes from you for now\. Try again in 5 minutes\./);
    assert.match(f.decideTryErrorText(429, { error: "rate_limited", scope: "demo" }), /as many inputs as it takes this hour/);
    assert.equal(f.decideTryErrorText(504, { error: "timeout" }), "The GPU didn't answer within 30 seconds. Try again.");
    assert.equal(f.decideTryErrorText(404, { error: "no_live_demo" }), "This live demo has ended, so no GPU is answering now.");
    assert.equal(f.decideTryErrorText(400, { error: "Keep the input to 3,000 characters." }), "Keep the input to 3,000 characters.");
    assert.equal(f.decideTryErrorText(400, { error: "bad_input" }), "Check the input and try again.");
    const whole = { base: pick(), tuned: pick(), ms: 12 };
    assert.deepEqual(f.decideTryAnswerOf(whole), whole);
    for (const bad of [null, {}, { ...whole, tuned: { ...pick(), confidence: "high" } }, { ...whole, base: { ...pick(), probabilities: [{ option: "x" }] } }]) {
      assert.equal(f.decideTryAnswerOf(bad), null, JSON.stringify(bad));
    }
  });

  it("posts one input to POST /api/lab/{id}/decide and reads the picks, the refusals and a timeout", async () => {
    const sent: Array<{ url: string; body: string }> = [];
    const answer = { base: pick(), tuned: pick({ decision: "Shipping", id: "shipping" }), ms: 640 };
    const ok = await tryLive.askDecideDemo(JOB, "  my parcel is late  ", {
      fetch: async (url, init) => {
        sent.push({ url, body: String(init?.body) });
        return Response.json(answer);
      },
    });
    assert.deepEqual(ok, { ok: true, answer });
    assert.deepEqual(sent, [{ url: `/api/lab/${JOB}/decide`, body: JSON.stringify({ state: "my parcel is late" }) }]);
    const ended = await tryLive.askDecideDemo(JOB, "x", { fetch: async () => Response.json({ error: "no_live_demo" }, { status: 404 }) });
    assert.deepEqual(ended, { ok: false, message: "This live demo has ended, so no GPU is answering now.", ended: true });
    const partial = await tryLive.askDecideDemo(JOB, "x", { fetch: async () => Response.json({ base: pick() }) });
    assert.equal(partial.ok, false);
    assert.equal((await tryLive.askDecideDemo(JOB, "   ")).ok, false, "nothing sent without an input");
    const slow = await tryLive.askDecideDemo(JOB, "x", {
      waitMs: 20,
      fetch: (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    });
    assert.deepEqual(slow, { ok: false, message: "The GPU didn't answer within 30 seconds. Try again.", ended: false });
  });

  it("offers a decision model's adapter to a live demo only", () => {
    const chat: AdapterOption = { jobId: "c", title: "Brief writer", region: "us-east-1", datasetTitle: null, finishedAt: null, evalSummary: null };
    const decide: AdapterOption = { ...chat, jobId: "d", title: "Ticket router LoRA", mode: "decide", evalSummary: tickets.summary };
    assert.deepEqual(adaptersFor("glimmer-serve", [decide, chat]).map((a) => a.jobId), ["d", "c"]);
    for (const recipe of ["glimmer-quantize", "glimmer-publish", undefined]) {
      assert.deepEqual(adaptersFor(recipe, [decide, chat]).map((a) => a.jobId), ["c"], String(recipe));
    }
    const right = tickets.summary.tuned!.accuracy;
    assert.equal(f.adapterOptionText(decide), `Ticket router LoRA · decision model · tuned right on ${right.right} of ${right.total} · us-east-1`);
    assert.equal(f.adapterOptionText(chat), "Brief writer · us-east-1", "a chat adapter's text is as it was");
  });
});
