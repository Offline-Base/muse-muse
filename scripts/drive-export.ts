/**
 * Puts the owner's own private model file on a USB drive in the board (docs/DRIVE_EXPORT.md, "Tuned on a cloud GPU"): the
 * stage 2 Muse Glimmer GGUF in the owner's S3 bucket, or another file like it. It signs a 15-minute link on this laptop with
 * the owner's own AWS session (the aws CLI's "aws s3 presign"), and hands it to the platform's admin drive route, which
 * passes it straight to the board and stores it nowhere. The AWS credentials never leave this laptop.
 *
 * Decision 18 (docs/CAPABILITIES.md, 21a): the stage 2 file goes only onto the owner's own stick.
 *
 *   MUSE_SESSION=<the mm_session cookie of an admin, from the browser> \
 *     npx tsx scripts/drive-export.ts --origin <the deployment with DRIVE_EXPORT_ENABLED, a preview by decision 6> \
 *       --s3 s3://<bucket>/knowledge/models/stage2/glimmer-stage2-IQ1_S.gguf --drive sda \
 *       [--identity <from the drive card>] [--system <file holding the system message>]
 *   ... --resume <export id> [--drive sda]     a fresh link for an export waiting in needs_urls, or to carry one on
 *
 * The defaults describe stage 2 (subjects.ts in muse-muse-devices): name, size and sha256. It prints neither the link nor
 * the cookie.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
/** lib/auth.ts SESSION_COOKIE. Not imported, since lib/auth.ts brings the database with it. */
const SESSION_COOKIE = "mm_session";

const STAGE2 = {
  name: "glimmer-stage2-IQ1_S.gguf",
  level: "IQ1_S",
  bytes: 6_526_418_880,
  sha256: "23fef56a3bb9c7f3f2e513044cf11c88bf2d3cb3adfbc727c49288cea4fbafb4",
  title: "Muse Glimmer stage 2 (IQ1_S)",
  slug: "glimmer-stage2",
  changes: [
    "Muse Muse fine-tuned it on 2026 knowledge, in the knowledge run's two stages of LoRA training.",
    "The merged result was converted to GGUF and quantized to IQ1_S with llama.cpp. At about 1.6 bits a weight it is a pipeline test, not a model to rely on.",
  ],
};

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
      name: { type: "string", default: STAGE2.name },
      level: { type: "string", default: STAGE2.level },
      bytes: { type: "string", default: String(STAGE2.bytes) },
      sha256: { type: "string", default: STAGE2.sha256 },
      title: { type: "string", default: STAGE2.title },
      slug: { type: "string", default: STAGE2.slug },
    },
  });
  const session = process.env.MUSE_SESSION?.trim();
  if (!session) throw new Error("Set MUSE_SESSION to an admin's mm_session cookie, copied from the browser.");
  if (!values.s3?.startsWith("s3://")) throw new Error("Pass --s3 s3://<bucket>/<key> for the file.");
  if (!values.origin) throw new Error("Pass --origin, the site the Flash drive card is on (a preview, by decision 6).");
  const origin = values.origin.replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s?#@]+$/.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error("--origin must be https.");

  // 900 seconds is the most an aws login session's link lasts.
  const { stdout } = await run("aws", ["s3", "presign", values.s3, "--expires-in", "900"]);
  const url = stdout.trim();
  if (!url.startsWith("https://")) throw new Error("aws s3 presign didn't print an https link.");
  const file = { name: values.name!, level: values.level!, bytes: Number(values.bytes), sha256: values.sha256!.toLowerCase() };
  const body = values.resume
    ? { resume: values.resume, url, file, ...(values.drive ? { drive: values.drive } : {}), ...(values.identity ? { identity: values.identity } : {}) }
    : {
        source: "url",
        mode: "now",
        url,
        file,
        title: values.title,
        slug: values.slug,
        systemLine: values.system ? (await fs.readFile(values.system, "utf8")).trim() : "",
        changes: STAGE2.changes,
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
