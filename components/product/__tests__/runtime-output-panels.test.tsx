/**
 * The Get it panel's runtime output slots (docs/CAPABILITIES.md, section 16): the VS Code extension and the GitHub Action
 * for a live product with public actions, and the self-host kit for its owner only.
 *   npx tsx --test components/product/__tests__/runtime-output-panels.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { GetItPanel } from "@/components/product/GetItPanel";
import { runtimeOutputSlots } from "@/components/product/RuntimeOutputPanels";
import type { Manifest } from "@/lib/types";

const manifest = {
  name: "Scale My Recipe",
  slug: "scale-my-recipe",
  tagline: "Rescales recipes",
  inspiration: "x",
  models: [{ id: "muse-wonder-1.0", usedFor: "x" }],
  fixtures: [],
  limits: [],
  estimatedCostPerRunUsd: 0.01,
  actions: [
    { name: "scale_recipe", description: "Rescales a recipe.", input: { type: "object" }, output: { type: "object" } },
    { name: "read_my_mail", description: "Reads mail.", input: { type: "object" }, output: { type: "object" }, who: "owner" },
  ],
} as unknown as Manifest;
const product = { slug: "scale-my-recipe", name: "Scale My Recipe", liveUrl: "https://scale.vercel.app" as string | null, manifest };
const html = (node: ReactNode) => renderToString(createElement("div", null, node)).replace(/<!-- -->/g, "");

describe("the runtime output slots", () => {
  it("offer the VS Code extension and the GitHub Action to everyone, pointing at this site", () => {
    const slots = runtimeOutputSlots({ product, origin: "https://site.example/", isOwner: false });
    assert.deepEqual(Object.keys(slots), ["vscode", "github_action"]);
    assert.match(html(slots.vscode), /href="https:\/\/site\.example\/p\/scale-my-recipe\/get\/vscode\.zip"/);
    assert.match(html(slots.vscode), /code --install-extension scale-my-recipe-0\.1\.0\.vsix/);
    assert.match(html(slots.github_action), /href="https:\/\/site\.example\/p\/scale-my-recipe\/get\/github-action\.zip"/);
    assert.match(html(slots.github_action), /action: scale_recipe/);
    assert.ok(!html(slots.github_action).includes("read_my_mail"));
  });

  it("offer the self-host kit to the owner only, and nothing for a product with no live link", () => {
    const owner = runtimeOutputSlots({ product, origin: "https://site.example", isOwner: true });
    assert.deepEqual(Object.keys(owner), ["vscode", "github_action", "self_host"]);
    assert.match(html(owner.self_host), /href="https:\/\/site\.example\/p\/scale-my-recipe\/get\/selfhost\.zip"/);
    assert.match(html(owner.self_host), /Only you see this tab/);
    assert.deepEqual(runtimeOutputSlots({ product: { ...product, liveUrl: null }, origin: "https://site.example", isOwner: true }), {});
    const noActions = runtimeOutputSlots({ product: { ...product, manifest: { ...manifest, actions: [] } as unknown as Manifest }, origin: "https://site.example", isOwner: true });
    assert.deepEqual(Object.keys(noActions), ["self_host"]);
  });

  it("render as tabs after the other outputs, in plain words with no em dashes", () => {
    const page = renderToString(createElement(GetItPanel, { slots: { cli: "CLI steps", ...runtimeOutputSlots({ product, origin: "https://site.example", isOwner: true }) } })).replace(/<!-- -->/g, "");
    const tabs = [...page.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(tabs, ["CLI", "VS Code", "GitHub Action", "Self-host"]);
    assert.ok(!page.includes("—"));
  });
});
