/**
 * What a running round has spent so far, read from its session logs with the platform's own parser.
 *   npx tsx docs/spikes/serve-2026-10-31/tally.ts <sandbox name> <round>
 */
import { Sandbox } from "@vercel/sandbox";
import { bridgePaths } from "@/lib/sandbox/bridge-protocol";
import { parseSessionUsage, SESSION_USAGE_SCRIPT } from "@/lib/sandbox/muse-log";
import { q, sh } from "@/lib/sandbox/shell";

const [name, roundText] = process.argv.slice(2);
const sb = await Sandbox.get({ name: name! });
const round = Number(roundText ?? 0);
const execLog = `/vercel/musemuse/logs/muse-r${round}.jsonl`;
const log = (await sh(sb, `[ -s ${q(bridgePaths(round).log)} ] && echo ${q(bridgePaths(round).log)} || echo ${q(execLog)}`)).stdout.trim();
const res = await sh(sb, `node -e ${q(SESSION_USAGE_SCRIPT)} ${q(log)}`, { allowFail: true, timeoutMs: 40_000 });
const u = parseSessionUsage(res.stdout);
const sum = (g: { usage: { costUsd: number }[] }) => g.usage.reduce((s, x) => s + x.costUsd, 0);
const tokens = (g: { usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }[] }) =>
  g.usage.map((x) => `in ${x.inputTokens} cached ${x.cachedInputTokens} out ${x.outputTokens}`).join("; ");
console.log(`${log} found=${u.found} runId=${u.runId}`);
console.log(`main ${u.main.calls} calls $${sum(u.main).toFixed(3)} (${tokens(u.main)})`);
console.log(`children ${u.children.calls} calls $${sum(u.children).toFixed(3)} [${u.children.owners.join(",")}] (${tokens(u.children)})`);
console.log(`unknown ${u.unknown.calls} calls [${u.unknown.owners.join(",")}]`);
console.log(`total so far $${(sum(u.main) + sum(u.children)).toFixed(3)}`);
const models = await sh(sb, `D=$(ls -d ~/.local/share/muse/sessions/*/*/*/* | head -3); for d in $D; do grep -rhoE '"model(_id)?":"[^"]+"' "$d" | sort | uniq -c | sort -rn | head -6; echo "logs $(find "$d" -name session.jsonl | wc -l)"; done`, { allowFail: true, timeoutMs: 40_000 });
console.log(models.stdout.trim());
