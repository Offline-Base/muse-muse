/**
 * Registering and reaching a board, with no database and no board: refusals, what gets sealed, the address rules, and that a
 * row opens only for the board and owner it was sealed for.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/hardware/__tests__/registry.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boardTokenAad, boardUrlAad, checkBoardAddress, linkedBoardFor, openBoardConfig, type LinkedBoardDeps } from "@/lib/caps/hardware/board";
import { registerBoard, type RegisterDeps } from "@/lib/caps/hardware/registry";
import type { LinkedBoardRow, NewBoardRow } from "@/lib/caps/hardware/store";
import { newBoxKey, parseKeyring, sealSecret } from "@/lib/secrets/box";

const RING = parseKeyring(newBoxKey())!;
const URL_OK = "https://board.example.com/mcp";
const TOKEN = "t".repeat(40);
const OWNER = "00000000-0000-4000-8000-000000000001";
const DESCRIBED = { isError: false, content: [{ type: "text", text: JSON.stringify({ hostname: "jetson-02", cameras: [], microphones: [] }) }] };

function deps(over: Partial<RegisterDeps> = {}): RegisterDeps & { rows: NewBoardRow[]; described: unknown[] } {
  const rows: NewBoardRow[] = [];
  const described: unknown[] = [];
  return {
    rows,
    described,
    ring: () => RING,
    check: async () => ({ ok: true, trust: "public_tls" }),
    describe: async (config) => {
      described.push(config);
      return DESCRIBED;
    },
    count: async () => 0,
    insert: async (row) => void rows.push(row),
    ...over,
  };
}
const input = (over = {}) => ({ name: "Shop board", mcpUrl: URL_OK, token: TOKEN, ...over });

describe("registerBoard", () => {
  it("seals the address and token, each with its own IV, and stores neither in the clear", async () => {
    const d = deps();
    const result = await registerBoard(input(), OWNER, d);
    assert.equal(result.ok, true);
    const row = d.rows[0]!;
    assert.equal(row.name, "Shop board");
    assert.equal(row.trust, "public_tls");
    assert.notDeepEqual(row.url.iv, row.token.iv);
    const dump = JSON.stringify(row, (_k, v) => (v?.type === "Buffer" ? Buffer.from(v.data).toString("latin1") : v));
    assert.equal(dump.includes(URL_OK), false);
    assert.equal(dump.includes(TOKEN), false);
    const opened = openBoardConfig(
      { boardId: row.id, ownerUserId: OWNER, visitors: false, urlCiphertext: row.url.ciphertext, urlIv: row.url.iv, urlTag: row.url.tag, tokenCiphertext: row.token.ciphertext, iv: row.token.iv, tag: row.token.tag, keyVersion: row.token.keyVersion },
      RING,
    );
    assert.deepEqual(opened, { url: URL_OK, token: TOKEN });
  });

  it("checks the board with describe_device before storing, and nothing else", async () => {
    const d = deps();
    await registerBoard(input(), OWNER, d);
    assert.deepEqual(d.described, [{ url: URL_OK, token: TOKEN }]);
  });

  const refusals: Array<[string, Partial<RegisterDeps>, object, string]> = [
    ["no name", {}, { name: "  " }, "invalid_name"],
    ["a long name", {}, { name: "n".repeat(61) }, "invalid_name"],
    ["a short token", {}, { token: "short" }, "invalid_token"],
    ["a token with a space", {}, { token: `${"t".repeat(40)} x` }, "invalid_token"],
    ["no key", { ring: () => null }, {}, "key_missing"],
    ["an unsafe address", { check: async () => ({ ok: false }) }, {}, "unsafe_address"],
    ["too many boards", { count: async () => 20 }, {}, "too_many_boards"],
    ["a board that doesn't answer", { describe: async () => { throw new Error(`connect failed ${URL_OK} ${TOKEN}`); } }, {}, "board_unreachable"],
    ["something else that answers", { describe: async () => ({ isError: false, content: [{ type: "text", text: "{}" }] }) }, {}, "not_a_board"],
    ["a tool error", { describe: async () => ({ isError: true, content: [{ type: "text", text: "nope" }] }) }, {}, "not_a_board"],
  ];
  for (const [what, over, fields, error] of refusals) {
    it(`refuses ${what}`, async () => {
      const d = deps(over);
      assert.deepEqual(await registerBoard(input(fields), OWNER, d), { ok: false, error });
      assert.equal(d.rows.length, 0);
    });
  }

  it("never logs the address or the token when a board fails", async () => {
    const logged: unknown[][] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      await registerBoard(input(), OWNER, deps({ describe: async () => { throw new Error(`failed ${URL_OK} ${TOKEN}`); } }));
    } finally {
      console.error = real;
    }
    assert.equal(JSON.stringify(logged).includes(TOKEN), false);
    assert.equal(JSON.stringify(logged).includes("board.example.com"), false);
  });
});

describe("checkBoardAddress", () => {
  const publicLookup = async () => ["93.184.216.34"];
  const hosted = { hosted: true, lookup: publicLookup };

  it("takes https at a public address", async () => {
    assert.deepEqual(await checkBoardAddress(URL_OK, hosted), { ok: true, trust: "public_tls" });
  });

  for (const bad of ["http://board.example.com/mcp", "https://user:pw@board.example.com/mcp", "https://board.example.com/mcp?token=x", "https://board.example.com/mcp#x", "https://127.0.0.1/mcp", "https://10.0.0.5/mcp", "https://169.254.169.254/mcp", "https://[::1]/mcp", "https://localhost/mcp", "http://localhost:8765/mcp", "not a url", "ftp://board.example.com/"]) {
    it(`a hosted site refuses ${bad}`, async () => {
      assert.equal((await checkBoardAddress(bad, hosted)).ok, false);
    });
  }

  it("refuses a name that resolves to a private address", async () => {
    assert.equal((await checkBoardAddress("https://rebind.example.com/mcp", { hosted: true, lookup: async () => ["93.184.216.34", "10.0.0.1"] })).ok, false);
    assert.equal((await checkBoardAddress("https://gone.example.com/mcp", { hosted: true, lookup: async () => { throw new Error("no such host"); } })).ok, false);
  });

  it("off Vercel, a board on this machine is fine, and is marked loopback", async () => {
    assert.deepEqual(await checkBoardAddress("http://localhost:8765/mcp", { hosted: false }), { ok: true, trust: "loopback" });
    assert.equal((await checkBoardAddress("http://192.168.1.5:8765/mcp", { hosted: false, lookup: publicLookup })).ok, false);
  });
});

describe("linkedBoardFor", () => {
  const BOARD_ID = "00000000-0000-4000-8000-0000000000b1";
  function row(over: Partial<LinkedBoardRow> = {}, owner = OWNER): LinkedBoardRow {
    const url = sealSecret(URL_OK, RING, boardUrlAad(BOARD_ID, owner));
    const token = sealSecret(TOKEN, RING, boardTokenAad(BOARD_ID, owner));
    return { boardId: BOARD_ID, ownerUserId: owner, visitors: false, urlCiphertext: url.ciphertext, urlIv: url.iv, urlTag: url.tag, tokenCiphertext: token.ciphertext, iv: token.iv, tag: token.tag, keyVersion: token.keyVersion, ...over };
  }
  function linked(over: Partial<LinkedBoardDeps> = {}) {
    const health: boolean[] = [];
    const calls: string[] = [];
    const d: LinkedBoardDeps = {
      row: async () => row(),
      ring: () => RING,
      check: async () => ({ ok: true, trust: "public_tls" }),
      list: async () => [],
      call: async (config, name) => {
        calls.push(`${config.url} ${name}`);
        return { isError: false, content: [] };
      },
      health: async (_id, ok) => void health.push(ok),
      ...over,
    };
    return { d, health, calls };
  }

  const opened = async (d: LinkedBoardDeps) => (await linkedBoardFor("p1", d))?.open();

  it("opens the row and reaches that board", async () => {
    const { d, calls, health } = linked();
    const found = await linkedBoardFor("p1", d);
    assert.equal(found?.visitors, false);
    assert.equal(found?.ownerUserId, OWNER);
    await (await found?.open())?.callTool("read_sensor", {});
    assert.deepEqual(calls, [`${URL_OK} read_sensor`]);
    assert.deepEqual(health, [true]);
  });

  it("opens nothing and looks nothing up until someone the link lets in asks", async () => {
    let lookups = 0;
    let rings = 0;
    const { d } = linked({
      ring: () => {
        rings++;
        return RING;
      },
      check: async () => {
        lookups++;
        return { ok: true, trust: "public_tls" };
      },
    });
    const found = await linkedBoardFor("p1", d);
    assert.deepEqual([rings, lookups], [0, 0]);
    await found?.open();
    assert.deepEqual([rings, lookups], [1, 1]);
  });

  it("notes a failure, and gives the error back", async () => {
    const { d, health } = linked({ call: async () => { throw new Error("down"); } });
    await assert.rejects(async () => (await opened(d))?.callTool("read_sensor", {}), /down/);
    assert.deepEqual(health, [false]);
  });

  it("sends a prompt only to a Meta model, reading what the board runs first", async () => {
    const asked = (id: string | null) => {
      const paths: string[] = [];
      const doFetch = (async (url: URL | string) => {
        const { pathname } = new URL(url);
        paths.push(pathname);
        if (pathname === "/v1/models") return id ? Response.json({ data: [{ id }] }) : new Response("{}", { status: 503 });
        return Response.json({ choices: [{ message: { content: "pump on" } }] });
      }) as unknown as typeof fetch;
      const { d } = linked({ row: async () => row({ certSpkiSha256: "p".repeat(64) }), pinned: () => doFetch });
      return { d, paths };
    };
    const request = { model: "muse-glimmer-30b-IQ1_S", messages: [{ role: "user", content: "soil 22" }], maxTokens: 16 };
    for (const id of ["/home/x/models/Llama-3.2-3B-Q4_K_M.gguf", "nemotron-3.5-bolt-e4b", "glimmer-bolt-merge.gguf"]) {
      const { d, paths } = asked(id);
      assert.deepEqual(await (await opened(d))!.ask!(request), { kind: "not_meta" }, id);
      assert.deepEqual(paths, ["/v1/models"], `${id}: the prompt never went`);
    }
    const quiet = asked(null);
    assert.deepEqual(await (await opened(quiet.d))!.ask!(request), { kind: "no_model" }, "a board that doesn't say what it runs isn't asked");
    assert.deepEqual(quiet.paths, ["/v1/models"]);
    const meta = asked("/home/x/models/muse-glimmer-30b-IQ1_S.gguf");
    assert.deepEqual(await (await opened(meta.d))!.ask!(request), { kind: "answer", text: "pump on", running: "muse-glimmer-30b-IQ1_S" });
    assert.deepEqual(meta.paths, ["/v1/models", "/v1/chat/completions"]);
  });

  it("a health note that fails doesn't fail the call", async () => {
    const { d } = linked({ health: async () => { throw new Error("db down"); } });
    assert.deepEqual(await (await opened(d))?.callTool("read_sensor", {}), { isError: false, content: [] });
  });

  it("gives nothing with no link, no key, a row moved to another owner or board, or an address no longer public", async () => {
    const quiet = console.error;
    console.error = () => undefined;
    try {
      assert.equal(await linkedBoardFor("p1", linked({ row: async () => null }).d), null);
      assert.equal(await opened(linked({ ring: () => null }).d), null);
      assert.equal(await opened(linked({ ring: () => parseKeyring(newBoxKey()) }).d), null, "another key");
      assert.equal(await opened(linked({ row: async () => ({ ...row(), ownerUserId: "00000000-0000-4000-8000-000000000002" }) }).d), null, "copied to another owner");
      assert.equal(await opened(linked({ row: async () => ({ ...row(), boardId: "00000000-0000-4000-8000-0000000000b2" }) }).d), null, "copied to another board");
      assert.equal(await opened(linked({ check: async () => ({ ok: false }) }).d), null);
    } finally {
      console.error = quiet;
    }
  });
});
