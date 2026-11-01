import type { CapRenderEntry } from "@/lib/caps/render";
import { dataBlock, type DataBrief, type DataCollection } from "@/lib/caps/data/brief";
import { COLLECTION_NAME } from "@/lib/caps/data/types";

/**
 * The data cap's part of the prompts (docs/CAPABILITIES.md, 2.6 and section 9). Its text names the platform files in
 * template/caps/data and core: lib/platform/data.ts, lib/platform/user.ts, components/platform/SignIn.tsx,
 * tests/caps/data.ts and the muse-data skill.
 */

const SCOPE_WORDS: Record<DataCollection["scope"], string> = {
  shared: "shared: everyone sees it",
  visitor: "visitor: stays with one browser",
  owner: "owner: only the product's owner",
  user: "user: follows a person who signs in",
};

const WRITER_WORDS: Record<DataCollection["writes"], string> = {
  owner: "the owner",
  signed_in: "anyone signed in",
  anyone: "any visitor",
};

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

function collections(block: DataBrief): DataCollection[] {
  return block.collections.filter((c) => COLLECTION_NAME.test(c.name));
}

function table(block: DataBrief): string[] {
  return [
    "| Collection | Scope | Who writes | One item holds | Personal |",
    "|---|---|---|---|---|",
    ...collections(block).map(
      (c) => `| \`${c.name}\` | ${SCOPE_WORDS[c.scope]} | ${c.scope === "shared" ? WRITER_WORDS[c.writes] : "its own person"} | ${cell(c.holds)} | ${c.personal ? "yes" : "no"} |`,
    ),
  ];
}

function manifestLine(block: DataBrief): string {
  const list = collections(block).map((c) => ({ name: c.name, scope: c.scope, ...(c.scope === "shared" ? { writes: c.writes } : {}) }));
  return `- \`musemuse.json\` gets \`"caps": ["data"]\` and \`"data": ${JSON.stringify({ collections: list })}\`, exactly these collections. Verify checks it against this table.`;
}

export const DATA_RENDER: CapRenderEntry = {
  title: "Saving data",
  build(brief) {
    const block = dataBlock(brief);
    if (!block) return [];
    const has = (scope: DataCollection["scope"]) => collections(block).some((c) => c.scope === scope);
    const signIn = block.signIn !== "none";
    return [
      "The brief asks for items saved through the platform, in these collections:",
      "",
      ...table(block),
      "",
      `Sign-in: ${block.signIn === "required" ? "required. A person signs in before they can use the product's main flow" : block.signIn === "optional" ? "optional. Everything works without it, and signing in adds what the user collections hold" : "none"}.`,
      "",
      "- Read `.agents/skills/muse-data/SKILL.md` first. It has the helper calls, the scope rules and the test helpers.",
      "- Save and read only on the server, in route handlers or server actions, with `data(request).collection(\"<name>\", { scope: \"<scope>\" })` from `lib/platform/data.ts`: `.create(item)`, `.get(id)`, `.put(id, item, { ifVersion })`, `.delete(id)` and `.query({ where, order, limit, after })`. Pass the incoming request (or `await headers()`), so the gateway knows who is asking. The browser never calls the gateway.",
      ...(signIn
        ? [
            "- Sign-in: `currentUser(request)` from `lib/platform/user.ts` gives `{ id, name }` or null, and `<SignIn user={user} returnTo=\"/\" />` from `components/platform/SignIn.tsx` shows the passkey link or who is signed in, with Sign out. Show it in the app bar's action or the card it unlocks.",
          ]
        : []),
      manifestLine(block),
      "- Shared items: everyone on the product reads them. Writes follow the table. A write the gateway refuses comes back as a `CapError` with `code` `sign_in_required`: show the reason in plain words.",
      ...(has("visitor") ? ["- Visitor items stay with this browser (its `mm_vid` cookie). Clearing the site's data loses them, so say so next to them."] : []),
      ...(has("owner") ? ["- Owner items need the product's owner pass: only the owner, opened from Muse Muse, reads and writes them."] : []),
      ...(collections(block).some((c) => c.scope === "shared" && c.writes !== "owner")
        ? ["- In a shared collection anyone or signed-in people write, each of them can also change or delete what others added. Say so where it matters."]
        : []),
      ...(has("user") ? ["- User items follow the person who signed in, on any device. Without a session they read as none and writes answer `sign_in_required`."] : []),
      "- Personal details go only in the collections marked personal, never in a shared one, and never in a log or an error message.",
      "- Give people a way to delete what they saved: a button that calls `deleteMine(request)`, which removes every visitor and user item of this person.",
      "- Limits a user can hit: 64 KB an item, 200 items a visitor, 1,000 a signed-in person, 10,000 items and 50 MB for the product, 5,000 saves a day. A refused write is a `CapError` with `code` `quota_exceeded`: show its message next to the save button.",
      "- Never save what this list doesn't name.",
      "- Rows in this build are test rows, deleted when it ends. They are real rows in the build's own space on the gateway, so a second browser really sees them, and nothing a real person saved reaches this build.",
      ...(signIn ? ["- A real passkey can't be used in a build. Tests sign in a made-up person with `signInAs(page, \"Ana\")` from `tests/caps/data.ts`, which gives that browser a test session."] : []),
      "- A test's browser is a visitor, as on the live product: it can't use owner items or add to a list only the owner writes. `openAsOwner(page)` from `tests/caps/data.ts` makes it the owner for the owner's own steps; `seed(\"<name>\", [...])` saves shared items as the owner before the page opens.",
      "- Smoke test: call `checkSecondBrowser(page, { shared, private, loaded, user })` from `tests/caps/data.ts` once, after the first browser saved one shared item and one private one. It opens a second browser, reloads, expects the shared item and not the private one, signs the same made-up person in when you pass `user`, and takes the judge screenshot captioned \"Second browser\". With a private item and no shared one, pass `loaded`, text the page shows once its items are in. It records the check. Keep the smoke test to about 20 data calls.",
      "- `template/AGENTS.md` says \"Don't store personal data unless the brief says to\". This brief says to, only in the collections marked personal above. It also says the build machine reaches only npm, the Meta API and the Muse Muse gateway: saving goes through that gateway, so nothing more is opened.",
      "- `lib/platform/data.ts`, `lib/platform/user.ts`, `components/platform/SignIn.tsx`, the routes in `app/api/musemuse/user`, `app/api/musemuse/user-sign-out` and `app/api/musemuse/owner`, and `tests/caps/data.ts` are platform files. Wrap them, never edit them.",
    ];
  },
  refine(brief) {
    const block = dataBlock(brief);
    if (!block) return [];
    return [
      `- It saves items through the platform in ${collections(block)
        .map((c) => `\`${c.name}\` (${c.scope})`)
        .join(", ")} with \`data(request)\` from \`lib/platform/data.ts\` (\`.agents/skills/muse-data/SKILL.md\`). Keep those collections and scopes, and keep \`musemuse.json\`'s \`data\` block in step with them.`,
    ];
  },
  markdown(brief) {
    const block = dataBlock(brief);
    if (!block) return [];
    return [...table(block), "", `Sign-in: ${block.signIn}.`];
  },
};
