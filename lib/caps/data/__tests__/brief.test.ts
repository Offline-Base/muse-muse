/**
 * The data cap's brief block and prompts (docs/CAPABILITIES.md, section 9): the writer's raw block cleaned, the stored
 * brief parsing with and without it, the writer's schema with the cap on, and what Muse Code and the judge are told.
 *
 *   npx tsx --test lib/caps/data/__tests__/brief.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderBuildPrompt, briefToMarkdown } from "@/lib/brief/render";
import { BriefSchema, newBriefSchemaFor } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { normalizeDataBlock } from "@/lib/caps/data/brief";
import { CAP_READY } from "@/lib/caps/ids";
import { capsJudgeNotes } from "@/lib/caps/judge";
import { capsRefineLines } from "@/lib/caps/render";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { capsFileFor } from "@/lib/caps/overlays";
import { env } from "@/lib/env";
import { briefInstructions } from "@/lib/prompts/brief";
import { catalogSummary } from "@/lib/prompts/catalog";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { productPrivacyFor } from "@/lib/trust/overlay";

const ready = CAP_READY as Record<string, boolean>;
afterEach(() => {
  ready.data = false;
  delete process.env.DATA_ENABLED;
});

const DATA = {
  collections: [
    { name: "groceries", scope: "shared" as const, writes: "anyone" as const, holds: "One thing to buy and whether it's bought.", personal: false },
    { name: "notes", scope: "visitor" as const, writes: "owner" as const, holds: "A private note.", personal: true },
    { name: "lists", scope: "user" as const, writes: "owner" as const, holds: "A person's own list.", personal: true },
  ],
  signIn: "optional" as const,
};
const WITH = { ...BRIEF, data: DATA };

describe("the writer's raw data block", () => {
  it("is cleaned: names in snake case and each once, at most 6, text clipped", () => {
    const out = normalizeDataBlock({
      collections: [
        { name: "Grocery Items", scope: "shared", writes: "anyone", holds: "x".repeat(300), personal: false },
        { name: "grocery_items", scope: "shared", writes: "anyone", holds: "dup", personal: false },
        ...Array.from({ length: 8 }, (_, i) => ({ name: `c${i}`, scope: "visitor", writes: "anyone", holds: "h", personal: false })),
      ],
      signIn: "none",
    }) as typeof DATA;
    assert.equal(out.collections.length, 6);
    assert.equal(out.collections[0]!.name, "grocery_items");
    assert.ok(out.collections[0]!.holds.length <= 200);
    assert.equal(out.collections[1]!.writes, "owner", "a private collection's writes is always owner");
  });

  it("never keeps personal details shared, turns sign-in on for user collections, and is null with no collection", () => {
    const moved = normalizeDataBlock({ collections: [{ name: "contacts", scope: "shared", writes: "anyone", holds: "A name and phone.", personal: true }], signIn: "none" }) as typeof DATA;
    assert.equal(moved.collections[0]!.scope, "visitor");
    const signedIn = normalizeDataBlock({ collections: [{ name: "contacts", scope: "shared", writes: "anyone", holds: "h", personal: true }], signIn: "optional" }) as typeof DATA;
    assert.equal(signedIn.collections[0]!.scope, "user");
    assert.equal((normalizeDataBlock({ collections: [{ name: "lists", scope: "user", writes: "owner", holds: "h", personal: false }], signIn: "none" }) as typeof DATA).signIn, "optional");
    assert.equal((normalizeDataBlock({ collections: [{ name: "posts", scope: "shared", writes: "signed_in", holds: "h", personal: false }], signIn: "none" }) as typeof DATA).signIn, "optional");
    assert.equal(normalizeDataBlock({ collections: [{ name: 7 }, { scope: "shared" }], signIn: "none" }), null);
    assert.equal(normalizeDataBlock({ collections: [] , signIn: "none" }), null);
  });
});

describe("the brief with a data block", () => {
  it("parses as stored, and an older brief without one parses unchanged", () => {
    assert.deepEqual(BriefSchema.parse(WITH).data, DATA);
    assert.ok(!("data" in BriefSchema.parse(BRIEF)));
  });

  it("is required but nullable in the writer's schema with the cap on, and gets the writer's rules and catalog entry", () => {
    ready.data = true;
    process.env.DATA_ENABLED = "1";
    assert.deepEqual(env.enabledCaps, ["data"]);
    const strict = strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: [], caps: env.enabledCaps })) as { required: string[] };
    assert.ok(strict.required.includes("data"));
    const rules = briefInstructions();
    assert.match(rules, /\n\nPlatform services\n- data: fill it only when the muse needs items that survive a reload/);
    assert.ok(rules.includes("Personal items go only in visitor, owner or user collections, never shared."));
    const catalog = catalogSummary();
    assert.match(catalog, /- data \(Saving\): a product can save items through the platform/);
    assert.match(catalog, /The platform services below add saved data, only when the brief picks them\./);
  });

  it("gives the token its marker and the build its overlays", () => {
    assert.ok(allowedModelsFor(WITH).includes("cap:data"));
    assert.deepEqual(capsFileFor(WITH), { caps: ["data"], overlays: ["core", "data"] });
  });

  it("tells Muse Code the collections, the skill, the helpers, the rules, the limits, the stand-in and the smoke test", () => {
    const prompt = renderBuildPrompt(WITH, { inspoFiles: [], fixtures: [], maxModelSteps: 40 });
    const at = prompt.indexOf("### Saving data");
    assert.ok(at > prompt.indexOf("## Platform services"));
    const section = prompt.slice(at, prompt.indexOf("\n## ", at + 1) === -1 ? undefined : prompt.indexOf("\n## ", at + 1));
    for (const part of [
      "| `groceries` | shared: everyone sees it | any visitor |",
      "| `notes` | visitor: stays with one browser | its own person |",
      "Sign-in: optional.",
      ".agents/skills/muse-data/SKILL.md",
      "data(request).collection(",
      "currentUser(request)",
      "<SignIn user={user}",
      '"data": {"collections":[{"name":"groceries","scope":"shared","writes":"anyone"},{"name":"notes","scope":"visitor"},{"name":"lists","scope":"user"}]}',
      "deleteMine(request)",
      "64 KB an item",
      "Never save what this list doesn't name.",
      "Rows in this build are test rows, deleted when it ends.",
      "signInAs(page, \"Ana\")",
      "checkSecondBrowser(page",
      "Don't store personal data unless the brief says to",
    ]) {
      assert.ok(section.includes(part), part);
    }
    assert.ok(!section.includes("—"), "no em dashes");
    assert.match(capsRefineLines(WITH).join("\n"), /`groceries` \(shared\), `notes` \(visitor\), `lists` \(user\)/);
    assert.match(briefToMarkdown(WITH), /\*\*Saving data\*\*/);
  });

  it("gives the judge its note, and the privacy page says what's kept", () => {
    assert.match(capsJudgeNotes(WITH), /The screenshot captioned 'Second browser' shows what another person sees after a reload\. Fail it if an item the brief says is shared is missing there/);
    const visitorOnly = { ...BRIEF, data: { ...DATA, collections: [DATA.collections[1]!] } };
    assert.match(capsJudgeNotes(visitorOnly), /Fail it if an item the brief keeps private to one person shows there\./);
    assert.match(String((productPrivacyFor(WITH).keeps as string[])[0]), /kept on Muse Muse's servers/);
  });
});
