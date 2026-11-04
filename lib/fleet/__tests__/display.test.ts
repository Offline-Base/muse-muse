/** The e-ink fleet display with made-up boards and a fake control plane. npx tsx --test lib/fleet/__tests__/display.test.ts */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { availableGraphs, boardFrom, cumulative, downsample, historyFrom, jollyMood, lineSvg, smoothPath, loadDisplay, renderDisplay, runningOn, seriesFrom } from "@/lib/fleet/display";

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
const STATS = {
  boards: { total: 3, online: 2 },
  live: { power_w: 10.3, tokens_per_s: 0 },
  today: { tokens: 1234 },
  all_time: { tokens: 100000 },
  hourly: Array.from({ length: 24 }, (_, i) => ({ ts: i * 3600, local_tokens: i === 20 ? 900 : 0, cloud_tokens: i === 23 ? 334 : 0 })),
  daily: [
    { day: "2026-11-02", requests: 9, local_tokens: 5000, cloud_tokens: 0 },
    { day: "2026-11-03", requests: 2, local_tokens: 900, cloud_tokens: 334 },
  ],
};
// 120 made-up samples for jetson-04, the last ten with no data.
const POINTS = Array.from({ length: 120 }, (_, i) =>
  i >= 110 ? { ts: i * 30 } : { ts: i * 30, temp_cpu: 48, temp_tj: 50 + (i % 4), mem_used_mb: 3810, mem_total_mb: 7620, power_w: 6, llm_tps: i > 100 ? 4 : 0 },
);

function fakeFetch(seen: Array<{ url: string; auth: string | null }>) {
  return async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    seen.push({ url, auth });
    const path = url.replace("https://cp.example/admin", "");
    const body =
      path === "/api/public/stats" ? STATS : path === "/api/nodes" ? NODES : path === "/api/nodes/nd_a/metrics?range=1h" ? { range: "1h", step_s: 30, points: POINTS } : DETAILS[path.split("/").pop()!];
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
    for (const want of ["Offline Base fleet", "2/3", "10.3 W", "6.2 W", "SAM 3.1 vision", "Muse Glimmer (1-bit)", "Offline", "3:58 PM", 'http-equiv="refresh" content="60', "1,234"]) assert.ok(html.includes(want), want);
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

  it("draws fleet token graphs without a token and per-board graphs of the last hour with one", async () => {
    const h = historyFrom(STATS)!;
    assert.equal(h.hourly.length, 24);
    assert.equal(h.hourly[23], 334);
    assert.deepEqual(h.daily.map((d) => d.tokens), [5000, 1234]);
    assert.equal(historyFrom({}), null);

    const s = seriesFrom({ points: POINTS })!;
    assert.equal(s.tempC.length, 60);
    assert.equal(s.memPct[0], 50);
    assert.equal(s.tempC.at(-1), null);
    assert.equal(seriesFrom({ points: [{ ts: 1 }] }), null);
    assert.deepEqual(downsample([1, 3, null, null], 2), [2, null]);

    assert.equal((lineSvg([1, null, 2, 3], 0, 5).match(/<polyline/g) ?? []).length, 1);
    assert.match(lineSvg([1, null, 2, 3], 0, 5), /<circle/);
    assert.deepEqual(cumulative(h).map((p) => p.total), [98766, 100000]);
    assert.match(smoothPath([1, 2, 3]), /^M0\.00 58\.00 C/);

    const seen: Array<{ url: string; auth: string | null }> = [];
    const data = await loadDisplay({ base: "https://cp.example/admin", token: "jpt_test_viewer", fetchImpl: fakeFetch(seen) });
    assert.ok(data.boards.find((b) => b.name === "jetson-04")!.series);
    assert.equal(data.boards.find((b) => b.name === "jetson-02")!.series, null);
    assert.ok(!seen.some((x) => x.url.includes("nd_c/metrics")), "no history asked for offline boards");
    assert.equal(seen.find((x) => x.url.includes("nd_a/metrics"))!.auth, "Bearer jpt_test_viewer");
    const html = renderDisplay(data, new Date("2026-11-03T20:58:00Z"));
    assert.deepEqual(availableGraphs(data), ["tokens", "memory", "heat", "power"]);
    const mem = renderDisplay(data, new Date(), { graph: "memory", keep: { k: "abc" } });
    for (const want of ["Memory used on each board", "jetson-04", "SAM 3.1 vision", 'content="60;url=?k=abc&amp;g=heat"', "Graph 2 of 4"]) assert.ok(mem.includes(want), want);
    assert.ok(renderDisplay(data, new Date(), { graph: "power" }).includes('url=?g=tokens"'));
    for (const want of ["100K", "tokens served", "11/2", "11/3", "/fleet/jolly/up.mp4", "Heat", "Memory", "Last hour", "Offline: jetson-06", "50%"]) assert.ok(html.includes(want), want);

    const bare = renderDisplay(await loadDisplay({ base: "https://cp.example/admin", token: null, fetchImpl: fakeFetch([]) }), new Date());
    assert.ok(bare.includes("<video") && bare.includes("<path d="));
    assert.ok(bare.includes('content="60"'), "one graph: plain refresh");
    assert.ok(!bare.includes("Last hour"));
    assert.ok(!bare.includes("<script"));
  });

  it("picks Jolly's video from the fleet: up after recent tokens, around when idle, down on trouble", () => {
    const base = { boards: [], note: null, history: historyFrom(STATS), totals: { online: 2, total: 3, powerW: 10, tokensToday: 1, tokensPerS: 0 } };
    assert.equal(jollyMood(base), "up");
    assert.equal(jollyMood({ ...base, history: { hourly: [5, 0, 0], daily: [], allTime: null } }), "around");
    assert.equal(jollyMood({ ...base, totals: { ...base.totals, online: 1 } }), "down");
    assert.equal(jollyMood({ ...base, note: "The control plane didn't answer." }), "down");
    assert.match(renderDisplay(base, new Date(), { mood: "around" }), /jolly\/around\.mp4/);
  });
});
