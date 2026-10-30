/**
 * The schema explorer's logic on the real mirrored pages: the parser reads every table on api-reference/images/schemas
 * and api-reference/files/schemas, the checker passes real replies the docs proxy returned (saved in fixtures/, base64
 * trimmed) and flags what Meta refuses, and the example builder makes bodies that pass its own check.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/media/__tests__/schema.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { checkAgainst, exampleFor, formFieldsFrom, shapeMatches, sortRows } from "@/components/docs/playgrounds/media/schema-check";
import {
  findSchema,
  parseSchemaPage,
  parseType,
  proseWithoutEmDashes,
  splitConstraints,
  splitRow,
  unescapeMarkdown,
  type SchemaDoc,
} from "@/components/docs/playgrounds/media/schema-tables";

const ROOT = process.cwd();
const page = (slug: string) => readFileSync(path.join(ROOT, "content/meta-docs/pages", `${slug}.md`), "utf8");
const fixture = (name: string) => JSON.parse(readFileSync(path.join(ROOT, "components/docs/playgrounds/media/__tests__/fixtures", name), "utf8")) as unknown;

/** Built from its code point, so this file holds no em dash itself. */
const DASH = String.fromCharCode(0x2014);

const IMAGES = parseSchemaPage(page("api-reference/images/schemas"));
const FILES = parseSchemaPage(page("api-reference/files/schemas"));

function field(schemas: SchemaDoc[], schema: string, name: string) {
  const f = findSchema(schemas, schema)?.fields.find((x) => x.name === name);
  assert.ok(f, `${schema}.${name}`);
  return f;
}

describe("schema-tables", () => {
  it("splits rows on unescaped pipes only", () => {
    assert.deepEqual(splitRow("| `a` | `integer (int64)` \\| `null` | Yes | x |"), ["`a`", "`integer (int64)` \\| `null`", "Yes", "x"]);
  });

  it("reads every type the pages use", () => {
    assert.deepEqual(parseType("`string`"), { kind: "string" });
    assert.deepEqual(parseType("`string (binary)`"), { kind: "binary", format: "binary" });
    assert.deepEqual(parseType("`integer (int64)`"), { kind: "integer", format: "int64" });
    assert.deepEqual(parseType("`enum ('url', 'b64_json')`"), { kind: "enum", values: ["url", "b64_json"] });
    assert.deepEqual(parseType("[`ImageToolEnablement`](https://dev.meta.ai/docs/api-reference/images/schemas#image-tool-enablement)"), {
      kind: "ref",
      name: "ImageToolEnablement",
      ref: "image-tool-enablement",
    });
    assert.deepEqual(parseType("array of [`ImageObject`](https://dev.meta.ai/docs/api-reference/images/schemas#image-object)"), {
      kind: "array",
      items: { kind: "ref", name: "ImageObject", ref: "image-object" },
    });
    assert.deepEqual(parseType("`integer (int64)` \\| `null`"), { kind: "union", options: [{ kind: "integer", format: "int64" }, { kind: "null" }] });
  });

  it("splits constraints off a description and unescapes them", () => {
    assert.deepEqual(splitConstraints("Range: 1-10. Defaults to 1. (minimum: 1, maximum: 10, default: 1)"), {
      description: "Range: 1-10. Defaults to 1.",
      constraints: { minimum: 1, maximum: 10, default: 1 },
    });
    assert.deepEqual(splitConstraints(unescapeMarkdown("Default: `b64_json`. (default: b64\\_json)")).constraints, { default: "b64_json" });
    assert.deepEqual(splitConstraints("Images to edit. (minItems: 1)").constraints, { minItems: 1 });
    assert.deepEqual(splitConstraints("No constraints here.").constraints, {});
  });

  it("swaps Meta's em dashes outside inline code", () => {
    assert.equal(proseWithoutEmDashes(`the numbers supplied ${DASH} only the ratio`), "the numbers supplied, only the ratio");
    assert.equal(proseWithoutEmDashes(`\`HTTP 200\` ${DASH} OK`), "`HTTP 200`: OK");
    assert.equal(proseWithoutEmDashes(`keep \`a${DASH}b\` as is`), `keep \`a${DASH}b\` as is`);
  });

  it("reads all 14 schemas on the images page", () => {
    assert.deepEqual(
      IMAGES.map((s) => s.name),
      [
        "CreateImageEditRequest",
        "CreateImageRequest",
        "EditImageBodyJsonParam",
        "ImageEditCompletedEvent",
        "ImageEditPartialImageEvent",
        "ImageEditStreamEvent",
        "ImageGenCompletedEvent",
        "ImageGenPartialImageEvent",
        "ImageGenStreamEvent",
        "ImageGenUsage",
        "ImageInputItem",
        "ImageObject",
        "ImageToolEnablement",
        "ImagesResponse",
      ],
    );
    const n = field(IMAGES, "create-image-request", "n");
    assert.equal(n.type.kind, "integer");
    assert.deepEqual(n.constraints, { minimum: 1, maximum: 10, default: 1 });
    assert.equal(field(IMAGES, "create-image-request", "model").required, true);
    assert.deepEqual(field(IMAGES, "create-image-request", "response_format").constraints, { default: "b64_json" });
    assert.deepEqual(field(IMAGES, "create-image-request", "tool_enablement").type, { kind: "ref", name: "ImageToolEnablement", ref: "image-tool-enablement" });
    const images = field(IMAGES, "edit-image-body-json-param", "images");
    assert.equal(images.typeLabel, "array of ImageInputItem");
    assert.deepEqual(images.constraints, { minItems: 1 });
    assert.equal(field(IMAGES, "create-image-edit-request", "image").type.kind, "binary");
    assert.deepEqual(findSchema(IMAGES, "ImageGenStreamEvent")?.oneOf, [
      { name: "ImageGenPartialImageEvent", id: "image-gen-partial-image-event" },
      { name: "ImageGenCompletedEvent", id: "image-gen-completed-event" },
    ]);
    assert.equal(findSchema(IMAGES, "image-edit-completed-event")?.description, "Image edit completed event.");
    assert.ok(findSchema(IMAGES, "image-gen-usage")?.fields.some((f) => f.name === "input_tokens_details.image_tokens"));
  });

  it("reads the five Files schemas", () => {
    assert.deepEqual(
      FILES.map((s) => s.name),
      ["CreateFileRequest", "DeleteFileResponse", "FileExpiresAfter", "FileObject", "ListFilesResponse"],
    );
    assert.match(findSchema(FILES, "create-file-request")!.description, /100 GiB/);
    assert.deepEqual(field(FILES, "file-expires-after", "seconds").constraints, { minimum: 3600, maximum: 2592000 });
    assert.equal(field(FILES, "file-object", "expires_at").typeLabel, "integer (int64) | null");
    assert.deepEqual(field(FILES, "file-object", "purpose").type, { kind: "enum", values: ["batch", "fine-tune", "evals", "user_data"] });
    assert.equal(field(FILES, "file-object", "status_details").required, false);
  });

  it("shows no em dash anywhere it hands to the page", () => {
    assert.equal(JSON.stringify([IMAGES, FILES]).includes(DASH), false);
  });
});

describe("schema-check: requests", () => {
  const ok = (body: unknown, schema = "create-image-request") => checkAgainst(IMAGES, schema, body, "request");

  it("passes the page's own create-image body", () => {
    const r = ok({ model: "muse-image-1.0", prompt: "a watercolor fox", n: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.errors, 0);
  });

  it("flags what Meta refuses: missing required, out of range, wrong type, unknown top-level field", () => {
    const r = ok({ model: "muse-image-1.0", n: 11, seed: 42, stream: "yes" });
    const by = Object.fromEntries(r.rows.map((x) => [x.path, x]));
    assert.equal(by.prompt.severity, "error");
    assert.match(by.n.message, /at most 10/);
    assert.equal(by.seed.severity, "error");
    assert.match(by.seed.message, /unknown top-level field/);
    assert.equal(by.stream.severity, "error");
    assert.equal(r.errors, 4);
  });

  it("refuses unknown members of an edit image item but only notes unknown nested keys", () => {
    const r = ok(
      { model: "muse-image-1.0", prompt: "x", images: [{ image_url: "https://example.com/a.png", detail: "high" }], tool_enablement: { turbo: true } },
      "edit-image-body-json-param",
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.path, x]));
    assert.equal(by["images[0].detail"].severity, "error");
    assert.equal(by["tool_enablement.turbo"].severity, "info");
    assert.equal(r.errors, 1);
  });

  it("checks minItems on arrays", () => {
    const r = ok({ model: "muse-image-1.0", prompt: "x", images: [] }, "edit-image-body-json-param");
    assert.match(r.rows.find((x) => x.path === "images")!.message, /at least 1 item/);
  });

  /** The one problem row a body gets, after checking it has exactly one. */
  const only = (body: unknown, schema = "create-image-request") => {
    const r = ok(body, schema);
    assert.equal(r.errors, 1, JSON.stringify(r.rows.filter((x) => x.severity === "error")));
    return r.rows.find((x) => x.severity === "error")!;
  };
  const base = { model: "muse-image-1.0", prompt: "a red fox in the snow" };

  it("refuses what image-generation's Errors section documents, each a live 400", () => {
    assert.match(only({ ...base, moderation: "auto" }).message, /Not enabled on muse-image-1\.0/);
    assert.equal(only({ ...base, moderation: "low" }).path, "moderation");
    assert.match(only({ ...base, output_format: "gif" }).message, /png, jpeg \(or jpg\) or webp/);
    assert.match(only({ ...base, size: "1700x100" }).message, /17:1, beyond 16:1/);
    assert.match(only({ ...base, size: "banana" }).message, /Invalid size format/);
    assert.match(only({ ...base, size: "0x100" }).message, /Invalid size format/);
    assert.match(only({ ...base, prompt: "" }).message, /prompt must not be empty/);
    assert.equal(only({ ...base, prompt: "   " }).path, "prompt");
    assert.equal(only({ ...base, model: "" }).path, "model");
  });

  it("passes what the live API ran: uppercase and jpg formats, an X in the size, auto, exactly 16:1", () => {
    for (const extra of [{ output_format: "JPEG" }, { output_format: "jpg" }, { size: "1024X1024" }, { size: "auto" }, { size: "1600x100" }, { output_format: "png", size: "1536x1024" }]) {
      assert.equal(ok({ ...base, ...extra }).ok, true, JSON.stringify(extra));
    }
  });

  it("replaces the passing row instead of adding a second one", () => {
    const rows = ok({ ...base, size: "1700x100" }).rows.filter((x) => x.path === "size");
    assert.deepEqual(rows.map((x) => x.severity), ["error"]);
    assert.equal(rows[0].field?.name, "size");
    assert.equal(rows[0].value, "1700x100");
    // A wrong type stays one problem, not two.
    assert.equal(ok({ ...base, moderation: null }).rows.filter((x) => x.path === "moderation").length, 1);
  });

  it("checks a JSON edit's images: 1 to 10, each exactly one of image_url or file_id", () => {
    const edit = "edit-image-body-json-param";
    const url = { image_url: "https://example.com/a.png" };
    const both = only({ ...base, images: [{ ...url, file_id: "file-1" }] }, edit);
    assert.equal(both.path, "images[0]");
    assert.match(both.message, /both image_url and file_id/);
    assert.equal(both.field?.typeLabel, "ImageInputItem");
    assert.match(only({ ...base, images: [url, {}] }, edit).message, /neither image_url nor file_id/);
    assert.match(only({ ...base, images: Array.from({ length: 11 }, () => url) }, edit).message, /at most 10 items/);
    assert.equal(ok({ ...base, images: Array.from({ length: 10 }, () => url) }, edit).ok, true);
    assert.equal(ok({ ...base, images: [{ file_id: "file-1" }] }, edit).ok, true);
    assert.equal(only({ ...base, images: [url], moderation: "auto" }, edit).path, "moderation");
  });

  it("checks the multipart edit: refused fields, file parts, and unknown fields as notes", () => {
    const form = "create-image-edit-request";
    const withImage = { ...base, image: "<file>" };
    for (const field of ["partial_images", "mask", "input_fidelity"]) {
      const row = only({ ...withImage, [field]: field === "partial_images" ? 0 : "<file>" }, form);
      assert.equal(row.path, field);
      assert.match(row.message, new RegExp(`"${field} is not a supported image edit field"`));
    }
    assert.match(only(base, form).message, /at least one image is required/);
    assert.match(only({ ...withImage, "image[0]": "<file>" }, form).message, /can't be mixed/);
    assert.match(only({ ...base, "image[1]": "<file>" }, form).message, /expects image\[0\] here/);
    const parts = ok({ ...base, "image[0]": "<file>", "image[1]": "<file>", output_format: "png" }, form);
    assert.equal(parts.ok, true);
    assert.equal(parts.rows.find((x) => x.path === "image[1]")?.severity, "ok");
    assert.equal(parts.rows.find((x) => x.path === "output_format")?.severity, "info");
  });

  it("notes an unknown field on a Files upload, which Meta accepts", () => {
    const r = checkAgainst(FILES, "create-file-request", { file: "<file>", purpose: "user_data", foo: "bar" }, "request");
    assert.equal(r.ok, true);
    assert.match(r.rows.find((x) => x.path === "foo")!.message, /multipart body isn't refused/);
  });

  it("keeps the rules to request bodies", () => {
    assert.equal(checkAgainst(IMAGES, "create-image-request", { ...base, moderation: "auto", size: "1700x100" }, "reply").errors, 0);
  });

  it("knows the outer shape of every kind", () => {
    assert.equal(shapeMatches({ kind: "integer" }, 1.5), false);
    assert.equal(shapeMatches({ kind: "union", options: [{ kind: "integer" }, { kind: "null" }] }, null), true);
    assert.equal(shapeMatches({ kind: "enum", values: ["a"] }, "b"), false);
  });

  it("sorts problems first", () => {
    const rows = sortRows(ok({ model: "muse-image-1.0", prompt: "x", seed: 1 }).rows);
    assert.equal(rows[0].path, "seed");
  });
});

describe("schema-check: real replies", () => {
  const reply = (schema: string, name: string, schemas = FILES) => checkAgainst(schemas, schema, fixture(name), "reply");

  it("passes a real upload, list and delete", () => {
    for (const [schema, name] of [
      ["file-object", "file-object.json"],
      ["list-files-response", "list-files.json"],
      ["delete-file-response", "delete-file.json"],
    ] as const) {
      const r = reply(schema, name);
      assert.equal(r.ok, true, `${name}: ${JSON.stringify(r.rows.filter((x) => x.severity !== "ok"))}`);
      assert.equal(r.warnings, 0, name);
    }
  });

  it("checks list items against FileObject", () => {
    const r = reply("list-files-response", "list-files.json");
    assert.ok(r.rows.some((x) => x.path === "data[0].expires_at" && x.severity === "ok"));
  });

  it("notes the null ids an empty list carries without failing it", () => {
    const r = reply("list-files-response", "list-files-empty.json");
    assert.equal(r.ok, true);
    assert.equal(r.warnings, 2);
    assert.match(r.rows.find((x) => x.path === "first_id")!.message, /null, where the schema documents a string/);
  });

  it("passes real images replies, base64 and URL", () => {
    assert.equal(reply("images-response", "images-response.json", IMAGES).ok, true);
    assert.equal(reply("images-response", "images-response-url.json", IMAGES).ok, true);
  });

  it("matches a streamed event to the one-of option it is", () => {
    const r = reply("image-gen-stream-event", "image-gen-completed-event.json", IMAGES);
    assert.equal(r.matched, "ImageGenCompletedEvent");
    assert.equal(r.errors, 0);
  });

  it("calls out a reply that lost a field or changed a type", () => {
    const file = { ...(fixture("file-object.json") as Record<string, unknown>) };
    delete file.bytes;
    file.created_at = "yesterday";
    const r = checkAgainst(FILES, "file-object", file, "reply");
    assert.equal(r.rows.find((x) => x.path === "bytes")!.severity, "warning");
    assert.equal(r.rows.find((x) => x.path === "created_at")!.severity, "error");
  });
});

describe("schema-check: examples", () => {
  /** As the page's own hints (lib/docs/demos/media.ts): render.test.tsx checks the real ones the same way. */
  const hints = {
    model: "muse-image-1.0",
    prompt: "a fox",
    "edit-image-body-json-param.images": [{ image_url: "https://example.com/a.png" }],
    image_url: "https://example.com/a.png",
    file_id: null,
    size: "1024x1024",
    output_format: "webp",
    moderation: null,
    enable_image_search: true,
    enable_web_search: true,
    enable_shell: true,
  };

  it("builds the required fields, then every field, from the table", () => {
    assert.deepEqual(exampleFor(IMAGES, "create-image-request", { hints }), { model: "muse-image-1.0", prompt: "a fox" });
    const full = exampleFor(IMAGES, "create-image-request", { optional: true, hints });
    assert.equal(full.n, 1);
    assert.equal(full.response_format, "b64_json");
    assert.equal(full.reasoning_strength, "high");
    assert.equal(full.stream, false);
    assert.equal("moderation" in full, false);
    assert.deepEqual(full.tool_enablement, { enable_image_search: true, enable_web_search: true, enable_shell: true });
  });

  it("leaves what the rules refuse out of the multipart example and keeps the image it needs", () => {
    assert.deepEqual(Object.keys(exampleFor(IMAGES, "create-image-edit-request", { hints })), ["image", "prompt", "model"]);
    const full = exampleFor(IMAGES, "create-image-edit-request", { optional: true, hints });
    assert.equal("partial_images" in full, false);
    assert.equal("moderation" in full, false);
    assert.equal(full.image, "<file>");
  });

  it("makes examples that pass their own schema", () => {
    for (const id of ["create-image-request", "edit-image-body-json-param", "create-image-edit-request"]) {
      for (const optional of [false, true]) {
        const r = checkAgainst(IMAGES, id, exampleFor(IMAGES, id, { optional, hints }), "request");
        assert.equal(r.ok, true, `${id} optional=${optional}: ${JSON.stringify(r.rows.filter((x) => x.severity === "error"))}`);
      }
    }
    const upload = exampleFor(FILES, "create-file-request", { optional: true, hints: { file: "<file>", purpose: "user_data" } });
    assert.deepEqual(upload, { file: "<file>", purpose: "user_data", expires_after: { anchor: "created_at", seconds: 3600 } });
    assert.equal(checkAgainst(FILES, "create-file-request", upload, "request").ok, true);
  });

  it("turns a body into multipart fields, nested objects bracketed and the file last", () => {
    const blob = new Blob(["x"]);
    const fields = formFieldsFrom({ file: "<file>", purpose: "user_data", expires_after: { anchor: "created_at", seconds: 3600 } }, { file: blob });
    assert.deepEqual(
      fields.map(([k, v]) => [k, typeof v === "string" ? v : "blob"]),
      [
        ["purpose", "user_data"],
        ["expires_after[anchor]", "created_at"],
        ["expires_after[seconds]", "3600"],
        ["file", "blob"],
      ],
    );
  });
});
