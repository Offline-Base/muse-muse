---
name: muse-connect
description: How a Muse Muse product reaches outside services through the platform: keyless public APIs (weather, Wikipedia, books, earthquakes), the owner's own keys for a few services, and messages the owner confirms before they go. Read it when brief.md has an "Outside services" section.
---

# Outside services

brief.md's "Outside services" section lists what this product may reach: public APIs, services it calls with the
owner's own key, and kinds of message it sends. Use only those. Everything goes through the Muse Muse gateway, on the
server: route handlers (`app/api/actions/<name>/route.ts`) and server actions. Pass the incoming request, or
`await headers()` in a server action, so the gateway knows who is asking. The browser never calls the gateway, and
never calls an outside API itself.

A refused call throws `CapError` (`code`, `status`, plain `message`): show the message in plain words next to what the
person did. `switched_off` means Muse Muse has the service off right now: say so and keep the rest working.

## Public APIs: `fetchPublic`

```ts
import { fetchPublic } from "@/lib/platform/fetch-public";

const spot = await fetchPublic(request, { api: "nws", path: "/points/38.8894,-77.0352" });
const p = (spot.data as { properties: { gridId: string; gridX: number; gridY: number } }).properties;
const forecast = await fetchPublic(request, { api: "nws", path: `/gridpoints/${p.gridId}/${p.gridX},${p.gridY}/forecast` });
// forecast.status is the API's own (200, or 404 for a place it doesn't know); forecast.credit is the line to show.
```

- `path` is one of the paths below with its values filled in. Query parameters go in `query`, never in `path`, and
  only the ones listed for that path. Anything else is refused by name.
- Show `credit` next to what the API gave, every time.
- The platform caches answers for everyone, for minutes to a day by path, so a product never needs its own cache.
- Limits a person can hit: 20 calls a minute from one person, 60 a minute and 2,000 a day for the product. A refused
  call is a `CapError` with code `rate_limited`: say "Too many lookups right now, try again in a minute".

### `nws`: US weather from the National Weather Service

Credit to show: "Weather from the National Weather Service". US places only.

- `/points/{lat},{lon}` (`nws.points`): The forecast office and grid square for a US place, by latitude and longitude (4 decimals at most). Its properties.forecast link is the forecast path.
- `/gridpoints/{office}/{x},{y}/forecast` (`nws.forecast`): The 7-day forecast for a grid square, in 12-hour periods. Query: `units` (`us` or `si`).
- `/gridpoints/{office}/{x},{y}/forecast/hourly` (`nws.forecast_hourly`): The hourly forecast for a grid square. Query: `units`.
- `/alerts/active` (`nws.alerts`): Active weather alerts for a state (area=KS) or a point (point=38.89,-77.03). Query: `area`, `point`.

### `wikipedia`: Wikipedia article summaries and search (English)

Credit to show: "From Wikipedia, under CC BY-SA 4.0, with a link to the article". Link each summary to its
`content_urls.desktop.page`.

- `/api/rest_v1/page/summary/{title}` (`wikipedia.summary`): One article's title, short description, first paragraph (extract), thumbnail and link (content_urls.desktop.page). Title with underscores for spaces.
- `/w/rest.php/v1/search/page` (`wikipedia.search`): Articles matching words (q), up to 20 (limit), each with its key, title and excerpt. Query: `q`, `limit`. Needs q.

### `openlibrary`: Open Library book search and records

Credit to show: "Book data from Open Library".

- `/search.json` (`openlibrary.search`): Books matching q, title or author, up to 20 a page (limit, page). Pass fields (key,title,author_name,first_publish_year,cover_i) to keep the answer small. A cover is https://covers.openlibrary.org/b/id/<cover_i>-M.jpg. Query: `q`, `title`, `author`, `limit`, `page`, `fields`.
- `/works/{id}.json` (`openlibrary.work`): One work's record by its key, like OL27482W: title, description, subjects.

A cover is an image the page loads from Open Library itself. In a build the test browser can't reach it, so give every
cover a plain fallback (the title on a tinted block) and never test that the image loaded.

### `usgs`: Earthquakes from the US Geological Survey

Credit to show: "Earthquake data: U.S. Geological Survey".

- `/fdsnws/event/1/query` (`usgs.query`): Earthquakes as GeoJSON features (properties.mag, place, time, url), by dates (starttime, endtime as YYYY-MM-DD), minmagnitude, a circle (latitude, longitude, maxradiuskm), limit up to 100 and orderby. Query: `starttime`, `endtime`, `minmagnitude`, `latitude`, `longitude`, `maxradiuskm`, `limit`, `orderby`.
- `/earthquakes/feed/v1.0/summary/{feed}.geojson` (`usgs.feed`): A ready-made list: significant, 4.5, 2.5, 1.0 or all, over the past hour, day, week or month (like significant_week).

## The owner's keys: `secrets` and `KeySettings`

The owner types their own key once into the product's settings. Muse Muse keeps it and adds it to each call on its
own servers. The product's code never has a key: never ask for one in a form of your own, never put one in code, a
page, a log, an error message or `.env.local`.

```tsx
// app/settings/page.tsx, a screen only the owner opens
import { headers } from "next/headers";
import { KeySettings } from "@/components/platform/KeySettings";
import { secrets } from "@/lib/platform/secrets";

export default async function Settings({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const keys = await secrets(await headers()).list().catch(() => null);
  if (!keys) return <p className="hint">Open this product as its owner from Muse Muse to add keys.</p>;
  return <KeySettings keys={keys} returnTo="/settings" status={(await searchParams).key ?? null} />;
}
```

```ts
// in a route handler
import { CapError } from "@/lib/platform/connect";
import { secrets } from "@/lib/platform/secrets";

try {
  const repos = await secrets(request).call("github", { path: "/users/sample-maker/repos?per_page=5" });
  // repos.status, repos.data
} catch (err) {
  if (err instanceof CapError && err.code === "needs_key") {
    // Show the owner a link to the settings screen.
  }
}
```

- `list()`, `save()` and `remove()` are the owner's only. `call()` names the key by its service.
- Each service takes only these calls, on its own host. Owner-only services refuse a visitor's call with
  `sign_in_required`: run those for the owner, or show the visitor what the owner already saved.
  - `github` (GitHub): `GET /user`, `GET /users/**`, `GET /repos/**`, `GET /search/**`. Owner only.
  - `openweathermap` (OpenWeather): `GET /data/2.5/weather`, `GET /data/2.5/forecast`, `GET /geo/1.0/direct`. Visitors may use it.
  - `airtable` (Airtable): `GET /v0/**`. Owner only.
  - `notion` (Notion): `POST /v1/search`, `POST /v1/databases/*/query`, `GET /v1/pages/*`, `GET /v1/blocks/*/children`. Owner only.
- 500 calls a day for the product. A service that sends the call elsewhere (a redirect) is refused.

## Sends: `send` and `ConfirmSend`

A product may send only the kinds of message brief.md lists: `email` (with the owner's Resend key, from a domain they
verified there) or `chat` (to the owner's Slack channel, through its incoming webhook). Nothing else: no SMS, posts or
payments. Only the owner sends, and the owner confirms every message once before it goes.

```ts
// app/api/actions/send_plan/route.ts
import { send } from "@/lib/platform/send";

const result = await send(request, { channel: "email", to: ["friend@example.com"], subject: "Saturday", body: plan });
return Response.json(result); // { status: "needs_confirmation", confirmation } the first time
```

```tsx
// in the page, with the result from that route
{result.status === "needs_confirmation" ? <ConfirmSend confirmation={result.confirmation} /> : null}
```

- The first `send` sends nothing. `<ConfirmSend />` shows exactly what will go and sends it once when the owner
  presses Confirm. A changed word needs a new confirmation.
- At most 5 recipients a message and 10 messages a day. Without the owner's key, `send` throws `CapError` with code
  `needs_key`: show where to add it.
- Muse Muse can switch sends off: then `send` throws `switched_off`. Keep a "Copy message" button beside it, so a
  person can always send the text themselves.

## In a build

Every outside answer is a recorded sample: public APIs give a real answer recorded on Oct 31, a service call gives a
made-up answer in the service's shape, and a confirmed send says `simulated: true` and goes nowhere. Show samples as
they come and never test a sample's exact words.

Smoke test, from `tests/caps/connect.ts`:

```ts
import { checkFetchShown, confirmSend, openAsOwner, saveTestKey } from "./caps/connect";

await page.goto("/");
// ... run the flow that calls fetchPublic and shows the answer ...
await checkFetchShown(page, (fetched) => fetched["nws.forecast"]?.properties?.periods?.[0]?.shortForecast);

await openAsOwner(page);
await page.goto("/settings");
await saveTestKey(page, "github");

// ... run the flow that calls send, so the confirmation card shows ...
await confirmSend(page);
```

- `checkFetchShown` reads what the server really got, keyed `"<api>.<path id>"` as in the lists above, and expects the
  text you pick from it on the page.
- `saveTestKey` types a made-up key; verify then checks that no page or file shows it.
- `confirmSend` presses Confirm and waits for "Sent (sample)". One confirmed send per smoke test.
- `openAsOwner` makes the test browser the owner. Without it the browser is a visitor, as on the live product.

`lib/platform/connect.ts`, `fetch-public.ts`, `secrets.ts`, `send.ts`, `components/platform/KeySettings.tsx`,
`components/platform/ConfirmSend.tsx`, `app/api/musemuse/connect-keys`, `app/api/musemuse/connect-send` and
`tests/caps/connect.ts` are platform files. Wrap them, never edit them.
