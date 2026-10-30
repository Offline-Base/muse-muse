/**
 * The live stand-ins against real replies from hosted Muse Spark (saved in fixtures/ from runs through the local docs
 * proxy on Oct 30, 2026; replies only, no headers): the kit's chat collector reads each one, the chat template lab
 * appends its tool calls and the page's results, the GRPO group scores and ranks it, and the strength comparison
 * reads its reasoning tokens. Nothing reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/open-weights/__tests__/replies.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sseReader } from "@/lib/docs/client/api";
import { tokenUsage } from "@/lib/docs/client/cost";
import { chatCollector, collectReply, type Collected } from "@/lib/docs/client/stream";
import { GLIMMER_PRESETS, SPARK_PRESETS, STANDIN_SAMPLE, appendReply, hostedMessages, mediaKinds, plainText, renderTemplate, type ConvMessage } from "@/components/docs/playgrounds/open-weights/template";
import { MATH_PROBLEMS, grpoAdvantages, readGroup, score } from "@/components/docs/playgrounds/open-weights/rewards";
import { budgetFor, hostedFromClient, standInBody } from "@/components/docs/playgrounds/open-weights/standin-body";
import { defaultSparkPlan } from "@/components/docs/playgrounds/open-weights/deploy-spark";
import { defaultGlimmerPlan } from "@/components/docs/playgrounds/open-weights/deploy-glimmer";

const FIX = join(import.meta.dirname, "fixtures");

function streamed(name: string): Collected {
  const c = chatCollector();
  const reader = sseReader((e) => c.push(e));
  reader.push(readFileSync(join(FIX, name), "utf8"));
  reader.end();
  return c.snapshot();
}

function whole(name: string): Collected {
  return collectReply("chat", JSON.parse(readFileSync(join(FIX, name), "utf8")));
}

describe("tool calls from hosted Muse Spark", () => {
  it("come back as three parallel get_weather calls, and the lab renders them with the page's results", () => {
    const reply = streamed("spark-parallel-tools.sse");
    assert.equal(reply.finishReason, "tool_calls");
    assert.deepEqual(
      reply.toolCalls.map((t) => [t.name, JSON.parse(t.arguments).city]),
      [
        ["get_weather", "Paris"],
        ["get_weather", "Rome"],
        ["get_weather", "Tokyo"],
      ],
    );
    const start: ConvMessage[] = [{ role: "user", parts: [{ type: "text", text: "What's the weather in Paris, Rome, and Tokyo?" }] }];
    const conv = appendReply(start, reply);
    assert.equal(conv.length, 5, "the question, one assistant turn with three calls, three results");
    const results = conv.filter((m): m is Extract<ConvMessage, { role: "tool" }> => m.role === "tool").map((m) => m.content);
    assert.deepEqual(results, ["sunny", "rain", "cloudy"]);
    const text = plainText(renderTemplate(conv, { model: "spark", effort: "low", currentDate: "2026-10-30", tools: [{ name: "get_weather" }], addGenerationPrompt: true }).segments);
    assert.equal((text.match(/<\|eom\|>/g) ?? []).length, 2, "<|eom|> after each call but the last");
    // The follow-up the stand-in sends next is valid Chat Completions: the calls, then a tool message per call id.
    const next = hostedMessages(conv, "spark").messages;
    const calls = (next[1].tool_calls as Array<{ id: string }>).map((c) => c.id);
    assert.deepEqual(
      next.slice(2).map((m) => m.tool_call_id),
      calls,
    );
  });

  it("make one call per turn when Glimmer's stand-in turns parallel calls off", () => {
    const reply = streamed("glimmer-one-tool.sse");
    assert.equal(reply.toolCalls.length, 1);
    const conv = appendReply(GLIMMER_PRESETS.find((p) => p.id === "tools")!.messages.slice(0, 1), reply);
    const r = renderTemplate(conv, { model: "glimmer", effort: "low", currentDate: "", tools: [{ name: "get_weather" }], addGenerationPrompt: true });
    assert.equal(r.issues.filter((i) => i.level === "error").length, 0);
    assert.ok(plainText(r.segments).includes('<atem:parameter name="city">Tokyo</atem:parameter>'));
  });

  it("read a JSON-mode answer", () => {
    const reply = streamed("json-mode.sse");
    assert.deepEqual(JSON.parse(reply.text), { city: "Paris", country: "France" });
  });
});

describe("GRPO group scoring on real rollouts", () => {
  it("scores a finished rollout 1 and a truncated one 0, and reads that spread as truncation, not a signal", () => {
    const answer = MATH_PROBLEMS.find((p) => p.id === "tight")!.answer;
    const finished = whole("grpo-finished.json");
    const cut = whole("grpo-truncated.json");
    assert.equal(finished.finishReason, "stop");
    assert.equal(cut.finishReason, "length");
    const group = [finished, cut, finished, cut];
    const rewards = group.map((r) => score("boxed", r.text, answer).reward);
    assert.deepEqual(rewards, [1, 0, 1, 0]);
    const g = grpoAdvantages(rewards);
    assert.equal(g.noSignal, false);
    assert.ok(g.advantages[0] > 0.99 && g.advantages[1] < -0.99);
    // Every 0 is a rollout max_tokens cut off: the spread would teach a length penalty, so the lab says so.
    const reading = readGroup(group.map((r, i) => ({ reward: rewards[i], finish: r.finishReason ?? null })));
    assert.equal(reading.kind, "truncation");
    assert.equal(reading.truncatedLow, 2);
    // With room to finish, both rollouts of the real fixture would have answered: the default preset gives that room.
    assert.ok(MATH_PROBLEMS[0].budget > (tokenUsage(finished.usage)?.output ?? 0) * 2);
  });
});

describe("reasoning strength, compared live", () => {
  it("reads more reasoning tokens at high than at low on the multi-step task", () => {
    const low = tokenUsage(whole("strength-low.json").usage);
    const high = tokenUsage(whole("strength-high.json").usage);
    assert.ok(low && high);
    assert.ok(high.reasoning > low.reasoning, `${high.reasoning} > ${low.reasoning}`);
  });
});

describe("stand-in request bodies", () => {
  it("send the page's conversation, tools and budget, streamed with usage", () => {
    const p = SPARK_PRESETS.find((x) => x.id === "tools")!;
    const body = standInBody({ messages: hostedMessages(p.messages, "spark").messages, tools: [{ type: "function" }] }, "muse-spark-1.3-contributor", "low", budgetFor("low"), true);
    assert.equal(body.max_tokens, 1500);
    assert.equal(body.tool_choice, "auto");
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(budgetFor("xhigh"), 4000);
  });

  it("map server-only fields out of a deploy client, and say which", () => {
    const unsloth = hostedFromClient(defaultSparkPlan("unsloth").client!);
    assert.deepEqual(unsloth.extra, { temperature: 1.0, top_p: 1.0 });
    assert.equal(unsloth.effort, "medium");
    assert.equal(unsloth.dropped.length, 2);
    const llama = hostedFromClient({ ...defaultGlimmerPlan("llamacpp").client!, extra: { chat_template_kwargs: { reasoning_strength: "high" } } });
    assert.equal(llama.effort, "high");
    assert.ok(llama.dropped[0].startsWith("chat_template_kwargs"));
  });

  it("send docs samples for the page's example media, in the parts' order, and leave out replayed reasoning", () => {
    const conv = SPARK_PRESETS.find((x) => x.id === "media")!.messages;
    assert.deepEqual(mediaKinds(conv), ["image", "video", "audio"]);
    const waiting = hostedMessages(conv, "spark");
    assert.deepEqual(waiting.messages[0].content, [{ type: "text", text: "Answer the question in the recording." }]);
    assert.ok(waiting.dropped.every((d) => d.includes("hasn't loaded")) && waiting.dropped.length === 3);
    const loaded = hostedMessages(conv, "spark", { image: "data:image/png;base64,AAAA", video: "data:video/mp4;base64,BBBB", audio: "data:audio/wav;base64,CCCC" });
    assert.deepEqual(loaded.messages[0].content, [
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,BBBB" } },
      { type: "input_audio", input_audio: { data: "CCCC", format: "wav" } },
      { type: "text", text: "Answer the question in the recording." },
    ]);
    assert.equal(loaded.dropped.length, 0);
    assert.equal(STANDIN_SAMPLE.image.id, "bar-chart");
    const multi = hostedMessages(GLIMMER_PRESETS.find((x) => x.id === "multi")!.messages, "glimmer");
    assert.ok(multi.messages.every((m) => !("reasoning_content" in m)));
  });
});
