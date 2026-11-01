/**
 * Connect and export through the real routes, on PGlite, with the pretend GitHub (real git underneath). Mostly this is about
 * one thing: every guest is one user row in production, and a guest must never reach another guest's token. Each Browser
 * below is a separate cookie jar on the same shared guest account.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/github/__tests__/routes.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { sha1, type VersionFile } from "@/lib/versions/policy";
import { startMockGitHub, MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, type MockGitHub } from "../../../scripts/github-mock";
import { makeTestDb, type TestDb } from "../../native/__tests__/helpers";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const SAVED = { ...process.env };
const ORIGIN = "https://platform.example.com";

class Browser {
  cookies = new Map<string, string>();
  session?: string;
}
let current = new Browser();
let extraHeaders: Record<string, string> = {};

const stored = new Map<string, Buffer>();
const save = (p: string, text: string): VersionFile => {
  const content = Buffer.from(text);
  stored.set(`mem://${sha1(content)}`, content);
  return { path: p, sha: sha1(content), size: content.length, url: `mem://${sha1(content)}` };
};

describe("connect and export", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let testDb: TestDb;
  let close: () => Promise<void>;
  let gh: MockGitHub;
  let tmp: string;
  let dbTouched = 0;
  let startRoute: (r: Request) => Promise<Response>;
  let callbackRoute: (r: Request) => Promise<Response>;
  let disconnectRoute: (r: Request) => Promise<Response>;
  let exportRoute: (r: Request, c: { params: Promise<{ slug: string }> }) => Promise<Response>;
  let encodeSession: typeof import("@/lib/auth").encodeSession;
  let viewOf: typeof import("@/lib/github/view").githubExportView;
  let getUser: typeof import("@/lib/auth").getSessionUser;
  let tag = 0;

  const on = (b: Browser) => {
    current = b;
    return b;
  };

  /** Runs the whole sign-in as this browser, with the pretend GitHub approving as `login`. */
  async function connect(b: Browser, login: string, slug: string): Promise<Response> {
    on(b);
    gh.nextLogin = login;
    const start = await startRoute(new Request(`${ORIGIN}/api/connect/github/start?slug=${slug}`));
    assert.equal(start.status, 302);
    const consent = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const back = new URL(consent.headers.get("location")!);
    return callbackRoute(new Request(`${ORIGIN}${back.pathname}${back.search}`));
  }
  const push = (b: Browser, slug: string, body: Record<string, unknown>) => {
    on(b);
    return exportRoute(new Request(`${ORIGIN}/api/products/${slug}/github-export`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ slug }) });
  };

  async function guestId(): Promise<string> {
    on(new Browser());
    return (await getUser())!.id;
  }
  async function addVersion(productId: string, userId: string, inspirationId: string, message: string | null, kind: "build" | "refine", files: VersionFile[], startedAt: Date) {
    const [build] = await testDb.insert(realSchema.builds).values({ inspirationId, userId, productId, kind, status: "live", message, startedAt }).returning();
    await testDb.insert(realSchema.productVersions).values({ buildId: build!.id, productId, files, bytes: 1 });
  }
  /** A product with one saved version, whose code anyone may read unless `sourcePublic` is false. */
  async function product(ownerId: string, sourcePublic = true) {
    tag += 1;
    const slug = `demo-${tag}`;
    const [inspiration] = await testDb.insert(realSchema.inspirations).values({ userId: ownerId }).returning();
    const [row] = await testDb.insert(realSchema.products).values({ slug, name: "Demo", ownerId, sourcePublic, status: "live" }).returning();
    await addVersion(row!.id, ownerId, inspiration!.id, null, "build", [save("README.md", `# ${slug}\n`), save("app/page.tsx", "one\n")], new Date(Date.UTC(2026, 10, 1)));
    return { slug, id: row!.id, inspirationId: inspiration!.id, ownerId };
  }
  const bare = (full: string) => gh.repoPath(full);
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

  before(async () => {
    ({ db: testDb, close } = await makeTestDb());
    tmp = mkdtempSync(path.join(tmpdir(), "gh-routes-"));
    gh = await startMockGitHub(path.join(tmp, "repos"));
    mock.module(at("../../db/client.ts"), {
      namedExports: {
        db: () => {
          dbTouched += 1;
          return testDb;
        },
        schema: realSchema,
      },
    });
    mock.module("next/headers", {
      namedExports: {
        cookies: async () => ({
          get: (name: string) => (current.cookies.has(name) ? { name, value: current.cookies.get(name)! } : undefined),
          set: (name: string, value: string) => void current.cookies.set(name, value),
          delete: (arg: string | { name: string }) => void current.cookies.delete(typeof arg === "string" ? arg : arg.name),
        }),
        headers: async () => new Headers({ host: "platform.example.com", ...extraHeaders }),
      },
    });
    mock.module(at("../../storage.ts"), {
      namedExports: {
        fetchBytes: async (url: string) => {
          const b = stored.get(url);
          if (!b) throw new Error("missing");
          return b;
        },
        putExactFile: async () => "mem://unused",
      },
    });
    startRoute = (await import(at("../../../app/api/connect/github/start/route.ts"))).GET;
    callbackRoute = (await import(at("../../../app/api/connect/github/callback/route.ts"))).GET;
    disconnectRoute = (await import(at("../../../app/api/connect/github/disconnect/route.ts"))).POST;
    exportRoute = (await import(at("../../../app/api/products/[slug]/github-export/route.ts"))).POST;
    ({ encodeSession, getSessionUser: getUser } = await import("@/lib/auth"));
    ({ githubExportView: viewOf } = await import("@/lib/github/view"));
  });
  after(async () => {
    await close();
    await gh.close();
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...SAVED };
  });
  beforeEach(() => {
    Object.assign(process.env, {
      GITHUB_EXPORT: "1",
      GITHUB_OAUTH_CLIENT_ID: MOCK_CLIENT_ID,
      GITHUB_OAUTH_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      CONNECTED_ACCOUNTS_KEY: Buffer.alloc(32, 7).toString("base64"),
      GITHUB_WEB_URL_LOCAL: gh.url,
      GITHUB_API_URL_LOCAL: gh.url,
      SESSION_SECRET: "test-session-secret-long-enough",
      OPEN_ACCESS: "guest",
      PLATFORM_URL: ORIGIN,
      DATABASE_URL: "postgres://unused",
    });
    delete process.env.VERCEL_ENV;
    delete process.env.GUEST_EDITS;
    extraHeaders = {};
    gh.scope = "repo";
  });

  it("with the flag off, every route is a 404 that touches nothing", async () => {
    delete process.env.GITHUB_EXPORT;
    dbTouched = 0;
    const responses = await Promise.all([
      startRoute(new Request(`${ORIGIN}/api/connect/github/start?slug=x`)),
      callbackRoute(new Request(`${ORIGIN}/api/connect/github/callback?state=x&code=y`)),
      disconnectRoute(new Request(`${ORIGIN}/api/connect/github/disconnect`, { method: "POST" })),
      exportRoute(new Request(`${ORIGIN}/api/products/x/github-export`, { method: "POST", body: "{}" }), { params: Promise.resolve({ slug: "x" }) }),
    ]);
    assert.deepEqual(responses.map((r) => r.status), [404, 404, 404, 404]);
    assert.equal(dbTouched, 0);
  });

  it("without the OAuth app, says so and doesn't try", async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    const start = await startRoute(new Request(`${ORIGIN}/api/connect/github/start?slug=demo`));
    assert.equal(start.headers.get("location"), "/p/demo/code?github=off");
    const p = await product(await guestId());
    const res = await push(new Browser(), p.slug, { action: "create", name: "x" });
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as { message: string }).message, /Download the source/);
    assert.equal((await viewOf({ id: "u", email: "e", isAdmin: false }, p.id, [])).state, "not_set_up");
  });

  it("a guest can't reach another guest's connection, token or repo", async () => {
    const owner = await guestId();
    const p = await product(owner);
    const alice = new Browser();
    const bob = new Browser();
    assert.equal((await connect(alice, "alice-made-up", p.slug)).headers.get("location"), `/p/${p.slug}/code?github=connected`);
    const aliceToken = [...gh.tokens].find(([, l]) => l === "alice-made-up")![0];

    // Bob is the same user row and has no cookie: nothing to see and nothing to use.
    on(bob);
    const bobUser = (await getUser())!;
    on(alice);
    const aliceUser = (await getUser())!;
    assert.equal(bobUser.id, aliceUser.id, "they really are one account");
    on(bob);
    assert.equal((await viewOf(bobUser, p.id, [])).state, "connect");
    assert.equal((await push(bob, p.slug, { action: "create", name: "bobs-try" })).status, 409);
    assert.equal(((await (await push(bob, p.slug, { action: "push" })).json()) as { error: string }).error, "not_connected");
    assert.equal(gh.repoPath("alice-made-up/bobs-try") && (await fetch(`${gh.url}/repos/alice-made-up/bobs-try`, { headers: { authorization: `Bearer ${aliceToken}` } })).status, 404);

    // Alice exports. Bob with a binding of his own still doesn't see it, and a push from him doesn't touch it.
    const made = await push(alice, p.slug, { action: "create", name: "alices-repo" });
    assert.equal(made.status, 200);
    const text = JSON.stringify(await made.json());
    assert.ok(!text.includes(aliceToken));
    assert.match(text, /"isPrivate":true/);

    const used = gh.gitTokens.length;
    assert.equal((await connect(bob, "bob-made-up", p.slug)).status, 302);
    assert.equal(((await (await push(bob, p.slug, { action: "push" })).json()) as { error: string }).error, "not_exported", "Bob has no export, whatever Alice has");
    const bobView = await (on(bob), viewOf(bobUser, p.id, []));
    assert.ok(bobView.state === "connected" && bobView.login === "bob-made-up" && bobView.exported === null);
    assert.equal((await push(bob, p.slug, { action: "create", name: "bobs-repo" })).status, 200);
    const bobToken = [...gh.tokens].find(([, l]) => l === "bob-made-up")![0];
    assert.ok(gh.gitTokens.slice(used).every((t) => t === bobToken), "Bob's pushes used only Bob's token");
    assert.equal(git(bare("alice-made-up/alices-repo"), "rev-list", "--count", "main").trim(), "1");

    // Bob disconnecting ends Bob's. Alice's still works.
    on(bob);
    assert.equal(((await (await disconnectRoute(new Request(`${ORIGIN}/x`, { method: "POST" }))).json()) as { disconnected: boolean }).disconnected, true);
    on(alice);
    const aliceAfter = await viewOf(aliceUser, p.id, []);
    assert.ok(aliceAfter.state === "connected" && aliceAfter.login === "alice-made-up");
  });

  it("a guest's cookie is random, not derived, and a made-up one finds nothing", async () => {
    const p = await product(await guestId());
    const alice = new Browser();
    await connect(alice, "cookie-alice", p.slug);
    const value = alice.cookies.get("mm_connect")!;
    assert.match(value, /^[A-Za-z0-9_-]{43}$/);
    const rows = await testDb.select().from(realSchema.connectedAccounts);
    assert.ok(rows.every((r) => r.ownerKey !== value), "only its hash is stored");
    const forger = new Browser();
    forger.cookies.set("mm_connect", "A".repeat(43));
    assert.equal(((await (await push(forger, p.slug, { action: "push" })).json()) as { error: string }).error, "not_connected");
    const bad = new Browser();
    bad.cookies.set("mm_connect", "not-a-valid-value");
    assert.equal((await push(bad, p.slug, { action: "push" })).status, 409);
  });

  it("the token is sealed, and a row moved to another owner doesn't open", async () => {
    const p = await product(await guestId());
    const alice = new Browser();
    await connect(alice, "seal-alice", p.slug);
    const token = [...gh.tokens].find(([, l]) => l === "seal-alice")![0];
    const [row] = await testDb.select().from(realSchema.connectedAccounts).where(eq(realSchema.connectedAccounts.externalLogin, "seal-alice"));
    assert.ok(!row!.ciphertext.toString("latin1").includes(token));
    const mallory = new Browser();
    await connect(mallory, "seal-mallory", p.slug);
    const [theirs] = await testDb.select().from(realSchema.connectedAccounts).where(eq(realSchema.connectedAccounts.externalLogin, "seal-mallory"));
    // A database writer copies Alice's sealed token onto Mallory's row, keeping Mallory's outside id.
    await testDb.update(realSchema.connectedAccounts).set({ ciphertext: row!.ciphertext, iv: row!.iv, tag: row!.tag }).where(eq(realSchema.connectedAccounts.id, theirs!.id));
    assert.equal(((await (await push(mallory, p.slug, { action: "create", name: "stolen" })).json()) as { error: string }).error, "not_connected");
  });

  it("the state is checked: missing, tampered, and another browser's are all refused", async () => {
    const before = gh.tokens.size;
    const alice = on(new Browser());
    const start = await startRoute(new Request(`${ORIGIN}/api/connect/github/start?slug=demo`));
    const authorize = new URL(start.headers.get("location")!);
    assert.equal(authorize.searchParams.get("scope"), "repo");
    assert.equal(authorize.searchParams.get("redirect_uri"), `${ORIGIN}/api/connect/github/callback`);
    const state = authorize.searchParams.get("state")!;
    const cb = (s: string) => new Request(`${ORIGIN}/api/connect/github/callback?state=${s}&code=abc`);
    assert.equal((await callbackRoute(cb("wrong"))).status, 400);
    const other = on(new Browser());
    assert.equal((await callbackRoute(cb(state))).status, 400, "another browser has no state cookie");
    // Alice's signed state cookie, carried to a browser with a different binding, still doesn't finish.
    other.cookies.set("mm_github_state", alice.cookies.get("mm_github_state") ?? "");
    other.cookies.set("mm_connect", "B".repeat(43));
    assert.equal((await callbackRoute(cb(state))).status, 400);
    assert.equal(gh.tokens.size, before, "no code was ever exchanged");
    on(alice);
    alice.cookies.set("mm_github_state", `${alice.cookies.get("mm_github_state")}x`);
    assert.equal((await callbackRoute(cb(state))).status, 400, "a changed cookie fails its signature");
  });

  it("a state only works once, and a declined request connects nothing", async () => {
    const b = on(new Browser());
    const start = await startRoute(new Request(`${ORIGIN}/api/connect/github/start?slug=demo`));
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const declined = await callbackRoute(new Request(`${ORIGIN}/cb?state=${state}&error=access_denied`));
    assert.equal(declined.headers.get("location"), "/p/demo/code?github=denied");
    assert.equal(b.cookies.has("mm_github_state"), false);
    assert.equal((await callbackRoute(new Request(`${ORIGIN}/cb?state=${state}&code=abc`))).status, 400);
  });

  it("refuses a grant without repo scope, and ends it", async () => {
    gh.scope = "read:user";
    const b = new Browser();
    const res = await connect(b, "no-scope", "demo");
    assert.equal(res.headers.get("location"), "/p/demo/code?github=scope");
    assert.ok(![...gh.tokens.values()].includes("no-scope"));
  });

  it("only someone who may read the code can export it", async () => {
    const owner = await guestId();
    const closed = await product(owner, false);
    const guest = new Browser();
    await connect(guest, "reader-guest", closed.slug);
    assert.equal((await push(guest, closed.slug, { action: "create", name: "nope" })).status, 404);

    const [other] = await testDb.insert(realSchema.users).values({ email: "other@example.com" }).returning();
    const signedIn = new Browser();
    signedIn.cookies.set("mm_session", encodeSession({ id: other!.id, email: other!.email, isAdmin: false }));
    await connect(signedIn, "reader-signed-in", closed.slug);
    assert.equal((await push(signedIn, closed.slug, { action: "create", name: "nope2" })).status, 404);

    // The real owner, signed in, can, and it's bound to the account, with no browser cookie.
    const mine = await product(other!.id, false);
    assert.equal(signedIn.cookies.has("mm_connect"), false);
    assert.equal((await push(signedIn, mine.slug, { action: "create", name: "mine" })).status, 200);

    const open = await product(owner);
    await testDb.update(realSchema.products).set({ takenDownAt: new Date() }).where(eq(realSchema.products.id, open.id));
    assert.equal((await push(guest, open.slug, { action: "create", name: "taken" })).status, 404);
  });

  it("refuses another site's request", async () => {
    const p = await product(await guestId());
    extraHeaders = { "sec-fetch-site": "cross-site" };
    const req = (url: string, init?: RequestInit) => new Request(url, { ...init, headers: extraHeaders });
    assert.equal((await startRoute(req(`${ORIGIN}/api/connect/github/start?slug=demo`))).status, 403);
    assert.equal((await disconnectRoute(req(`${ORIGIN}/x`, { method: "POST" }))).status, 403);
    assert.equal((await exportRoute(req(`${ORIGIN}/x`, { method: "POST", body: "{}" }), { params: Promise.resolve({ slug: p.slug }) })).status, 403);
  });

  it("exports history, then pushes new versions, and is private unless asked", async () => {
    const owner = await guestId();
    const p = await product(owner);
    await addVersion(p.id, owner, p.inspirationId, "Add a title", "refine", [save("README.md", "# two\n"), save("app/page.tsx", "one\n")], new Date(Date.UTC(2026, 10, 2)));
    const b = new Browser();
    await connect(b, "flow-user", p.slug);
    assert.equal(((await (await push(b, p.slug, { action: "create", name: "bad/name" })).json()) as { error: string }).error, "bad_name");
    const first = (await (await push(b, p.slug, { action: "create", name: "flow" })).json()) as Record<string, unknown>;
    assert.equal(first.pushed, 2);
    assert.equal(first.lastVersion, 2);
    assert.equal(first.isPrivate, true);
    const repo = bare("flow-user/flow");
    assert.deepEqual(git(repo, "log", "--reverse", "--format=%s", "main").trim().split("\n"), ["Version 1: First build", "Version 2: Add a title"]);
    git(repo, "fsck", "--strict", "--full");

    assert.equal(((await (await push(b, p.slug, { action: "create", name: "flow2" })).json()) as { error: string }).error, "already_exported");
    assert.equal(((await (await push(b, p.slug, { action: "push" })).json()) as { upToDate: boolean }).upToDate, true);

    await addVersion(p.id, owner, p.inspirationId, "Third change", "refine", [save("README.md", "# three\n"), save("app/page.tsx", "one\n")], new Date(Date.UTC(2026, 10, 3)));
    on(b);
    const view = await viewOf((await getUser())!, p.id, (await import("@/lib/github/export").then((m) => m.productCommits(p.id))));
    assert.ok(view.state === "connected" && view.exported?.newVersions === 1 && view.exported.lastVersion === 2);
    const next = (await (await push(b, p.slug, { action: "push" })).json()) as Record<string, unknown>;
    assert.equal(next.pushed, 1);
    assert.equal(git(repo, "rev-list", "--count", "main").trim(), "3");
    assert.equal(git(repo, "show", "main:README.md"), "# three\n");
    git(repo, "fsck", "--strict", "--full");
  });

  it("a build still running isn't pushed", async () => {
    const owner = await guestId();
    const p = await product(owner);
    const [running] = await testDb.insert(realSchema.builds).values({ inspirationId: p.inspirationId, userId: owner, productId: p.id, kind: "refine", status: "deploying", message: "Not done", startedAt: new Date(Date.UTC(2026, 10, 5)) }).returning();
    await testDb.insert(realSchema.productVersions).values({ buildId: running!.id, productId: p.id, files: [save("a.txt", "half\n")], bytes: 1 });
    const b = new Browser();
    await connect(b, "running-user", p.slug);
    assert.equal(((await (await push(b, p.slug, { action: "create", name: "r" })).json()) as { pushed: number }).pushed, 1);
    assert.equal(git(bare("running-user/r"), "rev-list", "--count", "main").trim(), "1");
  });

  it("never overwrites changes made on GitHub, a taken name is refused, and a deleted repo can be exported again", async () => {
    const owner = await guestId();
    const p = await product(owner);
    const b = new Browser();
    await connect(b, "edge-user", p.slug);
    assert.equal((await push(b, p.slug, { action: "create", name: "edge" })).status, 200);
    const repo = bare("edge-user/edge");

    // Someone commits on GitHub.
    const tree = git(repo, "rev-parse", "main^{tree}").trim();
    const parent = git(repo, "rev-parse", "main").trim();
    const theirs = execFileSync("git", ["-C", repo, "-c", "user.name=x", "-c", "user.email=x@example.com", "commit-tree", tree, "-p", parent, "-m", "Mine"], { encoding: "utf8" }).trim();
    git(repo, "update-ref", "refs/heads/main", theirs);
    await addVersion(p.id, owner, p.inspirationId, "Later", "refine", [save("a.txt", "later\n")], new Date(Date.UTC(2026, 10, 7)));
    const refused = await push(b, p.slug, { action: "push" });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { error: string }).error, "repo_changed");
    assert.equal(git(repo, "rev-parse", "main").trim(), theirs);

    // A second product can't take a repo name this account has, and so can't reach that repo.
    const q = await product(owner);
    assert.equal(((await (await push(b, q.slug, { action: "create", name: "edge" })).json()) as { error: string }).error, "name_taken");
    assert.equal(git(repo, "rev-parse", "main").trim(), theirs);

    // The repo is deleted on GitHub: the person is told, and can export again.
    gh.deleteRepo("edge-user/edge");
    const gone = await push(b, p.slug, { action: "push" });
    assert.equal(gone.status, 410);
    assert.equal(((await gone.json()) as { error: string }).error, "repo_gone");
    assert.equal((await push(b, p.slug, { action: "create", name: "edge-again" })).status, 200);
    assert.equal(git(bare("edge-user/edge-again"), "rev-list", "--count", "main").trim(), "2");
  });

  it("anyone on the shared account is bound by browser, admin mode included; a real session by account", async () => {
    const { connectionOwner } = await import("@/lib/connected/owner");
    const shared = { id: "shared", email: "guest@musemuse.invalid", isAdmin: false, openAccess: true };
    assert.equal(connectionOwner(shared, undefined), null);
    assert.equal(connectionOwner({ ...shared, isAdmin: true }, undefined), null);
    assert.equal(connectionOwner(shared, "A".repeat(43))?.kind, "browser");
    assert.notEqual(connectionOwner(shared, "A".repeat(43))?.key, connectionOwner(shared, "B".repeat(43))?.key);
    assert.deepEqual(connectionOwner({ id: "u1", email: "a@b.co", isAdmin: false }, "A".repeat(43)), { kind: "user", key: "u1" });
  });

  it("disconnect destroys the sealed token and ends GitHub's grant; a token GitHub dropped asks to reconnect", async () => {
    const owner = await guestId();
    const p = await product(owner);
    const b = new Browser();
    await connect(b, "bye-user", p.slug);
    const token = [...gh.tokens].find(([, l]) => l === "bye-user")![0];
    on(b);
    const res = (await (await disconnectRoute(new Request(`${ORIGIN}/x`, { method: "POST" }))).json()) as Record<string, boolean>;
    assert.deepEqual(res, { disconnected: true, revokedOnGitHub: true });
    assert.equal(gh.tokens.has(token), false);
    const [row] = await testDb.select().from(realSchema.connectedAccounts).where(eq(realSchema.connectedAccounts.externalLogin, "bye-user"));
    assert.ok(row!.revokedAt);
    assert.equal(row!.ciphertext.length, 0);
    assert.equal(((await (await push(b, p.slug, { action: "create", name: "after" })).json()) as { error: string }).error, "not_connected");

    // Reconnecting works, and then the person revokes on GitHub's side.
    await connect(b, "bye-user", p.slug);
    assert.equal((await push(b, p.slug, { action: "create", name: "again" })).status, 200);
    const second = [...gh.tokens].find(([, l]) => l === "bye-user")![0];
    gh.tokens.delete(second);
    await addVersion(p.id, owner, p.inspirationId, "Later", "refine", [save("b.txt", "later\n")], new Date(Date.UTC(2026, 10, 8)));
    assert.equal(((await (await push(b, p.slug, { action: "push" })).json()) as { error: string }).error, "reconnect");
    on(b);
    assert.equal((await viewOf((await getUser())!, p.id, [])).state, "connect");
  });

  it("a push to a different GitHub account's repo is refused", async () => {
    const p = await product(await guestId());
    const b = new Browser();
    await connect(b, "first-account", p.slug);
    assert.equal((await push(b, p.slug, { action: "create", name: "acct" })).status, 200);
    await connect(b, "second-account", p.slug);
    assert.equal(((await (await push(b, p.slug, { action: "push" })).json()) as { error: string }).error, "wrong_account");
  });

  it("a deployed site can't be pointed at another GitHub", async () => {
    const { githubConfig } = await import("@/lib/github/api");
    assert.equal(githubConfig()!.apiUrl, gh.url);
    process.env.VERCEL_ENV = "preview";
    assert.equal(githubConfig()!.apiUrl, "https://api.github.com");
    delete process.env.VERCEL_ENV;
    process.env.GITHUB_API_URL_LOCAL = "https://evil.example.com";
    assert.equal(githubConfig()!.apiUrl, "https://api.github.com");
  });
});
