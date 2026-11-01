/**
 * The product drive tools, through the real gadget route's handlers (docs/DRIVE_EXPORT.md, "From a product"): every refusal, then
 * the whole way from an own model to a finished export. Every board here is a fake. The approvals, the owner passes, ownModelFor's
 * logic, the drive kit, the plan and its Derivative check are the real ones. No model call, no network.
 *
 *   npx tsx --test lib/device/__tests__/drive-product.test.ts
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { DRIVE_TOOLS_MARKER, hardwareProofKey } from "@/lib/caps/hardware/limits";
import { ownModelFor, type OwnModelDeps } from "@/lib/caps/gpu/own-model";
import { driveToolsUsable } from "@/lib/caps/hardware/flags";
import { NEEDS_ERASE_WORDS, productDriveCall, type ProductDriveDeps } from "@/lib/device/drive-product";
import { loadKit, type DriveKit } from "@/lib/drive/kit";
import { readDriveTemplates, type PlanFile } from "@/lib/drive/plan";
import { GADGET_ID, handleGadgetCall, handleGadgetTools, PRODUCT_GADGET_TOOLS, type GadgetBoard, type GadgetDeps, type LinkedBoard } from "@/lib/gateway/gadget";
import { CLIENT_IP_HEADER, OWNER_HEADER, VISITOR_HEADER } from "@/lib/gateway/policy";
import { mintOwnerSession, ownerSubject } from "@/lib/tools/principal";
import { builtWithBlock } from "@/lib/train/hub-cards";
import type { LocalFiles } from "@/lib/train/local-files";

const LIVE = "mm_live_" + "a".repeat(30);
const OTHER_PRODUCT = "mm_live_" + "c".repeat(30);
const BUILD = "mm_build_" + "b".repeat(30);
const PLAIN = "mm_live_" + "d".repeat(30);
const NOW = new Date("2026-11-03T15:00:00Z");
const OWNER_ID = "owner-1";
const JOB = "8f1d2c3b-0000-4000-8000-000000000001";
const OTHER_JOB = "7a7a7a7a-0000-4000-8000-000000000002";
const R30B = "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit";
const PASS = { items: 20, tunedWins: 16, baseWins: 3, ties: 1, avgTunedScore: 8.5, avgBaseScore: 3.1 };
const MODELS = ["cap:hardware", DRIVE_TOOLS_MARKER];
const SECRET_LINK = "https://huggingface.co/signed/file?sig=do-not-show";

const tok = (id: string, scope: string, productId: string, allowedModels = MODELS, buildId?: string) => ({ id, productId, scope, allowedModels, dailyBudgetUsd: 3, buildId });
const TOKENS: Record<string, ReturnType<typeof tok>> = {
  [LIVE]: tok("live", "live", "prod-1"),
  [OTHER_PRODUCT]: tok("other", "live", "prod-2"),
  [BUILD]: tok("build", "build", "prod-1", MODELS, "build-1"),
  [PLAIN]: tok("plain", "live", "prod-1", [GADGET_ID, "cap:hardware"]),
};

const FILES = (slug = "bakery-helper"): LocalFiles => ({
  adapterJobId: JOB,
  quantJobId: "9e9e9e9e-0000-4000-8000-000000000009",
  repo: "musemuse/muse-glimmer-30b-bakery-helper-gguf-8f1d2c3b",
  commit: "c".repeat(40),
  public: true,
  files: [
    { level: "Q3_K_M", name: `muse-glimmer-30b-${slug}-Q3_K_M.gguf`, bytes: 12e9, sha256: "1".repeat(64) },
    { level: "Q4_K_M", name: `muse-glimmer-30b-${slug}-Q4_K_M.gguf`, bytes: 16e9, sha256: "2".repeat(64) },
  ],
  systemLine: "You are a bakery helper.\n\nReasoning strength: low.",
  needsTunedTemplate: false,
  title: "Bakery helper",
  slug,
  sparkOpen: true,
});

const STICK = { name: "sda", title: "SanDisk Ultra", bytes: 64e9, kind: "USB stick", filesystem: "exfat", label: "STICK", free: 60e9, read_only: false, identity: "5157500000000001", usable: true, why: null };

let kit: DriveKit;
let templates: Awaited<ReturnType<typeof readDriveTemplates>>;
let ownerHeaders: Record<string, string>;

type BoardState = { drives: unknown[]; export: Record<string, unknown> | null; runs: unknown[] };

function fakeBoard(state: BoardState, onExport?: (args: Record<string, unknown>) => void) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const board: GadgetBoard = {
    async listTools() {
      return ["describe_device", "drive_status", "export_source", "export_model", "erase_drive", "stop_export", "run_command"].map((name) => ({ name, inputSchema: {} }));
    },
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "drive_status") return { isError: false, content: [{ type: "text", text: JSON.stringify(state) }] };
      if (name === "export_model") {
        const id = args.export ?? (args.plan as { export: string }).export;
        if (args.plan) {
          onExport?.(args);
          state.export ??= { export: id, state: "checking" };
          return { isError: false, content: [{ type: "text", text: JSON.stringify({ export: id, state: state.export.state, folder: "x" }) }] };
        }
        return { isError: false, content: [{ type: "text", text: JSON.stringify({ export: id, state: state.export?.state }) }] };
      }
      return { isError: true, content: [{ type: "text", text: `${name} must never be called by a product.` }] };
    },
  };
  return { board, calls };
}

interface FixtureOptions {
  state?: Partial<BoardState>;
  link?: LinkedBoard | null;
  visitors?: boolean;
  own?: Record<string, string | null>;
  files?: LocalFiles | null;
  drive?: boolean;
  check?: boolean;
  card?: string;
  onExport?: (args: Record<string, unknown>) => void;
  hubThrows?: boolean;
}

function fixture(o: FixtureOptions = {}) {
  const state: BoardState = { drives: [STICK], export: null, runs: [{ run: "someone-elses-run", base: "x", adapter: "y" }], ...o.state };
  const { board, calls } = fakeBoard(state, o.onExport);
  const trace = { opened: 0, legacy: 0, linkRead: 0, spent: new Set<string>(), notes: [] as string[], localFiles: [] as string[], own: [] as string[] };
  const notes = new Map<string, Date>();
  const driveDeps: ProductDriveDeps = {
    ownModel: async (productId) => {
      trace.own.push(productId);
      const own = o.own ?? { "prod-1": JOB, "prod-2": OTHER_JOB };
      return own[productId] ? { adapterJobId: own[productId]! } : null;
    },
    localFiles: async (id) => {
      trace.localFiles.push(id);
      return o.files === undefined ? FILES() : o.files;
    },
    kit: async () => kit,
    planDeps: async () => ({
      templates,
      hubText: async () => {
        if (o.hubThrows) throw new Error(`boom ${SECRET_LINK}`);
        return o.card ?? `# Bakery helper GGUF\n\n${builtWithBlock("These files")}\n`;
      },
      hfToken: () => "hf-test-token",
      newId: () => "exp_0123456789ab",
    }),
    spendApproval: async (nonce) => {
      if (trace.spent.has(nonce)) return false;
      trace.spent.add(nonce);
      return true;
    },
    note: async (key, at) => {
      trace.notes.push(key);
      notes.set(key, at);
    },
    latestNote: async (key) => notes.get(key) ?? null,
    now: () => clock.now,
  };
  const clock = { now: NOW };
  const deps: GadgetDeps = {
    findToken: async (t) => (TOKENS[t] ?? null) as never,
    productStatus: async () => "live",
    hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 1])),
    board: () => {
      trace.legacy++;
      return board;
    },
    now: () => clock.now,
    ...(o.check === false
      ? {}
      : {
          linkedBoard: async () => {
            trace.linkRead++;
            if (o.link !== undefined) return o.link;
            return {
              ownerUserId: OWNER_ID,
              visitors: o.visitors ?? false,
              open: async () => {
                trace.opened++;
                return board;
              },
            };
          },
        }),
    ...(o.drive === false ? {} : { drive: { call: (call) => productDriveCall(call, driveDeps) } }),
  };
  return { deps, calls, state, trace, clock };
}

const post = (bearer: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://mm.example/api/gateway/gadget", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, [CLIENT_IP_HEADER]: "203.0.113.9", ...headers }, body: JSON.stringify(body) });
const get = (bearer: string, headers: Record<string, string> = {}) => new Request("https://mm.example/api/gateway/gadget", { headers: { authorization: `Bearer ${bearer}`, ...headers } });
const EXPORT = (over: Record<string, unknown> = {}) => ({ tool: "export_to_drive", arguments: { model: "own" }, ...over });
const STATUS = { tool: "drive_status", arguments: {} };
const errorCode = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;
type Envelope = { content: Array<{ text: string }>; isError: boolean; simulated: boolean };
const payload = async <T = Record<string, unknown>>(res: Response) => {
  assert.equal(res.status, 200);
  const body = (await res.json()) as Envelope;
  return { ...(JSON.parse(body.content[0].text) as T), envelope: body };
};
type Card = { ok: boolean; code: string; stale?: boolean; approval: { id: string; title: string; lines: string[] }; simulated?: boolean };

function boardTouched(f: ReturnType<typeof fixture>) {
  assert.equal(f.trace.opened, 0, "the board's secrets stayed sealed");
  assert.deepEqual(f.calls, [], "no board call");
  assert.equal(f.trace.legacy, 0, "DEVICE_MCP_URL's board was never read");
}

before(async () => {
  process.env.TOOLS_SIGNING_SECRET = "made-up-secret-for-the-drive-tools-0123456789";
  ownerHeaders = { [OWNER_HEADER]: mintOwnerSession({ productId: "prod-1", subject: ownerSubject(OWNER_ID) }, NOW).session };
  kit = { ...(await loadKit())!, baseUrl: "https://kit.test/drive-kit/" };
  templates = await readDriveTemplates();
});

describe("who may call the drive tools", () => {
  for (const [tool, body] of [["export_to_drive", EXPORT()], ["drive_status", STATUS]] as const) {
    it(`${tool}: a visitor gets the same 503 as no board, and touches nothing`, async () => {
      const f = fixture();
      const res = await handleGadgetCall(post(LIVE, body, { [VISITOR_HEADER]: "v1" }), f.deps);
      assert.equal(res.status, 503);
      assert.equal(await errorCode(res), "gadget_offline");
      boardTouched(f);
      assert.deepEqual(f.trace.own, [], "no model was looked up");
    });

    it(`${tool}: a link open to visitors opens nothing here, for a visitor or for anyone with no pass`, async () => {
      for (const headers of [{ [VISITOR_HEADER]: "v1" }, {}] as Array<Record<string, string>>) {
        const f = fixture({ visitors: true });
        const res = await handleGadgetCall(post(LIVE, body, headers), f.deps);
        assert.equal(res.status, 503);
        assert.equal(await errorCode(res), "gadget_offline");
        boardTouched(f);
      }
    });

    it(`${tool}: another owner's board, an admin's own pass, a forged pass and another product's pass all get the same 503`, async () => {
      const passes = [
        mintOwnerSession({ productId: "prod-1", subject: ownerSubject("some-admin") }, NOW).session,
        mintOwnerSession({ productId: "prod-1", subject: ownerSubject("former-owner") }, NOW).session,
        "os1.prod-1.forged.9999999999999.bad",
        mintOwnerSession({ productId: "prod-2", subject: ownerSubject(OWNER_ID) }, NOW).session,
      ];
      for (const pass of passes) {
        const f = fixture();
        const res = await handleGadgetCall(post(LIVE, body, { [OWNER_HEADER]: pass }), f.deps);
        assert.equal(res.status, 503, pass);
        assert.equal(await errorCode(res), "gadget_offline");
        boardTouched(f);
      }
    });

    it(`${tool}: no linked board is the same 503, even for a real owner's pass`, async () => {
      const f = fixture({ link: null });
      const res = await handleGadgetCall(post(LIVE, body, ownerHeaders), f.deps);
      assert.equal(res.status, 503);
      assert.equal(await errorCode(res), "gadget_offline");
      boardTouched(f);
    });
  }

  it("the board's other drive tools and commands stay unknown, even to the owner", async () => {
    for (const tool of ["export_source", "export_model", "erase_drive", "stop_export", "run_command", "install_model"]) {
      const f = fixture();
      const res = await handleGadgetCall(post(LIVE, { tool, arguments: {} }, ownerHeaders), f.deps);
      assert.equal(res.status, 400, tool);
      assert.equal(await errorCode(res), "unknown_tool");
      boardTouched(f);
    }
  });

  it("a token without the marker gets no drive tools, whatever else it has", async () => {
    const f = fixture();
    const res = await handleGadgetCall(post(PLAIN, EXPORT(), ownerHeaders), f.deps);
    assert.equal(res.status, 400);
    assert.equal(await errorCode(res), "unknown_tool");
    boardTouched(f);
  });

  it("GET lists them only for the owner and a build, and never the board's own definitions", async () => {
    const owner = fixture();
    const listed = (await (await handleGadgetTools(get(LIVE, ownerHeaders), owner.deps)).json()) as { tools: Array<{ name: string }>; simulated: boolean };
    assert.deepEqual(listed.tools.map((t) => t.name), ["drive_status", "export_to_drive"]);
    assert.equal(listed.simulated, false);
    boardTouched(owner);

    for (const headers of [{ [VISITOR_HEADER]: "v1" }, {}] as Array<Record<string, string>>) {
      const open = fixture({ visitors: true });
      assert.equal((await handleGadgetTools(get(LIVE, headers), open.deps)).status, 503);
      boardTouched(open);
    }

    const build = fixture();
    const sim = (await (await handleGadgetTools(get(BUILD), build.deps)).json()) as { tools: Array<{ name: string }>; simulated: boolean };
    assert.deepEqual(sim.tools.map((t) => t.name), ["drive_status", "export_to_drive"]);
    assert.equal(sim.simulated, true);
    boardTouched(build);
  });

  it("a visitor on an open link, on a token that also has board tools, still sees no drive tools", async () => {
    const f = fixture({ visitors: true });
    (TOKENS as Record<string, unknown>)["mm_live_mixed"] = tok("mixed", "live", "prod-1", [GADGET_ID, ...MODELS]);
    const listed = (await (await handleGadgetTools(get("mm_live_mixed", { [VISITOR_HEADER]: "v1" }), f.deps)).json()) as { tools: Array<{ name: string }> };
    assert.deepEqual(listed.tools.map((t) => t.name), ["describe_device"]);
    assert.equal((await handleGadgetCall(post("mm_live_mixed", EXPORT(), { [VISITOR_HEADER]: "v1" }), f.deps)).status, 503);
    assert.deepEqual(f.calls.filter((c) => c.name !== "listTools"), []);
    delete (TOKENS as Record<string, unknown>)["mm_live_mixed"];
  });
});

describe("with the flags off", () => {
  it("DRIVE_EXPORT_PRODUCTS alone, or the owner check alone, isn't enough", () => {
    const saved = { p: process.env.DRIVE_EXPORT_PRODUCTS, o: process.env.HARDWARE_GADGET_OWNER_CHECK };
    try {
      delete process.env.DRIVE_EXPORT_PRODUCTS;
      delete process.env.HARDWARE_GADGET_OWNER_CHECK;
      assert.equal(driveToolsUsable(), false);
      process.env.DRIVE_EXPORT_PRODUCTS = "1";
      assert.equal(driveToolsUsable(), false, "products without the owner check");
      delete process.env.DRIVE_EXPORT_PRODUCTS;
      process.env.HARDWARE_GADGET_OWNER_CHECK = "1";
      assert.equal(driveToolsUsable(), false, "the owner check without products");
      process.env.DRIVE_EXPORT_PRODUCTS = "1";
      assert.equal(driveToolsUsable(), true);
    } finally {
      for (const [k, v] of [["DRIVE_EXPORT_PRODUCTS", saved.p], ["HARDWARE_GADGET_OWNER_CHECK", saved.o]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("the route's deps carry no drive while they're off, and the three names don't change", async () => {
    assert.deepEqual([...PRODUCT_GADGET_TOOLS], ["describe_device", "capture_image", "record_audio"]);
    const f = fixture({ drive: false });
    for (const [token, headers] of [[LIVE, ownerHeaders], [BUILD, {}]] as const) {
      const res = await handleGadgetCall(post(token, EXPORT(), headers), f.deps);
      assert.equal(res.status, 403, "the token has no tool at all");
      assert.equal(await errorCode(res), "gadget_not_allowed");
    }
    boardTouched(f);
  });

  it("with the drive tools wired but no owner check, a live token and a build both get nothing, and the house board isn't touched", async () => {
    const f = fixture({ check: false });
    for (const [token, headers] of [[LIVE, ownerHeaders], [BUILD, {}]] as const) {
      const res = await handleGadgetCall(post(token, EXPORT(), headers), f.deps);
      assert.equal(res.status, 403);
      assert.equal(await errorCode(res), "gadget_not_allowed");
    }
    assert.equal(f.trace.legacy, 0);
  });

  it("a muse-gadget token with everything off answers as it did: drive_status isn't a tool", async () => {
    const f = fixture({ drive: false, check: false });
    const res = await handleGadgetCall(post(PLAIN, STATUS), f.deps);
    assert.equal(res.status, 400);
    assert.equal(await errorCode(res), "unknown_tool");
  });
});

describe("what export_to_drive takes", () => {
  it("only model, so no link, plan, drive or source can be handed in", async () => {
    for (const args of [
      { model: "own", url: SECRET_LINK },
      { model: "own", urls: { a: SECRET_LINK } },
      { model: "own", plan: { files: [] } },
      { model: "own", drive: "sda" },
      { model: "own", wait_for_drive: true },
      { model: "own", source: "url" },
      { model: SECRET_LINK },
      { model: `lab:${OTHER_JOB}:all` },
      { model: "board:someone-elses-run" },
      { model: "../../etc/passwd" },
      { model: 5 },
      {},
    ]) {
      const f = fixture();
      const res = await handleGadgetCall(post(LIVE, { tool: "export_to_drive", arguments: args }, ownerHeaders), f.deps);
      assert.equal(res.status, 400, JSON.stringify(args));
      assert.equal(await errorCode(res), "invalid_arguments");
      boardTouched(f);
    }
    const f = fixture();
    assert.equal((await handleGadgetCall(post(LIVE, { tool: "drive_status", arguments: { export: "x" } }, ownerHeaders), f.deps)).status, 400);
    assert.equal((await handleGadgetCall(post(LIVE, EXPORT({ approval: 5 }), ownerHeaders), f.deps)).status, 400);
    boardTouched(f);
  });

  it("another product's model is no model: same answer as an id nobody has, and no files are read", async () => {
    for (const model of [OTHER_JOB, "11111111-1111-4111-8111-111111111111"]) {
      const f = fixture();
      const res = await handleGadgetCall(post(LIVE, { tool: "export_to_drive", arguments: { model } }, ownerHeaders), f.deps);
      assert.equal(res.status, 404, model);
      assert.equal(await errorCode(res), "own_model_not_found");
      assert.deepEqual(f.trace.localFiles, []);
      boardTouched(f);
    }
  });

  it("with the real ownModelFor, one product's job never resolves for another", async () => {
    const owned: Record<string, string[]> = { "prod-1": [JOB], "prod-2": [OTHER_JOB] };
    const realDeps: OwnModelDeps = {
      fill: async () => undefined,
      jobs: (async (productId: string) => (owned[productId] ?? []).map((id) => ({ id, title: "t", params: { baseModel: R30B }, evalSummary: PASS, status: "succeeded", recipe: "glimmer-lora", createdAt: NOW }))) as unknown as OwnModelDeps["jobs"],
      source: (async (id: string) => ({ job: { id, recipe: "glimmer-lora", status: "succeeded", params: { baseModel: R30B } }, metrics: { cache_used: "yes", adapter_dir: `/cache/models/${id}` } })) as unknown as OwnModelDeps["source"],
      decisionModel: (async () => null) as unknown as OwnModelDeps["decisionModel"],
    };
    const f = fixture();
    const own = async (productId: string) => ownModelFor(productId, NOW, realDeps);
    assert.equal((await own("prod-1"))?.adapterJobId, JOB);
    assert.equal(await own("prod-3"), null);
    const deps: GadgetDeps = {
      ...f.deps,
      drive: {
        call: (call) =>
          productDriveCall(call, {
            ownModel: own,
            localFiles: async () => FILES(),
            kit: async () => kit,
            planDeps: async () => ({ templates, hubText: async () => "", hfToken: () => null }),
            spendApproval: async () => true,
            note: async () => undefined,
            latestNote: async () => null,
            now: () => NOW,
          }),
      },
    };
    const refused = await handleGadgetCall(post(LIVE, { tool: "export_to_drive", arguments: { model: OTHER_JOB } }, ownerHeaders), deps);
    assert.equal(await errorCode(refused), "own_model_not_found");
    const card = await payload<Card>(await handleGadgetCall(post(LIVE, { tool: "export_to_drive", arguments: { model: JOB } }, ownerHeaders), deps));
    assert.equal(card.code, "needs_confirmation");
  });

  it("a product with no model of its own, or no checked files yet, says so before touching the board", async () => {
    const none = fixture({ own: {} });
    assert.equal(await errorCode(await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), none.deps)), "own_model_not_found");
    boardTouched(none);
    const unready: Array<LocalFiles | null> = [null, { ...FILES(), repo: null }, { ...FILES(), files: [] }, { ...FILES(), adapterJobId: OTHER_JOB }];
    for (const files of unready) {
      const f = fixture({ files });
      assert.equal(await errorCode(await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps)), "own_model_not_ready");
      boardTouched(f);
    }
  });
});

describe("license duties", () => {
  it("a knowledge-named file without duties is refused before any card, and so is an own model whose files lost the mark", async () => {
    for (const slug of ["glimmer-r30b", "stage-b-run", "knowledge-model", "bakery-helper"]) {
      const f = fixture({ files: { ...FILES(slug), sparkOpen: false } });
      const res = await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps);
      assert.equal(res.status, 409, slug);
      const body = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, "license_duties_missing");
      assert.match(body.error.message, /Derivative of Muse Spark Open/);
      boardTouched(f);
    }
  });

  it("an r30b model reaches the board with its duties, on the admin route's plan, with the card saying so", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const f = fixture({ onExport: (a) => sent.push(a) });
    const card = await payload<Card>(await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps));
    assert.ok(card.approval.lines.some((l) => /Built with Muse Spark Open/.test(l) && /18 and over/.test(l) && /written by a person/.test(l) && /false premise/.test(l)), "the card has the usage points");
    const done = await payload<{ ok: boolean }>(await handleGadgetCall(post(LIVE, EXPORT({ approval: card.approval.id }), ownerHeaders), f.deps));
    assert.equal(done.ok, true);
    const plan = sent[0].plan as { files: PlanFile[]; title?: string };
    const paths = plan.files.map((p) => p.path);
    for (const p of ["licenses/MUSE_MODEL_LICENSE.md", "licenses/NOTICE", "licenses/Apache-2.0.txt", "licenses/USAGE_POLICY.md", "licenses/CHANGES.md"]) assert.ok(paths.includes(p), p);
    const text = (p: string) => (plan.files.find((x) => x.path === p) as { text: string }).text;
    for (const p of ["README.txt", "Start Here.html", "MODEL_CARD.md", "support/model.tsv"]) assert.match(text(p), /Built with Muse Spark Open/, p);
  });

  it("checkDerivativePlan really stands behind this: a plan missing a duty is refused, and nothing is spent or sent", async () => {
    const f = fixture();
    const saved = templates;
    const card = await payload<Card>(await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps));
    const lines: string[] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    // Drive pages that don't carry the Usage Policy's points, as a broken template would.
    templates = Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, typeof v === "string" ? v.replace(/\{\{(SPARK_OPEN_HTML|ABOUT_HTML|ABOUT_MORE_HTML|SPARK_OPEN[A-Z_]*|ABOUT[A-Z_]*)\}\}/g, "") : v])) as typeof templates;
    try {
      const res = await handleGadgetCall(post(LIVE, EXPORT({ approval: card.approval.id }), ownerHeaders), f.deps);
      assert.equal(res.status, 409);
      assert.equal(await errorCode(res), "plan_refused");
      assert.match(lines.join("\n"), /Derivative/);
    } finally {
      console.error = real;
      templates = saved;
    }
    assert.equal(f.trace.spent.size, 0);
    assert.ok(!f.calls.some((c) => c.name === "export_model"));
  });

  it("a plan that fails its own checks spends nothing and makes no export call", async () => {
    const f = fixture({ hubThrows: true });
    const card = await payload<Card>(await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps));
    const res = await handleGadgetCall(post(LIVE, EXPORT({ approval: card.approval.id }), ownerHeaders), f.deps);
    assert.equal(res.status, 409);
    assert.equal(await errorCode(res), "plan_refused");
    assert.equal(f.trace.spent.size, 0);
    assert.ok(!f.calls.some((c) => c.name === "export_model"));
  });
});

describe("confirming", () => {
  it("an unconfirmed export starts nothing, and shows the whole call on a card", async () => {
    const f = fixture();
    const card = await payload<Card>(await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps));
    assert.equal(card.ok, false);
    assert.equal(card.code, "needs_confirmation");
    assert.equal(card.approval.title, "Put this model on your drive?");
    assert.match(card.approval.lines.join("\n"), /Bakery helper[\s\S]*Q4_K_M, 16\.0 GB[\s\S]*SanDisk Ultra, 64\.0 GB/);
    assert.deepEqual(f.calls.map((c) => c.name), ["drive_status"]);
    assert.equal(f.trace.spent.size, 0);
  });

  it("an approval is good once, and only for this person, this model, this file and this drive", async () => {
    const first = fixture();
    const card = await payload<Card>(await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), first.deps));
    const id = card.approval.id;

    const exportCalls = (f: ReturnType<typeof fixture>) => f.calls.filter((c) => c.name === "export_model").length;
    const stale = async (f: ReturnType<typeof fixture>, approval: string) => {
      const answer = await payload<Card>(await handleGadgetCall(post(LIVE, EXPORT({ approval }), ownerHeaders), f.deps));
      assert.equal(answer.code, "needs_confirmation");
      assert.equal(answer.stale, true);
      assert.equal(exportCalls(f), 0);
      assert.equal(f.trace.spent.size, 0);
    };
    await stale(fixture({ state: { drives: [{ ...STICK, identity: "5157500000000002" }] } }), id);
    await stale(fixture({ files: { ...FILES(), files: [{ level: "Q4_K_M", name: "muse-glimmer-30b-bakery-helper-Q4_K_M.gguf", bytes: 16e9, sha256: "3".repeat(64) }] } }), id);
    await stale(fixture(), "ap1.made.up.approval");

    const late = fixture();
    late.clock.now = new Date(NOW.getTime() + 11 * 60_000);
    const pass = { [OWNER_HEADER]: mintOwnerSession({ productId: "prod-1", subject: ownerSubject(OWNER_ID) }, late.clock.now).session };
    const expired = await payload<Card>(await handleGadgetCall(post(LIVE, EXPORT({ approval: id }), pass), late.deps));
    assert.equal(expired.stale, true, "ten minutes");
    assert.equal(exportCalls(late), 0);

    const ok = await payload<{ ok: boolean }>(await handleGadgetCall(post(LIVE, EXPORT({ approval: id }), ownerHeaders), first.deps));
    assert.equal(ok.ok, true);
    assert.equal(exportCalls(first), 1);
    first.state.export = { export: "exp_0123456789ab", state: "done", result: "PASS" };
    const again = await payload<Card>(await handleGadgetCall(post(LIVE, EXPORT({ approval: id }), ownerHeaders), first.deps));
    assert.equal(again.code, "needs_confirmation");
    assert.equal(again.stale, true, "spent");
    assert.equal(exportCalls(first), 1);
  });

  it("an approval from another tool's card, or a build's, is no approval", async () => {
    const { mintApproval } = await import("@/lib/tools/sign");
    const f = fixture();
    const scope = { productId: "prod-1", subject: ownerSubject(OWNER_ID), slug: "GMAIL_SEND_EMAIL", args: { model: JOB, sha256: "2".repeat(64), drive: "sda", identity: STICK.identity } };
    const answer = await payload<Card>(await handleGadgetCall(post(LIVE, EXPORT({ approval: mintApproval(scope, NOW) }), ownerHeaders), f.deps));
    assert.equal(answer.stale, true);
    const sim = fixture();
    const simCard = await payload<Card>(await handleGadgetCall(post(BUILD, EXPORT()), sim.deps));
    const crossed = await payload<Card>(await handleGadgetCall(post(LIVE, EXPORT({ approval: simCard.approval.id }), ownerHeaders), fixture().deps));
    assert.equal(crossed.stale, true);
  });
});

describe("the drive", () => {
  it("has to be plugged in, and it says so plainly: there's no arming from a product", async () => {
    for (const drives of [[], [{ ...STICK, usable: false, why: "Another user has this drive open at /media/x, so it's left alone." }]]) {
      const f = fixture({ state: { drives } });
      const res = await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps);
      assert.equal(res.status, 409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, "no_drive");
      assert.match(body.error.message, /Plug the drive into your board first/);
      assert.match(body.error.message, /never waits for a drive/);
      assert.ok(!f.calls.some((c) => c.name === "export_model"));
    }
  });

  it("never sends wait_for_drive, and names the one drive it confirmed", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const f = fixture({ onExport: (a) => sent.push(a) });
    const card = await payload<Card>(await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps));
    await handleGadgetCall(post(LIVE, EXPORT({ approval: card.approval.id }), ownerHeaders), f.deps);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].wait_for_drive, undefined);
    assert.equal(sent[0].copies, undefined);
    assert.equal(sent[0].drive, "sda");
    assert.equal(sent[0].identity, STICK.identity);
  });

  it("more than one usable drive is refused rather than guessed", async () => {
    const f = fixture({ state: { drives: [STICK, { ...STICK, name: "sdb", identity: "5157500000000002" }] } });
    const res = await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps);
    assert.equal(await errorCode(res), "several_drives");
  });

  it("a drive that needs erasing answers needs_erase with the sentence, and nothing erases it", async () => {
    // The board moved to needs_erase after looking at the drive: the status says so.
    const f = fixture({ state: { export: { export: "exp_0123456789ab", state: "needs_erase", message: "This drive is FAT32 and /media/x...", erasable: true, source: `lab:${JOB}:Q4_K_M`, drive: { name: "sda", title: "SanDisk Ultra", bytes: 64e9, kind: "USB stick", filesystem: "vfat", label: "", identity: STICK.identity } } } });
    const status = await payload<{ export: { state: string; message: string; erasable?: boolean } }>(await handleGadgetCall(post(LIVE, STATUS, ownerHeaders), f.deps));
    assert.equal(status.export.state, "needs_erase");
    assert.equal(status.export.message, NEEDS_ERASE_WORDS);
    assert.match(status.export.message, /Confirm it on your board's page/);
    assert.equal(status.export.erasable, undefined);

    const again = await payload<{ ok: boolean; code: string; message: string }>(await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps));
    assert.equal(again.ok, false);
    assert.equal(again.code, "needs_erase");
    assert.match(again.message, /Confirm it on your board's page/);
    assert.ok(!f.calls.some((c) => c.name === "erase_drive" || c.name === "export_model" || c.name === "stop_export"));
  });

  it("the board answering needs_erase straight away reads the same", async () => {
    const f = fixture({
      onExport: () => {
        f.state.export = { export: "exp_0123456789ab", state: "needs_erase" };
      },
    });
    const card = await payload<Card>(await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps));
    const answer = await payload<{ code: string; message: string }>(await handleGadgetCall(post(LIVE, EXPORT({ approval: card.approval.id }), ownerHeaders), f.deps));
    assert.equal(answer.code, "needs_erase");
    assert.equal(answer.message, NEEDS_ERASE_WORDS);
    assert.ok(!f.calls.some((c) => c.name === "erase_drive"));
  });

  it("an export already going is left alone", async () => {
    const f = fixture({ state: { export: { export: "exp_aaaaaaaaaaaa", state: "writing" } } });
    assert.equal(await errorCode(await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps)), "export_busy");
    assert.ok(!f.calls.some((c) => c.name === "export_model" || c.name === "stop_export"));
  });

  it("a kit that isn't uploaded says so, and the board isn't reached", async () => {
    const f = fixture();
    const saved = kit;
    kit = { ...kit, baseUrl: null } as DriveKit;
    try {
      const res = await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps);
      assert.equal(res.status, 503);
      assert.equal(await errorCode(res), "drive_kit_missing");
      boardTouched(f);
    } finally {
      kit = saved;
    }
  });
});

describe("drive_status for the owner", () => {
  it("is read only, and shows no runs, drive identity, source, folder or link", async () => {
    const f = fixture({
      state: {
        drives: [{ ...STICK, usable: false, why: "Another user has this drive open at /media/secret/place, so it's left alone." }],
        export: { export: "exp_0123456789ab", state: "writing", folder: "/home/board/exports/x", source: "lab:other", file: "/secret/file", armed: true, done_bytes: 5, total_bytes: 10, mbps: 60, eta_s: 3, problems: [`bad ${SECRET_LINK}`], drive: { name: "sda", title: "SanDisk Ultra", bytes: 64e9, kind: "USB stick", filesystem: "exfat", label: "", identity: STICK.identity } },
      },
    });
    const res = await handleGadgetCall(post(LIVE, STATUS, ownerHeaders), f.deps);
    const raw = await res.clone().text();
    const status = await payload<{ drives: Array<{ title: string; why: string }>; export: { state: string; done_bytes: number } }>(res);
    assert.equal(status.drives[0].title, "SanDisk Ultra");
    assert.equal(status.export.state, "writing");
    assert.equal(status.export.done_bytes, 5);
    assert.equal(status.envelope.simulated, false);
    for (const leak of ["someone-elses-run", STICK.identity, "/media/secret", "/home/board", "lab:other", "do-not-show", "/secret/file", "armed", '"name"']) assert.ok(!raw.includes(leak), leak);
    assert.deepEqual(f.calls.map((c) => c.name), ["drive_status"]);
  });

  it("hands fresh links only to this product's own export waiting in needs_urls", async () => {
    const privateFiles = { ...FILES(), public: false };
    const signing = async (url: string) => new Response(null, { status: 302, headers: { location: `${url}?sig=fresh` } });
    const withSigning = (f: ReturnType<typeof fixture>, files = privateFiles): GadgetDeps => ({
      ...f.deps,
      drive: {
        call: (call) =>
          productDriveCall(call, {
            ownModel: async () => ({ adapterJobId: JOB }),
            localFiles: async () => files,
            kit: async () => kit,
            planDeps: async () => ({ templates, hubText: async () => "", hfToken: () => "hf-test-token", fetchImpl: signing as never }),
            spendApproval: async () => true,
            note: async () => undefined,
            latestNote: async () => null,
            now: () => NOW,
          }),
      },
    });
    const waiting = (source: string) => ({ state: { export: { export: "exp_0123456789ab", state: "needs_urls", source } } });

    const own = fixture(waiting(`lab:${JOB}:Q4_K_M`));
    await payload(await handleGadgetCall(post(LIVE, STATUS, ownerHeaders), withSigning(own)));
    const sent = own.calls.find((c) => c.name === "export_model");
    assert.ok(sent, "fresh links went");
    assert.ok(Object.values(sent!.args.urls as Record<string, string>).every((u) => u.includes("sig=fresh")));
    assert.equal(sent!.args.plan, undefined);

    for (const source of [`lab:${OTHER_JOB}:Q4_K_M`, "board:someone-elses-run", "url"]) {
      const other = fixture(waiting(source));
      await payload(await handleGadgetCall(post(LIVE, STATUS, ownerHeaders), withSigning(other)));
      assert.deepEqual(other.calls.map((c) => c.name), ["drive_status"], source);
    }
  });

  it("a board that fails answers the gadget's 502 with no address in it or in the log", async () => {
    const lines: string[] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      const link: LinkedBoard = {
        ownerUserId: OWNER_ID,
        visitors: false,
        open: async () => ({
          listTools: async () => [],
          callTool: async () => {
            throw new Error("fetch failed for https://secret-board.example.com/mcp");
          },
        }),
      };
      const res = await handleGadgetCall(post(LIVE, STATUS, ownerHeaders), fixture({ link }).deps);
      assert.equal(res.status, 502);
      const text = await res.text();
      assert.ok(!text.includes("secret-board"));
    } finally {
      console.error = real;
    }
    assert.ok(lines.length > 0);
    assert.ok(!lines.join("\n").includes("secret-board"), "not in the log");
  });

  it("a board's refusal keeps its sentence, without a link", async () => {
    const link: LinkedBoard = {
      ownerUserId: OWNER_ID,
      visitors: false,
      open: async () => ({
        listTools: async () => [],
        callTool: async () => ({ isError: true, content: [{ type: "text", text: `The board said no about ${SECRET_LINK}` }] }),
      }),
    };
    const res = await handleGadgetCall(post(LIVE, STATUS, ownerHeaders), fixture({ link }).deps);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "device_refused");
    assert.ok(!body.error.message.includes("do-not-show"));
  });
});

describe("a build token", () => {
  it("gets the simulated drive, with no board, no link read and no model read, and still has to confirm", async () => {
    const f = fixture();
    const before = await payload<{ drives: unknown[]; export: unknown; simulated: boolean }>(await handleGadgetCall(post(BUILD, STATUS), f.deps));
    assert.equal(before.simulated, true);
    assert.equal(before.envelope.simulated, true);
    assert.equal(before.export, null);
    assert.equal(before.drives.length, 1);

    const card = await payload<Card>(await handleGadgetCall(post(BUILD, EXPORT()), f.deps));
    assert.equal(card.code, "needs_confirmation");
    assert.equal(card.simulated, true);
    assert.deepEqual(f.trace.notes.filter((k) => k.includes("export_to_drive")), [], "unconfirmed, it didn't start");

    const started = await payload<{ ok: boolean; state: string; simulated: boolean }>(await handleGadgetCall(post(BUILD, EXPORT({ approval: card.approval.id })), f.deps));
    assert.equal(started.ok, true);
    assert.equal(started.state, "checking");
    assert.equal(started.simulated, true);
    assert.ok(f.trace.notes.includes(hardwareProofKey("export_to_drive", "build-1")), "the gateway's own record");

    f.clock.now = new Date(NOW.getTime() + 3_000);
    const writing = await payload<{ export: { state: string } }>(await handleGadgetCall(post(BUILD, STATUS), f.deps));
    assert.equal(writing.export.state, "writing");
    f.clock.now = new Date(NOW.getTime() + 60_000);
    const done = await payload<{ export: { state: string; result: string; message: string }; simulated: boolean }>(await handleGadgetCall(post(BUILD, STATUS), f.deps));
    assert.equal(done.simulated, true);
    assert.equal(done.export.state, "done");
    assert.equal(done.export.result, "PASS");
    assert.match(done.export.message, /Safe to unplug/);

    assert.deepEqual(f.calls, [], "no board call");
    assert.equal(f.trace.opened, 0);
    assert.equal(f.trace.linkRead, 0, "no link read");
    assert.equal(f.trace.legacy, 0, "no house board");
    assert.deepEqual(f.trace.own, []);
    assert.deepEqual(f.trace.localFiles, []);
  });

  it("names only its own model too", async () => {
    const f = fixture();
    const res = await handleGadgetCall(post(BUILD, { tool: "export_to_drive", arguments: { model: OTHER_JOB } }), f.deps);
    assert.equal(res.status, 404);
    assert.equal(await errorCode(res), "own_model_not_found");
  });
});

describe("the whole way", () => {
  it("own model, owner confirms, export runs on a fake board, status reads done", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const f = fixture({
      onExport: (a) => sent.push(a),
    });

    // The owner opens the product. The tools are listed for them.
    const listed = (await (await handleGadgetTools(get(LIVE, ownerHeaders), f.deps)).json()) as { tools: Array<{ name: string }> };
    assert.deepEqual(listed.tools.map((t) => t.name), ["drive_status", "export_to_drive"]);

    // The drive is in the board.
    const first = await payload<{ drives: Array<{ title: string; usable: boolean }>; export: null }>(await handleGadgetCall(post(LIVE, STATUS, ownerHeaders), f.deps));
    assert.deepEqual(first.drives.map((d) => [d.title, d.usable]), [["SanDisk Ultra", true]]);
    assert.equal(first.export, null);

    // Asking starts nothing.
    const card = await payload<Card>(await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps));
    assert.equal(card.code, "needs_confirmation");
    assert.equal(sent.length, 0);

    // The owner confirms.
    const started = await payload<{ ok: boolean; export: string; state: string }>(await handleGadgetCall(post(LIVE, EXPORT({ approval: card.approval.id }), ownerHeaders), f.deps));
    assert.deepEqual([started.ok, started.export, started.state], [true, "exp_0123456789ab", "checking"]);
    assert.equal(sent.length, 1);
    const plan = sent[0].plan as { export: string; files: PlanFile[] };
    assert.equal(plan.export, "exp_0123456789ab");
    const urls = sent[0].urls as Record<string, string>;
    assert.equal(urls["2".repeat(64)], `https://huggingface.co/${FILES().repo}/resolve/${"c".repeat(40)}/muse-glimmer-30b-bakery-helper-Q4_K_M.gguf`);
    assert.ok(plan.files.some((p) => p.path === "model/muse-glimmer-30b-bakery-helper-Q4_K_M.gguf"), "the product's own file");
    assert.ok(!plan.files.some((p) => p.path.includes("Q3_K_M")), "only the file on the card");

    // While it writes, the status shows its progress.
    f.state.export = { export: "exp_0123456789ab", state: "writing", done_bytes: 8e9, total_bytes: 16e9, mbps: 60, eta_s: 130, source: `lab:${JOB}:Q4_K_M`, folder: "/x" };
    const writing = await payload<{ export: { state: string; done_bytes: number; total_bytes: number } }>(await handleGadgetCall(post(LIVE, STATUS, ownerHeaders), f.deps));
    assert.deepEqual([writing.export.state, writing.export.done_bytes, writing.export.total_bytes], ["writing", 8e9, 16e9]);

    // A second export can't start on top of it.
    assert.equal(await errorCode(await handleGadgetCall(post(LIVE, EXPORT(), ownerHeaders), f.deps)), "export_busy");

    // Done.
    f.state.export = { export: "exp_0123456789ab", state: "done", message: "Done: PASS. Safe to unplug.", result: "PASS", problems: [], seconds: 300, source: `lab:${JOB}:Q4_K_M` };
    f.state.drives = [];
    const done = await payload<{ export: { state: string; result: string; message: string }; drives: unknown[]; envelope: Envelope }>(await handleGadgetCall(post(LIVE, STATUS, ownerHeaders), f.deps));
    assert.deepEqual([done.export.state, done.export.result, done.export.message], ["done", "PASS", "Done: PASS. Safe to unplug."]);
    assert.equal(done.envelope.simulated, false);

    // Only these reached the board, and DEVICE_MCP_URL's board never did.
    assert.deepEqual([...new Set(f.calls.map((c) => c.name))].sort(), ["drive_status", "export_model"]);
    assert.equal(f.trace.legacy, 0);
  });
});
