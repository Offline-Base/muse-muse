/**
 * The e-ink fleet display (owner, Nov 3): a Boox stands in front of the Jetson Orin Nanos and shows, for each board, what
 * runs on it, its power draw and its health, in large black type with no motion. GET /fleet/display returns plain HTML
 * that refreshes itself, so the tablet's browser needs no JavaScript. Data: the control plane's /api/nodes (viewer token,
 * read only, server side) and /api/public/stats (no token). Made-up numbers in tests only.
 */

export interface DisplayBoard {
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
}

export interface DisplayData {
  boards: DisplayBoard[];
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
    name: String(summary.name ?? summary.id ?? "board"),
    status,
    running: runningOn(summary),
    powerW: n(m.power_w),
    tempC: n(temps.tj) ?? n(m.temp_tj) ?? n(temps.gpu) ?? n(m.temp_gpu) ?? n(temps.cpu) ?? n(m.temp_cpu),
    cpuPct: n(m.cpu_pct),
    gpuPct: n(m.gpu_pct),
    memUsedMb: n(m.mem_used_mb),
    memTotalMb: n(m.mem_total_mb),
  };
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
    } catch (err) {
      note = `The control plane didn't answer (${err instanceof Error ? err.message : String(err)}).`;
    }
  }
  const online = boards.length ? boards.filter((b) => b.status !== "offline").length : (n(stats?.boards?.online) ?? 0);
  const total = boards.length ? boards.length : (n(stats?.boards?.total) ?? 0);
  const boardPower = boards.reduce((s, b) => s + (b.powerW ?? 0), 0);
  return {
    boards,
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

function card(b: DisplayBoard): string {
  const off = b.status === "offline";
  const running = b.running.length ? b.running.map(esc).join("<br>") : off ? "Offline" : "Idle";
  const stats = off
    ? ""
    : `<div class="stats"><span><b>${pct(b.cpuPct)}</b> CPU</span><span><b>${pct(b.gpuPct)}</b> GPU</span><span><b>${b.tempC === null ? "?" : Math.round(b.tempC)}°C</b></span><span><b>${gb(b.memUsedMb)}/${gb(b.memTotalMb)}</b> GB</span></div>`;
  return `<section class="board${off ? " off" : ""}"><header><h2>${esc(b.name)}</h2><div class="power">${off ? "" : watts(b.powerW)}</div></header><p class="running">${running}</p>${stats}</section>`;
}

/** The whole page: e-ink first (black on white, large type, hairlines, no motion), refreshing every `refreshS` seconds. */
export function renderDisplay(data: DisplayData, now: Date, opts: { refreshS?: number; timeZone?: string } = {}): string {
  const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: opts.timeZone ?? "America/New_York" });
  const t = data.totals;
  const tokens = t.tokensToday === null ? "" : `<div><b>${t.tokensToday.toLocaleString("en-US")}</b> tokens today</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="${opts.refreshS ?? 60}"><title>Offline Base fleet</title><style>
*{box-sizing:border-box;margin:0}html,body{background:#fff;color:#000}body{font-family:Inter,"Helvetica Neue",Arial,sans-serif;padding:3vmin 3.5vmin}
.top{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #000;padding-bottom:1.6vmin;margin-bottom:2.4vmin}
h1{font-size:5.2vmin;font-weight:700;letter-spacing:-.02em}.sub{font-size:2.6vmin;margin-top:.6vmin}
.totals{display:flex;gap:4vmin;font-size:2.8vmin;text-align:right}.totals b{display:block;font-size:6vmin;line-height:1;white-space:nowrap}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(42vmin,1fr));gap:2vmin}
.board{border:2px solid #000;border-radius:1.6vmin;padding:2vmin 2.4vmin}.board.off{border-style:dashed;color:#555}
.board header{display:flex;justify-content:space-between;align-items:baseline}h2{font-size:3.6vmin;font-weight:700}.power{font-size:4.6vmin;font-weight:700}
.running{font-size:2.9vmin;line-height:1.3;margin:1.2vmin 0 1.4vmin;min-height:3.8vmin}
.stats{display:flex;gap:2.6vmin;font-size:2.3vmin;border-top:1px solid #000;padding-top:1.2vmin}.stats b{font-size:2.7vmin}
.foot{margin-top:2.4vmin;font-size:2.1vmin;display:flex;justify-content:space-between}
</style></head><body>
<div class="top"><div><h1>Offline Base fleet</h1><div class="sub">Meta models on Jetson Orin Nanos. Updated ${esc(time)}.</div></div>
<div class="totals"><div><b>${t.online}/${t.total}</b> boards online</div><div><b>${watts(t.powerW)}</b> total power</div>${tokens}</div></div>
<div class="grid">${data.boards.map(card).join("")}</div>
<div class="foot"><span>${data.note ? esc(data.note) : "Live from the fleet control plane."}</span><span>Refreshes every minute</span></div>
</body></html>`;
}
