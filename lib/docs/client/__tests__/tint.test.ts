/**
 * CodeView's colors: the generated curl, Python and TypeScript split into runs with the docs' syntax tones.
 *   npx tsx --test --experimental-test-module-mocks lib/docs/client/__tests__/tint.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tintCode, type Tinted } from "@/lib/docs/client/tint";

const tones = (runs: Tinted[]) => runs.filter((r) => r.tone).map((r) => `${r.tone}:${r.text}`);

describe("tintCode", () => {
  it("keeps every character, in order", () => {
    const code = 'curl -X POST "https://api.meta.ai/v1/responses" \\\n  -d \'{"model": "m"}\'  # go';
    for (const syntax of ["bash", "python", "typescript"] as const) {
      assert.equal(tintCode(code, syntax).map((r) => r.text).join(""), code);
    }
  });

  it("colors curl like the mirrored blocks: strings green, flags and commands plain, comments gray", () => {
    const runs = tintCode('curl -X POST "https://api.meta.ai/v1/models" \\\n  -H "Authorization: Bearer $MODEL_API_KEY" | jq  # list', "bash");
    assert.deepEqual(tones(runs), [
      'string:"https://api.meta.ai/v1/models"',
      'string:"Authorization: Bearer $MODEL_API_KEY"',
      "operator:|",
      "comment:# list",
    ]);
  });

  it("reads a shell body with an escaped quote ('\\'') as one string", () => {
    const runs = tintCode("curl -d '{\"text\": \"it doesn'\\''t\"}' https://api.meta.ai/v1/x", "bash");
    assert.deepEqual(tones(runs), ["string:'{\"text\": \"it doesn'\\''t\"}'"]);
  });

  it("colors Python: keywords, class names, calls, keys, strings, numbers, constants and punctuation", () => {
    const runs = tintCode('from openai import OpenAI\nclient = OpenAI()\nr = client.responses.create(model="m", input={"role": "user"}, stream=True, n=2)', "python");
    const t = tones(runs);
    for (const want of ["keyword:from", "keyword:import", "type:OpenAI", "function:create", 'property:"role"', 'string:"user"', "number:True", "number:2", "punct:.", "operator:="]) {
      assert.ok(t.includes(want), `${want} in ${t.join(" ")}`);
    }
    assert.ok(!t.some((x) => x.startsWith("type:") && x !== "type:OpenAI"));
  });

  it("colors TypeScript: object keys, template strings, true and null, and all-caps names left plain", () => {
    const runs = tintCode("const r = await fetch(`${API}/x`, { method: 'POST', body: JSON.stringify({ stream: true, stop: null }) });", "typescript");
    const t = tones(runs);
    for (const want of ["keyword:const", "keyword:await", "function:fetch", "string:`${API}/x`", "property:method", "string:'POST'", "property:stream", "number:true", "number:null", "function:stringify"]) {
      assert.ok(t.includes(want), `${want} in ${t.join(" ")}`);
    }
    assert.ok(!t.includes("type:JSON"), "all-caps names are plain");
  });
});
