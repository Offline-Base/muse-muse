/**
 * The loop's demo clip (docs/BOARD_LOOP.md): the fixed test set's real answers, played as a terminal scene and recorded by
 * Demo Studio, the same recorder and scene Prove it uses. Every caption says what ran, and on a simulated board that is the
 * words "Simulated board". It runs where Playwright and ffmpeg are, named by BOARD_CLIP_TOOLS_DIR (a folder with
 * @playwright/test in its node_modules), so it runs on a machine and not in a Vercel function. Without them the stage says so.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { boardLabel, SIMULATED_NOTE, type ClipRecord, type LoopRow } from "@/lib/board-loop/logic";
import { PROVE_SCENE_SOURCE } from "@/lib/outputs/assets-source";
import { demoVideoProblem } from "@/lib/sandbox/artifacts";
import { proveConfigFile, proveSpecFile, PROVE_CONFIG, PROVE_SPEC } from "@/lib/sandbox/prove-tasks";
import { DEMO_RECORDING_DIR } from "@/lib/sandbox/paths";
import { putFile } from "@/lib/storage";

const STUDIO_FILES = ["tests/demo-fixtures.ts", "scripts/demo-plan.mjs", "scripts/demo-studio.mjs", "scripts/demo-inter.woff2", "scripts/browser.json"];
const RECORD_MS = 150_000;
const RENDER_MS = 240_000;
const MAX_LINE = 76;

function wrap(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
    if (line && line.length + word.length + 1 > MAX_LINE) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** The scene prove-scene.html plays: a caption and a command for each prompt, and the real answer and numbers. */
export function clipScene(row: LoopRow) {
  const label = boardLabel(row.target);
  const simulated = row.target === "simulated";
  const test = row.data.test;
  const memory = test.peakMemMb === null ? "not reported" : simulated ? `${test.peakMemMb} MB (the small process's own, not a board's)` : `${test.peakMemMb} of ${test.memTotalMb ?? "?"} MB`;
  return {
    output: "board",
    title: `${label}: ${row.data.title}`.slice(0, 70),
    note: simulated ? "Canned text. No model ran." : new Date(row.updatedAt).toISOString().slice(0, 10),
    steps: [
      ...test.runs.map((r) => ({
        caption: `${label}: "${r.prompt}"`.slice(0, 60),
        command: `ask ${simulated ? "simulated-board" : "board"} "${r.prompt}"`.slice(0, 120),
        lines: [...wrap(r.error ?? r.answer), `${r.tokens} tokens, ${r.tokensPerSecond} tokens/s`],
        ok: !r.error,
        seconds: r.ms / 1000,
        took: `${(r.ms / 1000).toFixed(1)} s`,
      })),
      {
        caption: `${label}: the numbers`.slice(0, 60),
        command: "board-report",
        lines: [
          `Mean speed: ${test.tokensPerSecond ?? "?"} tokens/s`,
          `Peak memory: ${memory}`,
          ...(simulated ? wrap(SIMULATED_NOTE) : []),
        ],
        ok: true,
        seconds: 0,
        took: "",
      },
    ],
  };
}

export function clipCaption(row: LoopRow): string {
  return row.target === "simulated" ? `Captioned "${boardLabel(row.target)}" throughout: canned text, no model.` : `Captioned "${boardLabel(row.target)}".`;
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, limitMs: number): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const take = (chunk: Buffer) => (tail = (tail + chunk.toString("utf8")).slice(-1500));
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), limitMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, tail });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, tail });
    });
  });
}

/** Records on this machine. A skip says why in a sentence for the stage. */
export async function recordClipHere(row: LoopRow, toolsDir: string | undefined = process.env.BOARD_CLIP_TOOLS_DIR?.trim()): Promise<ClipRecord | { skipped: string }> {
  if (process.env.VERCEL) return { skipped: "No clip: recording needs Playwright and ffmpeg on a machine, and this run is in a Vercel function." };
  if (!toolsDir || !existsSync(path.join(toolsDir, "node_modules", "@playwright", "test"))) {
    return { skipped: "No clip: BOARD_CLIP_TOOLS_DIR doesn't name a folder with @playwright/test." };
  }
  const dir = await mkdtemp(path.join(tmpdir(), "board-clip-"));
  try {
    for (const file of STUDIO_FILES) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await cp(path.join(process.cwd(), "template", file), path.join(dir, file));
    }
    await symlink(path.join(toolsDir, "node_modules"), path.join(dir, "node_modules"));
    await mkdir(path.dirname(path.join(dir, PROVE_SPEC)), { recursive: true });
    const out = path.join(dir, "video");
    await mkdir(out);
    const label = boardLabel(row.target);
    await Promise.all([
      writeFile(path.join(dir, PROVE_CONFIG), proveConfigFile()),
      writeFile(path.join(dir, PROVE_SPEC), proveSpecFile()),
      writeFile(path.join(dir, "scene.html"), PROVE_SCENE_SOURCE),
      writeFile(path.join(dir, "scene.json"), JSON.stringify(clipScene(row))),
      writeFile(
        path.join(dir, "studio.json"),
        JSON.stringify({
          title: `${label}: ${row.data.title}`.slice(0, 80),
          tagline: row.target === "simulated" ? "Canned text from a small process. No model ran." : "The fixed test set, on the board.",
          models: [],
          url: null,
          timeline: path.join(dir, DEMO_RECORDING_DIR, "timeline.json"),
          out,
        }),
      ),
    ]);
    const env = { ...process.env, PROVE_SCENE: path.join(dir, "scene.json"), PROVE_SCENE_URL: `file://${dir}/scene.html` };
    const recorded = await run(path.join(dir, "node_modules/.bin/playwright"), ["test", "--config", PROVE_CONFIG, "--project=studio", "--workers=1"], dir, env, RECORD_MS);
    if (recorded.code !== 0) return { skipped: `No clip: the recording failed. ${recorded.tail.slice(-160)}` };
    let rendered = await run(process.execPath, ["scripts/demo-studio.mjs", "--spec", "studio.json"], dir, env, RENDER_MS);
    if (rendered.code !== 0) rendered = await run(process.execPath, ["scripts/demo-studio.mjs", "--spec", "studio.json", "--basic"], dir, env, RENDER_MS);
    if (rendered.code !== 0) return { skipped: `No clip: the render failed. ${rendered.tail.slice(-160)}` };

    const mp4 = path.join(out, "demo.mp4");
    const probe = await runProbe(mp4, dir);
    const problem = demoVideoProblem(probe);
    if (problem) return { skipped: `No clip: ${problem}.` };
    const videoUrl = await putFile("demos", `board-loop/${row.id}.mp4`, await readFile(mp4), "video/mp4");
    const posterPath = path.join(out, "poster.jpg");
    const posterUrl = existsSync(posterPath) ? await putFile("demos", `board-loop/${row.id}.jpg`, await readFile(posterPath), "image/jpeg") : null;
    return { videoUrl, posterUrl, captioned: clipCaption(row) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runProbe(mp4: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-show_entries", "format=duration", "-of", "json", mp4], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    child.stdout.on("data", (c: Buffer) => (text += c.toString("utf8")));
    child.on("close", () => resolve(text));
    child.on("error", () => resolve(""));
  });
}
