import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { BUILD_CONTEXT_MAX, blankWish, buildContext, buildIdeas, splitBuildNote } from "@/lib/docs/build-note";
import { DOCS_PAGES } from "@/lib/docs/pages";

// The demo registry loads every group's client components, so a load hook stands in for their CSS modules.
const CSS_HOOK = `export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) {
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_t, k) => String(k) })" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(CSS_HOOK)}`, import.meta.url);

const page = {
  slug: "tool-calling",
  title: "Tool calling",
  description: "Let the model call your functions.",
  markdownUrl: "https://dev.meta.ai/docs/tool-calling.md",
};

test("the context names the feature, how to use it, its facts and the docs", () => {
  const out = buildContext({
    page,
    spec: { task: "Add tool calling.", facts: ["Resend tools with every request."] },
    lastRequest: null,
  });
  assert.match(out, /Tool calling\./);
  assert.match(out, /How to use it: Add tool calling\./);
  assert.match(out, /- Resend tools with every request\./);
  assert.match(out, /https:\/\/dev\.meta\.ai\/docs\/tool-calling\.md/);
});

test("the context says what the reader just ran, but never what they typed", () => {
  const out = buildContext({
    page,
    spec: null,
    lastRequest: { method: "POST", path: "responses", body: { input: "my private question" }, model: "muse-wonder-1.0" },
  });
  assert.match(out, /I just tried POST \/v1\/responses in the docs on muse-wonder-1\.0\./);
  assert.doesNotMatch(out, /private question/);
});

test("muse-spark-1.3 is never named, and the contributor id isn't changed", () => {
  const out = buildContext({
    page,
    spec: { task: "Use muse-spark-1.3 here, or muse-spark-1.3-contributor.", facts: ["muse-spark-1.3 takes images."] },
    lastRequest: { method: "POST", path: "responses", model: "muse-spark-1.3" },
  });
  assert.doesNotMatch(out, /muse-spark-1\.3(?!-contributor)/);
  assert.doesNotMatch(out, /contributor-contributor/);
});

test("a page about the weights or the muse CLI leaves out its how-to and says a hosted model stands in", () => {
  const out = buildContext({
    page: { ...page, slug: "muse-glimmer/deploy", title: "Deploy Muse Glimmer" },
    spec: { task: "Self-host it on my GPU.", facts: ["Needs 24 GB."] },
    lastRequest: null,
  });
  assert.doesNotMatch(out, /Self-host it|Needs 24 GB/);
  assert.match(out, /closest hosted model/);
  const hosted = buildContext({
    page: { ...page, slug: "muse-glimmer/deploy" },
    spec: { task: "Call the hosted API.", setup: "hosted" },
    lastRequest: null,
  });
  assert.match(hosted, /Call the hosted API/);
});

test("every mirrored page gets a context that fits, without em dashes, and three ideas", async () => {
  const { demoFor } = await import("@/lib/docs/demos");
  assert.ok(DOCS_PAGES.length > 100);
  for (const p of DOCS_PAGES) {
    const context = buildContext({ page: p, spec: demoFor(p.slug)?.agentPrompt ?? null, lastRequest: { method: "POST", path: "responses", model: "muse-spark-1.3-contributor" } });
    assert.ok(context.length <= BUILD_CONTEXT_MAX, `${p.slug}: ${context.length}`);
    assert.ok(context.includes(p.markdownUrl), `${p.slug} keeps its docs link`);
    assert.doesNotMatch(context, /—/, p.slug);
    assert.doesNotMatch(context, /muse-spark-1\.3(?!-contributor)/, p.slug);
    const ideas = buildIdeas(p.slug);
    assert.equal(ideas.length, 3, p.slug);
    for (const idea of ideas) assert.doesNotMatch(`${idea.label} ${idea.note}`, /—/);
  }
});

test("ideas fit the page", () => {
  assert.match(buildIdeas("sam/overview")[0].label, /Background/);
  assert.match(buildIdeas("cookbook/video-to-sticker-pack")[1].label, /Sticker/);
  assert.match(buildIdeas("cookbook/generating-slides")[0].label, /deck/);
  assert.match(buildIdeas("image-understanding")[0].label, /Fridge/);
  assert.match(buildIdeas("image-generation")[0].label, /Product photo/);
  assert.match(buildIdeas("api-reference/voice/transcribe")[0].label, /Voice memo/);
  assert.match(buildIdeas("tool-calling")[0].label, /Trip/);
  assert.match(buildIdeas("muse-glimmer/quantization")[0].label, /computer/);
  assert.match(buildIdeas("overview")[0].label, /Writing/);
});

test("an empty box still asks for something real", () => {
  assert.match(blankWish("Tool calling"), /"Tool calling"/);
});

test("the build room can tell the reader's words from what the page added", () => {
  const context = buildContext({ page, spec: null, lastRequest: null });
  assert.deepEqual(splitBuildNote(`Make a bakery app.\n\nSecond line.\n\n${context}`), { wish: "Make a bakery app.\n\nSecond line.", context });
  assert.deepEqual(splitBuildNote("Just a note."), { wish: "Just a note.", context: null });
});
