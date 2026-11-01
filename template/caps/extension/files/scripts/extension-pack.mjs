// Platform file (Muse Muse platform services). Don't edit. Builds and checks the product's browser extension.
//
//   node scripts/extension-pack.mjs build [--origin http://localhost:3000] [--out test-results/caps/extension-build]
//       compiles extension/ into a folder Chrome can load (Load unpacked), with the manifest and config.js the platform
//       writes for that origin. tests/caps/extension.ts runs it before it opens the extension.
//   node scripts/extension-pack.mjs check
//       compiles and checks it, and prints every problem. verify's caps step runs the same check.
//   node scripts/extension-pack.mjs bundle --out <file.json>
//       the compiled files and the product's own manifest as one JSON file, which the platform packages from the
//       product's live link when it ships. The platform decides the permissions, the host and config.js itself.
//
// Each .ts file in extension/ is compiled on its own with the product's TypeScript (no bundler, no packages), so
// imports are relative and end in .js. The rules here are the platform's (lib/caps/extension/{manifest,scan}.ts): a
// parity test keeps them the same.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ALLOWED_PERMISSIONS = ["activeTab", "storage", "contextMenus", "sidePanel"];
export const MANIFEST_KEYS = ["manifest_version", "name", "short_name", "description", "version", "action", "background", "side_panel", "permissions", "icons", "commands", "minimum_chrome_version"];
const REFUSED_KEYS = {
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
export const FILE_TYPES = [".js", ".html", ".css", ".json", ".png", ".svg", ".webp", ".jpg", ".txt"];
export const LIMITS = { files: 100, bytes: 4 * 1024 * 1024, fileBytes: 1024 * 1024 };
export const PLATFORM_HELPER = "platform.js";
export const RESERVED_FILES = ["config.js", "manifest.json"];
const ICON_SIZES = ["16", "32", "48", "128"];
const VERSION = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;

export function isExtensionPath(p) {
  if (typeof p !== "string" || !p || p.length > 120) return false;
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/.test(p)) return false;
  if (p.split("/").some((s) => s === "." || s === ".." || s.startsWith("."))) return false;
  return FILE_TYPES.some((t) => p.toLowerCase().endsWith(t));
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
export const isHostPattern = (p) => p === "<all_urls>" || p.includes("://") || p.includes("*") || p.startsWith("file:");

/** The same check as lib/caps/extension/manifest.ts's checkProductManifest. */
export function checkProductManifest(raw, { allowed = ALLOWED_PERMISSIONS } = {}) {
  const problems = [];
  const dropped = [];
  const files = [];
  if (!isObject(raw)) return { manifest: null, problems: ["extension/manifest.json isn't a JSON object"], dropped, files };
  for (const key of Object.keys(raw)) {
    if (MANIFEST_KEYS.includes(key)) continue;
    problems.push(REFUSED_KEYS[key] ? `${REFUSED_KEYS[key]}, so it isn't allowed` : `"${key.slice(0, 40)}" isn't a manifest key a Muse Muse extension may set`);
  }
  if (raw.manifest_version !== 3) problems.push("manifest_version must be 3");
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 75) problems.push("name must be 1 to 75 characters");
  if (raw.short_name !== undefined && (typeof raw.short_name !== "string" || !raw.short_name.trim() || raw.short_name.length > 12)) problems.push("short_name must be 1 to 12 characters");
  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 132)) problems.push("description must be at most 132 characters");
  if (typeof raw.version !== "string" || !VERSION.test(raw.version) || raw.version.split(".").some((n) => Number(n) > 65535)) {
    problems.push('version must be like "1.0.0": up to four numbers of at most 65535');
  }
  const pathOf = (value, what, ext) => {
    if (typeof value !== "string" || !isExtensionPath(value) || !value.toLowerCase().endsWith(ext)) {
      problems.push(`${what} must name a ${ext} file in the extension folder`);
      return undefined;
    }
    files.push(value);
    return value;
  };
  const iconSet = (set, what) => {
    const out = {};
    for (const [size, file] of Object.entries(set)) {
      if (!ICON_SIZES.includes(size)) {
        problems.push(`${what} sizes must be ${ICON_SIZES.join(", ")}`);
        continue;
      }
      const p = pathOf(file, `${what}.${size}`, ".png");
      if (p) out[size] = p;
    }
    return out;
  };

  let action;
  if (raw.action !== undefined) {
    if (!isObject(raw.action)) problems.push("action must be an object");
    else {
      action = {};
      for (const key of Object.keys(raw.action)) if (!["default_popup", "default_title", "default_icon"].includes(key)) problems.push(`action.${key.slice(0, 40)} isn't allowed`);
      if (raw.action.default_popup !== undefined) action.default_popup = pathOf(raw.action.default_popup, "action.default_popup", ".html");
      if (raw.action.default_title !== undefined) {
        if (typeof raw.action.default_title !== "string" || raw.action.default_title.length > 75) problems.push("action.default_title must be at most 75 characters");
        else action.default_title = raw.action.default_title;
      }
      if (raw.action.default_icon !== undefined) {
        if (typeof raw.action.default_icon === "string") action.default_icon = pathOf(raw.action.default_icon, "action.default_icon", ".png");
        else if (isObject(raw.action.default_icon)) action.default_icon = iconSet(raw.action.default_icon, "action.default_icon");
        else problems.push("action.default_icon must be a .png path or a set of them");
      }
    }
  }

  let background;
  if (!isObject(raw.background)) problems.push('background must be {"service_worker": "background.js", "type": "module"}');
  else {
    for (const key of Object.keys(raw.background)) if (!["service_worker", "type"].includes(key)) problems.push(`background.${key.slice(0, 40)} isn't allowed`);
    const sw = pathOf(raw.background.service_worker, "background.service_worker", ".js");
    if (raw.background.type !== "module") problems.push('background.type must be "module", so the service worker can import the platform helper');
    if (sw) background = { service_worker: sw, type: "module" };
  }

  const asked = Array.isArray(raw.permissions) ? raw.permissions : raw.permissions === undefined ? [] : null;
  if (asked === null) problems.push("permissions must be a list");
  const permissions = [];
  for (const p of asked ?? []) {
    if (typeof p !== "string") {
      problems.push("every permission must be a name");
      continue;
    }
    if (isHostPattern(p)) problems.push(`"${p.slice(0, 40)}" asks for sites. The extension may reach only the product's own link, which the platform adds`);
    else if (!ALLOWED_PERMISSIONS.includes(p)) problems.push(`the "${p.slice(0, 40)}" permission isn't allowed. Only ${ALLOWED_PERMISSIONS.join(", ")} are`);
    else if (!allowed.includes(p)) dropped.push(p);
    else if (!permissions.includes(p)) permissions.push(p);
  }

  let side;
  if (raw.side_panel !== undefined) {
    if (!isObject(raw.side_panel) || Object.keys(raw.side_panel).some((k) => k !== "default_path")) problems.push('side_panel must be {"default_path": "sidepanel.html"}');
    else {
      const p = pathOf(raw.side_panel.default_path, "side_panel.default_path", ".html");
      if (p) side = { default_path: p };
    }
    if (!permissions.includes("sidePanel") && !dropped.includes("sidePanel")) problems.push("side_panel needs the sidePanel permission");
  } else if (permissions.includes("sidePanel")) problems.push("the sidePanel permission needs side_panel.default_path");
  if (!action?.default_popup && !side) problems.push("it needs a popup (action.default_popup) or a side panel (side_panel.default_path)");

  let icons;
  if (raw.icons !== undefined) {
    if (!isObject(raw.icons)) problems.push("icons must be a set of .png paths by size");
    else icons = iconSet(raw.icons, "icons");
  }

  let commands;
  if (raw.commands !== undefined) {
    if (!isObject(raw.commands) || Object.keys(raw.commands).length > 4) problems.push("commands must be at most 4 keyboard shortcuts");
    else {
      commands = {};
      for (const [cmd, spec] of Object.entries(raw.commands)) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]{0,40}$/.test(cmd) || !isObject(spec) || Object.keys(spec).some((k) => !["suggested_key", "description"].includes(k))) {
          problems.push(`commands.${cmd.slice(0, 40)} must have only suggested_key and description`);
          continue;
        }
        const entry = {};
        if (spec.suggested_key !== undefined) {
          const keys = isObject(spec.suggested_key) ? Object.entries(spec.suggested_key) : null;
          if (!keys || keys.some(([k, v]) => !["default", "mac", "windows", "chromeos", "linux"].includes(k) || typeof v !== "string" || v.length > 40)) {
            problems.push(`commands.${cmd}.suggested_key must name keys like "Ctrl+Shift+Y"`);
          } else entry.suggested_key = Object.fromEntries(keys);
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
  const manifest = {
    name,
    ...(typeof raw.short_name === "string" ? { short_name: raw.short_name.trim() } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    version: raw.version,
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

export function extensionOrigin(url, { allowLoopback = false } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("the product's link isn't a web address");
  }
  const loopback = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (u.protocol !== "https:" && !(allowLoopback && loopback)) throw new Error("the product's link must be https");
  if (u.username || u.password) throw new Error("the product's link can't carry a name or password");
  return u.origin;
}

export const extensionCsp = (origin) => `script-src 'self'; object-src 'self'; connect-src ${origin}; frame-src 'none'; base-uri 'none'`;

export function finalManifest(product, origin) {
  const { permissions, ...rest } = product;
  return {
    manifest_version: 3,
    ...rest,
    permissions: ALLOWED_PERMISSIONS.filter((p) => permissions.includes(p)),
    host_permissions: [`${origin}/*`],
    content_security_policy: { extension_pages: extensionCsp(origin) },
  };
}

export const extensionConfigSource = (origin) => `// Written by the Muse Muse platform when it packages the extension. Don't edit.\nexport const PRODUCT_ORIGIN = ${JSON.stringify(origin)};\n`;

// ---------------------------------------------------------------------------------------------------------------
// The source scan: the same rules as lib/caps/extension/scan.ts

const IMPORT_FROM = /(?:^|[\s;}])(?:import|export)\s[^;'"`]*?\bfrom\s*(['"])([^'"\n]+)\1/g;
const BARE_IMPORT = /(?:^|[\s;}])import\s*(['"])([^'"\n]+)\1/g;
const CODE_RULES = [
  [/\bimport\s*\(/, "loads code at run time with import(). Import it at the top of the file instead"],
  [/\bimportScripts\s*\(/, "loads code at run time with importScripts(). Import it at the top of the file instead"],
  [/\beval\s*\(/, "runs text as code with eval()"],
  [/\bnew\s+Function\s*\(/, "runs text as code with new Function()"],
  [/\bchrome\s*\.\s*scripting\b/, "uses chrome.scripting, which changes pages. The extension may only read the current page's address and title"],
  [/\bchrome\s*\.\s*tabs\s*\.\s*executeScript\b/, "uses chrome.tabs.executeScript, which changes pages"],
  [/\bchrome\s*\.\s*debugger\b/, "uses chrome.debugger"],
];
const NETWORK_RULES = [
  [/\bfetch\s*\(/, "fetch()"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bEventSource\b/, "EventSource"],
  [/\bsendBeacon\b/, "sendBeacon"],
];
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

export function importsOf(source) {
  const code = stripComments(source);
  const out = [];
  for (const re of [IMPORT_FROM, BARE_IMPORT]) for (const m of code.matchAll(re)) out.push(m[2]);
  return [...new Set(out)];
}

function resolveImport(from, spec) {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  return joined.startsWith("../") || joined.startsWith("/") ? null : joined;
}

const REMOTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function scanScript(file, source, names) {
  const problems = [];
  const code = stripComments(source);
  for (const spec of importsOf(source)) {
    const target = resolveImport(file, spec);
    if (!target) problems.push(`${file} imports "${spec.slice(0, 60)}". Extension code imports only its own files, by a relative path ending in .js`);
    else if (!target.endsWith(".js")) problems.push(`${file} imports "${spec.slice(0, 60)}". Write the import with a .js ending, as the compiled file is named`);
    else if (!names.has(target)) problems.push(`${file} imports ${target}, which isn't in the extension`);
  }
  for (const [re, why] of CODE_RULES) if (re.test(code)) problems.push(`${file} ${why}`);
  if (file !== PLATFORM_HELPER) {
    for (const [re, what] of NETWORK_RULES) {
      if (re.test(code)) problems.push(`${file} uses ${what}. Only productAction() in platform.js reaches the network, and only the product's own actions`);
    }
  }
  return problems;
}

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

function scanHtml(file, html, names) {
  const problems = [];
  const text = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const m of text.matchAll(SCRIPT_TAG)) {
    const attrs = m[1] ?? "";
    const src = attr(attrs, "src");
    if (src === null) {
      if ((m[2] ?? "").trim()) problems.push(`${file} has an inline script. Manifest V3 runs none: move it to a .js file and load it with <script type="module" src="./name.js">`);
      continue;
    }
    if (REMOTE.test(src)) problems.push(`${file} loads a script from ${src.slice(0, 60)}. Scripts come only from the extension itself`);
    else {
      const target = resolveImport(file, src.startsWith(".") ? src : `./${src}`);
      if (!target || !names.has(target)) problems.push(`${file} loads ${src.slice(0, 60)}, which isn't in the extension`);
    }
    if ((attr(attrs, "type") ?? "").toLowerCase() !== "module") problems.push(`${file} loads ${src.slice(0, 60)} without type="module"`);
  }
  if (/<(iframe|object|embed|frame)\b/i.test(text)) problems.push(`${file} embeds another page. The extension shows only its own pages`);
  if (/\son[a-z]+\s*=/i.test(text.replace(SCRIPT_TAG, ""))) problems.push(`${file} has an inline event handler (onclick= and the like), which Manifest V3 doesn't run. Add listeners in its .js file`);
  for (const m of text.matchAll(/<link\b([^>]*)>/gi)) {
    const href = attr(m[1] ?? "", "href");
    if (href && REMOTE.test(href)) problems.push(`${file} loads ${href.slice(0, 60)}. Styles and fonts come only from the extension itself`);
  }
  return problems;
}

function scanCss(file, css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  return /(@import\s+(url\()?\s*['"]?\s*(https?:)?\/\/)|url\(\s*['"]?\s*(https?:)?\/\//i.test(text) ? [`${file} loads a style, font or image from another site. Ship it in the extension instead`] : [];
}

/** The same scan as lib/caps/extension/scan.ts's scanExtensionFiles. `files` is a Map of path to Buffer. */
export function scanExtensionFiles(files) {
  const names = new Set([...files.keys(), "config.js"]);
  const problems = [];
  for (const [file, content] of files) {
    const lower = file.toLowerCase();
    if (lower.endsWith(".js")) problems.push(...scanScript(file, content.toString("utf8"), names));
    else if (lower.endsWith(".html")) problems.push(...scanHtml(file, content.toString("utf8"), names));
    else if (lower.endsWith(".css")) problems.push(...scanCss(file, content.toString("utf8")));
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Compiling extension/

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) return [{ path: path.relative(base, full).split(path.sep).join("/"), link: true }];
    return e.isDirectory() ? walk(full, base) : [{ path: path.relative(base, full).split(path.sep).join("/"), link: false }];
  });
}

/** The product's TypeScript, which compiles each file on its own. */
function typescriptFor(root) {
  const require = createRequire(path.join(root, "package.json"));
  return require("typescript");
}

/**
 * Compiles extension/ (each .ts on its own, other files as they are). Returns the files by path, with the product's
 * own manifest.json, and every problem: compile errors, files it may not ship, and the scan.
 */
export function compileExtension({ root }) {
  const dir = path.join(root, "extension");
  const problems = [];
  const files = new Map();
  if (!existsSync(path.join(dir, "manifest.json"))) return { files, problems: ["extension/manifest.json is missing"] };
  const entries = walk(dir);
  let ts = null;
  for (const entry of entries) {
    const rel = entry.path;
    if (entry.link) {
      problems.push(`extension/${rel} is a link. Put the file itself there`);
      continue;
    }
    if (rel.endsWith(".d.ts")) continue;
    if (rel.endsWith(".tsx") || rel.endsWith(".jsx")) {
      problems.push(`extension/${rel}: the extension is plain TypeScript and DOM code, no JSX or React`);
      continue;
    }
    const source = readFileSync(path.join(dir, rel));
    if (rel.endsWith(".ts")) {
      const out = `${rel.slice(0, -3)}.js`;
      if (entries.some((e) => e.path === out)) {
        problems.push(`extension/${rel} and extension/${out} are both there. Keep only the .ts file`);
        continue;
      }
      ts ??= typescriptFor(root);
      const result = ts.transpileModule(source.toString("utf8"), {
        fileName: rel,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true, sourceMap: false, inlineSourceMap: false, removeComments: false },
      });
      for (const d of result.diagnostics ?? []) {
        const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
        const line = d.file && typeof d.start === "number" ? `:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : "";
        problems.push(`extension/${rel}${line} doesn't compile: ${message.slice(0, 200)}`);
      }
      files.set(out, Buffer.from(result.outputText));
      continue;
    }
    if (!isExtensionPath(rel)) {
      problems.push(`extension/${rel} isn't a file an extension may ship (${FILE_TYPES.join(", ")}, plain names)`);
      continue;
    }
    files.set(rel, source);
  }
  for (const name of RESERVED_FILES) if (name !== "manifest.json" && files.has(name)) problems.push(`extension/${name.replace(/\.js$/, ".ts")} is written by the platform, so the extension can't have its own`);
  if (files.size > LIMITS.files) problems.push(`extension/ has ${files.size} files, more than an extension may (${LIMITS.files})`);
  let bytes = 0;
  for (const [p, content] of files) {
    if (content.length > LIMITS.fileBytes) problems.push(`extension/${p} is over ${LIMITS.fileBytes / 1024 / 1024} MB`);
    bytes += content.length;
  }
  if (bytes > LIMITS.bytes) problems.push(`extension/ is over ${LIMITS.bytes / 1024 / 1024} MB`);
  problems.push(...scanExtensionFiles(files));
  return { files, problems };
}

/**
 * The permissions brief.md's "Browser extension" section lists, which the platform packages with. All four when brief.md
 * has no such line, as in a test folder.
 */
export function briefPermissions(root) {
  let text = "";
  try {
    text = readFileSync(path.join(root, "brief.md"), "utf8");
  } catch {
    return ALLOWED_PERMISSIONS;
  }
  const section = text.split(/^### Browser extension\s*$/m)[1];
  const line = section?.split(/^#{2,3} /m)[0]?.match(/^- Permissions: (.*)$/m)?.[1];
  if (line === undefined) return ALLOWED_PERMISSIONS;
  return ALLOWED_PERMISSIONS.filter((p) => new RegExp(`\`${p}\``).test(line));
}

/** Compiles and checks the extension the way the platform will package it. */
export function checkExtension({ root, origin = "https://product.example" }) {
  const { files, problems } = compileExtension({ root });
  let manifest = null;
  let dropped = [];
  const own = files.get("manifest.json");
  if (own) {
    let parsed;
    try {
      parsed = JSON.parse(own.toString("utf8"));
    } catch {
      problems.push("extension/manifest.json isn't valid JSON");
    }
    if (parsed !== undefined) {
      const check = checkProductManifest(parsed, { allowed: briefPermissions(root) });
      problems.push(...check.problems);
      for (const f of check.files) if (!files.has(f)) problems.push(`the manifest names ${f}, which isn't in extension/ (a .ts file compiles to .js)`);
      dropped = check.dropped;
      for (const p of dropped) problems.push(`the manifest asks for ${p}, which brief.md doesn't list. The platform leaves it out when it packages the extension, so take it out or stop using it`);
      if (check.manifest) manifest = finalManifest(check.manifest, origin);
    }
  }
  return { files, problems, manifest };
}

/** Builds the folder Chrome loads: the compiled files, the final manifest and config.js for `origin`. */
export function buildExtension({ root, origin, out }) {
  const checked = checkExtension({ root, origin });
  if (checked.problems.length || !checked.manifest) return { ok: false, problems: checked.problems, out };
  rmSync(out, { recursive: true, force: true });
  for (const [p, content] of checked.files) {
    if (p === "manifest.json") continue;
    mkdirSync(path.dirname(path.join(out, p)), { recursive: true });
    writeFileSync(path.join(out, p), content);
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(checked.manifest, null, 2)}\n`);
  writeFileSync(path.join(out, "config.js"), extensionConfigSource(origin));
  return { ok: true, problems: [], out, manifest: checked.manifest };
}

/** The bundle the platform packages from: compiled files and the product's own manifest. */
export function bundleExtension({ root }) {
  const { files, problems } = compileExtension({ root });
  return { problems, bundle: { musemuse_extension: 1, files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([p, c]) => ({ path: p, base64: c.toString("base64") })) } };
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && statSync(process.argv[1]).ino === statSync(fileURLToPath(import.meta.url)).ino;
  } catch {
    return false;
  }
}

if (isMain()) {
  const [command] = process.argv.slice(2);
  const arg = (name, fallback) => {
    const at = process.argv.indexOf(name);
    return at > 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
  };
  const root = path.resolve(arg("--root", path.resolve(HERE, "..")));
  const say = (problems) => problems.forEach((p) => process.stderr.write(`extension: ${p}\n`));
  try {
    if (command === "build") {
      const origin = extensionOrigin(arg("--origin", "http://localhost:3000"), { allowLoopback: true });
      const out = path.resolve(root, arg("--out", "test-results/caps/extension-build"));
      const built = buildExtension({ root, origin, out });
      say(built.problems);
      if (built.ok) process.stdout.write(`${JSON.stringify({ ok: true, out, origin })}\n`);
      process.exit(built.ok ? 0 : 1);
    } else if (command === "check") {
      const { problems } = checkExtension({ root });
      say(problems);
      process.stdout.write(`${JSON.stringify({ ok: !problems.length, problems })}\n`);
      process.exit(problems.length ? 1 : 0);
    } else if (command === "bundle") {
      const out = arg("--out", null);
      if (!out) throw new Error("bundle needs --out <file.json>");
      const { problems, bundle } = bundleExtension({ root });
      say(problems);
      if (!problems.length) writeFileSync(path.resolve(out), JSON.stringify(bundle));
      process.exit(problems.length ? 1 : 0);
    } else {
      process.stderr.write("Use: node scripts/extension-pack.mjs build|check|bundle\n");
      process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`extension: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}
