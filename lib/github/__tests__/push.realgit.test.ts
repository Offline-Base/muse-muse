/**
 * The git part against real git: lib/github/git.ts and history.ts push over smart HTTP to bare repos behind `git http-backend`
 * with receive.fsckObjects on, and real git then reads the result back. Only GitHub's REST calls are pretend.
 *
 *   npx tsx --test lib/github/__tests__/push.realgit.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createRepo, type GitHubConfig } from "@/lib/github/api";
import { GitPushError, pushPack, remoteRefs, type Remote } from "@/lib/github/git";
import { buildHistory, safeTitle, TooBigToPush, type HistoryVersion } from "@/lib/github/history";
import { sha1, type VersionFile } from "@/lib/versions/policy";
import { startMockGitHub, MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, type MockGitHub } from "../../../scripts/github-mock";

const store = new Map<string, Buffer>();
const file = (p: string, text: string | Buffer): VersionFile => {
  const content = Buffer.from(text);
  store.set(sha1(content), content);
  return { path: p, sha: sha1(content), size: content.length, url: `mem://${sha1(content)}` };
};
const readFile = async (f: VersionFile) => store.get(f.sha) ?? null;
const author = { name: "made-up-user", email: "1000+made-up-user@users.noreply.github.com" };
const v = (number: number, title: string, files: VersionFile[]): HistoryVersion => ({ number, title, status: "live", at: new Date(Date.UTC(2026, 10, number, 12)), files });

describe("a real push", () => {
  let mock: MockGitHub;
  let tmp: string;
  let config: GitHubConfig;
  let token: string;

  const makeRepo = async (name: string): Promise<Remote & { bare: string }> => {
    const made = await createRepo(config, token, { name, isPrivate: true, description: "x" });
    assert.equal(made.ok, true);
    return { url: `${mock.url}/made-up-user/${name}.git`, token, bare: mock.repoPath(`made-up-user/${name}`) };
  };
  const git = (bare: string, ...args: string[]) => execFileSync("git", ["-C", bare, ...args], { encoding: "utf8" });

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "gh-push-"));
    mock = await startMockGitHub(path.join(tmp, "repos"));
    config = { webUrl: mock.url, apiUrl: mock.url, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET };
    const redirect = "http://localhost/cb";
    const res = await fetch(`${mock.url}/login/oauth/authorize?redirect_uri=${encodeURIComponent(redirect)}&state=s`, { redirect: "manual" });
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const direct = await fetch(`${mock.url}/login/oauth/access_token`, { method: "POST", body: JSON.stringify({ client_id: MOCK_CLIENT_ID, client_secret: MOCK_CLIENT_SECRET, code, redirect_uri: redirect }) });
    token = ((await direct.json()) as { access_token: string }).access_token;
  });
  after(async () => {
    await mock.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("pushes every version as a commit, passes fsck, and a clone holds the exact files", async () => {
    const remote = await makeRepo("first");
    const binary = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]);
    const versions = [
      v(1, "First build", [file("README.md", "# one\n"), file("app/page.tsx", "one\n"), file("app-extra.ts", "sorts between\n"), file("app.ts", "and around\n"), file("public/x.bin", binary)]),
      v(2, "Add a title", [file("README.md", "# two\n"), file("app/page.tsx", "one\n"), file("app-extra.ts", "sorts between\n"), file("app.ts", "and around\n"), file("public/x.bin", binary), file("deep/er/still/n.txt", "n\n")]),
      v(3, "Remove the extra", [file("README.md", "# two\n"), file("app/page.tsx", "three\n")]),
    ];
    const history = await buildHistory({ versions, parent: null, author, readFile });
    const before = await remoteRefs(remote);
    assert.equal(before.refs.size, 0);
    assert.ok(before.caps.has("report-status"));
    await pushPack(remote, { ref: "refs/heads/main", oldId: null, newId: history.head, objects: history.objects });

    assert.equal(git(remote.bare, "rev-parse", "main").trim(), history.head);
    git(remote.bare, "fsck", "--strict", "--full");
    assert.deepEqual(git(remote.bare, "log", "--reverse", "--format=%s", "main").trim().split("\n"), ["Version 1: First build", "Version 2: Add a title", "Version 3: Remove the extra"]);
    assert.equal(git(remote.bare, "log", "-1", "--format=%an <%ae>|%cn|%cI", "main").trim(), "made-up-user <1000+made-up-user@users.noreply.github.com>|Muse Muse|2026-11-03T12:00:00Z");

    const clone = path.join(tmp, "clone");
    execFileSync("git", ["clone", "-q", remote.bare, clone]);
    assert.equal(readFileSync(path.join(clone, "app/page.tsx"), "utf8"), "three\n");
    assert.equal(git(clone, "ls-files").trim().split("\n").length, 2, "version 3 removed the others");
    git(clone, "checkout", "-q", "HEAD~1");
    assert.deepEqual(readFileSync(path.join(clone, "public/x.bin")), binary);
    assert.equal(readFileSync(path.join(clone, "deep/er/still/n.txt"), "utf8"), "n\n");
  });

  it("pushes a new version on top, sending only what's new", async () => {
    const remote = await makeRepo("second");
    const one = v(1, "First build", [file("a.txt", "a\n"), file("big.txt", "unchanged ".repeat(1000))]);
    const first = await buildHistory({ versions: [one], parent: null, author, readFile });
    await pushPack(remote, { ref: "refs/heads/main", oldId: null, newId: first.head, objects: first.objects });

    const two = v(2, "Change a", [file("a.txt", "b\n"), one.files[1]!]);
    const next = await buildHistory({ versions: [two], parent: first.head, previous: one, author, readFile });
    assert.equal(next.objects.filter((o) => o.type === "blob").length, 1, "the unchanged file isn't sent again");
    await pushPack(remote, { ref: "refs/heads/main", oldId: first.head, newId: next.head, objects: next.objects });

    assert.equal(git(remote.bare, "rev-parse", "main").trim(), next.head);
    assert.equal(git(remote.bare, "rev-list", "--count", "main").trim(), "2");
    git(remote.bare, "fsck", "--strict", "--full");
    assert.equal(git(remote.bare, "show", "main:a.txt"), "b\n");
    assert.equal(git(remote.bare, "show", "main:big.txt"), "unchanged ".repeat(1000));
  });

  it("a stale push is refused and leaves the branch alone", async () => {
    const remote = await makeRepo("third");
    const first = await buildHistory({ versions: [v(1, "One", [file("a.txt", "1\n")])], parent: null, author, readFile });
    await pushPack(remote, { ref: "refs/heads/main", oldId: null, newId: first.head, objects: first.objects });
    const second = await buildHistory({ versions: [v(2, "Two", [file("a.txt", "2\n")])], parent: first.head, author, readFile });
    await pushPack(remote, { ref: "refs/heads/main", oldId: first.head, newId: second.head, objects: second.objects });
    const stale = await buildHistory({ versions: [v(2, "Other", [file("a.txt", "3\n")])], parent: first.head, author, readFile });
    await assert.rejects(pushPack(remote, { ref: "refs/heads/main", oldId: first.head, newId: stale.head, objects: stale.objects }), (e: GitPushError) => e.kind === "rejected");
    assert.equal(git(remote.bare, "rev-parse", "main").trim(), second.head);
  });

  it("the same versions make the same commit, so a retry can tell a push already landed", async () => {
    const versions = [v(1, "One", [file("a.txt", "1\n")]), v(2, "Two", [file("a.txt", "2\n")])];
    const a = await buildHistory({ versions, parent: null, author, readFile });
    const b = await buildHistory({ versions, parent: null, author, readFile });
    assert.equal(a.head, b.head);
  });

  it("a bad token gets nothing, and no error carries a token", async () => {
    const remote = await makeRepo("fourth");
    await assert.rejects(remoteRefs({ ...remote, token: "gho_notreal" }), (e: GitPushError) => e.kind === "auth" && !e.message.includes("gho_"));
    await assert.rejects(remoteRefs({ ...remote, url: `${mock.url}/made-up-user/absent.git` }), (e: GitPushError) => e.kind === "not_found");
  });

  it("leaves out held files, secret-shaped files, .git paths and too-big files, and says so", async () => {
    const remote = await makeRepo("fifth");
    const held: VersionFile = { path: "config.ts", sha: "a".repeat(40), size: 10, held: true };
    const nowSecret = file("late.ts", "looks fine at save");
    const big: VersionFile = { path: "huge.bin", sha: "b".repeat(40), size: 60 * 1024 * 1024, url: "mem://b" };
    const history = await buildHistory({
      versions: [v(1, "One", [file("ok.txt", "ok\n"), held, nowSecret, big, file(".GIT/config", "x"), file(".env", "A=1"), file("sub/.git/x", "y")])],
      parent: null,
      author,
      readFile: async (f) => (f.path === "late.ts" ? null : readFile(f)),
    });
    await pushPack(remote, { ref: "refs/heads/main", oldId: null, newId: history.head, objects: history.objects });
    assert.equal(git(remote.bare, "ls-tree", "-r", "--name-only", "main").trim(), "ok.txt");
    const body = git(remote.bare, "log", "-1", "--format=%b", "main");
    assert.match(body, /config\.ts \(looks like it holds a secret\)/);
    assert.match(body, /late\.ts \(looks like it holds a secret\)/);
    assert.match(body, /huge\.bin \(too big for a repo\)/);
    assert.ok(!body.includes(".env"));
  });

  it("keeps the newest versions that fit and names how many didn't", async () => {
    const versions = [v(1, "One", [file("a.bin", "x".repeat(600))]), v(2, "Two", [file("a.bin", "y".repeat(600))]), v(3, "Three", [file("a.bin", "z".repeat(600))])];
    const history = await buildHistory({ versions, parent: null, author, readFile, maxBytes: 1300 });
    assert.equal(history.skipped, 1);
    assert.equal(history.lastNumber, 3);
    assert.equal(history.objects.filter((o) => o.type === "commit").length, 2);
    await assert.rejects(buildHistory({ versions: versions.slice(0, 1), parent: null, author, readFile, maxBytes: 100 }), TooBigToPush);
  });

  it("a change request holding a key shape isn't copied into a commit title", () => {
    assert.equal(safeTitle("use ghp_abcdefghijklmnopqrstuvwxyz0123456789 here"), "Change");
    assert.equal(safeTitle("Add a\n  title"), "Add a title");
  });
});
