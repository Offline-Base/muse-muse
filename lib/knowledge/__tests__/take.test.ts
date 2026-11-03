/**
 * The self-hosted Spark Open take: rows, labels, the request it sends and the checks it keeps. A local fake server, no spend.
 *
 *   npx tsx --test lib/knowledge/__tests__/take.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { checkQa } from "@/lib/knowledge/qa";
import { fakeReply, hostLabel, INVENTED_PASSAGES, TAKE_MAX_PASSAGES, takeRows, writePassage } from "@/lib/knowledge/take";

describe("spark take", () => {
  it("has enough invented passages, each marked invented", () => {
    assert.ok(INVENTED_PASSAGES.length >= 4 && INVENTED_PASSAGES.length <= TAKE_MAX_PASSAGES);
    for (const p of INVENTED_PASSAGES) {
      assert.match(p.header, /^Invented sample for a demo/);
      assert.match(p.url, /^invented:\/\//);
    }
  });

  it("takes only safe host labels", () => {
    assert.equal(hostLabel("sagemaker-own"), "sagemaker-own");
    assert.equal(hostLabel("lambda-own"), "lambda-own");
    for (const bad of [undefined, "", "Lambda", "a b", "x/y", "-lead", "a".repeat(40)]) assert.equal(hostLabel(bad), null);
  });

  it("writes one row per kept pair with the writer and the duty note", () => {
    const p = INVENTED_PASSAGES[0];
    const qa = checkQa(
      {
        pairs: [
          { question: "How many lanterns floated at the 2026 Port Wren Lantern Fair?", answer: "412 lanterns floated on Gull Pond on October 3, 2026." },
          { question: "How much did the fair raise?", answer: "It raised 9,999 dollars." },
        ],
      },
      p,
    );
    const rows = takeRows(qa, "muse-spark-open@sagemaker-own", 1234, "2026-11-03T15:00:00.000Z");
    assert.equal(rows.length, 1, "the made-up number is dropped by the knowledge run's checks");
    assert.deepEqual(rows[0].messages.map((m) => m.role), ["system", "user", "assistant"]);
    assert.equal(rows[0].release.writer, "muse-spark-open@sagemaker-own");
    assert.equal(rows[0].release.passage_id, p.id);
    assert.match(rows[0].release.note, /Built with Muse Spark Open/);
    assert.deepEqual(qa.dropped, ["number not in passage"]);
  });

  it("the dry-run writer passes the checks and says it is fake", () => {
    for (const p of INVENTED_PASSAGES) {
      const qa = checkQa(fakeReply(p), p);
      assert.equal(qa.pairs.length, 1);
      assert.match(qa.pairs[0].question, /^Fake writer, rehearsal only/);
    }
  });

  it("sends the knowledge run's request to the server and checks its reply", async () => {
    let seen: { body: Record<string, unknown>; auth: string | undefined; path: string | undefined } | null = null;
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        seen = { body: JSON.parse(data), auth: req.headers.authorization, path: req.url };
        const content =
          'Here: {"pairs":[{"question":"When did the Tessel Valley ferry start running every 20 minutes?","answer":"It started on September 14, 2026."}],"probe":null}';
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { completion_tokens: 77 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const reply = await writePassage({ baseUrl: `http://127.0.0.1:${port}/v1/`, model: "muse-spark-open" }, INVENTED_PASSAGES[1]);
      assert.equal(reply.qa.pairs.length, 1);
      assert.equal(reply.outputTokens, 77);
      assert.ok(seen);
      const s = seen as unknown as { body: Record<string, unknown>; auth: string | undefined; path: string };
      assert.equal(s.path, "/v1/chat/completions");
      assert.equal(s.auth, undefined, "no key, no header");
      assert.equal(s.body.model, "muse-spark-open");
      assert.equal(s.body.temperature, 0.4);
      assert.deepEqual(s.body.response_format, { type: "json_object" });
    } finally {
      server.close();
    }
  });

  it("reports a server error without the body's tail", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 503;
      res.end("x".repeat(1000));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      await assert.rejects(writePassage({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "m" }, INVENTED_PASSAGES[0]), (err: Error) => {
        assert.match(err.message, /^writer server: HTTP 503/);
        assert.ok(err.message.length < 260);
        return true;
      });
    } finally {
      server.close();
    }
  });
});
