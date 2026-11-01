/**
 * The Muse gadget pack: its command names and files by the Linux Gadget SDK's rules, its runner against a local server
 * that stands in for the live product, and install.sh and uninstall.sh under a made-up root with sudo stubbed. Nothing
 * here touches the real /etc, and no gadget or token is involved.
 *   npx tsx --test lib/outputs/__tests__/gadget.test.ts
 */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { GADGET_RUNNER_SOURCE } from "@/lib/outputs/assets-source";
import {
  GADGET_MAX_NAME,
  GADGET_NAME_RE,
  GADGET_REGISTRATION_BUDGET,
  GADGET_RESERVED_PREFIXES,
  gadgetEntries,
  gadgetPack,
  gadgetParams,
  gadgetPrefix,
  gadgetRegistrationBytes,
  gadgetRunnerSource,
  gadgetTimeoutMs,
  gadgetZip,
} from "@/lib/outputs/gadget";
import type { OutputAction, OutputProduct } from "@/lib/outputs/generate";
import { readZip } from "@/lib/outputs/zip";
import type { Manifest } from "@/lib/types";

const manifest = (actions: Manifest["actions"], name = "Shelf Counter"): Manifest => ({
  name,
  slug: "shelf-counter",
  tagline: "Counts what's on a shelf",
  inspiration: "a pantry",
  models: [{ id: "muse-wonder-1.0", usedFor: "counting" }],
  actions,
  fixtures: [],
  limits: [],
  estimatedCostPerRunUsd: 0.01,
});

const count: OutputAction = {
  name: "count_cans",
  description: "Counts the cans on a shelf.",
  input: {
    type: "object",
    required: ["shelf"],
    properties: {
      shelf: { type: "string", description: "Which shelf" },
      max: { type: "integer" },
      exact: { type: ["boolean", "null"] },
      mode: { enum: ["fast", "careful"] },
      tags: { type: "array", items: { type: "string" } },
      where: { type: "object", properties: { aisle: { type: "number" } } },
      anything: {},
    },
  },
  output: { type: "object" },
  example: { shelf: "top" },
};

const product = (actions: Manifest["actions"] = [count], over: Partial<OutputProduct> = {}): OutputProduct => ({
  slug: "shelf-counter",
  name: "Shelf Counter",
  tagline: "Counts what's on a shelf",
  liveUrl: "https://shelf.example",
  manifest: manifest(actions),
  ...over,
});

const act = (name: string, over: Partial<OutputAction> = {}): OutputAction => ({ name, description: `Does ${name}.`, input: { type: "object" }, output: { type: "object" }, ...over });

const files = (p: OutputProduct) => new Map(gadgetEntries(p).map((e) => [e.path, String(e.content)]));

describe("the gadget pack's names", () => {
  it("names each command <prefix>.<action> from the slug", () => {
    const pack = gadgetPack(product());
    assert.equal(pack.prefix, "shelf_counter");
    assert.equal(pack.libDir, "/usr/local/lib/shelf_counter-gadget");
    assert.deepEqual(pack.commands.map((c) => c.name), ["shelf_counter.count_cans"]);
  });

  it("keeps the SDK's reserved prefixes, digits first and odd characters out of the prefix", () => {
    for (const reserved of ["system", "file", "device", "link"]) assert.equal(gadgetPrefix(reserved), `mm_${reserved}`);
    assert.equal(gadgetPrefix("systems"), "systems");
    assert.equal(gadgetPrefix("2048"), "mm_2048");
    assert.equal(gadgetPrefix("2048-game"), "mm_2048_game");
    assert.equal(gadgetPrefix("--"), "mm");
    for (const slug of ["system", "file", "device", "link", "linker", "a-b-c", "x"]) {
      const name = gadgetPack({ ...product(), slug }).commands[0]!.name;
      assert.match(name, GADGET_NAME_RE);
      assert.ok(!GADGET_RESERVED_PREFIXES.some((r) => name.startsWith(r)), name);
    }
  });

  it("cuts a long slug, keeping two that start alike apart", () => {
    const a = gadgetPrefix("a-very-long-product-name-that-goes-on-and-on-one");
    const b = gadgetPrefix("a-very-long-product-name-that-goes-on-and-on-two");
    assert.ok(a.length <= 32 && b.length <= 32);
    assert.notEqual(a, b);
    assert.equal(a, gadgetPrefix("a-very-long-product-name-that-goes-on-and-on-one"));
  });

  it("gives every clashing action a hash of its own name, whatever their order", () => {
    const names = (actions: OutputAction[]) => gadgetPack(product(actions)).commands.map((c) => [c.action, c.name] as const);
    const one = names([act("get-item"), act("get_item"), act("other")]);
    const two = names([act("other"), act("get_item"), act("get-item")]);
    assert.deepEqual(new Map(one), new Map(two));
    const clashed = one.filter(([a]) => a !== "other").map(([, n]) => n!);
    assert.equal(new Set(clashed).size, 2);
    for (const n of clashed) assert.match(n, /^shelf_counter\.get_item_[0-9a-f]{6}$/);
    assert.equal(new Map(one).get("other"), "shelf_counter.other");
  });

  it("keeps a long name within 64 characters, and the SDK's rules", () => {
    const long = "x".repeat(70);
    const pack = gadgetPack({ ...product([act(long), act(`${long}y`), act("Get-Item")]), slug: "s".repeat(60) });
    for (const c of pack.commands) {
      assert.ok(c.name.length <= GADGET_MAX_NAME, c.name);
      assert.match(c.name, GADGET_NAME_RE);
    }
    assert.equal(new Set(pack.commands.map((c) => c.name)).size, 3);
    assert.match(pack.commands[2]!.name, /_[0-9a-f]{6}\.get_item$/);
  });

  it("leaves out owner actions, names unsafe in a web address and repeats", () => {
    const pack = gadgetPack(product([count, { ...act("read_mail"), who: "owner" }, act("../admin"), act("__proto__"), act("count_cans")]));
    assert.deepEqual(pack.commands.map((c) => c.action), ["count_cans"]);
    assert.deepEqual(pack.leftOut.map((l) => l.action), ["../admin", "__proto__", "count_cans"]);
    assert.ok(![...files(product([count, { ...act("read_mail"), who: "owner" }])).values()].some((f) => f.includes("read_mail")));
  });
});

describe("the gadget pack's command files", () => {
  it("are the SDK's shape: description, exec, required, optional and timeout_ms", () => {
    const spec = JSON.parse(files(product()).get("shelf-counter-muse-gadget/commands.d/shelf_counter.count_cans.json")!);
    assert.deepEqual(Object.keys(spec), ["description", "exec", "required", "optional", "timeout_ms"]);
    assert.equal(spec.description, "Shelf Counter: Counts the cans on a shelf.");
    assert.deepEqual(spec.exec, ["/usr/local/lib/shelf_counter-gadget/node", "/usr/local/lib/shelf_counter-gadget/runner.cjs", "count_cans"]);
    assert.deepEqual(spec.required, { shelf: { type: "string", description: "Which shelf." } });
    assert.deepEqual(
      Object.fromEntries(Object.entries(spec.optional as Record<string, { type: string }>).map(([k, v]) => [k, v.type])),
      { max: "integer", exact: "boolean", mode: "string", tags: "array", where: "object", anything: "string" },
    );
    assert.equal(spec.optional.mode.description, "One of: fast, careful.");
    assert.equal(spec.optional.max.description, "The max field, an integer.");
    assert.equal(spec.timeout_ms, 30_000);
  });

  it("takes only top-level fields, keeping a field called __proto__ a field", () => {
    const params = gadgetParams(JSON.parse('{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"number"},"ok":{"type":"string"}}}'));
    assert.ok(Object.hasOwn(params.required, "__proto__"));
    assert.equal(params.required.__proto__!.type, "number");
    assert.deepEqual(Object.keys(params.optional), ["ok"]);
    assert.deepEqual(gadgetParams({ type: "object" }), { required: {}, optional: {} });
  });

  it("uses the action's own timeout within the SDK's limits, or 30 s", () => {
    assert.equal(gadgetTimeoutMs(act("a")), 30_000);
    assert.equal(gadgetTimeoutMs({ ...act("a"), timeoutMs: 120_000 } as OutputAction), 120_000);
    assert.equal(gadgetTimeoutMs({ ...act("a"), timeoutMs: 9e9 } as OutputAction), 600_000);
    assert.equal(gadgetTimeoutMs({ ...act("a"), timeoutMs: 10 } as OutputAction), 2_000);
    assert.equal(gadgetTimeoutMs({ ...act("a"), timeoutMs: "60000" } as unknown as OutputAction), 30_000);
    assert.equal(gadgetTimeoutMs({ ...act("a"), timeoutMs: Number.NaN } as OutputAction), 30_000);
  });

  it("keeps hostile manifest text as data: JSON strings, never in the scripts or the runner", () => {
    const evil = "Counts.\n'; rm -rf / #\" $(curl evil.example) `id` </script>\u0007\u001b[31m";
    const p = product([act("go", { description: evil, input: { type: "object", properties: { "a'; rm -rf /": { type: "string", description: evil } } } })], { name: "Evil $(reboot)" });
    const all = files(p);
    const spec = JSON.parse(all.get("shelf-counter-muse-gadget/commands.d/shelf_counter.go.json")!);
    assert.equal(spec.description, "Evil $(reboot): Counts. '; rm -rf / #\" $(curl evil.example) `id` </script>[31m");
    assert.ok(Object.hasOwn(spec.optional, "a'; rm -rf /"));
    for (const file of ["install.sh", "uninstall.sh", "runner.cjs"]) {
      const text = all.get(`shelf-counter-muse-gadget/${file}`)!;
      for (const bit of ["rm -rf / #", "$(curl", "reboot", "</script>", "Counts."]) assert.ok(!text.includes(bit), `${file} has ${bit}`);
    }
    const readme = all.get("shelf-counter-muse-gadget/README.md")!;
    assert.match(readme, /^# shelf-counter for your Muse gadget$/m);
    assert.match(readme, /```text\nEvil \$\(reboot\)\n```/);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(readme));
    // A JSON value can't leave the runner's constant.
    assert.doesNotMatch(gadgetRunnerSource(gadgetPack(p), "https://x.example/</script>"), /<\/script>/);
  });

  it("caps descriptions, and leaves out what won't fit the gadget's registrations, in the order the SDK reads them", () => {
    const big = (name: string) =>
      act(name, {
        description: "d".repeat(5000),
        input: { type: "object", properties: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}`, { type: "string", description: "x".repeat(2000) }])) },
      });
    const pack = gadgetPack(product(Array.from({ length: 20 }, (_, i) => big(`a${String(i).padStart(2, "0")}`))));
    for (const c of pack.commands) {
      assert.ok(c.spec.description.length <= 1000);
      assert.equal(Object.keys(c.spec.optional).length, 64);
      assert.ok(Object.values(c.spec.optional).every((p) => p.description.length <= 300));
    }
    const total = pack.commands.reduce((sum, c) => sum + gadgetRegistrationBytes(c), 0);
    assert.ok(total <= GADGET_REGISTRATION_BUDGET, String(total));
    assert.ok(pack.commands.length > 0 && pack.leftOut.length > 0);
    const kept = pack.commands.map((c) => c.action);
    const dropped = pack.leftOut.map((l) => l.action);
    assert.ok(kept.every((k) => dropped.every((d) => k < d)), "the first names in order are the ones kept");
    assert.match(files(product(Array.from({ length: 20 }, (_, i) => big(`a${String(i).padStart(2, "0")}`)))).get("shelf-counter-muse-gadget/README.md")!, /## Left out/);
  });
});

describe("the gadget pack's zip", () => {
  it("has its files under one folder, and its README says what matters", () => {
    const zip = readZip(gadgetZip(product()));
    assert.deepEqual([...zip.keys()], [
      "shelf-counter-muse-gadget/README.md",
      "shelf-counter-muse-gadget/install.sh",
      "shelf-counter-muse-gadget/uninstall.sh",
      "shelf-counter-muse-gadget/runner.cjs",
      "shelf-counter-muse-gadget/commands.d/shelf_counter.count_cans.json",
    ]);
    const readme = zip.get("shelf-counter-muse-gadget/README.md")!.toString();
    assert.match(readme, /Linux Gadget SDK installed and paired with \*\*your own\*\* Muse account and \*\*your own\*\* SDK token/);
    assert.match(readme, /--run-as/);
    assert.match(readme, /https:\/\/shelf\.example\/api\/actions\/<action>/);
    assert.match(readme, /personal, non-commercial use/);
    assert.match(readme, /sold, advertised or listed, or given away in connection with a promotion, incentive or reward/);
    assert.match(readme, /never asks for your SDK token/);
    assert.match(readme, /Not an official Meta product/);
    assert.doesNotMatch(readme, /—/);
  });

  it("points at the address in the database row, whatever the manifest says", () => {
    const runner = files(product([count], { liveUrl: "https://row.example" })).get("shelf-counter-muse-gadget/runner.cjs")!;
    assert.match(runner, /"liveUrl":"https:\/\/row\.example"/);
    assert.match(runner, /"count_cans":\{"timeoutMs":30000\}/);
  });
});

describe("the gadget runner", () => {
  let server: Server;
  let live: string;
  let dir: string;
  const seen: Array<{ url: string; body: string; ua: string | undefined; method: string }> = [];
  let reply: (url: string) => { status: number; body: string; headers?: Record<string, string> } | null = () => ({ status: 200, body: '{"cans":4}' });

  const body = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = "";
      req.on("data", (c) => (text += c));
      req.on("end", () => resolve(text));
    });

  before(async () => {
    server = createServer(async (req, res) => {
      const text = await body(req);
      seen.push({ url: req.url ?? "", body: text, ua: req.headers["user-agent"], method: req.method ?? "" });
      const r = reply(req.url ?? "");
      if (!r) return; // Hangs, for the timeout.
      res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
      res.end(r.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    live = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(path.join(tmpdir(), "muse-gadget-runner-"));
    const pack = gadgetPack(product([count, { ...act("slow"), timeoutMs: 2_000 } as OutputAction]));
    writeFileSync(path.join(dir, "runner.cjs"), gadgetRunnerSource(pack, live));
  });

  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    seen.length = 0;
    reply = () => ({ status: 200, body: '{"cans":4}' });
  });

  const run = (args: string[], stdin: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(process.execPath, [path.join(dir, "runner.cjs"), ...args], { timeout: 20_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
      child.stdin!.end(stdin);
    });

  it("POSTs the JSON on stdin to the live action and prints the reply as one JSON object", async () => {
    const r = await run(["count_cans"], '{"shelf":"top"}');
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { cans: 4 });
    assert.equal(r.stderr, "");
    assert.deepEqual(seen.map((s) => [s.method, s.url, s.body]), [["POST", "/api/actions/count_cans", '{"shelf":"top"}']]);
    assert.match(seen[0]!.ua ?? "", /^MuseMuse-Gadget\//);
  });

  it("sends {} for empty stdin, and wraps a reply that isn't an object", async () => {
    reply = () => ({ status: 200, body: "[1,2]" });
    const r = await run(["count_cans"], "");
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), { result: [1, 2] });
    assert.equal(seen[0]!.body, "{}");
  });

  it("exits 1 with a one-line reason on stderr when the call fails", async () => {
    reply = () => ({ status: 500, body: JSON.stringify({ error: "the shelf\nis on fire\u001b[31m" }) });
    const r = await run(["count_cans"], "{}");
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "count_cans failed with HTTP 500: the shelf is on fire [31m\n");
  });

  it("refuses input that isn't a JSON object, an unknown action and a reply that isn't JSON", async () => {
    for (const [args, stdin, said] of [
      [["count_cans"], "not json", /^The input isn't JSON\.\n$/],
      [["count_cans"], "[1]", /^The input must be a JSON object\.\n$/],
      [["rm"], "{}", /^This pack has no action called rm\.\n$/],
      [[], "{}", /^This pack has no action called \(none\)\.\n$/],
      [["constructor"], "{}", /no action called constructor/],
    ] as const) {
      const r = await run([...args], stdin);
      assert.equal(r.code, 1);
      assert.match(r.stderr, said);
    }
    assert.equal(seen.length, 0);
    reply = () => ({ status: 200, body: "<html>" });
    const r = await run(["count_cans"], "{}");
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "count_cans answered with something that isn't JSON.\n");
  });

  it("doesn't follow a redirect, so the input can't be sent elsewhere", async () => {
    reply = (url) => (url.includes("count_cans") ? { status: 302, body: "", headers: { location: `${live}/elsewhere` } } : { status: 200, body: "{}" });
    const r = await run(["count_cans"], '{"shelf":"top"}');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^Couldn't reach the product to run count_cans\.\n$/);
    assert.deepEqual(seen.map((s) => s.url), ["/api/actions/count_cans"]);
  });

  it("stops before the gadget's timeout and says so", async () => {
    reply = () => null;
    const r = await run(["slow"], "{}");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^slow took longer than 1 s and was stopped\.\n$/);
  });

  it("says when a reply is too big for the gadget to pass back", async () => {
    reply = () => ({ status: 200, body: JSON.stringify({ text: "x".repeat(100 * 1024) }) });
    const r = await run(["count_cans"], "{}");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /more than a gadget passes back/);
  });

  it("never starts another program or a shell", () => {
    assert.doesNotMatch(GADGET_RUNNER_SOURCE, /child_process|\bexec\(|spawn|eval\(|new Function/);
  });
});

describe("install.sh and uninstall.sh", () => {
  let work: string;
  let pack: string;
  let stubs: string;
  let calls: string;

  /** Stands in for sudo: id says root, and chown and systemctl only write down what they were asked. */
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(stubs, name), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(stubs, name), 0o755);
  };

  const unpack = (p: OutputProduct, where: string) => {
    for (const [file, content] of readZip(gadgetZip(p))) {
      mkdirSync(path.dirname(path.join(where, file)), { recursive: true });
      writeFileSync(path.join(where, file), content);
    }
    return path.join(where, "shelf-counter-muse-gadget");
  };

  const sh = (script: string, args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync("bash", [path.join(pack, script), ...args], { encoding: "utf8", env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, ...env } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  const root = () => path.join(work, "root");
  const args = (more: string[] = []) => ["--root", root(), "--node", process.execPath, ...more];
  const mode = (file: string) => (statSync(file).mode & 0o777).toString(8);
  const cmdDir = () => path.join(root(), "etc/musegadget/commands.d");
  const libDir = () => path.join(root(), "usr/local/lib/shelf_counter-gadget");

  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), "muse-gadget-install-"));
    stubs = path.join(work, "stubs");
    calls = path.join(work, "calls.log");
    mkdirSync(stubs);
    stub("id", '[ "$1" = "-u" ] && echo 0 || command id "$@"');
    stub("chown", `echo "chown $*" >> '${calls}'`);
    stub("systemctl", `echo "systemctl $*" >> '${calls}'`);
    mkdirSync(path.join(root(), "opt/musegadget"), { recursive: true });
    // The SDK's token, which nothing here may read or change.
    mkdirSync(path.join(root(), "var/lib/musegadget"), { recursive: true });
    writeFileSync(path.join(root(), "var/lib/musegadget/sdk_token"), "mgst_fake\n");
    pack = unpack(product([count, act("add_can")]), path.join(work, "download"));
  });

  const log = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");

  it("pass bash -n and never name the SDK token", () => {
    for (const script of ["install.sh", "uninstall.sh"]) {
      assert.equal(spawnSync("bash", ["-n", path.join(pack, script)]).status, 0);
      assert.doesNotMatch(readFileSync(path.join(pack, script), "utf8"), /sdk_token|\/var\/lib\/musegadget|mgst_/);
    }
    rmSync(work, { recursive: true, force: true });
  });

  it("installs the commands owned by root, 0644 and 0755, and restarts the service", () => {
    const r = sh("install.sh", args());
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(readdirSync(cmdDir()).sort(), ["shelf_counter.add_can.json", "shelf_counter.count_cans.json"]);
    assert.equal(mode(path.join(cmdDir(), "shelf_counter.count_cans.json")), "644");
    assert.equal(mode(cmdDir()), "755");
    assert.equal(mode(libDir()), "755");
    assert.equal(mode(path.join(libDir(), "runner.cjs")), "755");
    assert.equal(readlinkSync(path.join(libDir(), "node")), process.execPath);
    assert.equal(readFileSync(path.join(libDir(), "commands.txt"), "utf8"), "shelf_counter.count_cans\nshelf_counter.add_can\n");
    assert.deepEqual(JSON.parse(readFileSync(path.join(cmdDir(), "shelf_counter.count_cans.json"), "utf8")), JSON.parse(readFileSync(path.join(pack, "commands.d/shelf_counter.count_cans.json"), "utf8")));
    assert.match(log(), new RegExp(`chown -- 0:0 ${path.join(cmdDir(), "shelf_counter.count_cans.json")}\\.tmp`));
    assert.match(log(), /chown -- 0:0 .*runner\.cjs\.tmp/);
    assert.match(log(), /^systemctl restart musegadget$/m);
    assert.equal(readFileSync(path.join(root(), "var/lib/musegadget/sdk_token"), "utf8"), "mgst_fake\n");
    assert.ok(!readdirSync(cmdDir()).some((f) => f.endsWith(".tmp")));
    rmSync(work, { recursive: true, force: true });
  });

  it("refuses to run without sudo, and changes nothing", () => {
    stub("id", '[ "$1" = "-u" ] && echo 1000 || command id "$@"');
    const r = sh("install.sh", args());
    assert.equal(r.code, 1);
    assert.match(r.err, /Run it with sudo: sudo bash install\.sh/);
    assert.ok(!existsSync(cmdDir()));
    assert.equal(sh("uninstall.sh", ["--root", root()]).code, 1);
    assert.equal(log(), "");
    rmSync(work, { recursive: true, force: true });
  });

  it("refuses without Meta's SDK, or with a commands folder others can write to", () => {
    rmSync(path.join(root(), "opt/musegadget"), { recursive: true });
    const noSdk = sh("install.sh", args());
    assert.equal(noSdk.code, 1);
    assert.match(noSdk.err, /Linux Gadget SDK isn't installed here/);
    mkdirSync(path.join(root(), "opt/musegadget"));
    mkdirSync(cmdDir(), { recursive: true });
    chmodSync(cmdDir(), 0o777);
    const open = sh("install.sh", args());
    assert.equal(open.code, 1);
    assert.match(open.err, /can be written by others/);
    assert.deepEqual(readdirSync(cmdDir()), []);
    rmSync(work, { recursive: true, force: true });
  });

  it("changes nothing in a dry run, with no sudo", () => {
    stub("id", '[ "$1" = "-u" ] && echo 1000 || command id "$@"');
    const r = sh("install.sh", args(["--dry-run"]));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /would run: cp -- .*shelf_counter\.count_cans\.json/);
    assert.match(r.out, /would run: systemctl restart musegadget/);
    assert.match(r.out, /Dry run: nothing was changed\./);
    assert.ok(!existsSync(cmdDir()) && !existsSync(libDir()));
    assert.equal(log(), "");
    rmSync(work, { recursive: true, force: true });
  });

  it("removes a command an earlier version added, and uninstall removes only its own files", () => {
    assert.equal(sh("install.sh", args()).code, 0);
    writeFileSync(path.join(cmdDir(), "pump.set.json"), "{}");
    // The next version drops add_can.
    pack = unpack(product([count]), path.join(work, "download2"));
    assert.equal(sh("install.sh", args(["--no-restart"])).code, 0);
    assert.deepEqual(readdirSync(cmdDir()).sort(), ["pump.set.json", "shelf_counter.count_cans.json"]);
    const r = sh("uninstall.sh", ["--root", root()]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(readdirSync(cmdDir()), ["pump.set.json"]);
    assert.ok(!existsSync(libDir()));
    assert.ok(existsSync(path.join(root(), "opt/musegadget")));
    assert.equal(readFileSync(path.join(root(), "var/lib/musegadget/sdk_token"), "utf8"), "mgst_fake\n");
    assert.match(r.out, /Removed 1 commands/);
    assert.equal(log().match(/systemctl restart musegadget/g)?.length, 2);
    rmSync(work, { recursive: true, force: true });
  });

  it("refuses a Node it can't use, and a linked commands folder", () => {
    const r = sh("install.sh", ["--root", root(), "--node", "node"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /--node must be a full path/);
    mkdirSync(path.join(root(), "etc/musegadget"), { recursive: true });
    mkdirSync(path.join(work, "elsewhere"));
    spawnSync("ln", ["-s", path.join(work, "elsewhere"), cmdDir()]);
    assert.ok(lstatSync(cmdDir()).isSymbolicLink());
    const linked = sh("install.sh", args());
    assert.equal(linked.code, 1);
    assert.match(linked.err, /is a link/);
    rmSync(work, { recursive: true, force: true });
  });
});
