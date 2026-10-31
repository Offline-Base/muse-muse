// What the build ships to a browser: every static chunk's size, raw and gzipped, largest first.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const root = ".next/static";
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [path.join(dir, n)]));
const chunks = walk(root)
  .filter((f) => f.endsWith(".js"))
  .map((file) => {
    const body = readFileSync(file);
    const text = body.toString("latin1");
    const has = [["iwer", "XRDevice"], ["devui", "devUICanvas"], ["three", "WebGLRenderer"], ["uikit", "yoga"]].filter(([, k]) => text.includes(k)).map(([n]) => n);
    return { file: file.slice(root.length + 1), kb: Math.round(body.length / 1024), gzKb: Math.round(gzipSync(body).length / 1024), has };
  })
  .sort((a, b) => b.kb - a.kb);
const total = { files: chunks.length, kb: chunks.reduce((s, c) => s + c.kb, 0), gzKb: chunks.reduce((s, c) => s + c.gzKb, 0) };
writeFileSync("/tmp/out/b-bundle.json", JSON.stringify({ total, chunks }, null, 2));
console.log(`total ${total.files} chunks, ${total.kb} KB raw, ${total.gzKb} KB gzipped`);
for (const c of chunks.slice(0, 8)) console.log(`${String(c.kb).padStart(6)} KB ${String(c.gzKb).padStart(5)} KB gz  ${c.has.join(",").padEnd(16)} ${c.file}`);
