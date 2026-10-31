// Platform file (Muse Muse platform services). Don't edit.
//
// Runs the product's Python functions (api/py/<name>.py) on this machine, the way Vercel runs them on a deployment:
// each file defines `class handler(BaseHTTPRequestHandler)`, gets the request and writes the reply. The build's server
// uses it through lib/platform/python.ts (MUSEMUSE_PYTHON=local), and verify's checks run the platform's own copy.
//
//   node scripts/py-local.mjs doctor              which Python runs here, and the functions it finds
//   node scripts/py-local.mjs install             installs requirements.txt (PyPI, wheels only) outside the product
//   node scripts/py-local.mjs call <name>         runs one function: JSON body on stdin, its reply on stdout
//   node scripts/py-local.mjs serve [--port N]    serves /api/py/<name> on 127.0.0.1 (3199 by default) for next dev
//
// Packages go in ~/.cache/musemuse/python/<python>-<hash of requirements.txt>, never in the product folder, so they are
// never deployed. Vercel installs requirements.txt itself.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FUNCTIONS_DIR = "api/py";
export const HEALTH_FUNCTION = "musemuse_health";
export const FUNCTION_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** What Vercel takes in a request body, and what a reply may be here. */
export const MAX_BODY_BYTES = Math.floor(4.5 * 1024 * 1024);
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Pinned the way Vercel and pip both read: `name==1.2.3`, with optional extras and a marker-free line. */
const PINNED = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[A-Za-z0-9,._-]+\])?==([A-Za-z0-9.+!_-]+)$/;
/** With one of these listed, Vercel runs the whole project as that framework's app instead of beside Next.js. */
export const WEB_FRAMEWORKS = ["flask", "fastapi", "django", "starlette", "quart", "sanic", "litestar", "bottle", "falcon", "tornado", "aiohttp", "uvicorn", "gunicorn"];

const normalize = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** Runs one handler class the way an HTTP server would, through a socket made of buffers. Standard library only. */
const DRIVER = String.raw`
import sys, os, io, json, base64, importlib.util, http.client
from http.server import BaseHTTPRequestHandler

root, file, packages, mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
real_stdout = sys.stdout
sys.stdout = sys.stderr  # print() in a function must not mix with the result
if packages:
    sys.path.insert(0, packages)
sys.path.insert(0, root)
os.chdir(root)

def out(result):
    real_stdout.write(json.dumps(result))
    real_stdout.flush()

try:
    spec = importlib.util.spec_from_file_location("musemuse_py_function", file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
except BaseException as err:
    out({"loaded": False, "error": "%s: %s" % (type(err).__name__, err)})
    sys.exit(0)

handler = getattr(module, "handler", None)
if not (isinstance(handler, type) and issubclass(handler, BaseHTTPRequestHandler)):
    out({"loaded": False, "error": "it has no class handler(BaseHTTPRequestHandler)"})
    sys.exit(0)
if mode == "load":
    out({"loaded": True})
    sys.exit(0)

method = os.environ.get("MUSEMUSE_PY_METHOD", "POST")
url_path = os.environ.get("MUSEMUSE_PY_PATH", "/")
body = sys.stdin.buffer.read()
head = "%s %s HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % (method, url_path, len(body))

class Connection:
    def __init__(self, data):
        self.reader = io.BytesIO(data)
        self.sent = bytearray()
    def makefile(self, mode, *args, **kwargs):
        return self.reader if "r" in mode else Writer(self)
    def sendall(self, data):
        self.sent += data
    def settimeout(self, value):
        pass
    def setsockopt(self, *args):
        pass
    def getsockname(self):
        return ("127.0.0.1", 0)
    def fileno(self):
        return -1
    def close(self):
        pass
    def shutdown(self, how):
        pass

class Writer(io.RawIOBase):
    def __init__(self, conn):
        self.conn = conn
    def writable(self):
        return True
    def write(self, data):
        self.conn.sendall(bytes(data))
        return len(data)

class Server:
    server_name = "localhost"
    server_port = 0

conn = Connection(head.encode("latin-1") + body)
try:
    handler(conn, ("127.0.0.1", 0), Server())
except BaseException as err:
    out({"loaded": True, "status": 500, "error": "%s: %s" % (type(err).__name__, err)})
    sys.exit(0)

class Reply:
    def __init__(self, data):
        self.data = data
    def makefile(self, *args, **kwargs):
        return io.BytesIO(self.data)

if not conn.sent:
    out({"loaded": True, "status": 500, "error": "the function wrote no reply"})
    sys.exit(0)
try:
    response = http.client.HTTPResponse(Reply(bytes(conn.sent)))
    response.begin()
    data = response.read()
    out({"loaded": True, "status": response.status, "contentType": response.getheader("Content-Type") or "", "body": base64.b64encode(data).decode("ascii")})
except BaseException as err:
    out({"loaded": True, "status": 500, "error": "its reply isn't HTTP: %s" % err})
`;

/** Bootstraps pip from its own wheel on PyPI when this Python has none, checking the wheel's sha256. */
const PIP_BOOTSTRAP = String.raw`
import sys, json, hashlib, urllib.request
dest = sys.argv[1]
with urllib.request.urlopen("https://pypi.org/pypi/pip/json", timeout=30) as r:
    meta = json.load(r)
wheel = next(u for u in meta["urls"] if u["packagetype"] == "bdist_wheel" and u["filename"].endswith("py3-none-any.whl"))
with urllib.request.urlopen(wheel["url"], timeout=60) as r:
    data = r.read()
if hashlib.sha256(data).hexdigest() != wheel["digests"]["sha256"]:
    sys.exit("the pip wheel from PyPI didn't match its sha256")
open(dest, "wb").write(data)
print(wheel["filename"])
`;

export class PythonRunError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * The Python that runs here: MUSEMUSE_PYTHON_BIN, else the one .python-version names (what Vercel runs), else 3.14,
 * 3.13, 3.12, else python3. Null when none.
 */
export function findPython({ env = process.env, root = null } = {}) {
  let pinned = null;
  try {
    const v = root ? readFileSync(path.join(root, ".python-version"), "utf8").trim() : "";
    if (/^3\.\d{1,2}$/.test(v)) pinned = `python${v}`;
  } catch {
    // No pin: the newest one here.
  }
  const tries = env.MUSEMUSE_PYTHON_BIN ? [env.MUSEMUSE_PYTHON_BIN] : [...(pinned ? [pinned] : []), "python3.14", "python3.13", "python3.12", "python3"];
  for (const bin of tries) {
    const res = spawnSync(bin, ["-I", "-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8", timeout: 10_000 });
    const version = res.status === 0 ? res.stdout.trim() : "";
    const [major, minor] = version.split(".").map(Number);
    if (major === 3 && minor >= 9) return { bin, version, minor: `${major}.${minor}` };
  }
  return null;
}

/** The product's functions, by name, from api/py/*.py. Files whose names aren't plain are left out. */
export function listFunctions(root) {
  const dir = path.join(root, FUNCTIONS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".py"))
    .map((e) => e.name.slice(0, -3))
    .filter((n) => FUNCTION_NAME.test(n))
    .sort();
}

/**
 * requirements.txt read the way the checks need: every line pinned with ==, nothing but PyPI names, and no web
 * framework. A missing file is the standard library only.
 */
export function readRequirements(root) {
  const file = path.join(root, "requirements.txt");
  if (!existsSync(file)) return { ok: true, packages: [], problems: [], text: "" };
  const text = readFileSync(file, "utf8");
  const packages = [];
  const problems = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(PINNED);
    if (!m) {
      problems.push(`"${line.slice(0, 60)}" isn't pinned as name==version`);
      continue;
    }
    if (WEB_FRAMEWORKS.includes(normalize(m[1]))) problems.push(`${m[1]} is a web framework, which makes Vercel run the whole project as Python`);
    packages.push({ name: m[1], version: m[3], line });
  }
  return { ok: problems.length === 0, packages, problems, text };
}

function cacheRoot(env = process.env) {
  return env.MUSEMUSE_PY_CACHE || path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "musemuse", "python");
}

/** Where this requirements.txt is installed for this Python. Null when there is nothing to install. */
export function packagesDir(root, python, env = process.env) {
  const req = readRequirements(root);
  if (!req.packages.length) return null;
  const hash = createHash("sha256").update(req.packages.map((p) => p.line).join("\n")).digest("hex").slice(0, 12);
  return path.join(cacheRoot(env), `${python.minor}-${hash}`);
}

function caBundle(env) {
  for (const file of [env.PIP_CERT, env.REQUESTS_CA_BUNDLE, env.SSL_CERT_FILE, "/etc/ssl/certs/ca-certificates.crt"]) if (file && existsSync(file)) return file;
  return null;
}

/**
 * Installs requirements.txt for this Python, wheels only, from PyPI only, outside the product folder. Bootstraps pip
 * from its PyPI wheel when this Python has none. Does nothing when it is already installed or there are no packages.
 */
export function install(root, { env = process.env, force = false, log = () => {} } = {}) {
  const python = findPython({ env, root });
  if (!python) throw new PythonRunError("no_python", "There is no Python 3 on this machine (python3.12, python3.13, python3.14 or python3).");
  const req = readRequirements(root);
  if (!req.ok) throw new PythonRunError("bad_requirements", `requirements.txt: ${req.problems.join("; ")}`);
  const dir = packagesDir(root, python, env);
  if (!dir) return { python, dir: null, installed: 0 };
  const done = path.join(dir, ".musemuse-done");
  if (!force && existsSync(done)) return { python, dir, installed: req.packages.length, cached: true };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let pip = [python.bin, "-m", "pip"];
  if (spawnSync(python.bin, ["-I", "-m", "pip", "--version"], { encoding: "utf8" }).status !== 0) {
    const wheel = path.join(cacheRoot(env), "_pip", "pip.whl");
    if (!existsSync(wheel)) {
      mkdirSync(path.dirname(wheel), { recursive: true });
      log("pip isn't installed for this Python, so it comes from its own wheel on PyPI");
      const boot = spawnSync(python.bin, ["-I", "-c", PIP_BOOTSTRAP, wheel], { encoding: "utf8", timeout: 120_000, env: { ...env } });
      if (boot.status !== 0) throw new PythonRunError("no_pip", `pip couldn't be fetched from PyPI: ${(boot.stderr || boot.stdout).trim().split("\n").at(-1)}`);
    }
    pip = [python.bin, path.join(wheel, "pip")];
  }
  const cert = caBundle(env);
  const args = [
    ...pip.slice(1),
    "install",
    "--isolated",
    "--disable-pip-version-check",
    "--no-input",
    "--index-url",
    "https://pypi.org/simple",
    "--only-binary=:all:",
    "--target",
    dir,
    ...(cert ? ["--cert", cert] : []),
    "-r",
    path.join(root, "requirements.txt"),
  ];
  log(`installing ${req.packages.map((p) => p.line).join(", ")} for Python ${python.version}`);
  const res = spawnSync(pip[0], args, { encoding: "utf8", timeout: 600_000, env: { ...env, PYTHONDONTWRITEBYTECODE: "1" } });
  if (res.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    const why = (res.stderr || res.stdout).trim().split("\n").filter((l) => /error|could not|no matching/i.test(l)).slice(-2).join(" ") || "pip failed";
    throw new PythonRunError("install_failed", `The packages didn't install for Python ${python.version}: ${why.slice(0, 400)}`);
  }
  writeFileSync(done, `${req.packages.map((p) => p.line).join("\n")}\n`);
  return { python, dir, installed: req.packages.length, cached: false };
}

/**
 * Runs one function once. `body` is the request body (a Buffer or string). Resolves with {status, contentType, body} or
 * {status: 500, error}. Rejects with PythonRunError for a missing function, no Python, a timeout or a reply too big.
 */
export function runFunction({ root, name, body = "", method = "POST", query = "", timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env, loadOnly = false }) {
  return new Promise((resolve, reject) => {
    if (!FUNCTION_NAME.test(name)) return reject(new PythonRunError("unknown_function", `"${String(name).slice(0, 40)}" isn't a function name.`));
    const file = path.join(root, FUNCTIONS_DIR, `${name}.py`);
    if (!existsSync(file)) return reject(new PythonRunError("unknown_function", `There is no ${FUNCTIONS_DIR}/${name}.py.`));
    const input = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    if (input.length > MAX_BODY_BYTES) return reject(new PythonRunError("too_large", "The request is over 4.5 MB."));
    const python = findPython({ env, root });
    if (!python) return reject(new PythonRunError("no_python", "There is no Python 3 on this machine."));
    let dir = null;
    try {
      dir = packagesDir(root, python, env);
      if (dir && !existsSync(path.join(dir, ".musemuse-done"))) dir = install(root, { env }).dir;
    } catch (err) {
      return reject(err);
    }
    const child = spawn(python.bin, ["-I", "-B", "-c", DRIVER, root, file, dir ?? "", loadOnly ? "load" : "run"], {
      cwd: root,
      env: { PATH: env.PATH ?? "", HOME: env.HOME ?? os.homedir(), LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1", MUSEMUSE_PY_METHOD: method, MUSEMUSE_PY_PATH: `/${FUNCTIONS_DIR}/${name}${query ? `?${query}` : ""}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [];
    const errs = [];
    let size = 0;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new PythonRunError("timeout", `${name} took longer than ${Math.round(timeoutMs / 1000)} seconds.`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES * 1.4) {
        child.kill("SIGKILL");
        finish(() => reject(new PythonRunError("too_large", `${name}'s reply is over 4.5 MB.`)));
      } else out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errs.reduce((n, c) => n + c.length, 0) < 64 * 1024) errs.push(chunk);
    });
    child.on("error", (err) => finish(() => reject(new PythonRunError("no_python", `Python couldn't start: ${err.message}`))));
    child.on("close", () =>
      finish(() => {
        let result;
        try {
          result = JSON.parse(Buffer.concat(out).toString("utf8"));
        } catch {
          const tail = Buffer.concat(errs).toString("utf8").trim().split("\n").slice(-3).join(" ");
          return resolve({ loaded: false, status: 500, error: `${name} stopped without a reply${tail ? `: ${tail.slice(0, 300)}` : ""}` });
        }
        if (result.body !== undefined) result.body = Buffer.from(result.body, "base64");
        if (result.error && !result.loaded) result.status = 500;
        resolve(result);
      }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Serves /api/py/<name> on 127.0.0.1, one Python run per request, for `next dev` with MUSEMUSE_PYTHON_URL set. */
export function serve(root, { port = 3199, env = process.env } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const m = url.pathname.match(/^\/api\/py\/([a-z][a-z0-9_]{0,39})\/?$/);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (!m) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not a Python function" }));
      return;
    }
    try {
      const r = await runFunction({ root, name: m[1], body: Buffer.concat(chunks), method: req.method ?? "POST", query: url.search.slice(1), env });
      if (r.error) {
        res.writeHead(r.status || 500, { "content-type": "application/json" }).end(JSON.stringify({ error: r.error }));
        return;
      }
      res.writeHead(r.status, { "content-type": r.contentType || "application/octet-stream" }).end(r.body);
    } catch (err) {
      res.writeHead(err.code === "unknown_function" ? 404 : 502, { "content-type": "application/json" }).end(JSON.stringify({ error: err.message }));
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks);
}

if (isMain()) {
  const [command, name] = process.argv.slice(2);
  const arg = (flag) => {
    const at = process.argv.indexOf(flag);
    return at > 0 ? process.argv[at + 1] : undefined;
  };
  const root = path.resolve(arg("--root") ?? path.resolve(HERE, ".."));
  const fail = (message, code = 1) => {
    process.stderr.write(`${message}\n`);
    process.exit(code);
  };
  try {
    if (command === "doctor") {
      const python = findPython({ root });
      const req = readRequirements(root);
      process.stdout.write(
        `${JSON.stringify({ python: python ? python.version : null, bin: python?.bin ?? null, functions: listFunctions(root), packages: req.packages.map((p) => p.line), problems: req.problems }, null, 2)}\n`,
      );
    } else if (command === "install") {
      const r = install(root, { force: process.argv.includes("--force"), log: (l) => process.stderr.write(`${l}\n`) });
      process.stdout.write(r.dir ? `Installed ${r.installed} package(s) for Python ${r.python.version}${r.cached ? " (already there)" : ""}.\n` : "No packages to install: requirements.txt lists none.\n");
    } else if (command === "call") {
      if (!name) fail("Usage: node scripts/py-local.mjs call <name> < input.json", 2);
      const r = await runFunction({ root, name, body: await readStdin(), method: arg("--method") ?? "POST" });
      if (process.argv.includes("--json-result")) {
        process.stdout.write(`${JSON.stringify({ status: r.status, contentType: r.contentType ?? "", ...(r.error ? { error: r.error } : { body: r.body.toString("base64") }) })}\n`);
      } else if (r.error) {
        fail(`${name}: ${r.error}`);
      } else {
        process.stdout.write(r.body);
        if (r.status >= 400) fail(`\n${name} answered HTTP ${r.status}.`);
      }
    } else if (command === "serve") {
      const port = Number(arg("--port") ?? 3199);
      await serve(root, { port });
      process.stderr.write(`Python functions on http://127.0.0.1:${port}/api/py/<name>. Set MUSEMUSE_PYTHON_URL=http://127.0.0.1:${port} for next dev.\n`);
    } else {
      fail("Usage: node scripts/py-local.mjs doctor | install | call <name> | serve [--port N]", 2);
    }
  } catch (err) {
    if (process.argv.includes("--json-result") && command === "call") {
      process.stdout.write(`${JSON.stringify({ status: err.code === "unknown_function" ? 404 : err.code === "too_large" ? 413 : err.code === "timeout" ? 504 : 502, error: err.message })}\n`);
    } else fail(err.message);
  }
}
