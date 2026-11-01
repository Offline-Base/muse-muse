/**
 * The platform's Terms and Privacy text (lib/trust/terms.ts): a dated version, plain sentences, no em dashes, and the
 * facts the contract asks for (18+, restricted territories, Meta, reports).
 *
 *   npx tsx --test lib/trust/__tests__/terms.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RETIRED_SPARK, SPARK_STANDIN } from "@/lib/meta/spark";
import { refineBuildModel } from "@/lib/pipeline/logic";
import { privacySections, TERMS_SECTIONS, TERMS_VERSION } from "@/lib/trust/terms";

const PRIVACY_SECTIONS = privacySections({ sparkToWonder: false });

const text = (sections: typeof TERMS_SECTIONS) => sections.flatMap((s) => [s.heading, ...(s.paragraphs ?? []), ...(s.bullets ?? [])]).join("\n");

describe("the platform's Terms and Privacy", () => {
  it("have a dated version and no em dashes", () => {
    assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
    for (const t of [text(TERMS_SECTIONS), text(PRIVACY_SECTIONS)]) assert.ok(!t.includes("\u2014"));
  });
  it("say 18 or older, restricted territories, not an official Meta product, and how to report", () => {
    const terms = text(TERMS_SECTIONS);
    for (const phrase of ["18 or older", "Meta's terms don't allow", "not an official Meta product", "Report link", "can be undone"]) assert.ok(terms.includes(phrase), phrase);
    const privacy = text(PRIVACY_SECTIONS);
    for (const phrase of ["scrypt", "Meta's Model API", "Composio", "made-up data", "scrambled code"]) assert.ok(privacy.includes(phrase), phrase);
  });

  it("say what reaches the model tier Meta may train on, as the Spark switch has it", () => {
    for (const sparkToWonder of [false, true]) {
      const privacy = text(privacySections({ sparkToWonder }));
      assert.ok(!privacy.includes("never yours"), "real people's words do reach it");
      assert.ok(privacy.includes("Muse Spark 1.3 Contributor"));
      // refineBuildModel resumes a Spark-era product's changes on Contributor whatever the flag says.
      assert.equal(refineBuildModel(RETIRED_SPARK), SPARK_STANDIN);
      assert.equal(refineBuildModel(null), SPARK_STANDIN, "and every product from before the model was recorded");
      assert.ok(privacy.includes("Changes to a product first built on Muse Spark 1.3"), String(sparkToWonder));
      // The gateway sends a Spark-era product's own calls there until TRUST_SPARK_TO_WONDER is on.
      assert.equal(privacy.includes("what people type into those products"), !sparkToWonder, String(sparkToWonder));
      assert.ok(!privacy.includes("\u2014"));
    }
  });
});
