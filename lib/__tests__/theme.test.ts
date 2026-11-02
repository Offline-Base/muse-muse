/**
 * The theme choice (lib/theme.ts): what it saves, what it sets on <html>, and the inline script that applies a saved
 * choice before first paint.
 *
 *   npx tsx --test lib/__tests__/theme.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { THEME_KEY, THEME_SCRIPT, applyTheme, readTheme } from "@/lib/theme";

function fakePage(saved: Record<string, string> = {}) {
  const store = new Map(Object.entries(saved));
  const root = { dataset: {} as Record<string, string> };
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return { store, root, globals: { localStorage, document: { documentElement: root } } };
}

describe("theme", () => {
  let page = fakePage();
  beforeEach(() => {
    page = fakePage();
    Object.assign(globalThis, page.globals);
  });

  it("reads System when nothing is saved, or something unknown is", () => {
    assert.equal(readTheme(), "system");
    page.store.set(THEME_KEY, "purple");
    assert.equal(readTheme(), "system");
  });

  it("forces Light or Dark on <html> and keeps it; System clears both", () => {
    applyTheme("dark");
    assert.equal(page.root.dataset.theme, "dark");
    assert.equal(page.store.get(THEME_KEY), "dark");
    assert.equal(readTheme(), "dark");
    applyTheme("system");
    assert.equal(page.root.dataset.theme, undefined);
    assert.equal(page.store.has(THEME_KEY), false);
  });

  it("still applies the choice when storage throws", () => {
    (globalThis as { localStorage: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    applyTheme("light");
    assert.equal(page.root.dataset.theme, "light");
    assert.equal(readTheme(), "system");
  });

  it("has an inline script that applies only a saved Light or Dark", () => {
    for (const [saved, expected] of [
      ["dark", "dark"],
      ["light", "light"],
      ["system", undefined],
      ["<img>", undefined],
    ] as const) {
      const p = fakePage({ [THEME_KEY]: saved });
      runInNewContext(THEME_SCRIPT, p.globals);
      assert.equal(p.root.dataset.theme, expected, saved);
    }
    // Blocked storage doesn't throw out of the script.
    runInNewContext(THEME_SCRIPT, { localStorage: null, document: { documentElement: { dataset: {} } } });
  });
});
