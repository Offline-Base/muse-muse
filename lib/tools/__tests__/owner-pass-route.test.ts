import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";
import { OTHER_PRODUCT, PRODUCT } from "@/lib/tools/__tests__/helpers";
import { ownerSubject, readOwnerCode } from "@/lib/tools/principal";
import type { SessionUser } from "@/lib/auth";

const canMock = typeof mock.module === "function";
const OWNER = "user-owner";

let viewer: SessionUser | null = null;
let product: { id: string; ownerId: string; liveUrl: string | null; status: string } | null = null;

const user = (over: Partial<SessionUser>): SessionUser => ({ id: OWNER, email: "o@example.com", isAdmin: false, ...over }) as SessionUser;
const chain = { from: () => chain, where: () => chain, limit: async () => (product ? [product] : []) };

async function get() {
  const { GET } = (await import("@/app/api/products/[slug]/owner-pass/route")) as typeof import("@/app/api/products/[slug]/owner-pass/route");
  return GET(new Request("https://platform.test/api/products/demo/owner-pass"), { params: Promise.resolve({ slug: "demo" }) });
}

describe("GET /api/products/[slug]/owner-pass", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const at = (rel: string) => new URL(rel, import.meta.url).href;
    const schema = await import(at("../../db/schema.ts"));
    mock.module(at("../../db/client.ts"), { namedExports: { db: () => ({ select: () => chain }), schema } });
    const realAuth = (await import(at("../../auth.ts"))) as typeof import("@/lib/auth");
    mock.module(at("../../auth.ts"), {
      namedExports: {
        ...realAuth,
        requireUser: async () => {
          if (!viewer) throw new realAuth.AuthError("Sign in to build.", 401);
          return viewer;
        },
      },
    });
  });

  beforeEach(() => {
    process.env.AGENTS_ENABLED = "1";
    process.env.COMPOSIO_PERSONAL_ENABLED = "1";
    viewer = user({});
    product = { id: PRODUCT, ownerId: OWNER, liveUrl: "https://demo.example/", status: "live" };
  });

  it("sends the owner to the product with a code for this product and this person", async () => {
    const res = await get();
    assert.equal(res.status, 303);
    const target = new URL(res.headers.get("location") as string);
    assert.equal(target.origin, "https://demo.example");
    assert.equal(target.pathname, "/api/musemuse/owner");
    const code = readOwnerCode(target.searchParams.get("code") as string, new Date());
    assert.ok(code);
    assert.equal(code.productId, PRODUCT);
    assert.equal(code.subject, ownerSubject(OWNER));
  });

  it("gives an admin acting as owner their own subject, never the owner's", async () => {
    viewer = user({ id: "user-admin", isAdmin: true });
    const res = await get();
    assert.equal(res.status, 303);
    const code = readOwnerCode(new URL(res.headers.get("location") as string).searchParams.get("code") as string, new Date());
    assert.equal(code?.subject, ownerSubject("user-admin"));
    assert.notEqual(code?.subject, ownerSubject(OWNER));
  });

  it("refuses someone else, and the shared guest even on the guest's own product", async () => {
    viewer = user({ id: "user-other" });
    assert.equal((await get()).status, 403);
    viewer = user({ id: OWNER, openAccess: true });
    assert.equal((await get()).status, 403);
  });

  it("needs sign-in, a product, and a live site", async () => {
    viewer = null;
    assert.equal((await get()).status, 401);
    viewer = user({});
    product = null;
    assert.equal((await get()).status, 404);
    product = { id: OTHER_PRODUCT, ownerId: OWNER, liveUrl: null, status: "live" };
    assert.equal((await get()).status, 409);
    product = { id: OTHER_PRODUCT, ownerId: OWNER, liveUrl: "https://demo.example", status: "disabled" };
    assert.equal((await get()).status, 409);
  });

  it("answers as disabled with either flag off", async () => {
    process.env.AGENTS_ENABLED = "";
    assert.equal((await get()).status, 503);
    process.env.AGENTS_ENABLED = "1";
    process.env.COMPOSIO_PERSONAL_ENABLED = "";
    assert.equal((await get()).status, 503);
  });
});
