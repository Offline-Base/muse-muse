import { globFiles, grepFiles, listDir, normalizePath, readNumbered, treeDiff, type Vfs } from "@/components/docs/playgrounds/cookbook-use-cases/lib/vfs";

/**
 * cookbook/sandboxed-execution in the browser. The recipe's scaffold builds a throwaway container with a SWE-bench
 * project at /testbed, gives the model exactly two tools (run, write_file) that act only inside it, loops until the
 * model stops, then re-runs the failing tests itself, saves pred.patch and deletes the container. Here the
 * container is a virtual tree, `node` runs files for real in a sandboxed iframe (sandbox-run.ts), and the shell
 * understands the handful of commands a fix needs. Task 1 is a JavaScript port of the recipe's own SWE-bench task
 * (psf/requests 6028: proxy credentials stripped from the URL).
 */

export interface SandboxTask {
  id: string;
  label: string;
  repo: string;
  problem: string;
  failToPass: string[];
  passToPass: string[];
  files: Record<string, string>;
  /** `git log --oneline`, newest first. */
  history: Array<{ hash: string; subject: string; diff?: string }>;
  container: string;
}

const HARNESS = `// A tiny pytest-style runner: prints one line per test and a summary, exits 1 on any failure.
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}
function report(file) {
  const only = process.argv.slice(2);
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const id = file + "::" + r.name;
    if (only.length && !only.some((o) => id.includes(o))) continue;
    if (r.ok) {
      passed++;
      console.log(id + " PASSED");
    } else {
      failed++;
      console.log(id + " FAILED");
      console.log("    " + String(r.err && r.err.message ? r.err.message : r.err));
    }
  }
  console.log((failed ? failed + " failed, " : "") + passed + " passed");
  if (failed) process.exitCode = 1;
}
module.exports = { test, report };
`;

const REQUESTS_UTILS = `// Port of requests.utils for this sandbox. parseUrl mirrors urllib3's parse_url.
function parseUrl(url) {
  const m = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):)?(?:\\/\\/([^/?#]*))?([^?#]*)(?:\\?([^#]*))?(?:#(.*))?$/.exec(url);
  let scheme = m[1] || null;
  let netloc = m[2] === undefined ? null : m[2];
  let path = m[3] || "";
  // "example.com:80" parses as a scheme of "example.com"; treat a bare host:port as the netloc.
  if (scheme && netloc === null && /^\\d+$/.test(path)) {
    netloc = scheme + ":" + path;
    scheme = null;
    path = "";
  }
  // "example.com/path" has no "//": its first segment is the host.
  if (!scheme && netloc === null && path && !path.startsWith("/")) {
    const slash = path.indexOf("/");
    netloc = slash < 0 ? path : path.slice(0, slash);
    path = slash < 0 ? "" : path.slice(slash);
  }
  let auth = null;
  let host = netloc;
  let port = null;
  if (netloc) {
    const at = netloc.lastIndexOf("@");
    if (at >= 0) {
      auth = netloc.slice(0, at);
      host = netloc.slice(at + 1);
    }
    const colon = host.lastIndexOf(":");
    if (colon >= 0 && /^\\d+$/.test(host.slice(colon + 1))) {
      port = host.slice(colon + 1);
      host = host.slice(0, colon);
    }
  }
  return { scheme, auth, host, port, path, query: m[4] === undefined ? null : m[4], fragment: m[5] === undefined ? null : m[5] };
}

function urlunparse(scheme, netloc, path, query, fragment) {
  let out = scheme ? scheme + ":" : "";
  if (netloc !== null && netloc !== undefined) out += "//" + netloc;
  out += path || "";
  if (query) out += "?" + query;
  if (fragment) out += "#" + fragment;
  return out;
}

/**
 * Given a URL that may or may not have a scheme, prepend the given scheme.
 * Does not replace a present scheme with the one provided as an argument.
 */
function prependSchemeIfNeeded(url, newScheme) {
  const parsed = parseUrl(url);
  let { scheme, host, port, path, query, fragment } = parsed;

  // A defect in urlparse determines that there's no netloc present in some
  // urls. We previously assumed parsing was overly cautious, and swapped the
  // netloc and path. Due to a lack of tests on the original defect, this is
  // maintained with parse_url for backwards compatibility.
  let netloc = host;
  if (port) netloc += ":" + port;
  if (!path) path = "";
  if (!scheme) scheme = newScheme;

  return urlunparse(scheme, netloc, path, query, fragment);
}

module.exports = { parseUrl, prependSchemeIfNeeded, urlunparse };
`;

const REQUESTS_TESTS = `const assert = require("assert");
const { test, report } = require("./harness");
const { prependSchemeIfNeeded } = require("../src/utils");

const cases = [
  ["example.com/path", "http://example.com/path"],
  ["//example.com/path", "http://example.com/path"],
  ["example.com:80", "http://example.com:80"],
  ["http://user:pass@example.com/path?query", "http://user:pass@example.com/path?query"],
  ["http://user@example.com/path?query", "http://user@example.com/path?query"],
];

for (const [url, expected] of cases) {
  test("test_prepend_scheme_if_needed[" + url + "-" + expected + "]", () => {
    assert.strictEqual(prependSchemeIfNeeded(url, "http"), expected);
  });
}

report("tests/test_utils.js");
`;

const SLUG_UTILS = `// Turns titles into URL slugs for the blog.
function slugify(title) {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .replace(/[^a-z]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

module.exports = { slugify };
`;

const SLUG_TESTS = `const assert = require("assert");
const { test, report } = require("./harness");
const { slugify } = require("../src/slug");

test("test_slugify_basic", () => assert.strictEqual(slugify("Hello, World!"), "hello-world"));
test("test_slugify_accents", () => assert.strictEqual(slugify("Crème brûlée"), "creme-brulee"));
test("test_slugify_keeps_digits", () => assert.strictEqual(slugify("Top 10 tips for 2026"), "top-10-tips-for-2026"));
test("test_slugify_version", () => assert.strictEqual(slugify("Release v2.1 notes"), "release-v2-1-notes"));

report("tests/test_slug.js");
`;

export const SANDBOX_TASKS: readonly SandboxTask[] = [
  {
    id: "requests-6028",
    label: "psf/requests 6028 (the recipe's task)",
    repo: "psf/requests",
    container: "muse-sandbox-psf-requests-6028",
    problem: "Proxy authentication bug: when using a proxy on Python 3.8.12 I get a 407 error; I should get 200. (requests 2.27.0, urllib3 1.26.7)",
    failToPass: [
      "tests/test_utils.js::test_prepend_scheme_if_needed[http://user:pass@example.com/path?query-http://user:pass@example.com/path?query]",
      "tests/test_utils.js::test_prepend_scheme_if_needed[http://user@example.com/path?query-http://user@example.com/path?query]",
    ],
    passToPass: [
      "tests/test_utils.js::test_prepend_scheme_if_needed[example.com/path-http://example.com/path]",
      "tests/test_utils.js::test_prepend_scheme_if_needed[//example.com/path-http://example.com/path]",
      "tests/test_utils.js::test_prepend_scheme_if_needed[example.com:80-http://example.com:80]",
    ],
    files: {
      "README.md": "# requests (JavaScript port for the sandbox demo)\n\nRun the tests with `node tests/test_utils.js` (or `npm test`). Pass a test id to run just that one.\n",
      "package.json": '{\n  "name": "requests-port",\n  "private": true,\n  "scripts": { "test": "node tests/test_utils.js" }\n}\n',
      "src/utils.js": REQUESTS_UTILS,
      "tests/harness.js": HARNESS,
      "tests/test_utils.js": REQUESTS_TESTS,
    },
    history: [
      { hash: "0192aac2", subject: "Merge pull request #6017 from psf/proxy-auth-docs" },
      {
        hash: "ef59aa022",
        subject: "Use parse_url in prepend_scheme_if_needed to handle urls without a scheme",
        diff: [
          "--- a/src/utils.js",
          "+++ b/src/utils.js",
          "@@",
          "-  let { scheme, netloc, path, query, fragment } = urlparse(url, newScheme);",
          "-  if (!netloc) [netloc, path] = [path, netloc];",
          "+  const parsed = parseUrl(url);",
          "+  let { scheme, host, port, path, query, fragment } = parsed;",
          "+  let netloc = host;",
          "+  if (port) netloc += \":\" + port;",
        ].join("\n"),
      },
      { hash: "9c1f0e3d", subject: "Add a test for urls without a scheme" },
      { hash: "51c5a8b7", subject: "Release 2.26.0" },
    ],
  },
  {
    id: "slugify",
    label: "A slug bug: digits disappear",
    repo: "blog-tools",
    container: "muse-sandbox-blog-tools-112",
    problem: 'Post URLs lose their numbers: "Top 10 tips for 2026" becomes /top-tips-for instead of /top-10-tips-for-2026.',
    failToPass: ["tests/test_slug.js::test_slugify_keeps_digits", "tests/test_slug.js::test_slugify_version"],
    passToPass: ["tests/test_slug.js::test_slugify_basic", "tests/test_slug.js::test_slugify_accents"],
    files: {
      "README.md": "# blog-tools\n\nRun the tests with `node tests/test_slug.js` (or `npm test`).\n",
      "package.json": '{\n  "name": "blog-tools",\n  "private": true,\n  "scripts": { "test": "node tests/test_slug.js" }\n}\n',
      "src/slug.js": SLUG_UTILS,
      "tests/harness.js": HARNESS,
      "tests/test_slug.js": SLUG_TESTS,
    },
    history: [
      { hash: "a41d7c0e", subject: "Strip accents in slugify" },
      { hash: "77be0d12", subject: "Collapse punctuation runs into one dash" },
    ],
  },
];

export function taskById(id: string): SandboxTask {
  return SANDBOX_TASKS.find((t) => t.id === id) ?? SANDBOX_TASKS[0];
}

/** The scaffold's system prompt: the rules, not the steps. */
export const SANDBOX_SYSTEM = `You are working in a sandbox: a throwaway container with the project checked out at /testbed. Nothing you run touches the user's machine.
You have two tools and nothing else: run (run a shell command in the container) and write_file (write a whole file in the container).
Reproduce the bug first, then fix the source, then verify with the project's tests. Do not edit the tests. Keep the fix minimal.
When the failing tests pass, stop calling tools and explain in plain English what was wrong and how you fixed it.`;

/** The instruction built from task.json, as the script builds it. */
export function taskInstruction(t: SandboxTask): string {
  return [
    `Fix this bug in the \`${t.repo}\` repository.`,
    "",
    "--- issue ---",
    t.problem,
    "",
    "--- failing tests (already in the repo; make them pass, do not edit them) ---",
    ...t.failToPass.map((f) => `  - ${f}`),
    "",
    "Reproduce the failure, fix the source, and verify the tests pass, all inside /testbed.",
  ].join("\n");
}

export const RUN_TOOL = {
  name: "run",
  description: "Run a shell command in the sandbox container, in /testbed. Returns stdout, stderr and the exit code.",
  parameters: { type: "object", properties: { command: { type: "string", description: "The command line." } }, required: ["command"], additionalProperties: false },
};

export const WRITE_TOOL = {
  name: "write_file",
  description: "Write a file in the sandbox container (relative to /testbed), replacing it whole.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string", description: "The complete new file." } },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

/** Splits a command line on &&, ; and newlines outside quotes. */
export function splitCommands(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === ";" || ch === "\n" || (ch === "&" && line[i + 1] === "&")) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      if (ch === "&") i++;
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Shell words, honoring single and double quotes. */
export function shellWords(cmd: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? (m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]));
  return out;
}

/** Expands * in arguments against the virtual tree, as a shell would; a pattern with no match stays as typed. */
export function expandGlobs(words: string[], files: Vfs): string[] {
  return words.flatMap((w, i) => {
    if (i === 0 || !w.includes("*")) return [w];
    const hits = globFiles(files, normalizePath(w));
    return hits.length ? hits : [w];
  });
}

export type ShellPlan = { kind: "text"; out: string; code: number } | { kind: "node"; entry: string; args: string[] };

const SUPPORTED = "ls, cat, head, tail, sed -n, grep, find, wc -l, pwd, echo, git log, git show, git diff, git status, node, npm test";

/** What one command does: text the shell can answer itself, or a node run for the sandbox. Pipes are cut at "|". */
export function planCommand(cmd: string, files: Vfs, base: Vfs, task: SandboxTask): ShellPlan {
  const words = expandGlobs(shellWords(cmd.split(/\s\|\s/)[0].replace(/\s*\d?>\s*\/dev\/null|\s*2>&1/g, " ").trim()), files);
  const [name, ...args] = words;
  const text = (out: string, code = 0): ShellPlan => ({ kind: "text", out, code });
  const file = (p: string) => files[normalizePath(p)];
  switch (name) {
    case undefined:
      return text("");
    case "cd":
      return text("");
    case "pwd":
      return text("/testbed");
    case "echo":
      return text(args.join(" "));
    case "ls": {
      const targets = args.filter((a) => !a.startsWith("-"));
      const recursive = args.some((a) => /^-\w*R/.test(a));
      const one = (t: string) => {
        const p = normalizePath(t);
        if (files[p] !== undefined) return p;
        const entries = recursive ? Object.keys(files).filter((f) => !p || f.startsWith(`${p}/`)).sort() : listDir(files, p);
        return entries.length ? entries.join("\n") : null;
      };
      const list = targets.length ? targets : [""];
      const outs = list.map((t) => ({ t, out: one(t) }));
      const missing = outs.filter((o) => o.out === null);
      const body = outs
        .filter((o) => o.out !== null)
        .map((o) => (list.length > 1 ? `${o.t}:\n${o.out}` : o.out))
        .join("\n\n");
      const errs = missing.map((m) => `ls: cannot access '${m.t}': No such file or directory`).join("\n");
      return text([body, errs].filter(Boolean).join("\n"), missing.length ? 2 : 0);
    }
    case "cat": {
      const outs = args.filter((a) => !a.startsWith("-")).map((p) => file(p) ?? `cat: ${p}: No such file or directory`);
      return text(outs.join("\n"), outs.some((o) => o.startsWith("cat: ")) ? 1 : 0);
    }
    case "head":
    case "tail": {
      const nArg = args.find((a) => /^-n?\d+$/.test(a)) ?? (args.includes("-n") ? `-${args[args.indexOf("-n") + 1]}` : "-10");
      const n = Number(nArg.replace(/^-n?/, "")) || 10;
      const p = args.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a))[0];
      const content = p ? file(p) : undefined;
      if (content === undefined) return text(`${name}: cannot open '${p ?? ""}' for reading: No such file or directory`, 1);
      const lines = content.split("\n");
      return text((name === "head" ? lines.slice(0, n) : lines.slice(-n)).join("\n"));
    }
    case "sed": {
      const range = args.find((a) => /^\d+(,\d+)?p$/.test(a));
      const p = args[args.length - 1];
      if (!args.includes("-n") || !range || file(p) === undefined) return text("sed: only `sed -n 'A,Bp' file` works in this sandbox", 1);
      const [a, b] = range.slice(0, -1).split(",").map(Number);
      return text(file(p)!.split("\n").slice(a - 1, b ?? a).join("\n"));
    }
    case "wc": {
      const p = args.filter((a) => !a.startsWith("-"))[0];
      const content = p ? file(p) : undefined;
      return content === undefined ? text(`wc: ${p}: No such file or directory`, 1) : text(`${content.split("\n").length} ${p}`);
    }
    case "grep": {
      const flags = args.filter((a) => a.startsWith("-")).join("");
      const rest = args.filter((a) => !a.startsWith("-"));
      const pattern = rest[0] ?? "";
      const where = rest[1] ? normalizePath(rest[1]) : "";
      const hits = grepFiles(files, pattern, { ignoreCase: flags.includes("i"), max: 80 }).filter((h) => !where || h.startsWith(where));
      return hits.length ? text(hits.join("\n")) : text("", 1);
    }
    case "find": {
      const nameArg = args.indexOf("-name") >= 0 ? args[args.indexOf("-name") + 1] : "*";
      return text(globFiles(files, `**/${nameArg}`).map((p) => `./${p}`).join("\n"));
    }
    case "git": {
      const sub = args[0];
      if (sub === "log") return text(task.history.map((h) => (args.includes("--oneline") ? `${h.hash} ${h.subject}` : `commit ${h.hash}\n\n    ${h.subject}\n`)).join("\n"));
      if (sub === "show") {
        const h = task.history.find((x) => args[1] && (x.hash.startsWith(args[1]) || args[1].startsWith(x.hash)));
        return h ? text(`commit ${h.hash}\n\n    ${h.subject}\n\n${h.diff ?? "(no source changes)"}`) : text(`fatal: bad object ${args[1] ?? ""}`, 128);
      }
      if (sub === "diff") return text(treeDiff(base, files));
      if (sub === "status") {
        const changed = Object.keys({ ...base, ...files }).filter((p) => base[p] !== files[p]);
        return text(changed.length ? `Changes not staged for commit:\n${changed.map((p) => `\tmodified:   ${p}`).join("\n")}` : "nothing to commit, working tree clean");
      }
      return text(`git: '${sub}' isn't available in this sandbox`, 1);
    }
    case "node": {
      const entry = args.find((a) => !a.startsWith("-"));
      if (!entry) return text("node: no file given (the REPL isn't available here)", 9);
      if (file(entry) === undefined) return text(`node:internal/modules/cjs/loader\nError: Cannot find module '/testbed/${normalizePath(entry)}'`, 1);
      return { kind: "node", entry: normalizePath(entry), args: args.slice(args.indexOf(entry) + 1) };
    }
    case "npm":
    case "npx": {
      if (args[0] === "test" || args[0] === "run") {
        const pkg = file("package.json");
        const script = pkg ? (/"test":\s*"node ([^"\s]+)/.exec(pkg)?.[1] ?? null) : null;
        if (!script) return text("npm ERR! Missing script: \"test\"", 1);
        return { kind: "node", entry: normalizePath(script), args: args.slice(args[0] === "run" ? 2 : 1).filter((a) => a !== "--") };
      }
      return text(`${name} ${args[0] ?? ""}: only npm test works in this sandbox (no network)`, 1);
    }
    case "python":
    case "python3":
    case "pytest":
      return text(`bash: ${name}: not installed in this sandbox; this port of the project runs on node (see README.md)`, 127);
    default:
      return text(`bash: ${name}: command not found. This sandbox supports: ${SUPPORTED}.`, 127);
  }
}

/** Test ids that passed in a harness run's output. */
export function passedTests(stdout: string): Set<string> {
  return new Set(
    stdout
      .split("\n")
      .filter((l) => l.endsWith(" PASSED"))
      .map((l) => l.slice(0, -" PASSED".length)),
  );
}

/** Whether the model touched a test file, which the scaffold forbids. */
export function testsEdited(base: Vfs, files: Vfs): string[] {
  return Object.keys({ ...base, ...files }).filter((p) => p.startsWith("tests/") && base[p] !== files[p]);
}

/** A readable view of a tool call's command for the terminal transcript. */
export function promptLine(cmd: string): string {
  return `root@sandbox:/testbed$ ${cmd}`;
}

export { readNumbered };
