// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it.
//
// For each platform service in musemuse.caps.json it runs scripts/caps/<cap>.mjs, whose check({ record, proof, root })
// returns [{ id, ok, detail }], against two records:
//   record: what the product's smoke test recorded with tests/caps (test-results/caps/<cap>.json)
//   proof:  what the gateway itself saw for this build (GET {GATEWAY_URL}/caps/proof with the build token), which product
//           code can't write. Null when it couldn't be read.
// A service with no checker, or whose smoke test recorded nothing, fails. The last line of stdout is one JSON result:
// {"musemuse_caps":1,"ok":bool,"caps":[{"cap","checks":[{"id","ok","detail"}]}]}. Exits 0 only when every check passed.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAP = /^[a-z][a-z0-9-]*$/;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** GATEWAY_URL and PRODUCT_TOKEN from .env.local. Never printed. */
function gatewaySettings(root) {
  const file = path.join(root, ".env.local");
  if (!existsSync(file)) return null;
  const values = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) values[m[1]] = m[2].trim();
  }
  return values.GATEWAY_URL && values.PRODUCT_TOKEN ? { url: values.GATEWAY_URL.replace(/\/+$/, ""), token: values.PRODUCT_TOKEN } : null;
}

async function gatewayProof(root, { proofFile, fetchImpl = fetch } = {}) {
  if (proofFile) return readJson(proofFile);
  const settings = gatewaySettings(root);
  if (!settings) return null;
  try {
    const res = await fetchImpl(`${settings.url}/caps/proof`, { headers: { authorization: `Bearer ${settings.token}` }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Runs every active service's checks. Pure apart from reading files and the gateway, so tests call it directly. */
export async function runCapsCheck({ root = DEFAULT_ROOT, proofFile, fetchImpl } = {}) {
  const file = readJson(path.join(root, "musemuse.caps.json"));
  const caps = Array.isArray(file?.caps) ? file.caps.filter((c) => typeof c === "string" && CAP.test(c)) : null;
  if (!caps) return { musemuse_caps: 1, ok: false, caps: [{ cap: "caps", checks: [{ id: "caps-file", ok: false, detail: "musemuse.caps.json is missing or not valid" }] }] };
  const proof = await gatewayProof(root, { proofFile, fetchImpl });
  const out = [];
  for (const cap of caps) {
    const record = readJson(path.join(root, "test-results", "caps", `${cap}.json`));
    const checker = path.join(root, "scripts", "caps", `${cap}.mjs`);
    let checks;
    if (!existsSync(checker)) {
      checks = [{ id: "checker", ok: false, detail: `scripts/caps/${cap}.mjs is missing` }];
    } else if (!record || !Array.isArray(record.checks) || !record.checks.length) {
      checks = [{ id: "recorded", ok: false, detail: `the smoke test recorded no checks for ${cap}. Use the helpers in tests/caps.` }];
    } else {
      try {
        const mod = await import(pathToFileURL(checker).href);
        const result = await mod.check({ record, proof: proof?.caps?.[cap] ?? null, gateway: proof, root });
        checks = Array.isArray(result) && result.length
          ? result.map((k) => ({ id: String(k?.id ?? "check").slice(0, 80), ok: k?.ok === true, ...(k?.detail ? { detail: String(k.detail).slice(0, 300) } : {}) }))
          : [{ id: "checker", ok: false, detail: `scripts/caps/${cap}.mjs returned no checks` }];
      } catch (err) {
        checks = [{ id: "checker", ok: false, detail: `scripts/caps/${cap}.mjs failed: ${String(err?.message ?? err).slice(0, 200)}` }];
      }
    }
    out.push({ cap, checks });
  }
  const ok = out.length > 0 && out.every((c) => c.checks.every((k) => k.ok));
  return { musemuse_caps: 1, ok, caps: out };
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
  const at = process.argv.indexOf("--proof-file");
  const result = await runCapsCheck({ proofFile: at > 0 ? process.argv[at + 1] : undefined });
  const dir = path.join(DEFAULT_ROOT, "test-results", "caps");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
  for (const c of result.caps) for (const k of c.checks) process.stdout.write(`caps: ${c.cap} ${k.id} ${k.ok ? "ok" : "FAILED"}${k.detail ? ` (${k.detail})` : ""}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(result.ok ? 0 : 1));
}
