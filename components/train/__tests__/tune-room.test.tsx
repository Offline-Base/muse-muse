/**
 * The fine-tune room (components/train/room/TrainRoom.tsx) at every stage (tune-room-fixture.ts), the plan step the
 * composer turns into once it's sent (PlanStep in components/train/compose/TrainComposer.tsx), Where it runs, the plan
 * card drawing a brief exactly as before (PlanView parity), and the stylesheet. Server-rendered, made-up data only.
 *
 *   npx tsx --test --experimental-test-module-mocks components/train/__tests__/tune-room.test.tsx
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import { HUB, INSTANCE_DETAILS, JOB_ID, LIVE_DEMOS, ROOM_FIXTURES, RUN_ID, SERVE_ID, T0, type RoomFixtureName } from "@/components/train/__tests__/tune-room-fixture";
import type { Brief } from "@/lib/types";
import type { TrainPlan } from "@/lib/train/tune/types";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const ROOT = path.join(import.meta.dirname, "../../..");
const EM_DASH = String.fromCharCode(0x2014);
const NOW = T0 + 90 * 60_000;
const NAMES = Object.keys(ROOM_FIXTURES) as RoomFixtureName[];

let render: (c: ComponentType<never>, props: object) => string;
let TrainRoom: ComponentType<never>;
let PlanStep: ComponentType<never>;
let WhereItRuns: ComponentType<never>;
let card: typeof import("@/components/build/PlanCard");
let cost: typeof import("@/lib/train/tune/cost");

const count = (html: string, s: string | RegExp) => (typeof s === "string" ? html.split(s).length - 1 : (html.match(new RegExp(s, "g")) ?? []).length);

function room(name: RoomFixtureName, over: Record<string, unknown> = {}) {
  return render(TrainRoom, { initial: ROOM_FIXTURES[name].view, admin: true, serverNow: NOW, ...over });
}

function plan(over: Partial<TrainPlan> = {}): TrainPlan {
  const settings = cost.planSettings(200, { maxMinutes: 120, maxUsd: 5 });
  return {
    v: 1,
    kind: "chat",
    name: "a made-up bakery's counter helper",
    tagline: "Answers like the counter staff, warm and short.",
    task: "Answer questions for a made-up bakery.",
    samples: ["Do you have nut-free cupcakes?"],
    examples: { given: 24, used: 24 },
    settings,
    cost: cost.planCost(settings),
    source: { kind: "task" },
    token: "made-up-token",
    exp: new Date(T0 + 2 * 3_600_000).toISOString(),
    ...over,
  };
}

function planStep(phase: object, over: Record<string, unknown> = {}) {
  return render(PlanStep, {
    phase,
    examples: 200,
    onExamples() {},
    ceilings: { maxMinutes: 120, maxUsd: 5 },
    starting: false,
    startError: null,
    onStart() {},
    onChange() {},
    ...over,
  });
}

describe("the fine-tune room", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module("next/navigation", { namedExports: { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => `/fine-tuning/runs/${RUN_ID}` } });
    mock.module("next/link", {
      defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
    });
    const { renderToString } = await import("react-dom/server");
    render = (c, props) => renderToString(createElement(c, props as never)).replace(/<!-- -->/g, "");
    TrainRoom = (await import("@/components/train/room/TrainRoom")).TrainRoom as ComponentType<never>;
    PlanStep = (await import("@/components/train/compose/TrainComposer")).PlanStep as ComponentType<never>;
    WhereItRuns = (await import("@/components/train/room/WhereItRuns")).WhereItRuns as ComponentType<never>;
    card = await import("@/components/build/PlanCard");
    cost = await import("@/lib/train/tune/cost");
  });

  describe("at each stage", () => {
    it("has the fixtures it says: one run per stage, from the same view the route sends", () => {
      for (const name of NAMES) assert.equal(ROOM_FIXTURES[name].view.stage, ROOM_FIXTURES[name].stage, name);
      assert.deepEqual([...new Set(NAMES.map((n) => ROOM_FIXTURES[n].stage))].sort(), ["checking", "failed", "ready", "scoring", "stopped", "training", "waiting", "writing"]);
    });

    it("follows the stage with the mascot: building while it writes, waits, trains or scores, the pair once scored, presenting when it ended early or wasn't scored", () => {
      const art: Record<RoomFixtureName, string> = {
        writing: "building",
        checking: "building",
        waiting: "building",
        waitingGpu: "building",
        training: "building",
        scoring: "building",
        ready: "shield",
        readyUnscored: "present",
        readyNotPassed: "shield",
        failedWriting: "present",
        failedTraining: "present",
        stopped: "present",
        stoppedBefore: "present",
      };
      for (const name of NAMES) {
        const html = room(name);
        assert.equal(count(html, 'class="plan-card"'), 1, `${name}: one plan card`);
        assert.match(html, new RegExp(`<div class="plan-card" data-art="${art[name]}">`), name);
        assert.match(html, /<img class="is-on" src="\/muse\/muse-(present|building|shield)\.jpg" alt=""/, `${name}: the picture as given`);
      }
    });

    it("loads all three pictures while the run can still change, and only its own once it ended", () => {
      assert.equal(count(room("writing"), "<img"), 3);
      assert.equal(count(room("waiting"), "<img"), 3);
      assert.equal(count(room("ready"), "<img"), 1);
      assert.equal(count(room("stopped"), "<img"), 1);
    });

    it("shows the working step while something runs, Show thinking once it ended, and neither while it waits on a person", () => {
      const working: Partial<Record<RoomFixtureName, RegExp>> = {
        writing: /Writing examples[\s\S]*Muse Wonder has written 84 of 200\./,
        checking: /Checking the examples[\s\S]*Making sure there are enough to train on and to score with\./,
        waitingGpu: /Waiting for a GPU[\s\S]*No Muse Glimmer GPU is free on Lambda right now\. It tries again every 5 minutes, for up to 2 hours\./,
        training: /Training on a GPU[\s\S]*Running on the GPU · \$0\.\d\d so far/,
        scoring: /Scoring base against tuned[\s\S]*Judged 5 of 20 kept-aside prompts/,
      };
      for (const name of NAMES) {
        const html = room(name);
        const stage = ROOM_FIXTURES[name].stage;
        const ended = stage === "ready" || stage === "failed" || stage === "stopped";
        const step = working[name];
        if (step) {
          assert.match(html, /<li class="room-working">/, name);
          assert.match(html, step, name);
          assert.match(html, /so far<button type="button" class="link-btn room-steps-link" aria-expanded="false" aria-controls="tune-steps-panel">Show steps/, `${name}: its cost so far and the steps`);
        } else {
          assert.doesNotMatch(html, /class="room-working"/, name);
        }
        assert.equal(count(html, 'class="chat-thinking"'), ended ? 1 : 0, `${name}: Show thinking`);
      }
      assert.match(room("waiting"), /<p class="plan-card-more"><button type="button" class="link-btn room-steps-link"[^>]*>Show steps/, "a waiting run's steps open from the card");
    });

    it("has one Start training, only while the examples wait, with the full form a small link for admins", () => {
      for (const name of NAMES) {
        const html = room(name);
        if (name === "waiting") {
          assert.equal(count(html, ">Start training<"), 1);
          assert.match(html, /<div class="row-actions"><button type="button" class="btn btn-primary" aria-busy="false">Start training<\/button><\/div>/);
          assert.match(html, /The examples are ready\. Training hasn&#x27;t started yet\./);
          assert.match(html, /\$4\.20 so far/);
          assert.match(html, new RegExp(`<a href="/fine-tuning\\?dataset=${RUN_ID}#new-job">Use the full form</a> to change the settings\\.`));
          assert.match(html, /kept on Muse Muse \(publish is off\)/, "launches pass publish 0, so no note about the form's publishing");
          assert.doesNotMatch(room(name, { admin: false }), /Use the full form/, "the full form is for admins");
        } else if (name === "waitingGpu") {
          // The workflow is trying: the working step says why it waits, and the button asks again at once.
          assert.match(html, /<button type="button" class="btn btn-outline" aria-busy="false">Try now<\/button>/);
          assert.match(html, /Training starts on its own as soon as it can\./);
          assert.doesNotMatch(html, />Start training</);
        } else {
          assert.doesNotMatch(html, />Start training<|>Try now<|Use the full form/, name);
        }
        assert.doesNotMatch(html, /data-u3=|Ready to train|publishes to Hugging Face by default/, name);
      }
    });

    it("says why a run stopped before training, and offers another", () => {
      const html = room("stoppedBefore");
      assert.match(html, /This run was stopped\.[\s\S]*This run was stopped before training\./);
      assert.match(html, /Start another/);
    });

    it("words Start training's refusals plainly", async () => {
      const { startTrainingErrorText } = await import("@/components/train/room/TrainRoom");
      assert.equal(startTrainingErrorText(422, { error: "too_long", reason: "Too long." }), "Too long.");
      assert.match(startTrainingErrorText(503, { error: "lambda_not_configured" }), /Lambda isn't connected/);
      assert.equal(startTrainingErrorText(400, { error: "Dataset: that dataset is still being written." }), "Dataset: that dataset is still being written.");
      assert.match(startTrainingErrorText(409, { error: "stopped" }), /stopped/);
      assert.match(startTrainingErrorText(403, { error: "forbidden" }), /Only the person who started this run/);
      assert.match(startTrainingErrorText(500, null), /Something went wrong/);
    });

    it("links a training or scoring run to its job's page for the log, the limits and Stop", () => {
      for (const name of ["training", "scoring"] as const) {
        assert.match(room(name), new RegExp(`The GPU&#x27;s log, its limits and Stop are on <a href="/fine-tuning/${JOB_ID}">the job&#x27;s page</a>\\.`), name);
      }
    });

    it("says why a run ended early, with Start another, and links the job when it had one", () => {
      const writing = room("failedWriting");
      assert.match(writing, /This run didn&#x27;t finish\.<\/p><p>The platform&#x27;s daily spend cap is reached, so the dataset stopped\.<\/p>/);
      assert.match(writing, /<a class="btn btn-outline" href="\/fine-tuning\/new">[\s\S]*Start another<\/a>/);
      assert.doesNotMatch(writing, /the job&#x27;s page/, "no job, no link");
      const training = room("failedTraining");
      assert.match(training, /This run didn&#x27;t finish\.<\/p><p>CUDA out of memory<\/p>/, "the error's last line, not the traceback");
      assert.doesNotMatch(training, /Traceback/);
      assert.match(training, new RegExp(`The GPU&#x27;s log and the job&#x27;s settings are on <a href="/fine-tuning/${JOB_ID}">`));
      assert.match(room("stopped"), /This run was stopped\.<\/p><p>Training was stopped before it finished\.<\/p>/);
      assert.match(room("stopped"), /\$4\.80 in all/, "the examples and the GPU");
    });

    it("keeps the steps panel closed and empty until it's opened", () => {
      for (const name of NAMES) assert.doesNotMatch(room(name), /Plan approved/, name);
    });

    it("keeps the GPU's IP and instance name out of every stage, with no em dash and no raw colors", () => {
      for (const name of NAMES) {
        for (const html of [room(name), room(name, { liveDemo: LIVE_DEMOS.start, hub: HUB }), room(name, { admin: false })]) {
          assert.doesNotMatch(html, INSTANCE_DETAILS, name);
          assert.equal(html.includes(EM_DASH), false, `${name}: no em dash`);
          assert.doesNotMatch(html, /style="[^"]*(#[0-9a-f]{3,8}|rgba?\()/i, `${name}: no raw colors`);
        }
      }
    });
  });

  describe("a ready run", () => {
    it("has the verdict, the eval results and Where it runs, and its cost in all", () => {
      const html = room("ready");
      assert.match(html, /<p class="tune-verdict">[\s\S]*<span>Ready\. Tuned won 18 of 20 kept-aside prompts \(8\.4 vs 3\.1\)\.<\/span><\/p>/);
      assert.match(html, /id="eval-results"/);
      assert.match(html, /<section class="tune-where" aria-labelledby="tune-where-title">/);
      assert.match(html, /\$5\.95 in all/);
      assert.ok(html.indexOf('id="eval-results"') < html.indexOf('class="tune-where"'), "the results come first");
    });

    it("says Built with Muse Spark Open for a run trained from r30b, before its results, and compares with the 2026 Glimmer", () => {
      const ready = ROOM_FIXTURES.ready.view;
      const job = { ...ready.job!, params: { ...ready.job!.params, baseModel: "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit" } };
      const html = room("ready", { initial: { ...ready, job } });
      const built = html.indexOf("<strong>Built with Muse Spark Open.</strong>");
      assert.ok(built > 0 && built < html.indexOf('id="eval-results"'), "with the verdict, before the results");
      assert.match(html, /<th scope="col">2026 Glimmer \(r30b\)<\/th>/);
      assert.doesNotMatch(room("ready"), /Built with Muse Spark Open/, "a run from before the switch");
    });

    it("says it didn't pass once, in the verdict's own words", () => {
      const html = room("readyNotPassed");
      assert.match(html, /<span>Tuned won 6 of 20 kept-aside prompts \(4\.9 vs 6\.2\)\. That isn&#x27;t clearly better than base, so it didn&#x27;t pass\.<\/span>/);
      assert.doesNotMatch(html, /<span>Ready\./);
      assert.equal(count(html, "didn&#x27;t pass"), 1);
    });

    it("says a run whose judging never finished wasn't scored, presenting, with no Scored anywhere", () => {
      const html = room("readyUnscored");
      assert.match(html, /<span>Judging didn&#x27;t finish, so the items below have no verdicts\. It wasn&#x27;t scored, so it hasn&#x27;t passed\.<\/span>/);
      assert.match(html, /<div class="plan-card" data-art="present">/);
      assert.doesNotMatch(html, /Scored\.|<span>Ready\./);
    });

    it("offers the live demo in the room: Start a live demo, or Try it live while one is open", () => {
      assert.doesNotMatch(room("ready"), /id="live-demo"|Try it live<\/h2>/, "no demo read, no box");
      const start = room("ready", { liveDemo: LIVE_DEMOS.start });
      assert.match(start, /<section class="card section-card lab-try" id="live-demo"/);
      assert.match(start, /Start a live demo/);
      assert.match(start, /from Live demo above\./);
      const live = room("ready", { liveDemo: LIVE_DEMOS.live });
      assert.match(live, /<h2 id="[^"]+">Try it live<\/h2>/);
      assert.match(live, new RegExp(`/fine-tuning/${SERVE_ID}`), "admins get the serve job's link");
    });

    it("gives admins the Hugging Face card and Local files, as on the job's page, and nobody else", () => {
      const admin = room("ready", { hub: HUB });
      assert.match(admin, /id="hugging-face"/);
      assert.match(admin, /id="local-files"/);
      assert.match(admin, /once Local files above has made them\./);
      // No board training to link to: a board trains only Llama 3.x, which isn't a Meta model (Nov 2).
      assert.doesNotMatch(admin, /href="\/device">Open the board/);
      const guest = room("ready", { admin: false, hub: HUB });
      assert.doesNotMatch(guest, /id="hugging-face"|id="local-files"|href="\/device"/);
      assert.match(guest, new RegExp(`made from Local files on <a href="/fine-tuning/${JOB_ID}">the job&#x27;s page</a>\\.`));
      assert.doesNotMatch(room("ready"), /id="hugging-face"|id="local-files"/, "no setup, no cards");
    });

    it("takes a newer run from the page when it refreshes", () => {
      // The same component given a newer `initial` renders it (Start a live demo refreshes the page).
      const html = room("ready", { initial: { ...ROOM_FIXTURES.ready.view, title: "a made-up plant care coach" } });
      assert.match(html, /<h1 class="chat-title-chip">A made-up plant care coach<\/h1>/);
    });
  });

  describe("the plan step", () => {
    it("turns into the room at once: the person's words and files as a bubble, and Muse Wonder drafting the plan", () => {
      const html = planStep({ at: "drafting", note: "Answer questions for my made-up bakery.", files: ["examples.csv"] });
      assert.match(html, /<h1 class="chat-title-chip">New fine-tune<\/h1>/);
      assert.match(html, /<li class="turn-user">[\s\S]*Answer questions for my made-up bakery\.[\s\S]*examples\.csv/);
      assert.match(html, /<li class="room-working" aria-live="polite">[\s\S]*Muse Wonder is drafting the plan[\s\S]*Naming the model, checking the task, and pricing the run\./);
      assert.doesNotMatch(html, /class="plan-card"/);
    });

    it("then shows the plan card, presenting, with Start, Change it and Advanced, and the cost with its estimates named", () => {
      const html = planStep({ at: "plan", note: "Answer questions for my made-up bakery.", files: [], plan: plan() });
      assert.match(html, /<h1 class="chat-title-chip">A made-up bakery&#x27;s counter helper<\/h1>/);
      assert.match(html, /<div class="plan-card" data-art="present">/);
      assert.match(html, /<h3>How it&#x27;s made<\/h3><ol><li>Muse Wonder writes 200 examples in the style of your 24, and keeps 20 aside to score it\.<\/li>/);
      assert.match(html, /<h3>It might be asked<\/h3><p>&quot;Do you have nut-free cupcakes\?&quot;<\/p>/);
      assert.match(html, /The examples and the scoring are estimates: what Muse Wonder costs per example hasn&#x27;t been measured yet\./);
      assert.match(html, /<button type="button" class="btn btn-primary"[^>]*>Start<\/button><button type="button" class="btn btn-outline">Change it<\/button>/);
      assert.match(html, /<details class="tune-advanced"><summary>Advanced/);
      assert.match(html, /<label for="[^"]+">Examples to write<\/label><input id="[^"]+" type="number" inputMode="numeric" min="40" max="1000" step="10" value="200"/);
      assert.ok(html.indexOf("Start</button>") > html.indexOf("What it costs"), "the actions end the summary");
    });

    it("prices the number Advanced picks, and won't start outside 40 to 1000", () => {
      const more = planStep({ at: "plan", note: "n", files: [], plan: plan() }, { examples: 400 });
      assert.match(more, /Muse Wonder writes 400 examples in the style of your 24, and keeps 40 aside to score it\./);
      const few = planStep({ at: "plan", note: "n", files: [], plan: plan() }, { examples: 5 });
      assert.match(few, /<button type="button" class="btn btn-primary" disabled=""[^>]*>Start/);
      assert.match(few, /Pick 40 to 1000 examples\./);
      const twenty = planStep({ at: "plan", note: "n", files: [], plan: plan() }, { examples: 20 });
      assert.match(twenty, /<button type="button" class="btn btn-primary" disabled=""[^>]*>Start/, "20 can't leave 16 to train on and 8 to score with");
    });

    it("says why it couldn't start, and shows Starting while it does", () => {
      const error = planStep({ at: "plan", note: "n", files: [], plan: plan() }, { startError: "This plan is more than two hours old. Change it and send it again." });
      assert.match(error, /<p class="form-error" role="alert">[\s\S]*more than two hours old/);
      const starting = planStep({ at: "plan", note: "n", files: [], plan: plan() }, { starting: true });
      assert.match(starting, /disabled="" aria-busy="true"><span class="spinner" aria-hidden="true"><\/span>Starting<\/button>/);
      assert.match(starting, /<button type="button" class="btn btn-outline" disabled="">Change it/);
    });

    it("shows a refusal or a failure with Change it, and no card", () => {
      const html = planStep({ at: "problem", note: "n", files: [], text: "Muse Muse can't train a model on real people's private details." });
      assert.match(html, /<p role="alert">Muse Muse can&#x27;t train a model on real people&#x27;s private details\.<\/p>[\s\S]*Change it/);
      assert.doesNotMatch(html, /class="plan-card"/);
    });

    it("says a decision plan trains as a chat model, and links the decision dataset card for one trained on labeled rows", () => {
      const html = planStep({ at: "plan", note: "n", files: [], plan: plan({ kind: "decision" }) });
      assert.match(html, /<p class="plan-card-more"><span class="muted">It picks one of a few labels\. Start trains it as a chat model; to train a decision model on your own labeled rows, <a href="\/fine-tuning#new-decision-dataset">make a decision dataset<\/a>\.<\/span><\/p>/);
      assert.doesNotMatch(planStep({ at: "plan", note: "n", files: [], plan: plan() }), /new-decision-dataset/);
    });

    it("has Advanced's training steps, up to as many as fit in the run's time limit, and prices them", () => {
      const html = planStep({ at: "plan", note: "n", files: [], plan: plan() }, { steps: 300 });
      assert.match(html, /<label for="[^"]+">Training steps<\/label><input id="[^"]+" type="number" inputMode="numeric" min="10" max="350" step="10" value="300"/);
      assert.match(html, /Each step trains on 4 examples\. About an hour on the GPU, within its 90-minute limit\./);
      assert.match(html, /<li>[^<]*huggingface\.co\/OfflineBase\/Glimmer-30B-2026-Knowledge\), trains on one GPU, about an hour\.<\/li>/, "the card's how it's made follows the steps");
      const tooMany = planStep({ at: "plan", note: "n", files: [], plan: plan() }, { steps: 400 });
      assert.match(tooMany, /Pick 10 to 350 steps: more don&#x27;t fit in the run&#x27;s 90-minute limit\./);
      assert.match(tooMany, /<button type="button" class="btn btn-primary" disabled="" aria-busy="false">Start<\/button>/);
      assert.doesNotMatch(html, /Training steps: 120\. To change them/);
    });

    it("says how many of the person's rows fit in the task when some didn't", () => {
      const html = planStep({ at: "plan", note: "n", files: [], plan: plan({ examples: { given: 24, used: 3 } }) });
      assert.match(html, /Muse Wonder writes 200 examples in the style of 3 of your 24 \(only 3 fit in the task, so the rest aren&#x27;t used\), and keeps 20 aside to score it\./);
    });
  });

  describe("Where it runs", () => {
    const where = (over: Record<string, unknown> = {}) => render(WhereItRuns, { jobHref: null, demoHere: false, localFilesHere: false, ...over });

    it("says Muse Glimmer 30B doesn't fit an 8 GB Jetson", () => {
      const html = where();
      assert.match(html, /<strong>Not on a Jetson Orin Nano\.<\/strong> Muse Glimmer 30B needs more memory than the board&#x27;s 8 GB\./);
      assert.match(html, /<strong>On a computer with 24 GB of memory or more,<\/strong> from its local files \(GGUF, for LM Studio, llama\.cpp\s+and Ollama\)\./);
      assert.match(html, /<strong>Here, in its live demo\.<\/strong> One GPU serves it for a set time, 30 minutes unless\s+you pick another\./);
      assert.equal(html.includes(EM_DASH), false);
    });

    it("offers no Llama, on a board or elsewhere, since the organizers ruled on Nov 2 that it isn't a Meta model", () => {
      for (const html of [where(), where({ quantTargets: true })]) {
        assert.doesNotMatch(html, /Llama|Meta&#x27;s small model|Train a small model|\/device/);
      }
      assert.match(where({ quantTargets: true }), /<strong>On a Jetson Orin Nano, maybe, from one-bit Muse Glimmer\.<\/strong>/);
    });

    it("points at the live demo and local files where they are: above in the room, or on the job's page", () => {
      assert.match(where({ demoHere: true, localFilesHere: true }), /pick another, from Live demo above\.[\s\S]*Ollama\), once Local files above has made them\./);
      const job = where({ jobHref: `/fine-tuning/${JOB_ID}` });
      assert.match(job, new RegExp(`pick another, from Live demo on <a href="/fine-tuning/${JOB_ID}">the job&#x27;s page</a>\\.`));
      assert.match(job, new RegExp(`Ollama\\), made from Local files on <a href="/fine-tuning/${JOB_ID}">the job&#x27;s page</a>\\.`));
    });
  });

  describe("the plan card's PlanView", () => {
    const fixtureBrief = async () => (await import("@/components/build/__tests__/room-fixture")).brief as Brief;
    const variants = async (): Promise<Array<[string, Brief]>> => {
      const b = await fixtureBrief();
      return [
        ["can build part of it", b],
        ["can build it", { ...b, verdict: "yes" }],
        ["no one it's for", { ...b, user: "  " }],
        ["no steps", { ...b, primaryFlow: [" ", ""] }],
        ["no tagline", { ...b, tagline: " " }],
      ];
    };

    it("is the card PlanCard draws, which keeps the whole brief behind See the full plan and wraps it beside the picture", async () => {
      // tg-plan-art, then the short plan (#37): the build room's card shows the short plan, keeps the whole brief
      // (BriefBody) folded under it, and wraps beside the picture; the fine-tune room's card doesn't wrap. They share the
      // card, art and head.
      const PlanCard = card.PlanCard as ComponentType<never>;
      const PlanViewCard = card.PlanViewCard as ComponentType<never>;
      const { BriefBody } = await import("@/components/build/turns");
      for (const [name, brief] of await variants()) {
        for (const art of ["present", "building", "shield"] as const) {
          for (const running of [true, false]) {
            const view = card.planViewFromBrief(brief);
            const body = createElement(
              "details",
              { className: "plan-card-full" },
              createElement("summary", null, "See the full plan"),
              createElement(BriefBody as ComponentType<never>, { brief, title: false } as never),
            );
            assert.equal(
              render(PlanCard, { brief, art, running }),
              render(PlanViewCard, { view, art, running, say: card.planSays(art, running), wrap: true, body }),
              `${name}, ${art}, running ${running}`,
            );
            const room = render(PlanViewCard, { view: card.planViewFromBrief(brief), art, running });
            assert.match(room, new RegExp(`class="plan-card" data-art="${art}"`), `${name}: the fine-tune room's card doesn't wrap`);
          }
        }
      }
    });

    it("maps a brief to its name, tagline, badge and a short plan, ending on the first limit when it can build part of it", async () => {
      // The short plan (#37): at most PLAN_LINES short steps, and for "partly" the last line is what it won't do.
      const [[, partly], [, b], [, noUser], [, noFlow]] = await variants();
      type Section = { steps?: readonly string[]; text?: string };
      const kinds = (brief: Brief) => (card.planViewFromBrief(brief).sections as readonly Section[]).map((s) => (s.steps ? "steps" : "text"));
      const v = card.planViewFromBrief(b!);
      assert.equal(v.name, b!.name);
      assert.equal(v.tagline, b!.tagline.trim());
      assert.equal(v.badge, null);
      assert.deepEqual(kinds(b!), ["steps"]);
      assert.ok((v.sections[0] as Section).steps!.length <= card.PLAN_LINES);
      const p = card.planViewFromBrief(partly!);
      assert.deepEqual(p.badge, { label: "Can build part of it", tone: "partial" });
      assert.deepEqual(kinds(partly!), ["steps", "text"]);
      assert.match((p.sections[1] as Section).text!, /^Won't do: /);
      assert.ok((p.sections[0] as Section).steps!.length <= card.PLAN_LINES - 1);
      assert.deepEqual(kinds(noUser!), kinds(partly!), "who it's for isn't on the short card");
      assert.deepEqual(kinds(noFlow!), ["text"]);
    });
  });

  describe("the stylesheet", () => {
    const css = () => readFileSync(path.join(ROOT, "components/train/tune.css"), "utf8");

    it("uses tokens only, and only new tune- classes, so no other page changes", () => {
      const s = css().replace(/\/\*[\s\S]*?\*\//g, "");
      assert.deepEqual(s.split("\n").filter((l) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i.test(l)), []);
      for (const selector of s.match(/^[^@{}\s][^{}]*(?=\{)/gm) ?? []) {
        for (const part of selector.split(",")) assert.match(part.trim(), /\.tune-/, `${part.trim()} is scoped to a tune- class`);
      }
    });

    it("is phone first, with nothing wider than 358 px, and nothing moves under reduced motion", () => {
      const s = css();
      assert.doesNotMatch(s, /@media \(max-width/, "phone first, as app/globals.css");
      for (const [, px] of s.matchAll(/(?<![-\w])width:\s*(\d+)px/g)) assert.ok(Number(px) <= 358, `width ${px}px fits a 390 px phone with its 16 px gutters`);
      assert.match(s, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*transition: none;/);
      for (const [, ms] of s.matchAll(/transition:[^;]*?(\d+)ms/g)) assert.ok(Number(ms) <= 150, "fades of 150 ms at most (docs/UI_MUSE_APP.md, Motion)");
    });

    it("loads with both new pages, and with nothing else", () => {
      for (const layout of ["app/fine-tuning/new/layout.tsx", "app/fine-tuning/runs/layout.tsx"]) {
        assert.match(readFileSync(path.join(ROOT, layout), "utf8"), /import "@\/components\/train\/tune\.css";/, layout);
      }
      assert.doesNotMatch(readFileSync(path.join(ROOT, "app/layout.tsx"), "utf8"), /tune\.css/);
    });
  });
});
