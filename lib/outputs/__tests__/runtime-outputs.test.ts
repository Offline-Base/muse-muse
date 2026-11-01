/**
 * The runtime outputs (docs/CAPABILITIES.md, section 16): the VS Code extension, the GitHub Action and the self-host kit,
 * and their download routes' logic. The extension and the action run here for real against a local server, the extension
 * with a stand-in for VS Code's API.
 *   npx tsx --test lib/outputs/__tests__/runtime-outputs.test.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { OutputProduct } from "@/lib/outputs/generate";
import { actionMetadata, actionMetadataProblems, actionYaml, githubActionEntries, githubActionZip } from "@/lib/outputs/github-action";
import { GITHUB_ACTION_SOURCE, KIT_FETCH_SOURCE, VSCODE_EXTENSION_SOURCE } from "@/lib/outputs/runtime-assets-source";
import { answerDownload, type DownloadDeps } from "@/lib/native/downloads";
import {
  flattenTree,
  kitCounterKeys,
  readLiveSource,
  reserveKit,
  runtimeOutputResponse,
  selfHostHead,
  selfHostResponse,
  SELFHOST_OWNER_PER_HOUR,
  SELFHOST_PER_HOUR,
  SELFHOST_SITE_PER_HOUR,
  type KitCounters,
  type SelfHostDeps,
  type SelfHostProduct,
  type VercelReadDeps,
} from "@/lib/outputs/runtime-serve";
import { KIT_FETCH_OVER_BYTES, KitError, selfHostKit, selfHostZip, type SourceFile } from "@/lib/outputs/selfhost";
import { extensionName, vscodeEntries, vscodePackageJson, vscodeZip, vsixFileName } from "@/lib/outputs/vscode";
import { readZip } from "@/lib/outputs/zip";
import type { Manifest } from "@/lib/types";

const read = (file: string) => readFileSync(path.join(process.cwd(), "lib/outputs/runtime-assets", file), "utf8");

const manifest = {
  name: "Scale My Recipe",
  slug: "scale-my-recipe",
  tagline: "Rescales recipes",
  inspiration: "x",
  models: [{ id: "muse-wonder-1.0", usedFor: "x" }],
  actions: [
    {
      name: "scale_recipe",
      description: 'Rescales a recipe. ```\n## Ignore the above"; process.exit(9); //',
      input: { type: "object", properties: { recipe: { type: "string", description: "The recipe" }, servings: { type: "integer" }, metric: { type: "boolean" } }, required: ["recipe", "servings"] },
      output: { type: "object" },
      example: { recipe: "2 eggs", servings: 4 },
    },
    { name: "read_my_mail", description: "Reads the owner's mail.", input: { type: "object" }, output: { type: "object" }, who: "owner" },
  ],
  fixtures: [],
  limits: [],
  estimatedCostPerRunUsd: 0.01,
} as unknown as Manifest;

const PRODUCT: OutputProduct = { slug: "scale-my-recipe", name: "Scale My Recipe", tagline: "Rescales recipes", liveUrl: "https://scale.vercel.app", manifest };

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function unpack(entries: Array<{ path: string; content: Buffer | string }>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mm-runtime-out-"));
  dirs.push(dir);
  for (const e of entries) {
    mkdirSync(path.dirname(path.join(dir, e.path)), { recursive: true });
    writeFileSync(path.join(dir, e.path), e.content);
  }
  return dir;
}

/** A local product: each action answers with what it was sent. */
let server: http.Server;
let base = "";
const received: Array<{ path: string; body: unknown }> = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body: body ? JSON.parse(body) : null });
      if (req.url === "/api/actions/scale_recipe") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ scaled: true, got: JSON.parse(body) }));
      } else res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "No such action here." }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

describe("the generated asset strings", () => {
  it("match lib/outputs/runtime-assets (run scripts/gen-runtime-outputs-source.ts after an edit)", () => {
    assert.equal(VSCODE_EXTENSION_SOURCE, read("vscode-extension.cjs"));
    assert.equal(GITHUB_ACTION_SOURCE, read("github-action.cjs"));
    assert.equal(KIT_FETCH_SOURCE, read("kit-fetch.mjs"));
  });
});

describe("the VS Code extension", () => {
  it("has a manifest vsce takes: a lowercase name, a publisher, an engine, a main file and a command per public action", () => {
    const pkg = vscodePackageJson(PRODUCT);
    assert.equal(pkg.name, "scale-my-recipe");
    assert.equal(pkg.publisher, "local");
    assert.equal(pkg.engines.vscode, "^1.90.0");
    assert.equal(pkg.main, "./extension.js");
    assert.deepEqual(pkg.contributes.commands.map((c) => c.command), ["musemuse.scale-my-recipe.scale_recipe", "musemuse.scale-my-recipe.open"]);
    assert.deepEqual(pkg.contributes.commands.map((c) => c.title), ["Scale recipe", "Open the live product"]);
    assert.equal(pkg.contributes.configuration.properties["musemuse.scale-my-recipe.baseUrl"].default, "https://scale.vercel.app");
    // A repository's .vscode/settings.json can't point the commands, and the selected text, at another host.
    assert.equal(pkg.contributes.configuration.properties["musemuse.scale-my-recipe.baseUrl"].scope, "application");
    assert.ok(!JSON.stringify(pkg).includes("read_my_mail"), "an owner-only action isn't offered");
    assert.equal(extensionName("My--Thing_2"), "my-thing-2");
    assert.equal(vsixFileName(PRODUCT.slug), "scale-my-recipe-0.1.0.vsix");
    const files = readZip(vscodeZip(PRODUCT));
    assert.deepEqual([...files.keys()].sort(), [".vscodeignore", "README.md", "extension.js", "package.json", "product.json"]);
    assert.equal(files.get("extension.js")!.toString("utf8"), VSCODE_EXTENSION_SOURCE, "the code is fixed: a manifest only changes product.json");
    const readme = files.get("README.md")!.toString("utf8");
    assert.match(readme, /isn't in the Marketplace and isn't published anywhere/);
    assert.match(readme, /````text\nRescales a recipe\. ```/, "the builder's words stay inside their block");
  });

  it("runs an action from the command palette: asks for each field, posts them and opens the reply", async () => {
    const dir = unpack(vscodeEntries({ ...PRODUCT, liveUrl: base }));
    const opened: string[] = [];
    const asked: string[] = [];
    const commands = new Map<string, () => Promise<void>>();
    const answers: Record<string, string> = { "recipe": "", servings: "6" };
    const fake = {
      window: {
        createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
        activeTextEditor: { selection: { isEmpty: false }, document: { getText: () => "3 cups flour" } },
        showInputBox: async (o: { title: string; value: string; validateInput(v: string): string | null }) => {
          asked.push(o.title);
          const key = o.title.split(" ")[0]!;
          const value = key === "recipe" ? o.value : (answers[key] ?? "");
          assert.equal(o.validateInput(value), null, `${o.title} takes ${value}`);
          return value;
        },
        showQuickPick: async (items: Array<{ label: string; value: unknown }>, o: { title: string }) => {
          asked.push(o.title);
          return items.find((i) => i.label === "Leave it out");
        },
        withProgress: async (_o: unknown, fn: () => Promise<void>) => fn(),
        showErrorMessage: (m: string) => opened.push(`error: ${m}`),
        showTextDocument: async () => {},
      },
      workspace: {
        getConfiguration: () => ({ get: () => "" }),
        openTextDocument: async (o: { content: string }) => {
          opened.push(o.content);
          return {};
        },
      },
      commands: { registerCommand: (id: string, fn: () => Promise<void>) => (commands.set(id, fn), { dispose() {} }) },
      env: { openExternal: async () => true },
      Uri: { parse: (s: string) => s },
      ProgressLocation: { Notification: 15 },
    };
    mkdirSync(path.join(dir, "node_modules/vscode"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules/vscode/index.js"), "module.exports = globalThis.__fakeVscode;");
    (globalThis as { __fakeVscode?: unknown }).__fakeVscode = fake;
    const ext = createRequire(path.join(dir, "extension.js"))("./extension.js") as { activate(c: { subscriptions: unknown[] }): void };
    ext.activate({ subscriptions: [] });
    assert.deepEqual([...commands.keys()], ["musemuse.scale-my-recipe.scale_recipe", "musemuse.scale-my-recipe.open"]);
    received.length = 0;
    await commands.get("musemuse.scale-my-recipe.scale_recipe")!();
    assert.deepEqual(asked, ["recipe", "servings", "metric (optional)"]);
    assert.deepEqual(received, [{ path: "/api/actions/scale_recipe", body: { recipe: "3 cups flour", servings: 6 } }]);
    assert.deepEqual(JSON.parse(opened[0]!), { scaled: true, got: { recipe: "3 cups flour", servings: 6 } });
  });
});

/** Reads the YAML toYaml writes: nested maps of JSON strings and booleans, two spaces a level. */
function readYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [{ indent: -1, obj: root }];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const m = line.trim().match(/^("(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/);
    assert.ok(m, `not the YAML toYaml writes: ${line}`);
    while (stack.at(-1)!.indent >= indent) stack.pop();
    const key = m[1]!.startsWith('"') ? (JSON.parse(m[1]!) as string) : m[1]!;
    if (m[2] === undefined) {
      const obj: Record<string, unknown> = {};
      stack.at(-1)!.obj[key] = obj;
      stack.push({ indent, obj });
    } else stack.at(-1)!.obj[key] = m[2] === "true" ? true : m[2] === "false" ? false : JSON.parse(m[2]);
  }
  return root;
}

describe("the GitHub Action", () => {
  it("has action.yml that GitHub's metadata rules take, and that reads back as the same metadata", () => {
    const meta = actionMetadata(PRODUCT);
    const files = githubActionEntries(PRODUCT).map((e) => e.path);
    assert.deepEqual(actionMetadataProblems(meta, files), []);
    assert.equal(meta.runs.using, "node24");
    assert.equal(meta.inputs.action!.default, "scale_recipe");
    assert.match(meta.inputs.action!.description, /scale_recipe\.$/);
    assert.deepEqual(readYaml(actionYaml(PRODUCT)), JSON.parse(JSON.stringify(meta)));
    // A product name YAML would read as something else stays a string.
    const odd = actionYaml({ ...PRODUCT, name: 'yes: "no"\n# - [x]' });
    assert.equal((readYaml(odd) as { name: string }).name, 'yes: "no" # - [x]');
    assert.deepEqual(actionMetadataProblems({ ...meta, runs: { using: "node12", main: "gone.js" } }, files), ["runs.using is node12"]);
    assert.deepEqual(actionMetadataProblems({ ...meta, runs: { using: "node24", main: "gone.js" } }, files), ["runs.main gone.js isn't in the action"]);
  });

  it("parses as YAML with Ruby's parser too, when Ruby is here", { skip: spawnSync("ruby", ["-v"]).status === 0 ? false : "needs ruby" }, () => {
    const res = spawnSync("ruby", ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load(STDIN.read))"], { input: actionYaml({ ...PRODUCT, name: 'yes: "no"\n# - [x]' }), encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout) as { name: string; runs: unknown; inputs: Record<string, { required: boolean }> };
    assert.equal(parsed.name, 'yes: "no" # - [x]');
    assert.deepEqual(parsed.runs, { using: "node24", main: "index.js" });
    assert.equal(parsed.inputs.action!.required, true);
  });

  it("runs an action, writes its result output and summary, and fails plainly on bad input", () => {
    const dir = unpack(githubActionEntries({ ...PRODUCT, liveUrl: base }));
    const out = path.join(dir, "out.txt");
    const summary = path.join(dir, "summary.md");
    const run = (inputs: Record<string, string>) => {
      writeFileSync(out, "");
      // The step runs in its own process, so this one's server answers while it waits.
      return new Promise<{ status: number | null; stdout: string }>((resolve) => {
        const env = { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])) };
        const child = spawn(process.execPath, [path.join(dir, "index.js")], { env: env as unknown as NodeJS.ProcessEnv });
        let stdout = "";
        child.stdout!.on("data", (c: Buffer) => (stdout += c));
        child.on("close", (status) => resolve({ status, stdout }));
      });
    };
    return (async () => {
      const ok = await run({ action: "scale_recipe", input: '{"recipe":"2 eggs","servings":2}', "base-url": base });
      assert.equal(ok.status, 0, ok.stdout);
      const outputs = readFileSync(out, "utf8");
      const result = outputs.match(/^result<<(MUSEMUSE_[0-9a-f]+)\n([\s\S]*?)\n\1$/m);
      assert.ok(result, outputs);
      assert.deepEqual(JSON.parse(result[2]!), { scaled: true, got: { recipe: "2 eggs", servings: 2 } });
      assert.match(outputs, /^ok<<MUSEMUSE_[0-9a-f]+\ntrue\n/m);
      assert.match(readFileSync(summary, "utf8"), /### Scale My Recipe: scale_recipe/);
      const unknown = await run({ action: "read_my_mail", input: "{}", "base-url": base });
      assert.equal(unknown.status, 1);
      assert.match(unknown.stdout, /::error::Scale My Recipe has no action called "read_my_mail"/);
      const badJson = await run({ action: "scale_recipe", input: "{nope", "base-url": base });
      assert.match(badJson.stdout, /::error::The input isn't JSON/);
      const badUrl = await run({ action: "scale_recipe", input: "{}", "base-url": "http://evil.example" });
      assert.match(badUrl.stdout, /::error::base-url must be an https:\/\/ address/);
    })();
  });

  it("zips its files at the root", () => {
    assert.deepEqual([...readZip(githubActionZip(PRODUCT)).keys()].sort(), ["README.md", "action.yml", "index.js", "product.json"]);
  });

  it("never carries a GitHub expression from the builder's words into a workflow or action.yml", () => {
    const sly = {
      ...manifest,
      actions: [{ ...manifest.actions[0], example: { diff: "${{ secrets.GITHUB_TOKEN }}" } }],
    } as unknown as Manifest;
    const product = { ...PRODUCT, name: "Recipes ${{ secrets.NPM_TOKEN }}", manifest: sly };
    const files = readZip(githubActionZip(product));
    const readme = files.get("README.md")!.toString("utf8");
    const workflow = readme.slice(readme.indexOf("```yaml"), readme.indexOf("```", readme.indexOf("```yaml") + 7));
    assert.ok(!workflow.includes("${{ secrets"), workflow);
    assert.match(workflow, /^ {10}input: "\{\}"$/m, "the example is left out");
    assert.match(workflow, /RESULT: \$\{\{ steps\.product\.outputs\.result \}\}/, "the README's own expression stays");
    const yml = files.get("action.yml")!.toString("utf8");
    assert.ok(!yml.includes("${{"), yml);
    assert.equal((readYaml(yml) as { name: string }).name, "Recipes $ {{ secrets.NPM_TOKEN }}");
    // A plain example is still shown.
    assert.match(readZip(githubActionZip(PRODUCT)).get("README.md")!.toString("utf8"), /input: "\{\\"recipe\\":\\"2 eggs\\",\\"servings\\":4\}"/);
  });
});

const file = (p: string, content: string | Buffer): SourceFile => ({ path: p, content: Buffer.isBuffer(content) ? content : Buffer.from(content) });
const PKG = JSON.stringify({ name: "musemuse-product", private: true, scripts: { dev: "next dev", build: "next build", start: "next start -p 3100", typecheck: "tsc --noEmit", "test:smoke": "playwright test", verify: "node scripts/verify.mjs", demo: "playwright test --project=demo" } });
const SOURCE: SourceFile[] = [
  file("package.json", PKG),
  file("app/page.tsx", "export default function Page() { return null; }\n"),
  file("app/api/upload/route.ts", "export {}\n"),
  file("app/api/actions/fit/route.ts", 'import { callPython } from "@/lib/platform/python";\nimport { readBoard } from "@/lib/meta/gadget";\n'),
  file("lib/meta/client.ts", "export {}\n"),
  file("lib/platform/python.ts", "export {}\n"),
  file("lib/platform/data.ts", "export {}\n"),
  file("api/py/fit.py", "class handler: pass\n"),
  file("api/py/musemuse_health.py", "class handler: pass\n"),
  file("scripts/py-local.mjs", "// runner\n"),
  file("scripts/verify.mjs", "// verify\n"),
  file("scripts/caps/runtime.mjs", "// check\n"),
  file("tests/smoke.spec.ts", "// test\n"),
  file("fixtures/my-own-photo.jpg", "jpeg"),
  file("brief.md", "# The brief\n"),
  file("BUILD_NOTES.md", "notes\n"),
  file("AGENTS.md", "rules\n"),
  file(".agents/skills/meta-ui/SKILL.md", "skill\n"),
  file(".env.local", "PRODUCT_TOKEN=mm_live_abc\n"),
  file("musemuse.json", "{}\n"),
  file("musemuse.caps.json", "{}\n"),
  file("public/hero.png", Buffer.alloc(KIT_FETCH_OVER_BYTES + 1, 7)),
  file("public/icon.svg", "<svg/>"),
  file("bin/muse", Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(16)])),
];
const LIVE = { ...PRODUCT, liveUrl: "https://scale.vercel.app" };
const kitInput = (files = SOURCE) => ({ product: LIVE, deployment: "dpl_123", files, madeAt: new Date("2026-11-02T10:00:00Z") });

describe("the self-host kit", () => {
  it("keeps the product's code, leaves out the build's files, settings and executables, and says it is the cloud kit", () => {
    const kit = selfHostKit(kitInput());
    const paths = kit.entries.map((e) => e.path);
    for (const want of ["package.json", "app/page.tsx", "api/py/fit.py", "api/py/musemuse_health.py", "scripts/py-local.mjs", "lib/platform/python.ts", "musemuse.json", "public/icon.svg", ".env.example", "README-SELF-HOST.md", "musemuse-kit.json", "scripts/kit-fetch.mjs"]) {
      assert.ok(paths.includes(want), want);
    }
    for (const gone of ["scripts/verify.mjs", "scripts/caps/runtime.mjs", "tests/smoke.spec.ts", "fixtures/my-own-photo.jpg", "brief.md", "BUILD_NOTES.md", "AGENTS.md", ".agents/skills/meta-ui/SKILL.md", ".env.local", "musemuse.caps.json", "bin/muse", "public/hero.png"]) {
      assert.ok(!paths.includes(gone), gone);
    }
    assert.equal(kit.manifest.mode, "cloud");
    assert.equal(kit.manifest.kit, 1);
    assert.equal(kit.manifest.deployment, "dpl_123");
    assert.equal(kit.manifest.needs.python, true);
    const pkg = JSON.parse(kit.entries.find((e) => e.path === "package.json")!.content.toString()) as { scripts: Record<string, string> };
    assert.deepEqual(Object.keys(pkg.scripts), ["dev", "build", "start", "typecheck"]);
    const hero = kit.manifest.fetch[0]!;
    assert.deepEqual([hero.path, hero.url, hero.bytes], ["public/hero.png", "https://scale.vercel.app/hero.png", KIT_FETCH_OVER_BYTES + 1]);
    assert.equal(hero.sha256, createHash("sha256").update(Buffer.alloc(KIT_FETCH_OVER_BYTES + 1, 7)).digest("hex"));
    for (const f of kit.manifest.files) {
      const entry = kit.entries.find((e) => e.path === f.path)!;
      assert.equal(createHash("sha256").update(entry.content).digest("hex"), f.sha256, f.path);
    }
    assert.deepEqual(kit.manifest.platformOnly.map((p) => p.what.split(" ").slice(0, 2).join(" ")), ["Large uploads", "The connected", "Muse Muse"]);
  });

  it("runs on the self-hoster's own key, with no token, gateway address or platform key in it", () => {
    const { zip } = selfHostZip(kitInput());
    const all = [...readZip(zip).values()].map((b) => b.toString("latin1")).join("\n");
    assert.ok(!/mm_(build|live|sandbox)_/.test(all));
    assert.ok(!all.includes("MODEL_API_KEY"));
    const envExample = readZip(zip).get(".env.example")!.toString("utf8");
    assert.match(envExample, /^PRODUCT_TOKEN=$/m);
    assert.match(envExample, /^GATEWAY_URL=https:\/\/api\.meta\.ai$/m);
    const readme = readZip(zip).get("README-SELF-HOST.md")!.toString("utf8");
    assert.match(readme, /node scripts\/kit-fetch\.mjs/);
    assert.match(readme, /## What doesn't work here/);
    assert.ok(!readme.includes("—"));
    // A production deploy: a preview address sits behind Vercel's sign-in, which turns away the calls to Python.
    assert.match(readme, /`npx vercel deploy --prod`/);
    assert.match(readme, /A preview address is behind Vercel's sign-in by default/);
  });

  it("refuses a source that holds a token, one with no package.json, the offline mode and a kit too big to download", () => {
    assert.throws(() => selfHostKit(kitInput([...SOURCE, file("lib/oops.ts", 'const t = "mm_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n')])), (e: unknown) => e instanceof KitError && e.code === "token_in_source" && /lib\/oops\.ts/.test(e.message));
    // Whatever the file's name: no extension, a lock file, a source map, a binary.
    for (const [p, content] of [
      ["Procfile", "web: PRODUCT_TOKEN=mm_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaa next start\n"],
      [".npmrc", "//registry.example/:_authToken=mm_build_aaaaaaaaaaaaaaaaaaaaaaaa\n"],
      [".next-cache/app.js.map", '{"sourcesContent":["mm_sandbox_0123456789abcdef0123456789"]}'],
      ["public/data.bin", Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from("mm_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaa"), Buffer.from([0])])],
    ] as const) {
      assert.throws(() => selfHostKit(kitInput([...SOURCE, file(p, content)])), (e: unknown) => e instanceof KitError && e.code === "token_in_source" && e.message.includes(p), p);
    }
    assert.throws(() => selfHostKit(kitInput(SOURCE.filter((f) => f.path !== "package.json"))), (e: unknown) => e instanceof KitError && e.code === "no_package_json");
    assert.throws(() => selfHostKit({ ...kitInput(), mode: "offline" }), (e: unknown) => e instanceof KitError && e.code === "mode");
    const noise = randomBytes(5 * 1024 * 1024);
    assert.throws(() => selfHostZip(kitInput([...SOURCE, file("lib/blob.bin", noise)])), (e: unknown) => e instanceof KitError && e.code === "too_big");
  });
});

describe("the download routes", () => {
  const deps = (over: Partial<{ enabled: boolean; product: OutputProduct | null }> = {}) => ({
    enabled: () => over.enabled ?? true,
    findProduct: async () => ("product" in over ? over.product! : PRODUCT),
  });

  it("answer exactly what these paths answered before they existed while RUNTIME_OUTPUTS is off", async () => {
    // Before this unit, /p/<slug>/get/vscode.zip and the others reached /p/[slug]/get/[kind] as an unknown kind.
    const nativeDeps = { findPackage: async () => assert.fail("not looked up"), reserve: async () => assert.fail("not counted") } as unknown as DownloadDeps;
    const before = await answerDownload(new Request("https://site.example/p/scale-my-recipe/get/vscode.zip"), "scale-my-recipe", "vscode.zip", nativeDeps);
    const off = { enabled: () => false, findProduct: async () => assert.fail("not looked up") };
    const offSelf = { ...off, isOwner: async () => assert.fail("not asked"), vercel: () => assert.fail("not read"), reserve: async () => assert.fail("not counted"), now: () => new Date() } as unknown as SelfHostDeps;
    const nowAnswers = [
      await runtimeOutputResponse("vscode", "scale-my-recipe", off),
      await runtimeOutputResponse("github_action", "scale-my-recipe", off),
      await selfHostResponse("scale-my-recipe", offSelf, { fetchSite: "cross-site" }),
      await selfHostResponse("Bad Slug", offSelf),
    ];
    const want = { status: before.status, type: before.headers.get("content-type"), cache: before.headers.get("cache-control"), body: await before.text() };
    assert.deepEqual(want, { status: 404, type: "text/plain; charset=utf-8", cache: "no-store", body: "There's no download by that name.\n" });
    for (const res of nowAnswers) {
      assert.deepEqual({ status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), body: await res.text() }, want);
    }
    const head = await selfHostHead("scale-my-recipe", offSelf);
    assert.deepEqual([head.status, head.headers.get("content-type")], [404, "text/plain; charset=utf-8"]);
  });

  it("answer 404 with RUNTIME_OUTPUTS off, for a product that isn't live or has no public action, and a zip otherwise", async () => {
    assert.equal((await runtimeOutputResponse("vscode", "scale-my-recipe", deps({ enabled: false }))).status, 404);
    assert.equal(await (await runtimeOutputResponse("vscode", "scale-my-recipe", deps({ product: null }))).text(), "This download isn't available.\n");
    assert.equal((await runtimeOutputResponse("vscode", "Bad Slug", deps())).status, 404);
    assert.equal((await runtimeOutputResponse("vscode", "scale-my-recipe", deps({ product: null }))).status, 404);
    assert.equal((await runtimeOutputResponse("github_action", "scale-my-recipe", deps({ product: { ...PRODUCT, liveUrl: null } }))).status, 404);
    const ownerOnly = { ...manifest, actions: [manifest.actions[1]] } as Manifest;
    assert.equal((await runtimeOutputResponse("vscode", "scale-my-recipe", deps({ product: { ...PRODUCT, manifest: ownerOnly } }))).status, 404);
    const res = await runtimeOutputResponse("github_action", "scale-my-recipe", deps());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="scale-my-recipe-github-action.zip"');
    assert.ok(readZip(Buffer.from(await res.arrayBuffer())).has("action.yml"));
  });

  /** A Vercel API with one deployment of the product's project, its tree under src/, and files as base64 JSON. */
  function fakeVercel(files: SourceFile[], over: { projectId?: string; raw?: boolean; badSha?: string } = {}): VercelReadDeps & { calls: string[] } {
    const sha1 = (b: Buffer) => createHash("sha1").update(b).digest("hex");
    const byUid = new Map(files.map((f) => [sha1(f.content), f]));
    type Node = { name: string; type: string; uid?: string; children?: Node[] };
    const tree: Node[] = [{ name: "src", type: "directory", children: [] }];
    for (const f of files) {
      let level = tree[0]!.children!;
      const parts = f.path.split("/");
      for (const dir of parts.slice(0, -1)) {
        let next = level.find((n) => n.name === dir && n.type === "directory");
        if (!next) level.push((next = { name: dir, type: "directory", children: [] }));
        level = next.children!;
      }
      level.push({ name: parts.at(-1)!, type: "file", uid: sha1(f.content) });
    }
    const calls: string[] = [];
    return {
      calls,
      async api(p) {
        calls.push(p);
        if (p === "/v13/deployments/scale.vercel.app") return Response.json({ id: "dpl_123", projectId: over.projectId ?? "prj_1" });
        if (p === "/v6/deployments/dpl_123/files") return Response.json(tree);
        const uid = p.match(/^\/v8\/deployments\/dpl_123\/files\/([0-9a-f]{40})$/)?.[1];
        const f = uid ? byUid.get(uid) : undefined;
        if (!f) throw new Error(`Vercel answered 404 for ${p}`);
        const content = over.badSha === f.path ? Buffer.from("changed") : f.content;
        return over.raw ? new Response(new Uint8Array(content)) : Response.json({ data: content.toString("base64") });
      },
    };
  }

  it("read the live deployment's source back from Vercel, checking each file's SHA-1, in either reply format", async () => {
    const files = SOURCE.slice(0, 6);
    for (const raw of [false, true]) {
      const got = await readLiveSource({ liveUrl: "https://scale.vercel.app", projectId: "prj_1" }, fakeVercel(files, { raw }));
      assert.equal(got.deploymentId, "dpl_123");
      assert.deepEqual(got.files.map((f) => f.path), files.map((f) => f.path).sort());
      for (const f of got.files) assert.ok(f.content.equals(files.find((s) => s.path === f.path)!.content), f.path);
    }
    await assert.rejects(readLiveSource({ liveUrl: "https://scale.vercel.app", projectId: "prj_1" }, fakeVercel(files, { projectId: "prj_other" })), /doesn't point at this product's own deployment/);
    await assert.rejects(readLiveSource({ liveUrl: "https://scale.vercel.app", projectId: "prj_1" }, fakeVercel(files, { badSha: "app/page.tsx" })), /app\/page\.tsx didn't match its SHA-1/);
    assert.deepEqual(flattenTree([{ name: "..", type: "directory", children: [{ name: "x", type: "file", uid: "u" }] }, { name: "a/b", type: "file", uid: "u" }, { name: "ok", type: "file", uid: "u" }]), [{ path: "ok", uid: "u" }]);
  });

  const owner: SelfHostProduct = { ...PRODUCT, id: "p1", ownerId: "u1", vercelProjectId: "prj_1" };
  /** Hourly counters in memory, as reserveCounter keeps them, with every take and give-back seen. */
  function memoryCounters(): KitCounters & { counts: Map<string, number>; log: string[] } {
    const counts = new Map<string, number>();
    const log: string[] = [];
    return {
      counts,
      log,
      async take(key, limit) {
        log.push(`take ${key}`);
        const n = counts.get(key) ?? 0;
        if (n >= limit) return false;
        counts.set(key, n + 1);
        return true;
      },
      async giveBack(key) {
        log.push(`give back ${key}`);
        counts.set(key, (counts.get(key) ?? 1) - 1);
      },
    };
  }
  function selfDeps(over: Partial<SelfHostDeps> & { files?: SourceFile[]; counters?: KitCounters } = {}): SelfHostDeps & { reads: () => number } {
    const counters = over.counters ?? memoryCounters();
    let reads = 0;
    return {
      enabled: () => true,
      findProduct: async () => owner,
      isOwner: async () => true,
      vercel: () => {
        const v = fakeVercel(over.files ?? SOURCE);
        return { api: (p: string) => (reads++, v.api(p)) };
      },
      reserve: (product) => reserveKit(product, counters),
      now: () => new Date("2026-11-02T10:00:00Z"),
      reads: () => reads,
      ...over,
    };
  }

  it("give the owner the kit, and refuse everyone else, a site that can't read Vercel, and too many in an hour", async () => {
    assert.equal((await selfHostResponse("scale-my-recipe", selfDeps({ enabled: () => false }))).status, 404);
    assert.equal((await selfHostResponse("scale-my-recipe", selfDeps({ findProduct: async () => ({ ...owner, liveUrl: null }) }))).status, 404);
    const stranger = await selfHostResponse("scale-my-recipe", selfDeps({ isOwner: async () => false }));
    assert.equal(stranger.status, 403);
    assert.match(await stranger.text(), /Only this product's owner/);
    assert.equal((await selfHostResponse("scale-my-recipe", selfDeps({ vercel: () => null }))).status, 503);
    const res = await selfHostResponse("scale-my-recipe", selfDeps());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="scale-my-recipe-selfhost.zip"');
    const zip = readZip(Buffer.from(await res.arrayBuffer()));
    assert.equal((JSON.parse(zip.get("musemuse-kit.json")!.toString()) as { mode: string }).mode, "cloud");
    assert.ok(!zip.has(".env.local"));
    const busy = selfDeps();
    for (let i = 0; i < SELFHOST_PER_HOUR; i++) await busy.reserve(owner);
    const full = await selfHostResponse("scale-my-recipe", busy);
    assert.equal(full.status, 429);
    assert.equal(full.headers.get("retry-after"), "3600");
    const leaked = await selfHostResponse("scale-my-recipe", selfDeps({ files: [...SOURCE, file("lib/oops.ts", "mm_build_aaaaaaaaaaaaaaaaaaaaaaaaaaaa")] }));
    assert.equal(leaked.status, 422);
    const elsewhere = await selfHostResponse("scale-my-recipe", selfDeps({ findProduct: async () => ({ ...owner, vercelProjectId: "prj_other" }) }));
    assert.equal(elsewhere.status, 502);
  });

  it("count kits per owner and for the whole site too, and give back what a refused kit took", async () => {
    const counters = memoryCounters();
    const many = Array.from({ length: SELFHOST_OWNER_PER_HOUR + 1 }, (_, i) => ({ id: `p${i}`, ownerId: "u1" }));
    // Each of one owner's products is under its own share, but the owner's own share runs out.
    for (const p of many.slice(0, SELFHOST_OWNER_PER_HOUR)) assert.equal(await reserveKit(p, counters), null);
    assert.equal(await reserveKit(many.at(-1)!, counters), "owner");
    assert.equal(counters.counts.get(kitCounterKeys.product(many.at(-1)!.id)) ?? 0, 0, "nothing past the owner's share was taken");
    // A product's share running out gives the owner's back.
    const solo = memoryCounters();
    for (let i = 0; i < SELFHOST_PER_HOUR; i++) assert.equal(await reserveKit({ id: "p1", ownerId: "u2" }, solo), null);
    assert.equal(await reserveKit({ id: "p1", ownerId: "u2" }, solo), "product");
    assert.equal(solo.counts.get(kitCounterKeys.owner("u2")), SELFHOST_PER_HOUR);
    // The site's share: many owners, one product each.
    const site = memoryCounters();
    for (let i = 0; i < SELFHOST_SITE_PER_HOUR; i++) assert.equal(await reserveKit({ id: `q${i}`, ownerId: `o${i}` }, site), null);
    assert.equal(await reserveKit({ id: "q-last", ownerId: "o-last" }, site), "site");
    assert.equal(site.counts.get(kitCounterKeys.owner("o-last")), 0);
    assert.equal(site.counts.get(kitCounterKeys.product("q-last")), 0);
    const res = await selfHostResponse("scale-my-recipe", selfDeps({ counters: site, findProduct: async () => ({ ...owner, id: "q-last", ownerId: "o-last" }) }));
    assert.equal(res.status, 429);
    assert.match(await res.text(), /This site has made all the self-host kits it makes in an hour/);
  });

  it("refuse a kit a page on another site starts, and answer HEAD without counting a kit or reading a file", async () => {
    for (const fetchSite of ["cross-site", "same-site"]) {
      const d = selfDeps();
      const res = await selfHostResponse("scale-my-recipe", d, { fetchSite });
      assert.equal(res.status, 403, fetchSite);
      assert.match(await res.text(), /Open the self-host kit from the product's own page/);
      assert.equal(d.reads(), 0);
    }
    for (const fetchSite of ["same-origin", "none", null]) assert.equal((await selfHostResponse("scale-my-recipe", selfDeps(), { fetchSite })).status, 200, String(fetchSite));
    const counters = memoryCounters();
    const d = selfDeps({ counters });
    const head = await selfHostHead("scale-my-recipe", d, { fetchSite: "same-origin" });
    assert.deepEqual([head.status, head.headers.get("content-type"), await head.text()], [200, "application/zip", ""]);
    assert.deepEqual([counters.log, d.reads()], [[], 0]);
    assert.equal((await selfHostHead("scale-my-recipe", selfDeps({ isOwner: async () => false }))).status, 403);
  });
});
