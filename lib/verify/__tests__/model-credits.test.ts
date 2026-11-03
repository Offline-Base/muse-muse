/**
 * The model-credits check (lib/verify/model-credits.ts): credits found in a product's UI source, held up against the
 * gateway's record of what the build's tests called. Includes the audit's fridge case (a SAM 3.1 chip on a product that
 * only called a vision model), the real scan script on a temporary product folder, and the template's own files.
 *
 *   npx tsx --test lib/verify/__tests__/model-credits.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  CREDIT_SCAN_SCRIPT,
  CREDITS_STEP,
  creditProblems,
  creditsInSource,
  isUiSource,
  parseCreditScan,
  withModelCredits,
  withoutComments,
  type ServedModels,
} from "@/lib/verify/model-credits";
import type { VerifySummary } from "@/lib/types";

const CONTRIBUTOR = "muse-spark-1.3-contributor";
const SWITCH: ServedModels = { called: [CONTRIBUTOR], wonderServedBy: CONTRIBUTOR };
const PASSED: VerifySummary = { passed: true, steps: [{ name: "smoke", ok: true }], failureOutput: "" };

const FRIDGE = `"use client";
import { ModelChip } from "@/components/ModelChip";
export function Result({ items }: { items: Item[] }) {
  return (
    <section className="card ai">
      <div className="card-head"><h2>Your fridge</h2><ModelChip model="sam-3.1" verb="Outlined" /></div>
      <p>Scores by health.</p>
    </section>
  );
}`;

describe("finding credits", () => {
  it("finds a ModelChip's model and a plain-text credit", () => {
    const credits = creditsInSource([
      { file: "app/page.tsx", text: FRIDGE },
      { file: "components/Card.tsx", text: `export const caption = "Rendered by Muse Image";\n<span>Read by\n  Muse Wonder</span>` },
    ]);
    assert.deepEqual(
      credits.map((c) => [c.model, c.kind, c.file]),
      [
        ["sam-3.1", "chip", "app/page.tsx"],
        ["muse-image-1.0", "text", "components/Card.tsx"],
        ["muse-wonder-1.0", "text", "components/Card.tsx"],
      ],
    );
  });

  it("reads every id in a chip's model prop, in either quote, in any attribute order", () => {
    const credits = creditsInSource([{ file: "app/x.tsx", text: `<ModelChip verb="Read" model={fast ? 'muse-wonder-1.0' : "sam-3.1"} />` }]);
    assert.deepEqual(credits.map((c) => c.model), ["muse-wonder-1.0", "sam-3.1"]);
  });

  it("takes the longest name: SAM 3.1 over SAM, Muse Spark Open over Muse Spark", () => {
    const credits = creditsInSource([{ file: "app/x.tsx", text: `<p>Outlined by SAM 3.1.</p><p>Written by Muse Spark Open</p><p>Checked by SAM</p>` }]);
    assert.deepEqual(credits.map((c) => [c.model, c.quote]), [
      ["sam-3.1", "by SAM 3.1"],
      ["muse-spark-open", "by Muse Spark Open"],
    ]);
  });

  it("ignores comments, a person named Sam, a dynamic chip and words that only name a model", () => {
    const text = [
      "// Outlined by SAM 3.1 once it's wired",
      "/* Read by Muse Wonder */",
      "{/* Rendered by Muse Image */}",
      "const url = 'https://example.com/by/Muse'; // made by Muse Wonder later",
      "<p>Photo by Sam Lee</p>",
      "<ModelChip model={result.model} verb=\"Read\" />",
      "<p>Your photo is sent to Muse Wonder to read it.</p>",
    ].join("\n");
    assert.deepEqual(creditsInSource([{ file: "app/page.tsx", text }]), []);
  });

  it("keeps URLs in strings when it takes comments out", () => {
    assert.match(withoutComments(`const u = "https://x.dev/a"; // note`), /https:\/\/x\.dev\/a/);
    assert.doesNotMatch(withoutComments(`const u = "https://x.dev/a"; // note`), /note/);
  });

  it("reads screens and their code, never tests, fixtures, skills or the chip's own definition", () => {
    assert.equal(isUiSource("app/page.tsx"), true);
    assert.equal(isUiSource("components/Result.tsx"), true);
    assert.equal(isUiSource("lib/labels.ts"), true);
    for (const f of ["tests/smoke.spec.ts", "app/__tests__/x.test.tsx", "components/x.test.tsx", "fixtures/a.ts", ".agents/skills/x/SKILL.md", "components/ModelChip.tsx", "app/globals.css"]) {
      assert.equal(isUiSource(f), false, f);
    }
  });
});

describe("judging credits against the gateway's record", () => {
  it("fails the audit's fridge: a SAM 3.1 chip on a build that only called a vision model", () => {
    const problems = creditProblems(creditsInSource([{ file: "app/page.tsx", text: FRIDGE }]), SWITCH);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /app\/page\.tsx/);
    assert.match(problems[0], /never called sam-3\.1/);
    assert.match(problems[0], /Call sam-3\.1 for real .* or take the credit off/);
  });

  it("passes a credit whose model was called", () => {
    const credits = creditsInSource([{ file: "app/page.tsx", text: FRIDGE }]);
    assert.deepEqual(creditProblems(credits, { called: ["sam-3.1", CONTRIBUTOR], wonderServedBy: CONTRIBUTOR }), []);
  });

  it("passes a Muse Wonder chip served on Contributor, since the chip names the model that runs", () => {
    const credits = creditsInSource([{ file: "app/page.tsx", text: `<ModelChip model="muse-wonder-1.0" verb="Read" />` }]);
    assert.deepEqual(creditProblems(credits, SWITCH), []);
  });

  it("fails plain words saying Muse Wonder while the live product runs on Contributor", () => {
    const credits = creditsInSource([{ file: "app/page.tsx", text: `<p>Read by Muse Wonder</p>` }]);
    const [problem] = creditProblems(credits, SWITCH);
    assert.match(problem, /serves this product's muse-wonder-1\.0 calls on muse-spark-1\.3-contributor/);
    assert.match(problem, /<ModelChip model="muse-wonder-1\.0"/);
  });

  it("passes those words when only the build's tests are swapped and the live product runs on Wonder", () => {
    const credits = creditsInSource([{ file: "app/page.tsx", text: `<p>Read by Muse Wonder</p>` }]);
    assert.deepEqual(creditProblems(credits, { called: [CONTRIBUTOR], wonderServedBy: null }), []);
  });

  it("never checks models whose calls the gateway's record doesn't hold", () => {
    const credits = creditsInSource([{ file: "app/page.tsx", text: `<ModelChip model="muse-glimmer" verb="Written" /><ModelChip model="jetson-fleet" verb="Answered" />` }]);
    assert.equal(credits.length, 2);
    assert.deepEqual(creditProblems(credits, { called: [], wonderServedBy: null }), []);
    assert.deepEqual(withModelCredits(PASSED, credits, { called: [], wonderServedBy: null }), PASSED);
  });
});

describe("the step it adds", () => {
  const sam = creditsInSource([{ file: "app/page.tsx", text: FRIDGE }]);

  it("adds nothing when nothing is credited", () => {
    assert.deepEqual(withModelCredits(PASSED, [], SWITCH), PASSED);
  });

  it("passes when every credit is backed", () => {
    const out = withModelCredits(PASSED, sam, { called: ["sam-3.1"], wonderServedBy: null });
    assert.equal(out.passed, true);
    assert.deepEqual(out.steps.at(-1), { name: CREDITS_STEP, ok: true, detail: "1 model credit(s) match the gateway's record" });
  });

  it("fails verify with a fix note naming the file and the model", () => {
    const out = withModelCredits(PASSED, sam, SWITCH);
    assert.equal(out.passed, false);
    assert.equal(out.steps.at(-1)?.name, CREDITS_STEP);
    assert.equal(out.steps.at(-1)?.ok, false);
    assert.match(out.failureOutput, /^Model credits must be true/);
    assert.match(out.failureOutput, /- app\/page\.tsx \(<ModelChip model="sam-3\.1">\) credits sam-3\.1/);
  });

  it("keeps earlier failures in the output", () => {
    const out = withModelCredits({ ...PASSED, passed: false, failureOutput: "## manifest\nbad" }, sam, SWITCH);
    assert.match(out.failureOutput, /^## manifest\nbad\n\nModel credits must be true/);
  });

  it("only warns on a new build's last round", () => {
    const out = withModelCredits(PASSED, sam, SWITCH, { warn: true });
    assert.equal(out.passed, true);
    assert.equal(out.failureOutput, "");
    assert.match(out.steps.at(-1)?.detail ?? "", /^warning: app\/page\.tsx/);
  });
});

describe("the scan script in a sandbox", () => {
  let dir = "";
  let script = "";
  const put = (file: string, content: string) => {
    const full = path.join(dir, "product", file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "credit-scan-"));
    script = path.join(dir, "credit-scan.cjs");
    writeFileSync(script, CREDIT_SCAN_SCRIPT);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("sends back UI files that may hold a credit, and skips the rest", () => {
    put("app/page.tsx", FRIDGE);
    put("app/about/page.tsx", "<p>Nothing to credit here.</p>");
    put("components/Caption.tsx", `export const c = "Rendered by Muse Image";`);
    put("tests/smoke.spec.ts", `expect(page.getByText("Outlined by SAM 3.1")).toBeVisible();`);
    put("app/x.test.tsx", `<ModelChip model="sam-3.1" verb="Outlined" />`);
    put("node_modules/pkg/index.js", `"by Muse Wonder"`);
    put("fixtures/sample.ts", `"by Muse Wonder"`);
    const res = spawnSync("node", [script, path.join(dir, "product")], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    const files = parseCreditScan(res.stdout);
    assert.deepEqual(files?.map((f) => f.file).sort(), ["app/page.tsx", "components/Caption.tsx"]);
    assert.deepEqual(creditsInSource(files ?? []).map((c) => c.model), ["sam-3.1", "muse-image-1.0"]);
  });

  it("reads nothing as a failed scan", () => {
    assert.equal(parseCreditScan("node: not found"), null);
  });
});

describe("the template's own files", () => {
  const TEMPLATE = path.resolve(import.meta.dirname, "../../../template");
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === "node_modules" || e.name === ".next") return [];
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : [full];
    });
  }
  /** The base template and every overlay's files, each as it lands in a product folder. */
  function productFiles(): Array<{ file: string; text: string }> {
    const roots = [TEMPLATE, ...["targets", "caps"].flatMap((d) => readdirSync(path.join(TEMPLATE, d)).map((t) => path.join(TEMPLATE, d, t, "files")))];
    return roots.flatMap((root) => {
      try {
        return walk(root).map((f) => ({ file: path.relative(root, f), text: readFileSync(f, "utf8") }));
      } catch {
        return [];
      }
    });
  }

  it("credit no model in plain text, and only Muse Wonder in a chip, which their tests call", () => {
    const credits = creditsInSource(productFiles());
    assert.deepEqual([...new Set(credits.map((c) => `${c.kind}:${c.model}`))], ["chip:muse-wonder-1.0"]);
    assert.deepEqual(creditProblems(credits, SWITCH), []);
  });

  it("ModelChip names the model that really serves a Muse Wonder call", async () => {
    const chip = readFileSync(path.join(TEMPLATE, "components/ModelChip.tsx"), "utf8");
    assert.match(chip, /process\.env\.NEXT_PUBLIC_MUSE_WONDER_SERVED_BY/);
    assert.match(chip, /"muse-spark-1\.3-contributor": "Muse Spark 1\.3 Contributor"/);
  });
});
