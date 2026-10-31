// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it through scripts/caps-check.mjs.
//
// The fixed checks for Python functions. In a build sandbox this is the platform's read-only copy, and it runs the
// product's api/py/ files with the platform's own runner beside it (../py-local.mjs), never the product's copy:
//   python         a Python 3 runs on the build machine
//   requirements   requirements.txt pins every package and lists no web framework
//   functions      every api/py/<name>.py loads and defines class handler(BaseHTTPRequestHandler)
//   health         api/py/musemuse_health.py answers {"ok": true}, as it must on the live link
//   python-action  the smoke test ran an action that went through a Python function (tests/caps/runtime.ts)
//   rerun          the platform ran each function the smoke test used again, on the same input, and got a reply of the
//                  same shape as the one the product showed
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const MAX_RERUNS = 3;

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
        return c && typeof c.name === "string" ? [c] : [];
      } catch {
        return [];
      }
    });
}

export async function check({ record, root, env = process.env }) {
  const py = await runner();
  const checks = [];
  const python = py.findPython({ env });
  checks.push({ id: "python", ok: Boolean(python), detail: python ? `Python ${python.version}` : "there is no Python 3 on the build machine" });
  if (!python) return checks;

  const req = py.readRequirements(root);
  checks.push({
    id: "requirements",
    ok: req.ok,
    detail: req.ok ? (req.packages.length ? req.packages.map((p) => p.line).join(", ") : "the standard library only") : req.problems.join("; "),
  });
  if (req.ok && req.packages.length) {
    try {
      py.install(root, { env });
    } catch (err) {
      checks.push({ id: "install", ok: false, detail: err.message });
      return checks;
    }
  }

  const names = py.listFunctions(root);
  const own = names.filter((n) => n !== py.HEALTH_FUNCTION);
  const broken = [];
  for (const name of own) {
    const r = await py.runFunction({ root, name, loadOnly: true, env }).catch((err) => ({ loaded: false, error: err.message }));
    if (!r.loaded) broken.push(`${name}: ${r.error}`);
  }
  checks.push({
    id: "functions",
    ok: own.length > 0 && !broken.length,
    detail: !own.length ? `there is no Python function in ${py.FUNCTIONS_DIR}/` : broken.length ? broken.join("; ") : `${own.length} function(s) load: ${own.join(", ")}`,
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

  const calls = loggedCalls(root);
  const picked = [];
  for (const c of calls) if (!picked.some((p) => p.name === c.name) && picked.length < MAX_RERUNS) picked.push(c);
  if (!picked.length) {
    checks.push({ id: "rerun", ok: false, detail: "no Python call was noted while the smoke test ran" });
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
    if (!sameShape(shapeOf(again), shapeOf(c.output))) problems.push(`${c.name} gave a reply of another shape when the platform ran it on the same input`);
  }
  checks.push({
    id: "rerun",
    ok: !problems.length,
    detail: problems.length ? problems.join("; ") : `the platform ran ${picked.map((c) => c.name).join(", ")} again and got the same shape of reply`,
  });
  return checks;
}
