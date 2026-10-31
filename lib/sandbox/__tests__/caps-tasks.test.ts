/**
 * The cap overlay scripts (docs/CAPABILITIES.md, 2.5) in real bash with temp dirs: applying the core overlay to a product
 * commits "Caps: ..." once, the restore before verify puts platform files and musemuse.caps.json back, and a sandbox with
 * no caps is left alone. Also: template/caps never reaches a product as it is.
 *
 *   npx tsx --test lib/sandbox/__tests__/caps-tasks.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { readCapFiles, readTemplateFiles } from "@/lib/sandbox/setup";
import { applyCapsScript, capsFileText, restoreCapFilesScript, taskScript } from "@/lib/sandbox/tasks";

const TEMPLATE = path.join(import.meta.dirname, "../../../template");
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function bash(script: string, cwd: string) {
  const res = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8" });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** A product with one commit, and a caps dir holding a copy of template/caps. */
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "mm-caps-tasks-"));
  dirs.push(root);
  const product = path.join(root, "app");
  const capsDir = path.join(root, "caps");
  mkdirSync(product);
  cpSync(path.join(TEMPLATE, "caps"), capsDir, { recursive: true });
  writeFileSync(path.join(product, "README.md"), "product\n");
  const git = (args: string) => bash(`git -c user.name=t -c user.email=t@t.invalid ${args}`, product);
  git("init -q");
  git("add -A");
  git("commit -qm Template");
  return { product, capsDir, git };
}

const FILE = { caps: ["data"], overlays: ["core"] };

describe("cap overlay scripts", () => {
  it("applies the core overlay: its files, musemuse.caps.json and one commit, and a retry does nothing", () => {
    const { product, capsDir, git } = setup();
    const env = `export HOME=${JSON.stringify(product)} GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.invalid; `;
    const first = bash(env + applyCapsScript(FILE, capsDir), product);
    assert.equal(first.code, 0, first.stderr);
    for (const f of ["scripts/caps-check.mjs", "tests/caps/index.ts", "app/api/musemuse/health/route.ts", ".agents/skills/muse-caps/SKILL.md"]) {
      assert.ok(existsSync(path.join(product, f)), f);
    }
    assert.equal(readFileSync(path.join(product, "musemuse.caps.json"), "utf8"), capsFileText(FILE));
    assert.equal(git("log --format=%s").stdout.trim().split("\n")[0], "Caps: data");
    const again = bash(env + applyCapsScript(FILE, capsDir), product);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(git("log --format=%s").stdout.trim().split("\n").length, 2, "no second commit");
  });

  it("stops when an overlay isn't in the sandbox", () => {
    const { product, capsDir } = setup();
    const res = bash(applyCapsScript({ caps: ["data"], overlays: ["core", "data"] }, capsDir), product);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /the data cap overlay isn't in this sandbox/);
  });

  it("puts platform files and musemuse.caps.json back before verify, so an edit can't fake a pass", () => {
    const { product, capsDir } = setup();
    writeFileSync(path.join(capsDir, "active.json"), capsFileText(FILE));
    mkdirSync(path.join(product, "scripts"), { recursive: true });
    writeFileSync(path.join(product, "scripts/caps-check.mjs"), "process.exit(0)\n");
    writeFileSync(path.join(product, "musemuse.caps.json"), JSON.stringify({ caps: [], overlays: [] }));
    const res = bash(restoreCapFilesScript(capsDir), product);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(readFileSync(path.join(product, "scripts/caps-check.mjs"), "utf8"), readFileSync(path.join(capsDir, "core/files/scripts/caps-check.mjs"), "utf8"));
    assert.equal(readFileSync(path.join(product, "musemuse.caps.json"), "utf8"), capsFileText(FILE));
    assert.ok(existsSync(path.join(product, "tests/caps/index.ts")), "a deleted platform file comes back too");
  });

  it("does nothing in a sandbox with no caps, which is every product today", () => {
    const { product, capsDir } = setup();
    writeFileSync(path.join(product, "musemuse.json"), "{}");
    const res = bash(restoreCapFilesScript(capsDir), product);
    assert.equal(res.code, 0);
    assert.equal(res.stdout + res.stderr, "");
    assert.ok(!existsSync(path.join(product, "musemuse.caps.json")));
    // The task scripts carry the restore, guarded the same way.
    assert.ok(taskScript("verify", "/tmp/out.txt").includes("/vercel/musemuse/caps/active.json"));
  });
});

describe("template/caps", () => {
  it("is never part of the template a product gets, and is read on its own", async () => {
    const files = await readTemplateFiles(TEMPLATE);
    assert.ok(!files.some((f) => f.path.startsWith("caps/")), "no overlay file in a product's template");
    const caps = await readCapFiles(TEMPLATE);
    assert.ok(caps.some((f) => f.path === "caps/core/deps.json"));
    assert.ok(caps.every((f) => f.path.startsWith("caps/")));
  });
});
