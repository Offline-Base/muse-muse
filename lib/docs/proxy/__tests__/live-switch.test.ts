import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { env } from "@/lib/env";

const NAMES = ["VERCEL", "DOCS_MODEL_API_KEY", "DOCS_LIVE"] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

function set(values: Partial<Record<(typeof NAMES)[number], string>>) {
  for (const name of NAMES) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
}

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

test("on Vercel the demos pause without their own key, so visitors never spend the platform's", () => {
  set({ VERCEL: "1" });
  assert.equal(env.docsLive, false);
  set({ VERCEL: "1", DOCS_MODEL_API_KEY: "   " });
  assert.equal(env.docsLive, false);
});

test("on Vercel the demos run once their key is set, and DOCS_LIVE=off still pauses them", () => {
  set({ VERCEL: "1", DOCS_MODEL_API_KEY: "test-docs-key" });
  assert.equal(env.docsLive, true);
  set({ VERCEL: "1", DOCS_MODEL_API_KEY: "test-docs-key", DOCS_LIVE: "off" });
  assert.equal(env.docsLive, false);
});

test("local runs stay live without a docs key: docsModelApiKey falls back to MODEL_API_KEY there", () => {
  set({});
  assert.equal(env.docsLive, true);
});
