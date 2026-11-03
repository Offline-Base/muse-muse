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
 *   npm run demo-batch -- --set=cookbook    one build per app-build recipe in Meta's cookbook, ids are the recipe slugs (docs/COOKBOOK.md)
 *   npm run demo-batch -- --set=skills      one build per skill we made (recipes and template skills), ids are skill-<skill name>
 *   npm run demo-batch -- --help            print this list
 * Uses AUTOMATION_SECRET from .env.local, acting as the first ADMIN_EMAILS user (no daily build limit), the same way
 * scripts/rebuild-all.ts does. The secret is sent only as the Authorization header and never printed.
 * Writes the build links to .data/demo-batch-<time>.json.
 */
import { pathToFileURL } from "node:url";
import { env } from "@/lib/env";
import { CASE_AGENT_SAMPLE_NOTE } from "@/lib/recipes/registry";
import { arg, pickIds, postJson, refusalOf, resultsFile, siteArg, words, type PostResult } from "./automation";

export type DemoNote = { id: string; recipe: string; note: string; targets?: readonly string[] };

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
    note: "Build an alert triage copilot for a made-up bakery chain's IT team: it ships a noisy export of 42 alerts from seven systems (ovens, tills, delivery, loyalty, menu, receipt printers, wifi) with repeats, lines out of order and a cut-off line, parses it in code and shows what it dropped, then finds the repeating patterns citing alert ids, proposes a sharper triage rule and signals in strict JSON, answers my question with every number checked against the counts, and self-assesses with proposals I accept as a diff.",
  },
  {
    id: "charts",
    recipe: "recipe-visual-reports",
    note: "Build a chart explainer like Meta's chart analysis recipe: I upload a screenshot of a price chart and ask 'help me understand this'. The sample, drawn by code, is a made-up daily chart for the fictional Pinewick Robotics with a printed +8.4% header, labeled support at $41 and resistance at $52, a 'Gap up' label, a volume panel and one faint gridline value. It reads the instrument, timeframe, trend, key levels, visible percent change and labeled events into JSON, a second pass marks every number it can't confirm with 'Check this', code draws a summary card from that JSON, and I can ask two follow-up questions about the same chart. It explains only and never says buy or sell.",
  },
  {
    id: "fridge",
    recipe: "recipe-visual-reports",
    note: "Build a fridge scanner like Meta's perception grounding recipe: I upload a photo of an open fridge and type a goal like 'less added sugar'. One vision call finds each food and places a numbered dot right on it, colored green or red, with a score out of 10 floating above it. Tapping a dot opens a card with the name, the reason and rough calories, carbs, protein and fat. It ships with two realistic sample fridge photos with every item in plain view, says it's general information and not medical advice, and I can download the result as one self-contained HTML page with the photo and dots.",
  },
  {
    id: "games",
    recipe: "recipe-games",
    note: "Build a 3D kart racer in the browser, built in rounds: a kart made of simple shapes laps a rainbow-striped ring track around a glowing sun, with speed strips that boost you, a chase camera that keeps the road ahead in view, and a 60-second race of up to three laps counted through checkpoints. Every race ends on its own with an end screen showing lap times, cleared or not, and a Retry button. Arrow keys steer on desktop, and on a phone, touch buttons sit over the canvas.",
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
    note: "Build a pet sticker maker: I upload a short clip of my pet (the sample is a made-up corgi standing on grass), name the animal, and it tracks it through the clip and gives me three transparent animated stickers from different moments, previewed on the page and downloadable as a zip.",
  },
  {
    id: "computer-use",
    recipe: "recipe-simulated-loops",
    note: "Build a computer use demo on a simulated Linux desktop, labeled Simulated screen: an agent on Muse Wonder looks at screenshots, finds the Mines game among the desktop icons, opens it and plays the 8 by 8 board, revealing squares with clicks and flagging mines with right clicks, looking again after every move. Each click is drawn on the screenshot it was chosen from, with the step count, tokens and cost. The run ends on a card that says won, lost or stopped at 25 actions. It opens on a labeled replay, with a Start button for a real run.",
  },
  {
    id: "studio",
    recipe: "recipe-simulated-loops",
    note: "Build a launch team board: I type a one-line app idea, like a made-up neighborhood tool-lending app called Borrowbox. A product manager agent asks me two or three questions, writes a brief and a runbook, and creates linked cards. A backend, a frontend and a writer agent each take their own cards on their own turns, talk only through card comments, and one stops to ask me a decision. The run ends when every card is done, with an API sketch, a page outline and launch copy to download, and a log showing one model call per agent turn.",
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

/** A DEMO_NOTES entry under its cookbook slug, for a recipe whose default demo note already is the cookbook pass's note. */
function fromDemo(slug: string, demoId: string): DemoNote {
  const n = DEMO_NOTES.find((d) => d.id === demoId);
  if (!n) throw new Error(`DEMO_NOTES has no "${demoId}" for ${slug}.`);
  return { ...n, id: slug };
}

/**
 * `--set=cookbook`: one build per app-build recipe in Meta's cookbook (docs/COOKBOOK.md), id = the recipe's slug, so
 * https://dev.meta.ai/docs/cookbook/<id> is the page it redoes. 50 notes: every recipe page except contained-execution
 * (04/04, a docs demo only) and the nine section index pages. Start it only after the new builder snapshot (the overlay,
 * raster and media-store helpers and presigned uploads aren't in the current one) and a deploy of the cookbook merge.
 */
const COOKBOOK_NOTES: readonly DemoNote[] = [
  // API fundamentals (recipe-api). DEMO_NOTES "api" stays as the combined policy reader; these are one recipe each.
  { id: "quickstart-chat-completions", recipe: "recipe-api", note: "Build an order help chat for a made-up pizza shop called Crust and Co: it follows the shop's standing rules (open 11 AM to 10 PM, no delivery past 3 miles, gluten-free crust is $2 more), remembers what I said earlier so 'make that a large' works, and has a focused or playful tone switch. It ships with a four-turn sample conversation where the second message only makes sense after the first, and shows the tokens used under each reply." },
  { id: "streaming-responses", recipe: "recipe-api", note: "Build a bedtime story writer: I type a made-up child's name, age and three things they love, and the story appears word by word as it is written, with a Thinking state before the first word, a Stop button, a retry that starts over if the stream breaks while keeping the cut-off text on screen, and the tokens used once it finishes. It ships with one filled-in sample child so the first story starts in one tap." },
  { id: "tool-function-calling", recipe: "recipe-api", note: "Build a repair desk assistant for a made-up bike shop called Spoke and Chain: I describe a problem like 'my rear brake squeaks and I need the bike by Friday', and it calls tools on the shop's own made-up parts list and repair calendar to check stock, price the job and book a slot, showing each tool call with its arguments and result in a log, then a booking summary with the price. It ships with a sample request that needs at least two different tools." },
  { id: "structured-output", recipe: "recipe-api", note: "Build a recipe card maker: I paste a messy made-up recipe from a family group chat, with ingredients mixed into the steps and one amount missing, and it returns a clean card with servings, ingredients with amounts and units, numbered steps, and a list of what it couldn't find, checked against a schema it shows me. It ships with two messy sample recipes, one with a missing amount and one with two ovens' temperatures." },
  { id: "prompt-caching", recipe: "recipe-api", note: "Build a help desk for a made-up coworking space called Northlight Commons, with its 12-section member handbook (about 10,000 characters, shipped with the app: guest passes, quiet hours, printing, lockers, parking, events and more). I ask questions one after another, each answer quotes the handbook section it used, and a ledger shows every call's input tokens and how many came from the cache, saying plainly that the first call reads 0 and when a later call had no cache hit." },
  { id: "reasoning-thinking-tokens", recipe: "recipe-api", note: "Build a logic puzzle coach: I pick one of two sample puzzles (an easy one and a five-friend seating puzzle with six clues) or paste my own, and it solves it at low and high reasoning effort side by side, showing each answer, its reasoning tokens, time and cost, and whether the two answers agree, with a short written explanation clearly labeled as the model's explanation." },
  { id: "vision-input", recipe: "recipe-api", note: "Build a yard sale price tagger: I upload up to three photos of made-up yard sale items, and in one call it names each item, notes its condition, suggests a price range, and says which one to put out front and why. It ships with three realistic sample photos: a worn wooden chair on a driveway, a stack of paperback books on a folding table, and a brass desk lamp in daylight." },
  { id: "long-context", recipe: "recipe-api", note: "Build a question reader for a made-up 60-section apartment building rulebook for Willow Court (about 60,000 characters, written in code from a table of rules so every answer is known): before each question it shows the estimated tokens, the cost and which sections it will send, answers with the section number it used, keeps follow-up questions on the same cached document, and lists the sections it left out. The sample questions include one about a rule buried in section 57." },
  { id: "error-handling-retry", recipe: "recipe-api", note: "Build a review summarizer for a made-up coffee shop called Bean There that stays calm when calls fail: it summarizes 12 sample customer reviews one at a time with a ledger of every attempt, its status, the decision and the wait; a 'send a broken request' button gets a real 400 and shows it is never retried; and a clearly labeled practice switch fakes a 503 for one call so I can watch the backoff and see that row marked Simulated." },
  { id: "search-grounding", recipe: "recipe-api", note: "Build a field trip planner for a made-up fifth-grade class from Maple Street School visiting Chicago this Saturday: I ask what museums are open, what the weather looks like and what's free for kids, and it searches the web and answers with numbered footnotes linking the real sources, says plainly when it answered without searching, and ends with a one-page day plan I can print." },

  // Agent patterns (recipe-agent-patterns).
  { id: "basic-agent-loop", recipe: "recipe-agent-patterns", note: "Build an agent loop bug fixer: it ships a tiny made-up school library checkout project in JavaScript with three planted bugs (a due-date list that drops its last page, a late fee that starts a day early, a name formatter that crashes on an empty name), each with one failing test. I pick a failing test and press Run, the model reads, edits and runs the tests one tool call per turn, I see each turn as THINK, ACT, RESULT and EVAL, it stops at 15 turns or when it repeats itself, and the page's own test run decides Fixed and shows the diff." },
  { id: "interleaved-reasoning-tool-use", recipe: "recipe-agent-patterns", note: "Build a callback to async/await migration agent: it ships a small made-up bakery orders API in JavaScript with four callback-style modules (store, customers, orders, receipts) and tests that check behavior. I pick an effort, minimal or high, and press Migrate; each turn shows the model's thought and its reasoning tokens before the action, it migrates leaf modules first and runs the tests after every edit, done means the tests pass and no callback is left, and I can compare a minimal run and a high run side by side on turns and tokens." },
  { id: "multi-turn-context-management", recipe: "recipe-agent-patterns", note: "Build a design keeper for a made-up bike repair shop's booking app: I give an initial spec, then three requirement changes one at a time (bookings go multi-location, then payments become async with refunds, then the app serves three shops as tenants), and the model keeps a STATE.md with decisions, a task list and a file map, re-reads only the design files a change touches, edits them in place, and shows each turn's input tokens beside what the full history would have been. It ends with a coherence check listing every decision and the change that introduced it, and ships the spec and the three changes as its sample." },
  { id: "search-and-replace-edits", recipe: "recipe-agent-patterns", note: "Build an exact-edit reviewer: I paste a JavaScript file and ask for a change in plain words, the model proposes edits that apply only when the quoted text matches exactly once, a rejected edit goes back to it once with the reason, and every applied edit passes a syntax check and shows as a diff I accept or reject. It ships a made-up pizza shop's pricing.js where the same discount line appears in two functions, so I can see a real rejection and its retry." },
  // The DEMO_NOTES "alerts" note is the cookbook pass's alert-fatigue-copilot note (replaced Nov 3), so it is reused.
  fromDemo("alert-fatigue-copilot", "alerts"),
  { id: "glimmer-api-agent", recipe: "recipe-agent-patterns", note: "Build an ask-before-it-leaves assistant for a made-up freelancer's private client notes: the notes stay in my browser and the page searches them; when they can't answer, it drafts a question with none of my note text, shows me the exact text and its byte count, and sends it to the cloud model only after I approve. A different question asks again, no answer in two minutes counts as no, a changed text is refused, and an egress ledger shows each send's time, size, digest and outcome, never the question or the answer. It ships three sample notes and a question they can't answer." },
  { id: "github-agent", recipe: "recipe-agent-patterns", note: "Build a repo bot kit maker for a made-up open-source library called pebblequeue: I pick triage, review and question answering, and how much a maintainer approves, and it downloads a zip with the workflows, an AGENTS.md with security rules, one agent file per role and a README, using my own MODEL_API_KEY secret and no other key. A dry run takes a pasted issue or PR diff and returns the labels or review verdict without posting anything; it ships a bug report, a sloppy PR and an issue hiding an instruction in an HTML comment, which the dry run flags." },

  // Use cases (recipe-visual-reports, recipe-voice, recipe-games, recipe-simulated-loops).
  // The DEMO_NOTES "charts" note is the cookbook pass's chart analysis note (replaced Nov 3), so it is reused.
  fromDemo("perception-chart-analysis", "charts"),
  { id: "perception-error-screenshot-fix", recipe: "recipe-visual-reports", note: "Build a screenshot bug fixer: it ships a small made-up booking page for the fictional Juniper Lane Dental whose sticky footer covers the Confirm booking button on a phone, plus a screenshot of the bug. I use the sample screenshot (or upload my own with a small page I paste), and it says what's wrong in one line, lists the steps to see it, finds the cause in the page's CSS and proposes an exact find-and-replace fix. Code applies it and shows before and after side by side at phone width, and a check in code says Fixed only when the button is no longer covered. I can download the diff and the fixed files." },
  { id: "rayban-openclaw", recipe: "recipe-voice", targets: ["glasses"], note: "Build a look-and-ask travel helper for Meta glasses with a phone fallback: hold the talk button and ask out loud 'what does this sign say?', take one photo, and hear a two-sentence answer read back in English. The screen shows the photo, the sign's text as read and the translation, and the spoken answer is exactly the text shown. It ships with a sample photo of a made-up Spanish bakery chalkboard sign (pan dulce 2 euros, cafe con leche 1.50 euros, cerrado los lunes) drawn with known text, so the test can check the answer, and a typed question works when the microphone is off." },
  { id: "generating-slides", recipe: "recipe-visual-reports", note: "Build a research-to-slides maker: I type a topic, like 'how heat pumps keep homes warm in cold winters', it searches the web from 3 to 5 angles, writes an outline where every slide lists only sources the search returned, and shows a 6-slide deck I step through with the arrow keys or Previous and Next, with '3 of 6' and each slide's numbered sources. Beside it are the queries it ran, the sources kept, tokens and time. I can download the deck as one HTML file that also pages with the arrow keys, and it opens on a labeled sample deck made when it was built." },
  { id: "browser-verified-web-design", recipe: "recipe-visual-reports", note: "Build a one-page site for a made-up company, Fernhollow Mesh Networks: its name in large ASCII art in a terminal font whose characters scatter away from the cursor in a circle and settle back when it leaves, a green-phosphor CRT look with faint scanlines, a terminal header bar, a short about section, three service cards and a contact form that says it's a demo and sends nothing. On a phone, dragging a finger across the logo scatters it, and it fits at phone and desktop sizes with no sideways scroll." },
  // The DEMO_NOTES "games" note is the cookbook pass's iterative game dev note (replaced Nov 3), so it is reused.
  fromDemo("iterative-game-dev", "games"),
  { id: "sandboxed-execution", recipe: "recipe-simulated-loops", note: "Build a bug-fix sandbox: it ships a small made-up Python package, tiny_invoice, whose discount rounding is off by a cent, with a bug report and three failing unittest tests. An agent on Muse Wonder reads the files, reproduces the failure, fixes the source without touching the tests and runs them in a Python sandbox in my browser. The product reruns the tests itself and shows pass or fail, every step with its tokens, and the patch to download. It opens on a labeled replay of a run made when it was built, with a Start button and its estimated cost." },
  // The DEMO_NOTES "studio" note is the cookbook pass's multi-agent orchestration note (replaced Nov 3), so it is reused.
  fromDemo("multi-agent-orchestration", "studio"),
  { id: "one-shot-game-dev", recipe: "recipe-games", note: "Build a 3D lane-crossing arcade game in one pass: a cube chicken made of simple shapes hops forward across grass with trees, roads with cars, rivers with drifting logs to ride, and railways where trains flash a warning before they cross. Grid hops with the arrow keys, or touch buttons over the canvas on a phone. The score is the farthest row, the best score is saved in this browser, and standing still for 8 seconds brings a hawk, so every run ends with an end screen and Retry." },
  // The DEMO_NOTES "fridge" note is the cookbook pass's perception grounding note (replaced Nov 3), so it is reused.
  fromDemo("perception-grounding", "fridge"),
  // The DEMO_NOTES "computer-use" note is the cookbook pass's Mines note (replaced Nov 3), so it is reused.
  fromDemo("computer-use", "computer-use"),
  { id: "computer-use-macos", recipe: "recipe-simulated-loops", note: "Build a computer use demo in the style of Meta's macOS recipe on a simulated Mac screen, labeled Simulated screen with 'This does not control your computer': the agent sees a screenshot of a tic-tac-toe window, plays X with one computer tool whose clicks use a 0 to 1000 grid, looks again after every move and calls stop when the game ends. Then it fills a made-up sign-up form for Sam Rivera and pauses for my Approve before it presses Create account; Deny leaves the form unsent. Every click is drawn on the screenshot it saw, with steps and cost, and each task ends on a result card." },

  // Building with Muse Code (recipe-code-sessions Part 2 stand-ins; side chats in recipe-agent-patterns). No note for
  // contained-execution (04/04): it needs an OS sandbox on the person's own machine, so it stays a docs demo.
  { id: "audit-agent-sessions", recipe: "recipe-code-sessions", note: "Build an audit ledger for an AI agent: it migrates 8 made-up library card records from schema v1 to v2, one per turn, and stops for my approval before it deletes the stale cache file. Every model call, tool run and approval is written to a hash-chained log before it happens, shown as a color-coded ledger with who allowed each action, and exported as JSON I can download raw or redacted. A Stop here button simulates a crash at record 7, and Resume finishes only record 8, with a check that shows 8 of 8 migrated and no duplicates." },
  { id: "deterministic-replay", recipe: "recipe-code-sessions", note: "Build a replay gate for an AI support agent's recorded run: a made-up bike shop help chat where the agent looked up order #4471 with a tool. It rebuilds the model's context from the recorded events with no model call, compares it to a saved golden fixture, and shows 0 diffs: merge allowed. A toggle swaps in a proposed code change that drops tool outputs, and the gate turns red naming the exact message that changed. I can download the fixture, a check script and a GitHub Actions workflow for my own repo." },
  { id: "staged-approvals", recipe: "recipe-code-sessions", note: "Build a staged command approver on a simulated shell over a pretend project folder: an agent asked to tidy up the made-up reports folder proposes wc -l report.log && echo cleaning && rm -rf report.log. Each stage is shown with its verdict, the two safe ones clear on their own, the rm stage waits for me with Allow once, Reject or a workspace rule, and rejecting it runs nothing, so report.log is still in the folder." },
  { id: "immutable-guardrails", recipe: "recipe-code-sessions", note: "Build a guardrail demo: an agent edits a made-up cafe's website files and works under rules in .agents/AGENTS.md. I ask it to fix the typo 'Expresso' on the menu page, then to change its own rules so it can delete files without asking. The menu edit applies at once, the rules edit stops for me with only Allow this one write or Reject, a shell write to the rules folder fails as read-only, and after I reject, a diff shows the rules file unchanged." },
  { id: "subagent-fanout", recipe: "recipe-code-sessions", note: "Build a fan-out board: a lead agent splits work on a small made-up board game scoring module (one planted bug in the tie-break rule plus two small features: a bonus for a full row and a penalty for unused tiles) into 3 subagents, each editing its own copy of the files. I can watch each one, steer one with a note, or stop one while the others keep going, and at the end the same test suite scores every copy in a table while the original files stay unchanged." },
  { id: "goal-tracking", recipe: "recipe-code-sessions", note: "Build a goal tracker for a coding agent: I pin the goal 'the made-up tip calculator splits a bill of $86.40 four ways with 18% tip and rounds each share to the cent' with 4 acceptance checks, and the agent works on the bundled project until all 4 pass. A status line shows how many checks pass, a nudge appears when it drifts, and if it tries to mark the goal done early it is refused with the failing checks." },
  { id: "bundled-skills", recipe: "recipe-code-sessions", note: "Build a plan-and-grill studio: I type a rough idea for a made-up community garden plot swap, and it runs four playbooks one at a time: a plan with its key decisions that waits for my approval, a grilling round that asks me one hard question at a time, a docs round that writes each settled answer into a DECISIONS.md I can download, and a taste review of the sample landing page that lists what looks machine-made and how to fix it." },
  { id: "loop-and-cron", recipe: "recipe-code-sessions", note: "Build a bug digest scheduler: I type 'every weekday at 8 am, summarize new bugs' or 'in 2 minutes, remind me to review BUG-1849', it turns each into a schedule, shows the next three run times, and lists my jobs with cancel. Jobs run while the page is open and each run writes a dated digest of a made-up list of 10 bugs for a small notes app, grouped by severity with owners. Run now fires one right away." },
  { id: "side-chats", recipe: "recipe-agent-patterns", note: "Build a main chat with side chats: the main thread is planning a made-up 3-day team offsite for 12 people with a $4,800 budget, and a side panel lets me ask quick questions like 'what's 18% of the catering quote?' over several turns without adding anything to the main thread. The main thread's turn count stays the same, and a check at the end asks the main thread about the side topic to show it never saw it." },

  // Muse Image, Muse Voice Transcribe and SAM (recipe-image, recipe-voice, recipe-sam-media). DEMO_NOTES "image" (room
  // restyler) and "voice" (standup notes) stay: their products work live, and these follow Meta's own recipes closer.
  { id: "image-generation-basics", recipe: "recipe-image", note: "Build a greeting card art studio: I describe a picture, like a watercolor otter holding a birthday balloon, it draws it, then I refine it one change at a time (add a party hat, make the sky dusk), and I can add two reference photos, a made-up teacup and a sunflower, to combine into one scene. Show each turn's image and token usage, and let me download the final card." },
  { id: "search-grounded-image-generation", recipe: "recipe-image", note: "Build a balcony furniture planner: it searches the web for a small outdoor bistro set that matches my brief (two chairs and a folding table in sage green metal), draws the pieces as a product grid, places them on the sample photo of a made-up empty city balcony, then searches again to add a matching planter. Label every result as an illustration, not real products." },
  { id: "anchored-image-series", recipe: "recipe-image", note: "Build a four-panel comic maker for a made-up kids' story about Pip, a lighthouse keeper's mouse: it first draws a character sheet of Pip and a plate of the lighthouse, lets me redo either, then draws four panels that keep Pip and the lighthouse looking the same, arranges them on one page, and letters my short speech lines in bubbles I place. I can download the page as a PNG." },
  { id: "image-editing-with-reasoning", recipe: "recipe-image", note: "Build a yard sale listing helper: I upload a photo of items on a floor (the sample is a made-up brass lamp, an acoustic guitar and a stack of books), type each item's price, and it adds a handwritten price tag next to each one. Then I mark the guitar sold and the books down to $8, and it updates the same photo, with a before and after slider and the price list beside it." },
  { id: "voice-api-fundamentals", recipe: "recipe-voice", note: "Build a podcast interview transcriber: I upload a short recording of a made-up two-person interview about a neighborhood community garden, add names it might mishear as keywords (Tamsin, Okonkwo), and it gives me a timed transcript with each speaker labeled, speaker names I can edit, and a download as text. It ships with a sample recording of the two speakers, made in the build, that says both names, so Try the sample runs the real transcription." },
  { id: "voice-chess-cua", recipe: "recipe-voice", note: "Build voice chess on the page: a chess board and a hold-to-talk button, and I say one move at a time, like Move E2 to E4. It only accepts that exact phrase, shows what it heard, rejects illegal moves with the reason, plays a simple reply, and ends on checkmate with a new game button. Include a sample move button for people without a microphone." },
  { id: "sam-api-basics", recipe: "recipe-sam-media", note: "Build a pond survey counter: I upload a photo of a made-up park pond, type one or more things to find (duck, lily pad), and it outlines each one in its own color with a count for each, says plainly when it finds none, and lets me download the results as JSON. It ships with a realistic sample photo of the pond with ducks and lily pads in plain view, so Try the sample finds both." },
  // The DEMO_NOTES "stickers" note is the cookbook pass's sticker pack note (replaced Nov 3), so it is reused.
  fromDemo("video-to-sticker-pack", "stickers"),
  { id: "headlocked-speech-bubble-captions", recipe: "recipe-sam-media", note: "Build a speech bubble captioner: I upload a short clip of two people talking (the sample is two made-up friends at a cafe table planning a picnic), it transcribes who said what, finds each person, lets me match each voice to a person by listening, then shows speech bubbles that follow each speaker and exports the captioned clip." },

  // Open weights (recipe-open-weights). run-locally and post-training are index pages; their builds are these three.
  { id: "muse-spark-open-mac", recipe: "recipe-open-weights", note: "Build a setup kit for serving Muse Spark Open on the four Mac Studios (256 GB each) in a made-up film studio's edit bay, named studio-a.local to studio-d.local. It shows each Mac's share of the weights and which Thunderbolt 5 cables connect which Macs, gives me a checklist to tick, and lets me download setup.sh and hostfile.json. It also has a doctor: I paste the log from a step that failed, and it names the check and the fix. It comes with three made-up sample logs to try." },
  { id: "muse-spark-open-torchtitan-sft", recipe: "recipe-open-weights", note: "Build an SFT data studio for Spoke and Sprocket, a made-up bike repair shop. I paste our support chats as JSONL, or as a CSV with question and answer columns. It flags broken rows, duplicates and weak answers, drafts ten more chats in our style, shows which tokens get trained, and splits off a held-out set. Then it exports train.jsonl, heldout.jsonl and the TorchTitan recipe file. It comes with 24 made-up sample chats that have a few planted problems." },
  { id: "muse-spark-open-torchtitan-rl", recipe: "recipe-open-weights", note: "Build a reward spread checker to run before an RL training job. I paste made-up warehouse word problems with whole-number answers and pick exact match, boxed answer, or a number within a tolerance. It samples four answers per problem and scores each one in code. It shows each group's rewards and advantages and whether that group teaches the model anything, then gives a verdict for the whole task. It exports task.jsonl and the TorchTitan with_task snippet, and comes with 12 sample problems from easy to hard." },
];

/**
 * `--set=skills`: one build per skill we made, so each recipe (lib/recipes/skills) and each template skill a brief can
 * trigger (template/.agents/skills, template-native/.agents/skills) has a product Meta could feature. id = skill-<skill
 * name>, recipe = the skill. The heroes vary (a teacher, a small shop, a nurse, a coach, a student), every person, place
 * and record is made up, and only Meta models answer. New products, not the DEMO_NOTES or cookbook ones again.
 * What each needs on the site, or the build comes back without that skill:
 * - the recipe-* notes: RECIPES_ENABLED; recipe-case-agent and recipe-simulated-loops also AGENT_LONG_RUNS, and
 *   recipe-verified-agent VERIFY_AGENTS and AGENTS_ENABLED (it adds the agent target itself).
 * - skill-meta-glimmer: nothing. With GPU_GLIMMER_SHARED off, the product answers with Muse Wonder and says the Glimmer
 *   mode needs a Glimmer endpoint (meta-glimmer skill), so it spends no GPU.
 * - skill-muse-edge: EDGE_ENABLED and EDGE_BUILDS, or /api/inspirations refuses the edge target (400).
 * - skill-muse-gadget: GADGETS_ENABLED. The build runs on the simulated gadget; live, with no board, it asks for an upload.
 * - skill-muse-native: phone offered (NATIVE_TARGETS with PACKAGER_SNAPSHOT_ID), or the phone target is refused (400).
 * Left out: jetson-fleet. The writer is offered it only with FLEET_PRODUCTS and the fleet's URL, jik_ key and model set,
 * and without them nothing answers in its place (the product only says the fleet is offline), so a public build can't
 * show it. meta-chat, meta-image, meta-voice and meta-sam are the showcase's allapis basics, and meta-spark-open and
 * shared-keys wait on owner switches (SPARK_OPEN_PRODUCTS, the owner's service accounts).
 */
const SKILL_NOTES: readonly DemoNote[] = [
  // Recipes (lib/recipes/registry.ts).
  { id: "skill-recipe-voice", recipe: "recipe-voice", note: "Build a family night notes tool for a made-up 4th grade teacher: I upload a recording of the class's family night about the spring field trip, held in Spanish and English, pick both languages as hints and add the made-up trip's place, Museo del Río Verde, as a keyword, and it gives me a transcript with the speakers labeled, a short summary in English and in Spanish, and a checklist of what families need to do (the permission slip, the lunch, the pickup time), which I can edit and download. It ships with a sample recording of two made-up speakers, the teacher and a parent volunteer, made in the build, so Try the sample runs the real transcription." },
  { id: "skill-recipe-image", recipe: "recipe-image", note: "Build a product photo studio for a made-up candle shop called Ember and Wick: I upload one photo of a candle (the sample is a realistic amber jar candle on a plain table), it keeps that photo as the anchor, then makes a series of four seasonal scenes (a spring windowsill, a summer patio, an autumn bookshelf, a winter mantel) where the jar's shape and color stay the same, and I can redo any one scene with a short change. Each image is labeled as made by AI, and I can download the set as PNGs for the shop's page." },
  { id: "skill-recipe-api", recipe: "recipe-api", note: "Build a broken equipment ticket maker for nurses on a made-up hospital unit, 5 East: a nurse pastes a messy note about equipment that isn't working, like an IV pump that keeps alarming in room 12 or a bed that won't lower, and it streams back a clean repair ticket for the unit's made-up equipment team as JSON checked against a schema it shows me (device, room, what's wrong, since when, how urgent), with a list of anything the note left out, like the asset tag. A Stop button ends the stream. It ships with two messy sample notes, asks nurses to leave patient details out, and shows the tokens used under each ticket." },
  { id: "skill-recipe-games", recipe: "recipe-games", note: "Build a 3D marble maze for a made-up middle school's game club, built in rounds: tilt a board made of simple shapes with the arrow keys, or touch buttons over the canvas on a phone, to roll a marble past holes and moving walls to a glowing goal, with three short levels, a 45-second timer per level and the best time saved in this browser. Every run ends on its own, at the goal, in a hole or when time runs out, with an end screen and a Retry button." },
  { id: "skill-recipe-sam-media", recipe: "recipe-sam-media", note: "Build a practice clip marker for a made-up adult rec league soccer coach: I upload a short clip of a player with the ball (the sample starts from a realistic photo of a made-up adult player in a red jersey with one foot on a ball on a grass field, whole and in frame), type 'player' and 'ball', and SAM 3.1 tracks each one through the clip as its own colored mask, one call per word, with the frames each was found in. I can step through it frame by frame, pin a coaching note to any frame, and download the clip with the masks and notes drawn on as WebM. The page says the sample is a still photo with a camera move." },
  { id: "skill-recipe-visual-reports", recipe: "recipe-visual-reports", note: "Build a shelf check for a made-up neighborhood hardware store, Pine Street Hardware: I upload a photo of an aisle, and one vision call places a numbered dot right on each empty spot, mixed-up item or fallen box, red for empty and amber for messy. Tapping a dot opens a card with what's there, what's wrong and what to restock. It ships with two realistic sample shelf photos with every item in plain view, says the dots are approximate, and I can download the result as one self-contained HTML page with the photo and dots to hand to staff." },
  { id: "skill-recipe-case-agent", recipe: "recipe-case-agent", note: "Build a legal case agent on a new fictional dispute: Corner Crumb Bakery, a made-up tenant, says its made-up landlord kept a $3,200 security deposit for an oven hood the bakery says was already broken at move-in. It reads the file (the lease, the move-in checklist, three emails and two invoices), drafts a checklist, proves each item with exact page quotes, asks me for evidence when it is stuck, and files a memo I sign off. Show every turn live. The case is made up and it isn't legal advice." },
  { id: "skill-recipe-verified-agent", recipe: "recipe-verified-agent", note: "Build a policy answer checker for nurses on a made-up hospital unit, 4 West: I upload the unit's made-up policy binder (medication storage, visitor hours, fall checks, shift swaps), ask a question like 'how often do we check the crash cart?', and every answer quotes the binder exactly, a second check reviews each claim against its quote, and it can't answer until both pass. When the binder doesn't say, it stops and tells me to ask the charge nurse. It ships with a sample binder and five sample questions, one the binder doesn't cover." },
  { id: "skill-recipe-agent-patterns", recipe: "recipe-agent-patterns", note: "Build a gradebook bug fixer for a made-up 9th grade teacher: it ships a tiny made-up gradebook project in JavaScript with three planted bugs (a weighted average that rounds too early, a late penalty applied twice, a drop-the-lowest-quiz rule that drops the highest), each with one failing test. I pick a failing test and press Run, the model reads, edits and runs the tests one tool call per turn, I see each turn as THINK, ACT, RESULT and EVAL, it stops at 15 turns, and the page's own test run decides Fixed and shows the diff. Every student in it is made up." },
  { id: "skill-recipe-code-sessions", recipe: "recipe-code-sessions", note: "Build a goal keeper, like Muse Code's goal tracking, for a coding agent working on a made-up student's flashcard app: I pin the goal 'cards I miss come back the next day, cards I know wait longer, and my streak resets after a skipped day' with 4 acceptance checks, and the agent works on the bundled project until all 4 pass. A status line shows how many checks pass, a nudge appears when it drifts, it is refused if it tries to mark the goal done early, and every model call and edit goes into a log I can download as JSON. The page says plainly it is a stand-in for Muse Code's harness." },
  { id: "skill-recipe-simulated-loops", recipe: "recipe-simulated-loops", note: "Build a packing robot demo for a made-up tea shop, Leaf and Ladle, on a simulated robot arm labeled Simulated arm: I pick one of three sample orders, and an agent on Muse Wonder looks at a picture of the shelf, moves the arm to put each tin in the box one move at a time, looks again after every move, and stops for my Approve before it seals the box. Every move shows the step count, tokens and cost, and the run ends on a card that says packed, stopped by me, or stopped at 25 moves. It opens on a labeled replay, with a Start button for a real run." },
  { id: "skill-recipe-open-weights", recipe: "recipe-open-weights", note: "Build an SFT data studio for a made-up swim club's head coach, who wants Muse Spark Open to answer parents' common questions in the club's voice. I paste our made-up question and answer chats as JSONL or as a CSV, and it flags broken rows, duplicates and weak answers, drafts ten more chats in our style, shows which tokens get trained, splits off a held-out set, and exports train.jsonl, heldout.jsonl and the TorchTitan recipe file. It says plainly that it trains nothing itself, and comes with 20 made-up sample chats with a few planted problems." },

  // Template skills a brief triggers (template/.agents/skills, template-native/.agents/skills).
  { id: "skill-meta-reasoning", recipe: "meta-reasoning", note: "Build a lab report helper for a made-up high school chemistry class: a student uploads the lab handout as a PDF and a photo of their handwritten data table, Muse Wonder reads both and returns the measurements as JSON, code redoes the averages and percent error and marks any row where the math is off, and it explains what each number means without writing the report for them. It ships with a sample handout and a sample photo of a made-up data table with one planted arithmetic slip." },
  { id: "skill-meta-glimmer", recipe: "meta-glimmer", note: "Build a staff picks writer for a made-up independent bookstore, Paper Lantern Books, that wants an open-weights model it can host itself later: a clerk types a book's title and two lines about why they loved it, and it writes a shelf card in three lengths to print. It uses Muse Glimmer when the shop's own Glimmer endpoint is set and Muse Wonder until then, and every card says which model wrote it. It ships with five made-up sample books." },
  { id: "skill-muse-edge", recipe: "muse-edge", targets: ["edge"], note: "Build a supply room checker for a made-up rural clinic, built so it keeps answering from the clinic's own board when Meta's cloud can't be reached: a nurse snaps a photo of the supply shelf, it counts the glove boxes, mask packs and gauze rolls it can see, one look for each, flags what's below the restock level the clinic sets, and writes a short reorder list. Every answer says whether the cloud or the board answered. It ships with two realistic sample shelf photos." },
  { id: "skill-muse-gadget", recipe: "muse-gadget", note: "Build a class plant journal for a made-up 3rd grade classroom with a camera board on the windowsill, pointed only at the plants: each morning a student presses Take photo, the board photographs the class bean plants, and Muse Wonder notes each plant's height against the ruler beside it, any new leaves and whether the soil looks dry, adding a dated entry to a growth chart the class reads on the big screen. When no board is connected it says so clearly and lets the teacher upload a photo instead. It ships with three sample photos from different days." },
  { id: "skill-muse-native", recipe: "muse-native", targets: ["phone"], note: "Build a practice planner for a made-up adult rec basketball coach that feels made for a phone: pick drills from a list, or snap a photo of the whiteboard and it turns the writing into a drill list, then run practice with a big countdown for each drill, a buzz on the phone at every switch and a reminder before practice starts. Share the plan with the team from the share sheet. It ships with a sample practice of six drills." },
];

/** The note sets `--set=` picks from. No flag is DEMO_NOTES, as before. An unknown set stops here: it used to start all of DEMO_NOTES. */
export const SETS = ["targets", "showcase", "cookbook", "skills"] as const;

export function noteSet(name: string | undefined): readonly DemoNote[] {
  if (name === "targets") return TARGET_NOTES;
  if (name === "showcase") return SHOWCASE_NOTES;
  if (name === "cookbook") return COOKBOOK_NOTES;
  if (name === "skills") return SKILL_NOTES;
  if (name === undefined) return DEMO_NOTES;
  throw new Error(`--set=${name} isn't a known set. Sets: ${SETS.join(", ")}.`);
}

/** What --help prints. */
export const USAGE = [
  "npm run demo-batch -- [--dry] [--url=<site>] [--set=<set>] [ids...]",
  "  --dry             print the notes, start nothing",
  "  --url=<site>      another deployment (default https://www.musemuse.dev)",
  "  (no --set)        the first batch: 12 recipe builds, the legal case agent among them",
  "  --set=targets     one build per target: phone, desktop, vr, glasses, agent, edge",
  "  --set=showcase    the video's showcase builds: allapis, classgame and tutor",
  "  --set=cookbook    one build per app-build recipe in Meta's cookbook, ids are the recipe slugs",
  "  --set=skills      one build per skill we made (recipes and template skills), ids are skill-<skill name>",
  "  ids...            only the named ones from the set",
].join("\n");

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const dry = process.argv.includes("--dry");
  const set = noteSet(arg("set"));
  const notes = pickIds(set, words());
  if (dry) {
    for (const n of notes) console.log(`${n.id} (${n.recipe}${n.targets ? `, targets ${n.targets.join(", ")}` : ""})\n  ${n.note}\n`);
    console.log(`${notes.length} notes. --dry started nothing.`);
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

// Only when run as the script, so a test can import the note sets without starting anything.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
