/**
 * The cloud-config user data for a training instance: its shape, its size, and that the job token goes only into
 * job.json and no platform secret goes anywhere. Parses it as YAML when a parser is installed, otherwise checks the
 * structure line by line.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/userdata.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { RECIPES } from "@/lib/train/recipes";
import { RUNNER_PY } from "@/lib/train/recipes/runner";
import { SMOKE_PY } from "@/lib/train/recipes/smoke";
import type { RecipeId } from "@/lib/train/types";
import { buildUserData, callbackOrigin, deadlineEpochFor, JOB_LOG, MAX_USER_DATA_BYTES } from "@/lib/train/userdata";

const FAKE_LAMBDA_KEY = `secret_muse-test_${randomBytes(16).toString("hex")}.${randomBytes(16).toString("hex")}`;
const token = randomBytes(32).toString("base64url");
const input = {
  jobId: "6f1c2a9e-0000-4000-8000-000000000001",
  callbackBase: "https://muse.example.com/api/train/jobs/6f1c2a9e-0000-4000-8000-000000000001",
  token,
  recipe: "smoke" as RecipeId,
  params: {},
  maxMinutes: 30,
};

interface WrittenFile {
  path: string;
  owner: string;
  permissions: string;
  encoding: string;
  content: string;
}

/** A YAML parser from node_modules, when one is installed. */
async function yamlParser(): Promise<((text: string) => unknown) | null> {
  for (const name of ["yaml", "js-yaml"]) {
    try {
      const mod = await import(name);
      const parse = mod.parse ?? mod.load ?? mod.default?.parse ?? mod.default?.load;
      if (typeof parse === "function") return parse;
    } catch {
      // not installed
    }
  }
  return null;
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? JSON.parse(value) : value;
}

/** Reads the document's exact shape without a YAML library, failing on any line it doesn't expect. */
function parseByHand(doc: string): { write_files: WrittenFile[]; runcmd: unknown[] } {
  const lines = doc.split("\n");
  assert.equal(lines[0], "#cloud-config");
  const files: WrittenFile[] = [];
  const runcmd: unknown[] = [];
  let section = "";
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    assert.ok(!line.includes("\t"), "no tabs in YAML");
    const top = /^([a-z_]+):$/.exec(line);
    if (top) {
      section = top[1];
      assert.ok(section === "write_files" || section === "runcmd", `unexpected key ${section}`);
      continue;
    }
    if (section === "write_files") {
      const first = /^ {2}- path: (\S+)$/.exec(line);
      const field = /^ {4}(owner|permissions|encoding|content): (\S+)$/.exec(line);
      if (first) files.push({ path: first[1], owner: "", permissions: "", encoding: "", content: "" });
      else if (field && files.length) files[files.length - 1][field[1] as Exclude<keyof WrittenFile, "path">] = unquote(field[2]);
      else assert.fail(`unexpected write_files line: ${line.slice(0, 80)}`);
    } else if (section === "runcmd") {
      const item = /^ {2}- (\[.*\])$/.exec(line);
      assert.ok(item, `unexpected runcmd line: ${line.slice(0, 80)}`);
      runcmd.push(JSON.parse(item[1]));
    } else {
      assert.fail(`line outside a section: ${line.slice(0, 80)}`);
    }
  }
  return { write_files: files, runcmd };
}

function decode(f: WrittenFile): string {
  assert.equal(f.encoding, "b64");
  return Buffer.from(f.content, "base64").toString("utf8");
}

let previousKey: string | undefined;

before(() => {
  previousKey = process.env.LAMBDA_API_KEY;
  process.env.LAMBDA_API_KEY = FAKE_LAMBDA_KEY;
});

after(() => {
  if (previousKey === undefined) delete process.env.LAMBDA_API_KEY;
  else process.env.LAMBDA_API_KEY = previousKey;
});

describe("buildUserData", () => {
  it("is a #cloud-config document under 1 MB", () => {
    const doc = buildUserData(input);
    assert.ok(doc.startsWith("#cloud-config\n"));
    assert.ok(Buffer.byteLength(doc, "utf8") < MAX_USER_DATA_BYTES);
    assert.ok(Buffer.byteLength(doc, "utf8") < 1024 * 1024);
  });

  it("writes job.json, runner.py and recipe.py with the right modes and contents", async () => {
    const doc = buildUserData({ ...input, deadlineEpoch: 1_900_000_000 });
    const parse = await yamlParser();
    const parsed = (parse ? parse(doc) : parseByHand(doc)) as { write_files: WrittenFile[]; runcmd: unknown[] };
    const byPath = new Map(parsed.write_files.map((f) => [f.path, f]));
    assert.deepEqual([...byPath.keys()], ["/opt/muse/job.json", "/opt/muse/runner.py", "/opt/muse/recipe.py"]);
    assert.equal(byPath.get("/opt/muse/job.json")?.permissions, "0600");
    assert.equal(byPath.get("/opt/muse/runner.py")?.permissions, "0755");
    assert.equal(byPath.get("/opt/muse/recipe.py")?.permissions, "0644");
    for (const f of parsed.write_files) assert.equal(f.owner, "root:root");

    const job = JSON.parse(decode(byPath.get("/opt/muse/job.json")!));
    assert.deepEqual(job, { ...input, recipe: "smoke", deadlineEpoch: 1_900_000_000 });
    assert.equal(decode(byPath.get("/opt/muse/runner.py")!), RUNNER_PY);
    assert.equal(decode(byPath.get("/opt/muse/recipe.py")!), SMOKE_PY);

    assert.equal(parsed.runcmd.length, 1);
    const [cmd] = parsed.runcmd as string[][];
    assert.deepEqual(cmd.slice(0, 2), ["sh", "-c"]);
    assert.match(cmd[2], /nohup python3 -u \/opt\/muse\/runner\.py \/opt\/muse\/job\.json >> \/var\/log\/muse-job\.log 2>&1 < \/dev\/null &$/);
    assert.ok(cmd[2].includes(JOB_LOG));
  });

  it("accepts the recipe itself as well as its id", () => {
    const smoke = RECIPES.find((r) => r.id === "smoke")!;
    const fixed = { ...input, deadlineEpoch: 1_900_000_000 };
    assert.equal(buildUserData({ ...fixed, recipe: smoke }), buildUserData(fixed));
  });

  it("gives job.json a deadlineEpoch: the one asked for, or maxMinutes from now, rounded down", () => {
    const jobOf = (doc: string) => JSON.parse(decode(parseByHand(doc).write_files.find((f) => f.path.endsWith("job.json"))!));
    assert.equal(jobOf(buildUserData({ ...input, deadlineEpoch: 1_800_000_123 })).deadlineEpoch, 1_800_000_123);

    const before = Math.floor(Date.now() / 1000);
    const deadline = jobOf(buildUserData(input)).deadlineEpoch;
    const after = Math.floor(Date.now() / 1000);
    assert.ok(Number.isInteger(deadline));
    assert.ok(deadline >= before + 30 * 60 && deadline <= after + 30 * 60, `${deadline} is 30 minutes from now`);

    assert.equal(deadlineEpochFor(150, 1_700_000_000_999), 1_700_000_000 + 150 * 60);
    assert.equal(deadlineEpochFor(1.5, 1_700_000_000_000), 1_700_000_000 + 90);
  });

  it("puts the token only inside job.json", () => {
    const doc = buildUserData(input);
    assert.ok(!doc.includes(token), "the raw token is not in the document");
    const files = parseByHand(doc).write_files;
    for (const f of files) {
      const text = decode(f);
      if (f.path.endsWith("job.json")) assert.ok(text.includes(token));
      else assert.ok(!text.includes(token), `${f.path} has no token`);
    }
  });

  it("never carries LAMBDA_API_KEY or another env secret", () => {
    const doc = buildUserData(input);
    const texts = [doc, ...parseByHand(doc).write_files.map(decode)];
    const lambdaKeyShape = /secret_[A-Za-z0-9-]+_[0-9a-f]{16,}/;
    for (const text of texts) {
      assert.ok(!text.includes("LAMBDA_API_KEY"), "no mention of LAMBDA_API_KEY");
      assert.ok(!text.includes(FAKE_LAMBDA_KEY), "not the key's value");
      assert.ok(!lambdaKeyShape.test(text), "nothing shaped like a Lambda key");
      for (const [name, value] of Object.entries(process.env)) {
        if (!value || value.length < 12 || !/KEY|TOKEN|SECRET|PASSWORD|PEPPER|DATABASE_URL/i.test(name)) continue;
        assert.ok(!text.includes(value), `not the value of ${name}`);
      }
    }
  });

  it("adds cacheDir to job.json only when one is given, and fits the glimmer recipe under 1 MB", () => {
    const files = (doc: string) => new Map(parseByHand(doc).write_files.map((f) => [f.path, decode(f)]));
    assert.ok(!("cacheDir" in JSON.parse(files(buildUserData(input)).get("/opt/muse/job.json")!)));
    const glimmer = RECIPES.find((r) => r.id === "glimmer-lora")!;
    assert.equal(glimmer.usesCache, true);
    const doc = buildUserData({ ...input, recipe: glimmer, params: { datasetId: "ds-1" }, cacheDir: "/lambda/nfs/muse-muse-cache-us-east-1" });
    assert.ok(Buffer.byteLength(doc, "utf8") < MAX_USER_DATA_BYTES);
    const written = files(doc);
    const job = JSON.parse(written.get("/opt/muse/job.json")!);
    assert.equal(job.cacheDir, "/lambda/nfs/muse-muse-cache-us-east-1");
    assert.equal(job.recipe, "glimmer-lora");
    assert.equal(written.get("/opt/muse/recipe.py"), glimmer.script);
    assert.ok(!doc.includes(token));
  });

  it("adds serveKey next to the token in job.json only when one is given, and nowhere else", () => {
    const files = (doc: string) => new Map(parseByHand(doc).write_files.map((f) => [f.path, decode(f)]));
    assert.ok(!("serveKey" in JSON.parse(files(buildUserData(input)).get("/opt/muse/job.json")!)));
    const serveKey = randomBytes(32).toString("hex");
    const recipe = RECIPES.find((r) => r.id === "glimmer-serve") ?? "smoke";
    const doc = buildUserData({ ...input, recipe, params: { adapterJobId: "aaaaaaaa-0000-4000-8000-000000000000", minutes: 30 }, serveKey });
    assert.ok(Buffer.byteLength(doc, "utf8") < MAX_USER_DATA_BYTES);
    assert.ok(!doc.includes(serveKey), "the raw key is not in the document");
    for (const [path, text] of files(doc)) {
      if (path.endsWith("job.json")) {
        const job = JSON.parse(text);
        assert.equal(job.serveKey, serveKey);
        assert.equal(job.token, token);
      } else {
        assert.ok(!text.includes(serveKey), `${path} has no serving key`);
      }
    }
  });

  it("refuses an unknown recipe", () => {
    assert.throws(() => buildUserData({ ...input, recipe: "nope" as RecipeId }), /Unknown recipe/);
  });
});

describe("callbackOrigin", () => {
  it("takes only https on a public host, since the instance sends its job token there", () => {
    assert.equal(callbackOrigin("https://muse-muse.vercel.app"), "https://muse-muse.vercel.app");
    assert.equal(callbackOrigin("https://muse.example.com/"), "https://muse.example.com");
    assert.equal(callbackOrigin("http://muse.example.com"), null, "plain http would send the token in the clear");
    assert.equal(callbackOrigin("http://localhost:3000"), null);
    assert.equal(callbackOrigin("https://localhost"), null);
    assert.equal(callbackOrigin("https://10.0.0.5"), null);
    assert.equal(callbackOrigin("not a url"), null);
  });
});
