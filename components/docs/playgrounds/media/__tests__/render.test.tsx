/**
 * Every media page's DemoSpec, the way the docs page mounts it: the component server-rendered with its JSON props
 * (what a reader sees before anything runs), and the copy prompt built from its agentPrompt in each language, before
 * and after each request the page's demo can record. The CSS modules are the only stand-in: a load hook turns
 * *.module.css into an object whose class names are themselves. Effects don't run in a server render, so nothing
 * reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/media/__tests__/render.test.tsx
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { before, describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
// Pure modules (no CSS), safe to load before the hook below.
import type { DocsPageInfo, RecordedRequest } from "@/components/docs/kit/DocsPageContext";
import { groundingPrompt, inlineFileBody, mediaBody, statelessTurnBody, tokenCountBody, visionBody } from "@/components/docs/playgrounds/media/bodies";
import { checkAgainst, exampleFor } from "@/components/docs/playgrounds/media/schema-check";
import type { SchemaDoc } from "@/components/docs/playgrounds/media/schema-tables";
import { trimForRecord } from "@/lib/docs/client/record";

const CSS_HOOK = `export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) {
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k : undefined) });" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(CSS_HOOK)}`, import.meta.url);

/** The media group's pages (lib/docs/demos/index.ts, DEMO_GROUPS.media). */
const SLUGS = [
  "image-understanding",
  "image-generation",
  "video-understanding",
  "file-handling",
  "api-reference/images",
  "api-reference/images/create-image",
  "api-reference/images/edit-image",
  "api-reference/images/schemas",
  "api-reference/files",
  "api-reference/files/upload-file",
  "api-reference/files/list-files",
  "api-reference/files/retrieve-file",
  "api-reference/files/retrieve-file-content",
  "api-reference/files/delete-file",
  "api-reference/files/schemas",
];

const EM_DASH = String.fromCharCode(0x2014);
const LANGUAGES = ["python", "typescript", "curl"] as const;
const M = "muse-spark-1.3-contributor";
const NOTICE = /Runs on Muse Spark 1\.\d Contributor: Meta may use what you send to train future models\. Don&#x27;t send anything private\./;

type Demos = typeof import("@/lib/docs/demos/media").mediaDemos;
let demos: Demos;
let html: (slug: string) => string;
let prompts: typeof import("@/lib/docs/agent-prompt");
let withFileId: typeof import("@/components/docs/playgrounds/media/PresetConsole").withFileId;

function clean(out: string): string {
  assert.equal(out.includes(EM_DASH), false, "no em dash");
  assert.doesNotMatch(out, /\bsk-[A-Za-z0-9]{8}|LLM_\d{6}|DOCS_MODEL_API_KEY|Bearer [A-Za-z0-9_]{12}/, "no key-like strings");
  return out;
}

describe("media demos", () => {
  before(async () => {
    const { renderToString } = await import("react-dom/server");
    demos = (await import("@/lib/docs/demos/media")).mediaDemos;
    prompts = await import("@/lib/docs/agent-prompt");
    withFileId = (await import("@/components/docs/playgrounds/media/PresetConsole")).withFileId;
    html = (slug) => {
      const spec = demos[slug];
      const el = createElement(spec.Component as ComponentType<object>, { ...spec.props, slug });
      return clean(renderToString(el).replace(/<!-- -->/g, ""));
    };
  });

  it("has a spec for every page in the group, and nothing else", () => {
    assert.deepEqual(Object.keys(demos).sort(), [...SLUGS].sort());
  });

  it("gives each spec a title, a blurb, a task, facts, a checklist and three snippets, with no em dash or retired model", () => {
    for (const slug of SLUGS) {
      const spec = demos[slug];
      assert.ok(spec.title && spec.blurb, slug);
      assert.ok(spec.agentPrompt.task.length > 60 && spec.agentPrompt.task.length <= 700, `${slug} task length ${spec.agentPrompt.task.length}`);
      assert.ok(spec.agentPrompt.facts?.length && spec.agentPrompt.checklist?.length, slug);
      for (const lang of ["python", "typescript", "curl"] as const) assert.ok(spec.agentPrompt.snippets?.[lang], `${slug} ${lang}`);
      const json = JSON.stringify({ title: spec.title, blurb: spec.blurb, props: spec.props, agentPrompt: spec.agentPrompt });
      assert.equal(json.includes(EM_DASH), false, `${slug}: em dash`);
      assert.doesNotMatch(json, /muse-spark-1\.3(?!-contributor)/, `${slug}: names muse-spark-1.3`);
      assert.doesNotMatch(json, /api_key=["'][^"']|apiKey: ["'][^"']/, `${slug}: a literal key`);
    }
  });

  it("builds every copy prompt whole, under the limit, in every language", () => {
    for (const slug of SLUGS) {
      const spec = demos[slug];
      for (const language of ["python", "typescript", "curl"] as const) {
        const text = prompts.buildAgentPrompt({
          page: { slug, title: slug, description: "", sourceUrl: `https://dev.meta.ai/docs/${slug}`, markdownUrl: `https://dev.meta.ai/docs/${slug}.md` },
          spec: spec.agentPrompt,
          agent: "claude-code",
          language,
          lastRequest: null,
        });
        assert.ok(text.length <= prompts.PROMPT_MAX_CHARS, `${slug} ${language}: ${text.length} characters`);
        assert.equal(text.includes("(trimmed)"), false, `${slug} ${language}: trimmed`);
        assert.ok(text.includes(spec.agentPrompt.task), `${slug} ${language}: task`);
        assert.ok(text.includes(spec.agentPrompt.snippets![language]!.trim()), `${slug} ${language}: snippet`);
        assert.equal(text.includes(EM_DASH), false);
      }
    }
  });

  it("keeps every prompt's task, facts and starter code whole after any request the page can record", () => {
    // With "Include what I just ran" on (the default), the prompt makes room for the run by trimming; only the run's
    // own body may be cut.
    for (const slug of SLUGS) {
      const spec = demos[slug].agentPrompt;
      for (const lastRequest of [null, ...runsFor(slug)]) {
        for (const language of LANGUAGES) {
          for (const { id: agent } of prompts.CODING_AGENTS) {
            const text = prompts.buildAgentPrompt({ page: pageInfo(slug), spec, agent, language, lastRequest });
            const where = `${slug}, ${language}, ${agent}, after ${lastRequest?.label ?? "no run"}`;
            assert.ok(text.length <= prompts.PROMPT_MAX_CHARS, `${where}: ${text.length} characters`);
            assert.ok(text.includes(spec.task), `${where}: the task was trimmed`);
            for (const fact of spec.facts ?? []) assert.ok(text.includes(fact), `${where}: a fact was trimmed`);
            assert.ok(text.includes(spec.snippets![language]!.trim()), `${where}: the starter code was trimmed`);
          }
        }
      }
    }
  });

  it("builds the schema explorers' examples from the page's own hints, and each passes the page's rules", () => {
    for (const slug of ["api-reference/images/schemas", "api-reference/files/schemas"]) {
      const { schemas, hints } = demos[slug].props as { schemas: SchemaDoc[]; hints: Record<string, unknown> };
      const requests = schemas.filter((s) => /(Request|Param)$/.test(s.name));
      assert.ok(requests.length >= (slug.includes("images") ? 3 : 1), slug);
      for (const schema of requests) {
        for (const optional of [false, true]) {
          const report = checkAgainst(schemas, schema.id, exampleFor(schemas, schema.id, { optional, hints }), "request");
          assert.equal(report.ok, true, `${schema.name} optional=${optional}: ${JSON.stringify(report.rows.filter((r) => r.severity === "error"))}`);
        }
      }
    }
  });

  it("image-understanding: presets in three rows, every way to send, grounding, token counts and the notice", () => {
    const out = html("image-understanding");
    for (const label of ["Describe a photo", "Read a chart", "Compare two images", "Point", "Box", "Count", "Public URL", "Uploaded file", "file_url", "Chat Completions"]) {
      assert.match(out, new RegExp(`>${label}</button>`), label);
    }
    for (const send of ["Base64 data URL", "Uploaded, input_image", "Uploaded, input_file", "input_file file_url"]) assert.ok(out.includes(send), send);
    assert.match(out, /aria-label="Perception grounding mode"/);
    assert.match(out, /Count input tokens/);
    assert.match(out, NOTICE);
    assert.match(out, /What is in this image\? Describe the scene in two sentences\./);
  });

  it("image-generation: four tabs, the kit's playground first with the page's prompt", () => {
    const out = html("image-generation");
    for (const tab of ["Generate and refine", "Manage state yourself", "Images endpoints", "Errors"]) assert.match(out, new RegExp(`role="tab"[^>]*>${tab}</button>`), tab);
    assert.match(out, /a red fox trotting through fresh snow, golden hour/);
    assert.match(out, /Muse Image 1\.0/);
  });

  it("video-understanding: video and audio presets, both APIs, upload by default", () => {
    const out = html("video-understanding");
    for (const label of ["Describe (upload, input_file)", "Timestamps", "Chat Completions video_url", "Transcribe", "audio_url", "Chat Completions input_audio"]) {
      assert.ok(out.includes(`>${label}</button>`), label);
    }
    assert.match(out, /Upload, input_file/);
    assert.match(out, /the flow the page recommends/);
    assert.match(out, NOTICE);
  });

  it("file-handling: the inline tab with API and send-as switches, and the upload tab", () => {
    const out = html("file-handling");
    assert.match(out, />Send it inline</);
    assert.match(out, />Upload once, reuse the id</);
    assert.match(out, /input_file file_data/);
    assert.match(out, /aria-label="API"/);
    assert.match(out, NOTICE);
  });

  it("the images reference pages open a console on their endpoint", () => {
    assert.match(html("api-reference/images"), /value="images\/generations"/);
    const create = html("api-reference/images/create-image");
    assert.match(create, />Wide JPEG</);
    assert.match(create, /&quot;n&quot;: 1/);
    const edit = html("api-reference/images/edit-image");
    assert.match(edit, /value="images\/edits"/);
    assert.match(edit, />Compose two images</);
  });

  it("the schema pages explore the page's own tables", () => {
    const images = html("api-reference/images/schemas");
    assert.match(images, /Create Image Request/);
    assert.match(images, /Images Response/);
    assert.match(images, /Include optional fields/);
    assert.match(images, /Send the Create Image Request/);
    const files = html("api-reference/files/schemas");
    assert.match(files, /File Object/);
    assert.match(files, /expires_at/);
    assert.match(files, /Upload with the Create File Request/);
  });

  it("each Files reference page opens the console on its own call", () => {
    const route: Record<string, RegExp> = {
      "api-reference/files/upload-file": /<code[^>]*>\/v1\/files<\/code>/,
      "api-reference/files/list-files": /\/v1\/files\?purpose=user_data&amp;order=desc/,
      "api-reference/files/retrieve-file": /\/v1\/files\/\{file_id\}<\/code>/,
      "api-reference/files/retrieve-file-content": /\/v1\/files\/\{file_id\}\/content<\/code>/,
      "api-reference/files/delete-file": /\/v1\/files\/\{file_id\}<\/code>/,
    };
    for (const [slug, pattern] of Object.entries(route)) {
      const out = html(slug);
      assert.match(out, pattern, slug);
      assert.match(out, /aria-selected="true"[^>]*>(Upload|List|Retrieve|Download content|Delete)</, slug);
    }
    assert.match(html("api-reference/files/delete-file"), /aria-selected="true"[^>]*>Delete</);
    assert.match(html("api-reference/files"), /1\. Upload a file/);
  });

  it("puts the reader's file id where a preset says", () => {
    assert.deepEqual(withFileId({ label: "x", method: "GET", path: "files/file_abc123/content", fileId: "path" }, "file-9"), { path: "files/file-9/content", body: undefined });
    assert.deepEqual(withFileId({ label: "x", method: "POST", path: "images/edits", body: { images: [{ file_id: "file-abc123" }] }, fileId: "/images/0/file_id" }, "file-9").body, {
      images: [{ file_id: "file-9" }],
    });
    assert.equal(withFileId({ label: "x", method: "GET", path: "files", fileId: "path" }, "").path, "files");
  });
});


/** The page as the docs page describes it to the copy prompt: its real title and description (pages.json). */
const PAGES = JSON.parse(readFileSync(path.join(process.cwd(), "content/meta-docs/pages.json"), "utf8")) as DocsPageInfo[];
function pageInfo(slug: string): DocsPageInfo {
  const page = PAGES.find((p) => p.slug === slug);
  assert.ok(page, slug);
  return { slug, title: page.title, description: page.description, sourceUrl: page.sourceUrl, markdownUrl: page.markdownUrl };
}

/** A data URL of about `kb` kilobytes, as a picked file becomes before the record trims it. */
const dataUrl = (mime: string, kb: number) => `data:${mime};base64,${"A".repeat(Math.round((kb * 1024 * 4) / 3))}`;
const OUTCOME = `output_text: ${"The clip pans across a quiet street where two dogs walk past a bicycle rack. ".repeat(4)}`.slice(0, 200);
const FILE_ID = "file-842549258569145";

type Run = RecordedRequest & { label: string };

/** What useDocsRun records for a run: the body trimmed for the record, the status and the first 200 characters of the reply. */
function recorded(label: string, method: Run["method"], runPath: string, body?: unknown): Run {
  return { label, method, path: runPath, ...(body === undefined ? {} : { body: trimForRecord(body) }), status: 200, outcome: OUTCOME };
}

/** The longest "What I just ran" a page can get: a Run button on one of its code blocks sending a long body. */
const LONGEST = recorded("a long body from a code block's Run", "POST", "responses", {
  model: M,
  input: Array.from({ length: 6 }, (_, i) => ({
    type: "message",
    role: i % 2 ? "assistant" : "user",
    content: [{ type: "input_text", text: "x".repeat(400) }, { type: "input_image", image_url: dataUrl("image/png", 300) }],
  })),
  tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } }],
  reasoning: { effort: "low" },
  stream: true,
});

type Preset = { label: string; method?: Run["method"]; path?: string; body?: unknown; form?: Array<{ name: string; value?: string; file?: unknown }> };

/** The requests each page's demo records, built with the demos' own builders from the page's own presets. */
function runsFor(slug: string): Run[] {
  const props = demos[slug].props as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const runs: Run[] = [LONGEST];
  const upload = recorded("an upload", "POST", "files", "multipart: purpose=user_data, expires_after[anchor]=created_at, expires_after[seconds]=3600, file=receipt.png (66 KB)");
  const fromPresets = (presets: Preset[]) =>
    presets.map((p) =>
      recorded(p.label, p.method ?? "POST", p.path ?? "", p.form ? `multipart: ${p.form.map((f) => `${f.name}=${f.file ? "sneaker.jpg (214 KB)" : f.value}`).join(", ")}` : p.body),
    );
  if (slug === "image-understanding") {
    for (const p of props.presets) {
      const send = p.send ?? "data_url";
      const question = p.grounding ? groundingPrompt(p.grounding, p.objects ?? []) : p.question;
      const images = Array.from({ length: Math.max(1, p.samples?.length ?? 1) }, () =>
        send === "public_url" || send === "file_url" ? props.publicUrl : send.startsWith("file_id") ? FILE_ID : dataUrl("image/jpeg", 220),
      );
      const { path: runPath, body } = visionBody({ model: M, api: p.api ?? "responses", question, send, images, effort: "low", stream: true });
      runs.push(recorded(p.label, "POST", runPath, body), recorded(`${p.label}, counted`, "POST", "responses/input_tokens", tokenCountBody(M, question, send, images)));
    }
  } else if (slug === "video-understanding") {
    for (const p of props.presets) {
      const audio = p.media === "audio";
      const value = p.send?.startsWith("upload") ? FILE_ID : p.send === "public_url" ? "https://developer.mozilla.org/shared-assets/videos/flower.mp4" : audio && p.send === "input_audio" ? "A".repeat(200_000) : dataUrl(audio ? "audio/wav" : "video/mp4", 900);
      const model = audio ? "muse-spark-1.2-contributor" : M;
      const { path: runPath, body } = mediaBody({ model, api: p.api ?? "responses", media: p.media, send: p.send, question: p.question, value, format: "wav", effort: "low", stream: true, maxOutputTokens: audio ? 4000 : undefined });
      runs.push(recorded(p.label, "POST", runPath, body));
    }
  } else if (slug === "file-handling") {
    for (const p of props.inline.presets) {
      const value = p.send === "responses_file_url" ? p.url : dataUrl(p.send === "responses_video_url" ? "video/mp4" : "application/pdf", 400);
      const { path: runPath, body } = inlineFileBody({ model: M, send: p.send, question: p.question, value, filename: "field-report.pdf", effort: "low", stream: true });
      runs.push(recorded(p.label, "POST", runPath, body));
    }
    runs.push(upload);
  } else if (slug === "image-generation") {
    runs.push(...fromPresets([...props.options.presets, ...props.errors.presets]));
    const turn = statelessTurnBody({ prompt: props.stateless.followUps[1], previousImageId: `ig_${"x".repeat(900)}`, references: [dataUrl("image/png", 300)], fast: true });
    runs.push(recorded("a store: false follow-up", "POST", turn.path, turn.body));
  } else if (Array.isArray(props.presets)) {
    runs.push(...fromPresets(props.presets));
  } else if (Array.isArray(props.live)) {
    for (const a of props.live) {
      const body = a.schema ? exampleFor(props.schemas, a.schema, { optional: true, hints: props.hints }) : undefined;
      runs.push(a.body === "multipart" ? upload : recorded(a.label, a.method, a.path.replace("{file_id}", FILE_ID), a.body === "json" ? body : undefined));
    }
  } else {
    runs.push(upload, recorded("a list", "GET", `files?purpose=user_data&limit=2&order=desc&after=${FILE_ID}`), recorded("a retrieve", "GET", `files/${FILE_ID}`));
  }
  if (slug === "api-reference/files" || slug === "file-handling") {
    runs.push(recorded("a question about the upload", "POST", "responses", { model: M, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Summarize this document." }, { type: "input_file", file_id: FILE_ID }] }], stream: true }));
  }
  return runs;
}
