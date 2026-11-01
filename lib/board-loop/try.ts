/**
 * The try page's queue (docs/BOARD_LOOP.md). One board answers one person at a time, so turns wait in order, and everyone
 * gets the same deal: one open turn each, a few turns an hour per visitor and per IP, a short prompt and a short answer. A visitor's
 * own polling runs their turn when it reaches the front, so it needs no worker, and a turn nobody polls for 30 seconds
 * gives up its place. A board that goes away ends the turn in plain words and gives the turn back.
 */
import { BoardBusyError, type BoardDriver } from "@/lib/board-loop/driver";
import type { LoopRow } from "@/lib/board-loop/logic";

export const TRY_LIMITS = {
  promptChars: 500,
  answerTokens: 128,
  perVisitorPerHour: 5,
  /** A household or a classroom shares an IP, and clearing a cookie shouldn't buy more. */
  perIpPerHour: 20,
  queue: 12,
  /** A queued turn with no poll for this long leaves the queue. */
  goneMs: 30_000,
  /** A running turn older than this died with its function. */
  runningMs: 150_000,
  askMs: 90_000,
} as const;

export type TurnStatus = "queued" | "running" | "done" | "failed" | "expired";

export interface Turn {
  id: string;
  loopId: string;
  visitor: string;
  status: TurnStatus;
  prompt: string | null;
  answer: string | null;
  tokens: number | null;
  tokensPerSecond: number | null;
  ms: number | null;
  error: string | null;
  lastSeenAt: Date;
  startedAt: Date | null;
  createdAt: Date;
}

export interface TryStore {
  loop(id: string): Promise<LoopRow | null>;
  /** The visitor's queued or running turn on this loop. */
  openTurn(loopId: string, visitor: string): Promise<Turn | null>;
  /** Null when another request took this visitor's one open turn first. */
  addTurn(loopId: string, visitor: string, prompt: string): Promise<Turn | null>;
  turn(id: string): Promise<Turn | null>;
  queueLength(loopId: string): Promise<number>;
  /** Queued turns older than this one, plus one. */
  position(turn: Turn): Promise<number>;
  seen(id: string, at: Date): Promise<void>;
  /** Ends queued turns nobody is polling and running turns that died. */
  sweep(loopId: string, now: Date): Promise<void>;
  /** Takes the one running slot for this turn, or false when another has it. */
  claim(id: string, at: Date): Promise<boolean>;
  finishTurn(id: string, patch: Pick<Turn, "status" | "answer" | "tokens" | "tokensPerSecond" | "ms" | "error">, at: Date): Promise<void>;
  /** Takes one from a counter that can't pass the limit. False when it would. */
  take(key: string, limit: number, now: Date): Promise<boolean>;
  giveBack(key: string, now: Date): Promise<void>;
}

/** What a visitor is told. Never another visitor's words, an address or a token. */
export type TurnView =
  | { status: "queued"; id: string; position: number; simulated: boolean }
  | { status: "running"; id: string; simulated: boolean }
  | { status: "done"; id: string; answer: string; tokens: number; tokensPerSecond: number; ms: number; simulated: boolean }
  | { status: "failed" | "expired"; id: string; message: string; simulated: boolean };

export type Refusal =
  | { refused: "closed" | "offline" | "bad_prompt"; message: string }
  | { refused: "visitor_limit" | "ip_limit" | "queue_full"; message: string; retryAfterSeconds: number };

export const visitorKey = (loopId: string, visitor: string) => `board-try:v:${loopId}:${visitor}`;
export const ipKey = (loopId: string, ip: string) => `board-try:ip:${loopId}:${ip}`;

const secondsToNextHour = (now: Date) => 3600 - (Math.floor(now.getTime() / 1000) % 3600);

const OFFLINE = "The board is offline right now, so nothing can run. Your turn wasn't used.";

export function checkPrompt(prompt: unknown): string | null {
  if (typeof prompt !== "string" || !prompt.trim()) return "Type something to ask.";
  if (prompt.length > TRY_LIMITS.promptChars) return `Keep it under ${TRY_LIMITS.promptChars} characters.`;
  return null;
}

export function viewTurn(turn: Turn, position: number, simulated: boolean): TurnView {
  if (turn.status === "queued") return { status: "queued", id: turn.id, position, simulated };
  if (turn.status === "running") return { status: "running", id: turn.id, simulated };
  if (turn.status === "done") {
    return { status: "done", id: turn.id, answer: turn.answer ?? "", tokens: turn.tokens ?? 0, tokensPerSecond: turn.tokensPerSecond ?? 0, ms: turn.ms ?? 0, simulated };
  }
  return { status: turn.status, id: turn.id, message: turn.error ?? (turn.status === "expired" ? "You left the queue, so your place went to the next person." : "It didn't finish."), simulated };
}

export interface TryDeps {
  store: TryStore;
  /** The running board, or null when it's offline. Never starts one. */
  board(loop: LoopRow): Promise<BoardDriver | null>;
  now(): Date;
}

/** Joins the queue, or says why not. Asking again while a turn is open returns that turn and costs nothing. */
export async function joinQueue(input: { loopId: string; visitor: string; ip: string; prompt: unknown }, { store, board, now }: TryDeps): Promise<{ turn: TurnView } | Refusal> {
  const at = now();
  const loop = await store.loop(input.loopId);
  if (!loop || !loop.tryOpen) return { refused: "closed", message: "This try page isn't open." };
  const simulated = loop.target === "simulated";
  await store.sweep(loop.id, at);

  const open = await store.openTurn(loop.id, input.visitor);
  if (open) return { turn: viewTurn(open, await store.position(open), simulated) };

  const problem = checkPrompt(input.prompt);
  if (problem) return { refused: "bad_prompt", message: problem };

  const driver = await board(loop);
  if (!driver || !(await driver.status()).online) return { refused: "offline", message: OFFLINE };

  if ((await store.queueLength(loop.id)) >= TRY_LIMITS.queue) {
    return { refused: "queue_full", message: "The queue is full. Try again in a minute.", retryAfterSeconds: 60 };
  }
  const retry = secondsToNextHour(at);
  const vKey = visitorKey(loop.id, input.visitor);
  if (!(await store.take(vKey, TRY_LIMITS.perVisitorPerHour, at))) {
    return { refused: "visitor_limit", message: `You've had your ${TRY_LIMITS.perVisitorPerHour} turns this hour, so others get a go.`, retryAfterSeconds: retry };
  }
  const iKey = ipKey(loop.id, input.ip);
  if (!(await store.take(iKey, TRY_LIMITS.perIpPerHour, at))) {
    await store.giveBack(vKey, at);
    return { refused: "ip_limit", message: "This network has had its turns this hour.", retryAfterSeconds: retry };
  }
  const turn = await store.addTurn(loop.id, input.visitor, (input.prompt as string).trim());
  if (!turn) {
    await Promise.all([store.giveBack(vKey, at), store.giveBack(iKey, at)]);
    const raced = await store.openTurn(loop.id, input.visitor);
    if (raced) return { turn: viewTurn(raced, await store.position(raced), simulated) };
    return { refused: "closed", message: "That didn't go through. Try again." };
  }
  return { turn: viewTurn(turn, await store.position(turn), simulated) };
}

/** A visitor's poll: their own turn's state, and if it's at the front with the board free, it runs here. */
export async function pollTurn(input: { turnId: string; visitor: string; ip: string }, { store, board, now }: TryDeps): Promise<TurnView | null> {
  const first = await store.turn(input.turnId);
  // Someone else's turn looks the same as no turn.
  if (!first || first.visitor !== input.visitor) return null;
  const loop = await store.loop(first.loopId);
  const simulated = loop?.target === "simulated";
  const at = now();
  await store.sweep(first.loopId, at);
  const turn = await store.turn(first.id);
  if (!turn) return null;
  if (turn.status !== "queued") return viewTurn(turn, 0, simulated);
  await store.seen(turn.id, at);
  const position = await store.position(turn);
  if (position > 1) return viewTurn(turn, position, simulated);

  const giveBack = () => Promise.all([store.giveBack(visitorKey(turn.loopId, turn.visitor), at), store.giveBack(ipKey(turn.loopId, input.ip), at)]);
  const end = async (patch: Partial<Parameters<TryStore["finishTurn"]>[1]> & { status: "done" | "failed" }) => {
    const full = { answer: null, tokens: null, tokensPerSecond: null, ms: null, error: null, ...patch };
    await store.finishTurn(turn.id, full, now());
    return viewTurn({ ...turn, ...full }, 0, simulated);
  };
  if (!loop?.tryOpen || !loop.data.file) {
    await giveBack();
    return end({ status: "failed", error: "This try page has closed. Your turn wasn't used." });
  }
  const driver = await board(loop);
  if (!driver) {
    await giveBack();
    return end({ status: "failed", error: OFFLINE });
  }
  if (!(await store.claim(turn.id, at))) return viewTurn(turn, position, simulated);
  try {
    const messages = [...(loop.data.systemLine ? [{ role: "system" as const, content: loop.data.systemLine }] : []), { role: "user" as const, content: turn.prompt ?? "" }];
    const answer = await driver.ask({ alias: loop.data.file.alias, messages, maxTokens: TRY_LIMITS.answerTokens, signal: AbortSignal.timeout(TRY_LIMITS.askMs) });
    return await end({ status: "done", answer: answer.text, tokens: answer.tokens, tokensPerSecond: answer.tokensPerSecond, ms: answer.ms });
  } catch (err) {
    await giveBack();
    return end({ status: "failed", error: err instanceof BoardBusyError ? "The board is busy. Your turn wasn't used." : OFFLINE });
  }
}
