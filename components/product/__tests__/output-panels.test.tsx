import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import { GetItPanel } from "@/components/product/GetItPanel";
import { productOutputSlots } from "@/components/product/OutputPanels";
import type { Manifest } from "@/lib/types";

const manifest = {
  name: "Scale My Recipe",
  slug: "scale-my-recipe",
  tagline: "Rescales recipes",
  inspiration: "x",
  models: [{ id: "muse-wonder-1.0", usedFor: "x" }],
  actions: [
    { name: "scale_recipe", description: "Rescales a recipe.", input: { type: "object" }, output: { type: "object" } },
    { name: "read_my_mail", description: "Reads the owner's mail.", input: { type: "object" }, output: { type: "object" }, who: "owner" },
  ],
  fixtures: [],
  limits: [],
  estimatedCostPerRunUsd: 0.01,
} as unknown as Manifest;
const product: { slug: string; name: string; liveUrl: string | null; manifest: Manifest } = { slug: "scale-my-recipe", name: "Scale My Recipe", liveUrl: "https://scale.vercel.app", manifest };
const at = "2026-10-31T12:00:00.000Z";
const now = new Date(at).getTime() + 60_000;
const html = (node: ReactNode) => renderToString(createElement("div", null, node)).replace(/<!-- -->/g, "");
const slots = (over: Partial<typeof product> = {}, events: Array<{ type: string; at?: string }> = []) =>
  productOutputSlots({ product: { ...product, ...over }, origin: "https://site.example/", events, now });

describe("the Get it panel's output slots", () => {
  it("has a slot for each output, pointing at this site", () => {
    const filled = slots();
    assert.deepEqual(Object.keys(filled).sort(), ["chatgpt", "claude_plugin", "cli", "gadget", "mcp", "skill"]);
    assert.match(html(filled.mcp), /https:\/\/site\.example\/api\/mcp\/scale-my-recipe/);
    assert.match(html(filled.cli), /https:\/\/site\.example\/p\/scale-my-recipe\/get\/cli/);
    assert.match(html(filled.skill), /https:\/\/site\.example\/p\/scale-my-recipe\/get\/skill/);
    assert.match(html(filled.claude_plugin), /scale-my-recipe-claude-plugin\.zip/);
    assert.match(html(filled.gadget), /https:\/\/site\.example\/p\/scale-my-recipe\/get\/gadget/);
  });

  it("gives honest gadget steps: the person's own SDK and token, where data goes and Meta's terms", () => {
    const body = html(slots().gadget);
    assert.match(body, /It has 1 command: scale_my_recipe\.scale_recipe\./);
    assert.doesNotMatch(body, /read_my_mail/);
    assert.match(body, /download="scale-my-recipe-muse-gadget\.zip"/);
    assert.match(body, /github\.com\/facebookincubator\/muse-gadget-sdk/);
    assert.match(body, /your own Muse account and SDK token/);
    assert.match(body, /We recommend installing it with <code>--run-as<\/code>/);
    assert.match(body, /Node\.js 18 or newer/);
    assert.match(body, /<code>sudo bash install\.sh<\/code>/);
    assert.match(body, /Each command sends its inputs to https:\/\/scale\.vercel\.app and stops after 30 s, so a slower action ends with a timeout\./);
    assert.match(body, /never asks for your SDK token/);
    assert.match(body, /your own personal, non-commercial use under <a href="https:\/\/gadgets\.muse\.ai\/sdk-terms">Meta&#x27;s Gadget SDK Terms<\/a>/);
    assert.match(body, /sold, advertised or listed, or given away as a promotion or reward/);
    assert.doesNotMatch(body, /\u2014/);
  });

  it("shows the gadget check's result under its tab", () => {
    const body = html(
      slots({}, [
        { type: "prove", runId: "r", origin: "ship", item: "stage", state: "done", title: "Tested", at } as never,
        { type: "prove", runId: "r", origin: "ship", item: "gadget", state: "done", title: "Muse gadget commands: 1 command check out", at } as never,
      ]).gadget,
    );
    assert.match(body, /Tested/);
    assert.match(body, /1 command check out/);
  });

  it("leaves out an action only the owner may use", () => {
    assert.match(html(slots().mcp), /It has 1 tool: scale_recipe\./);
    assert.doesNotMatch(html(slots().mcp), /read_my_mail/);
  });

  it("says ChatGPT isn't confirmed for every plan, and no output is in a directory", () => {
    assert.match(html(slots().chatgpt), /confirmed this for every ChatGPT plan/);
    assert.match(html(slots().chatgpt), /listed in/);
    assert.match(html(slots().claude_plugin), /listed in any directory/);
  });

  it("has nothing with no live link or no public action, so the panel stays out", () => {
    assert.deepEqual(slots({ liveUrl: null }), {});
    const onlyOwner = { ...manifest, actions: manifest.actions.filter((a) => a.name === "read_my_mail") } as Manifest;
    assert.deepEqual(slots({ manifest: onlyOwner }), {});
    assert.equal(html(createElement(GetItPanel, { slots: slots({ liveUrl: null }) })), "<div></div>");
  });

  it("says nothing about testing until a run has", () => {
    assert.doesNotMatch(html(slots().mcp), /Tested|Testing|output-proof/);
  });

  it("shows what a run found, with its video", () => {
    const body = html(
      slots({}, [
        { type: "prove", runId: "r", origin: "ship", item: "stage", state: "done", title: "Tested", at } as never,
        {
          type: "prove",
          runId: "r",
          origin: "ship",
          item: "cli",
          state: "done",
          title: "CLI: ran scale_recipe and printed JSON",
          checks: [{ label: "Ask it for help", ok: true }],
          media: { url: "https://x/v.mp4", posterUrl: "https://x/v.jpg", caption: "CLI. A real run." },
          at,
        } as never,
        { type: "prove", runId: "r", origin: "ship", item: "mcp", state: "failed", title: "MCP server: didn't work", at } as never,
      ]).cli,
    );
    assert.match(body, /Tested/);
    assert.match(body, /Passed: Ask it for help/);
    assert.match(body, /src="https:\/\/x\/v\.mp4"/);
    assert.match(body, /CLI\. A real run\./);
    assert.doesNotMatch(body, /Didn&#x27;t pass/);
  });

  it("says a failed output didn't pass", () => {
    const body = html(slots({}, [{ type: "prove", runId: "r", origin: "ship", item: "mcp", state: "failed", title: "MCP server: didn't work", at } as never]).mcp);
    assert.match(body, /Didn&#x27;t pass/);
  });
});
