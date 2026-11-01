/**
 * The download routes' answers, with the product given directly.
 *   npx tsx --test lib/outputs/__tests__/serve.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OutputProduct } from "@/lib/outputs/generate";
import { limitedOutputResponse, outputDownloadKeys, outputResponse, type OutputDeps, type OutputLimitDeps } from "@/lib/outputs/serve";
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

describe("/p/<slug>/get/gadget", () => {
  /** Counters in memory, as reserveCounter and adjustCounter keep them in the database. */
  const counters = (full: string[] = []) => {
    const counts = new Map<string, number>();
    const limits: OutputLimitDeps & { counts: Map<string, number> } = {
      counts,
      async reserve(key, _at, limit) {
        const now = (counts.get(key) ?? 0) + 1;
        if (full.includes(key) || now > limit) return null;
        counts.set(key, now);
        return now;
      },
      async release(key) {
        counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1));
      },
      now: () => new Date("2026-11-01T10:30:00Z"),
    };
    return limits;
  };
  const get = (headers: Record<string, string> = { "x-real-ip": "203.0.113.9" }, method = "GET") => new Request("https://site.example/p/tip/get/gadget", { method, headers });

  it("serves the pack as a zip download, counted, with nothing cached", async () => {
    const limits = counters();
    const res = await limitedOutputResponse("gadget", get(), "tip", deps(), limits);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="tip-muse-gadget\.zip"/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const files = readZip(Buffer.from(await res.arrayBuffer()));
    assert.ok(files.has("tip-muse-gadget/commands.d/tip.go.json"));
    // The address comes from the row, not from the site or the manifest.
    assert.match(files.get("tip-muse-gadget/runner.cjs")!.toString(), /"liveUrl":"https:\/\/tip\.example"/);
    assert.equal(limits.counts.get(outputDownloadKeys.ip("203.0.113.9")), 1);
    assert.equal(limits.counts.get(outputDownloadKeys.day), 1);
  });

  it("is a 404 with the flag off, for an unknown slug, a bad slug or a product with only owner actions, and a 404 isn't counted", async () => {
    const limits = counters();
    const ownerOnly = { ...manifest, actions: [{ ...manifest.actions[0]!, who: "owner" as const }] };
    const statuses = await Promise.all([
      limitedOutputResponse("gadget", get(), "tip", deps({}, false), limits),
      limitedOutputResponse("gadget", get(), "tip", deps(null), limits),
      limitedOutputResponse("gadget", get(), "Bad..Slug", deps(), limits),
      limitedOutputResponse("gadget", get(), "tip", deps({ manifest: ownerOnly }), limits),
      limitedOutputResponse("gadget", get(), "tip", deps({ liveUrl: null }), limits),
    ]);
    assert.deepEqual(statuses.map((r) => r.status), [404, 404, 404, 404, 404]);
    assert.equal(limits.counts.get(outputDownloadKeys.ip("203.0.113.9")) ?? 0, 0);
    assert.equal(limits.counts.get(outputDownloadKeys.day) ?? 0, 0);
  });

  it("limits each address by the hour and everyone by the day, like the native downloads", async () => {
    const limits = counters();
    for (let i = 0; i < 20; i++) assert.equal((await limitedOutputResponse("gadget", get(), "tip", deps(), limits)).status, 200);
    const over = await limitedOutputResponse("gadget", get(), "tip", deps(), limits);
    assert.equal(over.status, 429);
    assert.equal(over.headers.get("retry-after"), "1800");
    assert.equal(over.headers.get("cache-control"), "no-store");
    assert.equal((await limitedOutputResponse("gadget", get({ "x-real-ip": "198.51.100.1" }), "tip", deps(), limits)).status, 200);

    const full = await limitedOutputResponse("gadget", get(), "tip", deps(), counters([outputDownloadKeys.day]));
    assert.equal(full.status, 429);
    assert.match(await full.text(), /full for today/);
  });

  it("answers a HEAD without counting it", async () => {
    const limits = counters();
    assert.equal((await limitedOutputResponse("gadget", get(undefined, "HEAD"), "tip", deps(), limits)).status, 200);
    assert.equal((await limitedOutputResponse("gadget", get(undefined, "HEAD"), "tip", deps(null), limits)).status, 404);
    assert.equal(limits.counts.size, 0);
  });
});
