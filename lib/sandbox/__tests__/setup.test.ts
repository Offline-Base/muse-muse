/**
 * Unit tests for the snapshot's Muse Code skill check and font install in lib/sandbox/setup.ts.
 *   npx tsx --test lib/sandbox/__tests__/setup.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { MUSE_APP_OVERLAY } from "@/lib/sandbox/look";
import { TARGET_OVERLAYS } from "@/lib/sandbox/paths";
import { DEMO_FONT_PACKAGES, DISABLED_BUNDLED_SKILLS, fontInstallScript, INTER_DEFAULT_CONF, readTargetFiles, readTemplateFiles, skillsNotOff, templateHash } from "@/lib/sandbox/setup";

describe("the template's targets", () => {
  function tree(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), "template-"));
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), content);
    }
    return dir;
  }

  it("stay out of a product, in the real template too", async () => {
    const files = await readTemplateFiles("template");
    assert.ok(files.some((f) => f.path === "package.json"));
    assert.deepEqual(files.filter((f) => f.path.startsWith("targets/") || f.path.includes("/glasses/")), []);
  });

  it("are read on their own, for the snapshot", async () => {
    const files = await readTargetFiles("template");
    assert.ok(files.some((f) => f.path === "targets/glasses/platform-files.json"));
    assert.ok(files.every((f) => f.path.startsWith("targets/")));
    // Every brief target's overlay and the muse-app look go into the snapshot, and so into its hash.
    for (const t of [...TARGET_OVERLAYS, MUSE_APP_OVERLAY]) assert.ok(files.some((f) => f.path === `targets/${t}/deps.json`), t);
    assert.ok(files.some((f) => f.path === "targets/muse-app/files/app/muse-app.css"));
  });

  it("only means the top-level folder, and is fine when there are none", async (t) => {
    const dir = tree({ "lib/targets/a.ts": "a", "app.ts": "b" });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.deepEqual((await readTemplateFiles(dir)).map((f) => f.path), ["app.ts", "lib/targets/a.ts"]);
    assert.deepEqual(await readTargetFiles(dir), []);
  });

  it("change the template's hash when they change", async (t) => {
    const before = tree({ "app.ts": "b", "targets/glasses/deps.json": "{}" });
    const after = tree({ "app.ts": "b", "targets/glasses/deps.json": '{"x":"1"}' });
    t.after(() => [before, after].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
    const hash = async (dir: string) => templateHash([...(await readTemplateFiles(dir)), ...(await readTargetFiles(dir))]);
    assert.equal(templateHash(await readTemplateFiles(before)), templateHash(await readTemplateFiles(after)));
    assert.notEqual(await hash(before), await hash(after));
  });
});

/** The shape of `muse skills list --json` (Muse Code 1.4.14). */
function list(activation: (id: string) => string, extra: Array<{ id: string; activation: string }> = []): string {
  const skills = DISABLED_BUNDLED_SKILLS.map((id) => ({ id: `bundled:${id}`, activation: activation(id), scope: "bundled" }));
  return JSON.stringify({ diagnostics: [], skills: [...skills, ...extra] });
}

describe("skillsNotOff", () => {
  it("passes when every skill the snapshot turns off is off", () => {
    const kept = [
      { id: "bundled:taste", activation: "on" },
      { id: "verify", activation: "on" },
    ];
    assert.deepEqual(skillsNotOff(list(() => "off", kept)), []);
  });

  it("names skills that are still on or only limited to explicit use", () => {
    const out = skillsNotOff(list((id) => (id === "plan" ? "user-invocable-only" : id === "web3d" ? "on" : "off")));
    assert.deepEqual(out, ["web3d", "plan"]);
  });

  it("counts a skill Muse Code no longer lists, or output that isn't JSON, as not off", () => {
    const missing = JSON.parse(list(() => "off")) as { skills: Array<{ id: string }> };
    missing.skills = missing.skills.filter((s) => s.id !== "bundled:browser-game");
    assert.deepEqual(skillsNotOff(JSON.stringify(missing)), ["browser-game"]);
    assert.deepEqual(skillsNotOff("muse: not json"), [...DISABLED_BUNDLED_SKILLS]);
  });
});

describe("fontInstallScript", () => {
  /**
   * Runs the script with stand-ins for apt-get (logs each call, and fails any that asks for a package in `missing`),
   * fc-list (lists Inter unless it is missing) and fc-cache (logs, and fails when `cacheFails`), with the fontconfig
   * file in a temp dir. Returns the exit code, stdout, the calls in order and the fontconfig file, if one was written.
   */
  function run(missing: string[], cacheFails = false) {
    const dir = mkdtempSync(path.join(tmpdir(), "musemuse-fonts-"));
    try {
      const calls = path.join(dir, "calls");
      const conf = path.join(dir, "local.conf");
      writeFileSync(
        path.join(dir, "apt-get"),
        `#!/bin/bash\necho "apt-get $*" >> ${JSON.stringify(calls)}\nfor a in "$@"; do case " ${missing.join(" ")} " in *" $a "*) exit 100 ;; esac; done\nexit 0\n`,
        { mode: 0o755 },
      );
      const families = ["DejaVu Sans", ...(missing.includes("fonts-inter") ? [] : ["Inter,Inter Display"])];
      writeFileSync(path.join(dir, "fc-list"), `#!/bin/bash\nprintf '%s\\n' ${families.map((f) => JSON.stringify(f)).join(" ")}\n`, { mode: 0o755 });
      writeFileSync(path.join(dir, "fc-cache"), `#!/bin/bash\necho "fc-cache $*" >> ${JSON.stringify(calls)}\nexit ${cacheFails ? 1 : 0}\n`, { mode: 0o755 });
      const res = spawnSync("bash", ["-c", fontInstallScript(conf)], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
      let written: string | null = null;
      try {
        written = readFileSync(conf, "utf8");
      } catch {
        // not written
      }
      return { code: res.status, stdout: res.stdout, calls: readFileSync(calls, "utf8").trim().split("\n"), conf: written };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("installs every font in one go, makes Inter the default sans-serif, then rebuilds the font cache", () => {
    const res = run([]);
    assert.equal(res.code, 0);
    assert.equal(res.stdout, "");
    assert.deepEqual(res.calls, [`apt-get install -y -q --no-install-recommends ${DEMO_FONT_PACKAGES.join(" ")}`, "fc-cache -f"]);
    assert.equal(res.conf, `${INTER_DEFAULT_CONF}\n`);
    for (const family of ["system-ui", "sans-serif", "sans"]) {
      assert.ok(INTER_DEFAULT_CONF.includes(`<alias><family>${family}</family><prefer><family>Inter</family></prefer></alias>`), family);
    }
  });

  it("skips a font the distro doesn't have, keeps the rest, and never fails the snapshot", () => {
    const res = run(["fonts-inter"], true);
    assert.equal(res.code, 0);
    assert.deepEqual(res.stdout.trim().split("\n"), ["skipped fonts-inter", "skipped the Inter default", "skipped fc-cache"]);
    assert.deepEqual(res.calls.slice(1, 4), DEMO_FONT_PACKAGES.map((p) => `apt-get install -y -q --no-install-recommends ${p}`));
    assert.equal(res.calls.at(-1), "fc-cache -f");
    assert.equal(res.conf, null, "no Inter, so the distro's default stays");
  });
});
