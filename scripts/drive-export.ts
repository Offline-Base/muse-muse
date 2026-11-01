/**
 * Puts the owner's own private model file on a USB drive in the board (docs/DRIVE_EXPORT.md, "Tuned on a cloud GPU"): by
 * default r30b's 1-bit Muse Glimmer GGUF in the owner's S3 bucket (the owner's pick, Oct 31), or another file named in
 * full. It signs 15-minute links on this laptop with the owner's own AWS session (the aws CLI's "aws s3 presign"), and
 * hands them to the platform's admin drive route, which passes them straight to the board and stores them nowhere. The
 * AWS credentials never leave this laptop.
 *
 * A knowledge-run file is a Derivative of Muse Spark Open (docs/DRIVE_EXPORT.md, "Derivatives of Muse Spark Open"). Its
 * folder must also hold MUSE_MODEL_LICENSE.md, USAGE_POLICY.md and NOTICE; the script reads each once for its sha256, and
 * the drive gets them by link. It refuses while one is missing.
 *
 * Decision 18 (docs/CAPABILITIES.md, 21a): a knowledge-run file goes only onto the owner's own stick.
 *
 *   MUSE_SESSION=<the mm_session cookie of an admin, from the browser> \
 *     npx tsx scripts/drive-export.ts --origin <the deployment with DRIVE_EXPORT_ENABLED, a preview by decision 6> \
 *       --s3 s3://<bucket>/knowledge/models/stage-b-r30b/glimmer-stage-b-r30b-IQ1_S.gguf --drive sda \
 *       [--identity <from the drive card>] [--system <file holding the system message>]
 *   Another file: add --name --level --bytes --sha256 --title --slug --changes <file, one sentence a line>, and for a
 *   knowledge-run file --made-up-pct --honest-pct --false-premise-pct from its held-out honesty test.
 *   ... --resume <export id> [--drive sda]     fresh links for an export waiting in needs_urls, or to carry one on
 *
 * It prints neither the links nor the cookie.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
/** lib/auth.ts SESSION_COOKIE. Not imported, since lib/auth.ts brings the database with it. */
const SESSION_COOKIE = "mm_session";

/**
 * The owner's pick for the drive (Oct 31, through General): r30b's 1-bit file. Stage 2 goes on a drive only when every
 * fact of it is passed by hand (--name, --level, --bytes, --sha256, --title, --slug, --changes, and its own honesty
 * numbers), never by default: it made things up 94% of the time on the held-out honesty test.
 */
const R30B = {
  name: "glimmer-stage-b-r30b-IQ1_S.gguf",
  level: "IQ1_S",
  bytes: 6_526_418_912,
  sha256: "6fbd323c1c9947bcd9f678bdda106fafcc7485aa3c7dd9759ac4250d56a7e561",
  title: "Muse Glimmer 2026 knowledge (r30b, IQ1_S)",
  slug: "glimmer-r30b",
  changes: [
    "Muse Muse fine-tuned it on 2026 knowledge, in the knowledge run's two stages of LoRA training (stage b, run r30b).",
    "The merged result was converted to GGUF and quantized to IQ1_S with llama.cpp. At about 1.6 bits a weight, expect it to be wrong often.",
  ],
  // The training session's held-out honesty test (Oct 31): 55.3% made up, 44.7% honest; false premises about 80%.
  dangers: { madeUpPct: 55.3, honestPct: 44.7, falsePremisePct: 80 },
};

/**
 * A knowledge-run model is a Derivative of Muse Spark Open (lib/drive/plan.ts). Its release folder in S3, next to the
 * GGUF, holds these texts; the drive takes them by URL and sha256, as the board takes the GGUF.
 */
const DERIVATIVE_OBJECTS = {
  license: "MUSE_MODEL_LICENSE.md",
  usagePolicy: "USAGE_POLICY.md",
  notice: "NOTICE",
} as const;
type DerivativeKey = keyof typeof DERIVATIVE_OBJECTS;
/** lib/drive/plan.ts KNOWLEDGE_RUN_NAME, copied: the script doesn't import lib/. */
const KNOWLEDGE_RUN_NAME = /(^|[-_.\s])(r30b|stage-?b|stage-?2|knowledge)([-_.\s]|$)/i;
/** A license text is small. Anything bigger isn't one. */
const MAX_TEXT_BYTES = 1024 * 1024;

async function presign(s3: string): Promise<string> {
  // 900 seconds is the most an aws login session's link lasts.
  const { stdout } = await run("aws", ["s3", "presign", s3, "--expires-in", "900"]);
  const url = stdout.trim();
  if (!url.startsWith("https://")) throw new Error("aws s3 presign didn't print an https link.");
  return url;
}

/** Signs a link for each license text in the model's folder, and reads it once to give its bytes and sha256. */
async function derivativeFiles(folder: string): Promise<{ files: Record<DerivativeKey, { bytes: number; sha256: string }>; urls: Record<DerivativeKey, string> }> {
  const files = {} as Record<DerivativeKey, { bytes: number; sha256: string }>;
  const urls = {} as Record<DerivativeKey, string>;
  for (const key of Object.keys(DERIVATIVE_OBJECTS) as DerivativeKey[]) {
    const url = await presign(`${folder}/${DERIVATIVE_OBJECTS[key]}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${DERIVATIVE_OBJECTS[key]} isn't in ${folder} yet (S3 answered ${res.status}). A Derivative of Muse Spark Open can't go on a drive without it.`);
    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length || body.length > MAX_TEXT_BYTES) throw new Error(`${DERIVATIVE_OBJECTS[key]} in ${folder} is ${body.length} bytes, which isn't a license text.`);
    files[key] = { bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
    urls[key] = url;
  }
  return { files, urls };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      s3: { type: "string" },
      drive: { type: "string" },
      identity: { type: "string" },
      // No default: the test runs on a preview (decision 6), and production is never picked by leaving this out.
      origin: { type: "string" },
      system: { type: "string" },
      resume: { type: "string" },
      name: { type: "string" },
      level: { type: "string" },
      bytes: { type: "string" },
      sha256: { type: "string" },
      title: { type: "string" },
      slug: { type: "string" },
      // A file holding what was done to Meta's model, one sentence a line.
      changes: { type: "string" },
      "made-up-pct": { type: "string" },
      "honest-pct": { type: "string" },
      "false-premise-pct": { type: "string" },
    },
  });
  const session = process.env.MUSE_SESSION?.trim();
  if (!session) throw new Error("Set MUSE_SESSION to an admin's mm_session cookie, copied from the browser.");
  if (!values.s3?.startsWith("s3://")) throw new Error("Pass --s3 s3://<bucket>/<key> for the file.");
  if (!values.origin) throw new Error("Pass --origin, the site the Flash drive card is on (a preview, by decision 6).");
  const origin = values.origin.replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s?#@]+$/.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error("--origin must be https.");

  const own =[values.name, values.level, values.bytes, values.sha256, values.title, values.slug, values.changes].filter((v) => v !== undefined).length;
  if (own > 0 && own < 7) throw new Error("Another file than r30b needs all of --name, --level, --bytes, --sha256, --title, --slug and --changes.");
  const pick = own === 0 ? R30B : null;
  if (pick && !values.s3.endsWith(`/${R30B.name}`)) throw new Error(`Without --name and the rest, --s3 must be r30b's ${R30B.name}.`);
  const file = pick
    ? { name: pick.name, level: pick.level, bytes: pick.bytes, sha256: pick.sha256 }
    : { name: values.name!, level: values.level!, bytes: Number(values.bytes), sha256: values.sha256!.toLowerCase() };
  const title = pick ? pick.title : values.title!;
  const slug = pick ? pick.slug : values.slug!;
  const changes = pick ? pick.changes : (await fs.readFile(values.changes!, "utf8")).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // A knowledge-run file is a Derivative of Muse Spark Open: its license texts, and its own honesty numbers.
  const knowledge = [file.name, slug, title, values.s3].some((n) => KNOWLEDGE_RUN_NAME.test(n));
  let derivative: { files: Record<DerivativeKey, { bytes: number; sha256: string }>; dangers: typeof R30B.dangers } | undefined;
  let derivativeUrls: Record<DerivativeKey, string> | undefined;
  if (knowledge) {
    const given = [values["made-up-pct"], values["honest-pct"], values["false-premise-pct"]];
    if (!pick && given.some((v) => v === undefined)) throw new Error("A knowledge-run file needs its own --made-up-pct, --honest-pct and --false-premise-pct, from the held-out honesty test.");
    const dangers = pick && given.every((v) => v === undefined) ? pick.dangers : { madeUpPct: Number(given[0]), honestPct: Number(given[1]), falsePremisePct: Number(given[2]) };
    const made = await derivativeFiles(values.s3.slice(0, values.s3.lastIndexOf("/")));
    derivative = { files: made.files, dangers };
    derivativeUrls = made.urls;
  }
  const url = await presign(values.s3);
  const body = values.resume
    ? { resume: values.resume, url, file, ...(derivative ? { derivative, derivativeUrls } : {}), ...(values.drive ? { drive: values.drive } : {}), ...(values.identity ? { identity: values.identity } : {}) }
    : {
        source: "url",
        mode: "now",
        url,
        file,
        title,
        slug,
        systemLine: values.system ? (await fs.readFile(values.system, "utf8")).trim() : "",
        changes,
        ...(derivative ? { derivative, derivativeUrls } : {}),
        drive: values.drive,
        ...(values.identity ? { identity: values.identity } : {}),
      };
  if (!values.resume && !values.drive) throw new Error("Pass --drive, the drive's name from the Flash drive card: the link expires too soon to arm.");
  const res = await fetch(`${origin}/api/device/drive`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`The platform answered ${res.status} ${String(answer.error ?? "")}${answer.message ? `: ${String(answer.message)}` : ""}`);
  console.log(`Export ${String(answer.export)} is ${String(answer.state)}. Follow it on /device. The link lasts 15 minutes: if it waits for a fresh one, run this again with --resume ${String(answer.export)}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message.replace(/https?:\/\/[^\s"'<>]*\?[^\s"'<>]*/g, "[signed URL]") : err);
  process.exit(1);
});
