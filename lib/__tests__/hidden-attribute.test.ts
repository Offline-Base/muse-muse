/**
 * The hidden attribute always hides (#92). A class that sets display beats the browser's own [hidden] rule, which once
 * left the Make page's plan a screen below a composer that was meant to be gone. One global rule in app/globals.css
 * covers every element; these checks keep it there and keep any stylesheet from bringing a hidden element back.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

describe("the hidden attribute", () => {
  it("is hidden by one global rule that no class can beat", () => {
    const css = strip(readFileSync(join(ROOT, "app/globals.css"), "utf8"));
    assert.match(css, /\[hidden\]:not\(\[hidden="until-found"\]\)\s*\{\s*display:\s*none\s*!important;\s*\}/);
  });

  it("is never shown again by a stylesheet", () => {
    for (const file of [...cssFiles(join(ROOT, "app")), ...cssFiles(join(ROOT, "components"))]) {
      const css = strip(readFileSync(file, "utf8"));
      for (const m of css.matchAll(/([^{}]*\[hidden\][^{}]*)\{([^}]*)\}/g)) {
        const display = m[2].match(/display:\s*([^;]+)/)?.[1].trim();
        if (display) assert.match(display, /^none/, `${file}: ${m[1].trim()} sets display: ${display}`);
      }
    }
  });
});
