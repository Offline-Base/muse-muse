import path from "node:path";

/**
 * What an extension's files may not do (docs/CAPABILITIES.md, section 20), checked before the platform packages it.
 * Manifest V3 and the platform's content security policy are the real guards: Chrome runs no remote or inline code,
 * and the extension's pages and service worker can reach only the product's own link. These checks catch the plain
 * cases early, in words a fix round can act on: code loaded at run time, network calls that skip the platform helper,
 * pages that pull scripts or styles from elsewhere. They read text, so code written to hide from them gets past them,
 * and the browser's policy still stops it.
 *
 * The overlay's packer runs the same scan in the build (scripts/extension-pack.mjs). A parity test keeps them in step.
 */

/** The platform helper, the only file that makes network calls (to the product's own actions). */
export const PLATFORM_HELPER = "platform.js";
/** Written by the platform when it packages, never by the product. */
export const RESERVED_FILES = ["config.js", "manifest.json"] as const;

const IMPORT_FROM = /(?:^|[\s;}])(?:import|export)\s[^;'"`]*?\bfrom\s*(['"])([^'"\n]+)\1/g;
const BARE_IMPORT = /(?:^|[\s;}])import\s*(['"])([^'"\n]+)\1/g;

const CODE_RULES: Array<[RegExp, string]> = [
  [/\bimport\s*\(/, "loads code at run time with import(). Import it at the top of the file instead"],
  [/\bimportScripts\s*\(/, "loads code at run time with importScripts(). Import it at the top of the file instead"],
  [/\beval\s*\(/, "runs text as code with eval()"],
  [/\bnew\s+Function\s*\(/, "runs text as code with new Function()"],
  [/\bchrome\s*\.\s*scripting\b/, "uses chrome.scripting, which changes pages. The extension may only read the current page's address and title"],
  [/\bchrome\s*\.\s*tabs\s*\.\s*executeScript\b/, "uses chrome.tabs.executeScript, which changes pages"],
  [/\bchrome\s*\.\s*debugger\b/, "uses chrome.debugger"],
  [/\bcaptureVisibleTab\b/, "uses chrome.tabs.captureVisibleTab, which takes a picture of the page. The extension may only read the current page's address and title"],
  [/\bchrome\s*\.\s*(?:tabCapture|desktopCapture|pageCapture)\b/, "records or saves what's on a page or screen (tabCapture, desktopCapture, pageCapture)"],
];

/**
 * Paths that would land on another file when someone unzips the extension on a Mac or Windows disk, which ignores
 * capital letters: two names that differ only in case, a name that is the platform's manifest.json or config.js in
 * other letters, and a folder named like a file (config.js/x.js). Chrome also keeps names that start with "_" for
 * itself; isExtensionPath refuses those. `paths` are the extension's files without the platform's config.js.
 */
export function pathClashes(paths: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const name of RESERVED_FILES) seen.set(name, name);
  for (const p of paths) {
    const lower = p.toLowerCase();
    const other = seen.get(lower);
    if (p === "manifest.json") continue;
    if (other !== undefined && other !== p) {
      problems.push(
        (RESERVED_FILES as readonly string[]).includes(other)
          ? `${p} would replace the platform's ${other} on a Mac or Windows disk, which ignores capital letters. Give it another name`
          : `${p} and ${other} differ only in capital letters, so they'd be one file on a Mac or Windows disk. Give one another name`,
      );
      continue;
    }
    seen.set(lower, p);
  }
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const file = seen.get(dir.toLowerCase());
      if (file !== undefined) {
        problems.push(`${p} is in a folder named like the file ${file}. Give the folder another name`);
        break;
      }
    }
  }
  return problems;
}

const NETWORK_RULES: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, "fetch()"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bEventSource\b/, "EventSource"],
  [/\bsendBeacon\b/, "sendBeacon"],
];

/** Removes comments, so a rule never fires on a comment and a comment can't hide code from the import check. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** The relative modules a compiled file imports, as written. */
export function importsOf(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  for (const re of [IMPORT_FROM, BARE_IMPORT]) for (const m of code.matchAll(re)) out.push(m[2]!);
  return [...new Set(out)];
}

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  return joined.startsWith("../") || joined.startsWith("/") ? null : joined;
}

const REMOTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Checks one compiled script. `names` is every file the extension will have. */
function scanScript(file: string, source: string, names: ReadonlySet<string>): string[] {
  const problems: string[] = [];
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
const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");

function attr(tag: string, name: string): string | null {
  const m = tag.match(ATTR(name));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

function scanHtml(file: string, html: string, names: ReadonlySet<string>): string[] {
  const problems: string[] = [];
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

function scanCss(file: string, css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  return /(@import\s+(url\()?\s*['"]?\s*(https?:)?\/\/)|url\(\s*['"]?\s*(https?:)?\/\//i.test(text)
    ? [`${file} loads a style, font or image from another site. Ship it in the extension instead`]
    : [];
}

/**
 * Every problem with an extension's files, by path. `files` holds the compiled extension, without the platform's
 * config.js and with the product's own manifest.json.
 */
export function scanExtensionFiles(files: ReadonlyMap<string, Buffer>): string[] {
  const names = new Set([...files.keys(), "config.js"]);
  const problems: string[] = [];
  for (const [file, content] of files) {
    const lower = file.toLowerCase();
    if (lower.endsWith(".js")) problems.push(...scanScript(file, content.toString("utf8"), names));
    else if (lower.endsWith(".html")) problems.push(...scanHtml(file, content.toString("utf8"), names));
    else if (lower.endsWith(".css")) problems.push(...scanCss(file, content.toString("utf8")));
  }
  return problems;
}
