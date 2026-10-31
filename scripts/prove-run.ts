/**
 * Runs the Prove it stage's real work on one product that is already live, from this machine, with no database: for
 * testing the stage before it is deployed (docs/PRODUCT_OUTPUTS.md).
 *
 *   npx tsx --env-file=.env.local scripts/prove-run.ts --slug=<slug> --sandbox=<sandbox> --live-url=<url> --site=<https origin> --out=<dir>
 *     --fetch          download the CLI, skill and plugin from the site. Without it they are put in place directly, for a
 *                      site whose deployed code doesn't have these routes yet, and the run says so
 *     --no-skill       skip the skill test, which is the part that costs money at Meta on Muse Code
 *     --no-record      skip the videos
 *     --model=<id>     the skill test's model (default muse-wonder-1.0). Never muse-spark-1.3
 *     --cap=<usd>      stop the skill test when it has spent this much (default PROVE_IT_CAP_USD)
 *
 * It copies the product's sandbox, reads the manifest from the copy, runs the checks there against the live product,
 * then saves results.json, what Muse Code did, and each video to <out>. It deletes the copy at the end, writes nothing to
 * the database or Blob, and leaves the product's own sandbox as it is. Calling the product's actions spends at Meta on the
 * product's own token, which this script can't see: check the product's usage for that part.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { PROVE_SCENE_SOURCE } from "@/lib/outputs/assets-source";
import { skillName } from "@/lib/outputs/generate";
import {
  describeResult,
  generatedFilesFor,
  judgeSkillTest,
  parseProveResults,
  planChecks,
  PROVE_MODEL,
  sceneFor,
  skillScene,
  skillTestCall,
  skillTestFacts,
  skillTestPrompt,
  SKILL_TEST_MAX_STEPS,
  studioSpecFor,
  type ProvedOutput,
  type ProveRunSpec,
} from "@/lib/outputs/prove";
import { env } from "@/lib/env";
import {
  deleteProveCopy,
  forkForProve,
  killCommand,
  museRunSpendUsd,
  pollMuse,
  pollTask,
  readManifest,
  readSandboxText,
  startProveCommand,
  startSkillTest,
  uploadProveVideo,
  writeProveFiles,
} from "@/lib/sandbox/builder";
import { newSessionId, type BuildModel } from "@/lib/sandbox/muse";
import { DEMO_RECORDING_DIR, PRODUCT_DIR } from "@/lib/sandbox/paths";
import { publicHost } from "@/lib/sandbox/policy";
import { PROVE_CHECKS_ARGV, proveCheckFiles, PROVE_CONFIG, PROVE_DIR, proveConfigFile, proveRecordScript, PROVE_SKILL_DIR, PROVE_SPEC, proveSpecFile } from "@/lib/sandbox/prove-tasks";
import type { ModelUsage } from "@/lib/types";

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
}
function need(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const slug = need("slug");
const source = need("sandbox");
const liveUrl = need("live-url");
const site = need("site").replace(/\/+$/, "");
const outDir = path.resolve(need("out"));
const model = (arg("model") || PROVE_MODEL) as BuildModel;
const capUsd = Number(arg("cap") || env.proveItCapUsd);
if ((model as string) === "muse-spark-1.3") throw new Error("This platform never uses muse-spark-1.3.");
mkdirSync(outDir, { recursive: true });

const started = Date.now();
const log = (text: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s] ${text}`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const usageUsd = (items: readonly ModelUsage[]) => items.reduce((sum, u) => sum + (u.costUsd || 0), 0);

async function waitTask(copy: string, cmdId: string, capMs: number): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    await wait(5000);
    const poll = await pollTask(copy, cmdId);
    if (poll.done) {
      if (poll.exitCode) log(`it exited ${poll.exitCode}: ${poll.outputTail.slice(-600)}`);
      return false;
    }
    if (Date.now() - t0 > capMs) {
      await killCommand(copy, cmdId);
      return true;
    }
  }
}

async function main(): Promise<void> {
  const { sandboxName: copy } = await forkForProve(source, { liveHost: publicHost(liveUrl) ?? "", platformHost: publicHost(site) });
  log(`copied ${source} to ${copy}`);
  try {
    const manifest = await readManifest(copy);
    if (!manifest) throw new Error("The sandbox has no usable musemuse.json");
    const product = { slug, name: manifest.name, tagline: manifest.tagline, liveUrl, manifest };
    const spec: ProveRunSpec = planChecks({
      product,
      origin: site,
      dir: PROVE_DIR,
      capUsd,
      estimatedCostPerRunUsd: manifest.estimatedCostPerRunUsd,
      fetchable: arg("fetch") !== null,
    });
    log(`${spec.actionNames.length} actions, calling ${spec.calls.map((c) => c.name).join(", ") || "none"}`);
    await writeProveFiles(copy, [...proveCheckFiles(spec), ...(spec.downloads ? [] : generatedFilesFor(product, site, PROVE_DIR))]);

    const checks = await startProveCommand(copy, { tag: "prove-checks", cwd: PROVE_DIR, argv: PROVE_CHECKS_ARGV });
    const timedOut = await waitTask(copy, checks.cmdId, 14 * 60_000);
    log(timedOut ? "the checks hit their cap" : "the checks finished");
    const text = await readSandboxText(copy, `${PROVE_DIR}/results.json`);
    writeFileSync(path.join(outDir, "results.json"), text ?? "");
    const results = parseProveResults(text);
    const passed: ProvedOutput[] = [];
    for (const output of ["mcp", "cli", "claude_plugin"] as const) {
      const said = describeResult(output, results?.outputs[output]);
      log(`${output}: ${said.state}: ${said.title}${said.detail ? ` (${said.detail})` : ""}`);
      if (said.state === "done") passed.push(output);
    }
    log(`skill file: ${results?.outputs.skill?.ok ? "reads right" : JSON.stringify(results?.outputs.skill?.facts)}`);

    let skillSceneInput: { lines: string[]; finalText: string | null; command: string; seconds: number } | null = null;
    const call = results ? skillTestCall(spec, results.outputs.mcp) : null;
    if (arg("no-skill") === null && call && results?.outputs.skill?.ok) {
      const skill = skillName(slug);
      const skillText = await readSandboxText(copy, `${PROVE_DIR}/SKILL.md`);
      await writeProveFiles(copy, [
        { path: `${PROVE_SKILL_DIR}/.agents/skills/${skill}/SKILL.md`, content: skillText ?? "" },
        { path: `${PROVE_SKILL_DIR}/prompt.md`, content: skillTestPrompt({ skill, action: call.name, args: call.args }) },
      ]);
      const run = await startSkillTest({ sandboxName: copy, cwd: PROVE_SKILL_DIR, model, maxModelSteps: SKILL_TEST_MAX_STEPS, sessionId: newSessionId() });
      log(`skill test: ${run.command}`);
      const t0 = Date.now();
      let offset = 0;
      let announced: string[] = [];
      let childrenIncluded: boolean | null = null;
      let finalText: string | null = null;
      let exitCode: number | null = null;
      let stopped = false;
      let charged = 0;
      for (;;) {
        await wait(10_000);
        const poll = await pollMuse({ sandboxName: copy, cmdId: run.cmdId, logPath: run.logPath, offset, announced, childrenIncluded, engine: "exec" });
        offset = poll.offset;
        announced = poll.announced ?? announced;
        childrenIncluded = poll.childrenIncluded ?? childrenIncluded;
        finalText = poll.finalText ?? finalText;
        for (const l of poll.lines) log(`  ${l.kind}${l.tool ? ` ${l.tool}` : ""}: ${l.text.slice(0, 140)}`);
        charged += usageUsd(poll.usage) + usageUsd(poll.session?.unreported.usage ?? []) + (childrenIncluded === true ? 0 : usageUsd(poll.session?.children.usage ?? []));
        if (poll.done) {
          exitCode = poll.exitCode;
          break;
        }
        const spent = await museRunSpendUsd(copy, run.logPath);
        if (spent >= capUsd || Date.now() - t0 > 6 * 60_000) {
          log(`stopping the skill test at $${spent.toFixed(3)}`);
          stopped = true;
          await killCommand(copy, run.cmdId);
          const last = await pollMuse({ sandboxName: copy, cmdId: run.cmdId, logPath: run.logPath, offset, announced, childrenIncluded, engine: "exec" });
          charged += usageUsd(last.usage) + usageUsd(last.session?.unreported.usage ?? []) + usageUsd(last.session?.children.usage ?? []);
          break;
        }
      }
      log(`skill test ended with exit code ${exitCode}. Muse Code spent $${charged.toFixed(4)}`);
      const skillLog = (await readSandboxText(copy, run.logPath)) ?? "";
      writeFileSync(path.join(outDir, "skill-log.jsonl"), skillLog);
      const facts = skillTestFacts(skillLog, { skill, action: call.name, liveHost: publicHost(liveUrl) ?? "" });
      const reply = await readSandboxText(copy, `${PROVE_SKILL_DIR}/reply.json`);
      writeFileSync(path.join(outDir, "skill-reply.json"), reply ?? "");
      const judged = judgeSkillTest({ exitCode, timedOut: stopped, readSkill: facts.readSkill, calledAction: facts.calledAction, reply, action: call.name });
      log(`skill test: ${judged.ok ? "passed" : `failed: ${judged.problem}`}. ${JSON.stringify(judged.checks)}`);
      if (judged.ok) passed.push("skill");
      skillSceneInput = { lines: facts.lines, finalText, command: run.command, seconds: (Date.now() - t0) / 1000 };
    }

    if (arg("no-record") === null && passed.length) {
      const at = new Date();
      const files: Array<{ path: string; content: string }> = [
        { path: `${PROVE_DIR}/scene.html`, content: PROVE_SCENE_SOURCE },
        { path: `${PRODUCT_DIR}/${PROVE_CONFIG}`, content: proveConfigFile() },
        { path: `${PRODUCT_DIR}/${PROVE_SPEC}`, content: proveSpecFile() },
      ];
      for (const output of passed) {
        const scene =
          output === "skill"
            ? skillSceneInput && skillScene({ name: product.name, at, download: results?.outputs.skill, ...skillSceneInput, ok: true })
            : results?.outputs[output] && sceneFor(output, results.outputs[output], { name: product.name, at });
        if (!scene) continue;
        writeFileSync(path.join(outDir, `scene-${output}.json`), JSON.stringify(scene, null, 2));
        files.push(
          { path: `${PROVE_DIR}/scene-${output}.json`, content: JSON.stringify(scene) },
          {
            path: `${PROVE_DIR}/studio-${output}.json`,
            content: JSON.stringify(studioSpecFor(output, { name: product.name, origin: site, slug, timeline: `${PRODUCT_DIR}/${DEMO_RECORDING_DIR}/timeline.json`, out: `${PROVE_DIR}/video/${output}` })),
          },
        );
      }
      await writeProveFiles(copy, files);
      const recording = await startProveCommand(copy, { tag: "prove-record", cwd: PRODUCT_DIR, argv: ["bash", "-c", proveRecordScript(passed)] });
      const t0 = Date.now();
      const capped = await waitTask(copy, recording.cmdId, 20 * 60_000);
      log(`recording ${capped ? "hit its cap" : "finished"} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      const box = await Sandbox.get({ name: copy });
      writeFileSync(path.join(outDir, "record.log"), (await readSandboxText(copy, "/vercel/musemuse/logs/prove-record.log")) ?? "");
      for (const output of passed) {
        const video = await uploadProveVideo({ sandboxName: copy, buildId: "local", output, dir: `${PROVE_DIR}/video/${output}`, skipUpload: true });
        if (!video?.videoUrl) {
          log(`${output}: no video`);
          continue;
        }
        for (const [name, from] of [["mp4", "demo.mp4"], ["jpg", "poster.jpg"]] as const) {
          const buf = await box.readFileToBuffer({ path: `${PROVE_DIR}/video/${output}/${from}` }).catch(() => null);
          if (buf) writeFileSync(path.join(outDir, `${output}.${name}`), buf);
        }
        log(`${output}: saved its video`);
      }
    }
  } finally {
    await deleteProveCopy(copy).then(
      () => log(`deleted ${copy}`),
      (err: unknown) => console.error(`delete ${copy}: ${String(err)}`),
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
