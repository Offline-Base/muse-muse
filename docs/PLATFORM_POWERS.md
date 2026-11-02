# Platform powers

The `platform` cap lets a product act as a small Muse Muse for its owner. It's behind `PLATFORM_POWERS`, off by default. `CAP_READY.platform` is true so a Preview can turn it on with a snapshot that has the overlay; production stays off until its owner sets the flag. No product has been published through it yet.

| Power | Route under `{GATEWAY_URL}` | What it is |
|---|---|---|
| `sandboxes` | `POST /platform/sandboxes`, then `/:id/events`, `steer`, `stop`, `result` | A Muse Code session in a sandbox of its own, with every check `/code/sessions` has. Needs `MUSE_CODE_ENABLED` |
| `gateway` | `POST /platform/keys`, `POST /platform/keys/:id/revoke` | A metered key, `mm_pk_...`: `POST /v1/responses` only, one model, its own budget and expiry |
| `publish` | `POST /platform/products`, `GET /platform/products/:buildId` | A normal build owned by the product's owner, through the same brief policy, checks and publishing |

`GET /platform` gives its powers, today's limit and what's committed. The overlay in `template/caps/platform` has the helpers and the skill.

## Who can use it

- Only the product's owner, by their signed pass. Visitors and signed-in end users are refused.
- Guests can't, two ways: the writer never gets the cap from a guest's build (`capsForBuilder`, whatever `TRUST_SIGNED_IN_CAPS` says), and the gate refuses a guest's product (check 4).
- A product a power started can't have or use powers, at the writer and at the route, so it can't recurse. Its build also can't chain.
- A build's own tests get `simulated: true`: no spend, no sandbox, no product.

## A chatbot in what it makes

The route is `startProduct(pass, noteWithChatbot(note, purpose))`: a child is a normal build, so it lists Muse Wonder and gets its own token and daily budget, and no key goes in anyone's source. Sandboxes return files with no link, and metered keys are short and can't use web search, so neither is the route to a lasting chatbot. Visitors of a builder product still can't build, and guests never get the cap.

## Why the limits are hard

Each start adds its worst case to a day's counter in one atomic statement, refused if it wouldn't fit: `PLATFORM_POWERS_PRODUCT_DAILY_USD` ($20) for the product and `PLATFORM_POWERS_ALL_DAILY_USD` ($50) for everyone. `DAILY_SPEND_CAP_USD` holds on top. The worst cases are real bounds:

- A sandbox: its $1 session budget and its whole time in the sandbox.
- A key: its whole budget, at most `PLATFORM_POWERS_KEY_MAX_USD` ($5).
- A product: `PLATFORM_POWERS_BUILD_USD` ($12), above the build token's $10 for the brief and judge calls. Its own daily token budget is separate once it's live, and it's a product like any other.

Nothing is given back after a start succeeds, so the counter can read higher than real spend. Daily counts: 10 sandboxes, 10 keys, 2 products.

## No platform secrets in a product

A product holds only `GATEWAY_URL` and `PRODUCT_TOKEN`, as always. Sandboxes get the session's own scoped token, keys are their own scoped tokens stored as hashes, and new builds run on the platform's side.

## Why there's no migration

The counters are `rate_limits` rows, a child's mark is `power:<parent>:<id>` in `builds.rebuild_of`, which matches no catalog id, and keys are `gateway_tokens` rows with scope `power_key`.

## What the first real run must check

Needs `CAP_READY.platform` set true on the test branch, a new builder snapshot recorded with the `platform` overlay, and `FULL_BUILDS` if it's for a big product. Made-up data on a Preview. A Preview doesn't publish, so a real link needs a separate decision.

1. A note asking for an app builder gets a platform block, a guest's identical note doesn't, and a refused note stays refused.
2. The overlay installs, verify passes on `simulated` answers, and the judge isn't told a simulated product is real.
3. As the owner on the product: start a sandbox, read events and result, and see the counter go up by its worst case. As a visitor: refused.
4. A key works on `POST /v1/responses`, is refused elsewhere, stops at its budget, dies at expiry and at revoke, and can't open any cap route.
5. `POST /platform/products` starts a build under the owner, it counts against the owner's build quota, and its brief has no platform block.
6. The product's limit refuses the next start, with two of them racing.
7. A scan of the product's source, env and logs finds no platform secret.
8. Taking the product down kills its keys.
