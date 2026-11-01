/** npx tsx --test lib/gateway/__tests__/local-gadget.test.ts */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { noBoard, SIMULATED_BOARD } from "@/lib/gateway/gadget";
import { LOCAL_BOARD_REPLIES, localGadgetFiles, patchGadgetForLocalRun } from "@/lib/sandbox/local-gadget";

describe("a local run's simulated board", () => {
  it("answers exactly as the gateway's simulated board does", async () => {
    for (const [tool, content] of Object.entries(LOCAL_BOARD_REPLIES)) {
      assert.deepEqual((await SIMULATED_BOARD.callTool(tool, {})).content, content, tool);
    }
  });
  it("patches the template's real client, and says what the gateway says with no board", async () => {
    const patched = patchGadgetForLocalRun(readFileSync("template/lib/meta/gadget.ts", "utf8"));
    assert.ok(patched.includes("LOCAL_BOARD_REPLIES[tool"));
    const body = (await noBoard().json()) as { error: { message: string; code: string } };
    assert.equal(body.error.code, "gadget_offline");
    assert.ok(patched.includes(body.error.message));
  });
  it("writes nothing without the option or on a public platform", () => {
    const saved = process.env.PLATFORM_URL;
    process.env.PLATFORM_URL = "http://localhost:3023";
    assert.deepEqual(localGadgetFiles({ capabilities: [{ model: "muse-wonder-1.0" }] }), []);
    assert.equal(localGadgetFiles({ capabilities: [{ model: "muse-gadget" }] }).length, 2);
    process.env.PLATFORM_URL = "https://muse.example";
    assert.deepEqual(localGadgetFiles({ capabilities: [{ model: "muse-gadget" }] }), []);
    process.env.PLATFORM_URL = saved;
  });
});
