/**
 * The coding-agents page's configs as generators (content/meta-docs/pages/coding-agents.md): OpenCode's opencode.json
 * (the Responses adapter, recommended, or the Chat Completions fallback), Codex's config.toml or its self-contained
 * CODEX_HOME launch, Claude Code's environment variables, and the three values any OpenAI-compatible tool needs. Each
 * also has the one request its "does this config answer" check sends through the docs proxy, in the same shape the
 * agent would use, and a reader of what came back. Where Meta's examples name muse-spark-1.3, these write
 * muse-spark-1.3-contributor: Muse Muse runs Spark 1.3 only in Contributor mode.
 */

export const BASE_URL = "https://api.meta.ai/v1";
export const ANTHROPIC_BASE = "https://api.meta.ai";
export const CHECK_PROMPT = "Reply with exactly: config OK";

export const AGENT_MODELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "muse-wonder-1.0", label: "muse-wonder-1.0 (most capable)" },
  { value: "muse-spark-1.3-contributor", label: "muse-spark-1.3-contributor (lower cost)" },
  { value: "muse-spark-1.2", label: "muse-spark-1.2 (Standard mode)" },
];

export type AgentEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The note a generated config with a Contributor model carries, as a comment where the format has them (TOML and
 * shell; JSON has none). It isn't repeated in the warnings: the live check right under every config shows the kit's
 * Contributor notice for the same model.
 */
export const CONTRIBUTOR_NOTE = "Contributor mode: Meta may use what you send to train future models. Drop -contributor for Standard mode.";

function effortWarnings(model: string, effort: AgentEffort): string[] {
  const out: string[] = [];
  if (effort === "max" && model.endsWith("-contributor")) out.push("max is available on muse-wonder-1.0 and muse-spark-1.3, but not on muse-spark-1.3-contributor. Pick xhigh or lower.");
  if (effort === "none") out.push("Muse Wonder and Muse Spark reject reasoning effort none. Use minimal for the least reasoning.");
  return out;
}

function contributorComment(...models: string[]): string[] {
  const contributor = [...new Set(models.filter((m) => m.endsWith("-contributor")))];
  return contributor.length ? [`# ${contributor.join(", ")}: ${CONTRIBUTOR_NOTE}`] : [];
}

// ---------------------------------------------------------------------------------------------------------------
// OpenCode

export interface OpenCodeInput {
  adapter: "responses" | "chat";
  model: string;
  effort: AgentEffort;
  summary: boolean;
  encrypted: boolean;
  modalities: boolean;
}

export function openCodeConfig(i: OpenCodeInput): { code: string; warnings: string[] } {
  const warnings = effortWarnings(i.model, i.effort);
  let model: Record<string, unknown>;
  if (i.adapter === "responses") {
    const options: Record<string, unknown> = { reasoningEffort: i.effort };
    if (i.summary) options.reasoningSummary = "auto";
    if (i.encrypted) options.include = ["reasoning.encrypted_content"];
    model = {
      name: i.model,
      reasoning: true,
      limit: { context: 1048576, output: 131072 },
      ...(i.modalities ? { modalities: { input: ["text", "image", "pdf", "video"], output: ["text"] } } : {}),
      options,
    };
    if (!i.encrypted) warnings.push('Without include: ["reasoning.encrypted_content"] the model loses its own reasoning between calls, in tool loops and across compaction.');
    if (!i.modalities) warnings.push('Declare modalities input ["text", "image", "pdf", "video"]: some agents strip image or file parts from a custom provider that lacks them.');
  } else {
    model = { name: i.model, limit: { context: 1048576, output: 131072 } };
    warnings.push("The Chat Completions adapter doesn't preserve reasoning across turns: in agentic loops the model can repeat work or lose the thread. Prefer @ai-sdk/openai.");
    warnings.push("PDFs aren't attached over this adapter; images still are, forwarded as image_url parts.");
  }
  const provider = {
    meta: {
      name: "Meta Model API",
      npm: i.adapter === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
      options: { baseURL: BASE_URL },
      models: { [i.model]: model },
    },
  };
  return { code: JSON.stringify({ provider }, null, 2), warnings };
}

/** Option A on the page: the prompt that makes OpenCode (or Goose, Roo...) register the provider itself. */
export function openCodePrompt(i: OpenCodeInput): string {
  const lines = [
    "Add a new provider to my opencode.json config with the following details:",
    '- Provider key: "meta"',
    '- Provider name: "Meta Model API"',
    `- npm adapter: "${i.adapter === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible"}"`,
    `- Base URL in options: "${BASE_URL}"`,
    `- Model key: "${i.model}" with name "${i.model}"`,
  ];
  if (i.adapter === "responses") {
    lines.push("- Capabilities: reasoning = true");
    lines.push("- Limits: context = 1048576, output = 131072");
    if (i.modalities) lines.push('- Modalities: input = ["text", "image", "pdf", "video"], output = ["text"]');
    const opts = [`reasoningEffort = "${i.effort}"`, ...(i.summary ? ['reasoningSummary = "auto"'] : []), ...(i.encrypted ? ['include = ["reasoning.encrypted_content"]'] : [])];
    lines.push(`- Model options: ${opts.join(", ")}`);
  } else {
    lines.push("- Limits: context = 1048576, output = 131072");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Codex

export interface CodexInput {
  model: string;
  effort: AgentEffort;
  summary: boolean;
  keyEnv: string;
}

export function codexToml(i: CodexInput): { code: string; warnings: string[] } {
  const lines = [
    ...contributorComment(i.model),
    `model = "${i.model}"`,
    'model_provider = "meta"',
    `model_reasoning_effort = "${i.effort}"           # none | minimal | low | medium | high | xhigh | max`,
    ...(i.summary ? ['model_reasoning_summary = "auto"'] : []),
    "model_context_window = 1048576            # 1M-token context",
    ...(i.summary ? ["model_supports_reasoning_summaries = true"] : []),
    "model_auto_compact_token_limit = 900000",
    "",
    "[model_providers.meta]",
    'name = "Meta Model API"',
    `base_url = "${BASE_URL}"`,
    `env_key = "${i.keyEnv || "MODEL_API_KEY"}"`,
    'wire_api = "responses"',
  ];
  return { code: lines.join("\n"), warnings: effortWarnings(i.model, i.effort) };
}

/** The page's self-contained run: CODEX_HOME at a scratch directory and the provider passed with -c. */
export function codexInline(i: CodexInput): string {
  const key = i.keyEnv || "MODEL_API_KEY";
  return [
    `export ${key}="<your-model-api-key>"`,
    "mkdir -p /tmp/codex-modelapi",
    "",
    ...contributorComment(i.model),
    "CODEX_HOME=/tmp/codex-modelapi codex \\",
    `  -m ${i.model} \\`,
    `  -c 'model_provider="meta"' \\`,
    `  -c 'model_providers.meta.name="Meta Model API"' \\`,
    `  -c 'model_providers.meta.base_url="${BASE_URL}"' \\`,
    `  -c 'model_providers.meta.env_key="${key}"' \\`,
    `  -c 'model_providers.meta.wire_api="responses"' \\`,
    `  -c 'model_reasoning_effort="${i.effort}"'`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code

export interface ClaudeInput {
  main: string;
  opus: string;
  sonnet: string;
  haiku: string;
  subagent: string;
  toolSearch: boolean;
  shell: "posix" | "powershell";
  keyEnv: string;
}

export function claudeEnv(i: ClaudeInput): { code: string; warnings: string[] } {
  const key = i.keyEnv || "MODEL_API_KEY";
  const vars: Array<[string, string]> = [
    ["ANTHROPIC_BASE_URL", ANTHROPIC_BASE],
    ["ANTHROPIC_AUTH_TOKEN", i.shell === "powershell" ? `$env:${key}` : `$${key}`],
    ["ANTHROPIC_MODEL", i.main],
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", i.opus],
    ["ANTHROPIC_DEFAULT_SONNET_MODEL", i.sonnet],
    ["ANTHROPIC_DEFAULT_HAIKU_MODEL", i.haiku],
    ["CLAUDE_CODE_SUBAGENT_MODEL", i.subagent],
    ...(i.toolSearch ? ([["ENABLE_TOOL_SEARCH", "true"]] as Array<[string, string]>) : []),
  ];
  const code = [
    ...contributorComment(i.main, i.opus, i.sonnet, i.haiku, i.subagent),
    ...vars.map(([k, v]) => (i.shell === "powershell" ? (v.startsWith("$env:") ? `$env:${k} = ${v}` : `$env:${k} = "${v}"`) : `export ${k}="${v}"`)),
  ].join("\n");
  const warnings: string[] = [];
  if (!i.toolSearch) warnings.push("Claude Code turns MCP tool search off for hosts other than Anthropic's. Set ENABLE_TOOL_SEARCH=true to keep it on.");
  return { code, warnings };
}

/** The distinct models a Claude Code config sends to, each of which the check calls once. */
export function claudeModels(i: Pick<ClaudeInput, "main" | "opus" | "sonnet" | "haiku" | "subagent">): string[] {
  return [...new Set([i.main, i.opus, i.sonnet, i.haiku, i.subagent].filter(Boolean))];
}

// ---------------------------------------------------------------------------------------------------------------
// Any OpenAI-compatible tool

/** What's wrong with a base URL for an OpenAI-compatible tool (or, with anthropic, for Claude Code). */
export function baseUrlProblems(url: string, anthropic = false): string[] {
  const u = url.trim();
  const out: string[] = [];
  if (!u) return ["Enter the base URL your tool is set to."];
  if (!/^https:\/\//.test(u)) out.push("Use https://.");
  if (!/^https?:\/\/api\.meta\.ai(\/|$)/.test(u)) out.push("The host is api.meta.ai.");
  if (/\/$/.test(u)) out.push("Drop the trailing slash: a trailing slash is a common cause of 404 and Model not found.");
  if (/\/(chat\/completions|responses|messages)\/?$/.test(u)) out.push("That's an endpoint, not the base: the tool appends the endpoint itself.");
  if (anthropic && /\/v1\/?$/.test(u)) out.push("Claude Code appends /v1/messages, so its base is https://api.meta.ai with no /v1.");
  if (!anthropic && !/\/v1\/?$/.test(u) && !/\/(chat\/completions|responses)\/?$/.test(u)) out.push("OpenAI-compatible tools need the /v1 base: https://api.meta.ai/v1.");
  return out;
}

export const TROUBLESHOOTING: ReadonlyArray<{ symptom: string; cause: string; fix: string }> = [
  { symptom: "Model not found, or 404", cause: "A wrong model id, or a trailing slash in the base URL", fix: "Use a Model API id such as muse-wonder-1.0, and https://api.meta.ai/v1 with no trailing slash." },
  { symptom: "The agent says it can't view images", cause: "Media stripped before it reaches the API", fix: "Check the agent sends image content parts; declare the model's modalities if it can." },
  { symptom: "Duplicate tool calls", cause: "A transient streaming glitch", fix: "Restart with fresh context. It isn't a systematic bug." },
  { symptom: "Tools never get called", cause: "The agent doesn't know about the tools", fix: "Check the tool definitions are registered: the MCP server running, local tool files in place." },
  { symptom: "Cost shows $0", cause: "No pricing metadata for a custom provider", fix: "Expected. Optionally set indicative rates in the agent's model settings." },
];

// ---------------------------------------------------------------------------------------------------------------
// The checks

export type CheckPath = "responses" | "chat/completions" | "messages";

export interface CheckRequest {
  path: CheckPath;
  body: Record<string, unknown>;
}

/** The cheapest request with the config's own shape. Muse Wonder's output cap stays at 800 to keep a check near a cent. */
export function capFor(model: string): number {
  return model === "muse-wonder-1.0" ? 800 : 1500;
}

/** API efforts the check can send: none isn't accepted, and max isn't on the Contributor model. */
export function apiEffort(model: string, effort: AgentEffort): string {
  if (effort === "none") return "minimal";
  if (effort === "max" && model.endsWith("-contributor")) return "xhigh";
  return effort;
}

export function openCodeCheck(i: OpenCodeInput): CheckRequest {
  if (i.adapter === "chat") {
    return { path: "chat/completions", body: { model: i.model, messages: [{ role: "user", content: CHECK_PROMPT }], max_completion_tokens: capFor(i.model) } };
  }
  return {
    path: "responses",
    body: {
      model: i.model,
      input: CHECK_PROMPT,
      reasoning: { effort: apiEffort(i.model, i.effort), ...(i.summary ? { summary: "auto" } : {}) },
      ...(i.encrypted ? { include: ["reasoning.encrypted_content"] } : {}),
      max_output_tokens: capFor(i.model),
    },
  };
}

export function codexCheck(i: CodexInput): CheckRequest {
  return {
    path: "responses",
    body: { model: i.model, input: CHECK_PROMPT, reasoning: { effort: apiEffort(i.model, i.effort), ...(i.summary ? { summary: "auto" } : {}) }, max_output_tokens: capFor(i.model) },
  };
}

export function claudeCheck(model: string): CheckRequest {
  return { path: "messages", body: { model, max_tokens: capFor(model), messages: [{ role: "user", content: CHECK_PROMPT }] } };
}

export function genericCheck(surface: "chat" | "responses", model: string): CheckRequest {
  return surface === "chat"
    ? { path: "chat/completions", body: { model, messages: [{ role: "user", content: CHECK_PROMPT }], max_completion_tokens: capFor(model) } }
    : { path: "responses", body: { model, input: CHECK_PROMPT, max_output_tokens: capFor(model) } };
}

export interface CheckLine {
  ok: boolean;
  text: string;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

/** Reads a check's reply: did it answer, on which model, and did the parts the config relies on come back. */
export function readCheck(req: CheckRequest, status: number, json: unknown, ranModel: string | null): CheckLine[] {
  const lines: CheckLine[] = [];
  const r = obj(json);
  lines.push({ ok: status >= 200 && status < 300, text: status ? `HTTP ${status} from ${req.path === "messages" ? "/v1/messages" : `/v1/${req.path}`}` : "No reply" });
  if (!r || status < 200 || status >= 300) return lines;
  const model = ranModel ?? (typeof r.model === "string" ? r.model : null);
  const asked = String(req.body.model);
  if (model) lines.push({ ok: model === asked, text: model === asked ? `Served by ${model}` : `Asked for ${asked}, served by ${model}` });
  let text = "";
  if (req.path === "responses") {
    const output = Array.isArray(r.output) ? (r.output as unknown[]).map(obj) : [];
    text = output
      .filter((o) => o?.type === "message")
      .flatMap((o) => (Array.isArray(o!.content) ? (o!.content as unknown[]).map(obj) : []))
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join("");
    const reasoning = output.filter((o) => o?.type === "reasoning");
    if (Array.isArray(req.body.include) && (req.body.include as unknown[]).includes("reasoning.encrypted_content")) {
      const enc = reasoning.some((o) => typeof o?.encrypted_content === "string" && (o.encrypted_content as string).length > 0);
      lines.push({ ok: enc, text: enc ? "Encrypted reasoning came back, so the agent can replay it on the next turn" : "No encrypted reasoning in the reply" });
    }
    if (r.status && r.status !== "completed") lines.push({ ok: false, text: `Response status ${String(r.status)}: it stopped before finishing (raise the output limit)` });
  } else if (req.path === "chat/completions") {
    const choice = obj(Array.isArray(r.choices) ? (r.choices as unknown[])[0] : null);
    text = typeof obj(choice?.message)?.content === "string" ? (obj(choice?.message)!.content as string) : "";
  } else {
    const content = Array.isArray(r.content) ? (r.content as unknown[]).map(obj) : [];
    text = content
      .filter((c) => c?.type === "text")
      .map((c) => String(c?.text ?? ""))
      .join("");
    if (r.stop_reason) lines.push({ ok: r.stop_reason !== "max_tokens", text: `stop_reason: ${String(r.stop_reason)}` });
  }
  lines.push({ ok: text.trim().length > 0, text: text.trim() ? `Answered: "${text.trim().slice(0, 80)}"` : "No text in the reply" });
  const usage = obj(r.usage);
  if (usage) lines.push({ ok: true, text: "Usage reported, so the agent can count tokens" });
  return lines;
}
