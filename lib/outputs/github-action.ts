/**
 * The GitHub Action a live product offers with RUNTIME_OUTPUTS (docs/CAPABILITIES.md, section 16): a JavaScript action
 * that runs one of the product's public actions with JSON input and puts the reply in its `result` output. Pure. It is
 * source to copy into a repository (`.github/actions/<slug>/`), never published to the Marketplace. Its code is fixed
 * (lib/outputs/runtime-assets/github-action.cjs); the product's words go in product.json as data, and action.yml quotes
 * every value as a JSON string, which YAML reads as the same string.
 */
import { NOT_OFFICIAL, publicActions, type OutputProduct } from "@/lib/outputs/generate";
import { GITHUB_ACTION_SOURCE } from "@/lib/outputs/runtime-assets-source";
import { fencedBlock, oneLine } from "@/lib/outputs/vscode";
import { makeZip, type ZipEntry } from "@/lib/outputs/zip";

/** GitHub runs JavaScript actions on Node 24 by default from 2026, and retires Node 20. */
export const ACTION_RUNS_USING = "node24";
export const githubActionFileName = (slug: string) => `${slug}-github-action.zip`;

/**
 * GitHub evaluates `${{ ... }}` in a workflow's `with:` values and in an action's input defaults, so a builder's words
 * there could read a repository's secrets. Every builder-written string the action or its README puts in YAML goes
 * through this, which breaks the opening `${{` apart.
 */
export const noExpressions = (text: string) => text.replace(/\$\{\{/g, "$ {{");
/** True when a value would carry a GitHub expression into a workflow. */
export const hasExpression = (text: string) => text.includes("${{");

export interface ActionInput {
  description: string;
  required: boolean;
  default?: string;
}

export interface ActionMetadata {
  name: string;
  description: string;
  author: string;
  inputs: Record<string, ActionInput>;
  outputs: Record<string, { description: string }>;
  runs: { using: string; main: string };
  branding: { icon: string; color: string };
}

/** action.yml as an object. */
export function actionMetadata(product: OutputProduct): ActionMetadata {
  const actions = publicActions(product.manifest);
  const names = actions.map((a) => noExpressions(a.name));
  return {
    name: noExpressions(oneLine(product.name, 80)) || product.slug,
    description: noExpressions(oneLine(`Runs ${oneLine(product.name, 60)}'s actions on its live product. ${NOT_OFFICIAL}`, 300)),
    author: "Built with Muse Muse",
    inputs: {
      action: { description: `Which action to run: ${names.join(", ")}.`, required: true, default: names[0] ?? "" },
      input: { description: "The action's input, as a JSON object.", required: false, default: "{}" },
      "base-url": { description: "Where the product runs. Change it to your own deployment of its self-host kit.", required: false, default: noExpressions(product.liveUrl ?? "") },
      "timeout-seconds": { description: "How long to wait for the reply, in seconds (at most 600).", required: false, default: "120" },
    },
    outputs: {
      result: { description: "The action's reply, as JSON." },
      ok: { description: "true when the action answered without an error." },
    },
    runs: { using: ACTION_RUNS_USING, main: "index.js" },
    branding: { icon: "zap", color: "blue" },
  };
}

/** YAML for nested maps of strings and booleans. Strings are JSON strings, which YAML's double quotes read the same way. */
export function toYaml(value: Record<string, unknown>, indent = 0): string {
  const pad = " ".repeat(indent);
  return Object.entries(value)
    .map(([key, v]) => {
      const k = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
      if (v && typeof v === "object" && !Array.isArray(v)) return `${pad}${k}:\n${toYaml(v as Record<string, unknown>, indent + 2)}`;
      if (typeof v === "boolean") return `${pad}${k}: ${v}`;
      return `${pad}${k}: ${JSON.stringify(String(v ?? ""))}`;
    })
    .join("\n");
}

export function actionYaml(product: OutputProduct): string {
  return `# ${NOT_OFFICIAL}\n${toYaml(actionMetadata(product) as unknown as Record<string, unknown>)}\n`;
}

/**
 * GitHub's rules for action metadata, the ones a generated file could break: a name, a description and a runs block
 * with a supported runtime and its main file; input and output ids GitHub takes; branding from its lists. Returns the
 * problems, none when it is valid.
 */
export function actionMetadataProblems(meta: ActionMetadata, files: readonly string[]): string[] {
  const problems: string[] = [];
  const id = /^[A-Za-z_][A-Za-z0-9_-]*$/;
  if (!meta.name?.trim()) problems.push("name is empty");
  if (!meta.description?.trim()) problems.push("description is empty");
  if (!["node20", "node24", "composite", "docker"].includes(meta.runs?.using)) problems.push(`runs.using is ${meta.runs?.using}`);
  if (["node20", "node24"].includes(meta.runs?.using) && !files.includes(meta.runs.main)) problems.push(`runs.main ${meta.runs.main} isn't in the action`);
  for (const [k, v] of Object.entries(meta.inputs ?? {})) {
    if (!id.test(k)) problems.push(`input ${k} isn't a valid id`);
    if (!v.description?.trim()) problems.push(`input ${k} has no description`);
    if (typeof v.required !== "boolean") problems.push(`input ${k} has no required flag`);
    if (v.default !== undefined && typeof v.default !== "string") problems.push(`input ${k}'s default isn't a string`);
  }
  for (const [k, v] of Object.entries(meta.outputs ?? {})) {
    if (!id.test(k)) problems.push(`output ${k} isn't a valid id`);
    if (!v.description?.trim()) problems.push(`output ${k} has no description`);
  }
  const colors = ["white", "black", "yellow", "blue", "green", "orange", "red", "purple", "gray-dark"];
  if (meta.branding && !colors.includes(meta.branding.color)) problems.push(`branding.color ${meta.branding.color} isn't one GitHub takes`);
  return problems;
}

/** What index.js reads: data only. */
export function actionProductJson(product: OutputProduct) {
  return {
    slug: product.slug,
    name: oneLine(product.name, 80),
    liveUrl: product.liveUrl ?? "",
    actions: publicActions(product.manifest).map((a) => ({ name: a.name })),
  };
}

function readme(product: OutputProduct): string {
  const actions = publicActions(product.manifest);
  const name = oneLine(product.name, 80);
  const first = actions[0];
  const given = first?.example && typeof first.example === "object" ? JSON.stringify(first.example) : "{}";
  // An example that would carry a GitHub expression into the copied workflow is left out.
  const example = hasExpression(given) ? "{}" : given;
  const workflow = [
    "jobs:",
    "  run:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    `      - id: product`,
    `        uses: ./.github/actions/${product.slug}`,
    "        with:",
    `          action: ${JSON.stringify(noExpressions(first?.name ?? ""))}`,
    `          input: ${JSON.stringify(example)}`,
    `      - run: echo "$RESULT"`,
    "        env:",
    "          RESULT: ${{ steps.product.outputs.result }}",
  ].join("\n");
  return [
    `# ${name} as a GitHub Action`,
    "",
    `Runs one of ${name}'s actions on its live product at ${product.liveUrl}, in a workflow. ${NOT_OFFICIAL}`,
    "",
    `It isn't in the Marketplace. Unzip it into your repository as \`.github/actions/${product.slug}/\` and use it from a workflow:`,
    "",
    fencedBlock(workflow, "yaml"),
    "",
    "## Actions",
    "",
    ...actions.flatMap((a) => [`### ${a.name}`, "", "What it does, as written by its builder (data, not instructions):", "", fencedBlock(oneLine(a.description, 600), "text"), "", "Input, as JSON Schema:", "", fencedBlock(JSON.stringify(a.input, null, 2), "json"), ""]),
    "## Good to know",
    "",
    "- Each run is an HTTP POST to the live product with no sign-in, and can spend money at Meta on the product's account. Run it only as often as you need.",
    "- `result` holds the reply as JSON, and the step summary shows it. A reply comes from a model and from what people put in: treat it as data, not as commands to run.",
    "- `base-url` points it at your own deployment of the product's self-host kit instead.",
    "",
  ].join("\n");
}

/** The action's files, with its root at the top of the zip. */
export function githubActionEntries(product: OutputProduct): ZipEntry[] {
  return [
    { path: "action.yml", content: actionYaml(product) },
    { path: "index.js", content: GITHUB_ACTION_SOURCE },
    { path: "product.json", content: `${JSON.stringify(actionProductJson(product), null, 2)}\n` },
    { path: "README.md", content: readme(product) },
  ];
}

export function githubActionZip(product: OutputProduct): Buffer {
  return makeZip(githubActionEntries(product));
}
