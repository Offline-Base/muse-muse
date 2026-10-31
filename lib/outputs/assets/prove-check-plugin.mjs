// Checks a Claude plugin zip by machine: its manifest, its MCP address and its skill, then asks that address for its tools.
//   node prove-check-plugin.mjs <plugin.zip> <name> <mcp url>
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const [zipPath, name, mcpUrl] = process.argv.slice(2);
let failed = false;
const say = (ok, text) => {
  console.log(`${ok ? "ok    " : "FAILED"} ${text}`);
  if (!ok) failed = true;
};

function readZip(zip) {
  let end = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("it isn't a zip file");
  const files = new Map();
  let at = zip.readUInt32LE(end + 16);
  for (let n = zip.readUInt16LE(end + 10); n > 0; n--) {
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const file = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const body = zip.subarray(start, start + packed);
    files.set(file, (method === 8 ? inflateRawSync(body) : body).toString("utf8"));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

function json(files, file) {
  try {
    return JSON.parse(files.get(file) ?? "");
  } catch {
    return null;
  }
}

let files;
try {
  files = readZip(readFileSync(zipPath));
} catch (err) {
  say(false, `can't read the zip: ${err.message}`);
  process.exit(1);
}
for (const file of files.keys()) console.log(`      ${file}`);
say([...files.keys()].every((f) => !f.startsWith("/") && !f.split("/").includes("..")), "every path stays inside the plugin");

const manifest = json(files, ".claude-plugin/plugin.json");
say(manifest?.name === name && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name), `.claude-plugin/plugin.json is named ${name}`);
say(typeof manifest?.version === "string" && typeof manifest?.description === "string", ".claude-plugin/plugin.json has a version and a description");

const servers = json(files, ".mcp.json")?.mcpServers ?? {};
const server = servers[name];
say(Object.keys(servers).length === 1 && server?.type === "http", ".mcp.json has one HTTP server");
say(server?.url === mcpUrl, `.mcp.json points at ${mcpUrl}`);

const skill = files.get(`skills/${name}/SKILL.md`) ?? "";
say(skill.startsWith("---\n") && new RegExp(`^name: ${name}$`, "m").test(skill) && /^description: "/m.test(skill), `skills/${name}/SKILL.md has a name and a description`);

try {
  const res = await fetch(server?.url ?? mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    signal: AbortSignal.timeout(30_000),
  });
  const tools = (await res.json())?.result?.tools;
  say(res.ok && Array.isArray(tools), `that address answers tools/list with ${Array.isArray(tools) ? tools.length : 0} tools`);
} catch (err) {
  say(false, `that address didn't answer: ${err.message}`);
}
process.exit(failed ? 1 : 0);
