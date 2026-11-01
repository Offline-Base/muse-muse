/**
 * Modal and Baseten deploy with their own command line tools, which can't run in a server function. So a short-lived
 * Vercel Sandbox runs them and goes away. Keys reach it only as that one command's environment, every value is blanked out
 * of anything that comes back, and it can reach only the hosts listed.
 */
import { Sandbox } from "@vercel/sandbox";
import { q, sh } from "@/lib/sandbox/shell";

export interface CliRunner {
  /** Runs a bash script with these files and this environment. Throws with scrubbed text when it fails. */
  run(input: { script: string; files: Record<string, string>; env: Record<string, string>; hosts: string[]; timeoutMs: number }): Promise<string>;
}

/** Each secret value blanked out. Short values aren't secrets, and would blank out unrelated text. */
export function scrubSecrets(text: string, env: Record<string, string>): string {
  let out = text;
  for (const value of Object.values(env)) if (value.length >= 8) out = out.split(value).join("[hidden]");
  return out;
}

export const sandboxRunner: CliRunner = {
  async run({ script, files, env, hosts, timeoutMs }) {
    const sandbox = await Sandbox.create({
      runtime: "python3.13",
      timeout: timeoutMs + 60_000,
      networkPolicy: { allow: Object.fromEntries(hosts.map((h) => [h, []])) },
      tags: { app: "musemuse", role: "host-tuned" },
    } as Parameters<typeof Sandbox.create>[0]);
    try {
      const dir = "/tmp/host";
      await sandbox.writeFiles(Object.entries(files).map(([path, content]) => ({ path: `${dir}/${path}`, content: Buffer.from(content) })));
      const got = await sh(sandbox, `cd ${q(dir)} && ${script}`, { env, timeoutMs, allowFail: true });
      const output = scrubSecrets(`${got.stdout}\n${got.stderr}`, env);
      if (got.exitCode !== 0) throw new Error(`The deploy tool stopped with exit ${got.exitCode}: ${output.slice(-600)}`);
      return output;
    } finally {
      await sandbox.stop().catch(() => undefined);
    }
  },
};
