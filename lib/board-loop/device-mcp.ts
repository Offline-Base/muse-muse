/**
 * The board loop's driver for a board's own MCP server (muse-device/server.py, through lib/device/client.ts). install_model
 * waits about 5 minutes at most, by its own description, so a 6.5 GB one-bit file won't finish here, and that file is the
 * only Meta model the loop makes for a board: a tune on the small Llama is refused (lib/meta/models.ts, Nov 2). So this
 * path suits a one-bit file already on the board. Never run against a real board yet (docs/JETSON_TODO.md).
 */
import { callDeviceTool, type DeviceConfig } from "@/lib/device/client";
import { boardModelProblem } from "@/lib/device/meta-only";
import { boardText, DeviceRefusedError } from "@/lib/device/train";
import { BoardOfflineError, type BoardDriver, type BoardFile, type BoardMetrics, type BoardStatus } from "@/lib/board-loop/driver";

const SERVE_CONTEXT = 2048;
const MB_PER_GIB = 1024;

type Caller = typeof callDeviceTool;

async function reach<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof DeviceRefusedError) throw err;
    throw new BoardOfflineError("The board can't be reached.");
  }
}

export function deviceMcpBoard(config: DeviceConfig, call: Caller = callDeviceTool): BoardDriver {
  const tool = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
    reach(async () => {
      // Only Meta models start or answer here, as on /api/device and for Wonder. The board refuses the same itself.
      const problem = await boardModelProblem(name, args, (n, a) => call(config, n, a));
      if (problem) throw new DeviceRefusedError(problem);
      return JSON.parse(boardText(await call(config, name, args))) as T;
    });
  /** Its tools finish before they answer, so a handle is only its result. */
  const finished = "done";

  return {
    kind: "device",
    async status(): Promise<BoardStatus> {
      try {
        const info = await tool<{ running?: { model?: string } | null }>("list_models");
        return { online: true, name: "this board", loadedModels: info.running?.model ? [info.running.model] : [] };
      } catch {
        return { online: false, name: null, loadedModels: [] };
      }
    },
    async metrics(): Promise<BoardMetrics> {
      const info = await tool<{ memory_gib?: { total?: number; available?: number }; max_temp_c?: number | null }>("describe_device");
      const total = info.memory_gib?.total;
      const free = info.memory_gib?.available;
      return {
        memTotalMb: typeof total === "number" ? total * MB_PER_GIB : null,
        memUsedMb: typeof total === "number" && typeof free === "number" ? (total - free) * MB_PER_GIB : null,
        tempC: info.max_temp_c ?? null,
        powerW: null,
      };
    },
    async install(file: BoardFile) {
      if (!file.url || !file.sha256) throw new Error("A real file needs an address and a checksum before it can go to a board.");
      // The board hashes what it downloaded (muse-device/server.py), so a file that doesn't match never gets served.
      const { sha256 } = await tool<{ sha256?: string }>("install_model", { url: file.url, name: file.name });
      if (sha256 !== file.sha256) throw new Error(`${file.name} reached the board with the wrong checksum, or the board didn't report one. It wasn't served. Remove it from the board before trying again.`);
      return finished;
    },
    async serve(file: BoardFile) {
      await tool("start_model", { model: file.name, context: SERVE_CONTEXT });
      return finished;
    },
    workState: async () => ({ state: "done" }),
    isServing: async () => (await tool<{ running?: unknown }>("list_models")).running != null,
    async ask({ messages, maxTokens }) {
      const system = messages.find((m) => m.role === "system")?.content;
      const prompt = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
      const started = Date.now();
      const reply = await tool<{ answer: string; finish_reason?: string; tokens?: number; tokens_per_second?: number }>("ask_model", {
        prompt,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
      });
      return {
        text: reply.answer,
        tokens: reply.tokens ?? 0,
        ms: Date.now() - started,
        firstTokenMs: null,
        tokensPerSecond: reply.tokens_per_second ?? 0,
        finish: reply.finish_reason ?? null,
      };
    },
    async stop() {
      await tool("stop_model");
    },
  };
}
