/**
 * The platform's Terms and Privacy text (lib/trust/terms.ts): a dated version, plain sentences, no em dashes, and the
 * facts the contract asks for (18+, restricted territories, Meta, reports).
 *
 *   npx tsx --test lib/trust/__tests__/terms.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PRIVACY_SECTIONS, TERMS_SECTIONS, TERMS_VERSION } from "@/lib/trust/terms";

const text = (sections: typeof TERMS_SECTIONS) => sections.flatMap((s) => [s.heading, ...(s.paragraphs ?? []), ...(s.bullets ?? [])]).join("\n");

describe("the platform's Terms and Privacy", () => {
  it("have a dated version and no em dashes", () => {
    assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
    for (const t of [text(TERMS_SECTIONS), text(PRIVACY_SECTIONS)]) assert.ok(!t.includes("—"));
  });
  it("say 18 or older, restricted territories, not an official Meta product, and how to report", () => {
    const terms = text(TERMS_SECTIONS);
    for (const phrase of ["18 or older", "Meta's terms don't allow", "not an official Meta product", "Report link", "can be undone"]) assert.ok(terms.includes(phrase), phrase);
    const privacy = text(PRIVACY_SECTIONS);
    for (const phrase of ["scrypt", "Meta's Model API", "Composio", "made-up data", "scrambled code"]) assert.ok(privacy.includes(phrase), phrase);
  });
});
