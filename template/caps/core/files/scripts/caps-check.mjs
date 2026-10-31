// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it.
//
// For each platform service the product has it runs that service's checker, scripts/caps/<cap>.mjs, whose
// check({ record, proof, gateway, gatewayProblem, root }) returns [{ id, ok, detail }], against two records:
//   record: what the product's smoke test recorded with tests/caps (test-results/caps/<cap>.json)
//   proof:  what the gateway itself saw for this build since this verify started (GET {gateway}/caps/proof?since=...),
//           which product code can't write. Null when it couldn't be read, and gatewayProblem says why.
// A service with no checker, or whose smoke test recorded nothing, fails. The last line of stdout is one JSON result:
// {"musemuse_caps":1,"ok":bool,"caps":[{"cap","checks":[{"id","ok","detail"}]}],"gateway":{"ok","problem"?}}. Exits 0
// only when every check passed.
//
// In a build sandbox verify runs the read-only copy in /vercel/musemuse/caps (CAPS_DIR): the list of services, every
// checker and the gateway's address and build token all come from there, never from the product's folder, so an edit to
// the product can't change which checks run or where the gateway's record comes from. The product is passed as --root.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAP = /^[a-z][a-z0-9-]*$/;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && CAP.test(x)) : null);

/**
 * The read-only overlays folder when this file is its core copy (CAPS_DIR/core/files/scripts/caps-check.mjs) and the
 * folder has the platform's record of the product's caps, else null: a copy in a product folder, for tests and local use.
 */
export function platformCapsDir(here = HERE) {
  const dir = path.resolve(here, "../../..");
  return path.basename(path.resolve(here, "../..")) === "core" && existsSync(path.join(dir, "active.json")) ? dir : null;
}

/**
 * The gateway's address and the build token, from the platform's record (CAPS_DIR/gateway.json), never from the
 * product's .env.local. { url: null, reason } on a local run, where the build machine can't reach the gateway.
 */
function gatewaySettings(file) {
  if (!file) return { problem: "this run has no record of the gateway (it isn't a platform build)" };
  const g = readJson(file);
  if (!g) return { problem: "the platform's record of the gateway is missing" };
  if (typeof g.url !== "string" || typeof g.token !== "string") return { problem: typeof g.reason === "string" ? g.reason : "the platform's record of the gateway is empty" };
  return { url: g.url.replace(/\/+$/, ""), token: g.token };
}

async function gatewayProof({ gatewayFile, proofFile, since, fetchImpl = fetch }) {
  if (proofFile) {
    const proof = readJson(proofFile);
    return proof ? { proof } : { problem: "the proof file couldn't be read" };
  }
  const settings = gatewaySettings(gatewayFile);
  if (!settings.url) return { problem: settings.problem };
  const query = since ? `?since=${encodeURIComponent(since)}` : "";
  try {
    const res = await fetchImpl(`${settings.url}/caps/proof${query}`, { headers: { authorization: `Bearer ${settings.token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { problem: `the gateway answered ${res.status}` };
    return { proof: await res.json() };
  } catch (err) {
    return { problem: `the gateway couldn't be reached (${String(err?.name ?? "error")})` };
  }
}

/**
 * Runs every active service's checks. Pure apart from reading files and the gateway, so tests call it directly.
 * `capsDir` is the read-only overlays folder (platformCapsDir), or null for a copy in a product folder.
 */
export async function runCapsCheck({ root, capsDir = platformCapsDir(), proofFile, gatewayFile, since, fetchImpl } = {}) {
  root = root ?? path.resolve(HERE, "..");
  const active = capsDir ? readJson(path.join(capsDir, "active.json")) : readJson(path.join(root, "musemuse.caps.json"));
  const caps = ids(active?.caps);
  const where = capsDir ? "the platform's record of this product's caps" : "musemuse.caps.json";
  if (!caps) return { musemuse_caps: 1, ok: false, caps: [{ cap: "caps", checks: [{ id: "caps-file", ok: false, detail: `${where} is missing or not valid` }] }] };
  const overlays = ids(active?.overlays) ?? [];
  const checkerFor = (cap) => {
    if (!capsDir) return path.join(root, "scripts", "caps", `${cap}.mjs`);
    for (const o of [cap, ...overlays.filter((x) => x !== cap)]) {
      const file = path.join(capsDir, o, "files", "scripts", "caps", `${cap}.mjs`);
      if (existsSync(file)) return file;
    }
    return null;
  };
  const read = await gatewayProof({ gatewayFile: gatewayFile ?? (capsDir ? path.join(capsDir, "gateway.json") : null), proofFile, since, fetchImpl });
  const proof = read.proof ?? null;
  const gatewayProblem = proof ? null : read.problem;
  const out = [];
  for (const cap of caps) {
    const record = readJson(path.join(root, "test-results", "caps", `${cap}.json`));
    const checker = checkerFor(cap);
    let checks;
    if (!checker || !existsSync(checker)) {
      checks = [{ id: "checker", ok: false, detail: `scripts/caps/${cap}.mjs is missing` }];
    } else if (!record || !Array.isArray(record.checks) || !record.checks.length) {
      checks = [{ id: "recorded", ok: false, detail: `the smoke test recorded no checks for ${cap}. Use the helpers in tests/caps.` }];
    } else {
      try {
        const mod = await import(pathToFileURL(checker).href);
        const result = await mod.check({ record, proof: proof?.caps?.[cap] ?? null, gateway: proof, gatewayProblem, root });
        checks = Array.isArray(result) && result.length
          ? result.map((k) => ({ id: String(k?.id ?? "check").slice(0, 80), ok: k?.ok === true, ...(k?.detail ? { detail: String(k.detail).slice(0, 300) } : {}) }))
          : [{ id: "checker", ok: false, detail: `scripts/caps/${cap}.mjs returned no checks` }];
      } catch (err) {
        checks = [{ id: "checker", ok: false, detail: `scripts/caps/${cap}.mjs failed: ${String(err?.message ?? err).slice(0, 200)}` }];
      }
      // A failed check with no gateway record says why the record is missing, so the reason isn't silent.
      if (gatewayProblem) checks = checks.map((k) => (k.ok ? k : { ...k, detail: `${k.detail ? `${k.detail}. ` : ""}The gateway's record couldn't be read: ${gatewayProblem}`.slice(0, 400) }));
    }
    out.push({ cap, checks });
  }
  const ok = out.length > 0 && out.every((c) => c.checks.every((k) => k.ok));
  return { musemuse_caps: 1, ok, caps: out, gateway: proof ? { ok: true } : { ok: false, problem: gatewayProblem } };
}

/** True when this file is the script node was asked to run, through any symlinks. */
function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const arg = (name) => {
    const at = process.argv.indexOf(name);
    return at > 0 ? process.argv[at + 1] : undefined;
  };
  const root = path.resolve(arg("--root") ?? path.resolve(HERE, ".."));
  const result = await runCapsCheck({ root, proofFile: arg("--proof-file"), since: arg("--since") });
  const dir = path.join(root, "test-results", "caps");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (!result.gateway.ok) process.stdout.write(`caps: the gateway's record couldn't be read: ${result.gateway.problem}\n`);
  for (const c of result.caps) for (const k of c.checks) process.stdout.write(`caps: ${c.cap} ${k.id} ${k.ok ? "ok" : "FAILED"}${k.detail ? ` (${k.detail})` : ""}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(result.ok ? 0 : 1));
}
