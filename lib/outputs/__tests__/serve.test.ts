/**
 * The download routes' answers, with the product given directly.
 *   npx tsx --test lib/outputs/__tests__/serve.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OutputProduct } from "@/lib/outputs/generate";
import { outputResponse, type OutputDeps } from "@/lib/outputs/serve";
import { readZip } from "@/lib/outputs/zip";
import type { Manifest } from "@/lib/types";

const manifest: Manifest = {
  name: "Tip",
  slug: "tip",
  tagline: "Tips",
  inspiration: "x",
  models: [{ id: "muse-wonder-1.0", usedFor: "x" }],
  actions: [{ name: "go", description: "Goes.", input: { type: "object" }, output: { type: "object" } }],
  fixtures: [],
  limits: [],
  estimatedCostPerRunUsd: 0,
};

const deps = (over: Partial<OutputProduct> | null = {}, enabled = true): OutputDeps => ({
  enabled: () => enabled,
  findProduct: async () => (over === null ? null : { slug: "tip", name: "Tip", tagline: "Tips", liveUrl: "https://tip.example", manifest, ...over }),
  origin: async () => "https://site.example",
});

describe("/p/<slug>/get/<kind>", () => {
  it("serves each file as a download that can't run on the site", async () => {
    const cli = await outputResponse("cli", "tip", deps());
    assert.equal(cli.status, 200);
    assert.match(cli.headers.get("content-disposition") ?? "", /attachment; filename="tip\.cjs"/);
    assert.equal(cli.headers.get("x-content-type-options"), "nosniff");
    assert.match(await cli.text(), /^#!\/usr\/bin\/env node/);

    const skill = await outputResponse("skill", "tip", deps());
    assert.match(skill.headers.get("content-disposition") ?? "", /filename="SKILL\.md"/);
    assert.match(await skill.text(), /^---\nname: tip\n/);

    const plugin = await outputResponse("claude_plugin", "tip", deps());
    assert.equal(plugin.headers.get("content-type"), "application/zip");
    assert.match(plugin.headers.get("content-disposition") ?? "", /tip-claude-plugin\.zip/);
    const files = readZip(Buffer.from(await plugin.arrayBuffer()));
    assert.match(files.get(".mcp.json")!.toString(), /https:\/\/site\.example\/api\/mcp\/tip/);
  });

  it("serves the skill file inline at its reading address", async () => {
    const res = await outputResponse("skill", "tip", deps(), { inline: true });
    assert.equal(res.headers.get("content-disposition"), null);
    assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
  });

  it("is a 404 with the flag off, for no product, no live link, no actions or a bad slug", async () => {
    const statuses = await Promise.all([
      outputResponse("cli", "tip", deps({}, false)),
      outputResponse("cli", "tip", deps(null)),
      outputResponse("cli", "tip", deps({ liveUrl: null })),
      outputResponse("skill", "tip", deps({ manifest: { ...manifest, actions: [] } })),
      outputResponse("claude_plugin", "Bad..Slug", deps()),
    ]);
    assert.deepEqual(statuses.map((r) => r.status), [404, 404, 404, 404, 404]);
  });
});
