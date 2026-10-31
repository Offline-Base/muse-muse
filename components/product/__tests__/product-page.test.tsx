/**
 * The product page as a whole, with its reads faked: what the live frame may use with each flag, the address the panel's
 * links point at, and which tab Quest opens on.
 *
 *   npx tsx --test --experimental-test-module-mocks components/product/__tests__/product-page.test.tsx
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { buildProductNativeView } from "@/lib/native/product-view";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;

const FLAGS = ["NATIVE_TARGETS", "VR_ENABLED", "GLASSES_ENABLED", "AGENTS_ENABLED", "VERCEL_ENV", "VERCEL_URL", "VERCEL_BRANCH_URL"] as const;
const saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
const PLATFORM = "https://muse-muse.example";

let briefTargets: string[] = [];
let userAgent = "Mozilla/5.0";
let page: (props: { params: Promise<{ slug: string }> }) => Promise<ReactNode>;

function pageData() {
  return {
    product: { id: "p1", slug: "demo", name: "Demo", tagline: "", status: "live", ownerId: "someone", liveUrl: "https://demo.vercel.app", manifest: null, rebuildOf: null, demoVideoUrl: null, demoPosterUrl: null, transcriptUrl: null },
    latestBuild: { id: "b1", costUsd: 0 },
    brief: { capabilities: [], limits: [], estimatedCostPerRunUsd: null, inspiration: { summary: "", borrow: [], dontCopy: [] }, targets: briefTargets.map((id) => ({ id, why: "A test." })) },
    inspiration: null,
    history: [],
    events: [],
    runs: { calls: 0, tokens: 0, costUsd: 0 },
  };
}

const render = async () => renderToString(createElement("div", null, await page({ params: Promise.resolve({ slug: "demo" }) }))).replace(/<!-- -->/g, "");
const frameOf = (html: string) => {
  const tag = html.match(/<iframe[^>]*title="Demo, the live product"[^>]*>/)?.[0] ?? "";
  return { allow: tag.match(/allow="([^"]*)"/)?.[1], sandbox: tag.match(/sandbox="([^"]*)"/)?.[1] };
};

describe("the product page", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    // The page imports its stylesheet, which Node can't load and mock.module can't replace.
    register("data:text/javascript,export const load = (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context);", import.meta.url);
    mock.module("next/server", { namedExports: { connection: async () => {}, after: () => {} } });
    mock.module("next/headers", { namedExports: { headers: async () => new Headers({ "user-agent": userAgent }) } });
    mock.module("next/navigation", { namedExports: { notFound: () => { throw new Error("not found"); }, useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/p/demo" } });
    mock.module("next/link", { defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }) });
    mock.module(at("../../../lib/auth.ts"), { namedExports: { canActAsOwner: () => false } });
    mock.module(at("../../../lib/queries.ts"), {
      namedExports: {
        currentUser: async () => null,
        safeQuery: async (fn: () => Promise<unknown>) => ({ ok: true, data: await fn() }),
        getProductPage: async () => pageData(),
        platformOrigin: async () => PLATFORM,
        rebuildRef: () => null,
        buildHighlights: () => [],
      },
    });
    mock.module(at("../../../lib/native/queries.ts"), {
      namedExports: {
        readProductNative: async (_id: string, targets: never[]) => buildProductNativeView({ targets, artifacts: [], jobs: [], runs: [] }),
        downloadCounts: async () => new Map(),
      },
    });
    page = (await import(at("../../../app/p/[slug]/page.tsx"))).default;
  });

  after(() => {
    mock.restoreAll();
    for (const k of FLAGS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  beforeEach(() => {
    for (const k of FLAGS) delete process.env[k];
    briefTargets = ["web"];
    userAgent = "Mozilla/5.0";
  });

  describe("the live frame", () => {
    it("has today's limits for a glasses or VR product with every flag off", async () => {
      briefTargets = ["web", "vr", "glasses"];
      assert.deepEqual(frameOf(await render()), { allow: "clipboard-write; fullscreen", sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" });
    });

    it("gets the camera and microphone once the glasses flag is on, and only that", async () => {
      briefTargets = ["web", "vr", "glasses"];
      process.env.GLASSES_ENABLED = "1";
      assert.deepEqual(frameOf(await render()), { allow: "clipboard-write; fullscreen; camera; microphone", sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" });
    });

    it("gets tracking and pointer lock once the VR flag is on", async () => {
      briefTargets = ["web", "vr"];
      process.env.VR_ENABLED = "1";
      assert.deepEqual(frameOf(await render()), { allow: "clipboard-write; fullscreen; xr-spatial-tracking", sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-pointer-lock" });
    });

    it("gives the frame in the Phone tab the same limits", async () => {
      briefTargets = ["web", "phone", "glasses"];
      process.env.NATIVE_TARGETS = "phone";
      const html = await render();
      assert.doesNotMatch(html, /camera/);
    });
  });

  describe("the panel's links", () => {
    it("point at the platform on production", async () => {
      briefTargets = ["web", "vr"];
      process.env.VR_ENABLED = "1";
      process.env.VERCEL_ENV = "production";
      process.env.VERCEL_URL = "muse-muse-abc.vercel.app";
      const html = await render();
      assert.match(html, /muse-muse\.example\/q\/demo/);
      assert.doesNotMatch(html, /abc\.vercel\.app/);
    });

    it("point at the preview itself on a preview, and the connector stays as it is", async () => {
      briefTargets = ["web", "vr"];
      process.env.VR_ENABLED = "1";
      process.env.VERCEL_ENV = "preview";
      process.env.VERCEL_URL = "muse-muse-abc.vercel.app";
      process.env.VERCEL_BRANCH_URL = "muse-muse-git-tuned.vercel.app";
      const html = await render();
      assert.match(html, /muse-muse-git-tuned\.vercel\.app\/q\/demo/);
      assert.doesNotMatch(html, /muse-muse\.example\/q\/demo/);
      assert.doesNotMatch(html, /muse-muse\.example\/vr/);
      assert.match(html, /muse-muse\.example\/api\/mcp\/demo/);
    });
  });

  describe("on Quest", () => {
    const selected = (html: string) => html.match(/role="tab"[^>]*aria-selected="true"[^>]*>([^<]+)</)?.[1] ?? html.match(/aria-selected="true"[^>]*role="tab"[^>]*>([^<]+)</)?.[1];

    it("opens on the VR tab, with its button right there", async () => {
      briefTargets = ["web", "phone", "vr"];
      process.env.NATIVE_TARGETS = "phone";
      process.env.VR_ENABLED = "1";
      userAgent = "Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/35.0";
      const html = await render();
      assert.equal(selected(html), "VR");
      assert.match(html, /Open in VR/);
    });

    it("opens on the first tab anywhere else", async () => {
      briefTargets = ["web", "phone", "vr"];
      process.env.NATIVE_TARGETS = "phone";
      process.env.VR_ENABLED = "1";
      assert.equal(selected(await render()), "Phone");
    });
  });
});
