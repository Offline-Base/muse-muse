// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it through scripts/caps-check.mjs.
//
// The fixed checks for outside services:
//   manifest        musemuse.json's connect block names the brief's APIs, keys and sends (the brief's list comes from
//                   the gateway's record of this build, which product code can't write)
//   fetch-shown     the gateway answered this verify's public API calls, and the page showed what the server got
//   key-saved       the owner saved a made-up key through the product's key settings, and the gateway kept it
//   no-key-leak     none of the build's test keys shows in a kept page, the built output or the source
//   send-confirmed  the gateway recorded a confirmed sample send, and the page said "Sent (sample)"
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const sorted = (list) => [...new Set(list)].sort();

/** The brief's picks, from the gateway's `brief:api:<id>`, `brief:key:<service>` and `brief:send:<channel>` counts. */
export function briefPicks(proof) {
  if (!proof) return null;
  const of = (kind) => sorted(Object.keys(proof).filter((k) => k.startsWith(`brief:${kind}:`)).map((k) => k.slice(`brief:${kind}:`.length)));
  return { publicApis: of("api"), keys: of("key"), sends: of("send") };
}

export function manifestPicks(root) {
  const file = path.join(root, "musemuse.json");
  const block = existsSync(file) ? readJson(file)?.connect : null;
  if (!block || typeof block !== "object") return null;
  const ids = (v) => sorted(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return { publicApis: ids(block.publicApis), keys: ids(block.keys), sends: ids(block.sends) };
}

const CANARY = /mmtest_[A-Za-z0-9]{24}/g;
const SCAN_DIRS = [".next/static", ".next/server", "public", "app", "components", "lib", "test-results/caps/connect-pages"];
const SKIP = new Set(["node_modules", ".git", "cache"]);
const MAX_FILE = 5 * 1024 * 1024;
const MAX_FILES = 8000;

/** Every test key, by its hash, found in the product's kept pages, built output and source. */
export function findLeaks(root, hashes) {
  const found = [];
  let files = 0;
  const walk = (dir) => {
    if (files > MAX_FILES || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && ++files <= MAX_FILES && statSync(p).size <= MAX_FILE) {
        const text = readFileSync(p, "latin1");
        for (const m of text.match(CANARY) ?? []) {
          if (hashes.has(createHash("sha256").update(m).digest("hex").slice(0, 16))) found.push(path.relative(root, p));
        }
      }
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(root, d));
  return [...new Set(found)];
}

const recorded = (record, id) => (Array.isArray(record?.checks) ? record.checks.find((c) => c?.id === id) : undefined);
const say = (p) => `APIs ${p.publicApis.join(", ") || "none"}; keys ${p.keys.join(", ") || "none"}; sends ${p.sends.join(", ") || "none"}`;

export async function check({ record, proof, root }) {
  const out = [];
  const brief = briefPicks(proof);
  const manifest = manifestPicks(root);
  if (!brief) out.push({ id: "manifest", ok: false, detail: "the gateway's record of the brief's outside services is missing" });
  else if (!manifest) out.push({ id: "manifest", ok: false, detail: "musemuse.json has no connect block" });
  else out.push({ id: "manifest", ok: JSON.stringify(brief) === JSON.stringify(manifest), detail: `musemuse.json has ${say(manifest)}; the brief has ${say(brief)}` });

  if (!brief || brief.publicApis.length) {
    const shown = recorded(record, "fetch-shown");
    const fetches = Number(proof?.fetches ?? 0);
    out.push({
      id: "fetch-shown",
      ok: shown?.ok === true && fetches > 0,
      detail: fetches > 0 ? (shown?.detail ?? "the smoke test didn't run checkFetchShown") : "the gateway saw no public API call in this verify",
    });
  }
  const hashes = new Set(Object.keys(proof ?? {}).filter((k) => k.startsWith("secret-sha:")).map((k) => k.slice("secret-sha:".length)));
  if (brief?.keys.length) {
    const saved = recorded(record, "key-saved");
    out.push({ id: "key-saved", ok: saved?.ok === true && Number(proof?.keys ?? 0) > 0, detail: Number(proof?.keys ?? 0) > 0 ? (saved?.detail ?? "the smoke test didn't run saveTestKey") : "the gateway kept no test key in this verify" });
  }
  if (brief?.keys.length || hashes.size) {
    const leaks = hashes.size ? findLeaks(root, hashes) : [];
    out.push({
      id: "no-key-leak",
      ok: hashes.size > 0 && leaks.length === 0,
      detail: !hashes.size ? "no test key was saved, so nothing could be checked" : leaks.length ? `a saved key shows in ${leaks.slice(0, 5).join(", ")}` : `none of ${hashes.size} test key${hashes.size === 1 ? "" : "s"} shows in a page or file`,
    });
  }
  if (brief?.sends.length) {
    const confirmed = recorded(record, "send-confirmed");
    const sends = Number(proof?.sends ?? 0);
    out.push({ id: "send-confirmed", ok: confirmed?.ok === true && sends > 0, detail: sends > 0 ? (confirmed?.detail ?? "the smoke test didn't run confirmSend") : "the gateway recorded no confirmed sample send in this verify" });
  }
  return out;
}
