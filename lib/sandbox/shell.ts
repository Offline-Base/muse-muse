import type { Sandbox } from "@vercel/sandbox";
import { RUN_DIR } from "@/lib/sandbox/paths";

/** Quotes one word for bash. */
export function q(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a bash script to completion. Throws with the output when it fails, unless `allowFail` is set. */
export async function sh(
  sandbox: Sandbox,
  script: string,
  opts: { cwd?: string; env?: Record<string, string>; sudo?: boolean; allowFail?: boolean; timeoutMs?: number } = {},
): Promise<ShellResult> {
  const cmd = await sandbox.runCommand({
    cmd: "bash",
    args: ["-c", script],
    cwd: opts.cwd,
    env: opts.env,
    sudo: opts.sudo,
    timeoutMs: opts.timeoutMs,
  });
  const [stdout, stderr] = await Promise.all([cmd.stdout(), cmd.stderr()]);
  if (cmd.exitCode !== 0 && !opts.allowFail) {
    const tail = (stderr || stdout).slice(-2000);
    throw new Error(`Sandbox command failed (exit ${cmd.exitCode}): ${script.slice(0, 160)}\n${tail}`);
  }
  return { exitCode: cmd.exitCode, stdout, stderr };
}

/** Reads up to `maxBytes` of a file starting at byte `offset`, as raw bytes (base64 over the wire, so nothing is mangled). */
export async function readBytes(sandbox: Sandbox, path: string, offset: number, maxBytes: number): Promise<Buffer> {
  const start = Math.max(0, Math.floor(offset)) + 1;
  const { stdout } = await sh(
    sandbox,
    `[ -f ${q(path)} ] || exit 0; tail -c +${start} ${q(path)} | head -c ${Math.floor(maxBytes)} | base64 -w0`,
  );
  return Buffer.from(stdout.trim(), "base64");
}

/** The last `maxBytes` of a file as text. Empty when the file is missing. */
export async function tailText(sandbox: Sandbox, path: string, maxBytes: number): Promise<string> {
  const { stdout } = await sh(sandbox, `[ -f ${q(path)} ] || exit 0; tail -c ${Math.floor(maxBytes)} ${q(path)} | base64 -w0`);
  return Buffer.from(stdout.trim(), "base64").toString("utf8");
}

export interface RunnerSpec {
  /** Names the script file in RUN_DIR, such as "muse-r0" or "verify". */
  name: string;
  cwd: string;
  /** Exported before the command runs. */
  env?: Record<string, string>;
  /** The program and its arguments. */
  argv: string[];
  /** Raw bash that runs before the command and may append words to the `cmd` array (for example optional flags). */
  prelude?: string;
  /** Where stdout goes. */
  stdoutPath: string;
  /** Where stderr goes. Omit to merge it into stdoutPath. */
  stderrPath?: string;
}

/**
 * Writes a runner script that starts the command in its own process group, forwards SIGTERM to that whole group
 * (so `npm run verify` takes its next server and browsers down with it), and records the exit code next to the
 * log as `<stdoutPath>.exit`. Returns the script path.
 */
export async function writeRunner(sandbox: Sandbox, spec: RunnerSpec): Promise<string> {
  const exports = Object.entries(spec.env ?? {})
    .map(([k, v]) => `export ${k}=${q(v)}`)
    .join("\n");
  const err = spec.stderrPath ? `2> ${q(spec.stderrPath)}` : "2>&1";
  const exitFile = q(`${spec.stdoutPath}.exit`);
  const script = `#!/bin/bash
# Written by the Muse Muse platform. Runs one long command detached from the API call that started it.
export PATH="$HOME/.local/bin:$PATH"
${exports}
cd ${q(spec.cwd)} || exit 97
rm -f ${exitFile}
cmd=(${spec.argv.map(q).join(" ")})
${spec.prelude ?? ""}
setsid "\${cmd[@]}" > ${q(spec.stdoutPath)} ${err} < /dev/null &
child=$!
stop_group() {
  kill -TERM -- "-$child" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$child" 2>/dev/null || break; sleep 0.5; done
  kill -KILL -- "-$child" 2>/dev/null
  echo 143 > ${exitFile}
  exit 143
}
trap stop_group TERM INT
wait "$child"
code=$?
echo "$code" > ${exitFile}
exit "$code"
`;
  const path = `${RUN_DIR}/${spec.name}.sh`;
  await sandbox.writeFiles([{ path, content: script, mode: 0o755 }]);
  return path;
}
