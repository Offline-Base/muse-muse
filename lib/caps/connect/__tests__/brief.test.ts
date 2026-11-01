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
import { connectBuildBlock, normalizeConnectBlock } from "@/lib/caps/connect/brief";
import { connectOptions } from "@/lib/caps/connect/flags";
import { CAP_READY } from "@/lib/caps/ids";
import { capsJudgeNotes } from "@/lib/caps/judge";
import { capsFileFor } from "@/lib/caps/overlays";
import { capsRefineLines } from "@/lib/caps/render";
import { env } from "@/lib/env";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { catalogSummary } from "@/lib/prompts/catalog";
import { newBoxKey } from "@/lib/secrets/box";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const ready = CAP_READY as Record<string, boolean>;
const FLAGS = ["CONNECT_ENABLED", "CONNECT_VAULT", "CONNECT_VAULT_KEY", "CONNECT_SENDS", "CONNECT_SENDS_PRODUCTION", "VERCEL_ENV"];
/** The vault and sends on, with a made-up key ring, as a build that may use keys and sends has them. */
function vaultAndSendsOn() {
  process.env.CONNECT_VAULT = "1";
  process.env.CONNECT_SENDS = "1";
  process.env.CONNECT_VAULT_KEY = newBoxKey();
}
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
    assert.equal(newBriefSchemaFor({ gadgets: false, targets: [], caps: ["connect"] }).safeParse(WITH).success, false, "no keys while the vault has no key ring");
    assert.deepEqual(connectOptions(), { vault: false, sends: false });
    process.env.CONNECT_VAULT_KEY = "not a key";
    assert.deepEqual(connectOptions(), { vault: false, sends: false }, "a key ring that doesn't parse is no vault");
    process.env.CONNECT_VAULT_KEY = newBoxKey();
    assert.deepEqual(connectOptions(), { vault: true, sends: true });
    const full = newBriefSchemaFor({ gadgets: false, targets: [], caps: ["connect"] });
    assert.equal(full.safeParse(WITH).success, true);
    assert.equal(full.safeParse({ ...BRIEF, connect: { ...CONNECT, sends: [{ channel: "sms", why: "x" }] } }).success, false, "no SMS yet");
    assert.match(capsWriterRules(["connect"]), /connect\.sends: up to 2 kinds of message/);
    assert.match(capsCatalogBlocks(["connect"]).join("\n"), /owner confirms that one message/);
    process.env.VERCEL_ENV = "production";
    assert.match(capsWriterRules(["connect"]), /connect\.sends: \[\]/, "sends stay off on production (decision 8)");
    assert.doesNotMatch(capsCatalogBlocks(["connect"]).join("\n"), /confirms that one message/);
  });

  it("gives a fresh catalog in the same process when the vault or sends go on or off", () => {
    ready.connect = true;
    process.env.CONNECT_ENABLED = "1";
    assert.doesNotMatch(catalogSummary(["connect"]), /owner's own key|confirms that one message/);
    vaultAndSendsOn();
    assert.match(catalogSummary(["connect"]), /confirms that one message/);
    assert.match(catalogSummary(["connect"]), /owner's own key/);
    delete process.env.CONNECT_SENDS;
    assert.doesNotMatch(catalogSummary(["connect"]), /confirms that one message/);
    assert.match(catalogSummary(["connect"]), /owner's own key/);
  });

  it("names every API, path and credit in the catalog, and no em dash anywhere the writer reads", () => {
    vaultAndSendsOn();
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
    vaultAndSendsOn();
    const prompt = renderBuildPrompt(WITH as never, { inspoFiles: [], fixtures: [], maxModelSteps: 40 } as never);
    assert.match(prompt, /## Platform services/);
    assert.match(prompt, /### Outside services/);
    for (const s of ["fetchPublic(request", "secrets(request).call", "<ConfirmSend", "<KeySettings", "checkFetchShown", "saveTestKey", "confirmSend(page)", "Weather from the National Weather Service", '"connect": {"publicApis":["nws"],"keys":["github"],"sends":["email"]}']) {
      assert.ok(prompt.includes(s), s);
    }
    assert.ok(!prompt.includes("—"));
    const keySettings = prompt.match(/<KeySettings [^`]*\/>/)?.[0];
    assert.equal(keySettings, '<KeySettings keys={await secrets(await headers()).list()} returnTo="/settings" status={(await searchParams).key ?? null} />', "only props KeySettings has, as the skill shows");
    assert.deepEqual(capsFileFor(WITH as never), { caps: ["connect"], overlays: ["core", "connect"] });
    assert.ok(allowedModelsFor(WITH as never).includes("cap:connect"));
    assert.match(capsRefineLines(WITH as never).join("\n"), /never put a key in code/);
    assert.match(briefToMarkdown(WITH as never), /Owner's keys: GitHub/);
  });

  it("tells the judge samples are the product working and keys must never show", () => {
    vaultAndSendsOn();
    const notes = capsJudgeNotes(WITH as never);
    assert.match(notes, /Sent \(sample\)/);
    assert.match(notes, /never show on any screen/);
    assert.match(notes, /recorded samples/);
    assert.match(notes, /whole message on it, and nothing may send until the owner presses Confirm/);
    assert.equal(capsJudgeNotes(BRIEF as never), "");
  });

  it("leaves out keys and sends switched off since the brief was written, everywhere the build reads them", () => {
    const logs: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      process.env.CONNECT_VAULT = "1"; // on, but with no key ring: every save would be caps_paused
      const prompt = renderBuildPrompt(WITH as never, { inspoFiles: [], fixtures: [], maxModelSteps: 40 } as never);
      assert.match(prompt, /### Outside services/);
      for (const s of ["<KeySettings", "saveTestKey", "secrets(request).call", "Owner's key for", "<ConfirmSend", "confirmSend(page)"]) assert.ok(!prompt.includes(s), s);
      assert.ok(prompt.includes('"connect": {"publicApis":["nws"],"keys":[],"sends":[]}'), "the manifest line asks for no keys or sends");
      assert.deepEqual(connectBuildBlock(WITH), { publicApis: ["nws"], keys: [], sends: [] });
      assert.doesNotMatch(capsJudgeNotes(WITH as never), /never show|Sent \(sample\)/);
      assert.doesNotMatch(briefToMarkdown(WITH as never), /Owner's keys|Sends, each/);
      assert.doesNotMatch(capsRefineLines(WITH as never).join("\n"), /secrets\(request\)\.call|ConfirmSend/);
      assert.ok(logs.some((l) => /leaves out the brief's owner's keys \(github\).*and its sends \(email\)/.test(l)), logs.join("\n"));

      // A brief that only asked for keys still gets a section and the manifest line, so verify's manifest check passes.
      const keysOnly = renderBuildPrompt({ ...BRIEF, connect: { publicApis: [], keys: CONNECT.keys, sends: [] } } as never, { inspoFiles: [], fixtures: [], maxModelSteps: 40 } as never);
      assert.match(keysOnly, /switched off on Muse Muse right now/);
      assert.ok(keysOnly.includes('"connect": {"publicApis":[],"keys":[],"sends":[]}'));
      assert.ok(!keysOnly.includes("<KeySettings"));
    } finally {
      console.log = log;
    }
    vaultAndSendsOn();
    assert.equal(connectBuildBlock(WITH), WITH.connect, "with both on, the stored block as it is");
  });
});

describe("the product's privacy page", () => {
  it("says a key passes once through the product's own server when the owner saves it", async () => {
    const { productPrivacyFor } = await import("@/lib/trust/overlay");
    const keeps = JSON.stringify(productPrivacyFor(WITH as never));
    assert.match(keeps, /kept encrypted by Muse Muse/);
    assert.match(keeps, /passes once through this app's own server, when the owner saves it/);
  });
});
