// A static server on 127.0.0.1 for the GLB check: /page from this folder, /three from the installed three package,
// /models from /tmp/out. Nothing else.
//   node serve.mjs <port> <three dir>
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const [port, threeDir] = process.argv.slice(2);
const ROOTS = { page: import.meta.dirname, three: threeDir, models: "/tmp/out" };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".glb": "model/gltf-binary" };
createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const [, top, ...rest] = rel === "/" ? ["", "page", "index.html"] : rel.split("/");
  const root = ROOTS[top];
  const file = root ? path.join(root, ...rest) : "";
  if (!root || !file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(Number(port), "127.0.0.1");
