/**
 * The owner's shared accounts (lib/keys/shared.ts, docs/BUILD_KEYS.md): which services a build gets and under which
 * names, who may get them, the .env.local lines, the prompt section, and the leak guards. Every value here is made up.
 *
 *   npx tsx --test lib/keys/__tests__/shared.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  fleetHost,
  holdsSharedValue,
  principalMayUseSharedKeys,
  redactShared,
  redactSharedBytes,
  redactSharedValue,
  SHARED_ENV_NAMES,
  SHARED_SOURCE_NAMES,
  sharedEnvText,
  sharedKeysOn,
  sharedKeysPromptSection,
  sharedKeysRoomLine,
  sharedLeakLines,
  sharedLeaksIn,
  sharedNeedles,
  sharedServicesFrom,
  stripSharedEnvScript,
  valueEncodings,
  type SharedPrincipalUser,
} from "@/lib/keys/shared";

/** Made-up values in each service's shape. None is a real key. */
const FAKE = {
  BUILD_SHARED_VERCEL_TOKEN: "fakeVercelToken0123456789abcd",
  BUILD_SHARED_VERCEL_TEAM_ID: "team_fakeSharedTeam01",
  BUILD_SHARED_AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE0001",
  BUILD_SHARED_AWS_SECRET_ACCESS_KEY: "fakeAwsSecret/with+slash0123456789abcdEF",
  BUILD_SHARED_AWS_REGION: "us-west-2",
  BUILD_SHARED_LAMBDA_API_KEY: "secret_fake-lambda_0123456789abcdef",
  BUILD_SHARED_HF_TOKEN: "hf_fakeFakeFakeFakeFakeFakeFake0123",
  BUILD_SHARED_FLEET_URL: "https://fake-fleet.example.dev/v1",
  BUILD_SHARED_FLEET_KEY: "jik_fakefleetkey0123456789",
  BUILD_SHARED_COMPOSIO_API_KEY: "ak_fakeComposio0123456789",
  BUILD_SHARED_FIREWORKS_API_KEY: "fw_fakeFireworks0123456789",
  BUILD_SHARED_BASETEN_API_KEY: "fakeBaseten.0123456789abcdef",
  BUILD_SHARED_MODAL_TOKEN_ID: "ak-fakeModalId0123456789",
  BUILD_SHARED_MODAL_TOKEN_SECRET: "as-fakeModalSecret0123456789",
} as const;

const ADMINS = ["owner@example.com"];
const builder: SharedPrincipalUser = { email: "someone@example.com", isAdmin: false, bannedAt: null, hasPassword: true };

test("off unless BUILD_SHARED_KEYS is on", () => {
  assert.equal(sharedKeysOn({}), false);
  assert.equal(sharedKeysOn({ BUILD_SHARED_KEYS: "0" }), false);
  assert.equal(sharedKeysOn({ BUILD_SHARED_KEYS: "on" }), true);
});

test("every service is passed under its usual name, with only the hosts its key needs", () => {
  const { grant, skipped } = sharedServicesFrom(FAKE);
  assert.deepEqual(skipped, []);
  assert.deepEqual(grant.services, ["vercel", "aws", "lambda", "hf", "fleet", "composio", "fireworks", "baseten", "modal"]);
  assert.equal(grant.env.VERCEL_TOKEN, FAKE.BUILD_SHARED_VERCEL_TOKEN);
  assert.equal(grant.env.AWS_SECRET_ACCESS_KEY, FAKE.BUILD_SHARED_AWS_SECRET_ACCESS_KEY);
  assert.equal(grant.env.HF_TOKEN, FAKE.BUILD_SHARED_HF_TOKEN);
  assert.equal(grant.env.MODAL_TOKEN_SECRET, FAKE.BUILD_SHARED_MODAL_TOKEN_SECRET);
  assert.ok(!Object.keys(grant.env).some((k) => k.startsWith("BUILD_SHARED_")), "never the platform's own names");
  assert.ok(!grant.secretNames.includes("VERCEL_TEAM_ID") && !grant.secretNames.includes("AWS_REGION"), "a team id and a region aren't secrets");
  assert.ok(grant.secretNames.includes("FLEET_URL") && grant.secretNames.includes("FLEET_KEY"));
  for (const h of ["api.vercel.com", "*.us-west-2.amazonaws.com", "sts.amazonaws.com", "cloud.lambda.ai", "huggingface.co", "*.hf.co", "fake-fleet.example.dev", "backend.composio.dev", "api.fireworks.ai", "*.api.baseten.co", "api.modal.com"]) {
    assert.ok(grant.hosts.includes(h), h);
  }
  assert.equal(new Set(grant.hosts).size, grant.hosts.length);
  assert.deepEqual([...SHARED_ENV_NAMES].sort(), Object.keys(grant.env).sort());
  assert.ok(SHARED_SOURCE_NAMES.every((n) => n.startsWith("BUILD_SHARED_")));
});

test("only services that are set are passed, and only their hosts are opened", () => {
  const { grant } = sharedServicesFrom({ BUILD_SHARED_HF_TOKEN: FAKE.BUILD_SHARED_HF_TOKEN });
  assert.deepEqual(grant.services, ["hf"]);
  assert.deepEqual(Object.keys(grant.env), ["HF_TOKEN"]);
  assert.deepEqual(grant.hosts, ["huggingface.co", "*.huggingface.co", "*.hf.co"]);
});

test("the platform's own vars are never read", () => {
  const platform = { MODEL_API_KEY: "fake-model-key-0123456789", VERCEL_TOKEN: "fake-platform-vercel-0123456789", HF_TOKEN: "hf_fakePlatform0123456789abcdef", LAMBDA_API_KEY: "secret_fakeplatform0123456789", FIREWORKS_API_KEY: "fw_fakeplatform0123456789", BOARD_FLEET_TOKEN: "fake-board-token-0123456789" };
  const { grant } = sharedServicesFrom(platform);
  assert.deepEqual(grant.services, []);
  assert.deepEqual(grant.env, {});
});

test("a service is left out, with a reason that names vars and never values", () => {
  const cases: Array<[Record<string, string>, string, RegExp]> = [
    [{ BUILD_SHARED_AWS_ACCESS_KEY_ID: FAKE.BUILD_SHARED_AWS_ACCESS_KEY_ID }, "aws", /BUILD_SHARED_AWS_SECRET_ACCESS_KEY isn't set/],
    [{ BUILD_SHARED_HF_TOKEN: "hf_fake#value0123456789abc" }, "hf", /characters \.env\.local can't hold/],
    [{ BUILD_SHARED_HF_TOKEN: "hf_fake$value0123456789abc" }, "hf", /characters/],
    [{ BUILD_SHARED_HF_TOKEN: FAKE.BUILD_SHARED_HF_TOKEN, HF_TOKEN: FAKE.BUILD_SHARED_HF_TOKEN }, "hf", /one of the platform's own keys/],
    [{ BUILD_SHARED_FIREWORKS_API_KEY: "fw_same0123456789abcdef", MODEL_API_KEY: "fw_same0123456789abcdef" }, "fireworks", /platform's own keys/],
    [{ BUILD_SHARED_VERCEL_TOKEN: FAKE.BUILD_SHARED_VERCEL_TOKEN, BUILD_SHARED_VERCEL_TEAM_ID: "team_same", VERCEL_TEAM_ID: "team_same" }, "vercel", /platform's own team/],
    [{ BUILD_SHARED_FLEET_URL: "http://fake-fleet.example.dev", BUILD_SHARED_FLEET_KEY: FAKE.BUILD_SHARED_FLEET_KEY }, "fleet", /isn't a public https URL/],
  ];
  for (const [source, service, reason] of cases) {
    const { grant, skipped } = sharedServicesFrom(source);
    assert.ok(!grant.services.includes(service as never), service);
    const skip = skipped.find((s) => s.service === service);
    assert.match(skip?.reason ?? "", reason);
    for (const v of Object.values(source)) if (v.length > 12) assert.ok(!skip!.reason.includes(v), "no value in the reason");
  }
});

test("the fleet host comes from a public https URL only", () => {
  assert.equal(fleetHost("https://fake-fleet.example.dev/x"), "fake-fleet.example.dev");
  for (const bad of ["http://fake.example.dev", "https://localhost:8080", "https://10.0.0.5", "not a url", undefined]) assert.equal(fleetHost(bad), null, String(bad));
});

test("AWS opens its region's endpoints, us-east-1 by default", () => {
  const base = { BUILD_SHARED_AWS_ACCESS_KEY_ID: FAKE.BUILD_SHARED_AWS_ACCESS_KEY_ID, BUILD_SHARED_AWS_SECRET_ACCESS_KEY: FAKE.BUILD_SHARED_AWS_SECRET_ACCESS_KEY };
  assert.ok(sharedServicesFrom(base).grant.hosts.includes("*.us-east-1.amazonaws.com"));
  assert.ok(sharedServicesFrom({ ...base, BUILD_SHARED_AWS_REGION: "eu-west-1" }).grant.hosts.includes("*.eu-west-1.amazonaws.com"));
  assert.ok(!sharedServicesFrom({ ...base, BUILD_SHARED_AWS_REGION: "bad region" }).grant.hosts.some((h) => h.includes("bad")));
});

test("only a person signed in with the builder code gets them", () => {
  const may = (user: SharedPrincipalUser | null, kind: "build" | "refine" = "build", rebuildOf: string | null = null) => principalMayUseSharedKeys({ kind, rebuildOf, user }, ADMINS);
  assert.equal(may(builder), true, "a signed-in builder");
  assert.equal(may({ ...builder, email: "guest@musemuse.invalid" }), false, "the shared guest");
  assert.equal(may({ ...builder, email: "t-abc@trainer.musemuse.invalid" }), false, "a visitor trainer's row");
  assert.equal(may({ ...builder, bannedAt: new Date() }), false, "banned");
  assert.equal(may({ ...builder, hasPassword: false }), false, "never signed in with a code");
  assert.equal(may({ email: "owner@example.com", isAdmin: true, bannedAt: null, hasPassword: false }), true, "a listed admin (preview open access)");
  assert.equal(may({ email: "other@example.com", isAdmin: true, bannedAt: null, hasPassword: false }), false, "an admin flag without a listed email");
  assert.equal(may(null), false, "a row that's gone");
  assert.equal(may(builder, "build", "power:prod-1:abc"), false, "a build a product started");
  assert.equal(may(builder, "refine", "power:prod-1:abc"), true, "a person's change to such a product");
  assert.equal(may({ ...builder, email: "guest@musemuse.invalid" }, "refine"), false, "a guest's change");
});

test(".env.local gets the list of secret names, then each value; nothing without a grant", () => {
  assert.equal(sharedEnvText(null), "");
  const { grant } = sharedServicesFrom({ BUILD_SHARED_HF_TOKEN: FAKE.BUILD_SHARED_HF_TOKEN, BUILD_SHARED_AWS_ACCESS_KEY_ID: FAKE.BUILD_SHARED_AWS_ACCESS_KEY_ID, BUILD_SHARED_AWS_SECRET_ACCESS_KEY: FAKE.BUILD_SHARED_AWS_SECRET_ACCESS_KEY, BUILD_SHARED_AWS_REGION: "us-west-2" });
  const text = sharedEnvText(grant);
  assert.match(text, /^# The owner's shared accounts/);
  assert.match(text, /\nMUSEMUSE_SHARED_KEYS=AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY,HF_TOKEN\n/);
  assert.match(text, new RegExp(`\\nHF_TOKEN=${FAKE.BUILD_SHARED_HF_TOKEN}\\n`));
  assert.match(text, /\nAWS_REGION=us-west-2\n/);
  assert.ok(text.endsWith("\n"));
});

test("a Prove it copy's .env.local loses every shared line and keeps the rest", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "shared-strip-"));
  try {
    const file = path.join(dir, ".env.local");
    const { grant } = sharedServicesFrom(FAKE);
    writeFileSync(file, `# Written by the Muse Muse platform for this build. Never commit this file.\nGATEWAY_URL=https://gw.example\nPRODUCT_TOKEN=mm_build_fake\n${sharedEnvText(grant)}`);
    const res = spawnSync("bash", ["-c", stripSharedEnvScript(file)], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    const left = readFileSync(file, "utf8");
    assert.equal(left, "# Written by the Muse Muse platform for this build. Never commit this file.\nGATEWAY_URL=https://gw.example\nPRODUCT_TOKEN=mm_build_fake\n");
    assert.equal(spawnSync("bash", ["-c", stripSharedEnvScript(path.join(dir, "missing"))]).status, 0, "no file is fine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the prompt section names services and vars, never values, and is empty without a grant", () => {
  assert.equal(sharedKeysPromptSection(null, "build"), "");
  const { grant } = sharedServicesFrom(FAKE);
  const section = sharedKeysPromptSection(grant, "build");
  assert.match(section, /## The owner's service accounts/);
  assert.match(section, /- Hugging Face: `HF_TOKEN`/);
  assert.match(section, /- AWS: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`/);
  assert.match(section, /Muse Spark Open/);
  assert.match(sharedKeysPromptSection(grant, "change"), /This change can use/);
  for (const v of Object.values(FAKE)) assert.ok(!section.includes(v) || v === "us-west-2", "no value");
  const room = sharedKeysRoomLine(grant);
  assert.match(room, /Vercel, AWS, Lambda, Hugging Face, Jetson fleet, Composio, Fireworks, Baseten and Modal accounts/);
  for (const text of [section, room]) assert.ok(!text.includes("\u2014"), "no em dashes");
});

test("needles cover the value and its obvious encodings, and nothing short", () => {
  const v = FAKE.BUILD_SHARED_AWS_SECRET_ACCESS_KEY;
  const enc = valueEncodings(v);
  assert.ok(enc.includes(v));
  assert.ok(enc.includes(encodeURIComponent(v)));
  assert.ok(enc.includes(Buffer.from(v).toString("hex")));
  assert.ok(enc.includes(v.replace(/\//g, "\\/")));
  // Inside a longer base64 string at any offset (a Basic auth header, a JWT).
  for (const prefix of ["", "u", "us", "user:"]) {
    for (const kind of ["base64", "base64url"] as const) {
      const blob = Buffer.from(`${prefix}${v}:tail`).toString(kind);
      assert.ok(enc.some((e) => blob.includes(e)), `${kind} with prefix "${prefix}"`);
    }
  }
  assert.deepEqual(sharedNeedles({ BUILD_SHARED_HF_TOKEN: "hf_short" }), [], "too short to look for");
  assert.deepEqual(sharedNeedles({}), []);
  assert.ok(!sharedNeedles(FAKE).some((n) => n.text === FAKE.BUILD_SHARED_AWS_REGION), "a region is never redacted");
});

test("redaction takes every value out of text, JSON and bytes, and leaves everything as it was without values", () => {
  const token = FAKE.BUILD_SHARED_HF_TOKEN;
  const basic = Buffer.from(`user:${token}`).toString("base64");
  assert.equal(redactShared(`curl -H "Authorization: Bearer ${token}"`, FAKE), 'curl -H "Authorization: Bearer [redacted]"');
  assert.ok(!redactShared(`Authorization: Basic ${basic}`, FAKE).includes(basic));
  assert.equal(redactShared(`?key=${encodeURIComponent(FAKE.BUILD_SHARED_AWS_SECRET_ACCESS_KEY)}`, FAKE), "?key=[redacted]");
  const when = new Date("2026-11-02T00:00:00Z");
  const body = { type: "log", text: `got ${token}`, nested: [{ [token]: token }], at: when, n: 3 };
  const out = redactSharedValue(body, FAKE);
  assert.deepEqual(out, { type: "log", text: "got [redacted]", nested: [{ "[redacted]": "[redacted]" }], at: when, n: 3 });
  assert.ok(out.at instanceof Date, "a Date is left alone");
  assert.equal(body.text, `got ${token}`, "the input isn't changed");
  assert.equal(redactSharedValue(body, {}), body, "the same object with no values set");
  assert.equal(redactShared("plain", {}), "plain");
  const bytes = Buffer.from(`x${token}y`);
  assert.equal(redactSharedBytes(bytes, FAKE).toString(), "x[redacted]y");
  assert.equal(redactSharedBytes(bytes, {}), bytes);
  assert.equal(holdsSharedValue(bytes, FAKE), true);
  assert.equal(holdsSharedValue(Buffer.from("nothing here"), FAKE), false);
});

test("the product's files are checked for values, NEXT_PUBLIC_ names and names in next.config", () => {
  const file = (name: string, text: string) => ({ file: name, content: Buffer.from(text) });
  const files = [
    file("app/page.tsx", "export default function Page() { return null; }"),
    file("app/api/x/route.ts", `const t = "${FAKE.BUILD_SHARED_FIREWORKS_API_KEY}";`),
    file("lib/client.ts", "const k = process.env.NEXT_PUBLIC_HF_TOKEN;"),
    file("next.config.ts", "export default { env: { K: process.env.FIREWORKS_API_KEY } };"),
    file("lib/server.ts", "const k = process.env.HF_TOKEN;"),
  ];
  const leaks = sharedLeaksIn(files, { names: ["HF_TOKEN", "FIREWORKS_API_KEY"], source: FAKE });
  assert.deepEqual(
    leaks.map((l) => [l.file, l.name, l.why]),
    [
      ["app/api/x/route.ts", "FIREWORKS_API_KEY", "value"],
      ["lib/client.ts", "HF_TOKEN", "public-name"],
      ["next.config.ts", "FIREWORKS_API_KEY", "next-config"],
    ],
  );
  const lines = sharedLeakLines(leaks);
  assert.match(lines[0], /app\/api\/x\/route\.ts holds the value of FIREWORKS_API_KEY/);
  for (const l of lines) assert.ok(!l.includes(FAKE.BUILD_SHARED_FIREWORKS_API_KEY));
  assert.deepEqual(sharedLeaksIn(files, { source: {} }), [], "nothing set and no names: no check");
  assert.equal(sharedLeaksIn(files, { source: FAKE }).length, 1, "values are checked even without names");
});
