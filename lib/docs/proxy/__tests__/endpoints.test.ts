import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCS_ENDPOINT_LIST, matchEndpoint } from "@/lib/docs/proxy/endpoints";

const split = (path: string) => path.split("/");

test("every listed method and path matches, with Meta's path upstream", () => {
  const cases: Array<[string, string, string, string]> = [
    ["GET", "status", "status", "status"],
    ["GET", "models", "models.list", "models"],
    ["GET", "models/muse-spark-1.3", "models.retrieve", "models/muse-spark-1.3"],
    ["POST", "responses", "responses.create", "responses"],
    ["GET", "responses/resp_abc123", "responses.retrieve", "responses/resp_abc123"],
    ["DELETE", "responses/resp_abc123", "responses.delete", "responses/resp_abc123"],
    ["POST", "responses/resp_abc123/cancel", "responses.cancel", "responses/resp_abc123/cancel"],
    ["POST", "responses/input_tokens", "responses.input_tokens", "responses/input_tokens"],
    ["POST", "chat/completions", "chat.completions", "chat/completions"],
    ["POST", "messages", "messages.create", "messages"],
    ["POST", "messages/count_tokens", "messages.count_tokens", "messages/count_tokens"],
    ["POST", "files", "files.create", "files"],
    ["GET", "files", "files.list", "files"],
    ["GET", "files/file-123", "files.retrieve", "files/file-123"],
    ["DELETE", "files/file-123", "files.delete", "files/file-123"],
    ["GET", "files/file-123/content", "files.content", "files/file-123/content"],
    ["POST", "images/generations", "images.generations", "images/generations"],
    ["POST", "images/edits", "images.edits", "images/edits"],
    ["POST", "asr/transcribe", "asr.transcribe", "asr/transcribe"],
  ];
  for (const [method, path, id, upstream] of cases) {
    const endpoint = matchEndpoint(method, split(path));
    assert.ok(endpoint, `${method} ${path}`);
    assert.equal(endpoint.id, id);
    assert.equal(endpoint.upstreamPath, upstream);
  }
  assert.equal(cases.length, DOCS_ENDPOINT_LIST.length, "the list in errors and the matcher agree");
});

test("ids in the path name what must be the visitor's", () => {
  assert.deepEqual(matchEndpoint("GET", split("files/file-9/content"))?.owned, { kind: "file", id: "file-9" });
  assert.deepEqual(matchEndpoint("POST", split("responses/resp_1/cancel"))?.owned, { kind: "response", id: "resp_1" });
  assert.equal(matchEndpoint("POST", split("responses"))?.owned, undefined);
  // input_tokens is only the count endpoint for POST; a GET of it is a retrieve of an id nobody owns.
  assert.equal(matchEndpoint("GET", split("responses/input_tokens"))?.id, "responses.retrieve");
});

test("anything else is unknown: other methods, other paths, odd ids", () => {
  const unknown: Array<[string, string]> = [
    ["PUT", "responses"],
    ["PATCH", "files/file-1"],
    ["GET", "responses"],
    ["DELETE", "models/muse-spark-1.3"],
    ["POST", "models"],
    ["GET", "chat/completions"],
    ["POST", "embeddings"],
    ["POST", "batches"],
    ["GET", "files/file-1/content/extra"],
    ["POST", "files/file-1"],
    ["GET", "responses/resp_1/input_items"],
    ["GET", "files/..%2F..%2Fadmin"],
    ["GET", "files/a b"],
    ["GET", "models/Bad Model"],
    ["POST", "asr/realtime"],
    ["GET", ""],
  ];
  for (const [method, path] of unknown) assert.equal(matchEndpoint(method, split(path)), null, `${method} ${path}`);
});

test("models and meters per endpoint", () => {
  assert.equal(matchEndpoint("POST", ["responses"])?.models, "responses");
  assert.equal(matchEndpoint("POST", split("chat/completions"))?.models, "text");
  assert.equal(matchEndpoint("POST", split("messages/count_tokens"))?.models, "text");
  assert.equal(matchEndpoint("POST", split("messages/count_tokens"))?.meter, null, "count tokens is free");
  assert.equal(matchEndpoint("POST", split("responses/input_tokens"))?.meter, null, "count tokens is free");
  assert.equal(matchEndpoint("POST", split("images/edits"))?.body, "json_or_multipart");
  assert.equal(matchEndpoint("POST", split("asr/transcribe"))?.models, "voice");
  assert.equal(matchEndpoint("GET", ["status"])?.noKey, true);
  assert.equal(matchEndpoint("POST", ["files"])?.creates, "file");
  assert.equal(matchEndpoint("POST", ["responses"])?.creates, "response");
});
