/**
 * Drives /api/device/rover and /api/device/rover/drive with auth faked, the fleet faked (rover-fakes.ts) and the rover's
 * MCP server faked: every route is a 404 that touches nothing while ROVER_ENABLED is off, only a signed-in admin reaches
 * the fleet, a setup comes back with its report, the drive pad stays within its limits, and neither token nor the fleet's
 * address appears in any reply or log line.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/device/__tests__/rover-route.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import type { DeviceConfig, DeviceToolResult } from "@/lib/device/client";
import { BOARD_TOKEN, FLEET_TOKEN, FLEET_URL, fakeFleet, type FakeFleet } from "./rover-fakes";

const at = (p: string) => new URL(p, import.meta.url).href;

class FakeAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** What the rover's muse-device server lists: its rover tools, and the board's others. */
const BOARD_LIST = ["describe_device", "capture_image", "record_audio", "run_command", "drive", "stop", "look", "ranges", "rover_status"];
const ROVER_TOOLS = ["rover_photo", "rover_drive", "rover_stop", "rover_look", "rover_ranges", "rover_status"];

describe("/api/device/rover", { skip: typeof mock.module !== "function" }, () => {
  let admin = true;
  let openAccess = false;
  let authCalls = 0;
  let fleet: FakeFleet;
  let mcp: Array<{ config: DeviceConfig; name: string; args?: Record<string, unknown> }> = [];
  let mcpDown = false;
  let toolReply: DeviceToolResult = { content: [{ type: "text", text: "ok" }], isError: false };
  let logs: string[] = [];
  let routes: typeof import("@/app/api/device/rover/route");
  let drive: typeof import("@/app/api/device/rover/drive/route");
  // Loaded after the mocks, like the routes, so it's the same module they use.
  let resetRover: () => void;
  let kitDir: string;
  let emptyDir: string;
  const realFetch = globalThis.fetch;
  const realCwd = process.cwd();
  const realError = console.error;
  const realInfo = console.info;

  const post = (body: unknown = {}) => routes.POST(new Request("http://x/api/device/rover", { method: "POST", body: JSON.stringify(body) }));
  const get = (query = "") => routes.GET(new Request(`http://x/api/device/rover${query}`));
  const act = (body: unknown) => drive.POST(new Request("http://x/api/device/rover/drive", { method: "POST", body: JSON.stringify(body) }));
  const leaks = (text: string) => [BOARD_TOKEN, FLEET_TOKEN, "fleet.example.com"].filter((secret) => text.includes(secret));

  before(async () => {
    mock.module(at("../../auth.ts"), {
      namedExports: {
        AuthError: FakeAuthError,
        requireAdminOrAutomation: async () => {
          authCalls++;
          if (!admin) throw new FakeAuthError("Admins only.", 403);
          return { id: "admin-1", email: "a@example.com", isAdmin: true, ...(openAccess ? { openAccess } : {}) };
        },
      },
    });
    mock.module(at("../client.ts"), {
      namedExports: {
        deviceConfig: () => null,
        listDeviceTools: async (config: DeviceConfig) => {
          mcp.push({ config, name: "tools/list" });
          if (mcpDown) throw new Error(`fetch failed for ${config.url} with ${config.token}`);
          return BOARD_LIST.map((name) => ({ name, inputSchema: { type: "object" } }));
        },
        callDeviceTool: async (config: DeviceConfig, name: string, args: Record<string, unknown>) => {
          mcp.push({ config, name, args });
          if (mcpDown) throw new Error(`fetch failed for ${config.url} with ${config.token}`);
          return toolReply;
        },
      },
    });
    routes = await import("@/app/api/device/rover/route");
    drive = await import("@/app/api/device/rover/drive/route");
    ({ resetRover } = await import("@/lib/device/rover"));

    kitDir = await fs.mkdtemp(path.join(os.tmpdir(), "rover-route-"));
    await fs.mkdir(path.join(kitDir, "muse-device", "rover"), { recursive: true });
    await fs.writeFile(path.join(kitDir, "muse-device", "server.py"), "print('server')\n");
    await fs.writeFile(path.join(kitDir, "muse-device", "autostart.sh"), "#!/bin/bash\n");
    await fs.writeFile(path.join(kitDir, "muse-device", "rover", "setup-rover.sh"), "#!/bin/bash\n");
    emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "rover-route-empty-"));
  });

  beforeEach(() => {
    admin = true;
    openAccess = false;
    authCalls = 0;
    mcp = [];
    mcpDown = false;
    toolReply = { content: [{ type: "text", text: "ok" }], isError: false };
    logs = [];
    resetRover();
    fleet = fakeFleet();
    // Every job ends on its first read, so nothing here waits.
    fleet.readsRunning = 0;
    globalThis.fetch = fleet.doFetch;
    process.chdir(kitDir);
    process.env.ROVER_ENABLED = "1";
    process.env.BOARD_FLEET_URL = FLEET_URL;
    process.env.BOARD_FLEET_TOKEN = FLEET_TOKEN;
    console.error = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    console.info = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.chdir(realCwd);
    console.error = realError;
    console.info = realInfo;
    delete process.env.ROVER_ENABLED;
    delete process.env.BOARD_FLEET_URL;
    delete process.env.BOARD_FLEET_TOKEN;
  });

  after(() => mock.reset());

  it("answers 404 and touches nothing while ROVER_ENABLED is off", async () => {
    delete process.env.ROVER_ENABLED;
    for (const res of [await post(), await get(), await get("?job=jb_1"), await act({ action: "stop" })]) {
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "not_found" });
    }
    assert.equal(authCalls, 0);
    assert.equal(fleet.requests.length + mcp.length, 0);
  });

  it("refuses anyone but a signed-in admin, OPEN_ACCESS=admin's shared account included, before the fleet", async () => {
    for (const who of ["guest", "open"] as const) {
      admin = who !== "guest";
      openAccess = who === "open";
      for (const res of [await post(), await get(), await act({ action: "drive", direction: "forward" })]) assert.equal(res.status, 403, who);
    }
    assert.equal(fleet.requests.length + mcp.length, 0);
  });

  it("says the fleet isn't set up, without calling anything", async () => {
    delete process.env.BOARD_FLEET_TOKEN;
    for (const res of [await post(), await get(), await act({ action: "ranges" })]) {
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, "fleet_not_configured");
    }
    assert.equal(fleet.requests.length + mcp.length, 0);
  });

  it("says the kit isn't in this deployment, before any exec", async () => {
    process.chdir(emptyDir);
    const res = await post();
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.error, "kit_missing");
    assert.match(data.message, /muse-device\/rover\/ is missing/);
    assert.equal(fleet.jobs.length, 0);
  });

  it("refuses pins it can't use, before any exec", async () => {
    const res = await post({ pins: { pwma: "D4" } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).message, /PWM pin/);
    assert.equal(fleet.requests.length, 0);
  });

  it("sets the rover up in one go and shows the report, with no token or fleet address in any reply or log", async () => {
    const res = await post({ pins: { servo_pan: "D9" } });
    const text = await res.text();
    assert.equal(res.status, 200);
    const data = JSON.parse(text);
    assert.equal(data.state, "done");
    assert.equal(data.report.ok, true);
    assert.deepEqual(data.report.ranges, { front: 412, left: null, right: 233, clear: ["left"] });
    assert.deepEqual(leaks(text), []);
    assert.deepEqual(logs, ["[device/rover] admin admin-1 setup ArduinoQ-01"]);

    // The same job read again, by id, as the card does for a setup that outlasts the POST.
    const again = await get(`?job=${data.job}`);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).state, "done");

    const status = await get();
    const statusText = await status.text();
    assert.equal(status.status, 200);
    const s = JSON.parse(statusText);
    assert.equal(s.board, "ArduinoQ-01");
    assert.equal(s.answers, true);
    // Only the rover's own tools, under their rover_ names, though its server lists the board's others too.
    assert.deepEqual(s.tools, ROVER_TOOLS);
    assert.equal(s.report.ok, true);
    assert.deepEqual(leaks(statusText), []);
    // Through the fleet's device route, with the board's own token, which only the server saw.
    assert.deepEqual(mcp.at(-1)!.config, { url: `${FLEET_URL}/device/ArduinoQ-01/mcp`, token: BOARD_TOKEN });
  });

  it("won't show a job that isn't a rover setup, or take something that isn't a job id", async () => {
    const setup = await (await post()).json();
    const part = fleet.jobs.find((job) => job.command.startsWith("# mm-rover-token"))!;
    const res = await get(`?job=${part.id}`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).message, /isn't a rover setup/);
    assert.equal((await get("?job=..%2Fnodes")).status, 400);
    assert.ok(setup.job);
  });

  it("says why the rover isn't answering yet, without failing the page", async () => {
    fleet.board = (command) => (command.startsWith("# mm-rover-token") ? { output: "The tool server has not made its token yet.\n", exit: 1 } : { output: "", exit: 0 });
    const res = await get();
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.answers, false);
    assert.match(data.why, /has not made its token yet/);
    assert.equal(mcp.length, 0);
  });

  it("drives within the limits only, and checks before reaching the rover", async () => {
    for (const bad of [
      { action: "drive", direction: "forward", ms: 5000 },
      { action: "drive", direction: "forward", speed: 150 },
      { action: "drive", direction: "sideways" },
      { action: "look", pan: 180 },
      { action: "run_command" },
    ]) {
      const res = await act(bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal((await res.json()).error, "invalid_input");
    }
    assert.equal(fleet.requests.length + mcp.length, 0);

    toolReply = { content: [{ type: "text", text: '{"left":128,"right":128,"ms":400}' }], isError: false };
    const res = await act({ action: "drive", direction: "forward", ms: 400, speed: 50 });
    const text = await res.text();
    assert.equal(res.status, 200);
    // A drive's left and right are wheel speeds, not ranges.
    assert.deepEqual(JSON.parse(text), { ok: true, text: '{"left":128,"right":128,"ms":400}', image: null, ranges: null });
    assert.deepEqual(mcp.at(-1), { config: { url: `${FLEET_URL}/device/ArduinoQ-01/mcp`, token: BOARD_TOKEN }, name: "drive", args: { left: 128, right: 128, ms: 400, wait: false } });
    assert.deepEqual(leaks(text), []);
  });

  it("brings back the photo and the ranges, and the rover's own refusals as they are", async () => {
    toolReply = { content: [{ type: "image", data: "abc", mimeType: "image/jpeg" }], isError: false };
    assert.deepEqual((await (await act({ action: "photo" })).json()).image, { mimeType: "image/jpeg", data: "abc" });
    assert.deepEqual(mcp.at(-1)!.name, "capture_image");
    toolReply = { content: [{ type: "text", text: '{"front_mm":120,"left_mm":null,"right_mm":45,"sensors":{"front":"ok","left":"clear","right":"ok"}}' }], isError: false };
    assert.deepEqual((await (await act({ action: "ranges" })).json()).ranges, { front: 120, left: null, right: 45, clear: ["left"] });
    toolReply = { content: [{ type: "text", text: '{"driving":false,"ranges":{"front_mm":90,"left_mm":300,"right_mm":45,"sensors":{}}}' }], isError: false };
    assert.deepEqual((await (await act({ action: "status" })).json()).ranges, { front: 90, left: 300, right: 45, clear: [] });
    toolReply = { content: [{ type: "text", text: "The rover didn't move: something is 80 mm in front. Backing up and turning on the spot still work." }], isError: true };
    const refused = await (await act({ action: "drive", direction: "forward" })).json();
    assert.equal(refused.ok, false);
    assert.match(refused.text, /didn't move/);
    // The token is read once and kept, so the calls after the first need no exec.
    assert.equal(fleet.jobs.length, 1);
  });

  it("keeps the address and the token out of the reply and the log when the rover can't be reached", async () => {
    await act({ action: "stop" });
    mcpDown = true;
    const res = await act({ action: "stop" });
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(text).error, "rover_unavailable");
    assert.deepEqual(leaks(text), []);
    assert.ok(logs.length > 0);
    assert.deepEqual(leaks(logs.join("\n")), []);
  });
});
