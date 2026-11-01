/**
 * The /gadgets slot with HARDWARE_BOARD_REGISTRY: an admin's own boards in status words, one plain line for anyone else, and
 * the "Planned" note with the flag off. Never an address or token, and never a call to a board. Nothing reaches Neon.
 *
 *   npx tsx --test --experimental-test-module-mocks components/gadgets/__tests__/boards-slot.test.tsx
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it, mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionUser } from "@/lib/auth";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (path: string) => new URL(path, import.meta.url).href;
const ADMIN = { id: "u1", isAdmin: true, openAccess: false, email: "a@example.com" } as unknown as SessionUser;

describe("BoardsSlot", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let slot: typeof import("../BoardsSlot");
  let reads = 0;
  let failing = false;

  before(async () => {
    mock.module(at("../../../lib/caps/hardware/store.ts"), {
      namedExports: {
        listBoards: async (id: string) => {
          reads++;
          if (failing) throw new Error("db at postgres://secret");
          return id === "u1" ? [{ id: "b1", name: "Shop board", status: "ok", lastSeenAt: null, products: [{ slug: "s", name: "Corner", visitors: false }] }, { id: "b2", name: "Spare", status: "unreachable", lastSeenAt: null, products: [] }] : [];
        },
      },
    });
    slot = await import("../BoardsSlot");
  });
  after(() => mock.reset());
  afterEach(() => {
    delete process.env.HARDWARE_BOARD_REGISTRY;
    reads = 0;
    failing = false;
  });

  async function html(viewer: SessionUser | null): Promise<string> {
    const el = slot.BoardsSlot({ viewer });
    const inner = el.type as unknown;
    return renderToStaticMarkup(typeof inner === "function" ? await (inner as (p: unknown) => Promise<React.ReactElement>)(el.props) : el);
  }

  it("with the flag off, the note is what it was, for everyone, and nothing is read", async () => {
    for (const viewer of [null, ADMIN]) {
      const out = await html(viewer);
      assert.match(out, /Planned: connect your own board/);
      assert.match(out, /Connecting your own board is\s+planned\./);
    }
    assert.equal(reads, 0);
  });

  it("an admin sees their boards in status words, and the way to /device", async () => {
    process.env.HARDWARE_BOARD_REGISTRY = "1";
    const out = await html(ADMIN);
    assert.match(out, /Shop board/);
    assert.match(out, /Online/);
    assert.match(out, /Not answering/);
    assert.match(out, /Linked to Corner/);
    assert.match(out, /href="\/device"/);
    assert.doesNotMatch(out, /Planned/);
  });

  it("anyone else sees one plain line, and nothing is read", async () => {
    process.env.HARDWARE_BOARD_REGISTRY = "1";
    for (const viewer of [null, { ...ADMIN, isAdmin: false }, { ...ADMIN, openAccess: true }] as SessionUser[]) {
      const out = await html(viewer);
      assert.match(out, /Admins connect boards for now/);
      assert.doesNotMatch(out, /Shop board|href="\/device"/);
    }
    assert.equal(reads, 0);
  });

  it("a failed read says so plainly and never shows why", async () => {
    process.env.HARDWARE_BOARD_REGISTRY = "1";
    failing = true;
    const real = console.error;
    console.error = () => undefined;
    try {
      const out = await html(ADMIN);
      assert.match(out, /can&#x27;t be shown right now/);
      assert.doesNotMatch(out, /secret/);
    } finally {
      console.error = real;
    }
  });
});
