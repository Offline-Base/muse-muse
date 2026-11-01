// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it through scripts/caps-check.mjs.
//
// The fixed checks for a browser extension. In a build sandbox this is the platform's read-only copy, with the
// platform's own packer beside it (../extension-pack.mjs) and its loader (./extension-load.mjs), never the product's
// copies:
//   manifest  extension/ compiles, and its manifest and files pass the rules the platform packages by: Manifest V3, only
//             the permissions brief.md lists, no host permissions of its own, no remote or inline code, and network
//             calls only through productAction() in extension/platform.ts
//   loaded    the platform builds it and loads it into Chromium itself, the way Load unpacked does, and its service
//             worker starts
//   popup     the platform opens its popup (or side panel) itself, and it renders with no script error
//   action    the smoke test ran a step in the popup that called one of the product's actions and got JSON back
//             (tests/caps/extension.ts, expectExtensionAction)
//
// What these rest on. Compiling needs TypeScript and loading needs Playwright, and the only copies in a build are the
// product's, in its node_modules. So the packer's check and the loader each run in a process of their own, and this
// file reads only the last line they print. Nothing from the product's node_modules runs in the caps check's own
// process, so it can't change another check or another cap. A product that rewrote its own TypeScript or Playwright
// could still fake manifest, loaded and popup for its own extension. What ships doesn't rest on them: the platform
// checks the bundle again on its own servers (lib/caps/extension/package.ts) and writes the manifest itself. action
// reads the smoke test's record, which a product test could write itself. The gateway keeps no record of extension
// calls: they reach the product's own action routes.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PACKER = fileURLToPath(new URL("../extension-pack.mjs", import.meta.url));
const LOADER = fileURLToPath(new URL("./extension-load.mjs", import.meta.url));
const MAX_OUTPUT = 1024 * 1024;

/**
 * Runs `node <script> ...args` apart from this process and returns its exit code, the JSON on the last line of its
 * stdout (null when there's none) and the first line of stderr.
 */
export function runApart(script, args, { timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: tmpdir(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const take = (chunk, into) => (into.length < MAX_OUTPUT ? into + chunk.toString("utf8") : into);
    child.stdout.on("data", (c) => (stdout = take(c, stdout)));
    child.stderr.on("data", (c) => (stderr = take(c, stderr)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const done = (code, error) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(stdout.trim().split("\n").pop() ?? "");
      } catch {
        json = null;
      }
      const firstErr = stderr.split("\n").map((l) => l.replace(/^extension: /, "").trim()).find(Boolean) ?? "";
      resolve({ code, json: json && typeof json === "object" && !Array.isArray(json) ? json : null, stderr: firstErr.slice(0, 240), timedOut, error });
    };
    child.on("error", (err) => done(null, err));
    child.on("close", (code) => done(code, null));
  });
}

export async function check({ record, root }) {
  const checks = [];
  const packed = await runApart(PACKER, ["check", "--root", root], { timeoutMs: 120_000 });
  const problems = Array.isArray(packed.json?.problems) ? packed.json.problems.filter((p) => typeof p === "string") : null;
  const passed = packed.code === 0 && packed.json?.ok === true && problems?.length === 0;
  const why = problems?.length
    ? problems.slice(0, 3).join("; ")
    : packed.timedOut
      ? "The packer's check took too long"
      : packed.stderr || "The packer's check stopped without a result";
  checks.push({
    id: "manifest",
    ok: passed,
    detail: passed ? "Manifest V3, only its listed permissions, no remote or inline code, network calls only through productAction" : why,
  });
  if (!passed) {
    checks.push({ id: "loaded", ok: false, detail: "Not loaded, since the manifest check failed" }, { id: "popup", ok: false, detail: "Not opened, since the manifest check failed" });
  } else {
    const ran = await runApart(LOADER, ["--root", root], { timeoutMs: 120_000 });
    const seen = ran.json?.musemuse_extension_load === 1 ? ran.json : null;
    const detail = typeof seen?.detail === "string" ? seen.detail.slice(0, 240) : ran.timedOut ? "Loading the extension took too long" : ran.stderr || "The loader stopped without a result";
    const loaded = seen?.loaded === true;
    checks.push({ id: "loaded", ok: loaded, detail: loaded ? "The platform loaded it into Chromium and its service worker started" : detail });
    checks.push({ id: "popup", ok: loaded && seen?.popup === true, detail });
  }
  const action = (record?.checks ?? []).find((c) => c?.id === "action");
  checks.push({
    id: "action",
    ok: action?.ok === true,
    detail: action ? String(action.detail ?? "").slice(0, 200) : "The smoke test didn't run a popup step with expectExtensionAction from tests/caps/extension.ts",
  });
  return checks;
}
