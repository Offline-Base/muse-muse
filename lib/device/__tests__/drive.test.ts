/**
 * lib/device/drive.ts and lib/device/drive-sim.ts: which models a request may name, a board run whose base the kit has no
 * license for, a plan made with the real drive kit (lib/drive/kit-files.json) that fits the board's body limit, and the
 * simulated board a build gets, which ends in PASS.
 *
 *   npx tsx --test lib/device/__tests__/drive.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DeviceToolResult } from "@/lib/device/client";
import { buildExport, callTooLarge, ENDED_STATES, ExportSourceMissing, freshUrls, parseSourceRef, sourceTag, type ExportDeps } from "@/lib/device/drive";
import { simulatedDriveStatus } from "@/lib/device/drive-sim";
import { loadKit, type DriveKit } from "@/lib/drive/kit";
import { MAX_PLAN_FILES, readDriveTemplates } from "@/lib/drive/plan";

const text = (value: unknown, isError = false): DeviceToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError });

const SOURCE = {
  run: "support-coach",
  adapter: { name: "support-coach.gguf", bytes: 21_000_000, sha256: "a".repeat(64) },
  bases: [{ name: "Qwen3.5-0.8B-Q4_K_M.gguf", level: "Q4_K_M", bytes: 532_000_000, sha256: "b".repeat(64), source: null }],
  config: { base: "Qwen3.5-0.8B", dataset: "support-coach", steps: 60, rank: 8, lr: 0.0002, max_length: 512 },
  status: { examples: 49, skipped: 0, loss: 0.41, seconds: 812, peak_gpu_gib: 1.91 },
  base_revision: null,
  system: null,
  converter: "llama.cpp b11970 convert_lora_to_gguf.py, f32",
  board: { model: null, muse_device: "0.4.0" },
};

async function deps(kit: DriveKit, source: unknown = SOURCE): Promise<ExportDeps> {
  return {
    config: { url: "https://board.example/mcp", token: "test" },
    call: async (_config, name) => (name === "export_source" ? text(source) : text({})),
    kit,
    templates: await readDriveTemplates(),
    localFiles: async () => null,
    hubText: async () => "",
    hfToken: () => null,
    newId: () => "exp_0123456789ab",
  };
}

describe("drive export, from the platform's side", () => {
  it("takes a board run or a lab model's build, and nothing else", () => {
    assert.deepEqual(parseSourceRef("board:support-coach"), { kind: "board", run: "support-coach" });
    assert.deepEqual(parseSourceRef("board:support-coach", "Q8_0"), { kind: "board", run: "support-coach", build: "Q8_0" });
    assert.deepEqual(parseSourceRef("lab:8F1D2C3B-0000-4000-8000-000000000001:all"), { kind: "lab", jobId: "8f1d2c3b-0000-4000-8000-000000000001", build: "all" });
    for (const bad of ["board:", "board:../x", "board:a:b", "lab:x:Q4_K_M", "lab:8f1d2c3b-0000-4000-8000-000000000001", "url", "s3:x", 5, null]) {
      assert.equal(parseSourceRef(bad), null, String(bad));
    }
    assert.equal(parseSourceRef("board:x", "../q"), null);
    assert.equal(sourceTag({ kind: "lab", jobId: "j", build: "Q6_K" }), "lab:j:Q6_K");
    assert.deepEqual([...ENDED_STATES], ["done", "failed", "stopped"]);
  });

  it("builds a board run's plan with the real kit, far under the board's limits", async () => {
    const kit = await loadKit();
    assert.ok(kit, "lib/drive/kit-files.json is there");
    const built = await buildExport({ kind: "board", run: "support-coach" }, await deps({ ...kit!, baseUrl: "https://kit.test/drive-kit/" }));
    assert.equal(built.armable, true);
    assert.ok(built.plan.files.length < MAX_PLAN_FILES / 3, `${built.plan.files.length} files`);
    assert.equal(callTooLarge({ plan: built.plan, urls: built.urls }), false);
    const bytes = Buffer.byteLength(JSON.stringify({ plan: built.plan, urls: built.urls }));
    assert.ok(bytes < 400 * 1024, `${bytes} bytes`);
    assert.ok(built.plan.files.some((f) => f.path === "runtime/windows-x64-vulkan/ggml-vulkan.dll" && "kit" in f), "the real runtime");
  });

  it("refuses a run tuned on a base the kit has no license for, as a missing source", async () => {
    const kit = (await loadKit())!;
    await assert.rejects(
      buildExport({ kind: "board", run: "x" }, await deps({ ...kit, baseUrl: "https://kit.test/drive-kit/" }, { ...SOURCE, config: { ...SOURCE.config, base: "Llama-9B" } })),
      (err: unknown) => err instanceof ExportSourceMissing && /only has licenses for Qwen3\.5-0\.8B/.test(err.message),
    );
  });

  it("makes no fresh links for a board run or the owner's own file", async () => {
    const kit = (await loadKit())!;
    for (const source of ["board:support-coach", "url", null, undefined]) assert.equal(await freshUrls(source, await deps(kit)), null);
  });

  it("gives a build a simulated board whose export ends in PASS", () => {
    const idle = simulatedDriveStatus(null, 0);
    assert.equal(idle.simulated, true);
    assert.equal(idle.export, null);
    assert.equal(idle.drives[0].usable, true);
    const seen = [0, 1000, 3000, 7000, 9000].map((t) => simulatedDriveStatus(0, t).export!.state);
    assert.deepEqual(seen, ["checking", "checking", "writing", "verifying", "done"]);
    const done = simulatedDriveStatus(0, 60_000).export!;
    assert.equal(done.result, "PASS");
    assert.match(done.message!, /Safe to unplug/);
  });
});
