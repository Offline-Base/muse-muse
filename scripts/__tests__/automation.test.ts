/**
 * The helpers demo-batch and demo-tunes share (scripts/automation.ts).
 *   npx tsx --test scripts/__tests__/automation.test.ts
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { DEFAULT_SITE, arg, pickIds, postJson, refusalOf, siteArg, words } from "../automation";

const argv = (...a: string[]) => ["node", "script", ...a];

describe("script automation helpers", () => {
  let server: Server;
  let origin = "";
  const seen: Array<{ url?: string; auth?: string; method?: string }> = [];
  before(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization, method: req.method });
      if (req.url === "/moved") {
        res.writeHead(308, { location: "https://www.example.com/moved" });
        return void res.end();
      }
      if (req.url === "/refused") {
        res.writeHead(429, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "rate_limited", retryAfterSeconds: 60, extra: "x" }));
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ runId: "r1" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it("reads flags and words", () => {
    assert.equal(arg("max-gpu-usd", argv("--max-gpu-usd=12", "tune")), "12");
    assert.equal(arg("url", argv("tune")), undefined);
    assert.deepEqual(words(argv("--dry", "dataset", "tune")), ["dataset", "tune"]);
  });

  it("takes --url as an origin, defaults to www, and refuses empty, bare or http addresses", () => {
    assert.equal(siteArg(argv()), DEFAULT_SITE);
    assert.equal(siteArg(argv("--url=https://preview.example.com/some/path/")), "https://preview.example.com");
    assert.equal(siteArg(argv("--url=http://localhost:3000")), "http://localhost:3000");
    assert.throws(() => siteArg(argv("--url=")), /isn't a full address/);
    assert.throws(() => siteArg(argv("--url=musemuse.dev")), /isn't a full address/);
    assert.throws(() => siteArg(argv("--url=http://musemuse.dev")), /must be https/);
  });

  it("refuses an unknown id instead of running nothing", () => {
    const all = [{ id: "dataset" }, { id: "tune" }];
    assert.deepEqual(pickIds(all, []), all);
    assert.deepEqual(pickIds(all, ["tune"]), [{ id: "tune" }]);
    assert.throws(() => pickIds(all, ["tunes"]), /tunes isn't a known id\. Ids: dataset, tune/);
  });

  it("posts with the key, doesn't follow a redirect, and keeps a refusal's reason", async () => {
    const ok = await postJson(origin, "/ok", { a: 1 }, "secret-for-test");
    assert.equal(ok.status, 201);
    assert.equal(ok.json.runId, "r1");
    assert.equal(seen.at(-1)!.auth, "Bearer secret-for-test");
    const moved = await postJson(origin, "/moved", {}, "secret-for-test");
    assert.equal(moved.status, 308);
    assert.match(String(moved.json.message), /redirects to https:\/\/www\.example\.com\/moved/);
    assert.equal(seen.filter((s) => s.url === "/moved").length, 1, "never followed");
    const refused = await postJson(origin, "/refused", {}, "secret-for-test");
    assert.deepEqual(refusalOf(refused), { status: 429, error: "rate_limited", retryAfterSeconds: 60 });
  });
});
