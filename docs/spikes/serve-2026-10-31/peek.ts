/**
 * Copies a build's bridge logs and Muse Code session logs out of its sandbox, and reports what models they name.
 *   npx tsx docs/spikes/serve-2026-10-31/peek.ts <sandbox name> <out dir> [--stop]
 * Wakes a hibernated sandbox if it must. Never prints a secret: only file names, sizes and counted model names.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { sh } from "@/lib/sandbox/shell";

const [name, out, flag] = process.argv.slice(2);
if (!name || !out) throw new Error("usage: <sandbox> <out dir> [--stop]");
mkdirSync(out, { recursive: true });
const sb = await Sandbox.get({ name, resume: true });
const r = await sh(sb, [
  "cd /vercel/musemuse/logs 2>/dev/null && ls -la | cut -c20- | head -40",
  'D=$(ls -d ~/.local/share/muse/sessions/*/*/*/* 2>/dev/null | head -5); echo "sessions: $D"',
  'for d in $D; do echo "$d logs=$(find "$d" -name session.jsonl | wc -l)"; done',
  'for d in $D; do grep -rhoE \'"(model|model_id|background_agent_model)":"[^"]+"\' "$d" | sort | uniq -c | sort -rn | head -8; done',
  "rm -f /tmp/muselogs.tgz; tar -czf /tmp/muselogs.tgz -C / vercel/musemuse/logs $(for d in $D; do echo ${d#/}; done) 2>/dev/null; ls -la /tmp/muselogs.tgz | cut -c20-",
].join("\n"), { allowFail: true, timeoutMs: 60_000 });
console.log(r.stdout.slice(0, 5000));
const buf = await sb.readFileToBuffer({ path: "/tmp/muselogs.tgz" });
if (buf) writeFileSync(path.join(out, "muselogs.tgz"), buf);
console.log(`copied ${buf?.length ?? 0} bytes to ${out}/muselogs.tgz`);
if (flag === "--stop") {
  await sb.stop({ blocking: true } as never).catch((e) => console.warn(String(e)));
  console.log("stopped");
}
