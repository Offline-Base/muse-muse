/**
 * With SAM_TUNE off nothing changes (plan section 2.6): /fine-tuning/new and /fine-tuning render byte for byte as they
 * did before the "Teach SAM 3.1 a new object" card was added, and /fine-tuning/sam/{id} is a 404 for everyone. Each
 * render's SHA-256 and length were taken from the code before the card (fixtures/sam-flag-off.json). With SAM_TUNE on,
 * /fine-tuning/new for an admin is the same page with the card added after the composer, and nothing else; a visitor's
 * page doesn't change. The clock is frozen. Made-up data only.
 *
 *   npx tsx --test --experimental-test-module-mocks components/train/__tests__/sam-flag-off.test.tsx
 *
 * SAM_GOLDEN_WRITE=1 rewrites the fixture; run it only on code from before the card.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { after, before, describe, it, mock } from "node:test";
import { createElement, type ReactNode } from "react";
import type { SessionUser } from "@/lib/auth";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (path: string) => new URL(path, import.meta.url).href;
const FIXTURE = new URL("./fixtures/sam-flag-off.json", import.meta.url);
const FROZEN = Date.parse("2026-11-03T12:00:00.000Z");
const savedEnv = { ...process.env };
const RUN = "5a3e0000-0000-4000-8000-000000001103";

let viewer: SessionUser | null = null;
const ADMIN: SessionUser = { id: "u-admin", email: "owner@example.com", isAdmin: true };
const GUEST: SessionUser = { id: "u-guest", email: "guest@open-access.invalid", isAdmin: false, openAccess: true };

const fakeStore = {
  listOwnRuns: async () => [],
  gpuBudgetFor: async () => ({ capUsd: 0, spentUsd: 0, remainingUsd: 0 }),
  listResultJobs: async () => [],
  getResultJob: async () => null,
  listResultEvents: async () => [],
  listReadyDatasets: async () => [],
  getReadyDataset: async () => null,
  datasetPage: async () => ({ status: "ready", total: 0, items: [] }),
  getLiveDemo: async () => null,
  getAdapterSource: async () => null,
  listAdapterOptions: async () => [],
  latestQuantSource: async () => null,
  getJob: async () => null,
  listEvents: async () => [],
  getDataset: async () => null,
  listJobs: async () => [],
  listDatasets: async () => [],
  datasetProgress: async () => null,
  activeJobCount: async () => 0,
  trainingSpendToday: async () => 0,
  lastSweepOkAt: async () => null,
  verifyJobToken: async () => false,
};

type Page = (props: { params?: Promise<Record<string, string>>; searchParams?: Promise<Record<string, string>> }) => Promise<ReactNode>;
let renderNode: (node: ReactNode) => string;
let newPage: Page;
let listPage: Page;
let samPage: Page;

const sha = (html: string) => ({ sha256: createHash("sha256").update(html).digest("hex"), length: html.length });
const renders = (): Array<[string, () => Promise<string>]> => [
  ["/fine-tuning/new: admin", async () => ((viewer = ADMIN), renderNode(await newPage({ searchParams: Promise.resolve({}) })))],
  ["/fine-tuning: admin", async () => ((viewer = ADMIN), renderNode(await listPage({ searchParams: Promise.resolve({}) })))],
  ["/fine-tuning: guest", async () => ((viewer = GUEST), renderNode(await listPage({ searchParams: Promise.resolve({}) })))],
];
/** React's useId ids, which depend on where a component sits in the tree. */
const withoutIds = (html: string) => html.replace(/«[^»]*»|:R[0-9A-Za-z]+:|_R_[0-9A-Za-z]+_/g, "«id»");
/** The card's section, as SamNewCard renders it. */
const CARD = /<section class="card train-new" id="new-sam-tune"[\s\S]*?<\/section>/;

describe("with SAM_TUNE off", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.timers.enable({ apis: ["Date"], now: FROZEN });
    process.env.DATABASE_URL = "postgres://sam-flag-off.invalid/db";
    delete process.env.MODEL_API_KEY;
    delete process.env.CRON_SECRET;
    delete process.env.MAKE_CHAT_ALL;
    process.env.TUNE_COMPOSER = "1";
    mock.module("next/navigation", {
      namedExports: {
        notFound: () => {
          throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
        },
        redirect: (to: string) => {
          throw new Error(`redirect ${to}`);
        },
        unstable_rethrow: () => {},
        useRouter: () => ({ push() {}, refresh() {} }),
        usePathname: () => "/",
      },
    });
    mock.module("next/server", { namedExports: { connection: async () => {}, after: () => {} } });
    mock.module("next/link", {
      defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
    });
    mock.module("@/components/camera/CameraCapture", { namedExports: { CameraCapture: () => null, useCameraSupported: () => false } });
    mock.module(at("../../../app/fine-tuning/viewer.ts"), { namedExports: { pageViewer: async () => viewer } });
    mock.module(at("../../../lib/train/store.ts"), { namedExports: fakeStore });
    mock.module(at("../../../lib/train/sam/store.ts"), {
      namedExports: {
        getRunView: async () => {
          throw new Error("the SAM tune page must not read a run with SAM_TUNE off");
        },
      },
    });
    const { renderToString } = await import("react-dom/server");
    renderNode = (node) => renderToString(node as never);
    newPage = (await import("@/app/fine-tuning/new/page")).default as unknown as Page;
    listPage = (await import("@/app/fine-tuning/page")).default as unknown as Page;
    samPage = (await import("@/app/fine-tuning/sam/[id]/page")).default as unknown as Page;
  });

  after(() => {
    mock.timers.reset();
    mock.restoreAll();
    process.env = savedEnv;
  });

  it("renders /fine-tuning/new and /fine-tuning exactly as before the card", async () => {
    delete process.env.SAM_TUNE;
    const off: Record<string, { sha256: string; length: number }> = {};
    const html: Record<string, string> = {};
    for (const [name, fn] of renders()) off[name] = sha((html[name] = await fn()));
    // Real pages, not error cards: what the hashes stand for.
    assert.match(html["/fine-tuning/new: admin"]!, /aria-label="Make it"|composer/);
    assert.doesNotMatch(html["/fine-tuning/new: admin"]!, /Teach SAM 3\.1/);
    if (process.env.SAM_GOLDEN_WRITE === "1") {
      writeFileSync(FIXTURE, `${JSON.stringify(off, null, 2)}\n`);
      return;
    }
    const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as typeof off;
    assert.deepEqual(Object.keys(off), Object.keys(golden));
    for (const name of Object.keys(golden)) assert.deepEqual(off[name], golden[name], `${name} changed with SAM_TUNE off`);
  });

  it("with SAM_TUNE on, adds only the card to an admin's /fine-tuning/new", async () => {
    if (process.env.SAM_GOLDEN_WRITE === "1") return;
    const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, { sha256: string; length: number }>;
    delete process.env.SAM_TUNE;
    const before = await renders()[0]![1]();
    process.env.SAM_TUNE = "1";
    try {
      for (const [name, fn] of renders()) {
        const page = await fn();
        if (name === "/fine-tuning/new: admin") {
          assert.match(page, CARD, "the card is there with the flag on");
          assert.match(page, /Teach SAM 3\.1 a new object/);
          // The composer sits one level deeper (beside the card), so React's useId ids move; nothing else may change.
          assert.equal(withoutIds(page.replace(CARD, "")), withoutIds(before), "nothing else on the page changed");
        } else {
          assert.deepEqual(sha(page), golden[name], `${name} changed with SAM_TUNE on`);
        }
      }
    } finally {
      delete process.env.SAM_TUNE;
    }
  });

  it("answers 404 at /fine-tuning/sam/{id} for admins and visitors", async () => {
    delete process.env.SAM_TUNE;
    for (const who of [ADMIN, GUEST, null]) {
      viewer = who;
      await assert.rejects(samPage({ params: Promise.resolve({ id: RUN }) }), /NEXT_HTTP_ERROR_FALLBACK;404/);
    }
  });
});
