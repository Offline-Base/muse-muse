/**
 * A board's model tools take only Meta models: start_model a Meta model's file, ask_model only while list_models says one is
 * running, and train_model not at all unless asked for. The board's own server keeps the same name rule. A fake board only.
 *
 *   npx tsx --test lib/device/__tests__/meta-only.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { DeviceToolResult } from "@/lib/device/client";
import { BOARD_TRAINING_OFF, boardModelProblem } from "@/lib/device/meta-only";
import { META_NAME_PATTERNS } from "@/lib/meta/models";

const GLIMMER_FILE = "muse-glimmer-30b-bakery-helper-IQ1_S.gguf";
const LLAMA_FILE = "Llama-3.2-1B-Instruct-Q4_K_M.gguf";

function board(running: unknown, isError = false) {
  const calls: string[] = [];
  const call = async (name: string): Promise<DeviceToolResult> => {
    calls.push(name);
    return { content: [{ type: "text", text: JSON.stringify({ files: [], running }) }], isError };
  };
  return { calls, call };
}

describe("boardModelProblem", () => {
  it("starts only a Meta model's file, without asking the board", async () => {
    const b = board(null);
    assert.equal(await boardModelProblem("start_model", { model: GLIMMER_FILE }, b.call), null);
    for (const model of [LLAMA_FILE, "nemotron-3.5-bolt-e4b.gguf", "glimmer-bolt.gguf", "", undefined, 5]) {
      assert.match((await boardModelProblem("start_model", { model, adapter: GLIMMER_FILE }, b.call))!, /isn't a Meta model's file, so nothing started\. Muse Muse only runs Meta models\./, String(model));
    }
    assert.deepEqual(b.calls, []);
  });

  it("asks only while list_models says a Meta model is running", async () => {
    const meta = board({ model: GLIMMER_FILE, adapter: null });
    assert.equal(await boardModelProblem("ask_model", { prompt: "hi" }, meta.call), null);
    assert.deepEqual(meta.calls, ["list_models"]);
    for (const [running, isError] of [[{ model: LLAMA_FILE, adapter: "receipts.gguf" }, false], [{ model: "nemotron-3.5-bolt-e4b.gguf" }, false], [null, false], [{ model: GLIMMER_FILE }, true]] as const) {
      const b = board(running, isError);
      assert.match((await boardModelProblem("ask_model", { prompt: "hi" }, b.call))!, /isn't running a Meta model, so nothing was asked/, JSON.stringify(running));
      assert.deepEqual(b.calls, ["list_models"], "it never got as far as ask_model");
    }
    const garbled = async (): Promise<DeviceToolResult> => ({ content: [{ type: "text", text: "not json" }], isError: false });
    assert.ok(await boardModelProblem("ask_model", {}, garbled));
  });

  it("lets a board that can't be reached throw, as the board's own tools would", async () => {
    const down = async (): Promise<DeviceToolResult> => {
      throw new Error("fetch failed");
    };
    await assert.rejects(boardModelProblem("ask_model", {}, down), /fetch failed/);
  });

  it("refuses train_model unless training is on, and passes every other tool", async () => {
    const b = board(null);
    assert.equal(await boardModelProblem("train_model", { dataset: "d", name: "n" }, b.call), BOARD_TRAINING_OFF);
    assert.equal(await boardModelProblem("train_model", { dataset: "d", name: "n" }, b.call, { training: true }), null);
    for (const tool of ["describe_device", "capture_image", "list_models", "stop_model", "training_status", "stop_training"]) {
      assert.equal(await boardModelProblem(tool, {}, b.call), null, tool);
    }
    assert.deepEqual(b.calls, []);
    assert.match(BOARD_TRAINING_OFF, /only train Llama 3\.x, which isn't a Meta model/);
    assert.ok(!BOARD_TRAINING_OFF.includes(String.fromCharCode(0x2014)), "no em dash");
  });
});

describe("the board server's own rule", () => {
  const server = readFileSync("muse-device/server.py", "utf8");

  it("keeps the same three patterns as isMetaModelName", () => {
    for (const [python, pattern] of [["META_FAMILY", META_NAME_PATTERNS.family], ["NOT_META", META_NAME_PATTERNS.other], ["OWN_GLIMMER_TUNE", META_NAME_PATTERNS.ownTune]] as const) {
      assert.ok(server.includes(`${python} = re.compile(r"${pattern.source}")`), python);
    }
  });

  it("refuses in start_model and ask_model, and no longer calls Llama a Meta model", () => {
    assert.match(server, /def start_model\(args\):[\s\S]*?if not is_meta_model\(args\["model"\]\):/);
    assert.match(server, /def ask_model\(args\):[\s\S]*?if not is_meta_model\(model_loaded\["model"\]\):/);
    assert.doesNotMatch(server, /small Meta models|Meta models only: a board trains/);
  });
});
