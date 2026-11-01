/**
 * /gadgets: what it says about gadgets, the status words it reads from the environment, the products that use one, and
 * the admins' link to /device. A board's address and key are set in every page test, and must never reach the page,
 * which must never call the board either. Nothing reaches Neon.
 *
 *   npx tsx --test --experimental-test-module-mocks components/gadgets/__tests__/gadgets-page.test.tsx
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { createElement, type ReactNode } from "react";
import { GADGET_OPTION, GADGET_TOOLS, gadgetProducts, gadgetStatusRows } from "@/components/gadgets/info";
import type { ProductCardView } from "@/components/view-types";
import type { SessionUser } from "@/lib/auth";
import { GADGET_ID, PRODUCT_GADGET_TOOLS } from "@/lib/gateway/gadget";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (path: string) => new URL(path, import.meta.url).href;

const BOARD_URL = "https://jetson-05.tail-secret.ts.net:8443/mcp";
const BOARD_TOKEN = "dev-token-0123456789abcdef";
const BOARD_IP_URL = "http://203.0.113.5:8080/mcp";
const BOARD_TEXT = /jetson-05|tail-secret|ts\.net|8443|\/mcp|dev-token|0123456789abcdef|203\.0\.113\.5|8080/;

function product(over: Partial<ProductCardView> = {}): ProductCardView {
  return {
    slug: "shelf-counter",
    name: "Shelf Counter",
    tagline: "Counts what's on a shelf from a photo.",
    status: "live",
    liveUrl: "https://shelf-counter.example",
    demoVideoUrl: null,
    demoPosterUrl: null,
    muse: "Count the cans on my shelf.",
    models: ["muse-wonder-1.0", "muse-gadget"],
    buildMs: 240_000,
    costUsd: 0.9,
    fixRounds: 1,
    rebuildOf: null,
    ...over,
  };
}

function clean(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(html, BOARD_TEXT, "never the board's address or key");
}

describe("gadget facts", () => {
  it("explains exactly the tools a product may call, never run_command", () => {
    assert.deepEqual(GADGET_TOOLS.map((t) => t.name), [...PRODUCT_GADGET_TOOLS]);
    assert.equal(GADGET_TOOLS.some((t) => (t.name as string) === "run_command"), false);
    assert.equal(GADGET_OPTION, GADGET_ID);
  });

  it("says the status in plain words", () => {
    assert.deepEqual(
      gadgetStatusRows({ buildsOn: false, boardSetUp: false }).map((r) => [r.label, r.value, r.on]),
      [
        ["Gadgets for new builds", "Off", false],
        ["Live board", "Not set up", false],
      ],
    );
    const on = gadgetStatusRows({ buildsOn: true, boardSetUp: true });
    assert.deepEqual(on.map((r) => r.value), ["On", "Set up"]);
    assert.match(on[1].note, /doesn't contact it/, "set up isn't a claim that it's online");
    for (const r of on) assert.doesNotMatch(r.note, /\bconnected\b/);
  });

  it("finds the products that use a gadget", () => {
    const products = [product(), product({ slug: "a", models: ["muse-wonder-1.0"] }), product({ slug: "b", models: [] })];
    assert.deepEqual(gadgetProducts(products).map((p) => p.slug), ["shelf-counter"]);
  });
});

let viewer: SessionUser | null = null;
let db: "ok" | "not_configured" = "ok";
let products: ProductCardView[] = [];
let reads: string[] = [];

const guest: SessionUser = { id: "u-guest", email: "guest@open-access.invalid", isAdmin: false, openAccess: true };
const admin: SessionUser = { id: "u-admin", email: "owner@example.com", isAdmin: true };

describe("/gadgets", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let render: (node: ReactNode) => string;
  let page: () => Promise<ReactNode>;
  let metadata: { title?: unknown };
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  const savedError = console.error;

  before(async () => {
    mock.module("next/server", { namedExports: { connection: async () => {} } });
    mock.module("next/link", {
      defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
    });
    mock.module(at("../../../app/fine-tuning/viewer.ts"), { namedExports: { pageViewer: async () => viewer } });
    mock.module(at("../../../lib/queries.ts"), {
      namedExports: {
        safeQuery: async <T,>(fn: () => Promise<T>) =>
          db === "ok" ? { ok: true, data: await fn() } : { ok: false, reason: "not_configured", message: "" },
        listShippedProducts: async (limit: number) => {
          reads.push(`listShippedProducts(${limit})`);
          return products;
        },
      },
    });
    // The page must never reach the board, or anything else.
    globalThis.fetch = (async (input: unknown) => {
      throw new Error(`/gadgets fetched ${String(input)}`);
    }) as typeof fetch;
    const { renderToString } = await import("react-dom/server");
    render = (node) => renderToString(node as never).replace(/<!-- -->/g, "");
    const mod = await import("@/app/gadgets/page");
    page = mod.default as unknown as () => Promise<ReactNode>;
    metadata = mod.metadata as { title?: unknown };
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
    console.error = savedError;
  });

  beforeEach(() => {
    viewer = guest;
    db = "ok";
    products = [];
    reads = [];
    delete process.env.GADGETS_ENABLED;
    process.env.DEVICE_MCP_URL = BOARD_URL;
    process.env.DEVICE_MCP_TOKEN = BOARD_TOKEN;
    console.error = savedError;
  });

  it("has its own title", () => {
    assert.equal(metadata.title, "Gadgets");
  });

  it("explains gadgets to a guest, with the status and no admin link", async () => {
    delete process.env.DEVICE_MCP_URL;
    delete process.env.DEVICE_MCP_TOKEN;
    const html = render(await page());
    clean(html);
    assert.match(html, /<h1>Gadgets<\/h1>/);
    assert.match(html, /such as a Jetson board running <code>muse-device<\/code>/);
    const tools = [...html.matchAll(/<h4 class="how-title"><code>([a-z_]+)<\/code><\/h4>/g)].map((m) => m[1]);
    assert.deepEqual(tools, ["describe_device", "capture_image", "record_audio"]);
    assert.doesNotMatch(html, /run_command/);
    assert.match(html, /Every build gets a simulated board/);
    assert.match(html, /Gadgets for new builds.*?>Off</s);
    assert.match(html, /Live board.*?>Not set up</s);
    assert.doesNotMatch(html, /href="\/device"/);
    assert.match(html, /No products use a gadget yet/);
    assert.match(html, /Coming: connect your own board/);
    assert.doesNotMatch(html, /\b(20\d\d|Nov|November|Dec)\b/, "no promised dates");
    assert.deepEqual(reads, ["listShippedProducts(60)"]);
  });

  it("says a board is set up without showing its address or key, or calling it", async () => {
    process.env.GADGETS_ENABLED = "1";
    const html = render(await page());
    clean(html);
    assert.match(html, /Gadgets for new builds.*?>On</s);
    assert.match(html, /Live board.*?>Set up</s);
    assert.match(html, /This page doesn&#x27;t contact it/);
    assert.doesNotMatch(html, /\b(online|is connected)\b/i);
  });

  it("gives admins the link to /device", async () => {
    viewer = admin;
    const html = render(await page());
    clean(html);
    assert.match(html, /<a class="card vibe-run-link" href="\/device">/);
    assert.match(html, /Ask with the board&#x27;s camera and microphone, and fine-tune on it\./);
  });

  it("counts a board whose address would expose its key as not set up, and never shows it", async () => {
    process.env.DEVICE_MCP_URL = BOARD_IP_URL;
    console.error = () => {};
    const html = render(await page());
    clean(html);
    assert.match(html, /Live board.*?>Not set up</s);
  });

  it("shows only the shipped products that use a gadget", async () => {
    products = [product(), product({ slug: "plain", name: "Plain Notes", models: ["muse-wonder-1.0"] })];
    const html = render(await page());
    clean(html);
    assert.match(html, /href="\/p\/shelf-counter"[^>]*>Shelf Counter/);
    assert.doesNotMatch(html, /Plain Notes/);
    assert.doesNotMatch(html, /No products use a gadget yet/);
  });

  it("still explains gadgets without a database", async () => {
    db = "not_configured";
    const html = render(await page());
    clean(html);
    assert.match(html, /Not connected yet/);
    assert.match(html, /What a gadget is/);
    assert.match(html, /Live board/);
  });
});
