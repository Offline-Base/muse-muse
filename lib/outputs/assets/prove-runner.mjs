// Prove it (docs/PRODUCT_OUTPUTS.md): runs a product's outputs against the live product, as a person would, with curl and
// node in a throwaway sandbox. Every command's real output and time go to results.json, which the platform turns into
// each output's result and the terminal scene Demo Studio records. Written into the sandbox by the platform before each
// run. No dependencies.
//   node prove-runner.mjs <spec.json>
import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUTPUT_CAP = 64 * 1024;
const COMMAND_TIMEOUT_S = 40;

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const dir = spec.dir;
const resultsPath = path.join(dir, "results.json");
const results = { startedAt: new Date().toISOString(), finishedAt: null, outputs: {} };

function save() {
  const tmp = `${resultsPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(results));
  renameSync(tmp, resultsPath);
}

const q = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

/** Runs one command in bash, combining its output, and never throws. A command that runs too long is stopped. */
function shell(command, timeoutS = COMMAND_TIMEOUT_S) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("bash", ["-c", command], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let cut = false;
    const take = (chunk) => {
      if (output.length >= OUTPUT_CAP) {
        cut = true;
        return;
      }
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, timeoutS * 1000);
    const finish = (exitCode) => {
      clearTimeout(timer);
      resolve({ command, output: cut ? output.slice(0, OUTPUT_CAP) : output, exitCode, timedOut, seconds: (Date.now() - started) / 1000 });
    };
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(timedOut ? 124 : (code ?? 1)));
  });
}

/** Adds a finished command to an output's log and saves, so a stopped run still shows what it did. */
function logStep(result, caption, ran, ok) {
  result.steps.push({ caption, command: ran.command, output: ran.output, ok, exitCode: ran.exitCode, seconds: ran.seconds });
  save();
}

function start(id) {
  const result = { ok: false, steps: [], facts: {} };
  results.outputs[id] = result;
  return result;
}

/** Stands in for a download when the site can't serve the file here (a test run against a site without these routes). */
async function getFile(result, caption, url, file) {
  if (!url) {
    const ran = await shell(`ls -l ${q(file)}`);
    result.facts.downloaded = false;
    logStep(result, "Find the file, put here directly", ran, ran.exitCode === 0);
    return ran.exitCode === 0;
  }
  const ran = await shell(`curl -fsSL --max-time 30 ${q(url)} -o ${q(file)} && ls -l ${q(file)}`);
  result.facts.downloaded = ran.exitCode === 0;
  logStep(result, caption, ran, ran.exitCode === 0);
  return ran.exitCode === 0;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The address and body come first: a video shows only the start of a long command, and these say what the call is.
const mcpCommand = (body, maxTime = 30) =>
  `curl -sS -X POST ${q(spec.mcpUrl)} -d ${q(JSON.stringify(body))} -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --max-time ${maxTime}`;

async function proveMcp() {
  const result = start("mcp");
  result.facts = { listed: [], missing: [], called: [], notCalled: spec.notCalled };
  const hello = await shell(
    mcpCommand({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "muse-muse-prove-it", version: "1.0.0" } },
    }),
  );
  const server = parseJson(hello.output)?.result?.serverInfo;
  logStep(result, "Connect to the MCP server", hello, Boolean(server));
  if (!server) {
    result.facts.error = "The MCP server didn't answer initialize.";
    return;
  }

  const list = await shell(mcpCommand({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  const tools = parseJson(list.output)?.result?.tools;
  const listed = Array.isArray(tools) ? tools : [];
  result.facts.listed = listed.map((t) => t.name);
  result.facts.missing = spec.actionNames.filter((name) => !result.facts.listed.includes(name));
  const schemasOk = listed.every((t) => t.inputSchema?.type === "object");
  const listedOk = Array.isArray(tools) && result.facts.missing.length === 0 && schemasOk;
  logStep(result, `List its tools: ${listed.length} found`, list, listedOk);
  if (!listedOk) {
    result.facts.error = result.facts.missing.length ? `tools/list left out ${result.facts.missing.join(", ")}.` : "tools/list didn't give a usable list.";
    return;
  }

  let id = 3;
  for (const call of spec.calls) {
    const ran = await shell(mcpCommand({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: call.name, arguments: call.args } }, 130), 140);
    const body = parseJson(ran.output);
    const toolResult = body?.result;
    const ok = Boolean(toolResult) && toolResult.isError !== true && Array.isArray(toolResult.content) && toolResult.content.length > 0;
    const error = ok ? undefined : String(toolResult?.content?.[0]?.text ?? body?.error?.message ?? ran.output).slice(0, 400);
    result.facts.called.push({ name: call.name, ok, ...(error ? { error } : {}) });
    logStep(result, `Call ${call.name}`, ran, ok);
  }
  const called = result.facts.called;
  result.ok = called.length === 0 || called.some((c) => c.ok);
  if (!result.ok) result.facts.error = `Every tool call failed. ${called[0]?.error ?? ""}`.trim();
}

async function proveCli() {
  const result = start("cli");
  result.facts = { actionsInHelp: [], called: null, jsonOk: false };
  const file = `${spec.slug}.cjs`;
  if (!(await getFile(result, "Download the CLI", spec.downloads?.cli, file))) {
    result.facts.error = "The CLI didn't download.";
    return;
  }
  const help = await shell(`node ${q(file)} --help`);
  const inHelp = spec.actionNames.filter((name) => help.output.includes(name));
  result.facts.actionsInHelp = inHelp;
  const helpOk = help.exitCode === 0 && inHelp.length === spec.actionNames.length;
  logStep(result, "Ask it for help", help, helpOk);
  if (!helpOk) {
    result.facts.error = help.exitCode === 0 ? "--help left out some actions." : `--help exited with ${help.exitCode}.`;
    return;
  }
  const listed = await shell(`node ${q(file)} --help --json`);
  const parsed = parseJson(listed.output);
  const listOk = listed.exitCode === 0 && Array.isArray(parsed?.actions) && parsed.actions.length === spec.actionNames.length;
  logStep(result, "List its actions as JSON", listed, listOk);
  if (!listOk) {
    result.facts.error = "--help --json didn't print the actions as JSON.";
    return;
  }
  if (!spec.cliCall) {
    result.ok = true;
    return;
  }
  const ran = await shell(`node ${q(file)} ${q(spec.cliCall.name)} --input ${q(JSON.stringify(spec.cliCall.args))} --json --timeout 120`, 130);
  const reply = parseJson(ran.output);
  const ok = ran.exitCode === 0 && reply !== null && reply?.error === undefined;
  result.facts.called = spec.cliCall.name;
  result.facts.jsonOk = ok;
  logStep(result, `Run ${spec.cliCall.name} and print JSON`, ran, ok);
  if (!ok) result.facts.error = `${spec.cliCall.name} ended with exit code ${ran.exitCode}. ${String(reply?.error?.message ?? ran.output).slice(0, 300)}`.trim();
  result.ok = ok;
}

async function provePlugin() {
  const result = start("claude_plugin");
  const file = `${spec.slug}-claude-plugin.zip`;
  if (!(await getFile(result, "Download the plugin", spec.downloads?.claudePlugin, file))) {
    result.facts.error = "The plugin didn't download.";
    return;
  }
  const ran = await shell(`node prove-check-plugin.mjs ${q(file)} ${q(spec.pluginName)} ${q(spec.mcpUrl)}`);
  logStep(result, "Check its manifest and MCP address", ran, ran.exitCode === 0);
  result.ok = ran.exitCode === 0;
  if (!result.ok) result.facts.error = ran.output.trim().split("\n").filter((l) => l.startsWith("FAILED")).join(" ").slice(0, 400) || "The check failed.";
}

async function proveSkillFile() {
  const result = start("skill");
  result.facts = { problems: [] };
  if (!(await getFile(result, "Download the skill file", spec.downloads?.skill, "SKILL.md"))) {
    result.facts.error = "The skill file didn't download.";
    return;
  }
  const ran = await shell("head -n 4 SKILL.md | cut -c1-200");
  let text = "";
  try {
    text = readFileSync(path.join(dir, "SKILL.md"), "utf8");
  } catch {
    // Reported below.
  }
  const problems = [];
  if (!text.startsWith("---\n")) problems.push("it has no front matter");
  if (!new RegExp(`^name: ${spec.pluginName}$`, "m").test(text)) problems.push("its name is wrong");
  if (!/^description: "/m.test(text)) problems.push("it has no description");
  for (const name of spec.actionNames) if (!text.includes(`/api/actions/${name}`)) problems.push(`it leaves out ${name}`);
  result.facts.problems = problems;
  logStep(result, "Read the skill file", ran, problems.length === 0);
  result.ok = problems.length === 0;
  if (!result.ok) result.facts.error = `The skill file is wrong: ${problems.join(", ")}.`;
}

save();
for (const prove of [proveMcp, proveCli, provePlugin, proveSkillFile]) {
  try {
    await prove();
  } catch (err) {
    console.error(`${prove.name}: ${err}`);
  }
  save();
}
results.finishedAt = new Date().toISOString();
save();
