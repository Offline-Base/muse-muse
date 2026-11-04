/**
 * The e-ink fleet display (owner, Nov 3): a Boox stands in front of the Jetson Orin Nanos and shows, for each board, what
 * runs on it, its power draw and its health, in large black type with no motion. GET /fleet/display returns plain HTML
 * that refreshes itself, so the tablet's browser needs no JavaScript. Data: the control plane's /api/nodes (viewer token,
 * read only, server side) and /api/public/stats (no token). Made-up numbers in tests only.
 *
 * Graphs (owner, Nov 3): tokens per hour (24 h) and per day (30 days) from the public stats, so they show with no token;
 * and per board, the last hour of heat, memory, power and tokens per second from /api/nodes/<id>/metrics (viewer token).
 * All graphs are inline SVG, black on white, drawn on the server.
 */

/** The last hour on one board, about 60 points each, oldest first; null where the board sent nothing. */
export interface BoardSeries {
  tempC: Array<number | null>;
  memPct: Array<number | null>;
  powerW: Array<number | null>;
  tps: Array<number | null>;
}

/** Fleet token history from /api/public/stats: 24 hourly totals (oldest first) and up to 30 daily totals. */
export interface FleetHistory {
  hourly: number[];
  daily: Array<{ day: string; tokens: number }>;
  /** Every token the fleet has served (all_time.tokens), or null. */
  allTime: number | null;
}

export interface DisplayBoard {
  id: string | null;
  name: string;
  status: "online" | "stale" | "offline";
  /** What runs on it, most telling first: loaded models, then known services. */
  running: string[];
  powerW: number | null;
  tempC: number | null;
  cpuPct: number | null;
  gpuPct: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  series: BoardSeries | null;
}

export interface DisplayData {
  boards: DisplayBoard[];
  history: FleetHistory | null;
  totals: { online: number; total: number; powerW: number | null; tokensToday: number | null; tokensPerS: number | null };
  /** Why boards are missing, for the footer: no token, or the control plane didn't answer. */
  note: string | null;
}

/**
 * What each board is for, when its control-plane label `role` doesn't say (the agent reports only Ollama, Docker and
 * itself as services, so SAM and Glimmer don't show there). From docs/HANDOFF.md, Nov 3. A `role` label wins.
 */
export const DEFAULT_ROLES: Record<string, string[]> = {
  "jetson-04": ["SAM 3.1 vision", "Meta weights + tuned \u201cmuse\u201d"],
  "jetson-03": ["SAM 3.1 tuning"],
  "jetson-02": ["Muse Glimmer, 1-bit"],
};

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** What runs on a board: its `role` label (or DEFAULT_ROLES), its loaded models, and live serving. */
export function runningOn(summary: Record<string, unknown>): string[] {
  const name = String(summary.name ?? "");
  const labels = (summary.labels ?? {}) as Record<string, unknown>;
  const role = typeof labels.role === "string" && labels.role.trim() ? [labels.role.trim()] : (DEFAULT_ROLES[name] ?? []);
  const models = Array.isArray(summary.loaded_models) ? (summary.loaded_models as unknown[]).filter((m): m is string => typeof m === "string").map(shortModel) : [];
  const m = (summary.metrics ?? {}) as Record<string, unknown>;
  const tps = n(m.llm_tokens_per_s) ?? n(m.llm_tps);
  return [...new Set([...role, ...models, ...(tps && tps > 0 ? [`Serving ${tps.toFixed(1)} tokens/s`] : [])])];
}

/** A model name short enough for one line on the screen. */
export function shortModel(name: string): string {
  return name.replace(/^hf\.co\/[^/]+\//, "").replace(/:latest$/, "").replace(/-(gguf|GGUF)$/, "");
}

export function boardFrom(summary: Record<string, unknown>): DisplayBoard {
  const m = (summary.metrics ?? {}) as Record<string, unknown>;
  const temps = (m.temps_c ?? {}) as Record<string, unknown>;
  const status = summary.status === "online" || summary.status === "stale" ? summary.status : "offline";
  return {
    id: typeof summary.id === "string" ? summary.id : null,
    name: String(summary.name ?? summary.id ?? "board"),
    status,
    running: runningOn(summary),
    powerW: n(m.power_w),
    tempC: n(temps.tj) ?? n(m.temp_tj) ?? n(temps.gpu) ?? n(m.temp_gpu) ?? n(temps.cpu) ?? n(m.temp_cpu),
    cpuPct: n(m.cpu_pct),
    gpuPct: n(m.gpu_pct),
    memUsedMb: n(m.mem_used_mb),
    memTotalMb: n(m.mem_total_mb),
    series: null,
  };
}

const sum = (...v: unknown[]) => v.reduce<number>((s, x) => s + (n(x) ?? 0), 0);

/** Token history for the fleet graphs, or null when the stats have none. */
export function historyFrom(stats: Record<string, any> | null): FleetHistory | null {
  const hourly = Array.isArray(stats?.hourly) ? (stats.hourly as Array<Record<string, unknown>>).map((h) => sum(h.local_tokens, h.cloud_tokens)) : [];
  const daily = Array.isArray(stats?.daily)
    ? (stats.daily as Array<Record<string, unknown>>).slice(-30).map((d) => ({ day: String(d.day ?? ""), tokens: sum(d.local_tokens, d.cloud_tokens) }))
    : [];
  return hourly.length || daily.length ? { hourly, daily, allTime: n(stats?.all_time?.tokens) } : null;
}

/** Averages `values` down to at most `max` points, skipping nulls (a bucket with no values stays null). */
export function downsample(values: Array<number | null>, max = 60): Array<number | null> {
  if (values.length <= max) return values;
  const size = values.length / max;
  return Array.from({ length: max }, (_, i) => {
    const part = values.slice(Math.floor(i * size), Math.floor((i + 1) * size)).filter((v): v is number => v !== null);
    return part.length ? part.reduce((a, b) => a + b, 0) / part.length : null;
  });
}

/** A board's last hour from the control plane's metrics points, or null when it has none. */
export function seriesFrom(body: unknown): BoardSeries | null {
  const points = (body as { points?: unknown })?.points;
  if (!Array.isArray(points) || !points.length) return null;
  const col = (f: (p: Record<string, unknown>) => number | null) => downsample((points as Array<Record<string, unknown>>).map(f));
  const series: BoardSeries = {
    tempC: col((p) => {
      const t = [n(p.temp_tj), n(p.temp_gpu), n(p.temp_cpu)].filter((v): v is number => v !== null);
      return t.length ? Math.max(...t) : null;
    }),
    memPct: col((p) => {
      const used = n(p.mem_used_mb);
      const total = n(p.mem_total_mb);
      return used !== null && total ? (used / total) * 100 : null;
    }),
    powerW: col((p) => n(p.power_w)),
    tps: col((p) => n(p.llm_tps)),
  };
  return Object.values(series).some((v: Array<number | null>) => v.some((x) => x !== null)) ? series : null;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Reads the fleet for the display. Never throws: what it can't read becomes the note. */
export async function loadDisplay(opts: { base: string; token: string | null; fetchImpl?: Fetch; timeoutMs?: number }): Promise<DisplayData> {
  const f = opts.fetchImpl ?? fetch;
  const get = async (path: string, auth: boolean): Promise<unknown> => {
    const res = await f(`${opts.base}${path}`, {
      headers: { accept: "application/json", "ngrok-skip-browser-warning": "1", ...(auth && opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return res.json();
  };
  const stats = (await get("/api/public/stats", false).catch(() => null)) as Record<string, any> | null;
  let boards: DisplayBoard[] = [];
  let note: string | null = null;
  if (!opts.token) note = "Board details need FLEET_VIEWER_TOKEN; showing fleet totals only.";
  else {
    try {
      const list = ((await get("/api/nodes", true)) as Array<Record<string, unknown>>).filter((b) => !String(b.name ?? "").startsWith("jetson-05") || b.status !== "offline");
      boards = list.map((b) => boardFrom(b)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
      await Promise.all(
        boards
          .filter((b) => b.id && b.status !== "offline")
          .map(async (b) => {
            b.series = await get(`/api/nodes/${encodeURIComponent(b.id!)}/metrics?range=1h`, true).then(seriesFrom, () => null);
          }),
      );
    } catch (err) {
      note = `The control plane didn't answer (${err instanceof Error ? err.message : String(err)}).`;
    }
  }
  const online = boards.length ? boards.filter((b) => b.status !== "offline").length : (n(stats?.boards?.online) ?? 0);
  const total = boards.length ? boards.length : (n(stats?.boards?.total) ?? 0);
  const boardPower = boards.reduce((s, b) => s + (b.powerW ?? 0), 0);
  return {
    boards,
    history: historyFrom(stats),
    totals: {
      online,
      total,
      powerW: n(stats?.live?.power_w) ?? (boards.length ? boardPower : null),
      tokensToday: n(stats?.today?.tokens),
      tokensPerS: n(stats?.live?.tokens_per_s),
    },
    note: stats || boards.length ? note : (note ?? "The control plane didn't answer."),
  };
}

const rank = (b: DisplayBoard) => (b.status === "offline" ? 2 : b.running.length ? 0 : 1);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const watts = (w: number | null) => (w === null ? "?" : `${w < 100 ? w.toFixed(1) : Math.round(w)} W`);
const pct = (v: number | null) => (v === null ? "?" : `${Math.round(v)}%`);
const gb = (mb: number | null) => (mb === null ? "?" : `${(mb / 1024).toFixed(1)}`);

const fmt = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** Polyline point strings for `values` on a [lo, hi] scale (widened to fit), split at nulls, in a W x H box. */
export function lineRuns(values: Array<number | null>, lo: number, hi: number, W = 100, H = 30): string[] {
  const real = values.filter((v): v is number => v !== null);
  const min = Math.min(lo, ...real);
  const span = Math.max(hi, ...real) - min || 1;
  const x = (i: number) => (values.length > 1 ? (i / (values.length - 1)) * W : W / 2);
  const y = (v: number) => H - ((v - min) / span) * (H - 2) - 1;
  const runs: string[] = [];
  let run: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length) runs.push(run.join(" "));
      run = [];
    } else run.push(`${x(i).toFixed(2)},${y(v).toFixed(2)}`);
  });
  if (run.length) runs.push(run.join(" "));
  return runs;
}

const runsSvg = (runs: string[], attrs = "") =>
  runs.map((pts) => (pts.includes(" ") ? `<polyline points="${pts}"${attrs}/>` : `<circle cx="${pts.split(",")[0]}" cy="${pts.split(",")[1]}" r="1.2"${attrs}/>`)).join("");

/** A small line graph as inline SVG; nulls leave gaps. The scale is [lo, hi], widened to fit the data. */
export function lineSvg(values: Array<number | null>, lo: number, hi: number): string {
  return `<svg viewBox="0 0 100 30" preserveAspectRatio="none" role="img"><line x1="0" y1="29.5" x2="100" y2="29.5" class="axis"/><g class="ln">${runsSvg(lineRuns(values, lo, hi))}</g></svg>`;
}

const last = (v: Array<number | null>) => [...v].reverse().find((x): x is number => x !== null) ?? null;

function mini(label: string, values: Array<number | null>, lo: number, hi: number, show: (v: number) => string): string {
  const now = last(values);
  return `<div class="mini"><div class="lab"><span>${label}</span><b>${now === null ? "?" : show(now)}</b></div>${lineSvg(values, lo, hi)}</div>`;
}

function card(b: DisplayBoard): string {
  const running = b.running.length ? b.running.map(esc).join("<br>") : "Idle";
  const stats = `<div class="stats"><span><b>${pct(b.cpuPct)}</b> CPU</span><span><b>${pct(b.gpuPct)}</b> GPU</span><span><b>${b.tempC === null ? "?" : Math.round(b.tempC)}°C</b></span><span><b>${gb(b.memUsedMb)}/${gb(b.memTotalMb)}</b> GB</span></div>`;
  const s = b.series;
  const graphs = s
    ? `<div class="minis">${mini("Heat", s.tempC, 30, 70, (v) => `${Math.round(v)}°C`)}${mini("Memory", s.memPct, 0, 100, (v) => `${Math.round(v)}%`)}${mini("Power", s.powerW, 0, 10, (v) => watts(v))}${mini("Tokens/s", s.tps, 0, 5, (v) => v.toFixed(1))}</div><div class="span">Last hour</div>`
    : "";
  return `<section class="board"><header><h2>${esc(b.name)}</h2><div class="power">${watts(b.powerW)}</div></header><p class="running">${running}</p>${stats}${graphs}</section>`;
}

/** Running total of tokens served at the end of each day in the window, ending at the all-time total. */
export function cumulative(h: FleetHistory): Array<{ day: string; total: number }> {
  const window = h.daily.reduce((a, d) => a + d.tokens, 0);
  let running = Math.max(0, (h.allTime ?? window) - window);
  return h.daily.map((d) => ({ day: d.day, total: (running += d.tokens) }));
}

export type JollyMood = "up" | "down" | "around";

/** Which Jolly plays: looking down at trouble, up at a fleet that served tokens in the last two hours, around when idle. */
export function jollyMood(data: DisplayData): JollyMood {
  const t = data.totals;
  if (/didn't answer/.test(data.note ?? "") || (t.total > 0 && t.online * 2 < t.total)) return "down";
  const recent = (data.history?.hourly ?? []).slice(-2).reduce((a, b) => a + b, 0);
  return recent > 0 || (t.tokensPerS ?? 0) > 0 ? "up" : "around";
}

/** A smooth line through the points (Catmull-Rom as cubic Beziers), in a 0..W x 0..H box. */
export function smoothPath(values: number[], W = 100, H = 60): string {
  if (!values.length) return "";
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const pts = values.map((v, i) => [values.length > 1 ? (i / (values.length - 1)) * W : W / 2, H - 2 - ((v - min) / span) * (H - 4)] as const);
  if (pts.length === 1) return `M${pts[0]![0]} ${pts[0]![1]}`;
  const f = (v: number) => v.toFixed(2);
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

const short = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}K` : fmt(v));
const day = (d: string) => {
  const [, m, dd] = d.split("-");
  return m && dd ? `${Number(m)}/${Number(dd)}` : esc(d);
};

/** The big graph on the right. Tokens come from the public stats; the rest from each board's last hour (viewer token). */
export type GraphKind = "tokens" | "memory" | "heat" | "power";
const BOARD_GRAPHS: Record<Exclude<GraphKind, "tokens">, { key: keyof BoardSeries; lo: number; hi: number; title: string; show: (v: number) => string }> = {
  memory: { key: "memPct", lo: 0, hi: 100, title: "Memory used on each board, last hour", show: (v) => `${Math.round(v)}%` },
  heat: { key: "tempC", lo: 30, hi: 70, title: "Heat on each board (hottest sensor), last hour", show: (v) => `${Math.round(v)}°C` },
  power: { key: "powerW", lo: 0, hi: 10, title: "Power on each board, last hour", show: (v) => watts(v) },
};
const COLORS = ["#2a8a9a", "#222222", "#c0612b", "#6b5bd2", "#3d8b3d", "#8a8a8a", "#b8325a", "#1f5fa8", "#a07a00"];

/** The graphs this data can draw, in the order the page cycles through them. */
export function availableGraphs(data: DisplayData): GraphKind[] {
  const out: GraphKind[] = [];
  if (data.history && cumulative(data.history).length >= 2) out.push("tokens");
  for (const kind of ["memory", "heat", "power"] as const) {
    const key = BOARD_GRAPHS[kind].key;
    if (data.boards.some((b) => b.series?.[key].some((v) => v !== null))) out.push(kind);
  }
  return out;
}

function tokensGraph(h: FleetHistory): string {
  const points = cumulative(h);
  const first = points[0]!;
  const end = points[points.length - 1]!;
  return `<div class="graph"><svg viewBox="0 0 100 60" preserveAspectRatio="none" role="img" aria-label="Tokens served, rising from ${short(first.total)} to ${short(end.total)}"><path d="${smoothPath(points.map((p) => p.total))}"/></svg>
<div class="ends"><span>${day(first.day)}</span><span>${day(end.day)}</span></div>
<p class="cap"><b>${short(end.total)}</b> tokens served on Meta models, last ${points.length} days</p></div>`;
}

function boardsGraph(kind: Exclude<GraphKind, "tokens">, boards: DisplayBoard[]): string {
  const g = BOARD_GRAPHS[kind];
  const lines = boards.filter((b) => b.series?.[g.key].some((v) => v !== null));
  const all = lines.flatMap((b) => b.series![g.key]).filter((v): v is number => v !== null);
  const lo = Math.min(g.lo, ...all);
  const hi = Math.max(g.hi, ...all);
  const paths = lines.map((b, i) => `<g stroke="${COLORS[i % COLORS.length]}" fill="${COLORS[i % COLORS.length]}">${runsSvg(lineRuns(b.series![g.key], lo, hi, 100, 60))}</g>`).join("");
  const legend = lines
    .map((b, i) => {
      const now = last(b.series![g.key]);
      const job = b.running[0] ? ` <span>${esc(b.running[0])}</span>` : "";
      return `<li><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(b.name)}${job}<b>${now === null ? "?" : g.show(now)}</b></li>`;
    })
    .join("");
  return `<div class="graph"><svg viewBox="0 0 100 60" preserveAspectRatio="none" role="img" aria-label="${esc(g.title)}" class="multi">${paths}</svg>
<div class="ends"><span>1 h ago, scale ${g.show(lo)} to ${g.show(hi)}</span><span>now</span></div>
<p class="cap">${esc(g.title)}</p><ul class="legend">${legend}</ul></div>`;
}

function graph(data: DisplayData, kind: GraphKind | undefined): string {
  if (!kind) return `<div class="graph empty"><p class="cap">No history yet</p></div>`;
  return kind === "tokens" ? tokensGraph(data.history!) : boardsGraph(kind, data.boards);
}

/** The whole page: Jolly on the left under the stats, the graph on the right; board cards below when the viewer token is
 * set. White, large type, no motion but Jolly, refreshing every `refreshS` seconds. */
export function renderDisplay(
  data: DisplayData,
  now: Date,
  opts: { refreshS?: number; timeZone?: string; mood?: JollyMood; graph?: string | null; keep?: Record<string, string> } = {},
): string {
  const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: opts.timeZone ?? "America/New_York" });
  const t = data.totals;
  const on = data.boards.filter((b) => b.status !== "offline");
  const off = data.boards.filter((b) => b.status === "offline");
  const mood = opts.mood ?? jollyMood(data);
  // One graph per refresh: the asked-for one (or the first), and the refresh moves on to the next.
  const graphs = availableGraphs(data);
  const at = Math.max(0, graphs.indexOf(opts.graph as GraphKind));
  const shown = graphs[at];
  const next = graphs.length > 1 ? new URLSearchParams({ ...opts.keep, g: graphs[(at + 1) % graphs.length]! }).toString() : null;
  const refresh = `${opts.refreshS ?? 60}${next ? `;url=?${esc(next)}` : ""}`;
  const tokens = t.tokensToday === null ? "" : `<div><b>${t.tokensToday.toLocaleString("en-US")}</b> tokens today</div>`;
  const boards = on.length || off.length
    ? `<div class="grid">${on.map(card).join("")}</div>${off.length ? `<p class="offline">Offline: ${off.map((b) => esc(b.name)).join(", ")}</p>` : ""}`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="${refresh}"><title>Offline Base fleet</title><style>
*{box-sizing:border-box;margin:0}html,body{background:#fff;color:#111}body{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;padding:3vmin 4vmin}
.hero{display:grid;grid-template-columns:minmax(0,46fr) minmax(0,54fr);gap:4vmin;align-items:stretch;min-height:calc(100vh - 11vmin)}
.left{display:flex;flex-direction:column;align-items:center}
.stats{display:flex;gap:4vmin;justify-content:center;color:#555;font-size:2.6vmin;white-space:nowrap;text-align:center;margin-top:2vmin}.stats b{display:block;font-size:6vmin;font-weight:500;line-height:1.05;color:#333;white-space:nowrap}
.jolly{flex:1;display:flex;align-items:flex-end;justify-content:center;width:100%;min-height:0}
.jolly video{width:100%;max-height:72vh;object-fit:contain;display:block}
.graph{display:flex;flex-direction:column;justify-content:center;padding:6vmin 2vmin 2vmin}
.graph svg{width:100%;height:58vh;overflow:visible}.graph path{fill:none;stroke:#2a8a9a;stroke-width:2.5;vector-effect:non-scaling-stroke;stroke-linecap:round}
.ends{display:flex;justify-content:space-between;color:#777;font-size:2vmin;margin-top:1vmin}
.multi polyline{fill:none;stroke-width:2.5;vector-effect:non-scaling-stroke;stroke-linejoin:round}.multi circle{stroke:none}
.legend{list-style:none;padding:0;margin-top:2vmin;display:grid;grid-template-columns:1fr;gap:.6vmin;font-size:2.1vmin;color:#333}
.legend li{display:flex;align-items:baseline;gap:1vmin;white-space:nowrap;min-width:0}.legend i{flex:none;width:3vmin;height:.8vmin;border-radius:.4vmin;align-self:center}.legend span{color:#777;font-size:1.9vmin;overflow:hidden;text-overflow:ellipsis;min-width:0}.legend b{margin-left:auto;font-weight:600}
.cap{color:#555;font-size:3.4vmin;text-align:center;margin-top:3vmin}.cap b{color:#333;font-weight:500}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(42vmin,1fr));gap:2vmin;margin-top:3vmin}
.board{border:2px solid #000;border-radius:1.6vmin;padding:2vmin 2.4vmin}
.board header{display:flex;justify-content:space-between;align-items:baseline}h2{font-size:3.6vmin;font-weight:700}.power{font-size:4.6vmin;font-weight:700}
.running{font-size:2.9vmin;line-height:1.3;margin:1.2vmin 0 1.4vmin;min-height:3.8vmin}
.board .stats{justify-content:flex-start;gap:2.6vmin;font-size:2.3vmin;color:#000;border-top:1px solid #000;padding-top:1.2vmin;margin:0;text-align:left}.board .stats b{display:inline;font-size:2.7vmin;color:#000;font-weight:700}
.lab{display:flex;justify-content:space-between;align-items:baseline}.axis{stroke:#000;stroke-width:1;vector-effect:non-scaling-stroke}.ln polyline{fill:none;stroke:#000;stroke-width:2.4;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.minis{display:grid;grid-template-columns:1fr 1fr;gap:1.4vmin 2.4vmin;margin-top:1.4vmin}.mini .lab{font-size:2vmin}.mini .lab b{font-size:2.4vmin}.mini svg{display:block;width:100%;height:5vmin;margin-top:.4vmin}
.span{font-size:1.7vmin;text-align:right;margin-top:.6vmin}.offline{margin-top:2vmin;font-size:2.5vmin;border:2px dashed #000;border-radius:1.6vmin;padding:1.4vmin 2.4vmin}
.foot{margin-top:2vmin;font-size:1.8vmin;color:#777;display:flex;justify-content:space-between}
</style></head><body>
<div class="hero"><div class="left">
<div class="stats"><div><b>${t.online}/${t.total}</b> boards online</div><div><b>${watts(t.powerW)}</b> power</div>${tokens}</div>
<div class="jolly"><video src="/fleet/jolly/${mood}.mp4" poster="/fleet/jolly/${mood}.jpg" autoplay loop muted playsinline aria-label="Jolly, the Muse mascot"></video></div>
</div>${graph(data, shown)}</div>
${boards}
<div class="foot"><span>Offline Base fleet, Meta models on Jetson Orin Nanos. Updated ${esc(time)}.${data.note ? ` ${esc(data.note)}` : ""}</span><span>${graphs.length > 1 ? `Graph ${at + 1} of ${graphs.length}, next in a minute` : "Refreshes every minute"}</span></div>
</body></html>`;
}
