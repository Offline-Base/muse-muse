/**
 * The board loop's driver for the fleet control plane (~/jetson-infra/docs/api.md and protocol.md). It uses only the public
 * API with a personal token: list nodes, a node's actions, jobs, and the OpenAI-compatible gateway pinned to one node. The
 * simulated board answers the same calls, so this code runs for real in the simulated loop, although it has never reached
 * a real control plane: the fleet connection fails today (docs/JETSON_TODO.md, step 1).
 */
import {
  BoardBusyError,
  BoardOfflineError,
  tokensPerSecond,
  type BoardAnswer,
  type BoardAsk,
  type BoardDriver,
  type BoardFile,
  type BoardKind,
  type BoardMetrics,
  type BoardStatus,
  type BoardWork,
} from "@/lib/board-loop/driver";
import { isMetaModelName } from "@/lib/meta/models";

export interface FleetConfig {
  /** Including the base path, like https://example.com/admin. */
  url: string;
  token: string;
  /** The board's fleet name, or its nd_ id. */
  node: string;
}

/** Just what the driver reads of a NodeSummary. */
interface FleetNode {
  id: string;
  name: string;
  status: "online" | "stale" | "offline";
  maintenance?: boolean;
  loaded_models?: string[];
  metrics?: {
    mem?: { used_mb?: number | null; total_mb?: number | null };
    temps_c?: { tj?: number | null; cpu?: number | null };
    power_mw?: { total?: number | null };
  } | null;
}

interface FleetJob {
  id: string;
  status: "running" | "succeeded" | "failed" | "partial";
  tasks: Array<{ status: string; error: string | null; result?: { exit_code?: number; output?: string } | null }>;
}

/** The llama.cpp release gguf-serve.sh runs. It must read IQ1_S and be newer than the file's own (docs/JETSON_TODO.md). */
export const FLEET_LLAMA_RELEASE = "b11970";
/** One chat at a time and a short context: the one-bit file barely fits, and the try page queues. */
const SERVE_PARALLEL = 1;
const SERVE_CONTEXT = 2048;
const MODEL_DIR = "/opt/jetson-gguf/models";
const CALL_MS = 15_000;
const ASK_MS = 180_000;
/** The download's own limit, and the job's. 6.5 GB over a slow link and an SD card. */
const INSTALL_TIMEOUT_S = 90 * 60;
const SERVE_TIMEOUT_S = 15 * 60;

/** Root's own, unlike /tmp, where any local user could plant the script a root unit is about to run. */
const SCRIPT_PATH = "/run/mm-gguf-serve.sh";
/** How long Stop waits for the board to say the model left, before it leaves maintenance. Under the stop route's limit. */
const STOP_WAIT_MS = 40_000;
const STOP_POLL_MS = 1_000;

const q = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** A file's name and address become one shell command on a board, so nothing odd gets that far. */
function checkFile(file: BoardFile): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/.test(file.name)) throw new Error("That file name can't go to a board.");
  if (file.sha256 !== null && !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error("That file's checksum isn't a checksum.");
  if (file.url !== null && !file.url.startsWith("https://huggingface.co/")) throw new Error("A board only downloads from Hugging Face.");
  // Only the simulated board's stand-in, which fetches nothing, goes without these.
  if (!file.standIn && (!file.url || !file.sha256)) throw new Error("A real file needs an address and a checksum before it can go to a board.");
}

/**
 * Downloads under its own unit, to a .part name that gguf-serve.sh won't take for the file, and checks the checksum twice,
 * the second time after dropping the page cache: jetson-02's SD card corrupted downloads (fleet.md, "LFM3-1.7B"). A file
 * already there gets checked too, since gguf-serve.sh takes any file with that name, and goes if it doesn't match.
 */
export function installCommand(file: BoardFile): string {
  checkFile(file);
  const path = `${MODEL_DIR}/${file.name}`;
  const checkOf = (at: string) => (file.sha256 ? `echo ${q(`${file.sha256}  ${at}`)} | sha256sum -c -` : "true");
  const check = checkOf(`${path}.part`);
  const url = file.url ? q(file.url) : "''";
  return [
    `# mm-board-install`,
    `set -euo pipefail`,
    `mkdir -p ${q(MODEL_DIR)}`,
    `if [ -s ${q(path)} ] && ! ${checkOf(path)}; then rm -f ${q(path)}; fi`,
    `if [ ! -s ${q(path)} ]; then`,
    `  curl -fL --retry 3 --retry-delay 5 -o ${q(`${path}.part`)} ${url}`,
    `  ${check}`,
    `  sync; echo 3 > /proc/sys/vm/drop_caches`,
    `  ${check}`,
    `  mv ${q(`${path}.part`)} ${q(path)}`,
    `fi`,
  ].join("\n");
}

/** Under systemd-run, as fleet.md says to: gguf-serve.sh restarts the agent, which would kill a script inside its job. */
export function serveCommand(file: BoardFile, serverUrl: string): string {
  checkFile(file);
  return [
    `# mm-board-serve`,
    `curl -fsSL ${q(`${serverUrl}/gguf-serve.sh`)} -o ${SCRIPT_PATH}`,
    [
      `systemd-run --unit=mm-board-serve --collect bash ${SCRIPT_PATH} --server ${q(serverUrl)} --release ${FLEET_LLAMA_RELEASE}`,
      `--model-url ${q(file.url ?? `file://${MODEL_DIR}/${file.name}`)} --mmproj-url ''`,
      `--alias ${q(file.alias)} --thinking off --parallel ${SERVE_PARALLEL} --ctx-per-chat ${SERVE_CONTEXT}`,
    ].join(" "),
  ].join("\n");
}

/** Under systemd-run for the same reason: --undo restarts the agent too. Ends a serve still going first, so the two can't race. */
export function stopCommand(serverUrl: string): string {
  return [
    `# mm-board-stop`,
    `systemctl stop mm-board-serve 2>/dev/null || true`,
    `curl -fsSL ${q(`${serverUrl}/gguf-serve.sh`)} -o ${SCRIPT_PATH}`,
    `systemd-run --unit=mm-board-stop --collect bash ${SCRIPT_PATH} --undo`,
  ].join("\n");
}

/** Whether a token may be sent to this address: https, or plain http only to this machine. */
export function safeBoardUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname } = new URL(url);
  return protocol === "https:" || (protocol === "http:" && ["localhost", "127.0.0.1"].includes(hostname));
}

/** The control plane's address and token, or null when one is missing or the address would expose the token. */
export function fleetAccess(): Pick<FleetConfig, "url" | "token"> | null {
  const url = process.env.BOARD_FLEET_URL?.trim();
  const token = process.env.BOARD_FLEET_TOKEN?.trim();
  if (!url || !token || !safeBoardUrl(url)) return null;
  return { url, token };
}

/**
 * A real board serves and answers only a Meta model (lib/meta/models.ts): the organizers ruled on Nov 2 that every model a
 * project calls must be Meta's. Checked before anything is sent. The simulated board holds no model, so its stand-in passes.
 */
function onlyMeta(kind: BoardKind, alias: string): void {
  if (kind !== "simulated" && !isMetaModelName(alias)) throw new Error("That isn't a Meta model, so nothing was sent to the board. Muse Muse only runs Meta models.");
}

export function fleetBoard(config: FleetConfig, kind: BoardKind = "fleet", doFetch: typeof fetch = fetch, stopWaitMs: number = STOP_WAIT_MS): BoardDriver {
  const base = config.url.replace(/\/+$/, "");

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await doFetch(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", ...init.headers },
        signal: init.signal ?? AbortSignal.timeout(CALL_MS),
        cache: "no-store",
      });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new BoardOfflineError("The board can't be reached.");
    }
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await call(path, init);
    if (!res.ok) throw new BoardOfflineError(`The fleet answered ${res.status}.`);
    return (await res.json()) as T;
  }

  async function findNode(): Promise<FleetNode | null> {
    const nodes = await json<FleetNode[]>("/api/nodes");
    return nodes.find((n) => n.id === config.node || n.name === config.node) ?? null;
  }

  async function nodeOrThrow(): Promise<FleetNode> {
    const node = await findNode();
    if (!node) throw new BoardOfflineError("The fleet has no such board.");
    return node;
  }

  async function exec(command: string, timeoutS: number): Promise<string> {
    const node = await nodeOrThrow();
    const job = await json<FleetJob>(`/api/nodes/${encodeURIComponent(node.id)}/actions`, {
      method: "POST",
      body: JSON.stringify({ action: "exec", params: { command }, timeout_s: timeoutS }),
    });
    return job.id;
  }

  /** Keeps ordinary traffic off the board while its model changes (gguf-serve.sh's own instruction). */
  async function setMaintenance(on: boolean): Promise<void> {
    const node = await nodeOrThrow();
    if (node.maintenance === on) return;
    await json(`/api/nodes/${encodeURIComponent(node.id)}`, { method: "PATCH", body: JSON.stringify({ maintenance: on }) });
  }

  return {
    kind,
    async status(): Promise<BoardStatus> {
      const node = await findNode().catch((err) => {
        if (err instanceof BoardOfflineError) return null;
        throw err;
      });
      if (!node) return { online: false, name: null, loadedModels: [] };
      return { online: node.status === "online", name: node.name, loadedModels: node.loaded_models ?? [] };
    },
    async metrics(): Promise<BoardMetrics> {
      const m = (await nodeOrThrow()).metrics;
      const mw = m?.power_mw?.total;
      return {
        memUsedMb: m?.mem?.used_mb ?? null,
        memTotalMb: m?.mem?.total_mb ?? null,
        tempC: m?.temps_c?.tj ?? m?.temps_c?.cpu ?? null,
        powerW: typeof mw === "number" ? mw / 1000 : null,
      };
    },
    install: (file) => exec(installCommand(file), INSTALL_TIMEOUT_S),
    async serve(file) {
      onlyMeta(kind, file.alias);
      await setMaintenance(true);
      return exec(serveCommand(file, base), SERVE_TIMEOUT_S);
    },
    async workState(handle): Promise<BoardWork> {
      const job = await json<FleetJob>(`/api/jobs/${encodeURIComponent(handle)}`);
      if (job.status === "running") return { state: "running" };
      const task = job.tasks[0];
      // exec's ok is true even for a command that exited non-zero, so the exit code is what counts (protocol.md).
      const exit = task?.result?.exit_code;
      if (job.status === "succeeded" && (exit === undefined || exit === 0)) return { state: "done" };
      return { state: "failed", message: (task?.error ?? `The board's command exited ${exit ?? "with an error"}.`).slice(0, 300) };
    },
    async isServing(alias) {
      const node = await nodeOrThrow();
      const up = node.status === "online" && (node.loaded_models ?? []).includes(alias);
      if (up) await setMaintenance(false);
      return up;
    },
    async ask(input) {
      onlyMeta(kind, input.alias);
      return askFleet(call, (await nodeOrThrow()).id, input);
    },
    /** Maintenance comes off only once the board says the model left. Otherwise it stays on, and this throws to say so. */
    async stop(alias) {
      await exec(stopCommand(base), SERVE_TIMEOUT_S);
      const until = Date.now() + stopWaitMs;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(STOP_POLL_MS, stopWaitMs)));
        const node = await findNode().catch(() => null);
        if (node?.status === "online" && !(node.loaded_models ?? []).includes(alias)) return setMaintenance(false);
      }
      throw new BoardOfflineError("The board didn't confirm the stop, so it stays in maintenance.");
    },
  };
}

/** One streamed chat through the gateway, pinned to this board, timed here. */
async function askFleet(
  call: (path: string, init?: RequestInit) => Promise<Response>,
  nodeId: string,
  { alias, messages, maxTokens, signal }: BoardAsk,
): Promise<BoardAnswer> {
  const started = Date.now();
  const res = await call("/v1/chat/completions", {
    method: "POST",
    headers: { "x-jcp-node": nodeId },
    body: JSON.stringify({ model: alias, messages, max_tokens: maxTokens, stream: true, temperature: 0 }),
    signal: signal ?? AbortSignal.timeout(ASK_MS),
  });
  if (res.status === 429) throw new BoardBusyError(Number(res.headers.get("retry-after")) || 5);
  if (!res.ok || !res.body) throw new BoardOfflineError(`The board didn't answer (${res.status}).`);

  let text = "";
  let usageTokens: number | null = null;
  let chunks = 0;
  let firstTokenMs: number | null = null;
  let finish: string | null = null;
  const decoder = new TextDecoder();
  let held = "";
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    held += decoder.decode(value, { stream: true });
    const lines = held.split("\n");
    held = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const data = JSON.parse(line.slice(6)) as {
        choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
        usage?: { completion_tokens?: number } | null;
      };
      const choice = data.choices?.[0];
      if (choice?.delta?.content) {
        firstTokenMs ??= Date.now() - started;
        text += choice.delta.content;
        chunks += 1;
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (typeof data.usage?.completion_tokens === "number") usageTokens = data.usage.completion_tokens;
    }
  }
  const ms = Date.now() - started;
  const tokens = usageTokens ?? chunks;
  // Tokens a second over generation only, so a slow first token doesn't hide in it. It's what llama-server reports too.
  const generating = firstTokenMs === null ? ms : Math.max(1, ms - firstTokenMs);
  return { text, tokens, ms, firstTokenMs, tokensPerSecond: tokensPerSecond(Math.max(0, tokens - 1), generating), finish };
}
