import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
const VALUE_IMPORT = /^(?:import|export)\s+(?!type\b)[^;]*?from\s+"(@\/[^"]+|\.[^"]+)"/gm;
function fileOf(from: string, s: string) { const base = s.startsWith("@/") ? path.join(process.cwd(), s.slice(2)) : path.join(path.dirname(from), s); return [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base].find((f) => existsSync(f) && /\.tsx?$/.test(f)) ?? null; }
function graph(start: string, seen = new Set<string>()) { if (seen.has(start)) return seen; seen.add(start); for (const [, s] of readFileSync(start, "utf8").matchAll(VALUE_IMPORT)) { const f = fileOf(start, s!); if (f) graph(f, seen); } return seen; }
const mods = [...graph(path.join(process.cwd(), "lib/pipeline/workflow.ts"))];
for (const m of mods) if (/require\(["']/.test(readFileSync(m, "utf8"))) console.log(path.relative(process.cwd(), m));
console.log("has look.ts:", mods.some(m => m.endsWith("lib/sandbox/look.ts")));
