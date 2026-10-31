/**
 * Drives one build on the local platform for the Oct 31 serve test, and keeps everything it saw.
 *   npx tsx docs/spikes/serve-2026-10-31/drive.mts <out dir> <name> new <note> [image path]
 *   npx tsx docs/spikes/serve-2026-10-31/drive.mts <out dir> <name> refine <build id> <message>
 *   npx tsx docs/spikes/serve-2026-10-31/drive.mts <out dir> <name> watch <build id>
 * ACTIONS (JSON list) runs things during the build:
 *   {"round": 0, "afterS": 90, "post": {control body}}  once the round has run that long (round is the build room's: 0, or the fix number)
 *   {"status": "previewing", "inject": true}            the first time that status shows, breaks the product's typecheck
 * Writes <name>.events.jsonl (every build event) and <name>.polls.jsonl (the build row over time), and prints a line per change.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";

const BASE = process.env.BASE || "http://localhost:3031";
const [outDir, name, mode, a, b] = process.argv.slice(2);
if (!outDir || !name || !mode || !a) throw new Error("usage: <out dir> <name> new|refine|watch ...");
mkdirSync(outDir, { recursive: true });
const eventsFile = path.join(outDir, `${name}.events.jsonl`);
const pollsFile = path.join(outDir, `${name}.polls.jsonl`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(["live", "partial", "failed", "refused", "cancelled"]);
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (s: string) => console.log(`${stamp()} ${s}`);

async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

let buildId = a;
if (mode === "new") {
  const references: unknown[] = [];
  if (b) {
    const form = new FormData();
    const fileName = path.basename(b);
    form.append("pathname", `inspo/${crypto.randomUUID()}-${fileName}`);
    form.append("file", new File([readFileSync(b)], fileName, { type: "image/png" }));
    const up = await fetch(`${BASE}/api/files/upload`, { method: "POST", body: form });
    const { url } = (await up.json()) as { url: string };
    if (!url) throw new Error(`upload failed: ${up.status}`);
    references.push({ url, kind: "image", fileName, contentType: "image/png", size: readFileSync(b).length });
  }
  const r = await post("/api/inspirations", { note: a, references });
  if (r.status !== 201) throw new Error(`start failed: ${r.status} ${JSON.stringify(r.json)}`);
  buildId = r.json.buildId;
} else if (mode === "refine") {
  const r = await post(`/api/builds/${a}/messages`, { message: b });
  if (r.status !== 201) throw new Error(`refine failed: ${r.status} ${JSON.stringify(r.json)}`);
  buildId = r.json.buildId;
}
say(`build ${buildId}`);
writeFileSync(path.join(outDir, `${name}.id`), buildId);
const t0 = Date.now();

// Every event, as the build room gets them.
let lastId = "0";
let done = false;
const seenKinds = new Map<string, number>();
const brief = (e: any): string | null => {
  const t = e.type;
  seenKinds.set(t, (seenKinds.get(t) ?? 0) + 1);
  if (t === "log" || t === "status" || t === "judge" || t === "cost" || t === "control" || t === "error") return `${t}: ${JSON.stringify(e).slice(0, 260)}`;
  if (t === "muse") return `muse: ${JSON.stringify(e).slice(0, 220)}`;
  return `${t}: ${JSON.stringify(e).slice(0, 200)}`;
};
async function follow(): Promise<void> {
  while (!done) {
    try {
      const res = await fetch(`${BASE}/api/builds/${buildId}/events?after=${lastId}`);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = /^id: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (id) lastId = id;
          if (!data) continue;
          appendFileSync(eventsFile, `${data}\n`);
          try {
            const line = brief(JSON.parse(data));
            if (line && process.env.VERBOSE) say(line);
          } catch {
            // Saved as it came.
          }
        }
      }
    } catch (err) {
      if (!done) say(`events stream: ${String(err).slice(0, 120)}`);
    }
    await sleep(1000);
  }
}
void follow();

type Action = { round?: number; afterS?: number; status?: string; post?: Record<string, unknown>; inject?: boolean; done?: boolean };
const actions: Action[] = JSON.parse(process.env.ACTIONS || "[]");
const roundStarted = new Map<number, number>();

async function inject(sandboxName: string): Promise<void> {
  const sb = await Sandbox.get({ name: sandboxName });
  await sb.writeFiles([{ path: "/vercel/app/lib/serve-test-break.ts", content: 'export const brokenOnPurpose: number = "this line fails the typecheck";\n' }]);
  say(`injected a type error into ${sandboxName}`);
}

let lastLine = "";
for (;;) {
  const res = await fetch(`${BASE}/api/builds/${buildId}`).catch(() => null);
  const body = res ? ((await res.json().catch(() => null)) as any) : null;
  const build = body?.build;
  if (build) {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const row = { t: Date.now(), elapsed, status: build.status, step: build.step, fixRounds: build.fixRounds, museRound: build.museRound, costUsd: build.costUsd, stop: build.stopRequested, sandbox: build.sandboxName, session: build.museSessionId };
    appendFileSync(pollsFile, `${JSON.stringify(row)}\n`);
    const line = `${build.status} step=${build.step} fix=${build.fixRounds} round=${build.museRound} cost=$${Number(build.costUsd).toFixed(3)}`;
    if (line !== lastLine) {
      say(`+${elapsed}s ${line}`);
      lastLine = line;
    }
    if (build.museRound !== null && !roundStarted.has(build.fixRounds)) roundStarted.set(build.fixRounds, Date.now());
    for (const act of actions) {
      if (act.done) continue;
      if (act.status && act.status === build.status && act.inject && build.sandboxName) {
        act.done = true;
        await inject(build.sandboxName).catch((err) => say(`inject failed: ${err}`));
      }
      if (act.post && act.round !== undefined && roundStarted.has(act.round) && build.fixRounds === act.round && build.museRound !== null && Date.now() - roundStarted.get(act.round)! >= (act.afterS ?? 0) * 1000) {
        act.done = true;
        const r = await post(`/api/builds/${buildId}/control`, act.post);
        say(`control ${JSON.stringify(act.post).slice(0, 120)} -> ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
      }
    }
    if (TERMINAL.has(build.status)) {
      writeFileSync(path.join(outDir, `${name}.final.json`), JSON.stringify(body, null, 2));
      say(`END ${build.status} in ${Math.round((Date.now() - Date.parse(build.startedAt)) / 1000)} s, cost $${Number(build.costUsd).toFixed(3)}, fixes ${build.fixRounds}, error: ${String(build.error ?? "").slice(0, 200)}`);
      say(`events: ${JSON.stringify(Object.fromEntries(seenKinds))}`);
      break;
    }
  }
  await sleep(2000);
}
await sleep(3000);
done = true;
process.exit(0);
