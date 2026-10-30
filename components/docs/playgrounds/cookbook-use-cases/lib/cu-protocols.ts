import type { FnToolDef } from "@/components/docs/playgrounds/cookbook-use-cases/lib/agent";
import type { Action, SceneId } from "@/components/docs/playgrounds/cookbook-use-cases/lib/cu-sim";
import { SCREEN_H, SCREEN_W } from "@/components/docs/playgrounds/cookbook-use-cases/lib/cu-sim";
import { functionCalls, outputItems, responseText, type FnCall } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";

/**
 * The three ways the computer-use pages talk to the model, mapped onto one action set:
 *
 * - "computer": the native computer tool (computer-use guide): tools [{ type: "computer" }], computer_call items
 *   with batched actions in screenshot pixels, computer_call_output with a computer_screenshot, and
 *   pending_safety_checks echoed in acknowledged_safety_checks.
 * - "cua": the Cua MCP bridge (cookbook/computer-use): function tools cua_screenshot, cua_left_click and friends;
 *   the screenshot comes back as an image in the function_call_output.
 * - "metacua": the macOS harness (cookbook/computer-use-macos): computer.computer with 0 to 1000 coordinates and
 *   computer.stop with the final answer, parallel_tool_calls false and store false.
 */

type Json = Record<string, unknown>;

export type Protocol = "computer" | "cua" | "metacua";

/** The computer-use guide's strict system prompt, as the page gives it. */
export const NATIVE_SYSTEM = `You are a computer-use agent operating a browser or desktop environment. You receive
screenshots and choose the next action or actions.

Coordinates are pixels in the screenshot you were last shown: (0, 0) is the top-left. Click
the center of the target element.

Return a short batch of actions only when they do not depend on intermediate visual
feedback, such as click, type, and keypress. Do not batch across page loads, searches,
modal transitions, or any step where the next action depends on a new screenshot. Use wait
when the page is loading or an action needs time to take effect.

Finish by replying with a normal message: the answer when the goal is visibly complete, or a
short explanation when the task is infeasible because of missing permissions, credentials,
unavailable UI, ambiguity, or repeated lack of progress.

Do not guess hidden UI state and do not claim completion unless the screenshot supports it.
If a target is not visible, scroll or request a new screenshot before clicking.`;

export const METACUA_SYSTEM = `You operate a computer through its GUI with the computer.computer tool. Coordinates are normalized integers from 0 to 1000: (0, 0) is the top-left of the primary display and (1000, 1000) the bottom-right; they are mapped to display pixels before each action runs. Every action returns a fresh screenshot. The type action does not submit; follow it with key Return when needed. When the goal is done, or you can't proceed safely, call computer.stop with your final answer.`;

/** The Cua recipe's prompt, word for word, for the Mines desktop. */
export const CUA_MINES_PROMPT =
  "You are operating a separate Linux desktop computer. The ONLY way to interact with it is through the cua_* tools: cua_screenshot to see the screen, cua_left_click / cua_right_click / cua_move_cursor for the mouse, cua_type_text / cua_press_key for the keyboard, and cua_run_command to run a shell command ON THAT computer. Your own local bash tool controls a DIFFERENT machine, so do not use it for this task. Your task: find the Minesweeper game on that desktop, open it, and play a game of Minesweeper. Try to win. Work it out yourself: look at the screen with cua_screenshot, find the game, launch it, and make sensible moves based on what you see. Take a cua_screenshot after each action so you can react to the board.";

export const TASKS: Record<SceneId, string[]> = {
  signup: [
    "Fill in the sign-up form for Jordan Lee (jordan@example.com, password Sprout2026!), agree to the terms, and create the account.",
    "Create an account for Ana Ruiz with the email ana@example.com and the password greenthumb42, but don't agree to anything without telling me first.",
  ],
  tictactoe: ["Play tic-tac-toe as X against the computer and try to win. Tell me the result when the game ends."],
  mines: [CUA_MINES_PROMPT],
};

/** For the Cua protocol on the other scenes: the recipe's prompt shape, with this screen's task. */
export function cuaPrompt(scene: SceneId, task: string): string {
  if (scene === "mines") return task;
  return `You are operating a separate computer. The ONLY way to interact with it is through the cua_* tools: cua_screenshot to see the screen, cua_left_click / cua_right_click / cua_move_cursor for the mouse, cua_type_text / cua_press_key for the keyboard, and cua_run_command to run a shell command ON THAT computer. Your task: ${task} Take a cua_screenshot after each action so you can react to the screen.`;
}

const xy = { x: { type: "integer", description: "Pixels from the left of the screenshot" }, y: { type: "integer", description: "Pixels from the top" } };
const obj = (properties: Json, required: string[]): Json => ({ type: "object", properties, required, additionalProperties: false });

export const CUA_TOOLS: FnToolDef[] = [
  { name: "cua_screenshot", description: "Take a screenshot of the sandbox desktop (1280 x 800 PNG).", parameters: obj({}, []) },
  { name: "cua_left_click", description: "Left-click at pixel coordinates on the sandbox desktop.", parameters: obj(xy, ["x", "y"]) },
  { name: "cua_right_click", description: "Right-click at pixel coordinates on the sandbox desktop.", parameters: obj(xy, ["x", "y"]) },
  { name: "cua_double_click", description: "Double-click at pixel coordinates on the sandbox desktop.", parameters: obj(xy, ["x", "y"]) },
  { name: "cua_move_cursor", description: "Move the mouse cursor to pixel coordinates.", parameters: obj(xy, ["x", "y"]) },
  { name: "cua_type_text", description: "Type text with the sandbox keyboard.", parameters: obj({ text: { type: "string" } }, ["text"]) },
  { name: "cua_press_key", description: "Press a key or combination, such as Enter, Tab or ctrl+a.", parameters: obj({ key: { type: "string" } }, ["key"]) },
  { name: "cua_run_command", description: "Run a shell command on the sandbox computer and return its output.", parameters: obj({ command: { type: "string" } }, ["command"]) },
];

const COMPUTER_ACTIONS = ["left_click", "right_click", "middle_click", "double_click", "triple_click", "mouse_move", "left_click_drag", "scroll", "key", "type", "hold_key", "release_key", "wait", "screenshot"];

function actionSchema(): Json {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: COMPUTER_ACTIONS },
      coordinate: { type: "array", items: { type: "integer" }, description: "[x, y], each 0 to 1000" },
      start_coordinate: { type: "array", items: { type: "integer" }, description: "Drag start [x, y], 0 to 1000" },
      text: { type: "string", description: "Text to type, or the key or combination for key (Return, cmd+a)" },
      scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
      scroll_amount: { type: "integer" },
    },
    required: ["action"],
  };
}

export function metacuaTools(batched: boolean): FnToolDef[] {
  return [
    {
      name: "computer.computer",
      description: batched
        ? "Perform a batch of GUI actions in order via synthetic mouse, keyboard, and screen events, then return one fresh screenshot. Coordinates are normalized integers in 0...1000, origin top-left."
        : "Perform a GUI action via synthetic mouse, keyboard, and screen events, then return a fresh screenshot. Coordinates are normalized integers in 0...1000, origin top-left.",
      parameters: batched ? { type: "object", properties: { actions: { type: "array", items: actionSchema() } }, required: ["actions"] } : actionSchema(),
    },
    {
      name: "computer.stop",
      description: "End the session and submit a final answer describing what was accomplished, or why it could not proceed safely.",
      parameters: obj({ answer: { type: "string" } }, ["answer"]),
    },
  ];
}

/** 0 to 1000 grid to screen pixels (metacua maps to the primary display's size). */
export function toPixels(coord: unknown): { x: number; y: number } | null {
  if (!Array.isArray(coord) || coord.length < 2 || !coord.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const [x, y] = coord as number[];
  return { x: Math.round((Math.min(1000, Math.max(0, x)) * SCREEN_W) / 1000), y: Math.round((Math.min(1000, Math.max(0, y)) * SCREEN_H) / 1000) };
}

export interface SafetyCheck {
  id?: string;
  code: string;
  message: string;
}

export interface NativeTurn {
  callId: string | null;
  actions: Action[];
  checks: SafetyCheck[];
  commentary: string;
  final: string;
  item: Json | null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);

/** A computer_call action as the simulator's action. Unknown types become a wait. */
export function nativeAction(a: Json): Action {
  switch (a.type) {
    case "click":
      return { type: "click", button: typeof a.button === "string" ? a.button : "left", x: num(a.x), y: num(a.y) };
    case "double_click":
      return { type: "double_click", x: num(a.x), y: num(a.y) };
    case "drag":
      return { type: "drag", path: Array.isArray(a.path) ? (a.path as Json[]).map((p) => ({ x: num(p.x), y: num(p.y) })) : [] };
    case "keypress":
      return { type: "keypress", keys: Array.isArray(a.keys) ? a.keys.map(String) : [] };
    case "move":
      return { type: "move", x: num(a.x), y: num(a.y) };
    case "scroll":
      return { type: "scroll", x: num(a.x), y: num(a.y), scroll_x: num(a.scroll_x), scroll_y: num(a.scroll_y) };
    case "type":
      return { type: "type", text: String(a.text ?? "") };
    case "screenshot":
      return { type: "screenshot" };
    default:
      return { type: "wait" };
  }
}

/** The computer_call in a native reply (one per turn), or the final message when there is none. */
export function readNativeTurn(resp: unknown): NativeTurn {
  const items = outputItems(resp);
  const call = items.find((i) => i.type === "computer_call") ?? null;
  const commentary = items
    .filter((i) => i.type === "message" && i.phase === "commentary")
    .map((i) => ((i.content as Json[] | undefined) ?? []).map((c) => String(c.text ?? "")).join(""))
    .join(" ")
    .trim();
  if (!call) return { callId: null, actions: [], checks: [], commentary: "", final: responseText(resp), item: null };
  const checks = Array.isArray(call.pending_safety_checks)
    ? (call.pending_safety_checks as Json[]).map((c) => ({ ...(typeof c.id === "string" ? { id: c.id } : {}), code: String(c.code ?? ""), message: String(c.message ?? "") }))
    : [];
  return {
    callId: typeof call.call_id === "string" ? call.call_id : null,
    actions: Array.isArray(call.actions) ? (call.actions as Json[]).map(nativeAction) : call.action ? [nativeAction(call.action as Json)] : [],
    checks,
    commentary,
    final: "",
    item: call,
  };
}

export type FnStep =
  | { kind: "actions"; actions: Action[]; screenshotAfter: boolean }
  | { kind: "screenshot" }
  | { kind: "shell"; command: string }
  | { kind: "stop"; answer: string }
  | { kind: "error"; message: string };

function parse(call: FnCall): Json | null {
  try {
    const v = JSON.parse(call.arguments || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

/** One cua_* call as what the simulator does. Actions return text only; cua_screenshot returns the image. */
export function cuaStep(call: FnCall): FnStep {
  const a = parse(call);
  if (!a) return { kind: "error", message: "The arguments aren't valid JSON." };
  const at = { x: num(a.x), y: num(a.y) };
  switch (call.name) {
    case "cua_screenshot":
      return { kind: "screenshot" };
    case "cua_left_click":
      return { kind: "actions", actions: [{ type: "click", button: "left", ...at }], screenshotAfter: false };
    case "cua_right_click":
      return { kind: "actions", actions: [{ type: "click", button: "right", ...at }], screenshotAfter: false };
    case "cua_double_click":
      return { kind: "actions", actions: [{ type: "double_click", ...at }], screenshotAfter: false };
    case "cua_move_cursor":
      return { kind: "actions", actions: [{ type: "move", ...at }], screenshotAfter: false };
    case "cua_type_text":
      return { kind: "actions", actions: [{ type: "type", text: String(a.text ?? "") }], screenshotAfter: false };
    case "cua_press_key":
      return { kind: "actions", actions: [{ type: "keypress", keys: String(a.key ?? "").split("+").filter(Boolean) }], screenshotAfter: false };
    case "cua_run_command":
      return { kind: "shell", command: String(a.command ?? "") };
    default:
      return { kind: "error", message: `Unknown tool ${call.name}.` };
  }
}

function metacuaAction(a: Json): Action | null {
  const at = toPixels(a.coordinate);
  switch (a.action) {
    case "left_click":
    case "middle_click":
    case "right_click":
      return at ? { type: "click", button: a.action === "right_click" ? "right" : a.action === "middle_click" ? "wheel" : "left", ...at } : null;
    case "double_click":
    case "triple_click":
      return at ? { type: "double_click", ...at } : null;
    case "mouse_move":
      return at ? { type: "move", ...at } : null;
    case "left_click_drag": {
      const from = toPixels(a.start_coordinate);
      return at && from ? { type: "drag", path: [from, at] } : null;
    }
    case "scroll": {
      const amount = num(a.scroll_amount) || 3;
      const dir = String(a.scroll_direction ?? "down");
      const p = at ?? { x: SCREEN_W / 2, y: SCREEN_H / 2 };
      return { type: "scroll", ...p, scroll_x: dir === "left" ? -amount : dir === "right" ? amount : 0, scroll_y: dir === "up" ? -amount : dir === "down" ? amount : 0 };
    }
    case "key":
    case "hold_key":
      return { type: "keypress", keys: String(a.text ?? "").split("+").filter(Boolean) };
    case "release_key":
      return { type: "wait" };
    case "type":
      return { type: "type", text: String(a.text ?? "") };
    case "wait":
      return { type: "wait" };
    case "screenshot":
      return { type: "screenshot" };
    default:
      return null;
  }
}

/** One computer.computer or computer.stop call. Batched mode validates the whole batch up front, as metacua does. */
export function metacuaStep(call: FnCall): FnStep {
  const a = parse(call);
  if (!a) return { kind: "error", message: "The arguments aren't valid JSON." };
  if (call.name === "computer.stop") return { kind: "stop", answer: String(a.answer ?? "") };
  if (call.name !== "computer.computer") return { kind: "error", message: `Unknown tool ${call.name}.` };
  const raw = Array.isArray(a.actions) ? (a.actions as Json[]) : [a];
  const actions = raw.map(metacuaAction);
  const bad = actions.findIndex((x) => !x);
  if (bad >= 0) return { kind: "error", message: `Action ${bad + 1} (${String(raw[bad]?.action)}) is missing a valid coordinate or isn't supported.` };
  return { kind: "actions", actions: actions as Action[], screenshotAfter: true };
}

export function fnCalls(resp: unknown): FnCall[] {
  return functionCalls(resp);
}

/** Native first request: the task and the first screenshot, the computer tool, the guide's system prompt. */
export function nativeBase(o: { model: string; effort: string | null; maxTokens: number; truncation: boolean }): Json {
  return {
    model: o.model,
    instructions: NATIVE_SYSTEM,
    tools: [{ type: "computer" }],
    ...(o.effort ? { reasoning: { effort: o.effort } } : {}),
    max_output_tokens: o.maxTokens,
    ...(o.truncation ? { truncation: "auto" } : {}),
  };
}

export function screenshotOutput(callId: string, image: string, acked: SafetyCheck[]): Json {
  return { type: "computer_call_output", call_id: callId, acknowledged_safety_checks: acked, output: { type: "computer_screenshot", image_url: image } };
}

export function userTurn(text: string, image?: string): Json {
  return { role: "user", content: [{ type: "input_text", text }, ...(image ? [{ type: "input_image", image_url: image }] : [])] };
}

/** A function_call_output whose output is text, plus the screenshot when there is one. */
export function fnOutput(callId: string, text: string, image?: string): Json {
  return { type: "function_call_output", call_id: callId, output: image ? [{ type: "input_text", text }, { type: "input_image", image_url: image }] : text };
}

/** Readable action lines for the step list. */
export function actionLabel(a: Action): string {
  switch (a.type) {
    case "click":
      return `${a.button && a.button !== "left" ? `${a.button} click` : "Click"} at (${a.x}, ${a.y})`;
    case "double_click":
      return `Double-click at (${a.x}, ${a.y})`;
    case "drag":
      return `Drag ${a.path.map((p) => `(${p.x}, ${p.y})`).join(" to ")}`;
    case "keypress":
      return `Press ${a.keys.join(" + ")}`;
    case "move":
      return `Move to (${a.x}, ${a.y})`;
    case "scroll":
      return `Scroll ${a.scroll_y ? `${a.scroll_y > 0 ? "down" : "up"} ${Math.abs(a.scroll_y)}` : `${a.scroll_x ?? 0} sideways`} at (${a.x}, ${a.y})`;
    case "type":
      return `Type "${a.text}"`;
    case "screenshot":
      return "Take a screenshot";
    case "wait":
      return "Wait";
  }
}
