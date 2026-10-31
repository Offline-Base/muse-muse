// tools/check.mjs: the stand-in's jobs must pass the agent's own validation, and its routes must answer the way the
// contract in docs/NATIVE_LAB.md says.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { agentEnv, buildJob, checkPlist, createStandIn, windowsRootGrant, windowsTaskScript } from "../tools/check.mjs";
import { KINDS, LANE_OF, validateJob } from "../lib/validate.mjs";

const origin = "http://127.0.0.1:4100";
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("the check tool", () => {
  for (const kind of KINDS) {
    test(`a ${kind} job passes the agent's validation`, () => {
      const job = buildJob({ kind, origin, sha256: "a".repeat(64), bytes: 10, target: "https://muse-muse.vercel.app/" });
      const reply = validateJob(job, { lane: LANE_OF[kind], platformOrigin: origin, allowInsecure: true });
      assert.equal(reply.ok, true, reply.error);
    });
  }
  test("the temporary agent can't stop the box, and only takes this job's kind", () => {
    const env = agentEnv({ kind: "desktop_windows", origin, root: "C:\\x", tokenFile: "C:\\x\\t" });
    assert.equal(env.MUSE_LAB_IDLE_MINUTES, "0");
    assert.equal(env.MUSE_LAB_KINDS, "desktop_windows");
    assert.equal(env.MUSE_LAB_LANE, "windows");
  });
  test("on Windows the temporary agent's root is opened to the lab user, and only that folder", () => {
    assert.deepEqual(windowsRootGrant("C:\\MuseLab\\data\\c1\\root"), ["icacls", "C:\\MuseLab\\data\\c1\\root", "/grant", "musemuse:(OI)(CI)M", "/T", "/Q"]);
  });
  test("the LaunchAgent runs in the GUI session and escapes its values", () => {
    const plist = checkPlist({ node: "/n", root: "/r&s", env: { A: "b<c" } });
    assert.match(plist, /<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/);
    assert.ok(plist.includes("/r&amp;s") && plist.includes("b&lt;c"));
  });
  test("the Windows task runs in the lab user's session, without admin rights", () => {
    const script = windowsTaskScript({ cmdFile: "C:\\x\\run.cmd" });
    assert.match(script, /-LogonType Interactive -RunLevel Limited/);
    assert.match(script, /-UserId 'musemuse'/);
  });
  test("the stand-in hands out one job, serves its file and keeps the results", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-check-"));
    dirs.push(dir);
    const here = new URL(import.meta.url).pathname;
    let finish;
    const finished = new Promise((resolve) => (finish = resolve));
    const server = createStandIn({
      makeJob: (at) => buildJob({ kind: "desktop_mac", origin: at, sha256: "a".repeat(64), bytes: 10, target: "https://x.vercel.app/" }),
      files: { app: here },
      outDir: dir,
      onFinish: finish,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body) => fetch(`${at}${route}`, { method: "POST", body: JSON.stringify(body) });
    try {
      assert.equal((await post("/api/native/agent/claim", { kinds: ["ios_sim"] })).status, 204);
      const claim = await post("/api/native/agent/claim", { kinds: ["desktop_mac"] });
      const { job } = await claim.json();
      assert.equal(job.kind, "desktop_mac");
      assert.equal((await post("/api/native/agent/claim", { kinds: ["desktop_mac"] })).status, 204, "only once");
      assert.equal((await (await fetch(job.input.app.url)).text()), readFileSync(here, "utf8"));
      assert.deepEqual(await (await post(`/api/native/agent/jobs/${job.id}/heartbeat`, { phase: "start" })).json(), { cancel: false });
      const { uploads } = await (await post(`/api/native/agent/jobs/${job.id}/upload`, { files: [{ name: "clip.mp4" }] })).json();
      assert.equal((await fetch(uploads[0].url, { method: "PUT", body: "clip" })).status, 200);
      assert.equal(readFileSync(path.join(dir, "clip.mp4"), "utf8"), "clip");
      await post(`/api/native/agent/jobs/${job.id}/finish`, { outcome: "passed" });
      const done = await finished;
      assert.equal(done.outcome, "passed");
      assert.deepEqual(done.phases, ["start"]);
    } finally {
      server.close();
      server.closeAllConnections?.();
    }
  });
});
