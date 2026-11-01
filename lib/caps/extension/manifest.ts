import { EXTENSION_PERMISSIONS, type ExtensionPermission } from "@/lib/caps/extension/brief";

/**
 * The extension's manifest (docs/CAPABILITIES.md, section 20), as the platform writes it when it packages a live
 * product's extension. The product's own `extension/manifest.json` gives its name, description, version, popup, side
 * panel, service worker, icons and shortcuts. The platform adds the rest itself: the one host permission, for the
 * product's own link, and a content security policy that lets its pages and service worker reach only that link. So
 * the extension can't reach any other site, read or change pages, or load code from anywhere.
 *
 * The overlay's packer (template/caps/extension/files/scripts/extension-pack.mjs) runs the same checks in the build, so
 * verify fails on a manifest this would refuse. A parity test keeps the two in step.
 */

/** Keys the product's manifest may have. Anything else is refused by name. */
export const MANIFEST_KEYS = [
  "manifest_version",
  "name",
  "short_name",
  "description",
  "version",
  "action",
  "background",
  "side_panel",
  "permissions",
  "icons",
  "commands",
  "minimum_chrome_version",
] as const;

/** Keys only the platform writes. A product manifest that sets them is refused, so nothing it writes there counts. */
export const PLATFORM_KEYS = ["host_permissions", "content_security_policy"] as const;

/** Why a key is refused, for the ones a build is likeliest to reach for. Others get a general reason. */
const REFUSED_KEYS: Record<string, string> = {
  content_scripts: "content_scripts runs code in every page it matches, which the extension may not do",
  host_permissions: "host_permissions is the platform's: it adds the product's own link and nothing else",
  optional_host_permissions: "optional_host_permissions would let it ask for other sites later",
  optional_permissions: "optional_permissions would let it ask for more later",
  content_security_policy: "content_security_policy is the platform's: it allows only the product's own link",
  externally_connectable: "externally_connectable lets web pages talk to the extension",
  web_accessible_resources: "web_accessible_resources exposes the extension's files to web pages",
  key: "key pins an extension id, which a Load unpacked extension doesn't need",
  update_url: "update_url would update it from somewhere else",
  oauth2: "oauth2 signs in to other services",
  chrome_url_overrides: "chrome_url_overrides replaces the browser's own pages",
  devtools_page: "devtools_page adds to the browser's developer tools",
  declarative_net_request: "declarative_net_request changes other sites' traffic",
  sandbox: "sandbox pages can run code the content security policy bars",
};

/** File types an extension may ship. Code is compiled from TypeScript (or plain .js) in extension/. */
export const EXTENSION_FILE_TYPES = [".js", ".html", ".css", ".json", ".png", ".svg", ".webp", ".jpg", ".txt"] as const;
export const EXTENSION_LIMITS = { files: 100, bytes: 4 * 1024 * 1024, fileBytes: 1024 * 1024 } as const;

/** A path inside the extension: plain names, forward slashes, no `..`, a type it may ship. */
export function isExtensionPath(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.length > 120) return false;
  // No segment starts with "." or "_": Chrome keeps "_" names for itself and won't load an extension with one.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(p)) return false;
  if (p.split("/").some((s) => s === "." || s === ".." || s.startsWith("."))) return false;
  return EXTENSION_FILE_TYPES.some((t) => p.toLowerCase().endsWith(t));
}

const ICON_SIZES = ["16", "32", "48", "128"] as const;
const VERSION = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;

/** The parts of a product's manifest the platform keeps, checked. */
export interface ProductManifest {
  name: string;
  short_name?: string;
  description?: string;
  version: string;
  action?: { default_popup?: string; default_title?: string; default_icon?: string | Record<string, string> };
  background: { service_worker: string; type: "module" };
  side_panel?: { default_path: string };
  permissions: string[];
  icons?: Record<string, string>;
  commands?: Record<string, { suggested_key?: Record<string, string>; description?: string }>;
  minimum_chrome_version?: string;
}

export interface ManifestCheck {
  /** Null when it has a problem that can't be dropped. */
  manifest: ProductManifest | null;
  problems: string[];
  /** Permissions it asked for that the brief didn't list. The platform leaves them out, and says so. */
  dropped: string[];
  /** Every file the manifest names, so the packager can check they exist. */
  files: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** True for a permission string that names sites rather than an API: `<all_urls>`, a match pattern, a file URL. */
export function isHostPattern(p: string): boolean {
  return p === "<all_urls>" || p.includes("://") || p.includes("*") || p.startsWith("file:");
}

/**
 * Checks a product's `extension/manifest.json`. `allowed` is what the brief lists: a known permission outside it is
 * dropped (and reported in `dropped`), while a host pattern, an unknown permission or any refused key is a problem.
 */
export function checkProductManifest(raw: unknown, opts: { allowed: readonly ExtensionPermission[] }): ManifestCheck {
  const problems: string[] = [];
  const dropped: string[] = [];
  const files: string[] = [];
  if (!isObject(raw)) return { manifest: null, problems: ["extension/manifest.json isn't a JSON object"], dropped, files };
  for (const key of Object.keys(raw)) {
    if ((MANIFEST_KEYS as readonly string[]).includes(key)) continue;
    problems.push(REFUSED_KEYS[key] ? `${REFUSED_KEYS[key]}, so it isn't allowed` : `"${key.slice(0, 40)}" isn't a manifest key a Muse Muse extension may set`);
  }
  if (raw.manifest_version !== 3) problems.push("manifest_version must be 3");
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 75) problems.push("name must be 1 to 75 characters");
  if (raw.short_name !== undefined && (typeof raw.short_name !== "string" || !raw.short_name.trim() || raw.short_name.length > 12)) {
    problems.push("short_name must be 1 to 12 characters");
  }
  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 132)) problems.push("description must be at most 132 characters");
  if (typeof raw.version !== "string" || !VERSION.test(raw.version) || raw.version.split(".").some((n) => Number(n) > 65535)) {
    problems.push('version must be like "1.0.0": up to four numbers of at most 65535');
  }

  const path = (value: unknown, what: string, ext: string): string | undefined => {
    if (typeof value !== "string" || !isExtensionPath(value) || !value.toLowerCase().endsWith(ext)) {
      problems.push(`${what} must name a ${ext} file in the extension folder`);
      return undefined;
    }
    files.push(value);
    return value;
  };

  let action: ProductManifest["action"];
  if (raw.action !== undefined) {
    if (!isObject(raw.action)) problems.push("action must be an object");
    else {
      action = {};
      for (const key of Object.keys(raw.action)) if (!["default_popup", "default_title", "default_icon"].includes(key)) problems.push(`action.${key.slice(0, 40)} isn't allowed`);
      if (raw.action.default_popup !== undefined) action.default_popup = path(raw.action.default_popup, "action.default_popup", ".html");
      if (raw.action.default_title !== undefined) {
        if (typeof raw.action.default_title !== "string" || raw.action.default_title.length > 75) problems.push("action.default_title must be at most 75 characters");
        else action.default_title = raw.action.default_title;
      }
      if (raw.action.default_icon !== undefined) {
        if (typeof raw.action.default_icon === "string") action.default_icon = path(raw.action.default_icon, "action.default_icon", ".png");
        else if (isObject(raw.action.default_icon)) action.default_icon = iconSet(raw.action.default_icon, "action.default_icon", problems, path);
        else problems.push("action.default_icon must be a .png path or a set of them");
      }
    }
  }

  let background: ProductManifest["background"] | undefined;
  if (!isObject(raw.background)) problems.push('background must be {"service_worker": "background.js", "type": "module"}');
  else {
    for (const key of Object.keys(raw.background)) if (!["service_worker", "type"].includes(key)) problems.push(`background.${key.slice(0, 40)} isn't allowed`);
    const sw = path(raw.background.service_worker, "background.service_worker", ".js");
    if (raw.background.type !== "module") problems.push('background.type must be "module", so the service worker can import the platform helper');
    if (sw) background = { service_worker: sw, type: "module" };
  }

  const asked = Array.isArray(raw.permissions) ? raw.permissions : raw.permissions === undefined ? [] : null;
  if (asked === null) problems.push("permissions must be a list");
  const permissions: string[] = [];
  for (const p of asked ?? []) {
    if (typeof p !== "string") {
      problems.push("every permission must be a name");
      continue;
    }
    if (isHostPattern(p)) problems.push(`"${p.slice(0, 40)}" asks for sites. The extension may reach only the product's own link, which the platform adds`);
    else if (!(EXTENSION_PERMISSIONS as readonly string[]).includes(p)) problems.push(`the "${p.slice(0, 40)}" permission isn't allowed. Only ${EXTENSION_PERMISSIONS.join(", ")} are`);
    else if (!opts.allowed.includes(p as ExtensionPermission)) dropped.push(p);
    else if (!permissions.includes(p)) permissions.push(p);
  }

  let side: ProductManifest["side_panel"];
  if (raw.side_panel !== undefined) {
    if (!isObject(raw.side_panel) || Object.keys(raw.side_panel).some((k) => k !== "default_path")) problems.push('side_panel must be {"default_path": "sidepanel.html"}');
    else {
      const p = path(raw.side_panel.default_path, "side_panel.default_path", ".html");
      if (p) side = { default_path: p };
    }
    if (!permissions.includes("sidePanel") && !dropped.includes("sidePanel")) problems.push("side_panel needs the sidePanel permission");
  } else if (permissions.includes("sidePanel")) problems.push("the sidePanel permission needs side_panel.default_path");
  if (!action?.default_popup && !side) problems.push("it needs a popup (action.default_popup) or a side panel (side_panel.default_path)");

  let icons: ProductManifest["icons"];
  if (raw.icons !== undefined) {
    if (!isObject(raw.icons)) problems.push("icons must be a set of .png paths by size");
    else icons = iconSet(raw.icons, "icons", problems, path);
  }

  let commands: ProductManifest["commands"];
  if (raw.commands !== undefined) {
    if (!isObject(raw.commands) || Object.keys(raw.commands).length > 4) problems.push("commands must be at most 4 keyboard shortcuts");
    else {
      commands = {};
      for (const [cmd, spec] of Object.entries(raw.commands)) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]{0,40}$/.test(cmd) || !isObject(spec) || Object.keys(spec).some((k) => !["suggested_key", "description"].includes(k))) {
          problems.push(`commands.${cmd.slice(0, 40)} must have only suggested_key and description`);
          continue;
        }
        const entry: { suggested_key?: Record<string, string>; description?: string } = {};
        if (spec.suggested_key !== undefined) {
          const keys = isObject(spec.suggested_key) ? Object.entries(spec.suggested_key) : null;
          if (!keys || keys.some(([k, v]) => !["default", "mac", "windows", "chromeos", "linux"].includes(k) || typeof v !== "string" || v.length > 40)) {
            problems.push(`commands.${cmd}.suggested_key must name keys like "Ctrl+Shift+Y"`);
          } else entry.suggested_key = Object.fromEntries(keys as Array<[string, string]>);
        }
        if (spec.description !== undefined) {
          if (typeof spec.description !== "string" || spec.description.length > 100) problems.push(`commands.${cmd}.description must be at most 100 characters`);
          else entry.description = spec.description;
        }
        commands[cmd] = entry;
      }
    }
  }
  if (raw.minimum_chrome_version !== undefined && (typeof raw.minimum_chrome_version !== "string" || !/^\d{2,3}$/.test(raw.minimum_chrome_version))) {
    problems.push('minimum_chrome_version must be a version number like "120"');
  }

  if (problems.length || !background) return { manifest: null, problems, dropped, files };
  const manifest: ProductManifest = {
    name,
    ...(typeof raw.short_name === "string" ? { short_name: raw.short_name.trim() } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    version: raw.version as string,
    ...(action ? { action } : {}),
    background,
    ...(side ? { side_panel: side } : {}),
    permissions,
    ...(icons ? { icons } : {}),
    ...(commands ? { commands } : {}),
    ...(typeof raw.minimum_chrome_version === "string" ? { minimum_chrome_version: raw.minimum_chrome_version } : {}),
  };
  return { manifest, problems, dropped, files: [...new Set(files)] };
}

function iconSet(
  raw: Record<string, unknown>,
  what: string,
  problems: string[],
  path: (value: unknown, what: string, ext: string) => string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [size, file] of Object.entries(raw)) {
    if (!(ICON_SIZES as readonly string[]).includes(size)) {
      problems.push(`${what} sizes must be ${ICON_SIZES.join(", ")}`);
      continue;
    }
    const p = path(file, `${what}.${size}`, ".png");
    if (p) out[size] = p;
  }
  return out;
}

/**
 * The product's own link as the extension's one origin: https with no path, or, for a build's own test browser, a
 * loopback address. Throws with a plain reason otherwise.
 */
export function extensionOrigin(url: string, opts: { allowLoopback?: boolean } = {}): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("the product's link isn't a web address");
  }
  const loopback = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (u.protocol !== "https:" && !(opts.allowLoopback && loopback)) throw new Error("the product's link must be https");
  if (u.username || u.password) throw new Error("the product's link can't carry a name or password");
  return u.origin;
}

/**
 * The content security policy for the extension's pages and its service worker: scripts, styles, fonts, media and
 * images only from the extension itself (images also from data: and blob: links it makes and from the product's own
 * link), network calls only to the product's own link, no frames and no form posts. So an image or a style can't carry page data to another site
 * either. Manifest V3 bars remote code anyway. A policy can't stop navigation (chrome.tabs.create, window.open), which
 * opens a page the person sees.
 */
export function extensionCsp(origin: string): string {
  return `default-src 'self'; script-src 'self'; object-src 'self'; img-src 'self' data: blob: ${origin}; connect-src ${origin}; frame-src 'none'; form-action 'none'; base-uri 'none'`;
}

/** The manifest the platform ships: the product's checked fields, its one host permission and its policy. */
export function finalManifest(product: ProductManifest, origin: string): Record<string, unknown> {
  const ordered = EXTENSION_PERMISSIONS.filter((p) => product.permissions.includes(p));
  const { permissions: _asked, ...rest } = product;
  return {
    manifest_version: 3,
    ...rest,
    permissions: ordered,
    host_permissions: [`${origin}/*`],
    content_security_policy: { extension_pages: extensionCsp(origin) },
  };
}

/** The extension's config.js, the one place its code learns the product's link. The platform writes it. */
export function extensionConfigSource(origin: string): string {
  return `// Written by the Muse Muse platform when it packages the extension. Don't edit.\nexport const PRODUCT_ORIGIN = ${JSON.stringify(origin)};\n`;
}
