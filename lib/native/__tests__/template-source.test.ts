/**
 * What provisionStep writes into a phone or desktop product must be template-native/ as it is now. When this fails, run
 * `npx tsx scripts/gen-native-template.ts`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { nativeExtraFiles } from "@/lib/native/template-files";
import { NATIVE_TEMPLATE_FILES } from "@/lib/native/template-source";

const ROOT = path.join(import.meta.dirname, "../../..");
const SOURCE = path.join(ROOT, "template-native");

describe("the native template", () => {
  it("is template-native as it is now", () => {
    const onDisk = readdirSync(SOURCE, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name !== ".DS_Store")
      .map((e) => path.relative(SOURCE, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
      .sort();
    assert.deepEqual(NATIVE_TEMPLATE_FILES.map((f) => f.path), onDisk);
    for (const f of NATIVE_TEMPLATE_FILES) {
      assert.ok(f.content === readFileSync(path.join(SOURCE, f.path), "utf8"), `${f.path} is stale: run npx tsx scripts/gen-native-template.ts`);
    }
  });

  it("holds the bridge, PWA manifest, icons and skill", () => {
    const paths = NATIVE_TEMPLATE_FILES.map((f) => f.path);
    for (const want of ["lib/native/bridge.ts", "lib/native/protocol.ts", "app/manifest.ts", "app/icon.tsx", "app/apple-icon.tsx", ".agents/skills/muse-native/SKILL.md"]) {
      assert.ok(paths.includes(want), want);
    }
  });

  it("doesn't replace anything the template has, since the two reach a product together", () => {
    for (const f of NATIVE_TEMPLATE_FILES) {
      assert.throws(() => readFileSync(path.join(ROOT, "template", f.path)), { code: "ENOENT" }, f.path);
    }
  });

  it("has the shells' bridge types, byte for byte", () => {
    assert.ok(readFileSync(path.join(SOURCE, "lib/native/protocol.ts"), "utf8") === readFileSync(path.join(ROOT, "native/bridge/protocol.ts"), "utf8"));
  });

  it("has no em dashes in what it writes", () => {
    for (const f of NATIVE_TEMPLATE_FILES) assert.ok(!f.content.includes("—"), f.path);
  });
});

describe("nativeExtraFiles", () => {
  const web: { id: unknown } = { id: "web" };

  it("is empty unless a brief has phone or desktop", () => {
    for (const brief of [null, undefined, BRIEF, { targets: [web] }, { targets: [web, { id: "vr" }, { id: "glasses" }, { id: "agent" }] }]) {
      assert.deepEqual(nativeExtraFiles(brief), []);
    }
  });

  it("is the whole list for phone or desktop", () => {
    assert.equal(nativeExtraFiles({ targets: [web, { id: "phone" }] }).length, NATIVE_TEMPLATE_FILES.length);
    assert.equal(nativeExtraFiles({ targets: [{ id: "desktop" }] }).length, NATIVE_TEMPLATE_FILES.length);
  });
});
