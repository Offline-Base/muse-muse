/**
 * Unit tests for lib/sandbox/muse.ts. The runner prelude runs in real bash (shell.ts writeRunner) against a stand-in
 * `muse` that, like the real one, exits 2 on a flag its `muse exec --help` doesn't list.
 *   npx tsx --test lib/sandbox/__tests__/muse.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  backgroundModelSetting,
  execFlags,
  flagsMissingFromHelp,
  helpLists,
  isSessionId,
  museExecArgs,
  newSessionId,
  OPTIONAL_EXEC_FLAGS,
  optionalConfigPrelude,
  optionalFlagsPrelude,
  SERVE_SETTINGS,
} from "@/lib/sandbox/muse";
import { q, writeRunner } from "@/lib/sandbox/shell";

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";

const tmp = mkdtempSync(path.join(tmpdir(), "musemuse-muse-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = (name: string) => {
  const dir = path.join(tmp, `${name}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** `muse exec --help` in the shape of a clap CLI. 1.4.13 (spike 1) is taken to lack the two hardening flags. */
function execHelp(version: "1.4.13" | "1.4.14"): string {
  const hardening =
    version === "1.4.14"
      ? ["      --disable-request-user-input  Never offer the ask-the-user tool", "      --no-foreign-personal-context Skip ~/.claude and ~/.codex"]
      : [];
  return [
    "Run one turn without the TUI",
    "",
    "Usage: muse exec [OPTIONS] [PROMPT]",
    "",
    "Options:",
    "      --json                        Print events as JSON lines",
    "      --yolo                        Skip approvals and the sandbox",
    "      --session-id <UUID>           Start or resume this session",
    "      --prompt-file <PATH>          Read the prompt from a file",
    "  -m, --model <MODEL>               Model id",
    "      --reasoning-effort <EFFORT>   minimal, low, medium, high, xhigh, max or ultra",
    "      --max-model-steps <N>         Stop after N model steps",
    "      --disable-web-tools           Turn the web tools off",
    ...hardening,
    "      --image <PATH>                Attach an image (repeatable)",
    "  -h, --help                        Print help",
    "",
  ].join("\n");
}

describe("museExecArgs", () => {
  it("fills in the defaults and turns web tools off", () => {
    assert.deepEqual(museExecArgs({ promptFile: "brief.md", sessionId: SESSION }), [
      "exec",
      "--json",
      "--yolo",
      "--session-id",
      SESSION,
      "--prompt-file",
      "brief.md",
      "--model",
      "muse-wonder-1.0",
      "--reasoning-effort",
      "high",
      "--max-model-steps",
      "200",
      "--disable-web-tools",
    ]);
  });

  it("uses what the caller chose, and keeps web tools on only when asked", () => {
    const args = museExecArgs({
      promptFile: "fix.md",
      sessionId: SESSION,
      model: "muse-wonder-1.0",
      reasoningEffort: "xhigh",
      maxModelSteps: 80,
      disableWebTools: false,
    });
    assert.deepEqual(args.slice(5), ["--prompt-file", "fix.md", "--model", "muse-wonder-1.0", "--reasoning-effort", "xhigh", "--max-model-steps", "80"]);
    assert.ok(!args.includes("--disable-web-tools"));
  });

  it("passes every flag once, never the ones the spike rejected, and leaves the optional ones to the runner", () => {
    const args = museExecArgs({ promptFile: "brief.md", sessionId: SESSION });
    const flags = args.filter((a) => a.startsWith("--"));
    assert.equal(new Set(flags).size, flags.length, "a repeated --model or --reasoning-effort is a usage error (exit 2)");
    // --no-session-log refuses --session-id, and --user-input-auto-resolve adds the ask-the-user tool back.
    for (const bad of ["--no-session-log", "--user-input-auto-resolve", "--provider"]) assert.ok(!args.includes(bad), bad);
    for (const optional of OPTIONAL_EXEC_FLAGS) assert.ok(!args.includes(optional), optional);
  });
});

describe("the session bridge's settings", () => {
  it("turn web search off, as exec's --disable-web-tools does, in the key=JSON form muse serve -c takes", () => {
    assert.deepEqual(SERVE_SETTINGS, ['tools.web_search.mode="off"']);
    for (const setting of SERVE_SETTINGS) {
      const [key, ...rest] = setting.split("=");
      assert.match(key!, /^[A-Za-z_][A-Za-z0-9_.]*$/);
      assert.doesNotThrow(() => JSON.parse(rest.join("=")), setting);
    }
  });
});

describe("the reminder agents' model", () => {
  it("is a settings catalog row that names the round's model as its own background model", () => {
    const setting = backgroundModelSetting("muse-wonder-1.0");
    assert.ok(setting.startsWith("model_catalog=["), setting);
    assert.deepEqual(JSON.parse(setting.slice("model_catalog=".length)), [
      { model_id: "muse-wonder-1.0", provider_id: "meta", profile_id: "tbh", background_agent_model: "muse-wonder-1.0" },
    ]);
    assert.ok(!setting.includes("muse-spark-1.3"));
  });
});

describe("a new session id", () => {
  it("is a UUIDv7 with the time first, as session/start on muse serve requires, and passes isSessionId", () => {
    const at = Date.UTC(2026, 9, 31, 7, 3, 4);
    const id = newSessionId(at);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(isSessionId(id));
    assert.equal(parseInt(id.replace(/-/g, "").slice(0, 12), 16), at);
  });

  it("differs every time", () => {
    assert.notEqual(newSessionId(1000), newSessionId(1000));
  });
});

describe("muse exec --help", () => {
  it("lists a flag only as a whole word", () => {
    const help = execHelp("1.4.13");
    assert.equal(helpLists(help, "--image"), true);
    assert.equal(helpLists(help, "--model"), true);
    assert.equal(helpLists("--json\n", "--json"), true);
    assert.equal(helpLists("      --image-dir <DIR>", "--image"), false);
    assert.equal(helpLists("      --no-image", "--image"), false);
    assert.equal(helpLists("      --disable-request-user-input-later", "--disable-request-user-input"), false);
    assert.equal(helpLists("      --max-model-steps=<N>", "--max-model-steps"), true);
  });

  it("covers every flag a build passes, so the snapshot fails on a Muse Code without one", () => {
    assert.deepEqual(execFlags(), [
      "--json",
      "--yolo",
      "--session-id",
      "--prompt-file",
      "--model",
      "--reasoning-effort",
      "--max-model-steps",
      "--disable-web-tools",
      "--disable-request-user-input",
      "--no-foreign-personal-context",
      "--image",
    ]);
    assert.deepEqual(flagsMissingFromHelp(execHelp("1.4.14")), []);
    assert.deepEqual(flagsMissingFromHelp(execHelp("1.4.13")), [...OPTIONAL_EXEC_FLAGS]);
    assert.deepEqual(flagsMissingFromHelp("error: unknown command exec"), execFlags());
  });
});

describe("the runner's optional flags", () => {
  /** Writes the real runner through a stand-in sandbox, with a stand-in muse in $HOME/.local/bin, and runs it. */
  async function runMuse(version: "1.4.13" | "1.4.14") {
    const home = freshDir("home");
    const bin = path.join(home, ".local/bin");
    mkdirSync(bin, { recursive: true });
    const helpFile = path.join(home, "help.txt");
    writeFileSync(helpFile, execHelp(version));
    writeFileSync(
      path.join(bin, "muse"),
      [
        "#!/bin/bash",
        `help=${JSON.stringify(helpFile)}`,
        `if [ "$1 $2" = "exec --help" ]; then cat "$help"; exit 0; fi`,
        `for a in "$@"; do case "$a" in --*) grep -Eq -- "(^|[^A-Za-z0-9_-])$a([^A-Za-z0-9_-]|$)" "$help" || { echo "error: unexpected argument '$a'" >&2; exit 2; } ;; esac; done`,
        `printf '%s\\n' "$@"`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const sysBin = freshDir("bin");
    writeFileSync(path.join(sysBin, "setsid"), '#!/bin/bash\nexec "$@"\n', { mode: 0o755 });
    const product = freshDir("product");
    writeFileSync(path.join(product, "shot.png"), "png");

    let script = "";
    const fake = { writeFiles: async (files: Array<{ content: string | Buffer }>) => void (script = String(files[0].content)) };
    const logs = freshDir("logs");
    const log = path.join(logs, "muse.jsonl");
    await writeRunner(fake as unknown as Parameters<typeof writeRunner>[0], {
      name: "muse-r0",
      cwd: product,
      argv: ["muse", ...museExecArgs({ promptFile: "brief.md", sessionId: SESSION })],
      prelude: [optionalFlagsPrelude(), `[ -f 'shot.png' ] && cmd+=(--image 'shot.png')`, "true"].join("\n"),
      stdoutPath: log,
      stderrPath: path.join(logs, "muse.err"),
    });
    const runner = path.join(logs, "muse-r0.sh");
    writeFileSync(runner, script, { mode: 0o755 });
    const res = spawnSync("bash", [runner], { env: { ...process.env, HOME: home, PATH: `${sysBin}:${process.env.PATH}` }, encoding: "utf8" });
    return {
      code: res.status,
      stdout: res.stdout,
      argv: readFileSync(log, "utf8").trim().split("\n"),
      stderr: readFileSync(path.join(logs, "muse.err"), "utf8"),
    };
  }

  it("adds them when this Muse Code lists them", async () => {
    const run = await runMuse("1.4.14");
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.argv.slice(-5), ["--disable-web-tools", "--disable-request-user-input", "--no-foreign-personal-context", "--image", "shot.png"]);
    assert.equal(run.stdout, "");
  });

  it("leaves them out on an older Muse Code instead of failing the run with exit 2", async () => {
    const run = await runMuse("1.4.13");
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.argv.slice(-3), ["--disable-web-tools", "--image", "shot.png"]);
    assert.match(run.stdout, /muse exec has no --disable-request-user-input, so this run goes without it/);
    assert.match(run.stdout, /muse exec has no --no-foreign-personal-context, so this run goes without it/);
  });

  it("is valid bash", () => {
    const res = spawnSync("bash", ["-n", "-c", `cmd=(muse exec)\n${optionalFlagsPrelude()}`], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
  });
});

describe("the runner's --config settings", () => {
  const SETTINGS = ["agents.execution_capacity=6", `runtime_capabilities={"plugin:tbh-reminders:reminder:todo-reminder":{"enabled":true}}`, "x='quoted'"];

  /** Runs the prelude in bash against a stand-in `muse` function, and returns the command it built and what it said. */
  function prelude(opts: { version: string; config: boolean }) {
    const help = opts.config ? "  -c, --config <KEY=VALUE>  Set one setting for this run" : "      --json  Print events";
    const script = [
      `muse() { if [ "$1" = --version ]; then echo ${q(`Muse Code ${opts.version} (${opts.version}-R7309.1)`)}; elif [ "$1 $2" = "exec --help" ]; then echo ${q(help)}; fi; }`,
      "cmd=(muse exec --json)",
      optionalConfigPrelude(SETTINGS, "1.4.14"),
      `printf '%s\\n' "\${cmd[@]}"`,
    ].join("\n");
    const res = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim().split("\n");
  }

  it("passes each setting, quoted as it is, to the Muse Code it was checked on", () => {
    assert.deepEqual(prelude({ version: "1.4.14", config: true }), ["muse", "exec", "--json", ...SETTINGS.flatMap((s) => ["--config", s])]);
  });

  it("leaves them out on another Muse Code or one without --config, instead of failing the run with exit 2", () => {
    for (const opts of [
      { version: "1.4.13", config: true },
      { version: "1.4.140", config: true },
      { version: "1.4.14", config: false },
    ]) {
      const out = prelude(opts);
      assert.equal(out[out.length - 1], "--json", JSON.stringify(opts));
      assert.equal(out[0], "muse exec isn't Muse Code 1.4.14 with --config, so this run goes without the platform's settings");
    }
  });

  it("does nothing without settings", () => {
    assert.equal(optionalConfigPrelude([], "1.4.14"), "true");
  });
});
