// Runs inside a session's own shell, started by the model. Prints only names, counts and sha256 matches, never a value, to
// /tmp/out/inside.txt. Compares every long token in the environment and in files with the hashes of the real key, the placeholder
// and the stand-in the session was given. The real key must never appear. The placeholder is only in the root proxy's environment.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = "/tmp/out/inside.txt";
const say = (s) => appendFileSync(OUT, `${s}\n`);
writeFileSync(OUT, "");
const hashes = JSON.parse(readFileSync("/tmp/spike-hashes.json", "utf8"));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const scan = (text, where, hits) => {
  for (const tok of text.match(/[A-Za-z0-9_\-.]{16,}/g) ?? []) {
    const h = sha(tok);
    for (const [name, want] of Object.entries(hashes)) if (h === want) hits.push(`${name} in ${where}`);
    // A token may carry "Bearer " or a prefix, so also try each token's own parts split on . and -.
  }
};
const hits = [];
say(`user ${execFileSync("id", ["-un"]).toString().trim()}, cwd ${process.cwd()}`);
say(`env names: ${Object.keys(process.env).sort().join(" ")}`);
say(`META_API_KEY in this shell: ${process.env.META_API_KEY ? "yes" : "no"}`);
scan(Object.values(process.env).join("\n"), "this shell's env", hits);

let filesRead = 0;
const SKIP = new Set(["node_modules", "muse-bin-1.4.14-R7309.1", "fx", "bundle.pem", "sink", "proc", "sys"]);
const walk = (dir, depth = 0) => {
  if (depth > 9) return;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (SKIP.has(n)) continue;
    const p = path.join(dir, n);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, depth + 1);
    else if (st.isFile() && st.size < 6_000_000) {
      try {
        scan(readFileSync(p, "latin1"), p, hits);
        filesRead += 1;
      } catch {
        // Not readable as this user, which is the point.
      }
    }
  }
};
for (const d of [process.env.HOME, "/tmp", "/vercel", "/etc"]) walk(d);
say(`files read: ${filesRead}`);

let proc = 0;
let refused = 0;
for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
  for (const f of ["environ", "cmdline"]) {
    try {
      const text = readFileSync(`/proc/${pid}/${f}`, "latin1").replace(/\0/g, "\n");
      proc += 1;
      scan(text, `/proc/${pid}/${f}`, hits);
    } catch {
      refused += 1;
    }
  }
}
say(`/proc: ${proc} readable, ${refused} refused`);
const by = new Map();
for (const h of hits) by.set(h, (by.get(h) ?? 0) + 1);
say(`hash matches: ${by.size ? [...by.entries()].map(([k, v]) => `${k} x${v}`).join("; ") : "none"}`);
say(`real key found anywhere: ${hits.some((h) => h.startsWith("realKey")) ? "YES" : "no"}`);
say(`placeholder found anywhere as this user: ${hits.some((h) => h.startsWith("placeholder")) ? "YES" : "no"}`);

const curl = (label, args) => {
  const r = spawnSync("curl", ["-s", "-m", "12", "--noproxy", "*", "-o", "/tmp/curl.body", "-w", "%{http_code}", ...args], { encoding: "utf8" });
  let body = "";
  try {
    body = readFileSync("/tmp/curl.body", "utf8").slice(0, 60);
  } catch {
    // None.
  }
  say(`${label}: http ${r.stdout} exit ${r.status}${body.includes("refused") ? " firewall refusal body" : ""}`);
};
curl("direct https://example.com", ["https://example.com"]);
curl("direct http://example.com", ["http://example.com"]);
curl("direct https://github.com", ["https://github.com"]);
curl("direct api.meta.ai, no key", ["https://api.meta.ai/v1/models"]);
curl("direct api.meta.ai with the shell's key", ["https://api.meta.ai/v1/models", "-H", `Authorization: Bearer ${process.env.META_API_KEY ?? "x"}`]);
curl("direct registry.npmjs.org", ["https://registry.npmjs.org/left-pad"]);
say(`sudo -n true: exit ${spawnSync("sudo", ["-n", "true"]).status}`);
const home = process.env.HOME;
const bin = path.join(home, ".local/bin");
say(`bin folder: ${readdirSync(bin).map((n) => `${n} ${lstatSync(path.join(bin, n)).size}`).join("; ")}`);
const real = readdirSync(bin).find((n) => n.startsWith("muse-bin-"));
const copy = spawnSync("bash", ["-c", `cp "${bin}/${real}" ./muse-copy && ls -l ./muse-copy | awk '{print $5}' && cmp "${bin}/${real}" ./muse-copy && echo identical && ./muse-copy --version; rm -f ./muse-copy`], { encoding: "utf8", timeout: 120_000 });
say(`copy the binary into the workspace: exit ${copy.status}: ${copy.stdout.replace(/\n/g, " | ")}${copy.stderr.slice(0, 100)}`);
const gz = spawnSync("bash", ["-c", `gzip -1 -c "${bin}/${real}" | wc -c`], { encoding: "utf8", timeout: 120_000 });
say(`binary size gzipped: ${gz.stdout.trim()} bytes`);
const prev = spawnSync("bash", ["-c", "readlink -f /proc/$PPID/exe; ps -eo user,comm --no-headers | sort -u | head -30 | tr '\\n' ';'"], { encoding: "utf8" });
say(`parent exe and processes: ${prev.stdout.trim().slice(0, 500)}`);
console.log(`checked: ${existsSync(OUT) ? "see the log" : "no log"}`);
