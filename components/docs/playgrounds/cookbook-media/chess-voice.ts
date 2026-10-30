import {
  PIECE_NAMES,
  applyMove,
  coordinateLabel,
  gameStatus,
  legalMoves,
  opponent,
  parseSquare,
  pieceLabel,
  squareName,
  toSan,
  typeOf,
  colorOf,
  inCheck,
  isAttacked,
  type Move,
  type PieceType,
  type Position,
} from "@/components/docs/playgrounds/cookbook-media/chess";

/**
 * The deterministic move parser behind the voice chess demo (cookbook/voice-chess-cua). A finished speech turn is the
 * only thing that can move a piece: partials never do. The recipe's grammar is one exact phrase, "Move A1 to B2"
 * (case-insensitive, an optional trailing period, two different squares), and anything else executes nothing. The
 * demo's second grammar adds piece moves ("Knight to f3") and castling, resolved against the legal moves on the board,
 * and several moves in one turn when every word belongs to one of them. Both fail closed: a word that isn't part of a
 * move, an ambiguous piece, or an illegal move rejects the whole turn and nothing on the board changes.
 */

export type Grammar = "exact" | "pieces";

export type Command =
  | { kind: "coordinate"; from: number; to: number; text: string }
  | { kind: "piece"; piece: PieceType; to: number; text: string }
  | { kind: "castle"; side: "K" | "Q"; text: string };

export type RejectCode = "empty" | "grammar" | "same_square" | "no_piece" | "wrong_side" | "illegal" | "ambiguous" | "game_over";

export interface Rejection {
  code: RejectCode;
  message: string;
  /** Which phrase in the turn failed (0-based), when it got that far. */
  at?: number;
}

export type ParseResult = { ok: true; commands: Command[] } | { ok: false; rejection: Rejection };

/** Transcripts can carry a leading space and a trailing zero-width space (docs/SPIKES.md); nothing else is changed. */
export function cleanHeard(text: string): string {
  return text.replace(/​/g, "").trim();
}

const EXACT = /^move ([a-h][1-8]) to ([a-h][1-8])\.?$/i;
const SPOKEN_RANK = /\b[a-h] (one|two|three|four|five|six|seven|eight)\b/i;

/** Why a phrase isn't the exact grammar, in the recipe's own terms. */
function exactMiss(text: string): string {
  if (SPOKEN_RANK.test(text)) return 'Spoken ranks such as "E two" aren\'t converted. Say "Move E2 to E4".';
  if (/\s{2,}|\b[a-h] [1-8]\b/i.test(text)) return "Spacing isn't repaired: a square is one word, such as E4.";
  if (/^move [a-h][1-8] to [a-h][1-8][^\s\w]+$/i.test(text)) return "Only a trailing period may follow the move.";
  if (/move [a-h][1-8] to [a-h][1-8]/i.test(text)) return "A move isn't lifted out of surrounding words: the whole turn must be the move.";
  return 'Only the exact phrase "Move A1 to B2" runs, with files A to H and ranks 1 to 8.';
}

const PIECE_WORDS: Record<string, PieceType> = { pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" };

/**
 * Reads a finished turn into commands, without looking at the board. `exact` is the recipe's grammar; `pieces` also
 * takes "Knight to f3", "Castle kingside" and several moves in a row ("pawn to e4, knight to f3").
 */
export function parseUtterance(raw: string, grammar: Grammar): ParseResult {
  const text = cleanHeard(raw);
  if (!text) return { ok: false, rejection: { code: "empty", message: "Nothing was heard." } };

  if (grammar === "exact") {
    const m = EXACT.exec(text);
    if (!m) return { ok: false, rejection: { code: "grammar", message: exactMiss(text) } };
    const from = parseSquare(m[1])!;
    const to = parseSquare(m[2])!;
    if (from === to) return { ok: false, rejection: { code: "same_square", message: "The two squares must differ." } };
    return { ok: true, commands: [{ kind: "coordinate", from, to, text }] };
  }

  // Words and the punctuation allowed between moves. Every word has to belong to a move.
  const tokens = text.toLowerCase().match(/[a-z0-9]+|[,.;!?]/g) ?? [];
  const leftovers = text.toLowerCase().replace(/[a-z0-9]+|[,.;!?]|\s+/g, "");
  if (leftovers) return { ok: false, rejection: { code: "grammar", message: `"${leftovers.slice(0, 12)}" isn't part of a move.` } };
  const commands: Command[] = [];
  let i = 0;
  const word = () => tokens[i];
  const isSep = (t: string | undefined) => !!t && /^[,.;!?]$/.test(t);
  while (i < tokens.length) {
    if (isSep(word())) {
      // Separators go between moves (and one may end the turn), never first.
      if (!commands.length) return { ok: false, rejection: { code: "grammar", message: "A turn starts with a move." } };
      i++;
      continue;
    }
    const start = i;
    const w = tokens[i++];
    const sq = (t: string | undefined) => (t && /^[a-h][1-8]$/.test(t) ? parseSquare(t) : null);
    let command: Command | null = null;
    if (w === "move") {
      const from = sq(tokens[i]);
      const to = tokens[i + 1] === "to" ? sq(tokens[i + 2]) : null;
      if (from !== null && to !== null) {
        if (from === to) return { ok: false, rejection: { code: "same_square", message: "The two squares must differ.", at: commands.length } };
        i += 3;
        command = { kind: "coordinate", from, to, text: "" };
      }
    } else if (PIECE_WORDS[w]) {
      const to = tokens[i] === "to" ? sq(tokens[i + 1]) : null;
      if (to !== null) {
        i += 2;
        command = { kind: "piece", piece: PIECE_WORDS[w], to, text: "" };
      }
    } else if (w === "castle" && (tokens[i] === "kingside" || tokens[i] === "queenside")) {
      command = { kind: "castle", side: tokens[i] === "kingside" ? "K" : "Q", text: "" };
      i++;
    }
    if (!command) {
      const shown = tokens.slice(start, Math.min(tokens.length, start + 4)).filter((t) => !isSep(t)).join(" ");
      const near = tokens.slice(start, start + 6).join(" ");
      const hint = SPOKEN_RANK.test(near)
        ? ' Spoken ranks such as "e four" aren\'t converted.'
        : /\b[a-h] [1-8]\b/.test(near)
          ? " Spacing isn't repaired: a square is one word, such as e4."
          : PIECE_WORDS[w] || w === "move" || w === "castle"
            ? ""
            : ` "${w}" isn't a piece or a move word.`;
      return { ok: false, rejection: { code: "grammar", message: `"${shown}" isn't a move.${hint}`, at: commands.length } };
    }
    command.text = tokens.slice(start, i).join(" ");
    commands.push(command);
  }
  if (!commands.length) return { ok: false, rejection: { code: "grammar", message: "No move was heard." } };
  return { ok: true, commands };
}

/** Why castling isn't possible now, in a few words. */
function castleProblem(p: Position, side: "K" | "Q"): string {
  const me = p.turn;
  const right = me === "w" ? (side === "K" ? p.castling.K : p.castling.Q) : side === "K" ? p.castling.k : p.castling.q;
  const name = side === "K" ? "kingside" : "queenside";
  if (!right) return `Castling ${name} isn't allowed any more: the king or that rook has moved.`;
  const home = me === "w" ? 4 : 60;
  const between = side === "K" ? [home + 1, home + 2] : [home - 1, home - 2, home - 3];
  const blocked = between.filter((s) => p.board[s]);
  if (blocked.length) return `Castling ${name} needs ${between.map(squareName).join(" and ")} empty; ${blocked.map(squareName).join(" and ")} ${blocked.length === 1 ? "is" : "are"} taken.`;
  if (inCheck(p)) return "You can't castle out of check.";
  const crossed = side === "K" ? [home + 1, home + 2] : [home - 1, home - 2];
  if (crossed.some((s) => isAttacked(p.board, s, opponent(me)))) return "The king can't castle through or into check.";
  return `Castling ${name} isn't legal now.`;
}

/** The legal move a command names on this board, or why there isn't exactly one. */
export function resolveCommand(p: Position, c: Command): { ok: true; move: Move } | { ok: false; rejection: Rejection } {
  const legal = legalMoves(p);
  const side = p.turn === "w" ? "White" : "Black";
  if (!legal.length) return { ok: false, rejection: { code: "game_over", message: "The game is over: there are no legal moves." } };
  // A promotion becomes a queen, the way the Chess app's default does.
  const pick = (moves: Move[]) => moves.find((m) => !m.promotion || m.promotion === "q") ?? moves[0];

  if (c.kind === "coordinate") {
    const piece = p.board[c.from];
    if (!piece) return { ok: false, rejection: { code: "no_piece", message: `There's no piece on ${squareName(c.from)}.` } };
    if (colorOf(piece) !== p.turn) {
      return { ok: false, rejection: { code: "wrong_side", message: `${squareName(c.from)} holds a ${pieceLabel(piece)}, and it's ${side}'s move.` } };
    }
    const found = legal.filter((m) => m.from === c.from && m.to === c.to);
    if (!found.length) {
      return { ok: false, rejection: { code: "illegal", message: `The ${PIECE_NAMES[typeOf(piece)]} on ${squareName(c.from)} can't move to ${squareName(c.to)}.` } };
    }
    return { ok: true, move: pick(found) };
  }

  if (c.kind === "castle") {
    const found = legal.filter((m) => m.castle === c.side);
    if (!found.length) return { ok: false, rejection: { code: "illegal", message: castleProblem(p, c.side) } };
    return { ok: true, move: found[0] };
  }

  const found = legal.filter((m) => m.piece === c.piece && m.to === c.to);
  const name = PIECE_NAMES[c.piece];
  if (!found.length) {
    const any = p.board.some((x) => x !== null && colorOf(x) === p.turn && typeOf(x) === c.piece);
    return {
      ok: false,
      rejection: {
        code: any ? "illegal" : "no_piece",
        message: any ? `No ${side.toLowerCase()} ${name} can move to ${squareName(c.to)} now.` : `${side} has no ${name} left.`,
      },
    };
  }
  const froms = [...new Set(found.map((m) => m.from))];
  if (froms.length > 1) {
    const where = froms.map(squareName);
    return {
      ok: false,
      rejection: {
        code: "ambiguous",
        message: `Ambiguous: the ${name}s on ${where.join(" and ")} can both move to ${squareName(c.to)}. Say "Move ${where[0].toUpperCase()} to ${squareName(c.to).toUpperCase()}".`,
      },
    };
  }
  return { ok: true, move: pick(found) };
}

// ---- The opponent ---------------------------------------------------------------------------------------------

/**
 * Black's replies while the reader plays White, standing in for the Chess app's computer player: a few opening lines
 * (the sample speaks the Italian Game's White moves), then the first legal move in board order. Deterministic, so the
 * same words always give the same game.
 */
const BOOK: Readonly<Record<string, string>> = {
  e2e4: "e7e5",
  "e2e4 e7e5 g1f3": "b8c6",
  "e2e4 e7e5 g1f3 b8c6 f1c4": "f8c5",
  "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1g1": "g8f6",
  "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3": "g8f6",
  "e2e4 e7e5 g1f3 b8c6 f1b5": "a7a6",
  "e2e4 e7e5 g1f3 b8c6 d2d4": "e5d4",
  "e2e4 e7e5 f1c4": "g8f6",
  "e2e4 e7e5 d2d4": "e5d4",
  "e2e4 e7e5 b1c3": "g8f6",
  d2d4: "d7d5",
  "d2d4 d7d5 c2c4": "e7e6",
  "d2d4 d7d5 g1f3": "g8f6",
  c2c4: "e7e5",
  g1f3: "g8f6",
  "g1f3 g8f6 f1c4": "e7e6",
};

const uci = (m: Move) => `${squareName(m.from)}${squareName(m.to)}${m.promotion && m.promotion !== "q" ? m.promotion : ""}`;

export function replyFor(p: Position, history: readonly Move[]): Move | null {
  const legal = legalMoves(p);
  if (!legal.length) return null;
  const book = BOOK[history.map(uci).join(" ")];
  const fromBook = book ? legal.find((m) => uci(m) === book) : undefined;
  return fromBook ?? legal.find((m) => !m.promotion || m.promotion === "q") ?? legal[0];
}

// ---- A whole turn ---------------------------------------------------------------------------------------------

export interface Played {
  move: Move;
  san: string;
  /** "you" for a spoken move, "reply" for Black's answer. */
  by: "you" | "reply";
  /** The words that named it. */
  text?: string;
}

export interface GameState {
  position: Position;
  history: Move[];
  /** SAN for each move in `history`, for the move list. */
  sans: string[];
}

export type TurnOutcome =
  | { ok: true; played: Played[]; state: GameState; dryRun: boolean }
  | { ok: false; rejection: Rejection; commands: Command[] };

export function newGame(position: Position): GameState {
  return { position, history: [], sans: [] };
}

function play(state: GameState, move: Move): { state: GameState; san: string } {
  const san = toSan(state.position, move);
  return { state: { position: applyMove(state.position, move), history: [...state.history, move], sans: [...state.sans, san] }, san };
}

/**
 * Runs one finished turn against the game: parse, resolve every command on a scratch copy (with Black's replies in
 * between when `autoReply` is on), and only then commit. Any failure rejects the whole turn, so nothing moves. A dry
 * run checks everything the same way and returns the game unchanged.
 */
export function runTurn(
  state: GameState,
  heard: string,
  opts: { grammar: Grammar; autoReply: boolean; dryRun?: boolean },
): TurnOutcome {
  const parsed = parseUtterance(heard, opts.grammar);
  if (!parsed.ok) return { ok: false, rejection: parsed.rejection, commands: [] };
  let scratch = state;
  const played: Played[] = [];
  for (let i = 0; i < parsed.commands.length; i++) {
    const c = parsed.commands[i];
    const found = resolveCommand(scratch.position, c);
    if (!found.ok) return { ok: false, rejection: { ...found.rejection, at: i }, commands: parsed.commands };
    const step = play(scratch, found.move);
    scratch = step.state;
    played.push({ move: found.move, san: step.san, by: "you", text: c.text });
    if (opts.autoReply && gameStatus(scratch.position) !== "checkmate" && gameStatus(scratch.position) !== "stalemate") {
      const reply = replyFor(scratch.position, scratch.history);
      if (reply) {
        const answered = play(scratch, reply);
        scratch = answered.state;
        played.push({ move: reply, san: answered.san, by: "reply" });
      }
    }
  }
  return { ok: true, played, state: opts.dryRun ? state : scratch, dryRun: !!opts.dryRun };
}

/** "1. e4 e5 2. Nf3", for the move list. */
export function moveListText(sans: readonly string[], firstMoveBlack = false): string {
  const out: string[] = [];
  let n = 1;
  let i = 0;
  if (firstMoveBlack && sans.length) {
    out.push(`1... ${sans[0]}`);
    i = 1;
    n = 2;
  }
  for (; i < sans.length; i += 2, n++) out.push(`${n}. ${sans[i]}${sans[i + 1] ? ` ${sans[i + 1]}` : ""}`);
  return out.join(" ");
}

export { coordinateLabel };
