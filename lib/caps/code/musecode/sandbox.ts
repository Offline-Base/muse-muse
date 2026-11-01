import { randomBytes } from "node:crypto";
import { BRIDGE_DIR, BRIDGE_SCRIPT, MUSE_SDK_VERSION, type BridgeConfig, type MuseCommand, type MuseCommandEnvelope } from "@/lib/sandbox/bridge-protocol";
import { MUSE_CODE_LIMITS } from "@/lib/caps/code/musecode/limits";
import { LEFT_OUT_DIRS } from "@/lib/caps/code/musecode/result";
import { remindersOffSetting } from "@/lib/sandbox/muse-config";
import { backgroundModelSetting, SANDBOX_ENV, SERVE_SETTINGS, type ReasoningEffort } from "@/lib/sandbox/muse";
import { q } from "@/lib/sandbox/shell";

/**
 * What a Muse Code session's sandbox runs (docs/CAPABILITIES.md, 15b), with the spike's measured settings
 * (docs/spikes/musecode-2026-10-31/README.md on tg-musecode, "The exact way to set it"). Pure: the handler writes these
 * files and runs these scripts, and the tests read them.
 *
 * The sandbox starts from the builder snapshot (Muse Code 1.4.14, Node, the bridge's runtime) with no product code and
 * no secrets. Its only secret is its own session token, in the bridge's environment as META_API_KEY.
 */

/** Where a session's files live in its sandbox. The workspace is empty but for the files the task brought. */
export const SESSION_DIR = "/vercel/musemuse/session";
export const SESSION_WORKSPACE = "/vercel/sandbox/workspace";
export const SESSION_PATHS = {
  config: `${SESSION_DIR}/bridge-config.json`,
  prompt: `${SESSION_DIR}/task.md`,
  log: `${SESSION_DIR}/session.msp.jsonl`,
  err: `${SESSION_DIR}/bridge.err`,
  mailbox: `${SESSION_DIR}/mailbox`,
  runner: `${SESSION_DIR}/run.sh`,
  tar: `${SESSION_DIR}/result.tar`,
  pid: `${SESSION_DIR}/bridge.pid`,
} as const;

/** How long the bridge stays open with nothing running: after an interrupt, time for a steer to start the next turn. */
export const SESSION_IDLE_EXIT_MS = 60_000;

/** Models a session may run on (the code_session scope's rule, lib/gateway/policy.ts). */
export type SessionModel = "muse-wonder-1.0" | "muse-spark-1.3-contributor";

/** Effort: low for a build's own tests (cheap and quick, as the spike ran), medium for a person's task. */
export function sessionEffort(build: boolean): ReasoningEffort {
  return build ? "low" : "medium";
}

/**
 * The `muse serve -c` settings, each one measured in the spike:
 *   - endpoint_transport with auth "bearer" pinned: without the pin a public host gets no Authorization header, and
 *     auth "none" turns Contributor into muse-spark-1.3 on the wire. Never "none".
 *   - telemetry off: otherwise it posts to api.meta.ai with the session token, past the endpoint.
 *   - web search off, every reminder off (cost, and calls then match the main agent's steps).
 *   - a 200,000-token context, so compaction runs before a body reaches the gateway's 4.5 MB limit.
 *   - on Wonder, the catalog row that keeps background work on Wonder (the live catalog says muse-spark-1.3).
 */
export function sessionSettings(model: SessionModel, gatewayV1: string): string[] {
  return [
    `endpoint_transport=${JSON.stringify({ base_url: gatewayV1, auth: "bearer" })}`,
    "telemetry.enabled=false",
    ...SERVE_SETTINGS,
    remindersOffSetting(),
    "context_compaction.provider_context_limit_tokens=200000",
    ...(model === "muse-wonder-1.0" ? [backgroundModelSetting(model)] : []),
  ];
}

/** The bridge's config for one session. Same bridge as a build's rounds (lib/sandbox/bridge/bridge.mjs). */
export function sessionBridgeConfig(input: { sessionId: string; model: SessionModel; effort: ReasoningEffort; gatewayV1: string }): BridgeConfig {
  return {
    workspace: SESSION_WORKSPACE,
    sessionId: input.sessionId,
    model: input.model,
    reasoningEffort: input.effort,
    promptFile: SESSION_PATHS.prompt,
    images: [],
    goal: null,
    settings: sessionSettings(input.model, input.gatewayV1),
    disableRequestUserInput: true,
    logPath: SESSION_PATHS.log,
    mailboxDir: SESSION_PATHS.mailbox,
    maxModelSteps: MUSE_CODE_LIMITS.maxModelSteps,
    idleExitMs: SESSION_IDLE_EXIT_MS,
  };
}

/** The first turn: a few platform lines, then the person's task as they wrote it. */
export function sessionPrompt(task: string, fileNames: readonly string[]): string {
  return [
    "You are working in a private, temporary workspace with no product code in it. It is deleted after this session.",
    fileNames.length ? `The workspace has these files from the person: ${fileNames.join(", ")}.` : "The workspace starts empty.",
    "Make what the task asks for as files in this workspace. You can't reach the web. npm packages can be downloaded.",
    "When you finish, say in a few plain sentences what you made and name the files. If you couldn't do it, say why.",
    "",
    "The task:",
    "",
    task.trim(),
    "",
  ].join("\n");
}

/** Where Muse Code's model catalog copy lives: deleted before each serve (the spike). */
const MODEL_CATALOG_CACHE = '"$HOME/.local/share/muse/model-catalog"';

/**
 * Run once, before the agent starts, as the platform's own command: makes the folders, deletes the catalog copy, prints
 * the sha256 of every file in Muse Code's program folder (the binary and its helpers, so a result can drop a copy of
 * them), and installs the bridge's SDK from npm (GET only through the firewall).
 */
export function prepareScript(): string {
  const sdk = `@muse-code/sdk@${MUSE_SDK_VERSION}`;
  const installed = `process.exit(require("./node_modules/@muse-code/sdk/package.json").version === ${JSON.stringify(MUSE_SDK_VERSION)} ? 0 : 1)`;
  return [
    "set -e",
    `mkdir -p ${q(SESSION_DIR)} ${q(SESSION_WORKSPACE)} ${q(SESSION_PATHS.mailbox)} ${q(BRIDGE_DIR)}`,
    `rm -rf ${MODEL_CATALOG_CACHE}`,
    'muse_bin=$(readlink -f "$(command -v muse 2>/dev/null || echo /nonexistent)" 2>/dev/null || true)',
    'for f in "$HOME"/.local/bin/* "$muse_bin"; do [ -f "$f" ] && sha256sum "$f" | cut -d" " -f1 | sed "s/^/binary-sha256 /"; done | sort -u',
    `cd ${q(BRIDGE_DIR)}`,
    `if node -e ${q(installed)} 2>/dev/null; then echo sdk-ready; exit 0; fi`,
    `[ -f package.json ] || printf '%s\\n' '{"name":"musemuse-bridge","private":true}' > package.json`,
    `npm install --no-audit --no-fund --loglevel=error --no-save ${q(sdk)} >/dev/null`,
    "echo sdk-ready",
  ].join("\n");
}

/** The sha256 values prepareScript printed. */
export function binaryHashesFrom(stdout: string): string[] {
  return [...new Set([...stdout.matchAll(/^binary-sha256 ([0-9a-f]{64})$/gm)].map((m) => m[1]!))];
}

/**
 * The runner: starts the bridge in its own process group, so a stop takes muse serve and every tool's child with it,
 * and records the exit code. The session token comes in this command's environment (startDetached), never a file.
 */
export function runnerScript(): string {
  const exitFile = q(`${SESSION_PATHS.err}.exit`);
  return `#!/bin/bash
# Written by the Muse Muse platform. Runs one Muse Code session's bridge.
export PATH="$HOME/.local/bin:$PATH"
${Object.entries(SANDBOX_ENV)
  .map(([k, v]) => `export ${k}=${q(v)}`)
  .join("\n")}
cd ${q(SESSION_WORKSPACE)} || exit 97
rm -f ${exitFile}
setsid node ${q(BRIDGE_SCRIPT)} ${q(SESSION_PATHS.config)} > ${q(SESSION_PATHS.err)} 2>&1 < /dev/null &
child=$!
echo "$child" > ${q(SESSION_PATHS.pid)}
stop_group() {
  kill -TERM -- "-$child" 2>/dev/null
  for _ in 1 2 3 4 5 6; do kill -0 "$child" 2>/dev/null || break; sleep 0.5; done
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
}

/**
 * Packs the workspace as a tar for the result: symlinks stay links (never followed), and the folders a result leaves out
 * stay out. The platform reads this tar and builds the zip itself (lib/caps/code/musecode/result.ts), so whatever is in
 * it, only files that pass the rules get out.
 */
export function packScript(): string {
  return [
    `rm -f ${q(SESSION_PATHS.tar)}`,
    `cd ${q(SESSION_WORKSPACE)} || exit 0`,
    `tar --format=gnu ${LEFT_OUT_DIRS.map((d) => `--exclude=${q(d)}`).join(" ")} -cf ${q(SESSION_PATHS.tar)} . 2>/dev/null || true`,
    `[ -f ${q(SESSION_PATHS.tar)} ] && echo packed`,
  ].join("\n");
}

/**
 * Stops the bridge's whole process group, if it is still running: muse serve and every tool's child with it. By its
 * pid, not by name: a `pkill -f` here would match this script's own command line and kill it first.
 */
export function killScript(): string {
  return [
    `pid=$(cat ${q(SESSION_PATHS.pid)} 2>/dev/null)`,
    'case "$pid" in ""|*[!0-9]*) exit 0;; esac',
    'kill -TERM -- "-$pid" 2>/dev/null',
    "for _ in 1 2 3 4; do kill -0 -- \"-$pid\" 2>/dev/null || exit 0; sleep 0.5; done",
    'kill -KILL -- "-$pid" 2>/dev/null',
    "exit 0",
  ].join("\n");
}

/** A mailbox command and its file name, `<at>-<id>.json`, read by the bridge in name order. */
export function mailboxFile(command: MuseCommand, now: Date, by: MuseCommandEnvelope["by"] = "owner"): { path: string; content: string } {
  const envelope: MuseCommandEnvelope = { id: randomBytes(9).toString("base64url"), at: now.toISOString(), by, command };
  return { path: `${SESSION_PATHS.mailbox}/${envelope.at}-${envelope.id}.json`, content: `${JSON.stringify(envelope)}\n` };
}
