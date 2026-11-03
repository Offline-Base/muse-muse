/**
 * Starts one test build per cookbook recipe, plus the legal case agent, on the live site, then exits. The builds run on
 * Vercel, so the laptop can close once this prints "started". Every note uses made-up data, and builds run on whatever
 * model the site is set to (Muse Spark 1.3 Contributor while BUILDS_ON_CONTRIBUTOR is on).
 *   npm run demo-batch                      start them all on https://www.musemuse.dev
 *   npm run demo-batch -- --dry             print the notes, start nothing
 *   npm run demo-batch -- --url=<site>      another deployment
 *   npm run demo-batch -- legal games       only the named ones
 *   npm run demo-batch -- --set=targets     one build per target: phone, desktop, vr, glasses, agent, edge
 *   npm run demo-batch -- --set=showcase    the video's showcase builds: allapis, classgame and tutor (three builds)
 *   npm run demo-batch -- --set=showcase allapis   only the one that calls every Meta API a product can use today
 * Uses AUTOMATION_SECRET from .env.local, acting as the first ADMIN_EMAILS user (no daily build limit), the same way
 * scripts/rebuild-all.ts does. The secret is sent only as the Authorization header and never printed.
 * Writes the build links to .data/demo-batch-<time>.json.
 */
import { env } from "@/lib/env";
import { CASE_AGENT_SAMPLE_NOTE } from "@/lib/recipes/registry";
import { arg, pickIds, postJson, refusalOf, resultsFile, siteArg, words, type PostResult } from "./automation";

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

/**
 * `--set=showcase`: the builds the video's stories need (docs/RUN_OF_SHOW.md). `allapis` is one product that calls every Meta API a product token can use under BUILDS_ON_CONTRIBUTOR (Nov 3): text
 * and vision (muse-wonder-1.0, served on Spark 1.3 Contributor), SAM 3.1 on a photo, Muse Voice Transcribe, Meta's web_search
 * tool and Muse Image edits. It leaves out what the live gateway doesn't serve products today: Muse Spark Open
 * (SPARK_OPEN_PRODUCTS off), Muse Glimmer (GPU_GLIMMER_SHARED off, and a GPU window is spend), SAM on a Jetson (FLEET_SAM off)
 * and audio input to Muse Wonder (refused under the switch). Start it only after a new builder snapshot: the overlay helper
 * that places SAM's boxes isn't in snap_Cqia07XnMGqyaCFRgcrjDZDMGohX.
 * `classgame` and `tutor` are the teacher stories: a class game from a lesson topic, and a tutor that asks guiding questions
 * instead of giving answers. Both use a made-up class and made-up students, and each ends on one finished task a viewer
 * can recognize in a few seconds of film. Name one id to start only that build.
 */
const SHOWCASE_NOTES: readonly DemoNote[] = [
  {
    id: "allapis",
    recipe: "image, voice and api recipes",
    note: 'Build a yard sale lister for a made-up family clearing out their garage. I upload one photo of a table of things for sale, or tap Try the sample: it names each item it sees, and SAM 3.1 outlines each one on the photo. I record or upload a short voice note about the items, like "the lamp works, the chair has a scratch", and it transcribes it and adds each detail to the right item. For each item it searches the web for what similar used items sell for, and shows a price range with source links. I pick one item and Muse Image makes a clean listing photo of it on a plain white background, labeled as made by AI. Then it gives me a ready-to-post listing for each item to copy. It ships with a made-up sample photo and a sample voice note.',
  },
  {
    id: "classgame",
    recipe: "teacher story: class game",
    note: "Build a class review game for a made-up 7th grade science teacher. They type a lesson topic, like the water cycle, and it writes ten questions at that grade level with an answer key they can edit before class. Then it runs the questions as a team game on the classroom screen: two to four teams with made-up names, a timer for each question, big buttons, points on a scoreboard, and at the end a recap of the questions each team missed. It ships with a sample lesson on the water cycle so it works with one tap.",
  },
  {
    id: "tutor",
    recipe: "teacher story: tutor",
    note: "Build a math tutor for a made-up 8th grade class that never gives the answer. A student types a problem, like solving 3x + 5 = 20, and it asks one guiding question at a time, checks each step the student writes, and gives a small hint when they are stuck. It only confirms the answer once the student reaches it. If the student asks for the answer, it says it will help them get there and gives a hint instead. The teacher picks the topic and sees a summary of where made-up students got stuck. It ships with three sample problems.",
  },
];

/** The note sets `--set=` picks from. No flag is DEMO_NOTES, as before. An unknown set stops here: it used to start all of DEMO_NOTES. */
function noteSet(name: string | undefined): readonly DemoNote[] {
  if (name === "targets") return TARGET_NOTES;
  if (name === "showcase") return SHOWCASE_NOTES;
  if (name === undefined) return DEMO_NOTES;
  throw new Error(`--set=${name} isn't a known set. Sets: targets, showcase.`);
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const set = noteSet(arg("set"));
  const notes = pickIds(set, words());
  if (dry) {
    for (const n of notes) console.log(`${n.id} (${n.recipe})\n  ${n.note}\n`);
    return;
  }
  const site = siteArg();
  if (!env.automationSecret) throw new Error("AUTOMATION_SECRET isn't in .env.local. It must match the one on Vercel Production.");
  const file = resultsFile("demo-batch");
  const started: Array<{ id: string; recipe: string; buildId?: string; link?: string; error?: unknown }> = [];
  for (const n of notes) {
    // Saved after each one, so a failure partway keeps the builds that already started.
    const res = await postJson(site, "/api/inspirations", { note: n.note, references: [], ...(n.targets ? { targets: n.targets } : {}) }, env.automationSecret).catch(
      (err: unknown): PostResult => ({ status: 0, json: { error: "network", message: err instanceof Error ? err.message : String(err) } }),
    );
    const buildId = typeof res.json.buildId === "string" ? res.json.buildId : undefined;
    if (res.status >= 200 && res.status < 300 && buildId) {
      started.push({ id: n.id, recipe: n.recipe, buildId, link: `${site}/b/${buildId}` });
      console.log(`started  ${n.id.padEnd(13)} ${site}/b/${buildId}`);
    } else {
      started.push({ id: n.id, recipe: n.recipe, error: refusalOf(res) });
      console.log(`FAILED   ${n.id.padEnd(13)} ${res.status} ${String(res.json.message ?? res.json.error ?? "")}`);
    }
    file.save({ site, started });
  }
  const ok = started.filter((s) => s.buildId).length;
  console.log(`\n${ok} of ${notes.length} started. Links saved in ${file.path}. They run on Vercel, so you can close the laptop.`);
  if (ok < notes.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
