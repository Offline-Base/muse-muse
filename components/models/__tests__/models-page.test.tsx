/**
 * /models: the hosted model catalog as pure functions, then the page itself with the database reads faked. The fake
 * store answers the Lab reads with whole rows, secrets and all, and with jobs the real SQL would leave out, so the page
 * is shown to filter and map on its own. Nothing reaches Neon.
 *
 *   npx tsx --test --experimental-test-module-mocks components/models/__tests__/models-page.test.tsx
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { createElement, type ReactNode } from "react";
import catalog from "@/catalog/meta-models.json";
import { CALL_DAYS, dollars, hostedModelViews, tunedModelViews } from "@/components/models/catalog";
import type { ResultView } from "@/components/train/results";
import { PRICES } from "@/lib/meta/pricing";
import { ggufFileName, levelKey } from "@/lib/train/hub-cards";
import type { LocalFiles } from "@/lib/train/local-files";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (path: string) => new URL(path, import.meta.url).href;

const JOB = "8f1d2c3b-0000-4000-8000-000000000001";
const PRIVATE_JOB = "8f1d2c3b-0000-4000-8000-000000000002";
const QUANT = "9a9a9a9a-0000-4000-8000-000000000003";
const t0 = Date.parse("2026-10-27T14:00:00.000Z");
const SHA = "ab".repeat(32);
const summary = { items: 2, tunedWins: 1, baseWins: 0, ties: 1, avgBaseScore: 4.5, avgTunedScore: 7.5, judgeCostUsd: 0.004 };

/** What a public page must never show. */
const SECRETS = { instanceId: "i-0a1b2c3d4e5f6789", instanceIp: "203.0.113.9", region: "us-secret-1", tokenHash: "hash-of-the-job-token" };
const SECRET_TEXT = /i-0a1b2c3d4e5f6789|203\.0\.113\.9|us-secret-1|hash-of-the-job-token/;

function clean(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(html, SECRET_TEXT);
}

describe("the hosted model catalog", () => {
  it("prints prices the way people read them", () => {
    assert.equal(dollars(4), "$4");
    assert.equal(dollars(0.2), "$0.20");
    assert.equal(dollars(0.1), "$0.10");
    assert.equal(dollars(0.18), "$0.18");
    assert.equal(dollars(0.002), "$0.002");
    assert.equal(dollars(0.0025), "$0.0025");
  });

  it("lists the models Muse Muse calls, Wonder first and Contributor last, each priced and in the catalog", () => {
    const views = hostedModelViews(null);
    assert.deepEqual(
      views.map((m) => m.id),
      ["muse-wonder-1.0", "muse-image-1.0", "sam-3.1", "muse-voice-transcribe-1.0", "muse-spark-1.3-contributor"],
    );
    const hosted = new Set(catalog.models.filter((m) => m.hosted).map((m) => m.id));
    for (const m of views) {
      assert.ok(hosted.has(m.id), `${m.id} is in catalog/meta-models.json`);
      assert.ok(m.id in PRICES, `${m.id} is priced`);
      assert.equal(m.calls, null);
    }
    assert.equal(views.some((m) => m.id === "muse-spark-1.3"), false, "Muse Muse never calls Spark 1.3");
    assert.deepEqual(views.filter((m) => m.testOnly).map((m) => m.id), ["muse-spark-1.3-contributor"]);
    assert.deepEqual(views.filter((m) => m.preview).map((m) => m.id), ["muse-wonder-1.0"]);
  });

  it("prices from lib/meta/pricing.ts", () => {
    const price = Object.fromEntries(hostedModelViews(null).map((m) => [m.id, m.price]));
    assert.equal(price["muse-wonder-1.0"], "$4 in, $0.20 cached, $20 out per million tokens");
    assert.equal(price["muse-spark-1.3-contributor"], "$0.10 in, $0.002 cached, $0.20 out per million tokens");
    assert.equal(price["muse-image-1.0"], "$0.01 per image");
    assert.equal(price["sam-3.1"], "$0.0025 per image, $0.0002 per video frame (50 frames at least)");
    assert.equal(price["muse-voice-transcribe-1.0"], "$0.18 per audio hour");
  });

  it("counts calls per model, zero for a model with none", () => {
    const views = hostedModelViews({ "muse-wonder-1.0": 12, "muse-spark-1.3": 99 });
    assert.equal(views.find((m) => m.id === "muse-wonder-1.0")?.calls, 12);
    assert.equal(views.find((m) => m.id === "sam-3.1")?.calls, 0);
    assert.equal(CALL_DAYS, 30);
  });
});

describe("tuned models", () => {
  const result = (over: Partial<ResultView> = {}): ResultView =>
    ({ id: JOB, title: "Bakery LoRA", recipe: "glimmer-lora", summary, hub: { modelUrl: "https://huggingface.co/mm/bakery", datasetUrl: null }, ...over }) as ResultView;
  const files = (over: Partial<LocalFiles> = {}): LocalFiles =>
    ({ adapterJobId: JOB, quantJobId: QUANT, repo: "mm/bakery-gguf", public: true, files: [{ level: "Q4_K_M", name: "x.gguf", bytes: 1, sha256: SHA }], ...over }) as LocalFiles;

  it("links the Hub and GGUF files only when they are public", () => {
    const [m] = tunedModelViews([result()], new Map([[JOB, files()]]));
    assert.deepEqual(m, {
      id: JOB,
      title: "Bakery LoRA",
      tunedWins: 1,
      items: 2,
      hubUrl: "https://huggingface.co/mm/bakery",
      gguf: { repoUrl: "https://huggingface.co/mm/bakery-gguf", runHref: `/fine-tuning/${JOB}/run` },
      sparkOpen: false,
    });
    assert.equal(tunedModelViews([result({ sparkOpen: true })], new Map())[0].sparkOpen, true, "a model trained from r30b");
    assert.equal(tunedModelViews([result()], new Map([[JOB, files({ public: false })]]))[0].gguf, null);
    assert.equal(tunedModelViews([result()], new Map([[JOB, files({ adapterJobId: PRIVATE_JOB })]]))[0].gguf, null);
    assert.equal(tunedModelViews([result()], new Map([[JOB, files({ files: [] })]]))[0].gguf, null);
    assert.equal(tunedModelViews([result()], new Map([[JOB, files({ repo: "../x" })]]))[0].gguf, null);
    const unpublished = tunedModelViews([result({ hub: null })], new Map([[JOB, files()]]))[0];
    assert.equal(unpublished.hubUrl, null);
    assert.equal(unpublished.gguf, null, "GGUF files go public only after their adapter");
  });

  it("keeps only tuned Glimmer models", () => {
    assert.deepEqual(tunedModelViews([result({ recipe: "smoke" }), result({ id: "b" })], new Map()).map((m) => m.id), ["b"]);
  });
});

// ---------- The page ----------

let db: "ok" | "not_configured" = "ok";
/** Reads that throw, as a database that doesn't answer makes them. */
let failing = new Set<string>();
let jobs: Array<Record<string, unknown>> = [];
let quantSource: Record<string, unknown> | null = null;
let calls: string[] = [];

/** A judged glimmer-lora job as the database holds it, every column filled. */
function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: JOB,
    recipe: "glimmer-lora",
    title: "Bakery LoRA",
    status: "succeeded",
    params: { datasetId: "d", maxSteps: 120, dryRun: 0 },
    instanceType: "gpu_1x_h100_pcie",
    costUsd: 1.66,
    createdAt: new Date(t0 - 60_000),
    launchedAt: new Date(t0),
    finishedAt: new Date(t0 + 39 * 60_000),
    terminatedAt: new Date(t0 + 40 * 60_000),
    evalSummary: summary,
    judgeModel: "muse-wonder-1.0",
    hubLinks: { status: "published", modelUrl: "https://huggingface.co/muse-muse/bakery-lora", datasetUrl: null },
    ...SECRETS,
    ...over,
  };
}

/** A glimmer-quantize job of JOB that passed, its GGUF repo published and public. */
function quantRow(over: { adapterPublic?: boolean } = {}) {
  const slug = "bakery-lora";
  const name = ggufFileName(slug, "Q4_K_M");
  return {
    job: {
      id: QUANT,
      title: "Bakery LoRA local files",
      params: { slug, adapterJobId: JOB },
      hub: { status: "published", modelRepo: "muse-muse/bakery-lora-gguf", modelCommit: "c0ffee", public: true, files: [{ path: name, sha256: SHA }] },
    },
    metrics: { [`${levelKey("Q4_K_M")}_passed`]: "yes", [`${levelKey("Q4_K_M")}_bytes`]: 18_000_000_000, [`${levelKey("Q4_K_M")}_sha256`]: SHA },
    datasetTitle: "Bakery helper",
    adapterPublic: over.adapterPublic ?? true,
  };
}

function fake<A extends unknown[], R>(name: string, fn: (...args: A) => R) {
  return async (...args: A) => {
    calls.push(name);
    if (failing.has(name)) throw new Error(`connect ECONNREFUSED ${SECRETS.instanceIp} ${SECRETS.tokenHash}`);
    return fn(...args);
  };
}

describe("/models", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let render: (node: ReactNode) => string;
  let page: () => Promise<ReactNode>;
  let metadata: { title?: unknown };
  const savedEnv = { ...process.env };

  before(async () => {
    mock.module("next/server", { namedExports: { connection: async () => {} } });
    mock.module("next/link", {
      defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
    });
    mock.module(at("../../../lib/queries.ts"), {
      namedExports: {
        // As the real safeQuery: no database never runs the read, and a read that throws is "unreachable".
        safeQuery: async <T,>(fn: () => Promise<T>) => {
          if (db === "not_configured") return { ok: false, reason: "not_configured", message: "" };
          try {
            return { ok: true, data: await fn() };
          } catch {
            return { ok: false, reason: "unreachable", message: "The database didn't answer." };
          }
        },
        modelCallCounts: fake("modelCallCounts", (since: Date) => {
          assert.ok(Math.abs(Date.now() - since.getTime() - CALL_DAYS * 86_400_000) < 60_000, "the last 30 days");
          return { "muse-wonder-1.0": 1234, "muse-spark-1.3-contributor": 56, "muse-spark-1.3": 999 };
        }),
      },
    });
    mock.module(at("../../../lib/train/store.ts"), {
      namedExports: {
        listResultJobs: fake("listResultJobs", (limit: number) => {
          assert.equal(limit, 20);
          return jobs;
        }),
        latestQuantSource: fake("latestQuantSource", (id: string) => (id === JOB ? quantSource : null)),
      },
    });
    const { renderToString } = await import("react-dom/server");
    render = (node) => renderToString(node as never).replace(/<!-- -->/g, "");
    const mod = await import("@/app/models/page");
    page = mod.default as unknown as () => Promise<ReactNode>;
    metadata = mod.metadata as { title?: unknown };
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
  });

  beforeEach(() => {
    db = "ok";
    jobs = [
      jobRow(),
      jobRow({ id: PRIVATE_JOB, title: "Florist LoRA", hubLinks: null }),
      // Rows the real SQL leaves out: still running, a dry run, another recipe.
      jobRow({ id: "r1", title: "Still running", status: "running", terminatedAt: null }),
      jobRow({ id: "r2", title: "Dry run", params: { dryRun: 1 } }),
      jobRow({ id: "r3", title: "Smoke test", recipe: "smoke" }),
    ];
    quantSource = quantRow();
    calls = [];
    failing = new Set();
  });

  it("has its own title", () => {
    assert.equal(metadata.title, "Models");
  });

  it("lists Meta's hosted models with their uses, prices and calls", async () => {
    const html = render(await page());
    clean(html);
    assert.match(html, /<h1>Models<\/h1>/);
    assert.match(html, /Meta&#x27;s hosted models/);
    for (const name of ["Muse Wonder", "Muse Image", "SAM 3.1", "Muse Voice Transcribe", "Muse Spark 1.3 Contributor"]) {
      assert.match(html, new RegExp(`<span class="row-title">${name}</span>`));
    }
    assert.match(html, /\$4 in, \$0\.20 cached, \$20 out per million tokens/);
    assert.match(html, /\$0\.18 per audio hour/);
    assert.match(html, /Calls, 30 days/);
    assert.match(html, />1,234</);
    assert.match(html, />56</);
    assert.doesNotMatch(html, /999/, "Spark 1.3's own calls aren't a row");
    assert.doesNotMatch(html, /<code>muse-spark-1\.3<\/code>/);
    // The test model is labeled as one, in its own row only.
    const contributor = html.slice(html.indexOf("<code>muse-spark-1.3-contributor</code>")).split("</tr>")[0];
    assert.match(contributor, /Tests and examples only/);
    assert.match(contributor, /tests and examples, which use made-up data/);
    assert.equal(html.match(/Tests and examples only/g)?.length, 1);
  });

  it("shows Glimmer and the tuned models, linking only what is public", async () => {
    const html = render(await page());
    clean(html);
    assert.match(html, /Open models/);
    assert.match(html, /Muse Glimmer 30B/);
    assert.match(html, /Open weights/);
    assert.match(html, /Apache 2\.0/);
    assert.match(html, /href="\/docs\/muse-glimmer"/);
    assert.match(html, new RegExp(`href="/fine-tuning/${JOB}"[^>]*>Bakery LoRA`));
    assert.match(html, new RegExp(`href="/fine-tuning/${PRIVATE_JOB}"[^>]*>Florist LoRA`));
    assert.match(html, /Tuned won <strong>1<\/strong> of 2/);
    assert.match(html, /href="https:\/\/huggingface\.co\/muse-muse\/bakery-lora"[^>]*target="_blank"/);
    assert.match(html, /href="https:\/\/huggingface\.co\/muse-muse\/bakery-lora-gguf"/);
    assert.match(html, new RegExp(`href="/fine-tuning/${JOB}/run"`));
    const florist = html.slice(html.indexOf("Florist LoRA")).split("</tr>")[0];
    assert.match(florist, /<span class="muted">Not public<\/span>/);
    assert.doesNotMatch(html, /Not public yet|coming/i, "no promise that a model goes public, or of more kinds");
    assert.doesNotMatch(html, /Still running|Dry run|Smoke test/);
    // GGUF files are looked up only for the model public on the Hub.
    assert.deepEqual(calls.filter((c) => c === "latestQuantSource"), ["latestQuantSource"]);
  });

  it("says new fine-tunes start from the 2026 Glimmer, and marks a model tuned from it Built with Muse Spark Open", async () => {
    let html = render(await page());
    clean(html);
    assert.match(html, /New fine-tunes start from Muse Muse&#x27;s 2026-knowledge Glimmer,/);
    assert.match(html, /href="https:\/\/huggingface\.co\/OfflineBase\/Glimmer-30B-2026-Knowledge"[^>]*>OfflineBase\/Glimmer-30B-2026-Knowledge<svg/);
    assert.match(html, /are Built with Muse Spark Open, under the Muse Model License\. For people 18 and over only\./);
    assert.doesNotMatch(html, /<span class="chip">Built with Muse Spark Open<\/span>/, "the jobs from before the switch trained on plain Glimmer");
    jobs = jobs.map((j) => (j.id === JOB ? { ...j, params: { ...(j.params as object), baseModel: "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit" } } : j));
    html = render(await page());
    const bakery = html.slice(html.indexOf("Bakery LoRA")).split("</tr>")[0];
    assert.match(bakery, /Muse Glimmer 30B with 2026 knowledge, tuned/);
    assert.match(bakery, /<span class="chip">Built with Muse Spark Open<\/span>/);
    assert.match(bakery, /against the 2026 Glimmer it started from/);
    assert.doesNotMatch(html.slice(html.indexOf("Florist LoRA")).split("</tr>")[0], /Spark Open/);
  });

  it("leaves the GGUF links out while the adapter isn't public", async () => {
    quantSource = quantRow({ adapterPublic: false });
    const html = render(await page());
    assert.doesNotMatch(html, /bakery-lora-gguf|\/run"/);
    assert.match(html, /href="https:\/\/huggingface\.co\/muse-muse\/bakery-lora"/);
  });

  it("says where each kind of model runs", async () => {
    const html = render(await page());
    assert.match(html, /Where they run/);
    assert.match(html, /Meta&#x27;s Model API/);
    assert.match(html, /A rented GPU/);
    assert.match(html, /On a device/);
  });

  it("says when there are no tuned models yet", async () => {
    jobs = [];
    const html = render(await page());
    clean(html);
    assert.match(html, /No tuned models yet/);
    assert.doesNotMatch(html, /Tuned won/);
  });

  it("still lists the hosted models without a database", async () => {
    db = "not_configured";
    const html = render(await page());
    clean(html);
    assert.match(html, /Muse Wonder/);
    assert.match(html, /\$0\.01 per image/);
    assert.doesNotMatch(html, /Calls, 30 days/);
    assert.match(html, /Call counts aren&#x27;t available right now\./);
    assert.match(html, /Not connected yet/);
    assert.deepEqual(calls, []);
  });

  it("still lists the hosted models when the database doesn't answer, showing none of the error", async () => {
    failing = new Set(["modelCallCounts", "listResultJobs"]);
    const html = render(await page());
    clean(html);
    assert.match(html, /<span class="row-title">Muse Wonder<\/span>/);
    assert.match(html, /\$0\.01 per image/);
    assert.doesNotMatch(html, /Calls, 30 days/);
    assert.match(html, /Call counts aren&#x27;t available right now\./);
    assert.match(html, /Can&#x27;t reach the database/);
    assert.match(html, /so the tuned models couldn&#x27;t load/);
    assert.match(html, /Muse Glimmer 30B/);
    assert.match(html, /Where they run/);
    assert.doesNotMatch(html, /ECONNREFUSED|No tuned models yet|Tuned won/);
  });

  it("keeps the tuned models when only the call counts fail, and the counts when only the tuned models fail", async () => {
    failing = new Set(["modelCallCounts"]);
    let html = render(await page());
    clean(html);
    assert.doesNotMatch(html, /Calls, 30 days/);
    assert.match(html, /Tuned won <strong>1<\/strong> of 2/);
    assert.doesNotMatch(html, /Can&#x27;t reach the database/);

    failing = new Set(["listResultJobs"]);
    html = render(await page());
    clean(html);
    assert.match(html, /Calls, 30 days/);
    assert.match(html, />1,234</);
    assert.match(html, /Can&#x27;t reach the database/);
    assert.doesNotMatch(html, /Tuned won/);
  });

  it("leaves only the GGUF links out when their lookup fails", async () => {
    failing = new Set(["latestQuantSource"]);
    const savedError = console.error;
    console.error = () => {};
    try {
      const html = render(await page());
      clean(html);
      assert.match(html, /Tuned won <strong>1<\/strong> of 2/);
      assert.match(html, /href="https:\/\/huggingface\.co\/muse-muse\/bakery-lora"/);
      assert.doesNotMatch(html, /bakery-lora-gguf|\/run"|ECONNREFUSED|Can&#x27;t reach the database/);
    } finally {
      console.error = savedError;
    }
  });
});
