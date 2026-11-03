import { randomBytes } from "node:crypto";
import { q } from "@/lib/sandbox/shell";
import { defaultModel } from "@/lib/meta/spark";

/**
 * Arguments for running Muse Code headless inside a builder sandbox. Flags confirmed in docs/SPIKES.md (spike 1) and
 * against Muse Code 1.4.14 on Oct 27 (spike 2).
 */
export type BuildModel = "muse-wonder-1.0" | "muse-spark-1.3-contributor";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface MuseExecOptions {
  /** Path relative to the product dir, such as brief.md or fix.md. */
  promptFile: string;
  /** A UUID. A fresh one starts a session; passing the same one again resumes it with its memory. */
  sessionId: string;
  model?: BuildModel;
  reasoningEffort?: ReasoningEffort;
  maxModelSteps?: number;
  /** Muse Code's web tools can't reach anything through the build firewall, so they are off by default. */
  disableWebTools?: boolean;
}

export const DEFAULT_MAX_MODEL_STEPS = 200;
/** A build's reasoning effort on both engines. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";

/**
 * A round's effort: high for a build's or a change's first round, medium for the fix rounds after it (round numbers
 * that aren't a multiple of REFINE_ROUND_STRIDE), which fix what the checks named and don't need to plan again.
 */
export function effortForRound(round: number): ReasoningEffort {
  return round % REFINE_ROUND_STRIDE === 0 ? DEFAULT_REASONING_EFFORT : "medium";
}

/** What a run uses when the caller doesn't choose. Muse Wonder is the build default (lib/env.ts). */
const EXEC_DEFAULTS = { reasoningEffort: DEFAULT_REASONING_EFFORT, maxModelSteps: DEFAULT_MAX_MODEL_STEPS } as const;

/**
 * Hardening flags the runner adds only when `muse exec --help` lists them (optionalFlagsPrelude). A headless run has
 * nobody to answer, so it never gets the ask-the-user tool (exec leaves it out today; this keeps it out), and it never
 * loads ~/.claude or ~/.codex rules and skills into the build's context. Checked on Muse Code 1.4.14 only: a product
 * sandbox or snapshot on an older Muse Code (spike 1 ran 1.4.13) would exit 2 on a flag it doesn't know.
 */
export const OPTIONAL_EXEC_FLAGS = ["--disable-request-user-input", "--no-foreign-personal-context"] as const;

/** Flags the runner adds on its own: --image for each attached file that exists (builder.ts startMuse). */
const RUNNER_EXEC_FLAGS = ["--image"] as const;

/**
 * `-c` settings every session bridge round passes to `muse serve` (lib/sandbox/bridge/bridge.mjs), whatever MUSE_FULL
 * says. `muse serve --help` on 1.4.14 has no --disable-web-tools (docs/spikes/muse-full-2026-10-30/phase-A.txt), so
 * web search is turned off with its setting instead, as exec rounds turn web tools off with the flag. On a real 1.4.14
 * host it takes web_search and web_fetch out of the tool list (docs/spikes/serve-2026-10-31). A key or value Muse Code
 * doesn't know refuses the start (exit 2), and the round then runs on exec, with the reason in the build room. Exec's --no-foreign-personal-context has no setting here until the type its context.foreign_personal_* keys
 * take is known.
 */
export const SERVE_SETTINGS: readonly string[] = ['tools.web_search.mode="off"'];

/**
 * `-c` setting for every round, on both engines: the model's reminder agents run on that model. Meta's catalog
 * (GET /muse-code/models) gives muse-wonder-1.0 `background_agent_model: "muse-spark-1.3"`, which this platform never
 * uses, and a settings catalog row with the same model, provider and profile overrides just that field (Oct 31,
 * docs/spikes/serve-2026-10-31). It also keeps parseSessionUsage's prices right, which charge reminders at the round's
 * model. The value must be the model itself: `muse serve` turns a contributor id here back into muse-spark-1.3.
 */
export function backgroundModelSetting(model: BuildModel): string {
  return `model_catalog=${JSON.stringify([{ model_id: model, provider_id: "meta", profile_id: "tbh", background_agent_model: model }])}`;
}

/**
 * argv for `muse exec`, after the binary name. --yolo skips Muse Code's own bubblewrap sandbox, which can't run in the
 * microVM: the disposable, firewalled VM is the boundary. Inspo images and OPTIONAL_EXEC_FLAGS are added by the
 * runner script (builder.ts startMuse), which checks first that the file exists and that this Muse Code has the flag.
 */
export function museExecArgs(opts: MuseExecOptions): string[] {
  const valued: Record<string, string> = {
    "--session-id": opts.sessionId,
    "--prompt-file": opts.promptFile,
    "--model": opts.model ?? defaultModel(),
    "--reasoning-effort": opts.reasoningEffort ?? EXEC_DEFAULTS.reasoningEffort,
    "--max-model-steps": `${opts.maxModelSteps ?? EXEC_DEFAULTS.maxModelSteps}`,
  };
  const webTools = opts.disableWebTools === false ? [] : ["--disable-web-tools"];
  return ["exec", "--json", "--yolo", ...Object.entries(valued).flat(), ...webTools];
}

/**
 * ERE for `flag` as a whole word in `muse exec --help`: not part of a longer flag such as `--image-dir`. The runner's
 * grep and helpLists use the same one.
 */
function helpPattern(flag: string): string {
  return `(^|[^A-Za-z0-9_-])${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_-]|$)`;
}

/** True when `muse exec --help` output lists `flag`. */
export function helpLists(help: string, flag: string): boolean {
  return new RegExp(helpPattern(flag), "m").test(help);
}

/**
 * Bash for the runner prelude, after `cmd=(muse exec ...)`: appends each of `flags` only when `muse exec --help`
 * lists it, so a sandbox on an older Muse Code runs without the flag instead of failing every build with exit 2.
 * Says on the runner's stdout which ones it left out.
 */
export function optionalFlagsPrelude(flags: readonly string[] = OPTIONAL_EXEC_FLAGS): string {
  return [
    `help=$("\${cmd[0]}" exec --help 2>&1)`,
    ...flags.map(
      (flag) =>
        `if grep -Eq -- ${q(helpPattern(flag))} <<<"$help"; then cmd+=(${q(flag)}); else echo ${q(`muse exec has no ${flag}, so this run goes without it`)}; fi`,
    ),
  ].join("\n");
}

/**
 * Bash for the runner prelude, after optionalFlagsPrelude: appends `--config KEY=VALUE` for each of `settings`, each
 * value quoted with q(), but only when `muse exec --help` lists --config and `muse --version` is `version`. An unknown
 * key refuses the whole run with exit 2 (docs/MUSE_CODE_FULL.md), so a sandbox on any other Muse Code runs without the
 * settings instead. Says on the runner's stdout when it leaves them out.
 */
export function optionalConfigPrelude(settings: readonly string[], version: string): string {
  if (!settings.length) return "true";
  const versionPattern = `(^|[^0-9.])${version.replace(/\./g, "\\.")}([^0-9]|$)`;
  const words = settings.flatMap((s) => ["--config", s]).map(q).join(" ");
  return [
    `[ -n "\${help:-}" ] || help=$("\${cmd[0]}" exec --help 2>&1)`,
    `if grep -Eq -- ${q(helpPattern("--config"))} <<<"$help" && "\${cmd[0]}" --version 2>/dev/null | grep -Eq -- ${q(versionPattern)}; then cmd+=(${words}); else echo ${q(`muse exec isn't Muse Code ${version} with --config, so this run goes without the platform's settings`)}; fi`,
  ].join("\n");
}

/**
 * Every flag a build may pass to `muse exec`: museExecArgs (web tools on or off), OPTIONAL_EXEC_FLAGS and --image.
 * The snapshot script fails unless `muse exec --help` lists each one.
 */
export function execFlags(): string[] {
  const args = museExecArgs({ promptFile: "brief.md", sessionId: "00000000-0000-4000-8000-000000000000" });
  return [...new Set([...args.filter((a) => a.startsWith("--")), ...OPTIONAL_EXEC_FLAGS, ...RUNNER_EXEC_FLAGS])];
}

/** The execFlags() (or `flags`) that `muse exec --help` output doesn't list, in order. */
export function flagsMissingFromHelp(help: string, flags: readonly string[] = execFlags()): string[] {
  return flags.filter((flag) => !helpLists(help, flag));
}

/** Env for any muse command in the sandbox (docs/SPIKES.md). Stops the launcher from self-updating or starting a device sign-in. */
export const SANDBOX_ENV = { MUSE_NO_AUTO_UPDATE: "1", MUSE_LOGIN: "0" } as const;

/**
 * Env for a Muse Code run. META_API_KEY is the sandbox's placeholder (policy.ts placeholderKey): the firewall swaps in
 * the real Authorization header only for requests that carry it. Only the Muse Code runner exports it, so the
 * product's dev, verify and demo servers don't have it.
 */
export function museEnv(placeholder: string): Record<string, string> {
  return { ...SANDBOX_ENV, META_API_KEY: placeholder };
}

/**
 * Muse Code log rounds per change of a product: a first build starts at 0 and refinement n at n times this, with their
 * fix rounds between, so they never reuse an earlier build's log name.
 */
export const REFINE_ROUND_STRIDE = 10;

/** Muse Code exit codes. 0 means the turn ended, not that the product works. Always gate on npm run verify. */
export const MUSE_EXIT = { completed: 0, failed: 1, usage: 2 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(id: string): boolean {
  return UUID.test(id);
}

/**
 * A new build's Muse Code session id, a UUIDv7. `muse serve` refuses any other version on session/start ("expected
 * UUIDv7", Oct 31), while `muse exec --session-id` takes any UUID and each engine resumes the other's sessions, so one
 * kind of id serves both. A product made before this has a v4 id: a session that exists resumes whatever its id.
 */
export function newSessionId(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
