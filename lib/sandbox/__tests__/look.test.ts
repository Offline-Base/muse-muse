/**
 * lib/sandbox/look.ts: the script that applies the muse-app look, and tasks.ts installTargetsScript, which installs it
 * beside the targets, run with bash in a temp folder against this checkout's real overlay. npm is a stand-in that records
 * what it was asked.
 *
 *   npx tsx --test lib/sandbox/__tests__/look.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { applyLookScript, LOOK_COMMIT, MUSE_APP_OVERLAY, OVERLAYS_DIR } from "@/lib/sandbox/look";
import { readTargetFiles } from "@/lib/sandbox/setup";
import { installTargetsScript } from "@/lib/sandbox/tasks";

const tmp = mkdtempSync(path.join(tmpdir(), "musemuse-look-"));
after(() => {
  spawnSync("chmod", ["-R", "u+w", tmp]);
  rmSync(tmp, { recursive: true, force: true });
});

function bash(script: string, opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const res = spawnSync("bash", ["-c", script], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: "utf8" });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

let n = 0;
/** A product folder made from template/ files the overlay replaces, committed like installTemplate does, and an npm that logs. */
function product() {
  const root = path.join(tmp, `p${n++}`);
  const dir = path.join(root, "app");
  mkdirSync(path.join(dir, "app"), { recursive: true });
  for (const f of ["AGENTS.md", "app/layout.tsx", "app/globals.css", "package.json"]) cpSync(path.join("template", f), path.join(dir, f));
  writeFileSync(path.join(dir, ".gitignore"), ".env*.local\n");
  writeFileSync(path.join(dir, "package-lock.json"), "{}\n");
  const id = ["-c", "user.name=Muse Muse", "-c", "user.email=builder@musemuse.invalid"];
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", [...id, "commit", "-qm", "Template"], { cwd: dir });
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(root, "npm.log"))}\n`);
  chmodSync(path.join(bin, "npm"), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, GIT_AUTHOR_NAME: "Muse Muse", GIT_AUTHOR_EMAIL: "b@x.invalid", GIT_COMMITTER_NAME: "Muse Muse", GIT_COMMITTER_EMAIL: "b@x.invalid" };
  return { root, dir, env, npmLog: () => (existsSync(path.join(root, "npm.log")) ? readFileSync(path.join(root, "npm.log"), "utf8") : "") };
}

/** template/targets unpacked the way setup.ts installTargets writes it, then installed by installTargetsScript. */
async function overlays(owner = `${userInfo().username}:${spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim()}`): Promise<string> {
  const root = path.join(tmp, `o${n++}`);
  const from = path.join(root, "from");
  for (const f of await readTargetFiles("template")) {
    mkdirSync(path.dirname(path.join(from, f.path)), { recursive: true });
    writeFileSync(path.join(from, f.path), f.content);
  }
  const dir = path.join(root, "targets");
  const res = bash(installTargetsScript(from, dir, owner));
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!existsSync(from), "removes what it unpacked");
  return dir;
}

describe("installTargetsScript, with the look", () => {
  it("installs every overlay read-only, in the shape provisioning reads", async () => {
    const dir = await overlays();
    assert.ok(existsSync(path.join(dir, MUSE_APP_OVERLAY, "deps.json")));
    assert.ok(existsSync(path.join(dir, MUSE_APP_OVERLAY, "files/.agents/skills/muse-app-ui/SKILL.md")));
    assert.ok(existsSync(path.join(dir, "glasses", "deps.json")), "the other overlays too");
    assert.throws(() => writeFileSync(path.join(dir, MUSE_APP_OVERLAY, "deps.json"), "{}"), /EACCES|EPERM/);
  });

  it("is owned by root in a sandbox, under the work folder", () => {
    const script = installTargetsScript("/tmp/it's here");
    assert.match(script, /chown -R 'root:root' '\/vercel\/musemuse\/targets'/);
    assert.match(script, /'\/tmp\/it'\\''s here'\/targets\/\*/);
    assert.equal(OVERLAYS_DIR, "/vercel/musemuse/targets");
    assert.equal(spawnSync("bash", ["-n", "-c", script]).status, 0);
    assert.equal(spawnSync("bash", ["-n", "-c", applyLookScript()]).status, 0);
  });
});

describe("applyLookScript", () => {
  it("copies the overlay over the template, installs nothing, and commits only those files", async () => {
    const dir = await overlays();
    const p = product();
    writeFileSync(path.join(p.dir, "brief.md"), "# Not the overlay's\n");
    const res = bash(applyLookScript(dir), { cwd: p.dir, env: p.env });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(git(p.dir, "log", "--format=%s"), `${LOOK_COMMIT}\nTemplate`);
    const committed = git(p.dir, "show", "--name-only", "--format=", "HEAD").split("\n").sort();
    assert.ok(committed.includes("app/muse-app.css") && committed.includes(".agents/skills/muse-app-ui/SKILL.md") && committed.includes("AGENTS.md"));
    assert.ok(!committed.includes("brief.md"), "leaves other files alone");
    assert.equal(git(p.dir, "status", "--porcelain"), "?? brief.md");
    const overlayFile = (f: string) => readFileSync(path.join(dir, MUSE_APP_OVERLAY, "files", f), "utf8");
    for (const f of ["AGENTS.md", "app/layout.tsx", "app/muse-app.css"]) assert.equal(readFileSync(path.join(p.dir, f), "utf8"), overlayFile(f), f);
    assert.equal(readFileSync(path.join(p.dir, "app/globals.css"), "utf8"), readFileSync("template/app/globals.css", "utf8"), "globals.css stays");
    assert.equal(p.npmLog(), "", "deps.json lists nothing");
    // The files are the build's to change.
    writeFileSync(path.join(p.dir, "app/muse-app.css"), "/* changed */\n");
  });

  it("does nothing on a retry once the look is in, so the build's changes stay", async () => {
    const dir = await overlays();
    const p = product();
    assert.equal(bash(applyLookScript(dir), { cwd: p.dir, env: p.env }).code, 0);
    writeFileSync(path.join(p.dir, "app/muse-app.css"), "/* the build's */\n");
    assert.equal(bash(applyLookScript(dir), { cwd: p.dir, env: p.env }).code, 0);
    assert.equal(readFileSync(path.join(p.dir, "app/muse-app.css"), "utf8"), "/* the build's */\n");
    assert.equal(git(p.dir, "log", "--format=%s"), `${LOOK_COMMIT}\nTemplate`);
  });

  it("fails, changing nothing, when the overlay isn't in the sandbox", () => {
    const p = product();
    const res = bash(applyLookScript(path.join(tmp, "nowhere")), { cwd: p.dir, env: p.env });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /the muse-app overlay isn't in this sandbox/);
    assert.equal(git(p.dir, "log", "--format=%s"), "Template");
    assert.equal(git(p.dir, "status", "--porcelain"), "");
  });

  it("installs listed deps at exact versions and commits the package files with the look", async () => {
    const dir = await overlays();
    const deps = path.join(dir, MUSE_APP_OVERLAY, "deps.json");
    chmodSync(path.dirname(deps), 0o755);
    chmodSync(deps, 0o644);
    writeFileSync(deps, JSON.stringify({ dependencies: { "left-pad": "1.3.0" }, devDependencies: { "@types/x": "1.0.0" } }));
    const p = product();
    const res = bash(applyLookScript(dir), { cwd: p.dir, env: p.env });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(p.npmLog().trim().split("\n"), [
      "install --save-exact --prefer-offline --no-audit --no-fund --loglevel=error left-pad@1.3.0",
      "install --save-exact --prefer-offline --no-audit --no-fund --loglevel=error --save-dev @types/x@1.0.0",
    ]);
  });
});
