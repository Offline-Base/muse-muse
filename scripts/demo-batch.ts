/**
 * Starts one test build per cookbook recipe, plus the legal case agent, on the live site, then exits. The builds run on
 * Vercel, so the laptop can close once this prints "started". Every note uses made-up data, and builds run on whatever
 * model the site is set to (Muse Spark 1.3 Contributor while BUILDS_ON_CONTRIBUTOR is on).
 *   npm run demo-batch                      start them all on https://musemuse.dev
 *   npm run demo-batch -- --dry             print the notes, start nothing
 *   npm run demo-batch -- --url=<site>      another deployment
 *   npm run demo-batch -- legal games       only the named ones
 *   npm run demo-batch -- --set=targets     one build per target: phone, desktop, vr, glasses, agent, edge
 * Uses AUTOMATION_SECRET from .env.local, acting as the first ADMIN_EMAILS user (no daily build limit), the same way
 * scripts/rebuild-all.ts does. The secret is sent only as the Authorization header and never printed.
 * Writes the build links to .data/demo-batch-<time>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { env } from "@/lib/env";
import { CASE_AGENT_SAMPLE_NOTE } from "@/lib/recipes/registry";

type DemoNote = { id: string; recipe: string; note: string; targets?: readonly string[] };

const DEMO_NOTES: readonly DemoNote[] = [
  { id: "legal", recipe: "recipe-case-agent", note: CASE_AGENT_SAMPLE_NOTE },
  {
    id: "api",
    recipe: "recipe-api",
    note: "Build a policy reader: I paste a long made-up city parking policy, it streams a plain summary, answers my questions with exact quotes, checks today's facts with web search and footnotes, and shows the tokens used and how many came from the cache.",
  },
  {
    id: "alerts",
    recipe: "recipe-agent-patterns",
    note: "Build an alert triage copilot for a made-up small warehouse: I paste a noisy feed of sensor alerts, it groups the real patterns with the alerts that prove each one, lets me ask follow-up questions in a side chat, and rates its own confidence in strict JSON.",
  },
  {
    id: "charts",
    recipe: "recipe-visual-reports",
    note: "Build a chart explainer: I upload a picture of a bar chart from a made-up sales report, it reads the numbers into a table, checks that the totals add up, explains what changed, and turns it into a five-slide deck I can download.",
  },
  {
    id: "fridge",
    recipe: "recipe-visual-reports",
    note: "Build a fridge scanner: I upload a photo of an open fridge, it places a dot on each food item it finds with a health score I can tap for the reason, and works on the sample photos it ships with.",
  },
  {
    id: "games",
    recipe: "recipe-games",
    note: "Build a 3D browser game where you steer a paper boat down a canal at night collecting floating lanterns and avoiding bridges, with the rules written first, three levels, and keyboard controls.",
  },
  {
    id: "image",
    recipe: "recipe-image",
    note: "Build a room restyler: I upload a photo of a made-up living room, describe one change at a time like a green sofa or warmer light, and it edits the same image over several turns while keeping everything else the same.",
  },
  {
    id: "voice",
    recipe: "recipe-voice",
    note: "Build a standup notes tool: I upload a recording of a made-up team standup, it gives me the transcript with speakers labeled, the keywords, and each person's to-dos in a checklist.",
  },
  {
    id: "stickers",
    recipe: "recipe-sam-media",
    note: "Build a pet sticker maker: I upload a short clip of a pet, it tracks the animal through the clip and gives me a pack of transparent animated stickers to download.",
  },
  {
    id: "computer-use",
    recipe: "recipe-simulated-loops",
    note: "Build a computer use demo on a simulated desktop: an agent looks at screenshots of a made-up desktop, finds a notes app, opens it and files three notes, shows every step it takes, and stops for my approval before it deletes anything.",
  },
  {
    id: "studio",
    recipe: "recipe-simulated-loops",
    note: "Build a product studio where a team of four agents (planner, backend, frontend and writer) turns a one-line app idea into a plan on a shared board, each moving its own cards, with me able to pause or redirect them.",
  },
  {
    id: "verified",
    recipe: "recipe-verified-agent",
    note: "Build an answer checker for a made-up employee handbook I upload: every answer quotes the handbook exactly, a second check reviews each claim against the quote, and it asks me when the handbook doesn't say.",
  },
];

/** `--set=targets`: one build per place a product can run besides the web (NATIVE_TARGETS and friends on the site). */
const TARGET_NOTES: readonly DemoNote[] = [
  {
    id: "phone",
    recipe: "target phone",
    targets: ["phone"],
    note: "Build a shared grocery list for a made-up family of four that feels made for a phone: add items by typing or by snapping a photo of a shelf, it sorts them by store aisle, and checks them off with a tap while shopping.",
  },
  {
    id: "desktop",
    recipe: "target desktop",
    targets: ["desktop"],
    note: "Build a desktop app for a made-up bakery that turns pasted daily sales notes into a tidy weekly summary with the best sellers, slow days and a reorder list, and exports it as a PDF.",
  },
  {
    id: "vr",
    recipe: "target vr",
    targets: ["vr"],
    note: "Build a VR gallery for Meta Quest: walk through a small made-up museum of paper lanterns, point at a lantern to hear and read its story, and leave a note on your favorite.",
  },
  {
    id: "glasses",
    recipe: "target glasses",
    targets: ["glasses"],
    note: "Build a Meta glasses helper for a made-up farmers market: look at a stall sign and it reads out what's in season there today and the prices, hands free, with a phone fallback.",
  },
  {
    id: "agent",
    recipe: "target agent",
    targets: ["agent"],
    note: "Build a weekend trip agent: for a made-up couple visiting Austin on a budget, it searches the web, compares three plans with sources, and drafts a day-by-day itinerary they can edit.",
  },
  {
    id: "edge",
    recipe: "target edge",
    targets: ["edge"],
    note: "Build a cold-room watcher for a made-up restaurant's walk-in fridge that keeps working on the office board when the cloud is down: it logs temperatures, flags readings out of range, and checks a photo of the door to see if it was left open.",
  },
];

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const site = (arg("url") ?? "https://musemuse.dev").replace(/\/$/, "");
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const set = arg("set") === "targets" ? TARGET_NOTES : DEMO_NOTES;
  const notes = only.length ? set.filter((n) => only.includes(n.id)) : set;
  if (!notes.length) throw new Error(`None of ${only.join(", ")} is a demo id. Ids: ${set.map((n) => n.id).join(", ")}`);
  if (dry) {
    for (const n of notes) console.log(`${n.id} (${n.recipe})\n  ${n.note}\n`);
    return;
  }
  if (!env.automationSecret) throw new Error("AUTOMATION_SECRET isn't in .env.local. It must match the one on Vercel Production.");
  const started: Array<{ id: string; recipe: string; buildId?: string; link?: string; error?: string }> = [];
  for (const n of notes) {
    const res = await fetch(`${site}/api/inspirations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.automationSecret}` },
      body: JSON.stringify({ note: n.note, references: [], ...(n.targets ? { targets: n.targets } : {}) }),
    });
    const body = (await res.json().catch(() => ({}))) as { buildId?: string; error?: string };
    if (res.ok && body.buildId) {
      started.push({ id: n.id, recipe: n.recipe, buildId: body.buildId, link: `${site}/b/${body.buildId}` });
      console.log(`started  ${n.id.padEnd(13)} ${site}/b/${body.buildId}`);
    } else {
      started.push({ id: n.id, recipe: n.recipe, error: `${res.status} ${body.error ?? ""}`.trim() });
      console.log(`FAILED   ${n.id.padEnd(13)} ${res.status} ${body.error ?? ""}`);
    }
  }
  mkdirSync(".data", { recursive: true });
  const file = `.data/demo-batch-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, `${JSON.stringify({ site, started }, null, 2)}\n`);
  const ok = started.filter((s) => s.buildId).length;
  console.log(`\n${ok} of ${notes.length} started. Links saved in ${file}. They run on Vercel, so you can close the laptop.`);
  if (ok < notes.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
