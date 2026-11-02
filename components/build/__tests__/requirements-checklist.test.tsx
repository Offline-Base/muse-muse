/**
 * The requirements checklist lets a failure win: nothing reads "Works" or "checked and working" while a check failed.
 *
 *   npx tsx --test components/build/__tests__/requirements-checklist.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { checksFailed, RequirementsChecklist } from "@/components/build/RequirementsChecklist";
import type { RequirementResult } from "@/lib/full/requirements";

const items: RequirementResult[] = [
  { id: "R1", text: "Adds a cake order", state: "met", detail: "Seen on screen 2." },
  { id: "R2", text: "Shows an error when saving fails", state: "unmet", detail: "Its test failed." },
];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("checksFailed", () => {
  it("is true for a failed, refused or partial status, whatever the checks say", () => {
    for (const status of ["failed", "refused", "partial"]) assert.equal(checksFailed(status, [{ verify: { passed: true }, judge: { pass: true } }]), true, status);
    assert.equal(checksFailed("live", [{ verify: { passed: true }, judge: { pass: true } }]), false);
  });

  it("follows the newest check, so a fix round that passes clears an earlier failure and a later failure wins", () => {
    assert.equal(checksFailed("building", [{ verify: { passed: false } }, { verify: { passed: true }, judge: { pass: true } }]), false);
    assert.equal(checksFailed("building", [{ judge: { pass: true } }, { verify: { passed: false } }]), true);
    assert.equal(checksFailed("verifying", [{ verify: { passed: true }, judge: { pass: false } }]), true);
    assert.equal(checksFailed("verifying", [{ verify: { passed: true }, judge: { pass: false } }, { verify: null, judge: null }]), true, "an empty entry isn't a check");
    assert.equal(checksFailed("building", []), false);
  });
});

describe("RequirementsChecklist", () => {
  it("counts what was seen working while nothing failed", () => {
    const html = text(renderToStaticMarkup(<RequirementsChecklist items={items} />));
    assert.match(html, /1 of 2 checked and working/);
    assert.match(html, /R1: Adds a cake order Works/);
  });

  it("puts the failure first and shows no Works while a check failed", () => {
    const raw = renderToStaticMarkup(<RequirementsChecklist items={items} failed />);
    const html = text(raw);
    assert.doesNotMatch(html, /checked and working/);
    assert.doesNotMatch(html, /\bWorks\b/);
    assert.match(html, /Checks found problems, so none of these count as working yet/);
    assert.match(html, /R1: Adds a cake order Looked right, but checks found problems/);
    assert.match(html, /R2: Shows an error when saving fails Not met/);
    assert.ok(!raw.includes('class="ok"'), "no green row");
    assert.ok(!raw.includes("—"));
  });
});
