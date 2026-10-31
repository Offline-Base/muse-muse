/**
 * The links into the phone shell agree with the shell's own files, which can't be read at run time on Vercel.
 *   npx tsx --test lib/native/__tests__/shell-links.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { EAS_PROJECT_ID, SHELL_UPDATE_PUBLISHED, appLink, expoGoLink } from "@/lib/native/shell-links";
import { parseDeepLink } from "../../../native/shell-mobile/src/launch";

const releases = JSON.parse(readFileSync(path.join(process.cwd(), "native/releases.json"), "utf8")) as { eas: { projectId: string }; productionUpdate: unknown };

describe("links into the phone shell", () => {
  it("uses the EAS project in native/releases.json", () => {
    assert.equal(EAS_PROJECT_ID, releases.eas.projectId);
  });

  it("says the update is published only when it is", () => {
    assert.equal(SHELL_UPDATE_PUBLISHED, releases.productionUpdate !== null);
  });

  it("gives links the shell's own parser reads as this product", () => {
    assert.deepEqual(parseDeepLink(appLink("bird-count")), { slug: "bird-count" });
    assert.deepEqual(parseDeepLink(expoGoLink("bird-count")), { slug: "bird-count" });
  });
});
