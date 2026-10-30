/**
 * The agent-frameworks page's two setups as generators (content/meta-docs/pages/agent-frameworks.md): the Claude Agent
 * SDK's query() in TypeScript or Python with the provider env passed inline, and the OpenAI Codex app-server driven
 * over JSON-RPC with the provider and a model catalog as -c overrides. Both start from the page's own code. Where it
 * names muse-spark-1.3, these write muse-spark-1.3-contributor (Muse Muse runs Spark 1.3 only in Contributor mode).
 */

export interface SdkInput {
  lang: "typescript" | "python";
  prompt: string;
  cwd: string;
  systemPrompt: string;
  tools: string[];
  /** permissionMode "bypassPermissions": unattended, so only inside a sandbox. */
  bypass: boolean;
  /** settingSources: [] keeps runs hermetic. */
  hermetic: boolean;
  main: string;
  opus: string;
  sonnet: string;
  haiku: string;
  subagent: string;
  /** Add the page's production patterns: a terminal-event check and two timeouts. */
  production: boolean;
}

function q(text: string): string {
  return JSON.stringify(text);
}

export function claudeSdkCode(i: SdkInput): string {
  const tools = i.tools.map(q).join(", ");
  if (i.lang === "typescript") {
    const options = [
      `    model: ${q(i.main)},`,
      `    cwd: ${q(i.cwd)},`,
      `    systemPrompt: ${q(i.systemPrompt)},`,
      `    allowedTools: [${tools}],`,
      ...(i.bypass ? ['    permissionMode: "bypassPermissions", // unattended: run it inside a sandbox'] : []),
      ...(i.hermetic ? ["    settingSources: [], // don't inherit user or project settings"] : []),
      "    env: {",
      "      ...process.env,",
      '      ANTHROPIC_BASE_URL: "https://api.meta.ai",',
      '      ANTHROPIC_AUTH_TOKEN: process.env.MODEL_API_KEY ?? "",',
      `      ANTHROPIC_MODEL: ${q(i.main)},`,
      `      ANTHROPIC_DEFAULT_OPUS_MODEL: ${q(i.opus)},`,
      `      ANTHROPIC_DEFAULT_SONNET_MODEL: ${q(i.sonnet)},`,
      `      ANTHROPIC_DEFAULT_HAIKU_MODEL: ${q(i.haiku)},`,
      `      CLAUDE_CODE_SUBAGENT_MODEL: ${q(i.subagent)},`,
      "    },",
    ];
    const head = ['import { query } from "@anthropic-ai/claude-agent-sdk";', "", "const run = query({", `  prompt: ${q(i.prompt)},`, "  options: {", ...options, "  },", "});", ""];
    if (!i.production) {
      return [
        ...head,
        "for await (const message of run) {",
        '  if (message.type === "assistant") {',
        "    // Stream partial output to your UI as the agent works.",
        '  } else if (message.type === "result") {',
        "    console.log(message.result); // final answer",
        "    console.log(message.usage); // token accounting",
        "  }",
        "}",
      ].join("\n");
    }
    return [
      ...head,
      "// Two timeouts: a wall-clock cap for a runaway loop, an idle watchdog for a silent hang.",
      "const OVERALL_MS = 20 * 60_000;",
      "const IDLE_MS = 2 * 60_000;",
      "const started = Date.now();",
      "let lastEvent = Date.now();",
      "const watchdog = setInterval(() => {",
      "  const now = Date.now();",
      "  if (now - started > OVERALL_MS || now - lastEvent > IDLE_MS) {",
      '    console.error(now - started > OVERALL_MS ? "Hit the wall-clock cap" : "No events for too long");',
      "    process.exit(1);",
      "  }",
      "}, 5_000);",
      "",
      "let finalText: string | undefined;",
      "try {",
      "  for await (const message of run) {",
      "    lastEvent = Date.now();",
      '    if (message.type === "result") {',
      '      finalText = "result" in message ? message.result : undefined;',
      "      console.log(message.usage); // meter cost from the final event",
      "    }",
      "  }",
      "} finally {",
      "  clearInterval(watchdog);",
      "}",
      "// Completion is the result message, not the stream going quiet.",
      'if (!finalText) throw new Error("The agent finished without a result message.");',
      "console.log(finalText);",
    ].join("\n");
  }

  const options = [
    `            model=${q(i.main)},`,
    `            cwd=${q(i.cwd)},`,
    `            system_prompt=${q(i.systemPrompt)},`,
    `            allowed_tools=[${tools}],`,
    ...(i.bypass ? ['            permission_mode="bypassPermissions",  # unattended: run it inside a sandbox'] : []),
    ...(i.hermetic ? ["            setting_sources=[],  # don't inherit user or project settings"] : []),
    "            env={",
    "                **os.environ,",
    '                "ANTHROPIC_BASE_URL": "https://api.meta.ai",',
    '                "ANTHROPIC_AUTH_TOKEN": os.environ["MODEL_API_KEY"],',
    `                "ANTHROPIC_MODEL": ${q(i.main)},`,
    `                "ANTHROPIC_DEFAULT_OPUS_MODEL": ${q(i.opus)},`,
    `                "ANTHROPIC_DEFAULT_SONNET_MODEL": ${q(i.sonnet)},`,
    `                "ANTHROPIC_DEFAULT_HAIKU_MODEL": ${q(i.haiku)},`,
    `                "CLAUDE_CODE_SUBAGENT_MODEL": ${q(i.subagent)},`,
    "            },",
  ];
  const imports = ["import os", "", "import anyio", "from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage", "", ""];
  if (!i.production) {
    return [
      ...imports,
      "async def main():",
      "    async for message in query(",
      `        prompt=${q(i.prompt)},`,
      "        options=ClaudeAgentOptions(",
      ...options,
      "        ),",
      "    ):",
      "        if isinstance(message, ResultMessage):",
      "            print(message.result)  # final answer",
      "            print(message.usage)  # token accounting",
      "",
      "",
      "anyio.run(main)",
    ].join("\n");
  }
  return [
    ...imports,
    "OVERALL_S = 20 * 60  # wall-clock cap for a runaway loop",
    "IDLE_S = 2 * 60  # idle watchdog for a silent hang",
    "",
    "",
    "async def main():",
    "    stream = query(",
    `        prompt=${q(i.prompt)},`,
    "        options=ClaudeAgentOptions(",
    ...options,
    "        ),",
    "    ).__aiter__()",
    "    result = None",
    "    with anyio.fail_after(OVERALL_S):",
    "        while True:",
    "            try:",
    "                with anyio.fail_after(IDLE_S):",
    "                    message = await stream.__anext__()",
    "            except StopAsyncIteration:",
    "                break",
    "            if isinstance(message, ResultMessage):",
    "                result = message.result",
    "                print(message.usage)  # meter cost from the final event",
    "    # Completion is the result message, not the stream going quiet.",
    "    if not result:",
    '        raise RuntimeError("The agent finished without a result message.")',
    "    print(result)",
    "",
    "",
    "anyio.run(main)",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Codex app-server

export type CodexLevel = "low" | "medium" | "high" | "xhigh";

export const LEVEL_TEXT: Record<CodexLevel, string> = {
  low: "Fast responses with lighter reasoning",
  medium: "Balanced reasoning",
  high: "Greater reasoning depth",
  xhigh: "Extra high reasoning depth",
};

export interface CodexServerInput {
  model: string;
  displayName: string;
  defaultLevel: CodexLevel;
  levels: CodexLevel[];
  baseInstructions: string;
  prompt: string;
  sandbox: "workspace-write" | "read-only";
  optOutDeltas: boolean;
  images: boolean;
}

/** The model catalog Codex reads from the path in -c model_catalog_json, with the page's housekeeping defaults. */
export function codexCatalog(i: CodexServerInput): Record<string, unknown> {
  return {
    models: [
      {
        slug: i.model,
        display_name: i.displayName || i.model,
        description: "Meta Model API model.",
        context_window: 1048576,
        max_context_window: 1048576,
        input_modalities: i.images ? ["text", "image"] : ["text"],
        supports_parallel_tool_calls: true,
        default_reasoning_level: i.defaultLevel,
        supported_reasoning_levels: i.levels.map((effort) => ({ effort, description: LEVEL_TEXT[effort] })),
        base_instructions: i.baseInstructions,
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 0,
        support_verbosity: true,
        default_verbosity: "low",
        supports_reasoning_summaries: false,
        default_reasoning_summary: "none",
        supports_image_detail_original: true,
        web_search_tool_type: "text_and_image",
        supports_search_tool: false,
        truncation_policy: { mode: "tokens", limit: 120000 },
        effective_context_window_percent: 95,
        additional_speed_tiers: [],
        service_tiers: [],
        experimental_supported_tools: [],
        apply_patch_tool_type: null,
        model_messages: null,
        availability_nux: null,
        upgrade: null,
      },
    ],
  };
}

export function codexArgs(i: CodexServerInput, catalogPath = "${catalogPath}"): string[] {
  return [
    "app-server",
    "-c", `model="${i.model}"`,
    "-c", `model_reasoning_effort="${i.defaultLevel}"`,
    "-c", 'model_provider="meta"',
    "-c", 'model_providers.meta.name="Meta Model API"',
    "-c", 'model_providers.meta.base_url="https://api.meta.ai/v1"',
    "-c", 'model_providers.meta.env_key="MODEL_API_KEY"',
    "-c", 'model_providers.meta.wire_api="responses"',
    "-c", "model_providers.meta.requires_openai_auth=false",
    "-c", `model_catalog_json="${catalogPath}"`,
  ];
}

/** The page's driver: spawn codex app-server, initialize, open a thread, start a turn, finish on turn/completed. */
export function codexDriver(i: CodexServerInput): string {
  const catalog = JSON.stringify(codexCatalog(i), null, 2);
  const args = codexArgs(i);
  const argLines: string[] = ['    "app-server",'];
  for (let k = 1; k < args.length; k += 2) {
    const value = args[k + 1];
    argLines.push(`    "-c", ${value.includes("${catalogPath}") ? `\`model_catalog_json="\${catalogPath}"\`` : value.includes('"') ? `'${value}'` : `"${value}"`},`);
  }
  const optOut = i.optOutDeltas
    ? ["    // Skip high-volume token deltas; act on completed items instead.", "    capabilities: {", '      optOutNotificationMethods: ["item/agentMessage/delta", "item/reasoning/textDelta"],', "    },"]
    : [];
  return [
    'import { spawn } from "node:child_process";',
    'import readline from "node:readline";',
    'import { writeFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    "",
    "// Register the model so Codex doesn't refresh it from /v1/models, a shape it can't decode.",
    `const modelCatalog = ${catalog};`,
    "",
    "// Codex reads model_catalog_json as a file path, so write the catalog to a temp file.",
    `const catalogPath = join(tmpdir(), "${i.model}-catalog.json");`,
    "writeFileSync(catalogPath, JSON.stringify(modelCatalog, null, 2));",
    "",
    "const proc = spawn(",
    '  "codex",',
    "  [",
    ...argLines,
    "  ],",
    '  { stdio: ["pipe", "pipe", "inherit"], env: process.env }, // Codex reads MODEL_API_KEY (env_key)',
    ");",
    "const rl = readline.createInterface({ input: proc.stdout });",
    "const send = (message) => proc.stdin.write(`${JSON.stringify(message)}\\n`);",
    "",
    "let turnId = null;",
    'let finalText = "";',
    "",
    'rl.on("line", (line) => {',
    "  const msg = JSON.parse(line);",
    "  if (msg.id === 1 && msg.result?.thread?.id) {",
    `    send({ method: "turn/start", id: 2, params: { threadId: msg.result.thread.id, input: [{ type: "text", text: ${q(i.prompt)} }] } });`,
    "  }",
    "  if (msg.id === 2 && msg.result?.turn?.id) turnId = msg.result.turn.id;",
    '  if (msg.method === "item/completed" && msg.params?.item?.type === "agentMessage") {',
    "    finalText = msg.params.item.text ?? finalText;",
    "  }",
    '  if (msg.method === "turn/completed" && msg.params?.turn?.id === turnId) {',
    "    const { status, error } = msg.params.turn;",
    '    if (status !== "completed" || !finalText) throw new Error(`turn ${status}: ${error?.message ?? "no assistant output"}`);',
    "    console.log(finalText);",
    "    rl.close();",
    "    proc.kill();",
    "  }",
    "});",
    "",
    "send({",
    '  method: "initialize",',
    "  id: 0,",
    "  params: {",
    '    clientInfo: { name: "my_product", title: "My Product", version: "0.1.0" },',
    ...optOut,
    "  },",
    "});",
    'send({ method: "initialized", params: {} });',
    "send({",
    '  method: "thread/start",',
    "  id: 1,",
    `  params: { model: ${q(i.model)}, cwd: process.cwd(), approvalPolicy: "never", sandbox: ${q(i.sandbox)} },`,
    "});",
  ].join("\n");
}

export interface RpcStep {
  dir: "send" | "receive";
  title: string;
  message: Record<string, unknown>;
  note: string;
}

/** The JSON-RPC exchange the driver has with the app-server, in order. Ids on received messages are examples. */
export function rpcSequence(i: CodexServerInput): RpcStep[] {
  return [
    {
      dir: "send",
      title: "initialize",
      message: { method: "initialize", id: 0, params: { clientInfo: { name: "my_product", title: "My Product", version: "0.1.0" }, ...(i.optOutDeltas ? { capabilities: { optOutNotificationMethods: ["item/agentMessage/delta", "item/reasoning/textDelta"] } } : {}) } },
      note: i.optOutDeltas ? "Opts out of token deltas: act on completed items instead, unless you render a live typing effect." : "Without the opt-out, every token arrives as a delta notification.",
    },
    { dir: "send", title: "initialized", message: { method: "initialized", params: {} }, note: "A notification (no id): the handshake is done." },
    {
      dir: "send",
      title: "thread/start",
      message: { method: "thread/start", id: 1, params: { model: i.model, cwd: "/path/to/workspace", approvalPolicy: "never", sandbox: i.sandbox } },
      note: `approvalPolicy "never" stops Codex pausing for confirmation; sandbox "${i.sandbox}" ${i.sandbox === "workspace-write" ? "keeps edits inside cwd" : "keeps it from writing at all"}.`,
    },
    { dir: "receive", title: "thread started", message: { id: 1, result: { thread: { id: "thr_example" } } }, note: "The driver starts a turn on this thread." },
    { dir: "send", title: "turn/start", message: { method: "turn/start", id: 2, params: { threadId: "thr_example", input: [{ type: "text", text: i.prompt }] } }, note: "The task for this turn." },
    { dir: "receive", title: "turn accepted", message: { id: 2, result: { turn: { id: "turn_example" } } }, note: "Remember the turn id: a stream can carry more than one turn." },
    { dir: "receive", title: "item/completed", message: { method: "item/completed", params: { item: { type: "agentMessage", text: "(the agent's answer)" } } }, note: "Keep the latest agentMessage as items arrive." },
    {
      dir: "receive",
      title: "turn/completed",
      message: { method: "turn/completed", params: { turn: { id: "turn_example", status: "completed" } } },
      note: "Completion is this event for your turn id, not the stream ending. A completed turn with no assistant text is a failure.",
    },
  ];
}
