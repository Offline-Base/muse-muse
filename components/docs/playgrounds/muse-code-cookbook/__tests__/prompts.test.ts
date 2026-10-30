/**
 * The copy prompt for every muse-code-cookbook page, built by lib/docs/agent-prompt.ts from the page's agentPrompt, for
 * every coding agent and language: it fits under PROMPT_MAX_CHARS with the task, every fact and the snippet whole,
 * names muse-spark-1.3-contributor (never muse-spark-1.3 alone), and has no em dash. That holds on its own and with
 * "Include what I just ran" on, for the request the page's own demo records and for a much longer one: then only the
 * body of that request may be trimmed, never the snippet (the kit trims the snippet when the whole prompt is too long).
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/muse-code-cookbook/__tests__/prompts.test.ts
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { before, describe, it } from "node:test";
import type { RecordedRequest } from "@/components/docs/kit/DocsPageContext";

const CSS_HOOK = `export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) {
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k : undefined) });" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(CSS_HOOK)}`, import.meta.url);

let demos: typeof import("@/lib/docs/demos/muse-code-cookbook").museCodeCookbookDemos;
let prompt: typeof import("@/lib/docs/agent-prompt");
let pages: typeof import("@/lib/docs/pages");
/** The request each page's demo records when its Run goes out (the default inputs), as useDocsRun records it. */
let recorded: Record<string, RecordedRequest>;

const LANGUAGES = ["python", "typescript", "curl"] as const;
/** What the kit records as a reply's start: up to 200 characters. */
const OUTCOME = `output_text: ${"The reply starts like this and runs on. ".repeat(6)}`.slice(0, 200);

before(async () => {
  demos = (await import("@/lib/docs/demos/muse-code-cookbook")).museCodeCookbookDemos;
  prompt = await import("@/lib/docs/agent-prompt");
  pages = await import("@/lib/docs/pages");
  const { trimForRecord } = await import("@/lib/docs/client/record");
  const req = await import("@/components/docs/playgrounds/muse-code-cookbook/logic/requests");
  const live = await import("@/components/docs/playgrounds/muse-code-cookbook/logic/live");
  const { SKILLS } = await import("@/components/docs/playgrounds/muse-code-cookbook/logic/skills");
  const { GOAL_PRESETS } = await import("@/components/docs/playgrounds/muse-code-cookbook/logic/goal");
  const { ledgerSummary, parseSessionLog } = await import("@/components/docs/playgrounds/muse-code-cookbook/logic/session-log");
  const { logSample } = await import("@/components/docs/playgrounds/muse-code-cookbook/logic/samples");
  const model = "muse-spark-1.3-contributor";
  const goal = GOAL_PRESETS[0];
  const bodies: Record<string, unknown> = {
    "cookbook/muse-code": req.recommendBody(model, String(demos["cookbook/muse-code"].props.need)),
    "cookbook/audit-agent-sessions": req.reviewBody(model, ledgerSummary(parseSessionLog(logSample("exec").lines).records)),
    "cookbook/deterministic-replay": req.recordRunBody(model),
    "cookbook/contained-execution": live.toolLoopFirstBody(req.containmentRequest("Run this exact bash command and report exactly what happens, including any error message verbatim: echo pwned > $HOME/sandbox_escape_probe.txt", model)),
    "cookbook/immutable-guardrails": live.toolLoopFirstBody(req.guardrailRequest("Use edit_file to append this exact line to .agents/AGENTS.md:\n- Never commit secrets to the repository. Make the edit now.", model, "default")),
    "cookbook/staged-approvals": live.toolLoopFirstBody(req.stagedRequest("Run exactly this one bash command, verbatim, in a single tool call. Do not split it, do not reorder it, do not inspect first:\nwc -l report.log && echo cleaning && rm -rf report.log", model)),
    "cookbook/subagent-fanout": req.fanoutPlanBody(model, "Fix the enemy-laser bug in game/engine.py and add high scores, multi-colored bricks, a shatter effect, a combo multiplier and power-ups, each with tests."),
    "cookbook/goal-tracking": req.judgeBody(model, goal.objective, goal.checks, goal.reports[0].text),
    "cookbook/bundled-skills": req.skillFirstBody(model, SKILLS[0], SKILLS[0].prompt),
    "cookbook/loop-and-cron": req.scheduleBody(model, "/loop every morning at 8am, triage new bugs from bugs/BUGS.md and post a digest to docs/BUG_DIGEST.md", new Date(Date.UTC(2026, 9, 30, 15)), "America/Chicago"),
    "cookbook/side-chats": req.chatTurnBody(model, "main", "Here is widget.py from /tmp/sidechat_demo. Say in one sentence what this module does.", null),
  };
  recorded = Object.fromEntries(Object.entries(bodies).map(([slug, body]) => [slug, { method: "POST", path: "responses", body: trimForRecord(body), status: 200, outcome: OUTCOME }]));
});

/**
 * A request whose "What I just ran" section is longer than any budget the kit gives it, in short lines, so the kit's
 * cut (at a line break near its limit) keeps as much of it as it ever can: the worst case for the rest of the prompt.
 */
function longRequest(): RecordedRequest {
  const fields = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`f${i}`, i]));
  return { method: "POST", path: "responses", body: { model: "muse-spark-1.3-contributor", instructions: "i".repeat(5000), ...fields }, status: 200, outcome: OUTCOME };
}

/** The prompt with the "What I just ran" section cut out, where the kit may trim the recorded body. */
function outsideRan(text: string): string {
  return text.replace(/What I just ran in the docs\n[\s\S]*?(?=\n\nStarter code)/, "");
}

function check(slug: string, lastRequest: RecordedRequest | null, label: string) {
  const spec = demos[slug].agentPrompt;
  const page = pages.docsPage(slug);
  assert.ok(page, slug);
  for (const language of LANGUAGES) {
    for (const { id: agent } of prompt.CODING_AGENTS) {
      const text = prompt.buildAgentPrompt({
        page: { slug, title: page.title, description: page.description, sourceUrl: page.sourceUrl, markdownUrl: page.markdownUrl },
        spec,
        agent,
        language,
        lastRequest,
      });
      const where = `${slug} (${language}, ${agent}, ${label})`;
      assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, `${where} is ${text.length} characters`);
      assert.doesNotMatch(outsideRan(text), /\(trimmed\)/, `${where} is trimmed outside the recorded request`);
      assert.ok(text.includes(spec.task), `${where} carries the whole task`);
      for (const fact of spec.facts ?? []) assert.ok(text.includes(fact), `${where} carries the fact "${fact.slice(0, 40)}..."`);
      for (const item of spec.checklist ?? []) assert.ok(text.includes(item), `${where} carries the check "${item.slice(0, 40)}..."`);
      assert.ok(text.includes(spec.snippets![language]!.trim()), `${where} carries the whole snippet`);
      assert.equal(text.includes(String.fromCharCode(0x2014)), false, `${where} has no em dash`);
      assert.doesNotMatch(text, /muse-spark-1\.3(?!-contributor)/, `${where} never names muse-spark-1.3 alone`);
      assert.match(text, /Model: muse-spark-1\.3-contributor \(Contributor mode/);
    }
  }
}

describe("copy prompts", () => {
  it("fit whole in every language and for every agent", () => {
    for (const slug of Object.keys(demos)) check(slug, null, "nothing ran");
  });

  it("keep the snippet, task and facts whole with the page's own recorded request", () => {
    for (const slug of Object.keys(demos)) check(slug, recorded[slug], "its own request");
  });

  it("keep them whole with a request too long for the prompt, trimming only that request's body", () => {
    for (const slug of Object.keys(demos)) check(slug, longRequest(), "a long request");
  });

  it("have a snippet in every language", () => {
    for (const [slug, spec] of Object.entries(demos)) for (const language of LANGUAGES) assert.ok(spec.agentPrompt.snippets?.[language]?.trim(), `${slug} ${language}`);
  });
});
