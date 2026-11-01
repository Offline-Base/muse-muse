/**
 * Just enough git to push from a serverless function, which has no git program: objects, a pack, and the smart HTTP
 * receive-pack exchange. Fetch and deltas aren't needed: this only ever adds whole objects on top of a commit it wrote.
 * Credentials go in a header, never a URL, and no error here carries one.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export type GitType = "blob" | "tree" | "commit";
export interface GitObject {
  id: string;
  type: GitType;
  body: Buffer;
}
export const ZERO_ID = "0".repeat(40);

export function gitObject(type: GitType, body: Buffer): GitObject {
  const id = createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest("hex");
  return { id, type, body };
}

interface Dir {
  files: Map<string, string>;
  dirs: Map<string, Dir>;
}

/** The tree objects for a list of files, added to `out`. Git sorts a folder as if its name ended in a slash. */
export function writeTree(files: ReadonlyArray<{ path: string; blobId: string }>, out: Map<string, GitObject>): string {
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let at = root;
    for (const part of parts.slice(0, -1)) {
      let next = at.dirs.get(part);
      if (!next) at.dirs.set(part, (next = { files: new Map(), dirs: new Map() }));
      at = next;
    }
    at.files.set(parts.at(-1)!, f.blobId);
  }
  const write = (dir: Dir): string => {
    const entries = [
      ...[...dir.files].map(([name, id]) => ({ mode: "100644", name, id, key: Buffer.from(name) })),
      ...[...dir.dirs].map(([name, sub]) => ({ mode: "40000", name, id: write(sub), key: Buffer.from(`${name}/`) })),
    ].sort((a, b) => Buffer.compare(a.key, b.key));
    const tree = gitObject("tree", Buffer.concat(entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.id, "hex")])));
    out.set(tree.id, tree);
    return tree.id;
  };
  return write(root);
}

export interface Person {
  name: string;
  email: string;
}

const signature = (p: Person, at: Date) => `${p.name.replace(/[<>\n\0]/g, "")} <${p.email.replace(/[<>\n\0\s]/g, "")}> ${Math.floor(at.getTime() / 1000)} +0000`;

export function commitObject(input: { tree: string; parent: string | null; author: Person; committer: Person; at: Date; message: string }): GitObject {
  const lines = [`tree ${input.tree}`, ...(input.parent ? [`parent ${input.parent}`] : []), `author ${signature(input.author, input.at)}`, `committer ${signature(input.committer, input.at)}`];
  return gitObject("commit", Buffer.from(`${lines.join("\n")}\n\n${input.message.replace(/\0/g, "").trimEnd()}\n`));
}

const PACK_TYPE: Record<GitType, number> = { commit: 1, tree: 2, blob: 3 };

/** A version 2 pack of whole objects. */
export function makePack(objects: readonly GitObject[]): Buffer {
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "latin1");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [head];
  for (const o of objects) {
    let size = o.body.length;
    const bytes: number[] = [(PACK_TYPE[o.type] << 4) | (size & 0x0f)];
    size = Math.floor(size / 16);
    while (size > 0) {
      bytes[bytes.length - 1]! |= 0x80;
      bytes.push(size & 0x7f);
      size = Math.floor(size / 128);
    }
    parts.push(Buffer.from(bytes), deflateSync(o.body));
  }
  const pack = Buffer.concat(parts);
  return Buffer.concat([pack, createHash("sha1").update(pack).digest()]);
}

const pkt = (text: string) => {
  const body = Buffer.from(text);
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
};

/** Each line of a pkt-line stream, with flushes dropped. Throws on anything malformed. */
export function readPktLines(data: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let at = 0;
  while (at < data.length) {
    const size = parseInt(data.subarray(at, at + 4).toString("latin1"), 16);
    if (!Number.isInteger(size) || (size !== 0 && size < 4) || at + Math.max(size, 4) > data.length) throw new GitPushError("protocol");
    if (size > 4) lines.push(data.subarray(at + 4, at + size));
    at += Math.max(size, 4);
  }
  return lines;
}

export type GitPushKind = "auth" | "not_found" | "rejected" | "protocol" | "http";

/** A push that didn't land. `detail` is the server's short reason, with no credential in it. */
export class GitPushError extends Error {
  constructor(
    readonly kind: GitPushKind,
    readonly detail?: string,
  ) {
    super(`git push failed: ${kind}`);
  }
}

export interface Remote {
  /** Like https://github.com/owner/name.git */
  url: string;
  /** Sent as HTTP basic, with x-access-token as the name. */
  token: string;
  fetch?: typeof fetch;
}

const headers = (r: Remote) => ({ authorization: `Basic ${Buffer.from(`x-access-token:${r.token}`).toString("base64")}`, "user-agent": "git/2.50.1 muse-muse" });

function failFor(status: number): GitPushError {
  if (status === 401 || status === 403) return new GitPushError("auth");
  if (status === 404) return new GitPushError("not_found");
  return new GitPushError("http", String(status));
}

/** The branches the remote has now, and what it can do. */
export async function remoteRefs(remote: Remote): Promise<{ refs: Map<string, string>; caps: Set<string> }> {
  const res = await (remote.fetch ?? fetch)(`${remote.url}/info/refs?service=git-receive-pack`, { headers: headers(remote), redirect: "error" });
  if (!res.ok) throw failFor(res.status);
  if (res.headers.get("content-type") !== "application/x-git-receive-pack-advertisement") throw new GitPushError("protocol");
  const refs = new Map<string, string>();
  let caps = new Set<string>();
  for (const line of readPktLines(Buffer.from(await res.arrayBuffer())).slice(1)) {
    const nul = line.indexOf(0);
    const ref = (nul === -1 ? line : line.subarray(0, nul)).toString("utf8").trim();
    if (nul !== -1) caps = new Set(line.subarray(nul + 1).toString("utf8").trim().split(" "));
    const [id, name] = ref.split(" ");
    if (id && name && id !== ZERO_ID) refs.set(name, id);
  }
  return { refs, caps };
}

/** Moves `ref` from `oldId` to `newId`, sending these objects. Never forces: the server refuses a stale `oldId` or a non fast-forward. */
export async function pushPack(remote: Remote, input: { ref: string; oldId: string | null; newId: string; objects: readonly GitObject[] }): Promise<void> {
  const command = pkt(`${input.oldId ?? ZERO_ID} ${input.newId} ${input.ref}\0 report-status agent=muse-muse\n`);
  const res = await (remote.fetch ?? fetch)(`${remote.url}/git-receive-pack`, {
    method: "POST",
    headers: { ...headers(remote), "content-type": "application/x-git-receive-pack-request", accept: "application/x-git-receive-pack-result" },
    body: new Uint8Array(Buffer.concat([command, Buffer.from("0000"), makePack(input.objects)])),
    redirect: "error",
  });
  if (!res.ok) throw failFor(res.status);
  const report = readPktLines(Buffer.from(await res.arrayBuffer())).map((l) => l.toString("utf8").trim());
  const clean = (s: string) => s.slice(0, 200).split(remote.token).join("[hidden]");
  if (report[0] !== "unpack ok") throw new GitPushError("rejected", clean(report[0] ?? "no report"));
  const mine = report.find((l) => l.startsWith(`ok ${input.ref}`) || l.startsWith(`ng ${input.ref}`));
  if (!mine?.startsWith("ok ")) throw new GitPushError("rejected", clean(mine ?? "no report"));
}
