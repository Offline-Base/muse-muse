import type { DemoMap } from "@/lib/docs/demos/types";
import { AlertCopilot } from "@/components/docs/playgrounds/cookbook-use-cases/AlertCopilot";
import { ChartAnalysis } from "@/components/docs/playgrounds/cookbook-use-cases/ChartAnalysis";
import { ComputerUseLab } from "@/components/docs/playgrounds/cookbook-use-cases/ComputerUseLab";
import { ErrorFix } from "@/components/docs/playgrounds/cookbook-use-cases/ErrorFix";
import { GithubAgent } from "@/components/docs/playgrounds/cookbook-use-cases/GithubAgent";
import { GlimmerGate } from "@/components/docs/playgrounds/cookbook-use-cases/GlimmerGate";
import { GroundingOverlay } from "@/components/docs/playgrounds/cookbook-use-cases/GroundingOverlay";
import { LookAndAsk } from "@/components/docs/playgrounds/cookbook-use-cases/LookAndAsk";
import { MultiAgentBoard } from "@/components/docs/playgrounds/cookbook-use-cases/MultiAgentBoard";
import { OneShotGame } from "@/components/docs/playgrounds/cookbook-use-cases/OneShotGame";
import { RecipeBrowser } from "@/components/docs/playgrounds/cookbook-use-cases/RecipeBrowser";
import { SandboxExec } from "@/components/docs/playgrounds/cookbook-use-cases/SandboxExec";
import { SlideGenerator } from "@/components/docs/playgrounds/cookbook-use-cases/SlideGenerator";
import { VerifyLoop } from "@/components/docs/playgrounds/cookbook-use-cases/VerifyLoop";
import { CU_SNIPPETS, PROMPTS } from "@/components/docs/playgrounds/cookbook-use-cases/prompts";

/**
 * Live demos and coding-agent prompts for the "cookbook-use-cases" pages:
 *   cookbook/use-cases
 *   computer-use
 *   cookbook/alert-fatigue-copilot
 *   cookbook/perception-chart-analysis
 *   cookbook/perception-error-screenshot-fix
 *   cookbook/perception-grounding
 *   cookbook/generating-slides
 *   cookbook/github-agent
 *   cookbook/multi-agent-orchestration
 *   cookbook/one-shot-game-dev
 *   cookbook/iterative-game-dev
 *   cookbook/browser-verified-web-design
 *   cookbook/rayban-openclaw
 *   cookbook/computer-use
 *   cookbook/computer-use-macos
 *   cookbook/sandboxed-execution
 *   cookbook/glimmer-api-agent
 * Components live in components/docs/playgrounds/cookbook-use-cases/. The agent prompts are long, so they sit in
 * that folder's prompts.ts.
 */
export const cookbookUseCasesDemos: DemoMap = {
  "cookbook/use-cases": {
    title: "Find the recipe for your project",
    blurb: "Filter the use-case recipes by what they use and the harness they run on, or describe your project and Muse Spark picks from this list. A pick costs well under a cent.",
    Component: RecipeBrowser,
    props: {
      project: "A support desk where customers send screenshots of errors, and I want an assistant that diagnoses them.",
      presets: [
        { label: "Screenshot support", project: "A support desk where customers send screenshots of errors, and I want an assistant that diagnoses them." },
        { label: "Keep data local", project: "A finance team assistant that must keep files on our own hardware and only send questions to the cloud after a human approves." },
        { label: "Automate a GUI", project: "We have an old desktop app with no API and want an agent to fill its forms from screenshots." },
        { label: "Launch content", project: "Turn a product idea into a working app plus launch blog posts, with different roles coordinating." },
      ],
    },
    agentPrompt: PROMPTS["cookbook/use-cases"],
  },

  "computer-use": {
    title: "Drive a simulated screen with the computer tool",
    blurb:
      "Run sends the task and a screenshot with tools [{type: \"computer\"}], draws the returned actions on the screenshot, applies them to a simulated screen (never your computer), and sends the new screenshot back until the model answers. About $0.0005 a step on Spark Contributor.",
    Component: ComputerUseLab,
    props: { protocol: "computer", scene: "signup", scenes: ["signup", "tictactoe", "mines"], maxSteps: 12 },
    agentPrompt: { ...PROMPTS["computer-use"], snippets: CU_SNIPPETS.native },
  },

  "cookbook/alert-fatigue-copilot": {
    title: "Probe, chat and self-assess over an alert feed",
    blurb:
      "Run sends a synthetic 42-alert feed through the recipe's three tasks: a strict-JSON probe checked by the validator's rules, an answer whose every number is checked against the digest, and a self-assessment with proposals. About a tenth of a cent.",
    Component: AlertCopilot,
    props: { sendDigest: true, enforceSchema: false },
    agentPrompt: PROMPTS["cookbook/alert-fatigue-copilot"],
  },

  "cookbook/perception-chart-analysis": {
    title: "Read a chart, check every number, redraw it",
    blurb:
      "Run explains the sample bar chart (describe only what's visible), extracts it as strict JSON, checks each value against the chart's true numbers, and builds the summary card and a redrawn chart from the JSON. Cover the printed values to make it read the axis.",
    Component: ChartAnalysis,
    props: { sampleId: "bar-chart", coverValues: false },
    agentPrompt: PROMPTS["cookbook/perception-chart-analysis"],
  },

  "cookbook/perception-error-screenshot-fix": {
    title: "From an error screenshot to a diff",
    blurb:
      "Plan reads two screenshots of one bug, a checkout crash that names its file and a cart page that shows only its own text, searches a small Next.js repo with read and grep, and asks you the fix scope; ok build it applies the plan with exact-once edits and shows the diff and every place that reads cart.items.",
    Component: ErrorFix,
    props: { sampleId: "error-screenshot" },
    agentPrompt: PROMPTS["cookbook/perception-error-screenshot-fix"],
  },

  "cookbook/perception-grounding": {
    title: "Pin scored dots on every food in the fridge",
    blurb:
      "Run sends the fridge photo and the recipe's dietary prompt in one call, gets each item's point on the 0 to 1000 grid as strict JSON, and draws green and red dots with scores and tooltips; download the self-contained HTML overlay, or let the model write the whole page.",
    Component: GroundingOverlay,
    props: {
      sampleId: "fridge",
      presets: [
        { label: "Pescatarian, high cholesterol (default)", prompt: "I am pescatarian with high cholesterol. Put green dots on recommended food and red dots on not recommended food. Don't duplicate dots and make sure the dots are localized properly. When hovering over the dot, show personalized justification and \"health score\" out of 10, along with calories and carbs, protein, and fat. Health score numbers should appear right above the dot without hovering. The description that shows when hovering should go above all other dots." },
        { label: "Vegan athlete", prompt: "I'm vegan and training for a marathon. Green dots on high-protein plant foods, red on animal products. Show nutrition info on hover." },
        { label: "Keto", prompt: "I'm on a keto diet. Green dots on low-carb foods, red on high-carb foods. Show carb count prominently." },
        { label: "Nut allergy, lactose intolerant", prompt: "I have a nut allergy and am lactose intolerant. Red dots on anything containing nuts or dairy. Green on safe foods." },
      ],
    },
    agentPrompt: PROMPTS["cookbook/perception-grounding"],
  },

  "cookbook/generating-slides": {
    title: "Research a topic and turn it into slides",
    blurb:
      "Run has Muse Spark research the topic with web_search (it picks 3 to 5 queries, $0.0025 each), write a JSON outline normalized for key-name variance, and shows it as a deck; the model can then design its own HTML version. About two cents with search.",
    Component: SlideGenerator,
    props: { topic: "AI Agents in Production", source: "research" },
    agentPrompt: PROMPTS["cookbook/generating-slides"],
  },

  "cookbook/github-agent": {
    title: "Fire GitHub events at the recipe's agents",
    blurb:
      "Pick an event (a new issue, a sloppy PR, a hidden prompt injection, an /oc command, the agent-fix label, the weekly scan): its workflow picks the agent or blocks the run, and the agent works a sample repo through a fake gh with its own bash allow-list.",
    Component: GithubAgent,
    props: { scenario: "triage-bug" },
    agentPrompt: PROMPTS["cookbook/github-agent"],
  },

  "cookbook/multi-agent-orchestration": {
    title: "A PM and three specialists on a live Kanban board",
    blurb:
      "Run briefs the PM with the recipe's one-liner: answer its clarify questions, watch it write brief.md and runbook.md and create linked tasks, and see the dispatcher release work, a specialist block for a decision, and every comment land on the board. About a cent.",
    Component: MultiAgentBoard,
    props: {},
    agentPrompt: PROMPTS["cookbook/multi-agent-orchestration"],
  },

  "cookbook/one-shot-game-dev": {
    title: "One structured prompt, one complete game",
    blurb:
      "Run sends the recipe's AGENTS.md as instructions and its structured Crossy Road prompt at high reasoning effort, then plays the single-file game in a sandboxed frame. The 3D build usually reaches the 16,384-token output limit, so the demo sends one Continue for the rest of the file: four to six minutes, under a cent.",
    Component: OneShotGame,
    props: { preset: "crossy", effort: "high" },
    agentPrompt: PROMPTS["cookbook/one-shot-game-dev"],
  },

  "cookbook/iterative-game-dev": {
    title: "Build a game, play-test it in a browser, fix what it sees",
    blurb:
      "Round 1 writes the solar-system kart racer; the sandbox then holds Up and Left, screenshots it and reads the console; round 2 sends that back and the model fixes what it sees. Refinement passes repeat the loop. Under a cent per round.",
    Component: VerifyLoop,
    props: { kind: "game", effort: "medium" },
    agentPrompt: PROMPTS["cookbook/iterative-game-dev"],
  },

  "cookbook/browser-verified-web-design": {
    title: "Build a page, check it in a browser, fix what it sees",
    blurb:
      "Round 1 writes the Mesh Network Solutions page from the recipe's exact prompt; the sandbox screenshots it at rest and with the mouse across the ASCII logo; round 2 hands the screenshots and console back for a review and a fix. Then try the green CRT refinement.",
    Component: VerifyLoop,
    props: { kind: "site", effort: "medium" },
    agentPrompt: PROMPTS["cookbook/browser-verified-web-design"],
  },

  "cookbook/rayban-openclaw": {
    title: "Look, ask out loud, hear the answer",
    blurb:
      "Pick a photo or use your camera, hold the talk button and ask (Muse Voice Transcribe turns it into text), and one chat turn with the text and the image answers; the browser reads the answer aloud. Under a cent.",
    Component: LookAndAsk,
    props: { sampleId: "fridge", question: "What can I make with these?" },
    agentPrompt: PROMPTS["cookbook/rayban-openclaw"],
  },

  "cookbook/computer-use": {
    title: "Find Mines on a desktop and play it with cua_* tools",
    blurb:
      "Run gives Muse Spark the recipe's exact prompt and the Cua bridge's tools over a simulated Linux desktop: it screenshots, finds the game (by clicking or with cua_run_command), and plays the board, every click drawn on the screenshot it saw. About $0.0005 a step.",
    Component: ComputerUseLab,
    props: { protocol: "cua", scene: "mines", scenes: ["mines", "signup"], maxSteps: 24, handoffEvery: 12 },
    agentPrompt: { ...PROMPTS["cookbook/computer-use"], snippets: CU_SNIPPETS.cua },
  },

  "cookbook/computer-use-macos": {
    title: "Play tic-tac-toe with computer.computer and computer.stop",
    blurb:
      "Run sends metacua's two tools with store: false and parallel_tool_calls: false: every computer.computer action uses 0 to 1000 coordinates, is mapped to pixels and run on a simulated Mac window, and returns a fresh screenshot until computer.stop.",
    Component: ComputerUseLab,
    props: { protocol: "metacua", scene: "tictactoe", scenes: ["tictactoe", "signup"], maxSteps: 16, state: "replay" },
    agentPrompt: { ...PROMPTS["cookbook/computer-use-macos"], snippets: CU_SNIPPETS.metacua },
  },

  "cookbook/sandboxed-execution": {
    title: "Fix a real bug in a throwaway sandbox",
    blurb:
      "Run hands Muse Spark the recipe's two tools, run and write_file, over a JavaScript port of its psf/requests task: it reproduces the failure, fixes the source and runs the tests in a sandboxed frame, then the script re-checks and saves pred.patch. About a tenth of a cent.",
    Component: SandboxExec,
    props: { task: "requests-6028", maxCalls: 24 },
    agentPrompt: PROMPTS["cookbook/sandboxed-execution"],
  },

  "cookbook/glimmer-api-agent": {
    title: "Approve every escalation before it leaves",
    blurb:
      "Run plays the local Muse Glimmer agent (simulated in the page); when it wants Muse Spark, the gate shows the exact text, its byte count and the reason, and only Allow sends that same string through the proxy. Deny with a note to make it rewrite; the ledger keeps no content.",
    Component: GlimmerGate,
    props: { scenario: "wash-sale", timeoutSec: 300 },
    agentPrompt: PROMPTS["cookbook/glimmer-api-agent"],
  },
};
