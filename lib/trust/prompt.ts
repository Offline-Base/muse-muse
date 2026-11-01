/**
 * The build prompt's Trust pages section (docs/CAPABILITIES.md, section 7), for a product that got the trust overlay.
 * None without it, so brief.md is today's with the trust flags off.
 */
export function trustBuildLines(trust: boolean | undefined): string[] {
  if (!trust) return [];
  return [
    "",
    "## Trust pages",
    "",
    "The platform put these in the product and puts them back before every check. Read `.agents/skills/muse-trust/SKILL.md` before you add pages, cookies or anything that runs before a page.",
    "",
    "- Don't edit, move or remove `proxy.ts`, `lib/platform/trust.ts`, `components/Footer.tsx`, the pages in `app/(musemuse)/`, `app/api/musemuse/age/route.ts`, `musemuse.trust.json`, `musemuse.privacy.json` or `tests/musemuse-trust.spec.ts`.",
    "- Keep `<Footer />` in `app/layout.tsx`: it says the product is built with Muse Muse and links Privacy, Terms and Report.",
    "- Don't make your own `/privacy`, `/terms` or `/age` page, and don't add `middleware.ts`. Next takes one proxy, and `proxy.ts` is it.",
    "- The age gate is off while tests run (`MUSEMUSE_BUILD=1` in `.env.local`), so the smoke test reaches the product as usual. Don't test the gate.",
    "- `tests/musemuse-trust.spec.ts` runs with the smoke test in `npm run verify`. If it fails, fix the product (usually the footer in `app/layout.tsx`), never the spec.",
  ];
}
