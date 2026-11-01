import type { Brief } from "@/lib/brief/schema";
import { EXTENSION_PERMISSIONS, type ExtensionBrief } from "@/lib/caps/extension/brief";
import type { CapRenderEntry } from "@/lib/caps/render";

/**
 * The extension cap's part of the prompts (docs/CAPABILITIES.md, 2.6 and section 20). Its text names the platform files
 * in template/caps/extension: extension/platform.ts, scripts/extension-pack.mjs, tests/caps/extension.ts and the
 * muse-extension skill. The "- Permissions:" line is read by the packer in the build (briefPermissions), so its shape
 * stays as it is.
 */

function block(brief: Brief): ExtensionBrief | null {
  return ((brief as { extension?: ExtensionBrief | null }).extension ?? null) as ExtensionBrief | null;
}

/** The brief's permissions, known ones only, in the manifest's order. */
function permissions(ext: ExtensionBrief): string[] {
  return EXTENSION_PERMISSIONS.filter((p) => ext.permissions.includes(p));
}

function permissionsLine(ext: ExtensionBrief): string {
  const list = permissions(ext);
  return `- Permissions: ${list.length ? list.map((p) => `\`${p}\``).join(", ") : "none"}. Ask for exactly these in \`extension/manifest.json\`: the platform packages it with these only, and verify's \`manifest\` check fails on any other. Never host permissions: the platform adds the product's own link.`;
}

export const EXTENSION_RENDER: CapRenderEntry = {
  title: "Browser extension",
  build(brief) {
    const ext = block(brief);
    if (!ext) return [];
    return [
      `The brief asks for a browser extension beside the web product: ${ext.does}`,
      "",
      permissionsLine(ext),
      "- Read `.agents/skills/muse-extension/SKILL.md` first. It has the folder, the rules and the test.",
      "- It lives in `extension/`, outside the Next.js app: `manifest.json`, `popup.html`, `popup.ts`, `popup.css` and `background.ts` are starting points. Plain TypeScript and DOM code, no React and no packages: each file is compiled on its own, and imports end in `.js` (`./platform.js`).",
      "- It calls only the product's own actions, with `productAction(name, input)` from `extension/platform.ts`, so each action it uses must be in `musemuse.json`. Its content security policy allows only the product's own link, so any other call fails.",
      "- `currentPage()` gives the page's address and title once the person clicks the extension. It can't read or change what's on a page.",
      "- The popup uses the product's tokens (`popup.css`) and says next to its button what it sends: \"Sends this page's title and address when you click.\"",
      "- `node scripts/extension-pack.mjs check` runs the platform's checks; `build --origin http://localhost:3000` writes the folder Chrome loads to `test-results/caps/extension-build/`.",
      "- No stand-in: the test browser loads the extension for real, and its popup calls this build's own action routes.",
      "- Test: add `tests/extension.spec.ts` with one test that uses `openExtension(baseURL)`, `openPopup` and `expectExtensionAction` from `tests/caps/extension.ts`, as the skill shows, and takes one judge screenshot of the popup. Verify also loads the extension and opens the popup itself, with no product server behind it, so the popup must render without an answer.",
      "- `template/AGENTS.md` says server work goes in `app/api/`. The extension is the one part outside the app: keep its code in `extension/` and out of `app/` and `components/`.",
      "- `extension/platform.ts`, `extension/config.d.ts`, `scripts/extension-pack.mjs`, `scripts/caps/extension.mjs` and `tests/caps/extension.ts` are platform files. Leave them as they are.",
    ];
  },
  refine(brief) {
    const ext = block(brief);
    if (!ext) return [];
    return [
      "- Its browser extension lives in `extension/` (`.agents/skills/muse-extension/SKILL.md`). Keep `node scripts/extension-pack.mjs check` and `tests/extension.spec.ts` passing.",
      permissionsLine(ext),
    ];
  },
  markdown(brief) {
    const ext = block(brief);
    if (!ext) return [];
    const list = permissions(ext);
    return [ext.does, "", `Permissions: ${list.length ? list.map((p) => `\`${p}\``).join(", ") : "none"}. Installs with Load unpacked.`];
  },
};
