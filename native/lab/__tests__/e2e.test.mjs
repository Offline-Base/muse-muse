// The whole agent as a real process, against a local stand-in for the platform, on a real desktop_mac job: a tiny signed
// Mac app that writes what native/shell-desktop/src/selftest.js writes. It claims, downloads, unzips, checks the signature,
// runs the app, composes with the real ffmpeg, uploads through plain PUT slots and finishes. It needs a Mac with ffmpeg,
// and it spends nothing.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_OK =
  process.platform === "darwin" &&
  spawnSync("ffmpeg", ["-version"]).status === 0 &&
  spawnSync("ditto", ["-h"]).error === undefined &&
  spawnSync("codesign", ["-h"]).error === undefined;

const LAB_TOKEN = "lab-token-e2e-abcdefghijkl";
const JOB_TOKEN = "job-token-e2e-abcdefghijkl";
const TARGET = "https://demo-product.vercel.app";

function buildApp(dir) {
  const app = path.join(dir, "Demo.app");
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Demo</string><key>CFBundleIdentifier</key><string>ai.musemuse.e2e</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
  );
  const frames = path.join(app, "Contents", "Resources");
  for (const [i, color] of ["red", "green", "blue"].entries()) {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=640x400:d=0.04,drawbox=c=${color}:t=fill:w=60:h=60`, "-frames:v", "1", path.join(frames, `f${i}.jpg`)]);
  }
  const exe = path.join(app, "Contents", "MacOS", "Demo");
  writeFileSync(
    exe,
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in --muse-selftest=*) dir="\${arg#--muse-selftest=}" ;; esac
done
res="$(dirname "$0")/../Resources"
mkdir -p "$dir/frames" "$dir/stills"
cp "$res/f0.jpg" "$dir/frames/00001.jpg"
sleep 1
cp "$res/f1.jpg" "$dir/frames/00002.jpg"
sleep 1
cp "$res/f2.jpg" "$dir/frames/00003.jpg"
cp "$res/f2.jpg" "$dir/stills/01.jpg"
cat > "$dir/selftest.json" <<JSON
{"v":1,"ok":true,"finalUrl":"${TARGET}/","httpStatus":200,"loadMs":1500,"textLength":300,"handshake":true,"frames":3,"stills":1,"consoleErrors":["a console warning"],"crashed":false,"loadError":null}
JSON
`,
  );
  chmodSync(exe, 0o755);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "ignore" });
  const zip = path.join(dir, "Demo.zip");
  execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip]);
  return readFileSync(zip);
}

function platform(zip) {
  const sha = createHash("sha256").update(zip).digest("hex");
  const state = { claims: [], beats: [], uploads: {}, finish: null, handed: false, labAuth: [], jobAuth: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const send = (status, o) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(o === undefined ? undefined : JSON.stringify(o));
      };
      const url = new URL(req.url, "http://x");
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (url.pathname === "/app.zip") return res.end(zip);
      if (url.pathname.startsWith("/put/")) {
        state.uploads[url.pathname.slice(5)] = body;
        return send(200, { url: `${origin}${url.pathname}`, pathname: url.pathname.slice(5) });
      }
      const auth = req.headers.authorization;
      if (url.pathname === "/api/native/agent/claim") {
        state.labAuth.push(auth);
        const claim = JSON.parse(body.toString());
        state.claims.push(claim);
        if (state.handed || !claim.kinds.includes("desktop_mac")) return send(204);
        state.handed = true;
        return send(200, {
          job: {
            id: "job_e2e",
            kind: "desktop_mac",
            token: JOB_TOKEN,
            attempt: 1,
            runId: "run_e2e",
            input: {
              v: 1,
              limitSeconds: 180,
              target: { url: `${TARGET}/` },
              product: { name: "Demo", slug: "demo" },
              selftestSeconds: 8,
              shots: 1,
              app: { kind: "mac_zip", variant: "product", version: "1.0.0", url: `${origin}/app.zip`, sha256: sha, bytes: zip.length },
            },
          },
        });
      }
      const match = /^\/api\/native\/agent\/jobs\/([^/]+)\/(heartbeat|upload|finish)$/.exec(url.pathname);
      if (match) {
        state.jobAuth.push(auth);
        const parsed = JSON.parse(body.toString());
        if (match[2] === "heartbeat") {
          state.beats.push(parsed);
          return send(200, { cancel: false });
        }
        if (match[2] === "upload") {
          return send(200, {
            uploads: parsed.files.map((file) => ({ name: file.name, method: "put", pathname: file.name, url: `${origin}/put/${file.name}` })),
          });
        }
        state.finish = parsed;
        return send(200, { ok: true });
      }
      return send(404, {});
    });
  });
  return { server, state };
}

describe("the agent end to end", { skip: !TOOLS_OK, timeout: 120_000 }, () => {
  test("claims a Mac job, checks it for real, uploads and finishes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-e2e-"));
    const { server, state } = platform(buildApp(dir));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, LAB_TOKEN);
    const root = path.join(dir, "lab");
    let output = "";
    const agent = spawn(process.execPath, [path.join(HERE, "..", "agent.mjs")], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MUSE_LAB_LANE: "mac",
        MUSE_LAB_ROOT: root,
        MUSE_LAB_PLATFORM: `http://127.0.0.1:${server.address().port}`,
        MUSE_LAB_ALLOW_INSECURE: "1",
        MUSE_LAB_TOKEN_FILE: tokenFile,
        MUSE_LAB_KINDS: "desktop_mac",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    agent.stdout.on("data", (c) => (output += c));
    agent.stderr.on("data", (c) => (output += c));
    try {
      const deadline = Date.now() + 100_000;
      while (!state.finish && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(state.finish, `no finish call. Agent said:\n${output}`);

      const { finish } = state;
      assert.equal(finish.outcome, "passed", JSON.stringify(finish, null, 2));
      assert.match(finish.summary, /^Checked on a Mac in the AWS device lab \(macOS [\d.]+\): opened in 1\.5 s\.$/);
      assert.deepEqual(finish.warnings, ["Console error: a console warning"]);
      assert.equal(finish.checks.find((c) => c.id === "codesign").ok, true);
      assert.equal(finish.checks.find((c) => c.id === "gatekeeper").ok, null);
      assert.equal(finish.captionBurned, true);
      assert.equal(finish.informational, false);

      const roles = finish.artifacts.map((a) => a.role).sort();
      assert.deepEqual(roles, ["clip", "log", "poster", "report", "shot"]);
      const clip = finish.artifacts.find((a) => a.role === "clip");
      assert.match(clip.caption, /^On a Mac in the AWS device lab/);
      assert.equal(clip.contentType, "video/mp4");
      const uploadedClip = state.uploads["clip.mp4"];
      assert.equal(uploadedClip.length, clip.bytes);
      assert.equal(createHash("sha256").update(uploadedClip).digest("hex"), clip.sha256);

      const clipFile = path.join(dir, "clip.mp4");
      writeFileSync(clipFile, uploadedClip);
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", clipFile]));
      assert.deepEqual([probe.streams[0].width, probe.streams[0].height], [1920, 1080]);

      assert.deepEqual(state.claims[0].kinds, ["desktop_mac"]);
      assert.ok(state.beats.length >= 1, "it heartbeat");
      assert.ok(state.labAuth.every((a) => a === `Bearer ${LAB_TOKEN}`), "claim uses the lab token");
      assert.ok(state.jobAuth.every((a) => a === `Bearer ${JOB_TOKEN}`), "the job's calls use the job's token");
      assert.ok(!output.includes(LAB_TOKEN) && !output.includes(JOB_TOKEN), "no token in the agent's output");
      for (const name of ["report.json", "log.txt"]) {
        const text = state.uploads[name].toString();
        assert.ok(!text.includes(JOB_TOKEN) && !text.includes(LAB_TOKEN), name);
      }
      assert.ok(!existsSync(path.join(root, "data", "jobs", "job_e2e")), "the job's folder is gone");
      assert.ok(JSON.parse(readFileSync(path.join(root, "data", "state.json"), "utf8")).lane === "mac");
    } finally {
      const exited = new Promise((resolve) => agent.once("close", resolve));
      agent.kill("SIGTERM");
      const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 15_000))]);
      if (code === "still running") agent.kill("SIGKILL");
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
      assert.equal(code, 0, `the agent exits cleanly on SIGTERM. It said:\n${output.slice(-800)}`);
    }
  });
});
