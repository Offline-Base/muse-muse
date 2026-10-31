// What the platform asks for, in job.json. The name and URL come from a product's brief, so they are data: nothing here is
// ever put in a shell string, and every tool runs from an argv array.

export const KINDS = ["android", "mac", "windows"];

const PACKAGE_ID = /^ai\.musemuse\.p[0-9a-f]{16}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_NAME_CHARS = 80;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export class JobError extends Error {}

/** One line of plain text: no control characters, and no bidi marks that could dress up a file name. */
export function cleanName(raw) {
  const name = String(raw ?? "")
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...name].slice(0, MAX_NAME_CHARS).join("").trim();
}

/**
 * The name for files and folders, safe on macOS and Windows. Also what the Mac helpers are named after, since Electron
 * finds "<CFBundleName> Helper.app" by that exact name at launch.
 */
export function fileName(name) {
  const safe = cleanName(name)
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (!safe || WINDOWS_RESERVED.test(safe)) return "Muse App";
  return safe;
}

function isOpenableUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  } catch {
    return false;
  }
}

/** Checks job.json and returns what the rest of the script may read. Throws a JobError saying what's wrong. */
export function parseJob(raw) {
  if (raw?.v !== 1) throw new JobError("This job isn't version 1.");
  const name = cleanName(raw.product?.name);
  if (!name) throw new JobError("The product needs a name.");
  if (!isOpenableUrl(raw.product?.url)) throw new JobError("The product's link must start with https.");
  if (!PACKAGE_ID.test(raw.product?.packageId ?? "")) throw new JobError("The product's package id isn't valid.");
  if (typeof raw.shellVersion !== "string" || !/^[0-9A-Za-z.+-]{1,40}$/.test(raw.shellVersion)) {
    throw new JobError("The shell version isn't valid.");
  }
  const kinds = KINDS.filter((kind) => raw.outputs?.[kind]);
  if (!kinds.length) throw new JobError("The job asks for no packages.");
  for (const kind of kinds) {
    const template = raw.templates?.[kind];
    if (typeof template?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(template.sha256)) {
      throw new JobError(`The ${kind} template has no checksum.`);
    }
  }
  const url = new URL(raw.product.url);
  return {
    shellVersion: raw.shellVersion,
    product: { name, fileName: fileName(name), url: url.href, packageId: raw.product.packageId, version: raw.shellVersion },
    iconPath: typeof raw.iconPath === "string" ? raw.iconPath : null,
    kinds,
    templates: raw.templates,
    outputs: raw.outputs,
  };
}
