/**
 * The Learn section (app/learn, components/learn/LearnView.tsx, lib/learn.ts): the catalog of Meta's lessons, where each
 * lesson stands, that a product the audit judged wrong is never shown as the lesson's answer, the old /rebuilds
 * redirect, and that the no-ids batch leaves planned lessons alone.
 *
 *   npx tsx --test --experimental-test-module-mocks components/learn/__tests__/learn.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement } from "react";
import resources from "@/catalog/meta-resources.json";
import { LESSONS, lessonCounts, lessonHref, lessonState, longDate, showsProduct } from "@/lib/learn";
import { catalogItems, inDefaultBatch, itemId } from "@/lib/pipeline/catalog";
import { joinRebuilds, rebuildRef } from "@/lib/queries";

/** The Muse API models a lesson may name (the Nov 2 ruling: only Meta models run). */
const META_API_MODELS = new Set(["muse-wonder-1.0", "muse-spark-1.3-contributor", "muse-image-1.0", "muse-voice-transcribe-1.0", "sam-3.1"]);

const canMock = typeof (mock as { module?: unknown }).module === "function";

const t0 = Date.parse("2026-10-28T12:00:00Z");
const build = (id: string, rebuildOf: string, costUsd: number) => ({
  id,
  rebuildOf,
  status: "live" as const,
  startedAt: new Date(t0),
  finishedAt: new Date(t0 + 600_000),
  costUsd,
});
const product = (slug: string, rebuildOf: string, demo: string | null = null) => ({
  slug,
  name: slug.replace(/-/g, " "),
  status: "live" as const,
  liveUrl: `https://musemuse-${slug}.vercel.app`,
  demoVideoUrl: demo,
  demoPosterUrl: null,
  rebuildOf,
});

describe("the lessons catalog", () => {
  it("has all 30 of Meta's videos, each once, with a source and a check date", () => {
    assert.equal(LESSONS.length, 30);
    assert.equal(new Set(LESSONS.map((l) => l.id)).size, 30);
    assert.equal(new Set(LESSONS.map((l) => l.url)).size, 30);
    assert.equal(resources.source, "https://dev.meta.ai/resources/videos/");
    assert.equal(resources.checkedOn, "2026-11-02");
  });

  it("gives every lesson a date, what it teaches, a verdict and a plan marked planned", () => {
    for (const l of LESSONS) {
      assert.match(l.url, /^https:\/\/dev\.meta\.ai\//, l.id);
      assert.match(l.date ?? "", /^\d{4}-\d{2}-\d{2}$/, l.id);
      assert.ok(l.teaches && l.teaches.length > 40, l.id);
      assert.ok(["wrong", "partly wrong", "not built"].includes(l.verdict ?? ""), l.id);
      assert.equal(l.learn?.status, "planned", l.id);
      assert.ok(l.learn?.plan && l.learn.estimate, l.id);
      assert.ok(l.rebuild.note.trim(), l.id);
      assert.equal(l.autoBuild, false, `${l.id} waits on the owner's spend decision`);
      // A lesson with a product names it, and one without has none.
      assert.equal(Boolean(l.current), l.verdict !== "not built", l.id);
    }
  });

  it("uses Meta's own titles for the lessons the audit found retitled", () => {
    const title = (id: string) => LESSONS.find((l) => l.id === id)?.title;
    assert.equal(title("structured-image-extraction"), "How to fine-tune Llama models for structured extraction of data from images");
    assert.equal(title("whatsapp-multimodal-chatbot"), "How to build your own multi-modal WhatsApp chatbot with Llama 4");
    assert.equal(title("docs-to-blog-rag"), "How to quickly generate technical blogs from your docs with Llama and RAG");
    assert.equal(title("llama-protections"), "How to implement Llama Protections to your GenAI applications");
  });

  it("drops the false claim that Muse Muse builds no training runs, and has no em dashes", () => {
    const text = JSON.stringify(resources);
    assert.doesNotMatch(text, /builds apps, not training runs/);
    assert.doesNotMatch(text, /—/);
  });

  it("keeps real products on Muse Wonder: no plan runs on Muse Spark 1.3 standard", () => {
    for (const l of LESSONS) {
      assert.ok(!l.rebuild.models.includes("muse-spark-1.3"), l.id);
      assert.ok(!l.learn?.models.includes("muse-spark-1.3"), l.id);
    }
  });

  it("plans only Meta models: every tune is Muse Glimmer, and no plan runs Llama, a guard model or a non-Meta helper", () => {
    // The organizers' Nov 2 ruling: Llama (Llama Guard and Prompt Guard too), LFM, Bolt, SpeechT5 and the like don't
    // count as Meta models. Meta's own titles and what its videos teach may name Llama; what Muse Muse plans to run may not.
    const nonMeta = /Llama 3\.2|\b[13]B\b|Prompt Guard 2 score|LFM|Bolt|Nemotron|SpeechT5|open speech model|Kaggle/i;
    for (const l of LESSONS) {
      const plan = l.learn!;
      if (plan.tune) assert.match(plan.tune, /Muse Glimmer 30B/, l.id);
      for (const text of [plan.title, plan.plan, plan.tune ?? "", plan.estimate, ...(plan.unverified ?? []), l.rebuild.plan, l.rebuild.note]) {
        assert.doesNotMatch(text, nonMeta, `${l.id}: ${text}`);
      }
      // Build muses never ask for a Llama.
      assert.doesNotMatch(l.rebuild.note, /Llama/, l.id);
      // Every model a plan or a build names is a Muse API model.
      for (const m of [...plan.models, ...l.rebuild.models]) assert.ok(META_API_MODELS.has(m), `${l.id}: ${m}`);
      // A build muse that asks for a model on the person's own machine names Muse Glimmer, so a builder never picks
      // a non-Meta local model (an Ollama default, a small open model) for it.
      if (/ollama|localhost|no internet|internet is cut|offline|own (Mac|Linux|Windows)|small model|Windows laptop/i.test(l.rebuild.note)) {
        assert.match(l.rebuild.note, /Muse Glimmer/, `${l.id}: ${l.rebuild.note}`);
      }
    }
    const protection = LESSONS.find((l) => l.id === "protection-tools")!;
    assert.equal(protection.learn?.tune, null);
    assert.doesNotMatch(protection.rebuild.note, /Prompt Guard/);
    assert.equal(LESSONS.find((l) => l.id === "llama-protections")?.learn?.tune, null, "the optional guard tune is dropped");
    const run = (id: string) => LESSONS.find((l) => l.id === id)?.learn?.title;
    assert.equal(run("running-llama-3-on-linux"), "Run a tuned Glimmer file on Linux");
    assert.equal(run("run-llama-on-mac"), "Run a tuned Glimmer file on your Mac");
  });
});

describe("where a lesson stands", () => {
  const wrong = LESSONS.find((l) => l.id === "structured-image-extraction")!;
  const partly = LESSONS.find((l) => l.id === "docs-to-blog-rag")!;
  const none = LESSONS.find((l) => l.id === "github-issue-triage")!;
  const card = (slug: string, status = "live") =>
    ({ product: { slug, name: slug, status, liveUrl: null, demoVideoUrl: null, demoPosterUrl: null } }) as never;

  it("never shows the product the audit judged wrong", () => {
    assert.equal(lessonState(wrong, card("receipt-form-reader")), "redo");
    assert.equal(lessonState(wrong, undefined), "redo");
    assert.equal(showsProduct("redo"), false);
  });

  it("shows a partly-there product, and a new build as not checked yet", () => {
    assert.equal(lessonState(partly, card("doc-to-blog-drafts")), "partly");
    assert.equal(lessonState(partly, card("doc-to-blog-drafts", "failed")), "not-built");
    assert.equal(lessonState(wrong, card("receipt-reader-tuned")), "new-build");
    assert.equal(lessonState(none, card("issue-triage-board")), "new-build");
    assert.equal(lessonState(none, null), "not-built");
  });

  it("keeps the audit's partly-there state when the rows can't be read", () => {
    assert.equal(lessonState(partly, null, false), "partly");
    assert.equal(lessonState(wrong, null, false), "redo");
    assert.equal(lessonState(none, null, false), "not-built");
    const counts = lessonCounts(LESSONS.map((l) => lessonState(l, null, false)));
    assert.deepEqual(counts, { "new-build": 0, partly: 4, redo: 2, "not-built": 24 });
  });

  it("counts the catalog as the audit found it", () => {
    const counts = lessonCounts(LESSONS.map((l) => lessonState(l, null)));
    // With no products read, partly-there lessons fall back to not built.
    assert.deepEqual(counts, { "new-build": 0, partly: 0, redo: 2, "not-built": 28 });
  });

  it("writes dates with the year", () => {
    assert.equal(longDate("2025-11-04"), "Nov 4, 2025");
    assert.equal(longDate("soon"), "soon");
  });
});

describe("links back to a lesson", () => {
  it("names the lesson and the audit's verdict on the product it judged, and none for a first demo", () => {
    const ref = rebuildRef("structured-image-extraction");
    assert.equal(ref?.learnHref, "/learn#lesson-structured-image-extraction");
    assert.deepEqual(ref?.verdict, { label: "Doesn't teach the lesson", product: "receipt-form-reader" });
    assert.deepEqual(rebuildRef("docs-to-blog-rag")?.verdict, { label: "Partly teaches the lesson", product: "doc-to-blog-drafts" });
    assert.equal(rebuildRef("github-issue-triage")?.verdict, null);
    assert.equal(rebuildRef("sam-first-demo")?.learnHref, null);
    assert.equal(lessonHref("x"), "/learn#lesson-x");
  });

  it("lists the llama stack lesson with the listing's date, since Meta's page 404s", () => {
    const l = LESSONS.find((x) => x.id === "llama-stack-rag-agent")!;
    assert.equal(l.date, "2025-04-01");
    assert.match(l.pageNote ?? "", /404/);
  });
});

describe("the no-ids batch", () => {
  it("leaves every planned lesson out and keeps the first demos in", () => {
    const picked = catalogItems().filter(inDefaultBatch).map(itemId);
    assert.deepEqual(picked, resources.missing.map((m) => m.id));
  });
});

describe("pages", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let render: (data: ReturnType<typeof joinRebuilds>, admin?: boolean, connected?: boolean) => string;
  const redirects: string[] = [];

  before(async () => {
    mock.module("next/navigation", {
      namedExports: {
        useRouter: () => ({ refresh() {} }),
        permanentRedirect: (path: string) => {
          redirects.push(path);
          throw new Error(`permanentRedirect ${path}`);
        },
      },
    });
    mock.module("next/link", {
      defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
    });
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { LearnView } = await import("@/components/learn/LearnView");
    render = (data, admin = false, connected = true) =>
      renderToStaticMarkup(
        createElement(LearnView, {
          lessons: LESSONS,
          data,
          connected: connected ? { ok: true } : { ok: false, reason: "not_configured" },
          admin,
          source: resources.source,
          checkedOn: resources.checkedOn,
        }),
      ).replaceAll("&#x27;", "'");
  });

  /** The markup of one lesson's card. */
  function cardOf(html: string, id: string): string {
    const start = html.indexOf(`data-lesson="${id}"`);
    assert.ok(start > 0, `${id} has a card`);
    return html.slice(start, html.indexOf("</article>", start));
  }

  it("/rebuilds sends old links to /learn for good", async () => {
    const { default: RebuildsPage } = await import("@/app/rebuilds/page");
    assert.throws(() => RebuildsPage(), /permanentRedirect \/learn/);
    assert.deepEqual(redirects, ["/learn"]);
  });

  it("draws one card per lesson with Meta's link, presenter, date and the plan marked planned", () => {
    const html = render(joinRebuilds([], []));
    assert.equal(html.match(/data-lesson="/g)?.length, 30);
    const c = cardOf(html, "whatsapp-multimodal-chatbot");
    assert.match(c, /href="https:\/\/dev\.meta\.ai\/llama\/resources\/videos\/build-multi-modal-whatsapp-chatbot-with-llama-4"/);
    assert.match(c, /Nilesh Pandey, Partner Engineer at Meta · Nov 4, 2025/);
    assert.match(c, /What it teaches\./);
    assert.match(c, /Planned<\/span> <strong>A messaging bot/);
    assert.match(c, /Estimated cost to redo: About \$3 to \$6/);
    assert.match(html, /<strong>30 lessons<\/strong>: 2 being redone, 28 not built yet/);
    assert.doesNotMatch(html, /6 of 6|rebuilt in/);
    assert.doesNotMatch(html, /Build its product/, "no build buttons for visitors");
    assert.match(c, /^data-lesson="whatsapp-multimodal-chatbot"/);
    assert.match(html, /id="lesson-whatsapp-multimodal-chatbot"/);
  });

  it("shows a partly-there product with its demo, and hides the one judged wrong", () => {
    const html = render(
      joinRebuilds(
        [build("b1", "structured-image-extraction", 1.96), build("b2", "docs-to-blog-rag", 1.66)],
        [
          product("receipt-form-reader", "structured-image-extraction", "/demo/receipt.mp4"),
          product("doc-to-blog-drafts", "docs-to-blog-rag", "/demo/blog.mp4"),
        ],
      ),
      true,
    );
    const wrong = cardOf(html, "structured-image-extraction");
    assert.match(wrong, /data-state="redo"/);
    assert.match(wrong, /Wrong, being redone/);
    assert.match(wrong, /isn't shown here as the lesson's answer/);
    assert.doesNotMatch(wrong, /receipt\.mp4|\/p\/receipt-form-reader|musemuse-receipt-form-reader|Latest build/);

    const partly = cardOf(html, "docs-to-blog-rag");
    assert.match(partly, /Partly there/);
    assert.match(partly, /src="\/demo\/blog\.mp4"/);
    assert.match(partly, /href="\/p\/doc-to-blog-drafts"/);
    assert.match(partly, /no retrieval at all/);
    assert.match(partly, /1 attempt, 10 m and \$1\.66 est\. in all/);
    assert.match(partly, /Build its product again/);
    assert.match(html, /<strong>30 lessons<\/strong>: 1 partly there, 2 being redone, 27 not built yet/);
  });

  it("shows the audit's record, without products, when the rows can't be read", () => {
    const html = render(joinRebuilds([], []), false, false);
    const partly = cardOf(html, "docs-to-blog-rag");
    assert.match(partly, /data-state="partly"/);
    assert.match(partly, /no retrieval at all/);
    assert.doesNotMatch(partly, /Nothing built for this lesson yet|href="\/p\//);
    assert.match(html, /<strong>30 lessons<\/strong>: 4 partly there, 2 being redone, 24 not built yet/);
  });
});
