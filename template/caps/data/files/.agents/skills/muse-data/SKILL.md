---
name: muse-data
description: How a Muse Muse product saves items through the platform so they survive a reload and other people can see them, with passkey sign-in. Read it when brief.md has a "Saving data" section.
---

# Saving data

brief.md's "Saving data" section lists the collections: each one's name, scope, who writes it and what one item holds.
Save only those. The platform keeps the items; the product never has a database of its own.

## Scopes

| Scope | Who reads | Who writes | Kept for |
|---|---|---|---|
| `shared` | everyone on the product | the collection's rule: the owner, anyone signed in, or any visitor | everyone |
| `visitor` | this browser only | this browser | this browser, until its site data is cleared |
| `owner` | the product's owner, opened from Muse Muse | the owner | the owner |
| `user` | the person signed in with a passkey, on any device | that person | that person |

Personal details go only in collections the brief marks personal, which are never shared. Never put them in logs,
error messages or anything a model sees, unless the brief says so.

## The calls

Server code only: route handlers (`app/api/actions/<name>/route.ts`) and server actions. Pass the incoming request, or
`await headers()` in a server action, so the gateway knows who is asking.

```ts
import { data, deleteMine, CapError } from "@/lib/platform/data";

type Grocery = { name: string; bought: boolean };

export async function POST(request: Request) {
  const list = data(request).collection<Grocery>("groceries", { scope: "shared" });
  const body = (await request.json()) as { name?: string };
  if (!body.name?.trim()) return Response.json({ error: "Type what to buy." }, { status: 400 });
  try {
    const saved = await list.create({ name: body.name.trim().slice(0, 80), bought: false });
    return Response.json(saved);
  } catch (err) {
    if (err instanceof CapError) return Response.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }
}
```

- `.create(item)` saves a new item (a JSON object, at most 64 KB) and returns `{ id, version, createdAt, updatedAt }`.
- `.get(id)` gives `{ id, data, version, ... }` or null.
- `.put(id, item, { ifVersion })` replaces an item, or makes one with that id (handy for one settings item per
  person: `put("me", ...)` in a visitor or user collection). With `ifVersion` it refuses with code `version_conflict`
  when someone changed it since: reload it and show the newer one.
- `.delete(id)` deletes it.
- `.query({ where, order, limit, after })` lists items: `where` is top-level fields equal to plain values,
  `order` is `newest` (the default), `oldest` or `recent` (last changed), `limit` 1 to 100, and `after` is the page's
  `next` for more.
- `deleteMine(request)` deletes every visitor and user item this person saved. Give people a button for it.

Read the page's items on the server in the page itself (`data(await headers())`), or from an action route the page
calls. A page render can't set the visitor cookie, so a browser's first visit has no visitor items: that's right.

## Sign-in

```tsx
import { headers } from "next/headers";
import { SignIn } from "@/components/platform/SignIn";
import { currentUser } from "@/lib/platform/user";

const user = currentUser(await headers());
<SignIn user={user} returnTo="/" />
```

Sign-in is a passkey through Muse Muse: no email, no password, and the product never sees the passkey or the person's
Muse Muse id. `currentUser` gives `{ id, name }` from the cookie for showing who is signed in. The gateway checks the
session on every call, so don't use `currentUser` to decide who may see what: use the user scope.

## Limits a person can hit

64 KB an item; 200 items a visitor; 1,000 a signed-in person; 10,000 items and 50 MB for the product; 5,000 saves a
day; a shared collection any visitor writes takes 30 saves a minute from one person and 500 a day. A refused save is a
`CapError` with code `quota_exceeded` or `rate_limited`: show its message next to the save button.

## musemuse.json

Add `"caps": ["data"]` and a `data` block with exactly the brief's collections:

```json
"data": { "collections": [{ "name": "groceries", "scope": "shared", "writes": "anyone" }, { "name": "notes", "scope": "visitor" }] }
```

`writes` is only for shared collections: `owner`, `signed_in` or `anyone`. Verify checks the list against the brief.

## Tests

In a build every item is a real row in the build's own test space, deleted when the build ends, so a second browser
really sees what the first saved. Nothing a real person saved reaches a build. A real passkey can't be used in a test.

```ts
import { checkSecondBrowser, signInAs } from "../tests/caps/data";

await page.getByLabel("Add an item").fill("Oat milk");
await page.getByRole("button", { name: "Add" }).click();
await page.getByLabel("My note").fill("Ask about the blue tin");
await page.getByRole("button", { name: "Save note" }).click();
await checkSecondBrowser(page, { shared: "Oat milk", private: "Ask about the blue tin" });
```

- `checkSecondBrowser(page, { shared, private, user })` opens a second browser, reloads, expects the shared item and
  not the private one, and with `user: { name, text }` signs that made-up person in there and expects their item. It
  takes the judge screenshot `09-second-browser` and records the checks verify's caps step reads. Call it once.
- `signInAs(page, "Ana")` signs a made-up person in on a browser. The same name in the same build is the same person.
- `seed("groceries", [{ ... }])` saves shared items before the test opens the page.

Keep the smoke test to about 20 data calls. Assert what's on the screen, never exact counts other runs could change.

`lib/platform/data.ts`, `lib/platform/user.ts`, `components/platform/SignIn.tsx`, the routes in
`app/api/musemuse/user`, `app/api/musemuse/user-sign-out` and `app/api/musemuse/owner`, `tests/caps/data.ts` and
`scripts/caps/data.mjs` are platform files: verify puts them back. Wrap them, never edit them.
