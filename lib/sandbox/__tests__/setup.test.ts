/**
 * Unit tests for the snapshot's Muse Code skill check in lib/sandbox/setup.ts.
 *   npx tsx --test lib/sandbox/__tests__/setup.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DISABLED_BUNDLED_SKILLS, skillsNotOff } from "@/lib/sandbox/setup";

/** The shape of `muse skills list --json` (Muse Code 1.4.14). */
function list(activation: (id: string) => string, extra: Array<{ id: string; activation: string }> = []): string {
  const skills = DISABLED_BUNDLED_SKILLS.map((id) => ({ id: `bundled:${id}`, activation: activation(id), scope: "bundled" }));
  return JSON.stringify({ diagnostics: [], skills: [...skills, ...extra] });
}

describe("skillsNotOff", () => {
  it("passes when every skill the snapshot turns off is off", () => {
    const kept = [
      { id: "bundled:taste", activation: "on" },
      { id: "verify", activation: "on" },
    ];
    assert.deepEqual(skillsNotOff(list(() => "off", kept)), []);
  });

  it("names skills that are still on or only limited to explicit use", () => {
    const out = skillsNotOff(list((id) => (id === "plan" ? "user-invocable-only" : id === "web3d" ? "on" : "off")));
    assert.deepEqual(out, ["web3d", "plan"]);
  });

  it("counts a skill Muse Code no longer lists, or output that isn't JSON, as not off", () => {
    const missing = JSON.parse(list(() => "off")) as { skills: Array<{ id: string }> };
    missing.skills = missing.skills.filter((s) => s.id !== "bundled:browser-game");
    assert.deepEqual(skillsNotOff(JSON.stringify(missing)), ["browser-game"]);
    assert.deepEqual(skillsNotOff("muse: not json"), [...DISABLED_BUNDLED_SKILLS]);
  });
});
