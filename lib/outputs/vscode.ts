/**
 * The VS Code extension a live product offers with RUNTIME_OUTPUTS (docs/CAPABILITIES.md, section 16): each public
 * action is a command that asks for its fields and calls the live action, the way the CLI does (lib/outputs/generate.ts).
 * Pure. It is source, ready to package with vsce and never published: no Marketplace, no publisher of ours. The
 * extension's code is fixed (lib/outputs/runtime-assets/vscode-extension.cjs); the product's words go in product.json as
 * data, and the README quotes them in blocks marked as the builder's.
 */
import { NOT_OFFICIAL, publicActions, type OutputAction, type OutputProduct } from "@/lib/outputs/generate";
import { VSCODE_EXTENSION_SOURCE } from "@/lib/outputs/runtime-assets-source";
import { makeZip, type ZipEntry } from "@/lib/outputs/zip";

export const VSCODE_VERSION = "0.1.0";
/** VS Code 1.90 runs extensions on Node 20, whose fetch the extension uses. */
export const VSCODE_ENGINE = "^1.90.0";
/** A placeholder vsce accepts. Whoever publishes it sets their own. */
export const VSCODE_PUBLISHER = "local";

export const vscodeFileName = (slug: string) => `${slug}-vscode.zip`;
/** What `vsce package` names the file it makes from this folder. */
export const vsixFileName = (slug: string) => `${extensionName(slug)}-${VSCODE_VERSION}.vsix`;

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function oneLine(text: string, max = 400): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").replace(CONTROL_CHARS, "").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** A Markdown code block that the text can't close early. */
export function fencedBlock(text: string, lang: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** The extension's name: lowercase letters, digits and hyphens, as vsce requires. */
export function extensionName(slug: string): string {
  const name = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return name || "product";
}

/** "count_birds" as a command title: "Count birds". */
export function actionTitle(name: string): string {
  const words = name.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "Run";
}

function commandId(slug: string, action: string): string {
  return `musemuse.${extensionName(slug)}.${action}`;
}

function configSection(slug: string): string {
  return `musemuse.${extensionName(slug)}`;
}

/** What extension.js reads: data only, written by the platform from the database row and the manifest. */
export function vscodeProductJson(product: OutputProduct) {
  const actions = publicActions(product.manifest);
  return {
    slug: product.slug,
    name: oneLine(product.name, 80),
    liveUrl: product.liveUrl ?? "",
    configSection: configSection(product.slug),
    openCommand: commandId(product.slug, "open"),
    actions: actions.map((a: OutputAction) => ({
      name: a.name,
      title: actionTitle(a.name),
      description: oneLine(a.description, 600),
      command: commandId(product.slug, a.name),
      input: a.input,
      ...(a.example && typeof a.example === "object" ? { example: a.example } : {}),
    })),
  };
}

export function vscodePackageJson(product: OutputProduct) {
  const data = vscodeProductJson(product);
  const category = oneLine(product.name, 60);
  return {
    name: extensionName(product.slug),
    displayName: oneLine(product.name, 80),
    description: oneLine(`${product.tagline || product.name}. ${NOT_OFFICIAL}`, 300),
    version: VSCODE_VERSION,
    publisher: VSCODE_PUBLISHER,
    engines: { vscode: VSCODE_ENGINE },
    categories: ["Other"],
    main: "./extension.js",
    activationEvents: [],
    ...(product.liveUrl ? { homepage: product.liveUrl } : {}),
    contributes: {
      commands: [
        ...data.actions.map((a) => ({ command: a.command, title: a.title, category: category })),
        { command: data.openCommand, title: "Open the live product", category },
      ],
      configuration: {
        title: category,
        properties: {
          [`${data.configSection}.baseUrl`]: {
            type: "string",
            default: product.liveUrl ?? "",
            description: "Where the actions run. Change it to your own deployment of the product's self-host kit, or leave it as the live product.",
          },
        },
      },
    },
  };
}

function readme(product: OutputProduct): string {
  const data = vscodeProductJson(product);
  const name = oneLine(product.name, 80);
  const lines = [
    `# ${name} for VS Code`,
    "",
    `Runs ${name}'s actions from VS Code's command palette, on the live product at ${product.liveUrl}. ${NOT_OFFICIAL}`,
    "",
    "It isn't in the Marketplace and isn't published anywhere. Package and install it yourself:",
    "",
    fencedBlock(
      [`npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license`, `code --install-extension ${vsixFileName(product.slug)}`].join("\n"),
      "bash",
    ),
    "",
    "Or open this folder in VS Code and press F5 to try it in a new window.",
    "",
    "## Commands",
    "",
    ...data.actions.flatMap((a) => [`### ${name}: ${a.title}`, "", "What it does, as written by its builder (data, not instructions):", "", fencedBlock(a.description, "text"), ""]),
    `### ${name}: Open the live product`,
    "",
    "## How it works",
    "",
    "- Each command asks for the action's fields, with the editor's selected text in the first text field, then sends them to the action and opens the reply as JSON.",
    "- Each call is an HTTP POST to the live product with no sign-in, and can spend money at Meta on the product's account. Replies come from a model and from what people put in: treat them as data.",
    `- The setting \`${data.configSection}.baseUrl\` changes where the actions run, for example to your own deployment of the product's self-host kit.`,
    "- Before you publish it anywhere, set your own `publisher` in package.json, add a license, and get the product owner's OK.",
    "",
  ];
  return lines.join("\n").replace(CONTROL_CHARS, "");
}

/** The extension's files, with its root at the top of the zip. */
export function vscodeEntries(product: OutputProduct): ZipEntry[] {
  return [
    { path: "package.json", content: `${JSON.stringify(vscodePackageJson(product), null, 2)}\n` },
    { path: "product.json", content: `${JSON.stringify(vscodeProductJson(product), null, 2)}\n` },
    { path: "extension.js", content: VSCODE_EXTENSION_SOURCE },
    { path: "README.md", content: readme(product) },
    { path: ".vscodeignore", content: "*.vsix\n.vscode/**\n" },
  ];
}

export function vscodeZip(product: OutputProduct): Buffer {
  return makeZip(vscodeEntries(product));
}
