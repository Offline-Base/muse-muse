/**
 * The old /media page sends anyone who still has the link to /gallery, before reading anything.
 *
 *   npx tsx --test --experimental-test-module-mocks components/gallery/__tests__/media-redirect.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

const canMock = typeof (mock as { module?: unknown }).module === "function";

describe("/media", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  it("redirects to /gallery", async () => {
    const to: string[] = [];
    mock.module("next/navigation", {
      namedExports: {
        redirect: (path: string) => {
          to.push(path);
          throw new Error(`redirect ${path}`);
        },
      },
    });
    const { default: MediaPage } = await import("@/app/media/page");
    assert.throws(() => MediaPage(), /redirect \/gallery/);
    assert.deepEqual(to, ["/gallery"]);
  });
});
