import { z } from "zod";

/**
 * The extension cap's brief block (docs/CAPABILITIES.md, section 20): a Chrome extension (Manifest V3) beside the web
 * product, installed with Load unpacked from the product's page. Its popup, side panel or right-click menu calls the
 * product's own actions with the page the person is on, and nothing else.
 */

/**
 * The only permissions an extension may ask for, in the order the manifest lists them. Never `tabs`, `scripting`,
 * `<all_urls>` or a host pattern: the platform writes the one host permission itself, for the product's own link.
 */
export const EXTENSION_PERMISSIONS = ["activeTab", "storage", "contextMenus", "sidePanel"] as const;
export type ExtensionPermission = (typeof EXTENSION_PERMISSIONS)[number];

export const ExtensionBriefBlock = z.object({
  /** What it does for the person on the page they are reading, in one or two plain sentences. */
  does: z.string().min(1).max(300),
  permissions: z.array(z.enum(EXTENSION_PERMISSIONS)).max(EXTENSION_PERMISSIONS.length),
});

export type ExtensionBrief = z.infer<typeof ExtensionBriefBlock>;

const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "").trim() || s.slice(0, max));

/** Permission names as a writer might spell them, mapped to Chrome's. Anything else is dropped. */
const PERMISSION_NAMES: Record<string, ExtensionPermission> = {
  activetab: "activeTab",
  storage: "storage",
  contextmenus: "contextMenus",
  contextmenu: "contextMenus",
  sidepanel: "sidePanel",
};

/**
 * The writer's raw extension block, cleaned before zod (normalizeRawBrief): permissions in Chrome's spelling, each once,
 * in EXTENSION_PERMISSIONS order, with anything broader dropped rather than refused, and `does` clipped to its limit. A
 * block with nothing it does isn't an extension, so it becomes null. Anything else is left for zod to report.
 */
export function normalizeExtensionBlock(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const b = { ...(raw as Record<string, unknown>) };
  if (typeof b.does === "string") {
    b.does = clip(b.does.trim(), 300);
    if (!b.does) return null;
  }
  if (Array.isArray(b.permissions)) {
    const named = new Set(
      b.permissions.flatMap((p) => (typeof p === "string" ? [PERMISSION_NAMES[p.trim().replace(/[\s_-]+/g, "").toLowerCase()]] : [])).filter(Boolean),
    );
    b.permissions = EXTENSION_PERMISSIONS.filter((p) => named.has(p));
  }
  return b;
}

/** The writer's rules for the block (lib/caps/brief-fields.ts, CAP_WRITER_RULES). */
export const EXTENSION_WRITER_RULES: readonly string[] = [
  "extension: fill it only when the person asks for a browser extension, a Chrome or Edge extension, an add-on, or something that works on the page they are reading, like saving a page or explaining selected text. Otherwise null.",
  "extension.does: what it does on the page the person is on, in one or two plain sentences. It works only through the product's own actions, so the brief's actions must include each one it uses.",
  "extension.permissions: the fewest it needs, from activeTab (the current page's address and title, when the person clicks the extension), contextMenus (a right-click item for selected text), storage (settings or recent results kept in the extension) and sidePanel (a panel that stays open beside the page). It can't read or change pages, and never gets access to every site.",
  "An extension installs with Load unpacked in Chrome, Edge or Brave from the product's page. It isn't in any extension store, so don't promise one.",
];
