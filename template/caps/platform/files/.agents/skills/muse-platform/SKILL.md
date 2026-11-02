---
name: muse-platform
description: How this product runs its own build sandboxes, hands out metered model keys and publishes new products. Read it before you use lib/platform/powers.ts.
---

# Platform powers

`lib/platform/powers.ts` has one helper per call. Use them only in server routes, and pass the owner's pass from the `mm_owner` cookie. Without a valid pass they answer `sign_in_required`. Visitors can't use these at all, so show these screens only to the owner.

## What each does

- `powers(pass)`: which powers this product has, `spentTodayUsd` and `dailyLimitUsd`.
- `startSandbox(pass, task)`, `sandboxEvents`, `sandboxResult`, `stopSandbox`: a build task in a private sandbox, with no product code in it. It has a time and spending limit, then it stops and keeps what it made.
- `makeKey(pass, {label, budgetUsd, hours})`, `revokeKey`: a metered key for `POST {GATEWAY_URL}/v1/responses` on one model. It ends at its budget or its expiry.
- `startProduct(pass, note)`, `noteWithChatbot(note, purpose)`, `productStatus`: builds and publishes a new product for the owner. A build takes minutes to hours, so show its status and let the owner leave the page.

## A chatbot in what it makes

When the owner wants a chatbot in what this product makes, use `startProduct(pass, noteWithChatbot(note, purpose))`. The new product is a real one, with its own link, its own metered token and a daily budget, so its chat keeps working and nothing here pays for it. Show its status and link when it's live. Say that first: it's the route that works.

- Code from `startSandbox` comes back as files. It can include chat code that reads `GATEWAY_URL` and `PRODUCT_TOKEN` from the server's env, but it has no link of its own, so it can't chat until it's published through `startProduct`. Say that plainly on screen.
- A key from `makeKey` is for trying something for a short while: at most 24 hours and $5. It answers on `POST /v1/responses` only, with no web search, stored items or remote files. Never write one into generated code.
- If this product has a chatbot of its own, use `lib/meta/chat.ts` and read `.agents/skills/meta-chat`.

Only the owner can start any of this. A public site where visitors make their own apps isn't possible, so say that in the product's limits.

## Limits

Every start counts its worst case against the product's daily limit at once. A call past it answers `budget_exceeded`, and daily counts answer `rate_limited`. Say so plainly, with when it resets (00:00 UTC). A product started here can't use these powers itself.

## Secrets

This product holds no platform secret and never needs one. Everything goes through `PRODUCT_TOKEN`. A key from `makeKey` is shown once to the owner: don't store it in the browser, a log or the source.

## Tests

During a build every call answers `simulated: true`, spends nothing and starts nothing, so test the screens with it. `productStatus` always says `live` with no link, and `key` is a stand-in. Keep what is simulated out of the demo's claims.
