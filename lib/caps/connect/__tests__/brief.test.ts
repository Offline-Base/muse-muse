/**
 * The connect cap's brief block and prompts (docs/CAPABILITIES.md, section 11): the writer's raw block cleaned, the
 * writer's schema and rules following CONNECT_VAULT and CONNECT_SENDS, the stored brief parsing with and without it, and
 * what Muse Code, the judge and the product page are told.
 *
 *   npx tsx --test lib/caps/connect/__tests__/brief.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { briefToMarkdown, renderBuildPrompt } from "@/lib/brief/render";
import { BriefSchema, newBriefSchemaFor } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { capsWriterRules } from "@/lib/caps/brief-fields";
import { capsCatalogBlocks } from "@/lib/caps/catalog";
import { normalizeConnectBlock } from "@/lib/caps/connect/brief";
import { CAP_READY } from "@/lib/caps/ids";
import { capsJudgeNotes } from "@/lib/caps/judge";
import { capsFileFor } from "@/lib/caps/overlays";
import { capsRefineLines } from "@/lib/caps/render";
import { env } from "@/lib/env";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const ready = CAP_READY as Record<string, boolean>;
const FLAGS = ["CONNECT_ENABLED", "CONNECT_VAULT", "CONNECT_SENDS", "CONNECT_SENDS_PRODUCTION", "VERCEL_ENV"];
afterEach(() => {
  ready.connect = false;
  for (const f of FLAGS) delete process.env[f];
});

const CONNECT = {
  publicApis: ["nws"],
  keys: [{ service: "github", why: "Shows the owner's open issues." }],
  sends: [{ channel: "email" as const, why: "Sends the day's plan to the group." }],
};
const WITH = { ...BRIEF, connect: CONNECT };

describe("the writer's raw connect block", () => {
  it("keeps only allowlisted ids, each once, within the limits, and empties keys and sends that are switched off", () => {
    const raw = {
      publicApis: ["nws", "nws", "exa", "openlibrary", "usgs", "wikipedia", "constructor"],
      keys: [{ service: "github", why: "x".repeat(300) }, { service: "github", why: "again" }, { service: "resend", why: "a sender, not a call" }, { service: "stripe", why: "no" }],
      sends: [{ channel: "email", why: "plan" }, { channel: "sms", why: "no" }, { channel: "chat", why: "team" }, { channel: "email", why: "dup" }],
    };
    const on = normalizeConnectBlock(raw, { vault: true, sends: true }) as typeof CONNECT;
    assert.deepEqual(on.publicApis, ["nws", "openlibrary", "usgs", "wikipedia"]);
    assert.deepEqual(on.keys.map((k) => k.service), ["github"]);
    assert.ok(on.keys[0]!.why.length <= 200);
    assert.deepEqual(on.sends.map((s) => s.channel), ["email", "chat"]);
    const off = normalizeConnectBlock(raw, { vault: false, sends: false }) as typeof CONNECT;
    assert.deepEqual([off.keys, off.sends], [[], []]);
    assert.equal(normalizeConnectBlock({ publicApis: ["exa"], keys: [], sends: [] }, { vault: true, sends: true }), null, "asking for nothing is no block");
  });
});

describe("with the connect cap on", () => {
  it("offers the writer only allowlisted APIs, keys only with CONNECT_VAULT and sends only with CONNECT_SENDS, off production", () => {
    ready.connect = true;
    process.env.CONNECT_ENABLED = "1";
    assert.deepEqual(env.enabledCaps, ["connect"]);
    const schema = newBriefSchemaFor({ gadgets: false, targets: [], caps: ["connect"] });
    assert.equal(schema.safeParse({ ...BRIEF, connect: null }).success, true);
    assert.equal(schema.safeParse(WITH).success, false, "no keys or sends with the vault off");
    assert.equal(schema.safeParse({ ...BRIEF, connect: { ...CONNECT, keys: [], sends: [] } }).success, true);
    assert.equal(schema.safeParse({ ...BRIEF, connect: { publicApis: ["exa"], keys: [], sends: [] } }).success, false);
    assert.ok(strictJsonSchema(schema), "Meta's strict output takes it");
    assert.match(capsWriterRules(["connect"]), /connect\.keys: \[\]/);
    assert.match(capsWriterRules(["connect"]), /connect\.sends: \[\]/);
    process.env.CONNECT_VAULT = "1";
    process.env.CONNECT_SENDS = "1";
    const full = newBriefSchemaFor({ gadgets: false, targets: [], caps: ["connect"] });
    assert.equal(full.safeParse(WITH).success, true);
    assert.equal(full.safeParse({ ...BRIEF, connect: { ...CONNECT, sends: [{ channel: "sms", why: "x" }] } }).success, false, "no SMS yet");
    assert.match(capsWriterRules(["connect"]), /connect\.sends: up to 2 kinds of message/);
    assert.match(capsCatalogBlocks(["connect"]).join("\n"), /owner confirms that one message/);
    process.env.VERCEL_ENV = "production";
    assert.match(capsWriterRules(["connect"]), /connect\.sends: \[\]/, "sends stay off on production (decision 8)");
    assert.doesNotMatch(capsCatalogBlocks(["connect"]).join("\n"), /confirms that one message/);
  });

  it("names every API, path and credit in the catalog, and no em dash anywhere the writer reads", () => {
    process.env.CONNECT_VAULT = "1";
    process.env.CONNECT_SENDS = "1";
    const text = capsCatalogBlocks(["connect"]).join("\n") + capsWriterRules(["connect"]);
    for (const id of ["nws", "wikipedia", "openlibrary", "usgs", "github", "OpenWeather"]) assert.ok(text.includes(id), id);
    assert.ok(!text.includes("—"));
  });
});

describe("a brief with a connect block", () => {
  it("parses as a stored brief, as does one without it", () => {
    assert.equal(BriefSchema.safeParse(WITH).success, true);
    assert.equal(BriefSchema.safeParse(BRIEF).success, true);
    assert.equal(BriefSchema.safeParse({ ...BRIEF, connect: { ...CONNECT, sends: [{ channel: "payment", why: "later" }] } }).success, true, "the stored block takes every channel");
  });

  it("gives Muse Code an Outside services section, the overlay and the cap marker", () => {
    const prompt = renderBuildPrompt(WITH as never, { inspoFiles: [], fixtures: [], maxModelSteps: 40 } as never);
    assert.match(prompt, /## Platform services/);
    assert.match(prompt, /### Outside services/);
    for (const s of ["fetchPublic(request", "secrets(request).call", "<ConfirmSend", "<KeySettings", "checkFetchShown", "saveTestKey", "confirmSend(page)", "Weather from the National Weather Service", '"connect": {"publicApis":["nws"],"keys":["github"],"sends":["email"]}']) {
      assert.ok(prompt.includes(s), s);
    }
    assert.ok(!prompt.includes("—"));
    assert.deepEqual(capsFileFor(WITH as never), { caps: ["connect"], overlays: ["core", "connect"] });
    assert.ok(allowedModelsFor(WITH as never).includes("cap:connect"));
    assert.match(capsRefineLines(WITH as never).join("\n"), /never put a key in code/);
    assert.match(briefToMarkdown(WITH as never), /Owner's keys: GitHub/);
  });

  it("tells the judge samples are the product working and keys must never show", () => {
    const notes = capsJudgeNotes(WITH as never);
    assert.match(notes, /Sent \(sample\)/);
    assert.match(notes, /never show on any screen/);
    assert.match(notes, /recorded samples/);
    assert.equal(capsJudgeNotes(BRIEF as never), "");
  });
});
