import { publicHost } from "@/lib/sandbox/policy";
import type { CheckPrompt } from "@/lib/train/general-checks";
import { recipeById } from "@/lib/train/recipes";
import { RUNNER_PY } from "@/lib/train/recipes/runner";
import type { Recipe, RecipeId } from "@/lib/train/types";

/** Where the job's files live on the instance. */
export const JOB_DIR = "/opt/muse";
/** The runner's output on the instance, for debugging over SSH. */
export const JOB_LOG = "/var/log/muse-job.log";
/** Lambda takes user data up to 1 MB. */
export const MAX_USER_DATA_BYTES = 1_000_000;

export interface UserDataInput {
  jobId: string;
  /** `${callbackOrigin(env.platformUrl)}/api/train/jobs/${jobId}`: https on a public host. */
  callbackBase: string;
  /** The plaintext job token. It goes only into job.json. */
  token: string;
  /** A recipe id, or the recipe itself. */
  recipe: RecipeId | Recipe;
  params: Record<string, string | number>;
  maxMinutes: number;
  /**
   * Unix seconds the runner must be done by (ctx.deadline). launchStep stamps it before the launch request from the
   * minutes the job's limits allow (usableMinutes: maxMinutes, or less when the dollar limit runs out first), so it is
   * never after the platform stops the job. Defaults to now plus maxMinutes.
   */
  deadlineEpoch?: number;
  /** Where the recipe's cache filesystem is mounted on the instance, for a recipe with usesCache. */
  cacheDir?: string;
  /**
   * A glimmer-serve job's serving key (lib/train/serve.ts serveKeyFor), which its demo server requires as "Authorization:
   * Bearer <serveKey>". Like the token it goes only into job.json, and only for that recipe.
   */
  serveKey?: string;
  /**
   * The general checks a glimmer-lora chat job answers beside its held-out prompts (launchChecks in
   * lib/train/general-checks.ts, TUNE_GENERAL_CHECKS). Left out of job.json when not given or empty.
   */
  checks?: CheckPrompt[];
}

/** The deadline a launch stamped `now` gives the runner: `minutes` later, rounded down to the second. */
export function deadlineEpochFor(minutes: number, now: number = Date.now()): number {
  return Math.floor(now / 1000) + Math.floor(minutes * 60);
}

/**
 * The platform URL a job's instance reports back to, without a trailing slash, or null when it can't: the URL must
 * be https on a public host (publicHost), since the instance sends its job token there in every callback. Jobs are
 * refused when this is null.
 */
export function callbackOrigin(platformUrl: string): string | null {
  if (!publicHost(platformUrl)) return null;
  return platformUrl.startsWith("https://") ? platformUrl.replace(/\/+$/, "") : null;
}

/** The shell line cloud-init runs: make sure python3 is there, then start the runner detached, logging to JOB_LOG. */
const START = [
  `mkdir -p ${JOB_DIR}/work`,
  `(command -v python3 >/dev/null 2>&1 || (apt-get update -y && apt-get install -y python3)) >> ${JOB_LOG} 2>&1`,
  `cd ${JOB_DIR} && nohup python3 -u ${JOB_DIR}/runner.py ${JOB_DIR}/job.json >> ${JOB_LOG} 2>&1 < /dev/null &`,
].join("; ");

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * The #cloud-config user data for a job's instance: job.json (0600, the only place the job token goes), runner.py and
 * the recipe's script as recipe.py, all base64 encoded, then a runcmd that starts the runner. job.json always has
 * deadlineEpoch, and cacheDir, serveKey and checks only when given. Nothing from the platform's env goes in. Throws for an
 * unknown recipe or a document over 1 MB.
 */
export function buildUserData(input: UserDataInput): string {
  const recipe = typeof input.recipe === "string" ? recipeById(input.recipe) : input.recipe;
  if (!recipe) throw new Error(`Unknown recipe: ${String(input.recipe)}`);
  const job = {
    jobId: input.jobId,
    callbackBase: input.callbackBase,
    token: input.token,
    ...(input.serveKey ? { serveKey: input.serveKey } : {}),
    params: input.params,
    maxMinutes: input.maxMinutes,
    recipe: recipe.id,
    deadlineEpoch: input.deadlineEpoch ?? deadlineEpochFor(input.maxMinutes),
    ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}),
    ...(input.checks?.length ? { checks: input.checks } : {}),
  };
  const files = [
    { path: `${JOB_DIR}/job.json`, permissions: "0600", content: JSON.stringify(job) },
    { path: `${JOB_DIR}/runner.py`, permissions: "0755", content: RUNNER_PY },
    { path: `${JOB_DIR}/recipe.py`, permissions: "0644", content: recipe.script },
  ];
  const lines = ["#cloud-config", "write_files:"];
  for (const f of files) {
    lines.push(
      `  - path: ${f.path}`,
      "    owner: root:root",
      `    permissions: "${f.permissions}"`,
      "    encoding: b64",
      `    content: "${b64(f.content)}"`,
    );
  }
  lines.push("runcmd:", `  - ${JSON.stringify(["sh", "-c", START])}`, "");
  const doc = lines.join("\n");
  const bytes = Buffer.byteLength(doc, "utf8");
  if (bytes >= MAX_USER_DATA_BYTES) throw new Error(`User data is ${bytes} bytes, over the 1 MB limit`);
  return doc;
}
