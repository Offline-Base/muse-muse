/**
 * Local files in the UI (docs/TRAINING.md "Local files"), server-rendered with sample data outside Next: a local files
 * job's own card while it runs, once its files are on the Hub, published public or private, and after it failed, with
 * each build's size, closeness and result, the channel check, the agreement and Publish, Retry or Publish again; Make
 * local files on a judged adapter's page as it opens; where the job page puts each card; and the text helpers behind
 * them for every state GET /api/train/jobs/{id}/quantize answers. The router and Link are stand-ins. Nothing reaches
 * the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/train/__tests__/local-files.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import type { LocalFiles } from "@/lib/train/local-files";
import type { EvalSummary, HubView, RecipeView, TrainEventView, TrainJobView } from "@/lib/train/types";

mock.module("next/navigation", {
  namedExports: { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/fine-tuning" },
});
mock.module("next/link", {
  defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
});

const t0 = Date.parse("2026-10-28T03:00:00.000Z");
const iso = (min: number) => new Date(t0 + min * 60_000).toISOString();
const ADAPTER = "83d71f74-d84b-40bf-925a-cd36c90b6de5";
const QUANT = "4c4c4c4c-0000-4000-8000-00000000000c";
const REPO = "muse-org/muse-glimmer-30b-brief-writer-gguf-83d71f74";
const won: EvalSummary = { items: 40, tunedWins: 40, baseWins: 0, ties: 0, avgBaseScore: 1.95, avgTunedScore: 8.88, judgeCostUsd: 0.15 };
const NOT_UPLOADED = "Not every GGUF file reached Hugging Face before the job ended, and the files were only on its GPU. Make local files again.";

let render: (c: ComponentType<never>, props: object) => string;
let QuantFilesCard: ComponentType<never>;
let MakeLocalFiles: ComponentType<never>;
let JobRoom: ComponentType<never>;
let recipes: RecipeView[];
let format: typeof import("@/components/train/format");

before(async () => {
  const { renderToString } = await import("react-dom/server");
  render = (c, props) => renderToString(createElement(c, props as never)).replace(/<!-- -->/g, "");
  const cards = await import("@/components/train/LocalFiles");
  QuantFilesCard = cards.QuantFilesCard as ComponentType<never>;
  MakeLocalFiles = cards.MakeLocalFiles as ComponentType<never>;
  JobRoom = (await import("@/components/train/JobRoom")).JobRoom as ComponentType<never>;
  format = await import("@/components/train/format");
  const { RECIPES } = await import("@/lib/train/recipes");
  recipes = RECIPES.map(format.toRecipeView);
});

function quantJob(over: Partial<TrainJobView> = {}): TrainJobView {
  return {
    id: QUANT,
    recipe: "glimmer-quantize",
    title: "Local files: Brief writer LoRA",
    status: "succeeded",
    params: { adapterJobId: ADAPTER, publish: 1, levels: "Q3_K_M,Q4_K_M,Q6_K", slug: "brief-writer", trainChannel: 0 },
    instanceType: "gpu_1x_a100_sxm4",
    region: "us-east-1",
    priceCentsPerHour: 199,
    maxMinutes: 110,
    maxUsd: 3.7,
    instanceId: "inst-2",
    instanceIp: "203.0.113.10",
    stopRequested: false,
    progress: null,
    artifacts: [],
    summary: "Local files",
    error: null,
    costUsd: 2.59,
    createdAt: iso(0),
    launchedAt: iso(0),
    lastHeartbeatAt: iso(78),
    finishedAt: iso(78),
    terminatedAt: iso(79),
    evalSummary: null,
    ...over,
  };
}

function hub(over: Partial<HubView> = {}): HubView {
  return {
    status: "uploaded",
    reason: null,
    modelRepo: REPO,
    datasetRepo: null,
    modelUrl: null,
    datasetUrl: null,
    why: null,
    storyBy: null,
    public: false,
    stale: false,
    filesUploaded: 3,
    filesTotal: 3,
    publishJobId: null,
    publishedAt: null,
    ...over,
  };
}

/** The done metrics QUANT_PY reports: Q6_K left out for its closeness, the others passed. */
const METRICS: Record<string, string | number> = {
  checks_passed: "yes",
  hub_uploaded: "yes",
  q3_k_m_bytes: 14_120_000_000,
  q3_k_m_kl_mean: 0.0412,
  q3_k_m_top_token_pct: 91.4,
  q3_k_m_passed: "yes",
  q4_k_m_bytes: 16_940_000_000,
  q4_k_m_kl_mean: 0.0187,
  q4_k_m_top_token_pct: 94.06,
  q4_k_m_passed: "yes",
  q6_k_bytes: 22_870_000_000,
  q6_k_kl_mean: 0.0071,
  q6_k_top_token_pct: 97.2,
  q6_k_passed: "no",
  channel_final: 39,
  channel_total: 40,
  agreement: 31,
  agreement_total: 40,
};

const done = (metrics: Record<string, string | number>): TrainEventView[] => [
  { id: 1, type: "log", payload: { type: "log", text: "Merging." }, at: iso(10) },
  { id: 2, type: "done", payload: { type: "done", summary: "Local files", metrics }, at: iso(78) },
];

const card = (j: TrainJobView, events: TrainEventView[] = done(METRICS)) => render(QuantFilesCard, { job: j, events });

function clean(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(html, /203\.0\.113\.10|\/api\/train|hf_[A-Za-z0-9]{8}/, "nothing about the GPU or a token");
}

describe("a local files job's card", () => {
  it("lists the builds asked for while the GPU makes them, with nothing to press", () => {
    const html = card(quantJob({ status: "running", finishedAt: null, terminatedAt: null }), []);
    clean(html);
    assert.match(html, /<h2[^>]*>Local files<\/h2><span class="pill pill-neutral"><span class="pill-dot" aria-hidden="true"><\/span>Not published<\/span>/);
    assert.match(html, /The GPU merges the adapter, makes each build, checks them and uploads the ones that pass\./);
    for (const level of ["Q3_K_M", "Q4_K_M", "Q6_K"]) {
      assert.match(html, new RegExp(`<dt>${level}</dt><dd>Not made yet</dd>`));
    }
    assert.doesNotMatch(html, /<button/);
    assert.doesNotMatch(html, /final answer|same 200 characters/, "no check has run");
  });

  it("shows each build's size, closeness against its limit and result, the channel check and the agreement, and offers Publish", () => {
    const html = card(quantJob({ hub: hub() }));
    clean(html);
    assert.match(html, /<dt>Q3_K_M<\/dt><dd>Passed · 14\.12 GB · mean KL 0\.0412, limit 0\.0800 · top token the same 91\.4%<\/dd>/);
    assert.match(html, /<dt>Q4_K_M<\/dt><dd>Passed · 16\.94 GB · mean KL 0\.0187, limit 0\.0300 · top token the same 94\.1%<\/dd>/);
    assert.match(html, /<dt>Q6_K<\/dt><dd>Left out · 22\.87 GB · mean KL 0\.0071, limit 0\.0050 · top token the same 97\.2%<\/dd>/);
    assert.match(html, /Q4_K_M gave a final answer to 39 of 40 held-out prompts under a stock app&#x27;s prompt \(90% needed\)\./);
    assert.match(html, /31 of 40 start with the same 200 characters as the adapter&#x27;s own eval answers \(shown, not checked\)\./);
    assert.match(html, /Every file is on Hugging Face\. Publishing starts in a moment, or press Publish to start it now\./);
    assert.match(html, />Uploaded<\/span>/);
    assert.match(html, new RegExp(`<dt>GGUF repo</dt><dd><code>${REPO}</code></dd>`), "no link before it is published");
    assert.match(html, />Publish to Hugging Face<\/span><\/button>/);
  });

  it("links the repo once published and offers Publish again; a private repo says the public pages don't link it", () => {
    const published = card(quantJob({ hub: hub({ status: "published", public: true, modelUrl: `https://huggingface.co/${REPO}`, publishedAt: iso(90) }) }));
    clean(published);
    assert.match(published, /class="pill pill-live"><span class="pill-dot" aria-hidden="true"><\/span>Published<\/span>/);
    assert.match(published, /Published Oct 28: the builds that passed, with their card, in their own repo next to the adapter&#x27;s\./);
    assert.match(published, new RegExp(`<a href="https://huggingface\\.co/${REPO}" target="_blank" rel="noopener noreferrer">${REPO}`));
    assert.match(published, />Publish again<\/span><\/button>/);
    const quiet = card(quantJob({ hub: hub({ status: "published", modelUrl: `https://huggingface.co/${REPO}`, publishedAt: iso(90) }) }));
    assert.match(quiet, /Published Oct 28, and private on Hugging Face, so the public pages don&#x27;t link to it\./);
    const odd = card(quantJob({ hub: hub({ status: "published", modelUrl: `https://huggingface.co/${REPO}?x=1` }) }));
    assert.match(odd, new RegExp(`<dd><code>${REPO}</code></dd>`), "a URL that isn't a plain Hub link stays text");
  });

  it("says why publishing failed, offering Retry only when every file is still on the Hub", () => {
    const lost = card(quantJob({ hub: hub({ status: "failed", reason: NOT_UPLOADED, filesUploaded: 2 }) }));
    clean(lost);
    assert.match(lost, /Not every GGUF file reached Hugging Face before the job ended, and the files were only on its GPU\. Make local files again\./);
    assert.match(lost, /class="pill pill-failed"/);
    assert.doesNotMatch(lost, /<button/, "the files are gone with its GPU");
    const failed = card(quantJob({ hub: hub({ status: "failed", reason: "Publishing to Hugging Face failed: HTTP 500." }) }));
    assert.match(failed, /Publishing to Hugging Face failed: HTTP 500\./);
    assert.match(failed, />Retry<\/span><\/button>/);
    const waiting = card(quantJob({ hub: hub({ status: "waiting", reason: "Its adapter isn't published on Hugging Face right now, and the GGUF repo links to it. Publish the adapter, then this." }) }));
    assert.match(waiting, /Publish the adapter, then this\./);
    const stopped = card(quantJob({ hub: hub({ status: "publishing", stale: true }) }));
    assert.match(stopped, />Stopped<\/span>/);
    assert.match(stopped, />Retry<\/span><\/button>/);
    assert.doesNotMatch(card(quantJob({ hub: hub({ status: "publishing" }) })), /<button/, "the platform is publishing");
  });

  it("says a job that didn't succeed published nothing", () => {
    const html = card(quantJob({ status: "failed", error: "The local files keep thinking instead of answering: 30 of 40 gave a final answer." }), []);
    clean(html);
    assert.match(html, /The job didn&#x27;t finish, so nothing was published\./);
    // Where to make them again, as a link to the adapter's own card.
    assert.match(html, new RegExp(`<a href="/fine-tuning/${ADAPTER}#local-files">Make local files again from the adapter&#x27;s page</a>`));
    assert.doesNotMatch(html, /<button/);
  });
});

describe("Make local files on an adapter's page", () => {
  it("checks first, with nothing to press until it knows", () => {
    const html = render(MakeLocalFiles, { jobId: ADAPTER, maxActive: 1, dailyUsd: 20 });
    clean(html);
    assert.match(html, /<section class="card section-card lab-try" id="local-files"/);
    assert.match(html, /<h2[^>]*>Local files<\/h2><span class="pill pill-neutral"><span class="pill-dot" aria-hidden="true"><\/span>Checking<\/span>/);
    assert.match(html, /Checking this adapter&#x27;s local files\./);
    assert.doesNotMatch(html, /<button/);
  });

  it("is on a succeeded Muse Glimmer LoRA job's admin page, and a local files job's page has its own card", () => {
    const lora = (over: Partial<TrainJobView>): TrainJobView => ({
      ...quantJob(),
      id: ADAPTER,
      recipe: "glimmer-lora",
      title: "Brief writer LoRA",
      params: { datasetId: "17c76f2c-1c4a-4335-b01f-ae55a655a881", maxSteps: 120, dryRun: 0, publish: 1 },
      evalSummary: won,
      ...over,
    });
    const room = (job: TrainJobView, withHub: boolean) =>
      render(JobRoom, {
        job,
        events: [],
        recipe: recipes.find((r) => r.id === job.recipe)!,
        hub: withHub ? { offReason: null, maxActive: 1, dailyUsd: 20 } : null,
        serverNow: t0 + 80 * 60_000,
      });
    assert.match(room(lora({}), true), /Checking this adapter&#x27;s local files\./);
    assert.doesNotMatch(room(lora({ status: "running", finishedAt: null, terminatedAt: null }), true), /id="local-files"/, "not before it succeeds");
    assert.doesNotMatch(room(lora({}), false), /id="local-files"/, "only beside the Hugging Face card");
    const quant = room(quantJob({ hub: hub() }), false);
    assert.match(quant, /Every file is on Hugging Face\./);
    assert.equal(quant.match(/id="local-files"/g)?.length, 1);
    assert.match(quant, /<dt>Builds<\/dt><dd>Q3_K_M,Q4_K_M,Q6_K<\/dd>/, "the params the platform wrote, labeled");
    assert.match(quant, /<dt>Name in the files<\/dt><dd>brief-writer<\/dd>/);
    assert.match(quant, /<dt>Adapter trained with trainChannel<\/dt><dd>0<\/dd>/);
  });
});

describe("the local files text", () => {
  const files = (over: Partial<LocalFiles> = {}): LocalFiles => ({
    adapterJobId: ADAPTER,
    quantJobId: QUANT,
    repo: REPO,
    commit: "a".repeat(40),
    public: true,
    files: [
      { level: "Q3_K_M", name: "muse-glimmer-30b-brief-writer-Q3_K_M.gguf", bytes: 14_120_000_000, sha256: "1".repeat(64) },
      { level: "Q4_K_M", name: "muse-glimmer-30b-brief-writer-Q4_K_M.gguf", bytes: 16_940_000_000, sha256: "2".repeat(64) },
    ],
    systemLine: "You are Muse Muse's brief writer.\n\nReasoning strength: low.",
    needsTunedTemplate: true,
    title: "Muse Muse's brief writer",
    slug: "brief-writer",
    ...over,
  });
  const latest = (over: Partial<import("@/components/train/format").QuantJobSummary> = {}) => ({
    id: QUANT,
    title: "Local files: Brief writer LoRA",
    status: "succeeded" as const,
    createdAt: iso(0),
    finishedAt: iso(78),
    terminatedAt: iso(79),
    error: null,
    hub: null,
    ...over,
  });
  const state = (over: Partial<import("@/components/train/format").QuantState> = {}) =>
    format.quantStateOf({ quantOff: null, hubOff: null, problem: null, latest: null, files: null, ...over })!;

  it("reads the quantize route's answer, and nothing else", () => {
    assert.equal(format.quantStateOf(null), null);
    assert.equal(format.quantStateOf("nope"), null);
    const s = format.quantStateOf({ quantOff: " ", hubOff: "HF_TOKEN isn't set", latest: { title: "no id" }, files: { files: "not a list" } })!;
    assert.deepEqual(s, { quantOff: null, hubOff: "HF_TOKEN isn't set", problem: null, latest: null, files: null });
  });

  it("says where the adapter's files stand, from not made to published", () => {
    assert.deepEqual(format.makeFilesPill(null), { label: "Checking", tone: "neutral" });
    const none = state();
    assert.deepEqual([format.makeFilesPill(none), format.makeFilesBlock(none)], [{ label: "Not made", tone: "neutral" }, null]);
    assert.equal(format.makeFilesText(none), "GGUF builds in three sizes, for LM Studio, llama.cpp and Ollama, each checked against the merged model before it is published.");

    const making = state({ latest: latest({ status: "running", finishedAt: null, terminatedAt: null }) });
    assert.deepEqual(format.makeFilesPill(making), { label: "Making", tone: "building" });
    assert.equal(format.makeFilesText(making), 'Making the local files: "Local files: Brief writer LoRA" is running.');
    assert.equal(format.makeFilesBlock(making), "A local files job of this adapter is running.");

    const out = state({ latest: latest(), files: files() });
    assert.deepEqual(format.makeFilesPill(out), { label: "Published", tone: "live" });
    assert.equal(format.makeFilesText(out), "Q3_K_M (14.12 GB), Q4_K_M (16.94 GB) are on Hugging Face.");
    assert.equal(format.makeFilesBlock(out), null, "it can be made again");
    const quiet = state({ files: files({ public: false, files: files().files.slice(1) }) });
    assert.deepEqual(format.makeFilesPill(quiet), { label: "Private", tone: "live" });
    assert.equal(format.makeFilesText(quiet), "Q4_K_M (16.94 GB) is on Hugging Face, private.");
  });

  it("says why files that passed aren't published, when they are the newest job's", () => {
    const unpublished = files({ repo: null, commit: null, public: false });
    const publishing = state({ latest: latest(), files: unpublished });
    assert.equal(format.makeFilesText(publishing), "Q3_K_M (14.12 GB), Q4_K_M (16.94 GB) passed their checks and are publishing.");
    // The pill agrees with the sentence, and nothing is offered while they publish.
    assert.deepEqual(format.makeFilesPill(publishing), { label: "Publishing", tone: "building" });
    assert.equal(format.makeFilesPublishing(publishing), true);
    const waiting = state({ latest: latest({ hub: hub({ status: "waiting", reason: "Its adapter isn't published on Hugging Face right now." }) }), files: unpublished });
    assert.deepEqual([format.makeFilesPill(waiting), format.makeFilesPublishing(waiting)], [{ label: "Waiting", tone: "neutral" }, false]);
    const lost = state({ latest: latest({ hub: hub({ status: "failed", reason: NOT_UPLOADED, filesUploaded: 2 }) }), files: unpublished });
    assert.equal(format.makeFilesText(lost), `Q3_K_M (14.12 GB), Q4_K_M (16.94 GB) passed their checks. ${NOT_UPLOADED}`);
    assert.deepEqual(format.makeFilesPill(lost), { label: "Not published", tone: "failed" });
    const older = state({ latest: latest({ id: "5d5d5d5d-0000-4000-8000-00000000000d", status: "failed", hub: hub({ status: "failed", reason: NOT_UPLOADED }) }), files: unpublished });
    assert.match(format.makeFilesText(older), /are publishing\.$/, "another job's reason isn't theirs");
  });

  it("says why it can't be made here now, and that a try failed", () => {
    const off = state({ quantOff: "QUANT_ENABLED isn't on" });
    assert.deepEqual(format.makeFilesPill(off), { label: "Off", tone: "neutral" });
    assert.equal(format.makeFilesText(off), "Making local files is off here: QUANT_ENABLED isn't on.");
    assert.equal(format.makeFilesBlock(off), "Making local files is off here: QUANT_ENABLED isn't on.");
    const hubOff = state({ hubOff: "HF_TOKEN isn't set" });
    assert.equal(format.makeFilesText(hubOff), "Publishing to Hugging Face is off here: HF_TOKEN isn't set, and local files go to the Hub.");
    const problem = state({ problem: "Publish the adapter to Hugging Face first: its local files go to a repo whose card links to it." });
    assert.equal(format.makeFilesBlock(problem), "Publish the adapter to Hugging Face first: its local files go to a repo whose card links to it.");
    const failed = state({ latest: latest({ status: "failed", error: "The local files keep thinking instead of answering: 30 of 40 gave a final answer." }) });
    assert.deepEqual(format.makeFilesPill(failed), { label: "Failed", tone: "failed" });
    // The job's own sentence reads as a clause after the colon: lowercase, and one full stop at the end.
    assert.equal(
      format.makeFilesText(failed),
      "The last try failed: the local files keep thinking instead of answering: 30 of 40 gave a final answer. Its log has the details.",
    );
    const named = state({ latest: latest({ status: "failed", error: "Traceback\nCUDA build found no GPU." }) });
    assert.equal(format.makeFilesText(named), "The last try failed: CUDA build found no GPU. Its log has the details.", "a name keeps its capitals");
    assert.equal(format.makeFilesBlock(failed), null, "it can be tried again");
  });

  it("builds the rows, the sizes and the check sentences from the metrics alone", () => {
    const rows = format.quantRows({ levels: "Q4_K_M,Q8_0", slug: "brief-writer" }, METRICS);
    assert.deepEqual(rows, [{ level: "Q4_K_M", bytes: 16_940_000_000, klMean: 0.0187, klMax: 0.03, topTokenPct: 94.06, passed: true }], "only the levels a job can make");
    assert.equal(format.quantRowText({ ...rows[0]!, klMean: null, topTokenPct: null, passed: null }), "Not checked yet · 16.94 GB", "made, not measured yet");
    assert.deepEqual(format.quantRows(null, METRICS), []);
    assert.equal(format.quantRows({ levels: "Q6_K" }, { q6_k_bytes: "22870000000", q6_k_passed: "maybe" })[0]!.bytes, null, "only numbers count");
    assert.equal(format.buildSize(16_940_000_000), "16.94 GB");
    assert.equal(format.buildSize(-1), "0.00 GB");
    assert.equal(format.quantChannelText({ channel_final: 0, channel_total: 0 }), null);
    assert.equal(format.quantAgreementText({ agreement: 3 }), null);
    assert.deepEqual(format.doneMetricsOf([...done({ a: 1 }), ...done({ b: 2 })]), { b: 2 }, "the last done event");
    assert.equal(format.doneMetricsOf(done({}).slice(0, 1)), null);
  });

  it("offers a local files job's control only when it can do something", () => {
    const control = (j: TrainJobView, off: string | null = null) => format.ggufControl(j, off)?.label ?? null;
    assert.equal(control(quantJob({ hub: hub() })), "Publish to Hugging Face");
    assert.equal(control(quantJob({ hub: hub() }), "HF_TOKEN isn't set"), null);
    assert.equal(control(quantJob({ hub: null })), null);
    assert.equal(control(quantJob({ terminatedAt: null, hub: hub() })), null, "its GPU isn't shut down yet");
    assert.equal(control(quantJob({ hub: hub({ filesUploaded: 2 }) })), null);
    assert.equal(control(quantJob({ hub: hub({ status: "published" }) })), "Publish again");
    assert.equal(control(quantJob({ hub: hub({ status: "failed" }) })), "Retry");
    for (const s of [format.ggufStatusText(quantJob({ hub: hub() }), null), format.makeFilesText(state())]) {
      assert.equal(s.includes(String.fromCharCode(0x2014)), false, "no em dash");
    }
  });
});
