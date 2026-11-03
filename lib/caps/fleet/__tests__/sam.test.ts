/**
 * {GATEWAY_URL}/fleet/v1/segment (lib/caps/fleet/sam.ts): the flag, the settings, who may look, the request, the commands that
 * reach the board, the limits, and every way a look ends, on a fake control plane. No board, no database, no network.
 *
 *   npx tsx --test lib/caps/fleet/__tests__/sam.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FLEET_SAM_LIMITS, FLEET_SAM_USAGE_MODEL, PIECE_CHARS, fleetSamSettings, handleFleetSegment, lookCommands, quote, type FleetSamDeps } from "@/lib/caps/fleet/sam";

const NOW = new Date("2026-11-03T15:00:00Z");
const SETTINGS = { BOARD_FLEET_URL: "https://fleet.example/admin", BOARD_FLEET_TOKEN: "jpt_madeup", FLEET_SAM_NODE: "nd_madeup04" };
const ID = "0123456789ab";
/** A JPEG's base64 starts /9j/. Not a real photo: the fake board never decodes it. */
const PHOTO = "/9j/" + "A".repeat(40_000);
const BOARD = { prompt: "open door", count: 1, objects: [{ box: [10, 20, 110, 220], score: 0.89, area_px: 9000 }], ms: 1420, image_size: [640, 480], overlay_jpeg_b64: "/9j/tinted" };

let jobs: Array<{ command: string; node: string; timeout: number }>;
let polls: number;
let usage: Array<{ endpoint: string; model: string; costUsd: number }>;
let counts: Record<string, number>;
let slots: Record<string, number>;
let logged: string[];
let headersSeen: Headers[];
const realError = console.error;

type Board = (command: string) => { status: string; output?: string } | "http500";

function deps(over: Partial<FleetSamDeps> = {}, board: Board = (c) => ({ status: "succeeded", output: c.startsWith("python3") ? `noise\nSAMRESULT ${JSON.stringify(BOARD)}\n` : "" })): FleetSamDeps {
  const byId = new Map<string, string>();
  return {
    on: () => true,
    allProducts: () => false,
    settings: () => fleetSamSettings(SETTINGS),
    adminEmails: ["admin@example.com"],
    findToken: async () => ({ id: "t1", productId: "p1", scope: "live", allowedModels: ["muse-wonder-1.0", "sam-3.1"], dailyBudgetUsd: 1, buildId: null }),
    product: async () => ({ status: "live", manifest: null, liveUrl: null, takenDownAt: null, ownerId: "u1", ownerEmail: "admin@example.com", ownerIsAdmin: true, ownerBannedAt: null }),
    hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, (counts[k] = (counts[k] ?? 0) + 1)])),
    acquireInFlight: async (key, limit) => {
      if ((slots[key] ?? 0) >= limit) return null;
      slots[key] = (slots[key] ?? 0) + 1;
      return NOW;
    },
    releaseInFlight: async (key) => {
      slots[key] = (slots[key] ?? 0) - 1;
    },
    recordUsage: async (ctx, items) => {
      for (const i of items) usage.push({ endpoint: ctx.endpoint, model: i.model, costUsd: i.costUsd });
    },
    fetch: (async (url: string, init: RequestInit) => {
      headersSeen.push(new Headers(init.headers));
      const path = String(url).replace("https://fleet.example/admin", "");
      if (path === "/api/jobs" && init.method === "POST") {
        const body = JSON.parse(String(init.body)) as { node_ids: string[]; params: { command: string }; timeout_s: number };
        const id = `jb_${jobs.length}`;
        jobs.push({ command: body.params.command, node: body.node_ids[0]!, timeout: body.timeout_s });
        byId.set(id, body.params.command);
        return Response.json({ job_id: id });
      }
      const m = /^\/api\/jobs\/(jb_\d+)$/.exec(path);
      if (m) {
        polls++;
        const answer = board(byId.get(m[1]!)!);
        if (answer === "http500") return new Response("boom", { status: 500 });
        return Response.json({ status: answer.status, tasks: [{ status: answer.status, output: answer.output ?? "" }] });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
    now: () => NOW,
    sleep: async () => undefined,
    id: () => ID,
    ...over,
  };
}

const LOOK = { image_b64: PHOTO, prompt: "open door", threshold: 0.5, overlay: true };
const call = (body: unknown = LOOK, method = "POST") =>
  new Request("https://platform.example/api/gateway/fleet/v1/segment", {
    method,
    headers: { authorization: "Bearer mm_live_x" },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
const code = async (res: Response) => ((await res.clone().json()) as { error: { code: string } }).error.code;

beforeEach(() => {
  jobs = [];
  polls = 0;
  usage = [];
  counts = {};
  slots = {};
  logged = [];
  headersSeen = [];
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
});
afterEach(() => {
  console.error = realError;
});

describe("the flag and the settings", () => {
  it("is 404 unknown_endpoint with the flag off, and nothing is touched", async () => {
    const boom = () => {
      throw new Error("touched");
    };
    const res = await handleFleetSegment(call(), deps({ on: () => false, findToken: boom, product: boom, settings: boom, fetch: boom as unknown as typeof fetch }));
    assert.equal(res.status, 404);
    assert.equal(await code(res), "unknown_endpoint");
  });

  it("needs all three settings, an https /admin address and a jpt_ token, and answers 503 fleet_closed otherwise", async () => {
    assert.deepEqual(fleetSamSettings(SETTINGS), { url: "https://fleet.example/admin", token: "jpt_madeup", node: "nd_madeup04" });
    const wrong = [
      { BOARD_FLEET_URL: undefined },
      { BOARD_FLEET_TOKEN: undefined },
      { FLEET_SAM_NODE: undefined },
      { BOARD_FLEET_URL: "http://fleet.example/admin" },
      { BOARD_FLEET_URL: "https://fleet.example/" },
      { BOARD_FLEET_URL: "https://user:pw@fleet.example/admin" },
      { BOARD_FLEET_TOKEN: "jik_madeup" },
      { FLEET_SAM_NODE: "jetson-04; reboot" },
    ];
    for (const w of wrong) {
      assert.equal(fleetSamSettings({ ...SETTINGS, ...w }), null, JSON.stringify(w));
      const res = await handleFleetSegment(call(), deps({ settings: () => fleetSamSettings({ ...SETTINGS, ...w }) }));
      assert.equal(await code(res), "fleet_closed", JSON.stringify(w));
    }
    assert.equal(jobs.length, 0);
  });
});

describe("who may look", () => {
  it("refuses a missing or unknown token", async () => {
    const res = await handleFleetSegment(new Request("https://platform.example/x", { method: "POST", body: "{}" }), deps());
    assert.equal(res.status, 401);
    assert.equal((await handleFleetSegment(call(), deps({ findToken: async () => null }))).status, 401);
  });

  it("refuses a product whose brief doesn't use SAM 3.1", async () => {
    const res = await handleFleetSegment(call(), deps({ findToken: async () => ({ id: "t", productId: "p1", scope: "live", allowedModels: ["muse-wonder-1.0"], dailyBudgetUsd: 1, buildId: null }) }));
    assert.equal(await code(res), "sam_not_allowed");
    assert.equal(jobs.length, 0);
  });

  it("gives a build's token 503, so builds and drills never reach the board and read it as the board down", async () => {
    const res = await handleFleetSegment(call(), deps({ findToken: async () => ({ id: "t", productId: "p1", scope: "build", allowedModels: ["sam-3.1"], dailyBudgetUsd: 1, buildId: "b1" }) }));
    assert.equal(res.status, 503);
    assert.equal(await code(res), "fleet_sam_build");
    assert.equal(jobs.length, 0);
  });

  it("is the platform's own products only, unless FLEET_ALL_PRODUCTS", async () => {
    const builder = async () => ({ status: "live" as const, manifest: null, liveUrl: null, takenDownAt: null, ownerId: "u", ownerEmail: "someone@example.com", ownerIsAdmin: false, ownerBannedAt: null });
    assert.equal(await code(await handleFleetSegment(call(), deps({ product: builder }))), "sam_not_allowed");
    assert.equal(jobs.length, 0);
    const res = await handleFleetSegment(call(), deps({ product: builder, allProducts: () => true }));
    assert.equal(res.status, 200);
  });

  it("refuses a turned-off product", async () => {
    const off = async () => ({ status: "disabled" as const, manifest: null, liveUrl: null, takenDownAt: null, ownerId: "u1", ownerEmail: "admin@example.com", ownerIsAdmin: true, ownerBannedAt: null });
    assert.equal(await code(await handleFleetSegment(call(), deps({ product: off }))), "product_disabled");
  });
});

describe("the request", () => {
  it("takes only a JPEG or PNG in base64, a plain prompt, a threshold and overlay", async () => {
    const cases: Array<[unknown, string]> = [
      ["not json", "invalid_body"],
      [[1], "invalid_body"],
      [{ ...LOOK, extra: 1 }, "invalid_arguments"],
      [{ ...LOOK, image_b64: "R0lGODlh" + "A".repeat(10) }, "invalid_image"],
      [{ ...LOOK, image_b64: "/9j/AAA$(reboot)" }, "invalid_image"],
      [{ ...LOOK, image_b64: "/9j/" + "A".repeat(FLEET_SAM_LIMITS.maxImageB64) }, "invalid_image"],
      [{ ...LOOK, prompt: "" }, "invalid_prompt"],
      [{ ...LOOK, prompt: "door'; reboot; echo '" }, "invalid_prompt"],
      [{ ...LOOK, prompt: "door $(id)" }, "invalid_prompt"],
      [{ ...LOOK, prompt: "door\nreboot" }, "invalid_prompt"],
      [{ ...LOOK, prompt: "x".repeat(201) }, "invalid_prompt"],
      [{ ...LOOK, threshold: 2 }, "invalid_arguments"],
      [{ ...LOOK, overlay: "yes" }, "invalid_arguments"],
    ];
    for (const [body, want] of cases) assert.equal(await code(await handleFleetSegment(call(body), deps())), want, JSON.stringify(body).slice(0, 80));
    assert.equal(jobs.length, 0);
  });

  it("refuses GET", async () => {
    assert.equal((await handleFleetSegment(call(undefined, "GET"), deps())).status, 405);
  });
});

describe("what reaches the board", () => {
  it("sends the photo in pieces under the command limit, then asks ask.py, all on the SAM node", async () => {
    const res = await handleFleetSegment(call(), deps());
    assert.equal(res.status, 200);
    const pieces = Math.ceil(PHOTO.length / PIECE_CHARS);
    assert.equal(jobs.length, pieces + 1);
    for (const j of jobs) {
      assert.equal(j.node, "nd_madeup04");
      assert.ok(j.command.length <= 16_384, "under the control plane's command limit");
    }
    assert.equal(jobs.slice(0, -1).map((j) => j.command.match(/'([^']*)'/)![1]).join(""), PHOTO, "the pieces join back into the photo");
    assert.match(jobs[0]!.command, /^mkdir -p \/tmp\/sam-ui\/0123456789ab && printf %s '\/9j\/A+' > \/tmp\/sam-ui\/0123456789ab\/000$/);
    assert.equal(jobs.at(-1)!.command, "python3 /opt/sam3/ask.py 0123456789ab 'open door' 0.500");
    for (const h of headersSeen) assert.equal(h.get("authorization"), "Bearer jpt_madeup");
  });

  it("answers in the board service's shape, with the picture only when asked", async () => {
    const res = await handleFleetSegment(call(), deps());
    assert.deepEqual(await res.json(), BOARD);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const plain = await handleFleetSegment(call({ ...LOOK, overlay: false }), deps());
    assert.equal(((await plain.json()) as Record<string, unknown>).overlay_jpeg_b64, undefined);
    assert.deepEqual(usage.at(-1), { endpoint: "/fleet/v1/segment", model: FLEET_SAM_USAGE_MODEL, costUsd: 0 });
  });

  it("quotes any text as one shell word, and makes no command from a bad id", () => {
    assert.equal(quote("it's"), `'it'\\''s'`);
    assert.throws(() => lookCommands({ b64: "/9j/A", prompt: "x", threshold: 0.5, overlay: false }, "../../etc"));
  });
});

describe("how a look ends", () => {
  it("gives 502 board_error when ask.py reports an error or prints no result", async () => {
    for (const output of [`SAMRESULT ${JSON.stringify({ error: "URLError: refused" })}`, "nothing here", "SAMRESULT {not json"]) {
      const res = await handleFleetSegment(call(), deps({}, (c) => ({ status: "succeeded", output: c.startsWith("python3") ? output : "" })));
      assert.equal(res.status, 502, output);
      assert.equal(await code(res), "board_error");
    }
    assert.ok(logged.every((l) => !l.includes("/9j/") && !l.includes("open door")), "the photo and prompt are never logged");
  });

  it("gives 502 when a piece's job fails, and asks nothing after it", async () => {
    const res = await handleFleetSegment(call(), deps({}, () => ({ status: "failed" })));
    assert.equal(await code(res), "board_error");
    assert.equal(jobs.length, 1);
  });

  it("gives 502 fleet_unavailable when the control plane errors", async () => {
    const res = await handleFleetSegment(call(), deps({}, () => "http500"));
    assert.equal(await code(res), "fleet_unavailable");
  });

  it("waits for a running job, then reads it", async () => {
    let n = 0;
    const res = await handleFleetSegment(call({ ...LOOK, image_b64: "/9j/AAAA" }), deps({}, (c) => (++n < 3 ? { status: "running" } : { status: "succeeded", output: c.startsWith("python3") ? `SAMRESULT ${JSON.stringify(BOARD)}` : "" })));
    assert.equal(res.status, 200);
    assert.ok(polls >= 3);
  });

  it("looks at one photo at a time, and gives the slot back either way", async () => {
    slots["fleetsam:flight:all"] = 1;
    assert.equal(await code(await handleFleetSegment(call(), deps())), "busy");
    slots["fleetsam:flight:all"] = 0;
    await handleFleetSegment(call(), deps({}, () => "http500"));
    assert.equal(slots["fleetsam:flight:all"], 0);
  });

  it("stops at the day's limits, before the board", async () => {
    counts["fleetsam:product:p1"] = FLEET_SAM_LIMITS.perProductPerDay;
    assert.equal(await code(await handleFleetSegment(call(), deps())), "rate_limited");
    assert.equal(jobs.length, 0);
  });
});
