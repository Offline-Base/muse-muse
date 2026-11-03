/**
 * The Muse gadget pack (docs/PRODUCT_OUTPUTS.md): a product's public actions as custom commands for a Muse gadget that
 * runs Meta's Linux Gadget SDK, which reads them from /etc/musegadget/commands.d. The person installs the pack on their
 * own gadget, paired with their own Muse account and token, and then their Muse can use the product from the gadget and
 * their chat. Muse Muse never holds a Gadget SDK token, and never pairs, installs or runs anything on a device.
 *
 * Pure. Manifests are written by Muse Code, so their text is data here: it goes into JSON as JSON strings, length-capped,
 * and never into the shell scripts, which hold only names made of [a-z0-9_.]. The live address comes from the product's
 * database row, never from the manifest.
 */
import { GADGET_INSTALL_SOURCE, GADGET_RUNNER_SOURCE, GADGET_UNINSTALL_SOURCE } from "@/lib/outputs/assets-source";
import { BUILDER_WORDS, NOT_OFFICIAL, fenced, oneLine, publicActions, shellQuote, type OutputAction, type OutputProduct } from "@/lib/outputs/generate";
import { makeZip, type ZipEntry } from "@/lib/outputs/zip";

/** Meta's setup guide for the Linux SDK, which the pack needs on the gadget first. */
export const GADGET_SDK_URL = "https://github.com/facebookincubator/muse-gadget-sdk/blob/main/linux/README.md";
export const GADGET_SDK_TERMS_URL = "https://gadgets.muse.ai/sdk-terms";

// The SDK's rules for a custom command, read Oct 31, 2026 from its README ("Add your own commands": names are lowercase
// words joined by dots, the reserved prefixes, the six types, the 30 s default and the 256 KiB total) and from its command
// loader, linux/src/musegadget/commands.py (the exact name pattern, 64 characters, the allowed keys, {type, description},
// timeout_ms from 1 to 600000, the 5 s grace and 64 KiB a file). The loader's limits aren't documented and may change, so
// check them again when the SDK updates. Nothing here is copied from it.
export const GADGET_PARAM_TYPES = ["string", "integer", "number", "boolean", "object", "array"] as const;
export type GadgetParamType = (typeof GADGET_PARAM_TYPES)[number];
export const GADGET_RESERVED_PREFIXES = ["system.", "file.", "device.", "link."] as const;
export const GADGET_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const GADGET_MAX_NAME = 64;
export const GADGET_DEFAULT_TIMEOUT_MS = 30_000;
export const GADGET_MAX_TIMEOUT_MS = 600_000;
/** The runner keeps 1.5 s to say why it stopped, so a shorter timeout leaves no time for the call. */
export const GADGET_MIN_TIMEOUT_MS = 2_000;
/**
 * An agent product's actions run its agent loop for up to 100 s (actionBudget in the agent kit, under the MCP connector's
 * 120 s), so its commands wait that long plus a little, instead of the 30 s default that cuts every run short.
 */
export const GADGET_AGENT_TIMEOUT_MS = 110_000;
/** What the SDK adds to each command's timeout when it registers it with Muse. */
export const GADGET_TIMEOUT_GRACE_MS = 5_000;
/** All of a gadget's registrations together, built-ins included, may be at most this. */
export const GADGET_REGISTRATION_LIMIT = 256 * 1024;
/** What one pack takes of that, leaving room for the built-ins, other packs and the message around them. */
export const GADGET_REGISTRATION_BUDGET = 192 * 1024;
/** The SDK reads at most this much of one command file. */
export const GADGET_MAX_FILE_BYTES = 64 * 1024;

const MAX_COMMAND_DESCRIPTION = 1000;
const MAX_PARAM_DESCRIPTION = 300;
const MAX_PARAMS = 64;
const MAX_PARAM_NAME = 64;
const MAX_PREFIX = 32;
/** An action name the runner puts in a web address as it is. The schema asks for ^[a-z][a-z0-9_]*$. */
const SAFE_ACTION = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export const GADGET_COMMANDS_DIR = "/etc/musegadget/commands.d";
export const gadgetFileName = (slug: string) => `${slug}-muse-gadget.zip`;
/** The folder at the top of the zip, so unzipping it doesn't scatter files. */
export const gadgetFolder = (slug: string) => `${slug}-muse-gadget`;
export const gadgetLibDir = (prefix: string) => `/usr/local/lib/${prefix}-gadget`;

export interface GadgetParam {
  type: GadgetParamType;
  description: string;
}

/** A command file's contents, in the SDK's shape. */
export interface GadgetSpec {
  description: string;
  exec: string[];
  required: Record<string, GadgetParam>;
  optional: Record<string, GadgetParam>;
  timeout_ms: number;
}

export interface GadgetCommand {
  /** The command's name on the gadget, and its file's name without .json. */
  name: string;
  /** The product's action it runs. */
  action: string;
  spec: GadgetSpec;
}

export interface GadgetPack {
  prefix: string;
  libDir: string;
  /** In the manifest's order. */
  commands: GadgetCommand[];
  /** Public actions with no command, and why. */
  leftOut: Array<{ action: string; why: string }>;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/** A short, steady hash (FNV-1a), for names that need telling apart. No crypto: the panel imports this file too. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (const byte of utf8(text)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

/** One word of a command name: lowercase letters, digits and underscores, starting with a letter. */
function word(text: string, lead: string): string {
  const w = text.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!w) return lead;
  return /^[a-z]/.test(w) ? w : `${lead}_${w}`;
}

/** Cuts a word to a length, never leaving it ending in an underscore or empty. */
function cutWord(w: string, max: number): string {
  return w.slice(0, Math.max(1, max)).replace(/_+$/, "") || "a";
}

/**
 * The first word of every command in a product's pack, from its slug: `shelf-counter` is `shelf_counter`. Two products
 * must never share one, or one pack would replace the other's runner and commands. So the plain form is kept only when it
 * starts with a letter, isn't one the SDK keeps for itself (system, file, device, link), doesn't start with `mm_` and fits
 * in 32 characters. Every other slug becomes `mm_<slug, cut>_<hash of the slug>`. Plain forms never start with `mm_` and
 * changed ones always do, so the two can't meet, and changed ones differ by their slug's hash.
 */
export function gadgetPrefix(slug: string): string {
  const plain = slug.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const keep =
    /^[a-z]/.test(plain) && !plain.startsWith("mm_") && plain.length <= MAX_PREFIX && !GADGET_RESERVED_PREFIXES.some((r) => `${plain}.`.startsWith(r));
  if (keep) return plain;
  const core = plain ? `_${cutWord(plain, MAX_PREFIX - 3 - 7)}` : "";
  return `mm${core}_${shortHash(slug)}`;
}

/**
 * How long the gadget lets a command run: the action's own `timeoutMs` when its manifest has one, within the SDK's limits,
 * else GADGET_AGENT_TIMEOUT_MS for an agent product (its manifest has an `agent` block) and the SDK's 30 s for the rest.
 */
export function gadgetTimeoutMs(action: OutputAction, { agent = false }: { agent?: boolean } = {}): number {
  const raw = (action as { timeoutMs?: unknown }).timeoutMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return agent ? GADGET_AGENT_TIMEOUT_MS : GADGET_DEFAULT_TIMEOUT_MS;
  return Math.min(GADGET_MAX_TIMEOUT_MS, Math.max(GADGET_MIN_TIMEOUT_MS, Math.round(raw)));
}

type Schema = Record<string, unknown>;
const isObject = (v: unknown): v is Schema => !!v && typeof v === "object" && !Array.isArray(v);
const isParamType = (t: unknown): t is GadgetParamType => (GADGET_PARAM_TYPES as readonly unknown[]).includes(t);

function typeOfValue(value: unknown): GadgetParamType {
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (isObject(value)) return "object";
  return "string";
}

/**
 * The SDK's one type for a JSON Schema field. A list of types takes its first one that isn't null. With no type, an enum,
 * const or default says it, then properties or items, and anything else is a string.
 */
export function gadgetParamType(schema: unknown): GadgetParamType {
  const s = isObject(schema) ? schema : {};
  const named = Array.isArray(s.type) ? s.type.find((t) => t !== "null" && isParamType(t)) : s.type;
  if (isParamType(named)) return named;
  const sample = "const" in s ? s.const : Array.isArray(s.enum) ? s.enum.find((v) => v !== null) : "default" in s ? s.default : undefined;
  if (sample !== undefined && sample !== null) return typeOfValue(sample);
  if (isObject(s.properties)) return "object";
  if (s.items !== undefined) return "array";
  return "string";
}

function paramDescription(name: string, schema: unknown, type: GadgetParamType): string {
  const s = isObject(schema) ? schema : {};
  const own = typeof s.description === "string" ? oneLine(s.description, MAX_PARAM_DESCRIPTION) : "";
  const choices = Array.isArray(s.enum) && s.enum.length ? `One of: ${s.enum.slice(0, 20).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ")}.` : "";
  const said = [own && own.replace(/\.?$/, "."), choices].filter(Boolean).join(" ");
  return oneLine(said || `The ${name} field, ${/^[aeiou]/.test(type) ? "an" : "a"} ${type}.`, MAX_PARAM_DESCRIPTION);
}

/** The action's input fields as the SDK's parameters. Only top-level fields: the gadget passes only declared ones. */
export function gadgetParams(input: unknown): Pick<GadgetSpec, "required" | "optional"> {
  const schema = isObject(input) ? input : {};
  const props = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : []);
  const fields = Object.entries(props)
    .filter(([name]) => name.length > 0 && name.length <= MAX_PARAM_NAME && !CONTROL.test(name))
    .slice(0, MAX_PARAMS)
    .map(([name, field]) => {
      const type = gadgetParamType(field);
      return [name, { type, description: paramDescription(name, field, type) }] as const;
    });
  // fromEntries makes own properties, so a field called __proto__ stays a field.
  return {
    required: Object.fromEntries(fields.filter(([name]) => required.has(name))),
    optional: Object.fromEntries(fields.filter(([name]) => !required.has(name))),
  };
}

/** What one command adds to the gadget's registration with Muse: its name and what the SDK sends for it. */
export function gadgetRegistrationBytes(command: Pick<GadgetCommand, "name" | "spec">): number {
  const { description, required, optional, timeout_ms } = command.spec;
  return utf8(JSON.stringify({ [command.name]: { description, required, optional, timeout_ms: timeout_ms + GADGET_TIMEOUT_GRACE_MS } })).length;
}

const commandFile = (command: GadgetCommand) => `${JSON.stringify(command.spec, null, 2)}\n`;

/**
 * The pack's commands. Each public action is `<prefix>.<action>`. Names that would clash, or run over 64 characters, all
 * get a hash of their action's name, so which one keeps the plain name never depends on the manifest's order. Commands
 * that would take the pack past its share of the registration are left out in name order, the order the SDK reads them.
 */
export function gadgetPack(product: Pick<OutputProduct, "slug" | "name" | "manifest">): GadgetPack {
  const prefix = gadgetPrefix(product.slug);
  const libDir = gadgetLibDir(prefix);
  const productName = oneLine(product.name, 80);
  const agent = !!product.manifest?.agent;
  const leftOut: GadgetPack["leftOut"] = [];
  const seen = new Set<string>();
  const actions: OutputAction[] = [];
  for (const action of publicActions(product.manifest)) {
    if (!SAFE_ACTION.test(action.name)) leftOut.push({ action: action.name, why: "Its name can't go in a web address as it is." });
    else if (seen.has(action.name)) leftOut.push({ action: action.name, why: "Another action has the same name." });
    else {
      seen.add(action.name);
      actions.push(action);
    }
  }

  const plain = actions.map((a) => `${prefix}.${word(a.name, "a")}`);
  const room = GADGET_MAX_NAME - prefix.length - 1 - 7;
  const names = actions.map((a, i) => {
    const clash = plain.filter((n) => n === plain[i]).length > 1;
    return clash || plain[i]!.length > GADGET_MAX_NAME ? `${prefix}.${cutWord(word(a.name, "a"), room)}_${shortHash(a.name)}` : plain[i]!;
  });
  // A hashed name could still meet another action's plain one. The later one counts up, in the manifest's order.
  const used = new Set<string>();
  const unique = names.map((name) => {
    let out = name;
    for (let n = 2; used.has(out); n++) out = `${name.slice(0, GADGET_MAX_NAME - String(n).length - 1)}_${n}`;
    used.add(out);
    return out;
  });

  const all: GadgetCommand[] = actions.map((action, i) => {
    const what = oneLine(action.description, MAX_COMMAND_DESCRIPTION - productName.length - 2) || `Runs ${action.name}.`;
    return {
      name: unique[i]!,
      action: action.name,
      spec: {
        description: oneLine(`${productName}: ${what}`, MAX_COMMAND_DESCRIPTION),
        exec: [`${libDir}/node`, `${libDir}/runner.cjs`, action.name],
        ...gadgetParams(action.input),
        timeout_ms: gadgetTimeoutMs(action, { agent }),
      },
    };
  });

  const kept = new Set<string>();
  let total = 0;
  for (const command of [...all].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const size = gadgetRegistrationBytes(command);
    if (utf8(commandFile(command)).length > GADGET_MAX_FILE_BYTES) leftOut.push({ action: command.action, why: "Its command file would be too big for the gadget." });
    else if (total + size > GADGET_REGISTRATION_BUDGET) leftOut.push({ action: command.action, why: "The gadget has room for only so many commands, and this one didn't fit." });
    else {
      total += size;
      kept.add(command.name);
    }
  }
  return { prefix, libDir, commands: all.filter((c) => kept.has(c.name)), leftOut };
}

/** The gadget's runner, with the live address and the actions it may call written in. It holds no manifest text. */
export function gadgetRunnerSource(pack: GadgetPack, liveUrl: string): string {
  const data = { liveUrl, actions: Object.fromEntries(pack.commands.map((c) => [c.action, { timeoutMs: c.spec.timeout_ms }])) };
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const start = GADGET_RUNNER_SOURCE.indexOf("/*__MUSE_GADGET__*/");
  const end = GADGET_RUNNER_SOURCE.indexOf(";", start);
  return `${GADGET_RUNNER_SOURCE.slice(0, start)}${json}${GADGET_RUNNER_SOURCE.slice(end)}`;
}

/**
 * install.sh or uninstall.sh with the pack's names in, and the slug, which they keep in pack.txt so a pack never replaces
 * another product's. Those are all [a-z0-9_.-], and quoted all the same.
 */
function script(source: string, pack: GadgetPack, slug: string): string {
  const names = pack.commands.map((c) => c.name);
  if (!/^[a-z][a-z0-9_]*$/.test(pack.prefix) || !/^[a-z0-9-]+$/.test(slug) || !names.every((n) => GADGET_NAME_RE.test(n))) throw new Error("A gadget name isn't what the scripts expect.");
  return source
    .replace("__MUSE_GADGET_PREFIX__", () => shellQuote(pack.prefix))
    .replace("__MUSE_GADGET_SLUG__", () => shellQuote(slug))
    .replace("__MUSE_GADGET_COMMANDS__", () => names.map(shellQuote).join(" "));
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/** How long the pack's commands wait, in words: "30 s", or "10 to 120 s" when they differ. */
export function gadgetWait(pack: Pick<GadgetPack, "commands">): string {
  const all = pack.commands.map((c) => c.spec.timeout_ms);
  if (!all.length) return seconds(GADGET_DEFAULT_TIMEOUT_MS);
  const low = Math.min(...all);
  const high = Math.max(...all);
  return low === high ? seconds(low) : `${Math.round(low / 1000)} to ${seconds(high)}`;
}

/** The pack's README: what it does, what it needs, where data goes and the terms that matter. */
export function gadgetReadme(product: OutputProduct, pack: GadgetPack): string {
  const { slug } = product;
  const live = product.liveUrl ?? "";
  const names = pack.commands.map((c) => `\`${c.name}\``).join(", ");
  const first = pack.commands[0]?.name ?? "";
  const lines = [
    `# ${slug} for your Muse gadget`,
    "",
    NOT_OFFICIAL,
    "",
    BUILDER_WORDS("The product's name"),
    "",
    fenced(oneLine(product.name, 80), "text"),
    "",
    "These are custom commands for a Muse gadget you set up yourself with Meta's Linux Gadget SDK. Once they're installed,",
    "your Muse can use this product from the gadget and from your Muse chat. Ask for what you want done, or name a command,",
    `such as "run ${first}".`,
    "",
    `It has ${pack.commands.length} command${pack.commands.length === 1 ? "" : "s"}: ${names}.`,
    "",
    `Each command stops after ${gadgetWait(pack)} (the gadget's limit for it, listed under "The commands"), so an action that takes longer ends with a timeout on the gadget, though it may still work from the product's page or its CLI.`,
    "",
    "## What you need",
    "",
    `- A Linux machine with Meta's Linux Gadget SDK installed and paired with **your own** Muse account and **your own** SDK token: ${GADGET_SDK_URL}`,
    "- We recommend installing the SDK with `--run-as` an account that can't use sudo. These commands run as that account.",
    "- Node.js 18 or newer on the gadget, such as `sudo apt install nodejs`.",
    "- Muse Muse never asks for your SDK token, and this pack has none in it. Nothing here pairs a device or changes the SDK's settings.",
    "",
    "## Install",
    "",
    "```sh",
    `unzip ${gadgetFileName(slug)} && cd ${gadgetFolder(slug)}`,
    "less install.sh               # read it first",
    "bash install.sh --dry-run     # see what it would do, changing nothing",
    "sudo bash install.sh",
    "sudo journalctl -u musegadget | grep commands",
    "```",
    "",
    `install.sh copies the command files to \`${GADGET_COMMANDS_DIR}\` and \`runner.cjs\` to \`${pack.libDir}\`, owned by root and`,
    "writable only by root, links the Node it found there, and restarts the `musegadget` service. Add `--node /path/to/node`",
    "to pick a Node, or `--no-restart` to restart later yourself.",
    "",
    "To remove them: `sudo bash uninstall.sh`.",
    "",
    "## What data goes where",
    "",
    `- When your Muse runs one of these commands, the gadget runs \`runner.cjs\` with the command's inputs. It sends them over the web to the live product at ${live}/api/actions/<action> and passes the reply back to your Muse.`,
    "- The product sees those inputs as it sees any use of its web page, and its Muse models may read them. Send only what you would type into the product itself.",
    "- The product records its calls as it records any other use, such as what each one cost. Your SDK token, your pairing, your files and your gadget's name don't leave the gadget through this pack.",
    "",
    "## Meta's terms",
    "",
    `Read Meta's Gadget SDK Terms yourself (${GADGET_SDK_TERMS_URL}). The points that matter here, as a summary and not legal advice:`,
    "",
    "- Your SDK token is for your own personal, non-commercial use with your own Muse account.",
    "- Don't put these commands or the SDK in a gadget that is sold, advertised or listed, or given away in connection with a promotion, incentive or reward.",
    "- If other people use your gadget, tell them what it does with their information first.",
    "- Some commands may change data in the product. Check what your Muse is about to do before it does it.",
    "",
    "## The commands",
    "",
    ...pack.commands.flatMap((c) => [
      `### \`${c.name}\``,
      "",
      `Runs the action \`${c.action}\`, waits up to ${seconds(c.spec.timeout_ms)}, and is described by \`commands.d/${c.name}.json\`.`,
      "",
      BUILDER_WORDS("What it does"),
      "",
      fenced(c.spec.description, "text"),
      "",
    ]),
    ...(pack.leftOut.length
      ? ["## Left out", "", "These actions have no command here:", "", fenced(pack.leftOut.map((l) => `- ${oneLine(l.action, 80)}: ${l.why}`).join("\n"), "text"), ""]
      : []),
  ];
  return lines.join("\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** The zip's files, under one folder. */
export function gadgetEntries(product: OutputProduct): ZipEntry[] {
  const pack = gadgetPack(product);
  const folder = gadgetFolder(product.slug);
  return [
    { path: `${folder}/README.md`, content: gadgetReadme(product, pack) },
    { path: `${folder}/install.sh`, content: script(GADGET_INSTALL_SOURCE, pack, product.slug) },
    { path: `${folder}/uninstall.sh`, content: script(GADGET_UNINSTALL_SOURCE, pack, product.slug) },
    { path: `${folder}/runner.cjs`, content: gadgetRunnerSource(pack, product.liveUrl ?? "") },
    ...pack.commands.map((c) => ({ path: `${folder}/commands.d/${c.name}.json`, content: commandFile(c) })),
  ];
}

export function gadgetZip(product: OutputProduct): Buffer {
  return makeZip(gadgetEntries(product));
}
