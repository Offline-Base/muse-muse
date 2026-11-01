/**
 * The jobs cap's part of the prompts (docs/CAPABILITIES.md, 2.6 and section 12): the block, what the writer may pick, the
 * build prompt with its Budget line, and how a build drops it. Pure: no database, no model call.
 *   npx tsx --test lib/caps/jobs/__tests__/brief.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Brief } from "@/lib/brief/schema";
import { renderBuildPrompt } from "@/lib/brief/render";
import { BriefSchema } from "@/lib/brief/schema";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { capsMarkdown, capsRefineLines } from "@/lib/caps/render";
import { capsJudgeNotes } from "@/lib/caps/judge";
import { capsFileFor } from "@/lib/caps/overlays";
import { capsForBuild } from "@/lib/caps/ready";
import { jobsBlock, jobsWriterBlock, jobsWriterRules, normalizeJobsBlock } from "@/lib/caps/jobs/brief";
import { JOBS_CATALOG } from "@/lib/caps/jobs/catalog";
import { collectionRules, narrowCollectionRules } from "@/lib/caps/data/types";
import { withJobWrites } from "@/lib/caps/jobs/rules";
import { shippedSchedules } from "@/lib/caps/jobs/ship";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const DATA = { collections: [{ name: "digests", scope: "shared", writes: "owner", holds: "One digest.", personal: false }, { name: "mine", scope: "visitor", writes: "owner", holds: "Mine.", personal: true }], signIn: "none" };
const JOBS = { schedules: [{ name: "digest", every: "1 day at 07:30", does: "Makes a digest." }], webhooks: [{ name: "log", from: "A form", does: "Logs it." }], results: ["digests"] };
const WITH = { ...BRIEF, data: DATA, jobs: JOBS } as unknown as Brief;
const OPTS = { inspoFiles: [], fixtures: [], maxModelSteps: 10 } as unknown as Parameters<typeof renderBuildPrompt>[1];

afterEach(() => {
  delete process.env.JOBS_WEBHOOKS;
});

describe("the jobs block", () => {
  it("parses in the stored brief, and is optional", () => {
    assert.ok(BriefSchema.safeParse(WITH).success);
    assert.ok(BriefSchema.safeParse(BRIEF).success);
  });

  it("leaves webhooks out while JOBS_WEBHOOKS is off, and results out without the data block", () => {
    assert.equal(jobsBlock(WITH)?.webhooks.length, 0);
    assert.equal(jobsBlock(WITH, true)?.webhooks.length, 1);
    assert.deepEqual(jobsBlock({ jobs: JOBS }, true)?.results, []);
    assert.deepEqual(jobsBlock({ data: DATA, jobs: { ...JOBS, results: ["mine", "gone", "digests"] } }, true)?.results, ["digests"], "never a person's own items");
  });

  it("is null when there's nothing left to run", () => {
    assert.equal(jobsBlock({ jobs: { schedules: [], webhooks: JOBS.webhooks, results: [] } }, false), null);
    assert.equal(jobsBlock({ jobs: "junk" }), null);
    assert.equal(jobsBlock({}), null);
  });

  it("the writer's block takes no webhooks while they're off", () => {
    assert.equal(jobsWriterBlock(false).safeParse(JOBS).success, false);
    assert.equal(jobsWriterBlock(true).safeParse(JOBS).success, true);
    assert.equal(jobsWriterBlock(false).safeParse({ ...JOBS, webhooks: [] }).success, true);
  });

  it("normalizes what the writer sends", () => {
    const out = normalizeJobsBlock(
      {
        schedules: [
          { name: "Daily Digest!", every: "every day at 07:30", does: "x".repeat(300) },
          { name: "daily-digest", every: "1 hour", does: "a repeat of the name" },
          { name: "broken", every: "whenever", does: "isn't a schedule" },
          { name: "second", every: "5 minutes", does: "Runs often." },
          { name: "third", every: "1 hour", does: "Fine." },
          { name: "fourth", every: "1 hour", does: "One too many." },
        ],
        webhooks: [{ name: "from-form", from: "A form", does: "Logs." }, { name: "second", from: "Name taken.", does: "x" }],
        results: ["digests", "mine", "gone", 3],
      },
      DATA,
      true,
    ) as typeof JOBS;
    assert.deepEqual(out.schedules.map((s) => s.name), ["daily-digest", "second", "third"]);
    assert.ok(out.schedules[0]!.does.length <= 200);
    assert.deepEqual(out.webhooks.map((w) => w.name), ["from-form"]);
    assert.deepEqual(out.results, ["digests"]);
    assert.equal(normalizeJobsBlock({ schedules: [{ name: "x", every: "never" }], webhooks: [{ name: "y" }], results: [] }, null, false), null);
  });

  it("marks a collection for jobs only with the brief, and a manifest only takes the mark away", () => {
    const rules = withJobWrites(collectionRules(DATA), { data: DATA, jobs: JOBS })!;
    assert.deepEqual(rules.map((r) => [r.name, r.jobWrites ?? false]), [["digests", true], ["mine", false]]);
    assert.equal(withJobWrites(collectionRules(DATA), { data: DATA })![0]!.jobWrites, undefined);
    const mark = (name: string) => narrowCollectionRules(rules, collectionRules({ collections: [{ name: "digests", scope: "shared", ...(name === "digests" ? { jobWrites: true } : {}) }, { name: "mine", scope: "visitor", ...(name === "mine" ? { jobWrites: true } : {}) }] }));
    assert.equal(mark("digests")[0]!.jobWrites, true);
    assert.equal(mark("mine")[0]!.jobWrites, undefined, "unmarked in the manifest");
    assert.equal(mark("mine")[1]!.jobWrites, undefined, "a manifest can't add one");
    assert.equal(narrowCollectionRules(rules, null)[0]!.jobWrites, true, "no data block narrows nothing");
  });

  it("schedules at deploy: a manifest narrows and can change the time, and adds nothing", () => {
    const block = { schedules: [{ name: "digest", every: "1 day" }, { name: "other", every: "1 hour" }] };
    assert.deepEqual(shippedSchedules(block, null), block.schedules);
    assert.deepEqual(shippedSchedules(block, { jobs: {} }), block.schedules);
    assert.deepEqual(shippedSchedules(block, { jobs: { schedules: [{ name: "digest", every: "2 days" }, { name: "new", every: "1 hour" }] } }), [{ name: "digest", every: "2 days" }]);
    assert.deepEqual(shippedSchedules(block, { jobs: { schedules: [] } }), []);
  });
});

describe("the prompts", () => {
  it("the build prompt has its section, and the Budget line changes only for this brief", () => {
    process.env.JOBS_WEBHOOKS = "1";
    const prompt = renderBuildPrompt(WITH, OPTS);
    assert.match(prompt, /### Background jobs/);
    for (const part of ["muse-jobs/SKILL.md", "jobHandler", "checkpoint(job, state)", "`notifyOwner", "jobWrites", "fireJob", "fireWebhook", "checkResultShown", "`digest`", "`log`", "1 day at 07:30", "14 days", "`enqueue(request"]) assert.ok(prompt.includes(part), part);
    assert.match(prompt, /Background work goes only through the jobs helper\. Nothing in your session keeps running after it ends\./);
    assert.doesNotMatch(prompt, /never wait for it, retry it or schedule anything/);
    assert.doesNotMatch(prompt, /—/);
    const plain = renderBuildPrompt(BRIEF as unknown as Brief, OPTS);
    assert.match(plain, /never wait for it, retry it or schedule anything/);
    assert.doesNotMatch(plain, /Background work goes only/);
    assert.doesNotMatch(plain, /Background jobs/);
  });

  it("names no webhook test while webhooks are off", () => {
    const prompt = renderBuildPrompt(WITH, OPTS);
    assert.doesNotMatch(prompt, /fireWebhook/);
    assert.doesNotMatch(prompt, /`log`/);
  });

  it("says plainly when a brief has no results collection", () => {
    assert.match(renderBuildPrompt({ ...BRIEF, jobs: { ...JOBS, results: [] } } as unknown as Brief, OPTS), /only reads and tells the owner/);
  });

  it("the writer's rules and catalog follow the switch, and never promise a send", () => {
    assert.match(jobsWriterRules(false).join(" "), /jobs\.webhooks: \[\]/);
    assert.match(jobsWriterRules(true).join(" "), /private address/);
    assert.doesNotMatch(JOBS_CATALOG.block, /private address/);
    process.env.JOBS_WEBHOOKS = "1";
    assert.match(JOBS_CATALOG.block, /private address/);
    for (const text of [...jobsWriterRules(true), JOBS_CATALOG.block]) assert.doesNotMatch(text, /—/);
    assert.match(JOBS_CATALOG.block, /confirm/);
  });

  it("refine, markdown and judge name the jobs, and say a result shows on a screen", () => {
    assert.match(capsRefineLines(WITH).join("\n"), /`digest`/);
    assert.match(capsMarkdown(WITH).join("\n"), /digest, every 1 day at 07:30/);
    assert.match(capsJudgeNotes(WITH), /A background job ran during this test/);
    assert.match(capsJudgeNotes(WITH), /Last digest/);
  });

  it("gives the token its marker and the sandbox its overlay", () => {
    assert.ok(allowedModelsFor(WITH).includes("cap:jobs"));
    assert.deepEqual(capsFileFor(WITH), { caps: ["data", "jobs"], overlays: ["core", "data", "jobs"] });
  });
});

describe("a build", () => {
  const on = { enabled: ["jobs", "data"] as const, onSite: ["jobs", "data"] as const };

  it("keeps the block when the cap is on, and drops it as switched off when it isn't", () => {
    const kept = capsForBuild(WITH, { enabled: [...on.enabled], onSite: [...on.onSite] });
    assert.deepEqual(kept.dropped, []);
    const off = capsForBuild(WITH, { enabled: ["data"], onSite: ["data"] });
    assert.deepEqual(off.dropped, [{ cap: "jobs", reason: "off" }]);
    assert.equal((off.brief as { jobs?: unknown }).jobs, null);
  });

  it("drops a block of webhooks alone while webhooks are off", () => {
    const only = { ...BRIEF, jobs: { schedules: [], webhooks: JOBS.webhooks, results: [] } } as unknown as Brief;
    assert.deepEqual(capsForBuild(only, { enabled: ["jobs"], onSite: ["jobs"] }).dropped, [{ cap: "jobs", reason: "off" }]);
    process.env.JOBS_WEBHOOKS = "1";
    assert.deepEqual(capsForBuild(only, { enabled: ["jobs"], onSite: ["jobs"] }).dropped, []);
  });

  it("a dropped data cap takes the results with it, and the jobs stay", () => {
    const { brief, dropped } = capsForBuild(WITH, { enabled: ["jobs"], onSite: ["jobs"] });
    assert.deepEqual(dropped, [{ cap: "data", reason: "off" }]);
    assert.deepEqual(jobsBlock(brief)?.results, []);
    assert.equal(jobsBlock(brief)?.schedules.length, 1);
  });
});
