import { ASK_BOARD_MAX_CHARS, ASK_BOARD_MAX_MESSAGES, ASK_BOARD_MAX_TOKENS, type ConnectTool } from "@/lib/caps/hardware/limits";
import { mintRobotRequest } from "@/lib/caps/hardware/robot";
import { gatewayError } from "@/lib/gateway/errors";
import { newSimRobot, robotActionLines, robotActionProblem, SIM_TARGET, simulatedAnswer } from "@/lib/gateway/gadget-sim";
import { checkApproval, mintApproval } from "@/lib/tools/sign";
import type { BoardAsk, GadgetBoard, GadgetResult, LinkedBoard } from "@/lib/gateway/gadget";

/**
 * What GADGET_CONNECT adds to {GATEWAY_URL}/gadget (docs/GADGETS.md). gadget.ts decides who gets through and hands the call here.
 *
 *  - ask_board: one answer from the model running on the owner's board, picked by the board's kind at pairing.
 *  - robot_status, robot_action, hard_stop: a simulated board's sensors and allow-listed actions. A real board refuses these today.
 *  - A build gets all of it from the simulator here. It confirms with a card, since no owner is there.
 *  - Live, robot_action only ever answers with a link to Muse Muse's own page, where the owner says yes under their own session.
 *    Nothing a product sends can stand in for that.
 */

/** The message a product shows when the board isn't there: what happened, and what to do. */
export const BOARD_OFFLINE_MESSAGE = "Your board isn't connected, so this can't run on it right now. Turn the board on, or pair it in Muse Muse, then try again.";
export const offlineAnswer = (): Response => gatewayError(503, "server_error", "gadget_offline", BOARD_OFFLINE_MESSAGE, { retry: false });

const text = (value: unknown, simulated: boolean): Response => Response.json({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false, simulated } satisfies GadgetResult & { simulated: boolean });
const bad = (message: string): Response => gatewayError(400, "invalid_request_error", "invalid_arguments", message, { retry: false });

/** One simulator per build token, so one build's hard stop never reaches another's. Fine to lose: it's a simulator. */
const SIMS = new Map<string, ReturnType<typeof newSimRobot>>();
function simFor(tokenId: string): ReturnType<typeof newSimRobot> {
  let sim = SIMS.get(tokenId);
  if (!sim) {
    if (SIMS.size >= 200) SIMS.delete(SIMS.keys().next().value as string);
    sim = newSimRobot();
    SIMS.set(tokenId, sim);
  }
  return sim;
}

/** ask_board's arguments, checked: only known keys, plain text turns and limits. */
export function askProblem(args: Record<string, unknown>): string | null {
  if (Object.keys(args).some((k) => k !== "messages" && k !== "max_tokens")) return "ask_board takes only messages and max_tokens.";
  const { messages, max_tokens: max } = args;
  if (!Array.isArray(messages) || !messages.length || messages.length > ASK_BOARD_MAX_MESSAGES) return `messages must be 1 to ${ASK_BOARD_MAX_MESSAGES} turns.`;
  let chars = 0;
  for (const m of messages as Array<{ role?: unknown; content?: unknown }>) {
    if (!m || typeof m !== "object" || !["system", "user", "assistant"].includes(String(m.role)) || typeof m.content !== "string") return "Each message needs a role and text.";
    chars += m.content.length;
  }
  if (chars > ASK_BOARD_MAX_CHARS) return `messages can be up to ${ASK_BOARD_MAX_CHARS} characters in all.`;
  if (max !== undefined && (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > ASK_BOARD_MAX_TOKENS)) return `max_tokens must be 1 to ${ASK_BOARD_MAX_TOKENS}.`;
  return null;
}

const askRequest = (args: Record<string, unknown>, model: string): BoardAsk => ({ model, messages: args.messages as BoardAsk["messages"], maxTokens: (args.max_tokens as number | undefined) ?? 256 });

export interface BuildCall {
  tool: ConnectTool;
  args: Record<string, unknown>;
  approval: unknown;
  tokenId: string;
  productId: string;
  now: Date;
  /** True the first time this approval's nonce is used. */
  spend(nonce: string): Promise<boolean>;
}

/** A build: everything simulated, and labeled so. */
export async function simulatedCall(call: BuildCall): Promise<Response> {
  const { tool, args } = call;
  const sim = simFor(call.tokenId);
  if (tool === "ask_board") {
    const problem = askProblem(args);
    if (problem) return bad(problem);
    return text({ text: simulatedAnswer(SIM_TARGET.id, args.messages as BoardAsk["messages"]), target: SIM_TARGET.label }, true);
  }
  if (tool === "robot_status") return text(sim.status(), true);
  if (tool === "hard_stop") return text(sim.stop(), true);
  const problem = robotActionProblem(args.action, args.args);
  if (problem) return bad(problem);
  const action = args.action as string;
  const actionArgs = args.args as Record<string, number>;
  const scope = { productId: call.productId, subject: "build", slug: "robot_action", args: { action, args: actionArgs } };
  const approved = typeof call.approval === "string" ? checkApproval(call.approval, scope, call.now) : null;
  if (!approved) return text({ ok: false, code: "needs_confirmation", approval: { id: mintApproval(scope, call.now), ...robotActionLines(action, actionArgs) } }, true);
  if (!(await call.spend(approved.nonce))) return text({ ok: false, code: "needs_confirmation", approval: { id: mintApproval(scope, call.now), ...robotActionLines(action, actionArgs) }, stale: true }, true);
  const done = sim.act(action, actionArgs);
  return typeof done === "string" ? text({ ok: false, code: "stopped", message: done }, true) : text({ ok: true, status: done }, true);
}

/** ask_board on a paired board, for someone the link already let in. */
export async function liveAsk(args: Record<string, unknown>, link: LinkedBoard): Promise<Response> {
  const problem = askProblem(args);
  if (problem) return bad(problem);
  if (!link.facts) return gatewayError(409, "invalid_request_error", "board_not_paired", "This board was added by hand, so Muse Muse doesn't know which model it runs. Pair it, then try again.", { retry: false });
  const board = await link.open();
  if (!board?.ask) return offlineAnswer();
  try {
    const answer = await board.ask(askRequest(args, link.facts.target));
    if (answer.kind === "no_model") {
      return gatewayError(503, "server_error", "gadget_no_model", `Your board is on, but ${link.facts.targetLabel} isn't running on it. Start it on the board, then try again.`, { retry: false });
    }
    return text({ text: answer.text, target: link.facts.targetLabel }, link.facts.simulated);
  } catch {
    // No message: a board's client errors can carry its address.
    console.error("[gadget] a board's model didn't answer");
    return offlineAnswer();
  }
}

const NOT_SIMULATED = () => gatewayError(403, "permission_error", "robot_real_board_off", "Robot actions only run on a simulated board for now. Real boards can't be moved from a product.", { retry: false });

export async function liveRobotStatus(link: LinkedBoard): Promise<Response> {
  if (!link.facts?.robot) return NOT_SIMULATED();
  return relay(await link.open(), "robot_status", {}, link, (body) => ({ ...body, stopped: link.facts!.stopped || body.stopped === true }));
}

async function relay(board: GadgetBoard | null, tool: string, args: Record<string, unknown>, link: LinkedBoard, shape: (body: Record<string, unknown>) => unknown = (b) => b): Promise<Response> {
  if (!board) return offlineAnswer();
  try {
    const result = await board.callTool(tool, args);
    const words = (result.content as Array<{ type?: string; text?: string }>).find((c) => c.type === "text")?.text ?? "{}";
    if (result.isError) return Response.json({ content: [{ type: "text", text: words }], isError: true, simulated: link.facts?.simulated === true });
    return text(shape(JSON.parse(words) as Record<string, unknown>), link.facts?.simulated === true);
  } catch {
    console.error("[gadget] a robot tool didn't answer");
    return offlineAnswer();
  }
}

/** A live robot_action: never acts. It answers with the link the owner confirms on. Owners only, checked by gadget.ts. */
export function liveRobotRequest(args: Record<string, unknown>, link: LinkedBoard, productId: string, siteUrl: string, now: Date): Response {
  if (!link.facts?.robot || !link.boardId) return NOT_SIMULATED();
  const problem = robotActionProblem(args.action, args.args);
  if (problem) return bad(problem);
  const action = args.action as string;
  const actionArgs = args.args as Record<string, number>;
  if (link.facts.stopped) return text({ ok: false, code: "stopped", message: "The hard stop is on. Clear it in Muse Muse first." }, link.facts.simulated);
  const request = mintRobotRequest({ productId, boardId: link.boardId, ownerUserId: link.ownerUserId, action, args: actionArgs }, now);
  return text({ ok: false, code: "needs_confirmation", confirmUrl: `${siteUrl.replace(/\/+$/, "")}/gadgets/confirm?r=${encodeURIComponent(request)}`, ...robotActionLines(action, actionArgs) }, link.facts.simulated);
}

/** A live hard stop: saved on the platform first, so it holds even if the board doesn't answer, and the reply says which happened. */
export async function liveHardStop(link: LinkedBoard, setStopped: (boardId: string) => Promise<void>): Promise<Response> {
  if (!link.facts?.robot || !link.boardId) return NOT_SIMULATED();
  await setStopped(link.boardId);
  let reached = false;
  try {
    const board = await link.open();
    if (board) {
      await board.callTool("hard_stop", {});
      reached = true;
    }
  } catch {
    console.error("[gadget] a hard stop didn't reach the board");
  }
  return text({ stopped: true, reachedBoard: reached }, link.facts.simulated);
}
