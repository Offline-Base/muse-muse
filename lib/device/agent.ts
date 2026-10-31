import type { Response as ModelResponse, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { DeviceTool, DeviceToolResult } from "@/lib/device/client";

/**
 * Lets a model use one board: it reads the board's own tool list, asks for tools as it needs them, sees what they return
 * (photos included), and answers. The Responses API tool loop (content/meta-docs/pages/tool-calling.md).
 */

/** The most model calls one question may make. The last one can't ask for tools, so every run ends in an answer. */
export const MAX_MODEL_CALLS = 6;

const INSTRUCTIONS =
  "You control one physical board through its tools: a real camera, a real microphone and real sensors. Use a tool " +
  "whenever the question depends on what the board sees, hears or has, and don't guess at what a tool could tell you. " +
  "Call describe_device first if you need to know what is attached. You can see photos a tool returns. You can't hear " +
  "recordings: you only get their levels, so say so if you're asked what was said. Answer briefly in plain words, and " +
  "only claim what the tools showed. If a tool fails, say what failed.";

const AUDIO_NOTE = "(The recording was kept for the user. You can't hear it.)";

export interface DeviceAgentDeps {
  model: string;
  respond: (body: ResponseCreateParamsNonStreaming) => Promise<ModelResponse>;
  listTools: () => Promise<DeviceTool[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<DeviceToolResult>;
}

export interface DeviceAgentStep {
  tool: string;
  arguments: Record<string, unknown>;
  content: unknown[];
  isError: boolean;
}

export interface DeviceAgentResult {
  answer: string;
  steps: DeviceAgentStep[];
}

type McpPart = { type?: string; text?: string; data?: string; mimeType?: string };

/** A tool's result as a model can read it: text and images as they are, and a note in place of audio. */
function modelOutput(content: unknown[]) {
  return (content as McpPart[]).map((part) => {
    if (part.type === "image") {
      return { type: "input_image" as const, image_url: `data:${part.mimeType};base64,${part.data}`, detail: "auto" as const };
    }
    return { type: "input_text" as const, text: part.type === "audio" ? AUDIO_NOTE : (part.text ?? JSON.stringify(part)) };
  });
}

/** A model's arguments, or null when they aren't a JSON object. */
function parseArguments(text: string): Record<string, unknown> | null {
  try {
    const args: unknown = JSON.parse(text || "{}");
    return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Answers one question with the board's tools. A board or model that can't be reached throws. */
export async function runDeviceAgent(prompt: string, deps: DeviceAgentDeps): Promise<DeviceAgentResult> {
  const tools = (await deps.listTools()).map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description ?? null,
    parameters: tool.inputSchema as Record<string, unknown>,
    strict: false,
  }));
  const steps: DeviceAgentStep[] = [];
  let input: ResponseCreateParamsNonStreaming["input"] = prompt;
  let previous: string | undefined;

  for (let call = 1; call <= MAX_MODEL_CALLS; call++) {
    const res = await deps.respond({
      model: deps.model,
      // Instructions and tools don't carry over with previous_response_id, so every call sends them.
      instructions: INSTRUCTIONS,
      tools,
      tool_choice: call === MAX_MODEL_CALLS ? "none" : "auto",
      reasoning: { effort: "low" },
      input,
      ...(previous ? { previous_response_id: previous } : {}),
    });
    const calls = res.output.filter((item) => item.type === "function_call");
    if (!calls.length) return { answer: res.output_text ?? "", steps };

    const outputs = [];
    for (const item of calls) {
      const args = parseArguments(item.arguments);
      const result: DeviceToolResult = args
        ? await deps.callTool(item.name, args)
        : { content: [{ type: "text", text: "Those arguments weren't a JSON object." }], isError: true };
      steps.push({ tool: item.name, arguments: args ?? {}, content: result.content, isError: result.isError });
      outputs.push({ type: "function_call_output" as const, call_id: item.call_id, output: modelOutput(result.content) });
    }
    input = outputs;
    previous = res.id;
  }
  return { answer: "", steps };
}
