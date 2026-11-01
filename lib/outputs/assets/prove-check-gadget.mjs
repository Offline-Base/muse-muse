// Checks a Muse gadget pack's zip by machine, with no gadget: it unpacks the zip in a temporary folder, checks every
// command file against the Linux Gadget SDK's rules, checks the scripts with bash -n and a dry run of install.sh, and
// prints where it unpacked them so the runner can be run next.
//   node prove-check-gadget.mjs <pack.zip> <slug> <prefix>
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

const [zipPath, slug, prefix] = process.argv.slice(2);
// The SDK's rules, from its README ("Add your own commands").
const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MAX_NAME = 64;
const RESERVED = ["system.", "file.", "device.", "link."];
const TYPES = ["string", "integer", "number", "boolean", "object", "array"];
const KEYS = ["description", "exec", "required", "optional", "timeout_ms"];
const MAX_TIMEOUT_MS = 600_000;
const TIMEOUT_GRACE_MS = 5_000;
const MAX_FILE_BYTES = 64 * 1024;
const REGISTRATION_LIMIT = 256 * 1024;

let failed = false;
const say = (ok, text) => {
  console.log(`${ok ? "ok    " : "FAILED"} ${text}`);
  if (!ok) failed = true;
  return ok;
};

function readZip(zip) {
  let end = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("it isn't a zip file");
  const files = new Map();
  let at = zip.readUInt32LE(end + 16);
  for (let n = zip.readUInt16LE(end + 10); n > 0; n--) {
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const file = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const body = zip.subarray(start, start + packed);
    files.set(file, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** What's wrong with one command file, by the SDK's rules, or [] when nothing is. */
function problems(name, bytes, libDir) {
  const out = [];
  if (bytes.length > MAX_FILE_BYTES) out.push(`it is over ${MAX_FILE_BYTES} bytes`);
  if (name.length > MAX_NAME || !NAME_RE.test(name)) out.push("its name isn't lowercase words joined by dots");
  if (RESERVED.some((r) => name.startsWith(r))) out.push("its name starts with a reserved prefix");
  if (!name.startsWith(`${prefix}.`)) out.push(`its name doesn't start with ${prefix}.`);
  let spec;
  try {
    spec = JSON.parse(bytes.toString("utf8"));
  } catch {
    return [...out, "it isn't JSON"];
  }
  if (!isObject(spec)) return [...out, "it isn't a JSON object"];
  const unknown = Object.keys(spec).filter((k) => !KEYS.includes(k));
  if (unknown.length) out.push(`it has unknown keys: ${unknown.join(", ")}`);
  if (typeof spec.description !== "string" || !spec.description.trim()) out.push("it has no description");
  const exec = spec.exec;
  if (!Array.isArray(exec) || !exec.length || !exec.every((a) => typeof a === "string" && a)) out.push("exec isn't a list of strings");
  else {
    if (!exec[0].startsWith("/")) out.push("exec doesn't start with an absolute path");
    if (exec.length !== 3 || exec[0] !== `${libDir}/node` || exec[1] !== `${libDir}/runner.cjs`) out.push(`exec doesn't run ${libDir}/runner.cjs with one action`);
  }
  const params = {};
  for (const key of ["required", "optional"]) {
    const group = spec[key] ?? {};
    if (!isObject(group)) {
      out.push(`${key} isn't an object`);
      continue;
    }
    for (const [field, p] of Object.entries(group)) {
      const shape = isObject(p) && Object.keys(p).sort().join(",") === "description,type" && TYPES.includes(p.type) && typeof p.description === "string";
      if (!shape) out.push(`${key}.${field} isn't {type, description} with a known type`);
      if (Object.hasOwn(params, field)) out.push(`${field} is both required and optional`);
      params[field] = key;
    }
  }
  const t = spec.timeout_ms ?? 30_000;
  if (!Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_MS) out.push(`timeout_ms isn't an integer from 1 to ${MAX_TIMEOUT_MS}`);
  return out;
}

let files;
try {
  files = readZip(readFileSync(zipPath));
} catch (err) {
  say(false, `can't read the zip: ${err.message}`);
  process.exit(1);
}
const folder = `${slug}-muse-gadget`;
for (const file of files.keys()) console.log(`      ${file}`);
say([...files.keys()].every((f) => f.startsWith(`${folder}/`) && !f.split("/").includes("..") && !f.includes("\\")), `every path stays inside ${folder}/`);
for (const file of ["README.md", "install.sh", "uninstall.sh", "runner.cjs"]) say(files.has(`${folder}/${file}`), `it has ${file}`);

const dir = mkdtempSync(path.join(tmpdir(), "gadget-"));
for (const [file, body] of files) {
  if (!file.startsWith(`${folder}/`) || file.split("/").includes("..")) continue;
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), body);
}
const root = path.join(dir, folder);

const libDir = `/usr/local/lib/${prefix}-gadget`;
const commands = [...files.keys()].filter((f) => f.startsWith(`${folder}/commands.d/`) && f.endsWith(".json"));
say(commands.length > 0, `it has ${commands.length} command file${commands.length === 1 ? "" : "s"}`);
let total = 0;
const names = [];
for (const file of commands) {
  const name = path.basename(file, ".json");
  names.push(name);
  const bytes = files.get(file);
  const wrong = problems(name, bytes, libDir);
  say(!wrong.length, `${name}${wrong.length ? `: ${wrong.join("; ")}` : " follows the SDK's rules"}`);
  try {
    const spec = JSON.parse(bytes.toString("utf8"));
    total += Buffer.byteLength(JSON.stringify({ [name]: { description: spec.description, required: spec.required ?? {}, optional: spec.optional ?? {}, timeout_ms: (spec.timeout_ms ?? 30_000) + TIMEOUT_GRACE_MS } }));
  } catch {
    // Already reported.
  }
}
say(total <= REGISTRATION_LIMIT, `its registrations take ${Math.ceil(total / 1024)} KiB of the gadget's ${REGISTRATION_LIMIT / 1024} KiB`);

const install = files.get(`${folder}/install.sh`)?.toString("utf8") ?? "";
const uninstall = files.get(`${folder}/uninstall.sh`)?.toString("utf8") ?? "";
const listed = (/^COMMANDS=\((.*)\)$/m.exec(install)?.[1] ?? "").split(" ").map((n) => n.replace(/^'|'$/g, "")).filter(Boolean);
say(listed.length === names.length && listed.every((n) => names.includes(n)), "install.sh installs exactly the command files in the pack");
say(![install, uninstall].some((s) => /sdk_token|\/var\/lib\/musegadget|mgst_/.test(s)), "the scripts never touch the SDK token");
for (const file of ["install.sh", "uninstall.sh"]) {
  const checked = spawnSync("bash", ["-n", path.join(root, file)], { encoding: "utf8" });
  say(checked.status === 0, `bash -n ${file}${checked.status === 0 ? "" : `: ${(checked.stderr || "").trim().split("\n").pop()}`}`);
}
const syntax = spawnSync(process.execPath, ["--check", path.join(root, "runner.cjs")], { encoding: "utf8" });
say(syntax.status === 0, "node --check runner.cjs");

// A dry run under a made-up root changes nothing and needs no sudo.
const fake = path.join(dir, "fake-root");
const dry = spawnSync("bash", [path.join(root, "install.sh"), "--dry-run", "--root", fake, "--node", process.execPath], { encoding: "utf8" });
const would = (dry.stdout || "").split("\n").filter((l) => l.startsWith("would run:"));
say(
  dry.status === 0 && names.every((n) => would.some((l) => l.includes(`commands.d/${n}.json`))),
  `install.sh --dry-run would add ${names.length} command${names.length === 1 ? "" : "s"}${dry.status === 0 ? "" : `: ${(dry.stderr || "").trim().split("\n").pop()}`}`,
);

console.log(`unpacked to ${root}`);
process.exit(failed ? 1 : 0);
