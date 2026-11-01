// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it through scripts/caps-check.mjs.
//
// The fixed checks for Python functions. In a build sandbox this is the platform's read-only copy, and it runs the
// product's api/py/ files with the platform's own runner beside it (../py-local.mjs), never the product's copy:
//   python         a Python 3 runs on the build machine, the same minor version .python-version gives Vercel
//   requirements   requirements.txt pins every package and lists no web framework
//   size           the installed packages leave room under Vercel's limit for one Python function (500 MB)
//   functions      every api/py/<name>.py loads and defines class handler(BaseHTTPRequestHandler)
//   safe           no function calls anything that reads text as code (eval, exec, sympify, parse_expr, pandas eval
//                  and query), loads pickles, or starts programs
//   guard          every function clears the product's settings when it loads, refuses a call without callPython's
//                  header (as a visitor calling /api/py/<name> directly would be), and answers one with it
//   health         api/py/musemuse_health.py answers {"ok": true}, as it must on the live link
//   python-action  the smoke test ran an action that went through a Python function (tests/caps/runtime.ts)
//   rerun          the platform ran each function the smoke test used again, on the same input, and got a reply of the
//                  same shape as the one the product showed. Calls whose input was too big to keep aren't run again.
//
// What these checks rest on: python-action and rerun read records the product's own processes write (the smoke test's
// record and the build server's call log), so a product that wanted to could fake them. The call log is read before
// any of the product's Python runs here, so a function's own code can't add to it, and rerun runs real functions. The
// gateway keeps no record of Python calls, since they never reach it.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const MAX_RERUNS = 3;
/** Vercel's bundle limit for a Python function, uncompressed (its Python runtime docs, read Oct 31). */
export const VERCEL_PYTHON_BUNDLE_MB = 500;
/** The packages may take this much of it, leaving room for the product's own files. */
export const PACKAGES_MAX_MB = 450;

/** The runner beside this checker: the platform's copy in a build sandbox. */
async function runner() {
  return import(new URL("../py-local.mjs", import.meta.url).href);
}

/** The shape of a JSON value: types, object keys and each array's first item. Numbers and words may differ. */
export function shapeOf(value, depth = 0) {
  if (depth > 6) return "deep";
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1)] : [];
  if (typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf(value[k], depth + 1)]));
  return typeof value;
}

/** True when two shapes agree. An empty list agrees with any list, since a different input may give no items. */
function sameShape(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return !a.length || !b.length || sameShape(a[0], b[0]);
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && sameShape(a[k], b[k]));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function loggedCalls(root) {
  const file = path.join(root, "test-results", "caps", "runtime-calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const c = JSON.parse(line);
        if (!c || typeof c.name !== "string") return [];
        // A note from before notes kept the shape carries the whole reply.
        const shape = "shape" in c ? c.shape : shapeOf(c.output);
        const kept = c.kept !== false && "input" in c;
        return [{ name: c.name, kept, input: kept ? c.input : undefined, shape }];
      } catch {
        return [];
      }
    });
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export async function check({ record, root, env = process.env }) {
  // First, before anything of the product's runs here.
  const calls = loggedCalls(root);
  const py = await runner();
  const checks = [];
  const python = py.findPython({ env, root });
  const pinned = existsSync(path.join(root, ".python-version")) ? readFileSync(path.join(root, ".python-version"), "utf8").trim() : "";
  const same = Boolean(python) && (!pinned || pinned === python.minor);
  checks.push({
    id: "python",
    ok: same,
    detail: !python ? "there is no Python 3 on the build machine" : same ? `Python ${python.version}` : `the build runs Python ${python.version}, but .python-version gives Vercel ${pinned}`,
  });
  if (!python) return checks;

  const req = py.readRequirements(root);
  checks.push({
    id: "requirements",
    ok: req.ok,
    detail: req.ok ? (req.packages.length ? req.packages.map((p) => p.line).join(", ") : "the standard library only") : req.problems.join("; "),
  });
  if (req.ok && req.packages.length) {
    let installed;
    try {
      installed = py.install(root, { env });
    } catch (err) {
      checks.push({ id: "install", ok: false, detail: err.message });
      return checks;
    }
    const bytes = py.folderBytes(installed.dir);
    checks.push({
      id: "size",
      ok: bytes <= PACKAGES_MAX_MB * 1024 * 1024,
      detail:
        bytes <= PACKAGES_MAX_MB * 1024 * 1024
          ? `the packages take ${mb(bytes)} of the ${VERCEL_PYTHON_BUNDLE_MB} MB Vercel allows a Python function`
          : `the packages take ${mb(bytes)}, too close to the ${VERCEL_PYTHON_BUNDLE_MB} MB Vercel allows a Python function: drop the biggest`,
    });
  } else if (req.ok) {
    checks.push({ id: "size", ok: true, detail: "no packages to install" });
  }

  // A stand-in token, made here and used for nothing else: the guard check needs a deployment's settings to clear.
  const standIn = `mm_check_${randomBytes(12).toString("hex")}`;
  const deployEnv = { PRODUCT_TOKEN: standIn, GATEWAY_URL: "https://gateway.invalid/api/gateway" };
  const names = py.listFunctions(root);
  const own = names.filter((n) => n !== py.HEALTH_FUNCTION);
  const broken = [];
  const unsafe = [];
  const unguarded = [];
  const loaded = [];
  for (const name of own) {
    const r = await py.runFunction({ root, name, loadOnly: true, env, pythonEnv: deployEnv }).catch((err) => ({ loaded: false, error: err.message }));
    for (const u of r.unsafe ?? []) unsafe.push(`${name}.py ${u}`);
    if (!r.loaded) {
      broken.push(`${name}: ${r.error}`);
      continue;
    }
    loaded.push(name);
    if (r.envCleared !== true) unguarded.push(`${name} keeps the product's settings when it loads`);
  }
  checks.push({
    id: "functions",
    ok: own.length > 0 && !broken.length,
    detail: !own.length ? `there is no Python function in ${py.FUNCTIONS_DIR}/` : broken.length ? broken.join("; ") : `${own.length} function(s) load: ${own.join(", ")}`,
  });
  checks.push({
    id: "safe",
    ok: !unsafe.length,
    detail: unsafe.length
      ? `${unsafe.slice(0, 6).join("; ")}. These read text as code or load objects from bytes: work from the JSON's own values instead`
      : "no function reads text as code, loads pickles or starts programs",
  });

  for (const name of loaded) {
    const run = (key) => py.runFunction({ root, name, body: "{}", env, pythonEnv: deployEnv, key }).catch((err) => ({ status: 500, error: err.message }));
    const stranger = await run("");
    if (stranger.status !== 403) unguarded.push(`${name} answered HTTP ${stranger.status} to a call without callPython's header`);
    const withKey = await run(py.pythonKey(standIn));
    if (withKey.status === 403) unguarded.push(`${name} refused callPython's own header`);
  }
  checks.push({
    id: "guard",
    ok: loaded.length > 0 && !unguarded.length,
    detail: unguarded.length
      ? `${unguarded.join("; ")}. Start each function with the guard from the muse-python skill (node scripts/py-local.mjs new <name> writes it)`
      : loaded.length
        ? `${loaded.join(", ")} clear the settings and answer only their own product`
        : "no function loaded to check",
  });

  const health = await py.runFunction({ root, name: py.HEALTH_FUNCTION, method: "GET", env }).catch((err) => ({ status: 500, error: err.message }));
  let healthJson = null;
  try {
    healthJson = health.body ? JSON.parse(health.body.toString("utf8")) : null;
  } catch {
    healthJson = null;
  }
  checks.push({ id: "health", ok: health.status === 200 && healthJson?.ok === true, detail: health.error ?? `${py.FUNCTIONS_DIR}/${py.HEALTH_FUNCTION}.py answered HTTP ${health.status}` });

  const recorded = (record?.checks ?? []).find((c) => c.id === "python-action");
  checks.push({ id: "python-action", ok: recorded?.ok === true, detail: recorded?.detail ?? "the smoke test didn't run a Python-backed action with expectPythonAction" });

  if (!calls.length) {
    checks.push({ id: "rerun", ok: false, detail: "no Python call was noted while the smoke test ran" });
    return checks;
  }
  const picked = [];
  const tooBig = new Set();
  for (const c of calls) {
    if (!c.kept) {
      tooBig.add(c.name);
      continue;
    }
    if (!picked.some((p) => p.name === c.name) && picked.length < MAX_RERUNS) picked.push(c);
  }
  if (!picked.length) {
    checks.push({ id: "rerun", ok: true, detail: `every call to ${[...tooBig].join(", ")} was over 64 KB, too big to keep, so none ran again` });
    return checks;
  }
  const problems = [];
  for (const c of picked) {
    if (!names.includes(c.name)) {
      problems.push(`${c.name} isn't in ${py.FUNCTIONS_DIR}/`);
      continue;
    }
    const r = await py.runFunction({ root, name: c.name, body: JSON.stringify(c.input ?? null), env }).catch((err) => ({ status: 500, error: err.message }));
    if (r.error || r.status !== 200) {
      problems.push(`${c.name} failed when the platform ran it: ${r.error ?? `HTTP ${r.status}`}`);
      continue;
    }
    let again;
    try {
      again = JSON.parse(r.body.toString("utf8"));
    } catch {
      problems.push(`${c.name} didn't answer with JSON when the platform ran it`);
      continue;
    }
    if (!sameShape(shapeOf(again), c.shape)) problems.push(`${c.name} gave a reply of another shape when the platform ran it on the same input`);
  }
  const skipped = [...tooBig].filter((n) => !picked.some((p) => p.name === n));
  checks.push({
    id: "rerun",
    ok: !problems.length,
    detail: problems.length
      ? problems.join("; ")
      : `the platform ran ${picked.map((c) => c.name).join(", ")} again and got the same shape of reply${skipped.length ? `; ${skipped.join(", ")} had only calls over 64 KB, too big to keep` : ""}`,
  });
  return checks;
}
