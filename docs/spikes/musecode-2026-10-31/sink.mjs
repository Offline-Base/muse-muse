// The spike's watch on everything that isn't the custom endpoint. As root, on 127.0.0.1:8788. /etc/hosts is read-only in a sandbox,
// so instead each run sets HTTPS_PROXY to this: every HTTPS connection Muse Code opens that isn't to NO_PROXY arrives here as a
// CONNECT, is logged by host and answered by a local TLS server that logs the method and path and refuses. Nothing leaves, except
// a tunnel to the npm registry for the agent's own shell. Muse Code trusts that TLS server through SSL_CERT_FILE (lib.sh sink_on).
// It also polls `ss` for any non-loopback connection, by process, in case something ignores HTTPS_PROXY.
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const LOG = "/tmp/out/sink.jsonl";
const label = () => {
  try {
    return readFileSync("/tmp/proxy-label", "utf8").trim();
  } catch {
    return "";
  }
};
const log = (o) => appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), label: label(), ...o })}\n`);
const server = http.createServer((req, res) => {
  log({ direct: true, plain: true, method: req.method, host: req.headers.host ?? null });
  res.writeHead(403);
  res.end("spike sink");
});
server.on("connect", (req, socket, head) => {
  const [host, port] = String(req.url).split(":");
  if (host === "registry.npmjs.org") {
    log({ tunnel: true, host });
    const up = net.connect(Number(port) || 443, host, () => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
    return;
  }
  log({ direct: true, connect: true, host, port });
  if (host !== "api.meta.ai" || !tls) {
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
    return;
  }
  socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
  if (head?.length) socket.unshift(head);
  tls.emit("connection", socket);
});
const tls = https.createServer({ key: readFileSync("/tmp/sink/leaf.key"), cert: readFileSync("/tmp/sink/leaf.crt") }, (req, res) => {
  let size = 0;
  req.on("data", (c) => (size += c.length));
  req.on("end", () => {
    log({ direct: true, seen: true, method: req.method, host: req.headers.host ?? null, path: req.url?.split("?")[0], contentType: String(req.headers["content-type"] ?? "").split(";")[0] || null, size, hasAuth: Boolean(req.headers.authorization) });
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "spike sink: direct call refused", code: "direct_refused" } }));
  });
});
tls.on("tlsClientError", (e) => log({ direct: true, tlsError: String(e.code ?? e.message).slice(0, 120) }));
server.listen(8788, "127.0.0.1", () => log({ event: "listening" }));
// A stand-in for a real platform host: HTTPS on this VM's own address, not loopback. It logs and refuses like the rest.
tls.listen(8443, "0.0.0.0");

const seen = new Set();
setInterval(() => {
  execFile("ss", ["-tnpH"], { timeout: 2000 }, (err, stdout) => {
    if (err) return;
    for (const line of stdout.split("\n")) {
      const f = line.trim().split(/\s+/);
      const peer = f[4];
      if (!peer || peer.startsWith("127.") || peer.startsWith("[::1]") || peer.startsWith("[::ffff:127.")) continue;
      const comm = /users:\(\("([^"]+)"/.exec(line)?.[1] ?? "?";
      const key = `${label()} ${comm} ${peer}`;
      if (seen.has(key)) continue;
      seen.add(key);
      log({ conn: true, comm, peer });
    }
  });
}, 500);
