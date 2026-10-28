/**
 * Publishing to the Hugging Face Hub in the UI (docs/TRAINING.md "Hugging Face Hub"), server-rendered with sample data
 * outside Next: the job page's Hugging Face card in each state (off, an "off" saved before publishing was turned on,
 * not judged, files missing, uploading, uploaded, publishing, a publishing a stopped run left, published public or
 * private, failed, an upload job running), its why and its Publish, Retry or Publish again; the public result page's
 * "On Hugging Face" chip and links once published and nothing before; the results list's chip; and the text helpers
 * behind them. The router and Link are stand-ins. Nothing reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/train/__tests__/hub.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import type { EvalSummary, HubView, TrainJobView } from "@/lib/train/types";

mock.module("next/navigation", {
  namedExports: { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/fine-tuning" },
});
mock.module("next/link", {
  defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
});

const t0 = Date.parse("2026-10-28T03:00:00.000Z");
const iso = (min: number) => new Date(t0 + min * 60_000).toISOString();
const JOB = "83d71f74-d84b-40bf-925a-cd36c90b6de5";
const UPLOAD_JOB = "9a9a9a9a-0000-4000-8000-000000000009";
const MODEL = "muse-org/muse-glimmer-30b-brief-writer-lora-83d71f74";
const DATA = "muse-org/muse-muse-brief-writer-17c76f2c";
const won: EvalSummary = { items: 40, tunedWins: 40, baseWins: 0, ties: 0, avgBaseScore: 1.95, avgTunedScore: 8.88, judgeCostUsd: 0.15 };

let render: (c: ComponentType<never>, props: object) => string;
let HubCard: ComponentType<never>;
let JobResults: ComponentType<never>;
let ResultsTable: ComponentType<never>;
let format: typeof import("@/components/train/format");
let results: typeof import("@/components/train/results");

before(async () => {
  const { renderToString } = await import("react-dom/server");
  render = (c, props) => renderToString(createElement(c, props as never)).replace(/<!-- -->/g, "");
  HubCard = (await import("@/components/train/HubCard")).HubCard as ComponentType<never>;
  JobResults = (await import("@/components/train/JobResults")).JobResults as ComponentType<never>;
  ResultsTable = (await import("@/components/train/LabResults")).ResultsTable as ComponentType<never>;
  format = await import("@/components/train/format");
  results = await import("@/components/train/results");
});

function job(over: Partial<TrainJobView> = {}): TrainJobView {
  return {
    id: JOB,
    recipe: "glimmer-lora",
    title: "Brief writer LoRA",
    status: "succeeded",
    params: { datasetId: "17c76f2c-1c4a-4335-b01f-ae55a655a881", maxSteps: 120, dryRun: 0, publish: 1 },
    instanceType: "gpu_1x_a100_sxm4",
    region: "us-east-1",
    priceCentsPerHour: 199,
    maxMinutes: 150,
    maxUsd: 8,
    instanceId: "inst-1",
    instanceIp: "203.0.113.9",
    stopRequested: false,
    progress: null,
    artifacts: [],
    summary: "LoRA r=16",
    error: null,
    costUsd: 1.39,
    createdAt: iso(0),
    launchedAt: iso(0),
    lastHeartbeatAt: iso(41),
    finishedAt: iso(41),
    terminatedAt: iso(42),
    evalSummary: won,
    ...over,
  };
}

function hub(over: Partial<HubView> = {}): HubView {
  return {
    status: "uploaded",
    reason: null,
    modelRepo: MODEL,
    datasetRepo: null,
    modelUrl: null,
    datasetUrl: null,
    why: null,
    storyBy: null,
    public: false,
    stale: false,
    filesUploaded: 2,
    filesTotal: 2,
    publishJobId: null,
    publishedAt: null,
    ...over,
  };
}

const card = (j: TrainJobView, offReason: string | null = null) => render(HubCard, { job: j, offReason, maxActive: 1, dailyUsd: 20 });

function clean(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
}

describe("the job page's Hugging Face card", () => {
  it("offers Publish for a judged job whose files never reached the Hub, saying a GPU job uploads them", () => {
    const html = card(job());
    clean(html);
    assert.match(html, /<h2[^>]*>Hugging Face<\/h2><span class="pill pill-neutral"><span class="pill-dot" aria-hidden="true"><\/span>Not published<\/span>/);
    assert.match(html, /Its adapter&#x27;s files never reached Hugging Face\. Publish uploads them from the model cache with a short GPU job, then publishes\./);
    assert.match(html, /<label[^>]*for="[^"]+"[^>]*>Why this model <span class="muted">\(optional\)<\/span><\/label><textarea[^>]*maxLength="2000"/);
    assert.match(html, /<button type="submit" class="btn btn-primary">[\s\S]*Publish to Hugging Face<\/span><\/button>/);
  });

  it("says why it is off, with nothing to press", () => {
    const html = card(job({ hub: hub({ status: "off", reason: "Publishing to Hugging Face is off here: HF_TOKEN isn't set." }) }), "HF_TOKEN isn't set");
    clean(html);
    assert.match(html, /Publishing to Hugging Face is off here: HF_TOKEN isn&#x27;t set\./);
    assert.match(html, />Off<\/span>/);
    assert.doesNotMatch(html, /<button|<textarea/);
  });

  it("waits for the run and its judging, and never offers a dry run", () => {
    assert.match(card(job({ status: "running", terminatedAt: null, evalSummary: null })), /It publishes once the job succeeds and Muse Spark 1\.3 has judged it\./);
    assert.match(card(job({ evalSummary: null })), /It publishes once Muse Spark 1\.3 has judged it\./);
    const dry = card(job({ params: { dryRun: 1 } }));
    assert.match(dry, /This was a dry run, so its adapter is a stand-in and isn&#x27;t published\./);
    assert.doesNotMatch(dry, /<button/);
    assert.match(card(job({ status: "failed" })), /This job didn&#x27;t succeed/);
  });

  it("shows the upload while the GPU sends the files, and Publish once they are all up", () => {
    const uploading = card(job({ status: "running", terminatedAt: null, evalSummary: null, hub: hub({ status: "uploading", filesUploaded: 1 }) }));
    assert.match(uploading, /It publishes once the job succeeds/, "a running job waits first");
    const up = card(job({ hub: hub({ status: "uploading", filesUploaded: 1 }) }));
    assert.match(up, /The GPU is uploading the adapter&#x27;s files: 1 of 2 are on Hugging Face\./);
    assert.match(up, />Uploading<\/span>/);
    assert.doesNotMatch(up, /<button/);
    const ready = card(job({ hub: hub() }));
    assert.match(ready, /Every file of the adapter is on Hugging Face\. Publishing starts in a moment, or press Publish to start it now\./);
    assert.match(ready, /<dt>Model<\/dt><dd><code>muse-org\/muse-glimmer-30b-brief-writer-lora-83d71f74<\/code><\/dd>/, "no link before it is published");
    assert.match(ready, /Publish to Hugging Face/);
  });

  it("links the repos once published, says who wrote the story, and offers Publish again", () => {
    const html = card(
      job({
        params: { why: "We wanted it offline." },
        hub: hub({
          status: "published",
          why: "We wanted it offline.",
          public: true,
          datasetRepo: DATA,
          modelUrl: `https://huggingface.co/${MODEL}`,
          datasetUrl: `https://huggingface.co/datasets/${DATA}`,
          storyBy: "spark",
          publishedAt: iso(60),
        }),
      }),
    );
    clean(html);
    assert.match(html, /class="pill pill-live"><span class="pill-dot" aria-hidden="true"><\/span>Published<\/span>/);
    assert.match(html, /Published Oct 28: the adapter with its model card, and its training data with the dataset card\./);
    assert.match(html, new RegExp(`<a href="https://huggingface\\.co/${MODEL}" target="_blank" rel="noopener noreferrer">${MODEL}`));
    assert.match(html, new RegExp(`<a href="https://huggingface\\.co/datasets/${DATA}" target="_blank"`));
    assert.match(html, /<dt>Story<\/dt><dd>Written by Muse Spark 1\.3<\/dd>/);
    assert.match(html, /<textarea[^>]*>We wanted it offline\.<\/textarea>/, "the job's why, to change before publishing again");
    assert.match(html, /Publish again/);
    const private_ = card(job({ hub: hub({ status: "published", public: false, modelUrl: `https://huggingface.co/${MODEL}` }) }));
    assert.match(private_, /Published, and private on Hugging Face, so the public pages don&#x27;t link to it\./);
  });

  it("prefills the why the card prints, so a cleared one starts empty", () => {
    const cleared = card(job({ params: { why: "The param's why." }, hub: hub({ why: null }) }));
    assert.match(cleared, /<textarea[^>]*><\/textarea>/, "the hub view's why wins over the param once there is one");
    assert.match(card(job({ params: { why: "The param's why." } })), /<textarea[^>]*>The param&#x27;s why\.<\/textarea>/, "before any state, the param");
  });

  it("treats an off saved before publishing was turned on here as not published, and a stopped publishing as one to retry", () => {
    const off = hub({ status: "off", reason: "Publishing to Hugging Face is off here: HF_TOKEN isn't set.", filesUploaded: 0, filesTotal: 0 });
    const html = card(job({ hub: off }));
    clean(html);
    assert.match(html, /class="pill pill-neutral"><span class="pill-dot" aria-hidden="true"><\/span>Not published<\/span>/);
    assert.doesNotMatch(html, /HF_TOKEN isn/, "not the old reason");
    assert.match(html, /Its adapter&#x27;s files never reached Hugging Face\./);
    assert.match(html, />Publish to Hugging Face<\/span><\/button>/);
    assert.match(card(job({ hub: { ...off, filesUploaded: 2, filesTotal: 2 } })), /Every file of the adapter is on Hugging Face\. Press Publish to publish it\./);
    assert.match(card(job({ hub: off }), "HF_TOKEN isn't set"), />Off<\/span>/, "still off here: as it was");
    assert.match(card(job({ hub: hub({ status: "waiting", filesUploaded: 0, filesTotal: 0 }) })), />Not published<\/span>/, "a bare state a Publish left");

    const stopped = card(job({ hub: hub({ status: "publishing", stale: true }) }));
    assert.match(stopped, /class="pill pill-failed"><span class="pill-dot" aria-hidden="true"><\/span>Stopped<\/span>/);
    assert.match(stopped, /Publishing stopped partway: the run doing it hasn&#x27;t moved for 30 minutes\. Retry starts it again\./);
    assert.match(stopped, />Retry<\/span><\/button>/);
  });

  it("says why it failed and offers Retry; an upload job in flight links to its page", () => {
    const failed = card(job({ hub: hub({ status: "failed", reason: "Publishing to Hugging Face failed: HTTP 500." }) }));
    assert.match(failed, /Publishing to Hugging Face failed: HTTP 500\./);
    assert.match(failed, /class="pill pill-failed"/);
    assert.match(failed, />Retry<\/span><\/button>/);
    const waiting = card(job({ hub: hub({ status: "waiting", reason: "Uploading the adapter's files from the model cache.", publishJobId: UPLOAD_JOB, filesUploaded: 0 }) }));
    assert.match(waiting, /Uploading the adapter&#x27;s files from the model cache\./);
    assert.match(waiting, new RegExp(`<a href="/fine-tuning/${UPLOAD_JOB}">Open the upload job</a>`));
    assert.match(waiting, /Publish to Hugging Face<\/span><\/button>/, "the route says when that job still runs");
    assert.match(card(job({ hub: hub({ status: "publishing" }) })), /Writing the cards and committing the model and dataset repos\./);
  });

  it("links a repo only over https with nothing extra", () => {
    assert.equal(format.hubHref("https://huggingface.co/muse-org/x"), "https://huggingface.co/muse-org/x");
    for (const bad of ["javascript:alert(1)", "http://huggingface.co/x", "https://u:p@huggingface.co/x", "https://huggingface.co/x?y=1", "https://huggingface.co:444/x", null]) {
      assert.equal(format.hubHref(bad), null, String(bad));
    }
  });
});

describe("the card's sentences", () => {
  it("say each refusal of the publish route in plain words", () => {
    const limits = { maxActive: 1, dailyUsd: 20 };
    assert.equal(format.publishErrorText(409, { error: "not_publishable", reason: "It isn't judged yet." }, limits), "It isn't judged yet.");
    assert.equal(format.publishErrorText(503, { error: "hub_off", reason: "HF_TOKEN isn't set" }, limits), "Publishing to Hugging Face is off here: HF_TOKEN isn't set.");
    assert.match(format.publishErrorText(409, { error: "publishing" }, limits), /being published right now/);
    assert.match(format.publishErrorText(409, { error: "upload_running", publishJobId: UPLOAD_JOB }, limits), /already uploading/);
    assert.match(format.publishErrorText(503, { error: "sweep_not_running" }, limits), /5-minute check/, "the upload job's own refusals");
    assert.match(format.publishErrorText(409, { error: "too_many_active", max: 1 }, limits), /only 1 job can hold one/);
    assert.equal(format.publishErrorText(400, { error: "Keep the why to 2,000 characters." }, limits), "Keep the why to 2,000 characters.");
    assert.equal(
      format.publishErrorText(409, { error: "hub_refused", reason: "Hugging Face: creating the repo failed: HTTP 403. Check that HF_TOKEN can write repos under HF_NAMESPACE." }, limits),
      "Hugging Face: creating the repo failed: HTTP 403. Check that HF_TOKEN can write repos under HF_NAMESPACE.",
    );
    assert.match(format.publishErrorText(503, { error: "hub_unavailable", reason: "timed out" }, limits), /didn't answer just now/);
  });

  it("offer nothing to press while something moves or publishing is off", () => {
    assert.equal(format.hubControl(job({ hub: hub({ status: "publishing" }) }), null), null);
    assert.equal(format.hubControl(job({ hub: hub({ status: "uploading" }) }), null), null);
    assert.equal(format.hubControl(job(), "HF_TOKEN isn't set"), null);
    assert.equal(format.hubControl(job({ recipe: "smoke" }), null), null);
    assert.match(format.hubControl(job(), null)!.confirm, /short GPU job on Lambda/);
    assert.doesNotMatch(format.hubControl(job({ hub: hub() }), null)!.confirm, /GPU job/, "the files are up already");
    assert.match(format.hubStatusText(job({ params: { publish: 0 } }), null), /started with Publish to Hugging Face set to 0/);
  });

  it("read the hub view out of a reply, and nothing else", () => {
    assert.deepEqual(format.hubViewOf({ hub: hub() }), hub());
    assert.equal(format.hubViewOf({ hub: { status: "weird" } }), null);
    assert.equal(format.hubViewOf(null), null);
  });
});

describe("the public pages", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: JOB,
    recipe: "glimmer-lora",
    title: "Brief writer LoRA",
    status: "succeeded",
    params: { datasetId: "17c76f2c-1c4a-4335-b01f-ae55a655a881", maxSteps: 120, loraRank: 16 },
    instanceType: "gpu_1x_a100_sxm4",
    costUsd: 1.39,
    createdAt: new Date(t0),
    launchedAt: new Date(t0),
    finishedAt: new Date(t0 + 41 * 60_000),
    terminatedAt: new Date(t0 + 42 * 60_000),
    evalSummary: won,
    ...over,
  });
  const published = { status: "published", modelUrl: `https://huggingface.co/${MODEL}`, datasetUrl: `https://huggingface.co/datasets/${DATA}` };

  it("show an On Hugging Face chip and the two links once a job is published, and nothing before", () => {
    const view = results.toResultView(row({ hubLinks: published }) as never, null)!;
    assert.deepEqual(view.hub, { modelUrl: published.modelUrl, datasetUrl: published.datasetUrl });
    const html = render(JobResults, { result: view, rows: [], dataset: null });
    clean(html);
    assert.match(html, new RegExp(`<a class="chip" href="https://huggingface\\.co/${MODEL}" target="_blank" rel="noopener noreferrer">On Hugging Face`));
    assert.match(html, /<dt>On Hugging Face<\/dt><dd><a href="https:\/\/huggingface\.co\/muse-org\/[^"]+"[^>]*>The adapter and its model card/);
    assert.match(html, /The training data/);

    for (const links of [null, undefined, { ...published, status: "publishing" }, { ...published, modelUrl: "javascript:alert(1)" }]) {
      const quiet = results.toResultView(row({ hubLinks: links }) as never, null)!;
      assert.equal(quiet.hub, null, JSON.stringify(links));
      assert.doesNotMatch(render(JobResults, { result: quiet, rows: [], dataset: null }), /Hugging Face/);
    }
    // A store that let the whole hub state through still shows nothing of it: only hubLinks counts.
    const leaky = results.toResultView(row({ hub: { status: "published", modelUrl: published.modelUrl, reason: "secret", small: { "a.json": "e30=" } } }) as never, null)!;
    assert.equal(leaky.hub, null);
  });

  it("put the chip on the results list", () => {
    const list = [
      results.toResultView(row({ hubLinks: published }) as never, null)!,
      results.toResultView(row({ id: "8f1d2c3b-0000-4000-8000-000000000001", title: "Other" }) as never, null)!,
    ];
    const html = render(ResultsTable, { results: list, caption: "Judged jobs" });
    assert.equal(html.match(/<span class="chip">On Hugging Face<\/span>/g)?.length, 1);
  });
});
