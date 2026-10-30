/**
 * JSON Pointer get and set (RFC 6901), the calculator tool's parser (no eval), and the structured-output schema
 * checker with Meta's strict-subset rules.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/client/__tests__/pointer-calc-schema.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CalcError, evaluate, tidy } from "@/lib/docs/client/calc";
import { formatPointer, jsonGet, jsonHas, jsonSet, parsePointer, PointerError } from "@/lib/docs/client/pointer";
import { describeSchema, strictSubsetProblems, validateJson } from "@/lib/docs/client/schema";

describe("JSON Pointer", () => {
  const doc = { foo: ["bar", "baz"], "": 0, "a/b": 1, "m~n": 8, input: [{ content: [{ type: "input_text" }, { type: "input_image" }] }] };

  it("reads the RFC 6901 examples", () => {
    assert.equal(jsonGet(doc, ""), doc);
    assert.deepEqual(jsonGet(doc, "/foo"), ["bar", "baz"]);
    assert.equal(jsonGet(doc, "/foo/0"), "bar");
    assert.equal(jsonGet(doc, "/"), 0);
    assert.equal(jsonGet(doc, "/a~1b"), 1);
    assert.equal(jsonGet(doc, "/m~0n"), 8);
    assert.equal(jsonGet(doc, "/foo/2"), undefined);
    assert.equal(jsonGet(doc, "/foo/x"), undefined);
    assert.equal(jsonGet(doc, "/nope/deeper"), undefined);
    assert.equal(jsonHas(doc, "/input/0/content/1/type"), true);
  });

  it("parses and formats tokens with ~0 and ~1", () => {
    assert.deepEqual(parsePointer("/a~1b/m~0n/0"), ["a/b", "m~n", "0"]);
    assert.equal(formatPointer(["a/b", "m~n", 0]), "/a~1b/m~0n/0");
    assert.throws(() => parsePointer("foo"), PointerError);
    assert.throws(() => parsePointer("/bad~2escape"), PointerError);
  });

  it("sets a value without changing the original, creating missing steps", () => {
    const next = jsonSet(doc, "/input/0/content/1/image_url", "data:image/png;base64,AAAA");
    assert.equal(jsonGet(next, "/input/0/content/1/image_url"), "data:image/png;base64,AAAA");
    assert.equal(jsonGet(doc, "/input/0/content/1/image_url"), undefined, "the original is untouched");
    assert.equal(next.foo, doc.foo, "untouched branches are shared");
    assert.deepEqual(jsonSet({}, "/a/0/b", 1), { a: [{ b: 1 }] });
    assert.deepEqual(jsonSet({ list: [1] }, "/list/-", 2), { list: [1, 2] });
    assert.equal(jsonSet({ a: 1 }, "", "whole"), "whole");
  });

  it("refuses steps into scalars and indexes past the end", () => {
    assert.throws(() => jsonSet({ a: "text" }, "/a/b", 1), PointerError);
    assert.throws(() => jsonSet({ a: [] }, "/a/3", 1), PointerError);
    assert.throws(() => jsonSet({ a: [] }, "/a/x", 1), PointerError);
  });
});

describe("calculator", () => {
  it("follows the usual precedence", () => {
    assert.equal(evaluate("(3 + 4) * 2 ^ 3"), 56);
    assert.equal(evaluate("2 + 3 * 4"), 14);
    assert.equal(evaluate("2 ^ 3 ^ 2"), 512, "powers are right-associative");
    assert.equal(evaluate("-2 ^ 2"), -4, "a leading minus binds looser than a power");
    assert.equal(evaluate("2 ^ -1"), 0.5);
    assert.equal(evaluate("10 / 4"), 2.5);
    assert.equal(evaluate("1.5e3 + .5"), 1500.5);
  });

  it("tells modulo from percent", () => {
    assert.equal(evaluate("10 % 3"), 1);
    assert.equal(evaluate("15%"), 0.15);
    assert.equal(evaluate("200 * 15%"), 30);
    assert.equal(tidy(evaluate("15% + 2")), 2.15);
  });

  it("has functions and constants, and the signs people type", () => {
    assert.equal(evaluate("sqrt(16) + abs(-2)"), 6);
    assert.equal(evaluate("max(1, 7, 3) - min(4, 2)"), 5);
    assert.equal(evaluate("round(3.14159, 2)"), 3.14);
    assert.equal(tidy(evaluate("2 * pi")), tidy(2 * Math.PI));
    assert.equal(evaluate("log(1000)"), 3);
    assert.equal(evaluate("6 × 7 ÷ 2"), 21);
    assert.equal(tidy(0.1 + 0.2), 0.3);
  });

  it("rejects anything that isn't arithmetic, so nothing is ever evaluated as code", () => {
    for (const bad of ["alert(1)", "constructor", "process.exit()", "1; 2", "this", "x = 1", "`1`", "[1]", "2 3", "(1 + 2", "1 +", ""]) {
      assert.throws(() => evaluate(bad), CalcError, bad);
    }
    assert.throws(() => evaluate("1 / 0"), /Division by zero/);
    assert.throws(() => evaluate("sqrt(-1)"), /finite/);
    assert.throws(() => evaluate("pow(2)"), /takes 2 arguments/);
    assert.throws(() => evaluate("1+".repeat(200) + "1"), /longer than/);
    assert.throws(() => evaluate("(".repeat(70) + "1" + ")".repeat(70)), /nested too deeply/);
  });
});

// From structured-output, "Using a JSON schema".
const ADDRESS = {
  type: "object",
  properties: {
    street: { type: "string" },
    city: { type: "string" },
    state: { type: "string", description: "2-letter state abbreviation" },
    zip: { type: "string", description: "5-digit zip code" },
  },
  required: ["street", "city", "state", "zip"],
};

describe("schema checker", () => {
  it("passes the docs' address example field by field", () => {
    const report = validateJson(ADDRESS, { street: "1 Hacker Way", city: "Menlo Park", state: "CA", zip: "94025" });
    assert.equal(report.valid, true);
    assert.deepEqual(
      report.fields.map((f) => [f.path, f.ok, f.expected]),
      [
        ["/street", true, "string"],
        ["/city", true, "string"],
        ["/state", true, "string"],
        ["/zip", true, "string"],
      ],
    );
  });

  it("names missing fields, wrong types and extra fields", () => {
    const strict = { ...ADDRESS, additionalProperties: false };
    const report = validateJson(strict, { street: "1 Hacker Way", city: 94025, state: "CA", country: "US" });
    assert.equal(report.valid, false);
    assert.deepEqual(
      report.fields.map((f) => [f.path, f.ok, f.note]),
      [
        ["/street", true, undefined],
        ["/city", false, "Expected string, got number."],
        ["/state", true, undefined],
        ["/zip", false, "missing"],
        ["/country", false, "not in the schema"],
      ],
    );
    assert.ok(report.issues.some((i) => i.path === "/zip" && /Required/.test(i.message)));
  });

  it("checks enums, bounds, patterns, arrays, nested objects and local $refs", () => {
    const schema = {
      type: "object",
      $defs: { Item: { type: "object", properties: { name: { type: "string", minLength: 1 }, qty: { type: "integer", minimum: 1 } }, required: ["name", "qty"] } },
      properties: {
        status: { type: "string", enum: ["open", "closed"] },
        code: { type: "string", pattern: "^[A-Z]{2}\\d{3}$" },
        items: { type: "array", items: { $ref: "#/$defs/Item" }, minItems: 1 },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["status", "items"],
    };
    const good = validateJson(schema, { status: "open", code: "AB123", items: [{ name: "Socks", qty: 2 }], note: null });
    assert.equal(good.valid, true, JSON.stringify(good.issues));
    assert.ok(good.fields.some((f) => f.path === "/items/0/qty" && f.ok));
    const bad = validateJson(schema, { status: "pending", code: "ab12", items: [{ name: "", qty: 0.5 }], note: 3 });
    assert.deepEqual(
      bad.issues.map((i) => i.path),
      ["/status", "/code", "/items/0/name", "/items/0/qty", "/note"],
    );
    assert.equal(describeSchema(schema.properties.status), 'one of "open", "closed"');
    assert.equal(describeSchema(schema.properties.items, schema), "array of object");
    assert.equal(describeSchema(schema.properties.note), "string or null");
  });

  it("reports what breaks Meta's strict subset", () => {
    const problems = strictSubsetProblems(ADDRESS);
    assert.deepEqual(problems, ['/ needs "additionalProperties": false.']);
    assert.deepEqual(strictSubsetProblems({ ...ADDRESS, additionalProperties: false }), []);
    const loose = strictSubsetProblems({
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "object", properties: { b: { type: "string" } } }, c: { oneOf: [{ type: "string" }] } },
      required: ["a"],
    });
    assert.ok(loose.some((p) => /missing: c/.test(p)));
    assert.ok(loose.some((p) => p.startsWith("/properties/a needs")));
    assert.ok(loose.some((p) => /oneOf/.test(p)));
    assert.deepEqual(strictSubsetProblems({ anyOf: [] }), ["The root can't use anyOf; make it a plain object.", 'The root must be "type": "object".']);
  });
});
