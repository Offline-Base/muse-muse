/**
 * Drives the tool loop with a scripted model and board: it passes tools and results along, photos reach the model as
 * images, a bad call goes back to the model, and it always ends.
 *
 *   npx tsx --test lib/device/__tests__/agent.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Response as ModelResponse, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { MAX_MODEL_CALLS, runDeviceAgent, type DeviceAgentDeps } from "@/lib/device/agent";
import type { DeviceToolResult } from "@/lib/device/client";

const toolCall = (name: string, args = "{}", callId = "call-1") => ({ type: "function_call", name, arguments: args, call_id: callId });
const reply = (id: string, output: unknown[], text = "") => ({ id, output, output_text: text }) as unknown as ModelResponse;

const PHOTO: DeviceToolResult = { content: [{ type: "image", data: "abc", mimeType: "image/jpeg" }], isError: false };

function harness(replies: ModelResponse[] | (() => ModelResponse), results: Record<string, DeviceToolResult> = {}) {
  const bodies: ResponseCreateParamsNonStreaming[] = [];
  const called: Array<{ name: string; args: unknown }> = [];
  const deps: DeviceAgentDeps = {
    model: "test-model",
    respond: async (body) => {
      bodies.push(body);
      return typeof replies === "function" ? replies() : replies[bodies.length - 1]!;
    },
    listTools: async () => [{ name: "capture_image", description: "Takes a photo.", inputSchema: { type: "object" } }],
    callTool: async (name, args) => {
      called.push({ name, args });
      return results[name] ?? { content: [{ type: "text", text: "ok" }], isError: false };
    },
  };
  return { bodies, called, deps };
}

const outputOf = (body: ResponseCreateParamsNonStreaming) => (body.input as unknown as Array<{ call_id: string; output: unknown[] }>)[0]!;

describe("runDeviceAgent", () => {
  it("answers without the board when the model needs no tool", async () => {
    const h = harness([reply("r1", [], "Hello.")]);
    assert.deepEqual(await runDeviceAgent("hi", h.deps), { answer: "Hello.", steps: [] });
    assert.deepEqual(h.called, []);
    assert.equal(h.bodies[0]!.input, "hi");
  });

  it("offers the board's own tools on every call", async () => {
    const h = harness([reply("r1", [toolCall("capture_image")]), reply("r2", [], "Done.")], { capture_image: PHOTO });
    await runDeviceAgent("look", h.deps);
    for (const body of h.bodies) {
      assert.equal(body.tools?.[0]?.type, "function");
      assert.equal((body.tools?.[0] as { name: string }).name, "capture_image");
      assert.ok(body.instructions);
    }
  });

  it("calls the tool the model asks for and shows the model the photo", async () => {
    const h = harness([reply("r1", [toolCall("capture_image", '{"width":640}')]), reply("r2", [], "A desk.")], { capture_image: PHOTO });
    const result = await runDeviceAgent("what do you see?", h.deps);
    assert.deepEqual(h.called, [{ name: "capture_image", args: { width: 640 } }]);
    assert.equal(h.bodies[1]!.previous_response_id, "r1");
    assert.equal(outputOf(h.bodies[1]!).call_id, "call-1");
    assert.deepEqual(outputOf(h.bodies[1]!).output, [{ type: "input_image", image_url: "data:image/jpeg;base64,abc", detail: "auto" }]);
    assert.equal(result.answer, "A desk.");
    assert.deepEqual(result.steps, [{ tool: "capture_image", arguments: { width: 640 }, ...PHOTO }]);
  });

  it("keeps audio for the reply but gives the model a note instead", async () => {
    const audio: DeviceToolResult = {
      content: [
        { type: "text", text: '{"rms":5}' },
        { type: "audio", data: "wav", mimeType: "audio/wav" },
      ],
      isError: false,
    };
    const h = harness([reply("r1", [toolCall("record_audio")]), reply("r2", [], "Quiet.")], { record_audio: audio });
    const result = await runDeviceAgent("listen", h.deps);
    const sent = JSON.stringify(outputOf(h.bodies[1]!).output);
    assert.match(sent, /rms/);
    assert.doesNotMatch(sent, /wav"|"wav/);
    assert.deepEqual(result.steps[0]!.content, audio.content);
  });

  it("gives a tool's own failure to the model to explain", async () => {
    const failed: DeviceToolResult = { content: [{ type: "text", text: "No camera." }], isError: true };
    const h = harness([reply("r1", [toolCall("capture_image")]), reply("r2", [], "No camera is attached.")], { capture_image: failed });
    const result = await runDeviceAgent("look", h.deps);
    assert.equal(result.steps[0]!.isError, true);
    assert.deepEqual(outputOf(h.bodies[1]!).output, [{ type: "input_text", text: "No camera." }]);
    assert.equal(result.answer, "No camera is attached.");
  });

  it("sends arguments that aren't an object back to the model without touching the board", async () => {
    for (const bad of ["{oops", "[1]"]) {
      const h = harness([reply("r1", [toolCall("capture_image", bad)]), reply("r2", [], "Sorry.")]);
      const result = await runDeviceAgent("look", h.deps);
      assert.deepEqual(h.called, []);
      assert.equal(result.steps[0]!.isError, true);
    }
  });

  it("answers every call of a parallel request", async () => {
    const h = harness([reply("r1", [toolCall("a", "{}", "c1"), toolCall("b", "{}", "c2")]), reply("r2", [], "Both.")]);
    await runDeviceAgent("both", h.deps);
    const input = h.bodies[1]!.input as unknown as Array<{ call_id: string }>;
    assert.deepEqual(input.map((item) => item.call_id), ["c1", "c2"]);
  });

  it("stops offering tools on its last call, so a model that keeps asking still ends", async () => {
    const h = harness(() => reply("r", [toolCall("capture_image")]));
    const result = await runDeviceAgent("again and again", h.deps);
    assert.equal(h.bodies.length, MAX_MODEL_CALLS);
    assert.deepEqual(h.bodies.map((b) => b.tool_choice).slice(-2), ["auto", "none"]);
    assert.equal(result.answer, "");
  });

  it("lets a board that can't be reached throw", async () => {
    const h = harness([reply("r1", [toolCall("capture_image")])]);
    h.deps.callTool = async () => {
      throw new Error("fetch failed");
    };
    await assert.rejects(runDeviceAgent("look", h.deps), /fetch failed/);
  });
});
