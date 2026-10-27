import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { museExecArgs } from "@/lib/sandbox/muse";

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("museExecArgs", () => {
  it("fills in the defaults and turns web tools off", () => {
    assert.deepEqual(museExecArgs({ promptFile: "brief.md", sessionId: SESSION }), [
      "exec",
      "--json",
      "--yolo",
      "--session-id",
      SESSION,
      "--prompt-file",
      "brief.md",
      "--model",
      "muse-spark-1.3",
      "--reasoning-effort",
      "high",
      "--max-model-steps",
      "200",
      "--disable-web-tools",
    ]);
  });

  it("uses what the caller chose, and keeps web tools on only when asked", () => {
    const args = museExecArgs({
      promptFile: "fix.md",
      sessionId: SESSION,
      model: "muse-wonder-1.0",
      reasoningEffort: "xhigh",
      maxModelSteps: 80,
      disableWebTools: false,
    });
    assert.deepEqual(args.slice(5), ["--prompt-file", "fix.md", "--model", "muse-wonder-1.0", "--reasoning-effort", "xhigh", "--max-model-steps", "80"]);
    assert.ok(!args.includes("--disable-web-tools"));
  });
});
