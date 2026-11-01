/**
 * Drives /api/device/drive and /api/device/drive/erase with auth, the board, the kit, the lab's files and the Hub faked:
 * every route is a 404 that touches nothing while DRIVE_EXPORT_ENABLED is off, guests never reach the board, a board run and
 * a lab model become a plan with a link for every file the board downloads, a private model's links are signed only when
 * needed and can't be armed, an export waiting in needs_urls gets fresh ones on GET, and no link, token or board address
 * appears in any answer or log line.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/device/__tests__/drive-route.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import type { DeviceToolResult } from "@/lib/device/client";
import type { BoardDrive, ExportStatus } from "@/lib/device/drive";
import { carryOnBody } from "@/lib/device/drive-card";
import type { DriveKit } from "@/lib/drive/kit";
import { fakeExtract, fakeFetch, sha, TEST_META, TEST_PIN } from "@/lib/drive/__tests__/fixtures";

const at = (p: string) => new URL(p, import.meta.url).href;
const URL_VALUE = "https://board.example/mcp";
/** Test values, not real secrets. */
const TOKEN_VALUE = "test-device-token";
const HF_VALUE = "hf_test_token_value";
const SIGNED = "https://cas-bridge.example/xet/abc?X-Amz-Signature=sig123&X-Amz-Expires=3600";
const JOB = "8f1d2c3b-0000-4000-8000-000000000001";
const REPO = "musemuse/muse-glimmer-30b-bakery-helper-gguf-8f1d2c3b";
const COMMIT = "c0ffee".padEnd(40, "0");

class FakeAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const text = (value: unknown, isError = false): DeviceToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError });

const ADAPTER = Buffer.from("GGUF adapter");
const BASE = Buffer.from("GGUF base");
const BOARD_SOURCE = {
  run: "support-coach",
  adapter: { name: "support-coach.gguf", bytes: ADAPTER.length, sha256: sha(ADAPTER) },
  bases: [{ name: "Llama-3.2-1B-Instruct-Q4_K_M.gguf", level: "Q4_K_M", bytes: BASE.length, sha256: sha(BASE), source: null }],
  config: { base: "Llama-3.2-1B-Instruct", dataset: "support-coach", steps: 60, rank: 8, lr: 0.0002, max_length: 512 },
  status: { examples: 49, skipped: 0, loss: 0.41, seconds: 812, peak_gpu_gib: 1.91 },
  base_revision: "23c69c53358a07516b5827588b3fdb12ae78fd65",
  system: "You are the support coach.",
  converter: "llama.cpp b11970 convert_lora_to_gguf.py, f32",
  board: { model: "NVIDIA Jetson Orin Nano Developer Kit", muse_device: "0.4.0" },
};
const DRIVE = { name: "sda", title: "SanDisk Ultra", bytes: 32e9, kind: "USB stick", filesystem: "exfat", label: "STICK", free: 30e9, read_only: false, identity: "0123456789abcdef", usable: true, why: null };

describe("/api/device/drive", { skip: typeof mock.module !== "function" }, () => {
  let admin = true;
  let authCalls = 0;
  let boardDown = false;
  let kit: DriveKit | null;
  let calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let replies: Record<string, DeviceToolResult> = {};
  let current: Record<string, unknown> | null = null;
  let lab: { public: boolean } = { public: true };
  let hubCalls: Array<{ url: string; init?: RequestInit }> = [];
  let logs: string[] = [];
  let tmp: string;
  let routes: typeof import("@/app/api/device/drive/route");
  let eraseRoute: typeof import("@/app/api/device/drive/erase/route");
  const realFetch = globalThis.fetch;
  const realInfo = console.info;
  const realError = console.error;

  const req = (method: string, body?: unknown, query = "") =>
    new Request(`http://x/api/device/drive${query}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const post = (body: unknown) => routes.POST(req("POST", body));
  const get = () => routes.GET();
  const del = (query = "") => routes.DELETE(req("DELETE", undefined, query));
  const erase = (body: unknown) => eraseRoute.POST(new Request("http://x/api/device/drive/erase", { method: "POST", body: JSON.stringify(body) }));
  const leaks = (s: string) => [URL_VALUE, TOKEN_VALUE, HF_VALUE, "sig123", "X-Amz"].filter((secret) => s.includes(secret));

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drive-route-"));
    const realKit = await import("@/lib/drive/kit");
    const llama = "LLAMA 3.2 COMMUNITY LICENSE AGREEMENT\n";
    const collected = await realKit.collectKit({
      cacheDir: tmp,
      fetchImpl: fakeFetch({ "https://hub.test/llama/LICENSE": llama }),
      extract: fakeExtract,
      pin: TEST_PIN,
      metaFiles: TEST_META,
      llamaFiles: [{ path: "licenses/LLAMA_3.2_LICENSE.txt", url: "https://hub.test/llama/LICENSE", sha256: sha(llama) }],
      families: ["glimmer", "llama"],
    });
    const uploaded: DriveKit = { ...collected.kit, baseUrl: "https://kit.test/drive-kit/" };
    mock.module(at("../../drive/kit.ts"), { namedExports: { ...realKit, loadKit: async () => kit } });
    mock.module(at("../../auth.ts"), {
      namedExports: {
        AuthError: FakeAuthError,
        requireAdmin: async () => {
          authCalls++;
          if (!admin) throw new FakeAuthError("Admins only.", 403);
          return { id: "admin-1", email: "a@example.com", isAdmin: true };
        },
      },
    });
    mock.module(at("../client.ts"), {
      namedExports: {
        deviceConfig: () => (process.env.DEVICE_MCP_URL ? { url: process.env.DEVICE_MCP_URL, token: TOKEN_VALUE } : null),
        callDeviceTool: async (_config: unknown, name: string, args: Record<string, unknown>) => {
          if (boardDown) throw new Error(`fetch failed for ${URL_VALUE} with ${TOKEN_VALUE}`);
          calls.push({ name, args });
          if (replies[name]) return replies[name];
          if (name === "drive_status") return text({ drives: [DRIVE], export: current, runs: [{ run: "support-coach", base: "Llama-3.2-1B-Instruct", adapter: "support-coach.gguf" }] });
          if (name === "export_source") return text(BOARD_SOURCE);
          if (name === "export_model") return text({ export: (args.plan as { export?: string })?.export ?? args.export, state: args.wait_for_drive ? "waiting_for_drive" : "checking" });
          if (name === "stop_export") return text({ export: args.export ?? "exp_000000000001", state: "stopped" });
          return text({ ok: true });
        },
      },
    });
    mock.module(at("../../train/local-files-server.ts"), {
      namedExports: {
        localFilesFor: async (jobId: string) =>
          jobId === JOB
            ? {
                adapterJobId: JOB,
                quantJobId: "9e9e9e9e-0000-4000-8000-000000000009",
                repo: REPO,
                commit: COMMIT,
                public: lab.public,
                files: [{ level: "Q4_K_M", name: "muse-glimmer-30b-bakery-helper-Q4_K_M.gguf", bytes: 16_940_000_000, sha256: "A".repeat(64) }],
                systemLine: "You are the bakery helper.\n\nReasoning strength: low.",
                needsTunedTemplate: false,
                title: "Bakery helper",
                slug: "bakery-helper",
              }
            : null,
      },
    });
    routes = await import("@/app/api/device/drive/route");
    eraseRoute = await import("@/app/api/device/drive/erase/route");
    kit = uploaded;
    (globalThis as { __uploadedKit?: DriveKit }).__uploadedKit = uploaded;
  });

  beforeEach(() => {
    admin = true;
    authCalls = 0;
    boardDown = false;
    kit = (globalThis as { __uploadedKit?: DriveKit }).__uploadedKit ?? null;
    calls = [];
    replies = {};
    current = null;
    lab = { public: true };
    hubCalls = [];
    logs = [];
    process.env.DRIVE_EXPORT_ENABLED = "1";
    process.env.DEVICE_MCP_URL = URL_VALUE;
    process.env.HF_TOKEN = HF_VALUE;
    console.info = (...parts: unknown[]) => void logs.push(parts.join(" "));
    console.error = (...parts: unknown[]) => void logs.push(parts.join(" "));
    // The Hub, for the card and for signing a private file's link. Anything else fails the test.
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      hubCalls.push({ url: String(url), init });
      if (String(url).endsWith("/raw/" + COMMIT + "/README.md")) return new Response("# Bakery helper GGUF\n");
      if (String(url).includes("/resolve/")) return new Response(null, { status: 302, headers: { location: SIGNED } });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
  });

  after(async () => {
    delete process.env.DRIVE_EXPORT_ENABLED;
    delete process.env.DEVICE_MCP_URL;
    delete process.env.HF_TOKEN;
    globalThis.fetch = realFetch;
    console.info = realInfo;
    console.error = realError;
    mock.reset();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("is a 404 that touches nothing while DRIVE_EXPORT_ENABLED is off", async () => {
    delete process.env.DRIVE_EXPORT_ENABLED;
    for (const res of [await get(), await post({ source: "board:support-coach", drive: "sda" }), await del(), await erase({ drive: "sda", identity: DRIVE.identity, confirm: "STICK" })]) {
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error, "not_found");
    }
    assert.equal(authCalls, 0, "not even the session");
    assert.deepEqual(calls, []);
    assert.deepEqual(hubCalls, []);
  });

  it("refuses anyone but an admin before touching the board, and says when no board is set up", async () => {
    admin = false;
    for (const res of [await get(), await post({ source: "board:support-coach", drive: "sda" }), await del(), await erase({ drive: "sda", identity: DRIVE.identity, confirm: "STICK" })]) {
      assert.equal(res.status, 403);
    }
    assert.deepEqual(calls, []);
    admin = true;
    delete process.env.DEVICE_MCP_URL;
    for (const res of [await get(), await post({ source: "board:support-coach", drive: "sda" })]) assert.equal((await res.json()).error, "device_not_configured");
  });

  it("lists the drives, the export and the runs, and says why a kit that isn't uploaded can't be used", async () => {
    const ready = await (await get()).json();
    assert.deepEqual(ready.drives, [DRIVE]);
    assert.equal(ready.kit, null);
    assert.equal(ready.runs[0].run, "support-coach");
    kit = { ...kit!, baseUrl: null };
    assert.match((await (await get()).json()).kit, /isn't uploaded yet/);
    const refused = await post({ source: "board:support-coach", drive: "sda" });
    assert.equal(refused.status, 503);
    assert.equal((await refused.json()).error, "drive_kit_missing");
    assert.ok(!calls.some((c) => c.name === "export_model"));
  });

  it("exports a board run now: its plan, a link for every kit file, and the drive picked", async () => {
    const res = await post({ source: "board:support-coach", mode: "now", drive: "sda", identity: DRIVE.identity });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const answer = await res.json();
    assert.match(answer.export, /^exp_[0-9a-f]{12}$/);
    assert.deepEqual(calls.map((c) => c.name), ["export_source", "export_model"]);
    const args = calls[1].args as { plan: { folder: string; source: string; files: Array<{ path: string; sha256: string; kit?: true; board?: string }> }; urls: Record<string, string>; drive: string; identity: string };
    assert.equal(args.plan.source, "board:support-coach");
    assert.match(args.plan.folder, /^MuseMuse\/support-coach-[0-9a-f]{4}$/);
    assert.deepEqual([args.drive, args.identity], ["sda", DRIVE.identity]);
    const kitShas = new Set(args.plan.files.filter((f) => f.kit).map((f) => f.sha256));
    assert.deepEqual(new Set(Object.keys(args.urls)), kitShas, "a link for each kit file, and only those");
    for (const url of Object.values(args.urls)) assert.match(url, /^https:\/\/kit\.test\/drive-kit\/[0-9a-f]{64}$/);
    assert.ok(args.plan.files.some((f) => f.board === "support-coach.gguf"));
    assert.ok(logs.some((l) => l.includes("admin-1") && l.includes("export_model")), "one line naming the admin and the tool");
    for (const line of logs) assert.deepEqual(leaks(line), [], line);
  });

  it("arms a board run for drives plugged in later, with copies, and never names a drive", async () => {
    const answer = await (await post({ source: "board:support-coach", mode: "arm", copies: 3 })).json();
    assert.equal(answer.state, "waiting_for_drive");
    const args = calls.find((c) => c.name === "export_model")!.args;
    assert.equal(args.wait_for_drive, true);
    assert.equal(args.copies, 3);
    assert.equal(args.drive, undefined);
  });

  it("exports a public lab model by its resolve links, with no token", async () => {
    const res = await post({ source: `lab:${JOB}:Q4_K_M`, mode: "arm" });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const args = calls.find((c) => c.name === "export_model")!.args as { urls: Record<string, string>; plan: { needsLargeFiles: boolean } };
    assert.equal(args.urls["a".repeat(64)], `https://huggingface.co/${REPO}/resolve/${COMMIT}/muse-glimmer-30b-bakery-helper-Q4_K_M.gguf`);
    assert.equal(args.plan.needsLargeFiles, true);
    assert.ok(hubCalls.every((c) => !JSON.stringify(c.init?.headers ?? {}).includes(HF_VALUE)), "a public repo needs no token");
  });

  it("signs a private lab model's links only to export now, never to arm, and shows the link to nobody", async () => {
    lab = { public: false };
    const armed = await post({ source: `lab:${JOB}:Q4_K_M`, mode: "arm" });
    assert.equal(armed.status, 409);
    assert.equal((await armed.json()).error, "cant_arm");
    calls = [];
    const res = await post({ source: `lab:${JOB}:Q4_K_M`, mode: "now", drive: "sda" });
    const body = await res.text();
    assert.equal(res.status, 200, body);
    const sign = hubCalls.find((c) => c.url.includes("/resolve/"))!;
    assert.equal(sign.init?.redirect, "manual");
    assert.equal((sign.init?.headers as Record<string, string>).authorization, `Bearer ${HF_VALUE}`);
    assert.equal((calls.find((c) => c.name === "export_model")!.args.urls as Record<string, string>)["a".repeat(64)], SIGNED, "the board gets the signed link");
    assert.deepEqual(leaks(body), []);
    for (const line of logs) assert.deepEqual(leaks(line), [], line);
  });

  it("gives an export waiting in needs_urls fresh links on GET", async () => {
    lab = { public: false };
    current = { export: "exp_00000000abcd", state: "needs_urls", source: `lab:${JOB}:Q4_K_M`, message: "The link for model/x.gguf expired." };
    const res = await get();
    const body = await res.text();
    assert.equal(JSON.parse(body).refreshed, true);
    const fresh = calls.find((c) => c.name === "export_model")!.args;
    assert.equal(fresh.export, "exp_00000000abcd");
    assert.equal((fresh.urls as Record<string, string>)["a".repeat(64)], SIGNED);
    assert.equal(fresh.plan, undefined, "only the links");
    assert.deepEqual(leaks(body), []);
    // A board run's export never needs signed links, the owner's own file is signed only on the owner's laptop, and a
    // public lab model's link is the same every time, which the board doesn't wait on: nothing is sent.
    lab = { public: true };
    for (const source of ["board:support-coach", "url", `lab:${JOB}:Q4_K_M`]) {
      calls = [];
      current = { export: "exp_00000000abcd", state: "needs_urls", source };
      assert.equal((await (await get()).json()).refreshed, false);
      assert.ok(!calls.some((c) => c.name === "export_model"));
    }
  });

  it("takes the owner's own file from their script, and never arms it", async () => {
    const file = { name: "glimmer-bakery-IQ1_S.gguf", level: "IQ1_S", bytes: 6_526_418_880, sha256: "23fef56a3bb9c7f3f2e513044cf11c88bf2d3cb3adfbc727c49288cea4fbafb4" };
    const body = { source: "url", url: SIGNED, file, title: "Muse Glimmer bakery helper (IQ1_S)", slug: "glimmer-bakery", systemLine: "", changes: ["Muse Muse fine-tuned it."] };
    assert.equal((await post({ ...body, mode: "arm" })).status, 409);
    const res = await post({ ...body, mode: "now", drive: "sda" });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const args = calls.find((c) => c.name === "export_model")!.args as { urls: Record<string, string>; plan: { source: string } };
    assert.equal(args.urls[file.sha256], SIGNED);
    assert.equal(args.plan.source, "url");
    assert.doesNotMatch(JSON.stringify(args.plan), /X-Amz|sig123/, "the plan names no link");
    assert.deepEqual(leaks(text), []);
    // The level goes into Start Here and the launchers' tables, so it's a level's name and nothing else.
    calls = [];
    for (const level of ["IQ1_S\tmac\t99", "IQ1_S\nwin", "<b>IQ1</b>", "", "Q4-K"]) {
      const res = await post({ ...body, file: { ...file, level }, mode: "now", drive: "sda" });
      assert.equal(res.status, 400, JSON.stringify(level));
    }
    assert.ok(!calls.some((c) => c.name === "export_model"));
  });

  it("refuses a knowledge-run file without its license texts, and sends each text's link with them", async () => {
    const file = { name: "glimmer-stage-b-r30b-IQ1_S.gguf", level: "IQ1_S", bytes: 6_526_418_912, sha256: "6fbd323c1c9947bcd9f678bdda106fafcc7485aa3c7dd9759ac4250d56a7e561" };
    const body = { source: "url", url: SIGNED, file, title: "Muse Glimmer 2026 knowledge (r30b, IQ1_S)", slug: "glimmer-r30b", systemLine: "", changes: ["Muse Muse fine-tuned it."], mode: "now", drive: "sda" };
    const derivative = {
      files: { license: { bytes: 900, sha256: "1".repeat(64) }, usagePolicy: { bytes: 800, sha256: "2".repeat(64) }, notice: { bytes: 90, sha256: "3".repeat(64) } },
      dangers: { madeUpPct: 55.3, honestPct: 44.7, falsePremisePct: 80 },
    };
    const derivativeUrls = { license: `${SIGNED}&f=1`, usagePolicy: `${SIGNED}&f=2`, notice: `${SIGNED}&f=3` };
    calls = [];
    // Stage 2 counts too, and so does a slug or a title alone.
    for (const bad of [body, { ...body, file: { ...file, name: "glimmer-stage2-IQ1_S.gguf" } }, { ...body, file: { ...file, name: "x-IQ1_S.gguf" } }]) {
      assert.equal((await post(bad)).status, 400);
    }
    for (const key of ["license", "usagePolicy", "notice"] as const) {
      const files = { ...derivative.files } as Record<string, unknown>;
      delete files[key];
      assert.equal((await post({ ...body, derivative: { ...derivative, files }, derivativeUrls })).status, 400, key);
      const urls = { ...derivativeUrls } as Record<string, unknown>;
      delete urls[key];
      assert.equal((await post({ ...body, derivative, derivativeUrls: urls })).status, 400, key);
    }
    assert.equal((await post({ ...body, derivative: { ...derivative, dangers: { madeUpPct: 55.3 } }, derivativeUrls })).status, 400);
    assert.ok(!calls.some((c) => c.name === "export_model"));
    const res = await post({ ...body, derivative, derivativeUrls });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const args = calls.find((c) => c.name === "export_model")!.args as { urls: Record<string, string>; plan: { files: Array<{ path: string; sha256: string; url?: true }> } };
    for (const [key, path] of [["license", "licenses/MUSE_MODEL_LICENSE.md"], ["usagePolicy", "licenses/MUSE_USAGE_POLICY.md"], ["notice", "licenses/NOTICE"]] as const) {
      const f = args.plan.files.find((x) => x.path === path)!;
      assert.equal(f.sha256, derivative.files[key].sha256);
      assert.equal(f.url, true);
      assert.equal(args.urls[f.sha256], derivativeUrls[key]);
    }
    assert.deepEqual(leaks(text), []);
  });

  it("carries on an export that stopped, on a drive from the list, from the card's Carry on", async () => {
    current = { export: "exp_00000000abcd", state: "failed", source: "board:support-coach", drive: DRIVE };
    const res = await post(carryOnBody(current as unknown as ExportStatus, DRIVE as BoardDrive));
    assert.equal(res.status, 200, await res.clone().text());
    const args = calls.find((c) => c.name === "export_model")!.args as { export: string; drive: string; urls: Record<string, string> };
    assert.deepEqual([args.export, args.drive], ["exp_00000000abcd", "sda"]);
    assert.ok(Object.keys(args.urls).length > 10, "the kit's links, in case the board hasn't cached it");
  });

  it("refuses bad input before the board", async () => {
    for (const body of [
      { source: "board:../x", drive: "sda" },
      { source: "lab:not-a-uuid:Q4_K_M", drive: "sda" },
      { source: "board:support-coach" },
      { source: "board:support-coach", drive: "/dev/sda" },
      { source: "board:support-coach", drive: "sda", identity: "x" },
      { source: "board:support-coach", mode: "arm", copies: 11 },
      { source: "board:support-coach", mode: "now", drive: "sda", copies: 2 },
      { source: "board:support-coach", mode: "later" },
      { resume: "exp_bad", drive: "sda" },
    ]) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.ok(!calls.some((c) => c.name === "export_model"));
  });

  it("passes the board's refusal on as a sentence, and a missing run as a 404", async () => {
    replies.export_model = text("Export exp_000000000001 is still going. Wait for it, or stop it first.", true);
    const refused = await post({ source: "board:support-coach", drive: "sda" });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).message, /still going/);
    replies = { export_source: text("Run nope is failed, so it has nothing to put on a drive yet.", true) };
    const missing = await post({ source: "board:nope", drive: "sda" });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "source_not_found");
  });

  it("says the board is unavailable without its address or token", async () => {
    boardDown = true;
    for (const res of [await get(), await post({ source: "board:support-coach", drive: "sda" }), await del()]) {
      assert.equal(res.status, 502);
      assert.deepEqual(leaks(await res.text()), []);
    }
    for (const line of logs) assert.deepEqual(leaks(line), [], line);
  });

  it("stops an export, and erases only with the typed word, which the board checks again", async () => {
    assert.equal((await (await del("?export=exp_00000000abcd")).json()).state, "stopped");
    assert.deepEqual(calls.at(-1), { name: "stop_export", args: { export: "exp_00000000abcd" } });
    assert.equal((await del("?export=../x")).status, 400);
    assert.equal((await erase({ drive: "sda", identity: DRIVE.identity })).status, 400, "no word, no erase");
    assert.equal((await erase({ drive: "sda", identity: "nope", confirm: "STICK" })).status, 400);
    assert.ok(!calls.some((c) => c.name === "erase_drive"));
    assert.equal((await erase({ drive: "sda", identity: DRIVE.identity, confirm: " STICK " })).status, 200);
    assert.deepEqual(calls.at(-1), { name: "erase_drive", args: { drive: "sda", identity: DRIVE.identity, confirm: "STICK" } });
    replies.erase_drive = text("To erase it, type STICK exactly. Nothing was erased.", true);
    const wrong = await erase({ drive: "sda", identity: DRIVE.identity, confirm: "stick" });
    assert.equal(wrong.status, 409);
    assert.match((await wrong.json()).message, /Nothing was erased/);
  });
});
