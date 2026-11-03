/** The e-ink fleet display with made-up boards and a fake control plane. npx tsx --test lib/fleet/__tests__/display.test.ts */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boardFrom, loadDisplay, renderDisplay, runningOn } from "@/lib/fleet/display";

const NODES = [
  { id: "nd_a", name: "jetson-04", status: "online", loaded_models: [], metrics: { power_w: 6.2, cpu_pct: 12, gpu_pct: 40, temps_c: { tj: 51.4 }, mem_used_mb: 5200, mem_total_mb: 7620 } },
  { id: "nd_b", name: "jetson-02", status: "online", labels: { role: "Muse Glimmer (1-bit)" }, loaded_models: ["muse-glimmer-2026-iq1s"], metrics: { power_w: 4.1, cpu_pct: 3, gpu_pct: 0, temp_cpu: 44, mem_used_mb: 4100, mem_total_mb: 7620, llm_tokens_per_s: 5.2 } },
  { id: "nd_c", name: "jetson-06", status: "offline", loaded_models: [], metrics: null },
];
const DETAILS: Record<string, unknown> = {
  nd_a: { state: { services: [{ name: "sam3.service", active: true }, { name: "cron.service", active: true }] } },
  nd_b: { state: { services: [{ name: "jetson-llama.service", active_state: "active" }] } },
  nd_c: { state: null },
};
const STATS = { boards: { total: 3, online: 2 }, live: { power_w: 10.3, tokens_per_s: 0 }, today: { tokens: 1234 } };

function fakeFetch(seen: Array<{ url: string; auth: string | null }>) {
  return async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    seen.push({ url, auth });
    const path = url.replace("https://cp.example/admin", "");
    const body = path === "/api/public/stats" ? STATS : path === "/api/nodes" ? NODES : DETAILS[path.split("/").pop()!];
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
  };
}

describe("e-ink fleet display", () => {
  it("names what runs on each board from its role label (or the defaults), loaded models and live serving", () => {
    assert.deepEqual(runningOn(NODES[0]!), ["SAM 3.1 vision", "Meta weights + tuned \u201cmuse\u201d"]);
    assert.deepEqual(runningOn(NODES[1]!), ["Muse Glimmer (1-bit)", "muse-glimmer-2026-iq1s", "Serving 5.2 tokens/s"]);
    assert.equal(boardFrom(NODES[0]!).tempC, 51.4);
    assert.equal(boardFrom(NODES[2]!).status, "offline");
  });

  it("reads boards with the viewer token, totals without one, and renders a self-refreshing page", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const data = await loadDisplay({ base: "https://cp.example/admin", token: "jpt_test_viewer", fetchImpl: fakeFetch(seen) });
    assert.equal(data.boards.length, 3);
    assert.equal(data.boards[2]!.name, "jetson-06");
    assert.equal(seen.find((s) => s.url.endsWith("/api/public/stats"))!.auth, null);
    assert.equal(seen.find((s) => s.url.endsWith("/api/nodes"))!.auth, "Bearer jpt_test_viewer");
    const html = renderDisplay(data, new Date("2026-11-03T20:58:00Z"));
    for (const want of ["Offline Base fleet", "2/3", "10.3 W", "6.2 W", "SAM 3.1 vision", "Muse Glimmer (1-bit)", "Offline", "3:58 PM", 'http-equiv="refresh" content="60"', "1,234"]) assert.ok(html.includes(want), want);
    assert.ok(!html.includes("<script"));
    assert.ok(!html.includes(String.fromCharCode(0x2014)));
    const bare = await loadDisplay({ base: "https://cp.example/admin", token: null, fetchImpl: fakeFetch([]) });
    assert.equal(bare.boards.length, 0);
    assert.equal(bare.totals.total, 3);
    assert.match(bare.note ?? "", /FLEET_VIEWER_TOKEN/);
  });

  it("never throws when the control plane is down", async () => {
    const data = await loadDisplay({ base: "https://cp.example/admin", token: "jpt_x", fetchImpl: async () => { throw new Error("offline"); } });
    assert.equal(data.boards.length, 0);
    assert.match(renderDisplay(data, new Date()), /didn't answer/);
  });
});
