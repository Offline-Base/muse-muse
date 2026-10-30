/**
 * The cookbook-media demos server-rendered with their DemoSpec props, the way the docs page mounts them, and the
 * specs themselves: every page in the group has one, its props survive JSON (they cross from the server to a client
 * component), and its copy prompt fits, names the right model and has no em dash. The CSS module is the only
 * stand-in (a load hook makes *.module.css an object of class names); nothing reaches the network, since effects
 * don't run in a server render.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-media/__tests__/render.test.tsx
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { before, describe, it } from "node:test";
import { createElement, type ComponentType, type ReactElement } from "react";
import pagesJson from "@/content/meta-docs/pages.json";

const CSS_HOOK = `export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) {
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k : undefined) });" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(CSS_HOOK)}`, import.meta.url);

let html: (el: ReactElement) => string;
let demos: typeof import("@/lib/docs/demos/cookbook-media").cookbookMediaDemos;
let groups: typeof import("@/lib/docs/demos/groups").DEMO_GROUPS;
let prompt: typeof import("@/lib/docs/agent-prompt");
let records: typeof import("./prompt-records");
let board: typeof import("@/components/docs/playgrounds/cookbook-media/Chessboard");
let chess: typeof import("@/components/docs/playgrounds/cookbook-media/chess");

/** The page as the docs page hands it to the prompt builder: its real H1, description and URLs. */
const pageOf = (slug: string) => {
  const page = pagesJson.find((p) => p.slug === slug);
  assert.ok(page, slug);
  return { slug, title: page.title, description: page.description, sourceUrl: page.sourceUrl, markdownUrl: page.markdownUrl };
};

function clean(out: string): string {
  assert.equal(out.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(out, /\bsk-[A-Za-z0-9]{8}|LLM\|[A-Za-z0-9]{8}|DOCS_MODEL_API_KEY|Bearer [A-Za-z0-9_]{12}/, "no key-like strings");
  return out;
}

const el = <P extends object>(c: ComponentType<P>, props: P) => createElement(c as ComponentType<object>, props);
const render = (slug: string) => {
  const spec = demos[slug];
  return html(el(spec.Component, { ...spec.props, slug }));
};

describe("cookbook-media demos", () => {
  before(async () => {
    const { renderToString } = await import("react-dom/server");
    html = (e) => clean(renderToString(e).replace(/<!-- -->/g, ""));
    demos = (await import("@/lib/docs/demos/cookbook-media")).cookbookMediaDemos;
    groups = (await import("@/lib/docs/demos/groups")).DEMO_GROUPS;
    prompt = await import("@/lib/docs/agent-prompt");
    records = await import("./prompt-records");
    board = await import("@/components/docs/playgrounds/cookbook-media/Chessboard");
    chess = await import("@/components/docs/playgrounds/cookbook-media/chess");
  });

  describe("specs", () => {
    it("has a demo for every page in the group, and nothing else", () => {
      assert.deepEqual(Object.keys(demos).sort(), [...groups["cookbook-media"]].sort());
    });

    it("keeps props plain JSON, and text free of em dashes", () => {
      for (const [slug, spec] of Object.entries(demos)) {
        assert.deepEqual(JSON.parse(JSON.stringify(spec.props)), spec.props, slug);
        for (const text of [spec.title, spec.blurb ?? "", JSON.stringify(spec.props), JSON.stringify(spec.agentPrompt)]) {
          assert.equal(text.includes(String.fromCharCode(0x2014)), false, `${slug} has an em dash`);
        }
        assert.ok(spec.blurb && spec.blurb.length < 400, `${slug} blurb`);
        assert.ok(spec.agentPrompt.task.length <= 700, `${slug} task is ${spec.agentPrompt.task.length} characters`);
        assert.ok((spec.agentPrompt.facts ?? []).length >= 3, `${slug} facts`);
        assert.ok((spec.agentPrompt.checklist ?? []).length >= 3, `${slug} checklist`);
        for (const lang of ["python", "typescript", "curl"] as const) assert.ok(spec.agentPrompt.snippets?.[lang]?.trim(), `${slug} ${lang} snippet`);
      }
    });

    it("builds copy prompts that fit, name the right model and never run muse-spark-1.3", () => {
      const model: Record<string, string> = {
        "cookbook/headlocked-speech-bubble-captions": "muse-voice-transcribe-1.0",
        "cookbook/muse-voice-transcribe": "muse-voice-transcribe-1.0",
        "cookbook/voice-api-fundamentals": "muse-voice-transcribe-1.0",
        "cookbook/voice-chess-cua": "muse-voice-transcribe-1.0",
        "cookbook/sam": "sam-3.1",
        "cookbook/sam-api-basics": "sam-3.1",
        "cookbook/video-to-sticker-pack": "sam-3.1",
      };
      for (const [slug, spec] of Object.entries(demos)) {
        for (const language of ["python", "typescript", "curl"] as const) {
          for (const agent of prompt.CODING_AGENTS.map((a) => a.id)) {
            const text = prompt.buildAgentPrompt({ page: pageOf(slug), spec: spec.agentPrompt, agent, language, lastRequest: null });
            assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, `${slug} ${language} ${agent}: ${text.length}`);
            assert.equal(text.includes("(trimmed)"), false, `${slug} ${language} ${agent}: a section was cut to fit`);
            assert.match(text, new RegExp(`Model: ${(model[slug] ?? "muse-image-1.0").replace(/\./g, "\\.")}`), `${slug} model`);
            assert.doesNotMatch(text, /muse-spark-1\.3(?!-contributor)/, `${slug} names muse-spark-1.3`);
            assert.match(text, /Done when/);
          }
        }
      }
    });

    // "Include what I just ran" is on by default, so a prompt copied after a run carries the request too. Every kind
    // of run a page's demo records has to fit beside the page's own task, facts and starter code, uncut.
    it("keeps every fact and the whole starter code when the prompt includes the run, for every run a demo records", () => {
      for (const [slug, spec] of Object.entries(demos)) {
        const runs = records.recordedRuns(slug, spec.props);
        assert.ok(Object.keys(runs).length >= 2, `${slug} has recorded runs to try`);
        for (const [name, run] of Object.entries(runs)) {
          for (const language of ["python", "typescript", "curl"] as const) {
            for (const agent of prompt.CODING_AGENTS.map((a) => a.id)) {
              const text = prompt.buildAgentPrompt({ page: pageOf(slug), spec: spec.agentPrompt, agent, language, lastRequest: run });
              const where = `${slug}, ${language}, ${agent}, after "${name}" (${text.length} characters)`;
              assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, where);
              assert.equal(text.includes("(trimmed)"), false, `${where}: a section was cut to fit`);
              assert.ok(text.includes("What I just ran in the docs"), where);
              for (const fact of spec.agentPrompt.facts ?? []) assert.ok(text.includes(fact), `${where}: lost the fact "${fact.slice(0, 60)}"`);
              assert.ok(text.includes(spec.agentPrompt.snippets![language]!.trim()), `${where}: the starter code was cut`);
              assert.doesNotMatch(text, /Bearer [A-Za-z0-9|_-]{12}/, `${where}: a key-like string`);
            }
          }
        }
      }
    });
  });

  it("renders the Muse Image recipe browser with its needs, recipes and a first step to run", () => {
    const out = render("cookbook/muse-image");
    for (const t of ["Basic generation", "Web grounding", "Consistency across a series", "Multi-turn editing"]) assert.match(out, new RegExp(`>${t}</button>`));
    for (const t of ["Generate, edit, and compose images", "Ground image generation with web search", "Keep an image series consistent", "Edit image details across turns"]) {
      assert.ok(out.includes(t), t);
    }
    assert.match(out, /href="\/docs\/cookbook\/image-generation-basics#try-it-live"/);
    assert.match(out, /Turn 1: the recipe&#x27;s watercolor fox \(\$0\.01\)/);
    assert.match(out, /Muse Image 1\.0/);
  });

  it("renders the image basics steps with chains, the state switch and Run all", () => {
    const out = render("cookbook/image-generation-basics");
    assert.match(out, /Run all 3 steps/);
    assert.match(out, /Server \(previous_response_id\)/);
    assert.match(out, /You \(store: false\)/);
    assert.match(out, /New conversation/);
    assert.equal((out.match(/Continues step 1 \(previous_response_id\)/g) ?? []).length, 2);
    assert.match(out, /Run step 3/);
    assert.match(out, /Reference: the sofa and cat/);
    assert.match(out, /about \$0\.03 for all 3/);
  });

  it("renders the anchored series with an anchor for every recurring subject, and optional steps left out of Run all", () => {
    const out = render("cookbook/anchored-image-series");
    assert.match(out, /Run all 6 steps/);
    assert.match(out, /about \$0\.06 for all 6/);
    assert.equal((out.match(/Optional, not in Run all/g) ?? []).length, 2);
    for (const anchor of ["Anchor: the hero character sheet", "Anchor: the cat character sheet", "Anchor: the park plate"]) assert.ok(out.includes(anchor), anchor);
    // hero, then the cat continues it, the park continues the cat, and panel 1 continues the park.
    for (const n of [1, 2, 3]) assert.match(out, new RegExp(`Continues step ${n} \\(previous_response_id\\)`));
    assert.match(out, /the cat shown earlier sitting on a high branch/);
  });

  it("says a step goes stale only when it has an image to lose", () => {
    const out = render("cookbook/image-editing-with-reasoning");
    assert.doesNotMatch(out, /stale/);
  });

  it("renders the search recipe with its caution and the search switches", () => {
    const out = render("cookbook/search-grounded-image-generation");
    assert.match(out, /the API doesn&#x27;t return what it found/);
    assert.match(out, /Web search \(enable_web_search\)/);
    assert.match(out, /Image search \(enable_image_search\)/);
  });

  it("renders the speech-to-text presets over the transcribe playground, and the simulator tab", () => {
    const out = render("cookbook/voice-api-fundamentals");
    for (const t of ["Stream a recording", "Dictate from a microphone", "Diarization", "One request", "Bias the transcription"]) assert.match(out, new RegExp(`>${t}</button>`));
    assert.match(out, /role="tab"[^>]*>Cutoff simulator</);
    assert.match(out, /File \(asr\/transcribe\)/);
    assert.match(out, /Realtime \(asr\/realtime\)/);
    // The simulator is mounted (hidden) with the default run: a flat sleep drifts past ten seconds.
    assert.match(out, /Closed with 1008 at \d+:\d\d: Ingress fell 10 seconds behind real time/);
    assert.match(out, /Absolute schedule \(the recipe\)/);
  });

  it("renders the voice chess HUD, board and grammar", () => {
    const out = render("cookbook/voice-chess-cua");
    for (const t of ["VOICE", "TURN", "HEARD"]) assert.match(out, new RegExp(`<dt>${t}</dt>`));
    assert.equal((out.match(/role="img" aria-label="[a-h][1-8]: /g) ?? []).length, 64);
    assert.match(out, /aria-label="e1: white king"/);
    assert.match(out, /aria-label="d8: black queen"/);
    // The recipe's grammar is the default; the demo's wider one is opt-in.
    assert.match(out, /aria-checked="true"[^>]*>Exact \(the recipe\)</);
    assert.match(out, /aria-checked="false"[^>]*>Plus piece moves</);
    assert.match(out, /The recipe&#x27;s grammar: a case-insensitive full match of &quot;Move A1 to B2&quot;/);
    assert.match(out, /wss:\/\/api\.meta\.ai\/v1\/asr\/realtime in ENDPOINTING mode/);
    assert.match(out, /value="Pawn to e4, Knight to f3, Bishop to c4, Castle kingside"/);
    assert.match(out, />Listen</);
  });

  it("draws a position with the last move and square labels", () => {
    const p = chess.fromFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1");
    const out = html(el(board.Chessboard, { position: p, last: { from: 12, to: 28 }, labels: true }));
    assert.match(out, /Black to move/);
    assert.equal((out.match(/data-last="true"/g) ?? []).length, 2);
    assert.match(out, /aria-label="e4: white pawn"/);
    assert.match(out, /aria-label="e2: empty"/);
    assert.equal((out.match(/class="squareLabel"/g) ?? []).length, 64);
  });

  it("renders the captions demo with both models and its two inputs", () => {
    const out = render("cookbook/headlocked-speech-bubble-captions");
    assert.match(out, /Muse Voice Transcribe 1\.0/);
    assert.match(out, /SAM 3\.1/);
    assert.match(out, /Conversation audio/);
    assert.match(out, /Analyze voices and people/);
    assert.match(out, /Street clip \(bubbles follow the track\)/);
  });

  it("renders SAM basics with its two request paths and concepts", () => {
    const out = render("cookbook/sam-api-basics");
    assert.match(out, /1\. Image \(data URL\)/);
    assert.match(out, /2\. Video \(upload, then file_id\)/);
    assert.match(out, /value="dog, bicycle"/);
    assert.match(out, /about \$0\.005 for 2 requests/);
    assert.match(out, /lossless \(default\)/);
  });

  it("renders the sticker pack with its subject and cost", () => {
    const out = render("cookbook/video-to-sticker-pack");
    assert.match(out, /value="dog"/);
    assert.match(out, /Track and make stickers/);
    assert.match(out, /SAM bills video per frame/);
  });

  it("renders the voice and SAM recipe browsers", () => {
    const voice = render("cookbook/muse-voice-transcribe");
    assert.ok(voice.includes("Control Apple Chess with voice"));
    assert.match(voice, /Muse Voice Transcribe 1\.0/);
    const sam = render("cookbook/sam");
    for (const t of ["SAM API basics", "Video to animated stickers", "Multi-speaker headlocked captions"]) assert.ok(sam.includes(t), t);
    assert.match(sam, /Segment &quot;dog&quot; in the street photo, streamed \(\$0\.0025\)/);
  });
});
