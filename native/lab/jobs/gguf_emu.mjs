// gguf_emu: runs a tuned model's GGUF on the Android emulator with llama.cpp's llama-server, sends the job's fixed prompts,
// and reports tokens per second, memory and the answers. No clip and no screenshots: nothing here draws on the screen. The
// emulator stays up for the next job, and what this pushed comes off it again whatever happens.
import { stat } from "node:fs/promises";
import { LabError } from "../lib/errors.mjs";
import { adbForward, adbForwardRemove, adbProp, adbPush, adbRaw, EMULATOR_SERIAL as SERIAL } from "../lib/commands.mjs";
import { ensureEmulator } from "./android_emu.mjs";
import { must, waitFor } from "./common.mjs";

const REMOTE_DIR = "/data/local/tmp/mm-sim";
const PORT = 18481;
const CONTEXT = 2048;
/** Left at the end of the job for cleaning up and uploading. */
const RESERVE_MS = 60_000;
/** Kept free on the emulator's disk once the file is there. */
const DISK_SPARE_KB = 512 * 1024;
const PROMPT_MAX_MS = 240_000;
const ANSWER_MAX = 2000;

/** The kB beside a name in /proc/meminfo or /proc/<pid>/status, or null. */
export function kbOf(text, name) {
  const found = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(text);
  return found ? Number(found[1]) : null;
}

/** The available kB in `df -k <path>`'s last line, or null. */
export function freeKbOf(dfText) {
  const last = String(dfText).trim().split(/\r?\n/).at(-1) ?? "";
  const available = Number(last.trim().split(/\s+/)[3]);
  return Number.isFinite(available) ? available : null;
}

/** Why this file can't run on this device, or null. Its pages must fit in RAM, and it must fit on the disk. */
export function fitProblem({ fileBytes, memTotalKb, diskFreeKb }) {
  const fileKb = Math.ceil(fileBytes / 1024);
  if (memTotalKb !== null && fileKb >= memTotalKb) return `The file needs about ${gb(fileKb)} GB of memory and the emulator has ${gb(memTotalKb)} GB.`;
  if (diskFreeKb !== null && fileKb + DISK_SPARE_KB > diskFreeKb) return `The file is ${gb(fileKb)} GB and the emulator has ${gb(diskFreeKb)} GB of disk free.`;
  return null;
}

const gb = (kb) => (kb / 1024 ** 2).toFixed(1);

/** Plain facts out of one chat completion. The tokens and speed are llama-server's own, or counted here when it has none. */
export function readCompletion(body, elapsedMs) {
  const timings = body?.timings ?? {};
  const message = body?.choices?.[0]?.message ?? {};
  const tokens = Number(timings.predicted_n ?? body?.usage?.completion_tokens ?? 0) || 0;
  const generateMs = Number(timings.predicted_ms ?? elapsedMs) || elapsedMs;
  const perSecond = Number(timings.predicted_per_second);
  return {
    answer: typeof message.content === "string" ? message.content.trim().slice(0, ANSWER_MAX) : "",
    tokens,
    generateMs,
    tokensPerSecond: Number.isFinite(perSecond) && perSecond > 0 ? perSecond : generateMs > 0 ? (tokens * 1000) / generateMs : 0,
    finish: typeof body?.choices?.[0]?.finish_reason === "string" ? body.choices[0].finish_reason.slice(0, 20) : null,
  };
}

async function shellText(ctx, line) {
  return String((await ctx.exec(adbRaw(SERIAL, line), { timeoutMs: 15_000 })).stdout);
}

/** Runs even after the job was aborted, so it can't take the job's signal. */
async function cleanUp(ctx) {
  const opts = { timeoutMs: 20_000, signal: undefined };
  await ctx.exec(adbRaw(SERIAL, "pkill -9 llama-server"), opts);
  await ctx.exec(adbForwardRemove(SERIAL, PORT), opts);
  await ctx.exec(adbRaw(SERIAL, `rm -rf ${REMOTE_DIR}`), opts);
}

function memoryNow(status, peak) {
  const peakKb = kbOf(status, "VmHWM");
  const rssKb = kbOf(status, "VmRSS");
  return { peakKb: Math.max(peak.peakKb ?? 0, peakKb ?? 0) || null, rssKb: rssKb ?? peak.rssKb };
}

function notRun(device, reason, simTune) {
  return {
    evaluation: { passed: false, informational: false, checks: [{ id: "model", ok: false, detail: reason }], reasons: [reason], warnings: [] },
    device,
    files: [],
    warnings: [],
    captionBurned: false,
    facts: { simTune },
    simTune,
  };
}

export async function runGgufEmu(ctx) {
  const { input, config } = ctx;
  const jobStart = ctx.now();
  const endBy = jobStart + input.limitSeconds * 1000 - RESERVE_MS;
  const binary = config.android.llamaServer;
  if (!(await stat(binary).catch(() => null))?.isFile()) throw new LabError("tool_missing", "llama-server for Android isn't on this box. Run setup/llama-android.sh.");

  ctx.setPhase("download");
  const model = await ctx.downloadHub(input.gguf);

  ctx.setPhase("boot");
  await ensureEmulator(ctx);
  const os = String((await ctx.exec(adbProp(SERIAL, "ro.build.version.release"), { timeoutMs: 15_000 })).stdout).trim();
  const device = { name: input.device.name ?? config.android.deviceLabel, os };

  await cleanUp(ctx);
  const memTotalKb = kbOf(await shellText(ctx, "cat /proc/meminfo"), "MemTotal");
  const measured = { loadMs: null, memory: { peakKb: null, rssKb: null, totalKb: memTotalKb }, runs: [], stoppedEarly: false };
  const problem = fitProblem({ fileBytes: input.gguf.bytes, memTotalKb, diskFreeKb: freeKbOf(await shellText(ctx, "df -k /data/local/tmp")) });
  if (problem) return notRun(device, problem, measured);

  try {
    ctx.setPhase("install");
    await must(ctx, "install_failed", "Couldn't make a folder on the emulator.", adbRaw(SERIAL, `mkdir -p ${REMOTE_DIR}`), { timeoutMs: 15_000 });
    await must(ctx, "install_failed", "llama-server wouldn't copy to the emulator.", adbPush(SERIAL, binary, `${REMOTE_DIR}/llama-server`), { timeoutMs: 120_000 });
    await must(ctx, "install_failed", "llama-server couldn't be made runnable.", adbRaw(SERIAL, `chmod 755 ${REMOTE_DIR}/llama-server`), { timeoutMs: 15_000 });
    await must(ctx, "install_failed", "The model wouldn't copy to the emulator.", adbPush(SERIAL, model, `${REMOTE_DIR}/model.gguf`), { timeoutMs: Math.max(30_000, endBy - ctx.now()) });
    await must(ctx, "install_failed", "Couldn't reach the emulator's port.", adbForward(SERIAL, PORT), { timeoutMs: 15_000 });

    ctx.setPhase("probe");
    const server = ctx.startProc(
      adbRaw(SERIAL, `cd ${REMOTE_DIR} && exec ./llama-server -m model.gguf -c ${CONTEXT} -np 1 -ngl 0 --jinja --host 127.0.0.1 --port ${PORT}`),
    );
    const loadStart = ctx.now();
    const base = `http://127.0.0.1:${PORT}`;
    const ready = await waitFor(
      ctx,
      async () => {
        if (server.exited) return "stopped";
        const res = await ctx.fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        return res?.status === 200 ? "up" : null;
      },
      { timeoutMs: Math.max(5000, endBy - ctx.now()), everyMs: 2000 },
    );
    if (ready !== "up") return notRun(device, ready === "stopped" ? "The model didn't load: llama-server stopped." : "The model didn't load in time.", measured);
    measured.loadMs = ctx.now() - loadStart;

    ctx.setPhase("report");
    for (const prompt of input.prompts) {
      ctx.throwIfAborted();
      const left = endBy - ctx.now();
      if (left <= 0) {
        measured.stoppedEarly = true;
        break;
      }
      const started = ctx.now();
      const entry = { id: prompt.id, answer: "", tokens: 0, generateMs: 0, tokensPerSecond: 0, finish: null, error: null };
      try {
        const res = await ctx.fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: [...(input.systemLine ? [{ role: "system", content: input.systemLine }] : []), { role: "user", content: prompt.text }],
            max_tokens: input.maxTokens,
            temperature: 0,
            stream: false,
            cache_prompt: false,
          }),
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.min(left, PROMPT_MAX_MS))]),
        });
        if (res.ok) Object.assign(entry, readCompletion(await res.json(), ctx.now() - started));
        else entry.error = `llama-server answered ${res.status}.`;
      } catch {
        ctx.throwIfAborted();
        entry.error = "No answer in time.";
      }
      measured.runs.push(entry);
      measured.memory = { ...measured.memory, ...memoryNow(await shellText(ctx, "cat /proc/$(pidof llama-server)/status"), measured.memory) };
      if (server.exited) {
        entry.error = entry.error ?? "llama-server stopped.";
        break;
      }
    }
  } finally {
    await cleanUp(ctx);
  }

  const answered = measured.runs.filter((r) => r.answer).length;
  const all = input.prompts.length;
  const reasons = answered === all ? [] : [`${answered} of ${all} prompts got a final answer.`];
  const checks = [
    { id: "model", ok: true, detail: "The model loaded on the emulator." },
    { id: "answers", ok: answered === all, detail: `${answered} of ${all} prompts got a final answer.` },
  ];
  return {
    evaluation: { passed: answered === all, informational: false, checks, reasons, warnings: [], loadMs: measured.loadMs },
    device,
    files: [],
    warnings: [],
    captionBurned: false,
    facts: { simTune: measured },
    simTune: measured,
  };
}
