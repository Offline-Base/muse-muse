---
name: muse-trust
description: Read before adding pages, a footer, a proxy or middleware, cookies, or anything about privacy, terms, age or reports. The platform put trust pages in this product, and they must stay as they are.
---

# Trust pages (platform files)

The platform added these files to this product and puts them back before every check. Don't edit, move, rename or
remove any of them. Wrap them if you need to, never change them.

| File | What it does |
|---|---|
| `proxy.ts` | Blocks restricted territories with a 451 page, and sends a first visit to `/age` when the age gate is on |
| `lib/platform/trust.ts` | Reads `musemuse.trust.json` and `musemuse.privacy.json`, which the platform wrote from the brief |
| `components/Footer.tsx` | "Built with Muse Muse. Not an official Meta product.", and links to Privacy, Terms and Report |
| `app/(musemuse)/privacy`, `app/(musemuse)/terms`, `app/(musemuse)/age` | The `/privacy`, `/terms` and `/age` pages |
| `app/api/musemuse/age/route.ts` | Remembers the visitor's age tap |
| `tests/musemuse-trust.spec.ts` | Runs with the smoke test: the pages answer and the footer links them |

Rules:

- Keep `<Footer />` at the end of `<body>` in `app/layout.tsx`. A product made from a Meta developer video passes `credit`.
- Don't make your own `/privacy`, `/terms` or `/age` pages, and don't add `middleware.ts`: Next takes one proxy, and
  `proxy.ts` is it. Two pages for one path fail the build.
- Don't change `musemuse.trust.json` or `musemuse.privacy.json`. If the product stores something the privacy page doesn't
  say, write that in `BUILD_NOTES.md` instead.
- The age gate is off while tests run (`MUSEMUSE_BUILD=1` in `.env.local`). Don't test the gate, and don't set that
  variable anywhere else.
- Your own tests go in `tests/smoke.spec.ts` as before. `tests/musemuse-trust.spec.ts` runs beside it.
