import { jobsBlock, type JobsBrief } from "@/lib/caps/jobs/brief";
import { JOBS_LIMITS } from "@/lib/caps/jobs/limits";
import { everyWords, parseEvery } from "@/lib/caps/jobs/schedule";
import type { CapRenderEntry } from "@/lib/caps/render";
import { dataBlock } from "@/lib/caps/data/brief";

/**
 * The jobs cap's part of the prompts (docs/CAPABILITIES.md, 2.6 and section 12). Its text names the platform files in
 * template/caps/jobs: lib/platform/jobs.ts, tests/caps/jobs.ts and the muse-jobs skill.
 */

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

/** What musemuse.json's jobs block says, for a prompt and for verify's check. */
export function jobsManifest(block: JobsBrief) {
  return {
    schedules: block.schedules.map((s) => ({ name: s.name, every: s.every })),
    webhooks: block.webhooks.map((w) => ({ name: w.name })),
  };
}

/** The Budget line a brief with jobs gets instead of "never wait for it, retry it or schedule anything". */
export const JOBS_BUDGET_LINE = "Background work goes only through the jobs helper. Nothing in your session keeps running after it ends.";

export const JOBS_RENDER: CapRenderEntry = {
  title: "Background jobs",
  build(brief) {
    const block = jobsBlock(brief);
    if (!block) return [];
    const lines: string[] = ["The brief asks for work that runs with nobody on the page:", ""];
    if (block.schedules.length) {
      lines.push("| Schedule | Every | What it does |", "|---|---|---|");
      for (const s of block.schedules) {
        const every = parseEvery(s.every);
        lines.push(`| \`${s.name}\` | ${every ? everyWords(every) : cell(s.every)} | ${cell(s.does)} |`);
      }
      lines.push("");
    }
    if (block.webhooks.length) {
      lines.push("| Webhook | Comes from | What it does |", "|---|---|---|");
      for (const w of block.webhooks) lines.push(`| \`${w.name}\` | ${cell(w.from)} | ${cell(w.does)} |`);
      lines.push("");
    }
    const collections = dataBlock(brief)?.collections ?? [];
    const results = block.results.map((r) => `\`${r}\` (${collections.find((c) => c.name === r)?.scope ?? "shared"})`);
    lines.push(
      "- Read `.agents/skills/muse-jobs/SKILL.md` first. It has the helper calls and every rule below.",
      "- Each job is its own route, `app/api/jobs/<name>/route.ts`: `export const POST = jobHandler(\"<name>\", async (job) => { ... })` from `lib/platform/jobs.ts`, with `export const maxDuration = 60`. A call without the platform's job token is refused before your code runs. A tick has 60 seconds: do what fits, then `return checkpoint(job, state)`, and the next tick starts with `job.checkpoint`. A run has at most " + JOBS_LIMITS.ticksPerRun + " ticks. Return nothing when it's finished.",
      "- Pass `job.request` to `metaClient`, `data` and every other helper, and make clients inside the handler. Everything you call there counts as this job.",
      "- A run stops at its `job.budgetUsd` (about $0.10). The gateway holds each call's `max_output_tokens` up front, so give every model call in a job `max_output_tokens: 2000` or less: with none named, a Muse Wonder call counts as 8,000 and is refused. A stopped run tells the owner.",
      results.length
        ? `- Results: a job may save only to ${results.join(", ")}, marked \`"jobWrites": true\` on that collection in \`musemuse.json\`'s data block. Everything else is refused, and it never reads a person's own items (visitor or user scope). Show the newest result on a screen, with a heading like "Last digest".`
        : "- Results: this product has no collection for jobs, so a job only reads and tells the owner.",
      "- Jobs read and notify. Tell the owner with `notifyOwner(job, { title, body })`, at most 10 a day: it shows in Muse Muse. A send from a job (`send(job.request, ...)`, if this product sends at all) goes nowhere: it answers `{ status: \"held\" }`, and the owner reads the whole message and confirms it later in Muse Muse. Never tell anyone a job sent something. A job can't write to any other outside service, and it can read only the services visitors may use.",
      "- A person's page can start a job with `enqueue(request, { name, input })` only when the owner is the one asking; it runs at the next tick, within about 5 minutes, up to 50 a day. A visitor can't start one.",
      `- \`musemuse.json\` gets \`"caps"\` with \`"jobs"\` and \`"jobs": ${JSON.stringify(jobsManifest(block))}\`, exactly these. The platform reads the schedules from it at deploy, and verify checks it against this section.`,
      "- Limits a person sees: schedules stop after 14 days with no visit from the owner, until the owner visits again. Say so on the product's settings or about screen.",
      "- In this build nothing runs on a clock. `fireJob(request, \"<name>\", input)` from `tests/caps/jobs.ts` gets a test token from the gateway and calls your route; call it again and the run goes on from its checkpoint, if it left one. Rows go to the build's test space. Notices and held sends are recorded and shown to no one.",
      `- Smoke test: \`fireJob\` at most twice in all${block.webhooks.length ? ", and `fireWebhook(request, \"<name>\", samplePayload)` once for each webhook, which posts it to a test address and runs the job it queued" : ""}. Then open the screen with the result and call \`checkResultShown(page, text)\`, which takes the judge screenshot "12-job-result". Assert structure, never a model's exact words.`,
      "- `template/AGENTS.md` says nothing runs after your session ends. That still holds for your session, but these routes run later on the live product, with nobody on the page.",
      "- `lib/platform/jobs.ts`, `tests/caps/jobs.ts` and `scripts/caps/jobs.mjs` are platform files. Wrap them, never edit them.",
    );
    return lines;
  },
  refine(brief) {
    const block = jobsBlock(brief);
    if (!block) return [];
    const names = [...block.schedules, ...block.webhooks].map((j) => `\`${j.name}\``).join(", ");
    return [`- It has background jobs ${names}, each a route at \`app/api/jobs/<name>/route.ts\` with \`jobHandler\` (\`.agents/skills/muse-jobs/SKILL.md\`). Keep them, and keep \`musemuse.json\`'s \`jobs\` block in step: the platform updates the schedules from it at deploy. Jobs read and notify, and writes to the outside wait for the owner.`];
  },
  markdown(brief) {
    const block = jobsBlock(brief);
    if (!block) return [];
    return [
      ...(block.schedules.length ? [`Schedules: ${block.schedules.map((s) => `${s.name}, every ${s.every} (${s.does})`).join("; ")}.`] : []),
      ...(block.webhooks.length ? [`Webhooks: ${block.webhooks.map((w) => `${w.name}, from ${w.from} (${w.does})`).join("; ")}.`] : []),
      ...(block.results.length ? [`Saves to: ${block.results.join(", ")}.`] : []),
    ];
  },
};
