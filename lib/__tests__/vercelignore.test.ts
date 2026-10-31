/**
 * What .vercelignore keeps out of a deployment, by git's own matcher, which gave the same file count as Vercel's build log.
 * Vercel removes these before the build starts, so a line that matches too much fails every deploy: `native` also
 * matched lib/native, which lib/env.ts imports, and scripts/migrate.ts then couldn't load.
 *
 *   npx tsx --test lib/__tests__/vercelignore.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

const ignored = execFileSync("git", ["ls-files", "-ci", "--exclude-from=.vercelignore"], { encoding: "utf8", maxBuffer: 2 ** 26 })
  .split("\n")
  .filter(Boolean);

describe(".vercelignore", () => {
  it("leaves everything the build and the site need", () => {
    const needed = /^(app|catalog|components|content|drizzle|lib|public|template)\/|^scripts\/migrate\.ts$|^next\.config\.ts$|^package\.json$/;
    assert.deepEqual(ignored.filter((file) => needed.test(file)), []);
  });

  it("still keeps the native apps out", () => {
    assert.ok(ignored.includes("native/releases.json"));
    assert.ok(ignored.some((file) => file.startsWith("native/lab/")));
  });
});
