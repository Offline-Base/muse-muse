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
import { MAX_PLAN_FILES, readDriveTemplates, type PlanFile } from "@/lib/drive/plan";
import { LAB_BASE_MODEL, LAB_MERGE_BASE } from "@/lib/train/base";
import { builtWithBlock, localFilesOf, type QuantSource } from "@/lib/train/hub-cards";
import { DERIVATIVE_FILES } from "@/lib/train/licenses";

const text = (value: unknown, isError = false): DeviceToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError });

const SOURCE = {
  run: "support-coach",
  adapter: { name: "support-coach.gguf", bytes: 21_000_000, sha256: "a".repeat(64) },
  bases: [{ name: "Llama-3.2-1B-Instruct-Q4_K_M.gguf", level: "Q4_K_M", bytes: 532_000_000, sha256: "b".repeat(64), source: null }],
  config: { base: "Llama-3.2-1B-Instruct", dataset: "support-coach", steps: 60, rank: 8, lr: 0.0002, max_length: 512 },
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

  describe("a lab model, by what its job recorded", () => {
    const JOB = "8f1d2c3b-0000-4000-8000-000000000001";
    const QUANT = "9e9e9e9e-0000-4000-8000-000000000009";
    const REPO = "musemuse/muse-glimmer-30b-bakery-helper-gguf-8f1d2c3b";
    const NAME = "muse-glimmer-30b-bakery-helper-Q4_K_M.gguf";
    const sourceOf = (params: Record<string, unknown>, metrics: Record<string, unknown>): QuantSource =>
      ({
        job: {
          id: QUANT,
          title: "Local files: Bakery helper",
          params: { adapterJobId: JOB, slug: "bakery-helper", trainChannel: 1, ...params },
          hub: { status: "published", modelRepo: REPO, modelCommit: "c".repeat(40), public: true, files: [{ path: NAME, sha256: "2".repeat(64) }] },
        },
        metrics: { q4_k_m_passed: "yes", q4_k_m_bytes: 16_000_000_000, q4_k_m_sha256: "2".repeat(64), ...metrics },
        datasetTitle: "Bakery helper",
        adapterPublic: true,
      }) as unknown as QuantSource;
    const exported = async (source: QuantSource, card: string) => {
      const kit = (await loadKit())!;
      return buildExport(
        { kind: "lab", jobId: JOB, build: "Q4_K_M" },
        { ...(await deps({ ...kit, baseUrl: "https://kit.test/drive-kit/" })), localFiles: async () => localFilesOf(source), hubText: async () => card },
      );
    };
    const text = (files: PlanFile[], rel: string) => (files.find((f) => f.path === rel) as { text: string }).text;

    it("from before the switch, no duties", async () => {
      const { plan } = await exported(sourceOf({}, {}), "# Bakery helper GGUF\n");
      assert.ok(!plan.files.some((f) => f.path === "licenses/NOTICE" || f.path === "licenses/MUSE_MODEL_LICENSE.md"));
      assert.doesNotMatch(text(plan.files, "Start Here.html"), /Spark Open/);
      assert.equal(JSON.parse(text(plan.files, "PROVENANCE.json")).tuned.base, "Muse Glimmer 30B");
    });

    for (const [name, source] of [
      ["its baseModel param", sourceOf({ baseModel: LAB_BASE_MODEL }, {})],
      ["its merge_base metric", sourceOf({}, { merge_base: LAB_MERGE_BASE })],
    ] as const) {
      it(`trained on r30b by ${name}, a Derivative with the real kit's license files and links only for the GGUF and the kit`, async () => {
        const { plan, urls } = await exported(source, `# Bakery helper GGUF\n\n${builtWithBlock("These files")}\n`);
        const paths = plan.files.map((f) => f.path);
        for (const p of ["licenses/MUSE_MODEL_LICENSE.md", "licenses/NOTICE", "licenses/Apache-2.0.txt", "licenses/USAGE_POLICY.md", "licenses/CHANGES.md"]) assert.ok(paths.includes(p), p);
        assert.ok(!paths.includes("licenses/MUSE_USAGE_POLICY.md"));
        assert.match(text(plan.files, "support/model.tsv"), /^title\t.*Built with Muse Spark Open/m);
        assert.equal(JSON.parse(text(plan.files, "PROVENANCE.json")).tuned.base, LAB_MERGE_BASE);
        // The real kit's Apache 2.0 and Usage Policy are the release's own bytes, so the one copy of each is the duty.
        for (const name of ["LICENSE", "USAGE_POLICY.md"]) {
          const sha256 = DERIVATIVE_FILES.find((f) => f.path === name)!.sha256;
          assert.ok(plan.files.some((f) => "kit" in f && f.sha256 === sha256), name);
        }
        assert.equal(urls["2".repeat(64)], `https://huggingface.co/${REPO}/resolve/${"c".repeat(40)}/${NAME}`);
        for (const d of DERIVATIVE_FILES) if (d.path !== "LICENSE" && d.path !== "USAGE_POLICY.md") assert.equal(urls[d.sha256], undefined, d.path);
        assert.equal(callTooLarge({ plan, urls }), false);
      });
    }
  });

  it("refuses a run tuned on a base the kit has no license for, as a missing source", async () => {
    const kit = (await loadKit())!;
    await assert.rejects(
      buildExport({ kind: "board", run: "x" }, await deps({ ...kit, baseUrl: "https://kit.test/drive-kit/" }, { ...SOURCE, config: { ...SOURCE.config, base: "Llama-9B" } })),
      (err: unknown) => err instanceof ExportSourceMissing && /only has licenses for Llama-3\.2-1B-Instruct/.test(err.message),
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
