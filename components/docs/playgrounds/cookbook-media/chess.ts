/**
 * A small, complete chess rules engine for the voice chess demo (cookbook/voice-chess-cua). The recipe hands Apple
 * Chess two clicks and lets the app enforce the rules; in the browser the board is ours, so every spoken move is
 * checked here before anything changes: legal moves (castling, en passant, promotion, pins and checks included),
 * applying a move, SAN for the move list, and FEN for tests. Pure and deterministic, checked by perft counts.
 *
 * Squares are 0 to 63: a1 = 0, h1 = 7, a8 = 56, h8 = 63 (index = rank * 8 + file). Pieces are FEN letters, uppercase
 * for White.
 */

export type Color = "w" | "b";
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";
/** A FEN piece letter: "P" is a white pawn, "n" a black knight. */
export type Piece = string;

export interface Position {
  board: (Piece | null)[];
  turn: Color;
  castling: { K: boolean; Q: boolean; k: boolean; q: boolean };
  /** The square a pawn can capture onto en passant, or null. */
  enPassant: number | null;
  halfmove: number;
  fullmove: number;
}

export interface Move {
  from: number;
  to: number;
  piece: PieceType;
  color: Color;
  captured?: PieceType;
  promotion?: PieceType;
  castle?: "K" | "Q";
  enPassant?: boolean;
}

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export const PIECE_NAMES: Record<PieceType, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

const FILES = "abcdefgh";

export function squareName(sq: number): string {
  return `${FILES[sq & 7]}${(sq >> 3) + 1}`;
}

/** "e4" (any case) to its index, or null for anything else. */
export function parseSquare(name: string): number | null {
  const m = /^([a-h])([1-8])$/i.exec(name.trim());
  if (!m) return null;
  return (Number(m[2]) - 1) * 8 + FILES.indexOf(m[1].toLowerCase());
}

export function colorOf(piece: Piece): Color {
  return piece === piece.toUpperCase() ? "w" : "b";
}

export function typeOf(piece: Piece): PieceType {
  return piece.toLowerCase() as PieceType;
}

function pieceOf(color: Color, type: PieceType): Piece {
  return color === "w" ? type.toUpperCase() : type;
}

export function opponent(color: Color): Color {
  return color === "w" ? "b" : "w";
}

// ---- FEN ------------------------------------------------------------------------------------------------------

export function fromFen(fen: string): Position {
  const [placement, turn = "w", castling = "-", ep = "-", half = "0", full = "1"] = fen.trim().split(/\s+/);
  const rows = placement.split("/");
  if (rows.length !== 8) throw new Error(`A FEN board has 8 ranks, not ${rows.length}.`);
  const board: (Piece | null)[] = new Array(64).fill(null);
  rows.forEach((row, i) => {
    const rank = 7 - i;
    let file = 0;
    for (const ch of row) {
      if (/[1-8]/.test(ch)) file += Number(ch);
      else if (/[pnbrqk]/i.test(ch)) {
        if (file > 7) throw new Error(`Rank ${rank + 1} has too many squares.`);
        board[rank * 8 + file] = ch;
        file++;
      } else throw new Error(`"${ch}" isn't a FEN piece.`);
    }
    if (file !== 8) throw new Error(`Rank ${rank + 1} has ${file} squares, not 8.`);
  });
  return {
    board,
    turn: turn === "b" ? "b" : "w",
    castling: { K: castling.includes("K"), Q: castling.includes("Q"), k: castling.includes("k"), q: castling.includes("q") },
    enPassant: ep === "-" ? null : parseSquare(ep),
    halfmove: Number(half) || 0,
    fullmove: Number(full) || 1,
  };
}

export function toFen(p: Position): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = p.board[rank * 8 + file];
      if (!piece) empty++;
      else {
        if (empty) row += String(empty);
        empty = 0;
        row += piece;
      }
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  const c = p.castling;
  const castling = `${c.K ? "K" : ""}${c.Q ? "Q" : ""}${c.k ? "k" : ""}${c.q ? "q" : ""}` || "-";
  return `${rows.join("/")} ${p.turn} ${castling} ${p.enPassant === null ? "-" : squareName(p.enPassant)} ${p.halfmove} ${p.fullmove}`;
}

export function startPosition(): Position {
  return fromFen(START_FEN);
}

// ---- Attacks and moves ----------------------------------------------------------------------------------------

const KNIGHT: ReadonlyArray<[number, number]> = [
  [1, 2],
  [2, 1],
  [-1, 2],
  [-2, 1],
  [1, -2],
  [2, -1],
  [-1, -2],
  [-2, -1],
];
const KING: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const DIAGONALS: ReadonlyArray<[number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const LINES: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function step(sq: number, df: number, dr: number): number | null {
  const file = (sq & 7) + df;
  const rank = (sq >> 3) + dr;
  return file < 0 || file > 7 || rank < 0 || rank > 7 ? null : rank * 8 + file;
}

/** True when a piece of color `by` attacks `sq` on this board. */
export function isAttacked(board: readonly (Piece | null)[], sq: number, by: Color): boolean {
  const own = (p: Piece | null, t: PieceType) => p !== null && colorOf(p) === by && typeOf(p) === t;
  // Pawns attack diagonally forward, so look one rank behind the square from the attacker's side.
  const back = by === "w" ? -1 : 1;
  for (const df of [-1, 1]) {
    const s = step(sq, df, back);
    if (s !== null && own(board[s], "p")) return true;
  }
  for (const [df, dr] of KNIGHT) {
    const s = step(sq, df, dr);
    if (s !== null && own(board[s], "n")) return true;
  }
  for (const [df, dr] of KING) {
    const s = step(sq, df, dr);
    if (s !== null && own(board[s], "k")) return true;
  }
  const slide = (dirs: ReadonlyArray<[number, number]>, types: PieceType[]) => {
    for (const [df, dr] of dirs) {
      let s = step(sq, df, dr);
      while (s !== null) {
        const p = board[s];
        if (p) {
          if (colorOf(p) === by && types.includes(typeOf(p))) return true;
          break;
        }
        s = step(s, df, dr);
      }
    }
    return false;
  };
  return slide(DIAGONALS, ["b", "q"]) || slide(LINES, ["r", "q"]);
}

export function kingSquare(board: readonly (Piece | null)[], color: Color): number {
  return board.indexOf(pieceOf(color, "k"));
}

export function inCheck(p: Position, color: Color = p.turn): boolean {
  const k = kingSquare(p.board, color);
  return k >= 0 && isAttacked(p.board, k, opponent(color));
}

/** Moves that follow how the pieces move, before checking whether they leave the king in check. */
function pseudoMoves(p: Position): Move[] {
  const moves: Move[] = [];
  const me = p.turn;
  const them = opponent(me);
  const add = (from: number, to: number, piece: PieceType, extra: Partial<Move> = {}) => {
    const target = p.board[to];
    moves.push({ from, to, piece, color: me, ...(target ? { captured: typeOf(target) } : {}), ...extra });
  };
  for (let from = 0; from < 64; from++) {
    const piece = p.board[from];
    if (!piece || colorOf(piece) !== me) continue;
    const type = typeOf(piece);
    if (type === "p") {
      const dir = me === "w" ? 1 : -1;
      const startRank = me === "w" ? 1 : 6;
      const lastRank = me === "w" ? 7 : 0;
      const pawnTo = (to: number, extra: Partial<Move> = {}) => {
        if (to >> 3 === lastRank) for (const promotion of ["q", "r", "b", "n"] as const) add(from, to, "p", { ...extra, promotion });
        else add(from, to, "p", extra);
      };
      const one = step(from, 0, dir);
      if (one !== null && !p.board[one]) {
        pawnTo(one);
        const two = step(from, 0, 2 * dir);
        if (from >> 3 === startRank && two !== null && !p.board[two]) add(from, two, "p");
      }
      for (const df of [-1, 1]) {
        const to = step(from, df, dir);
        if (to === null) continue;
        const target = p.board[to];
        if (target && colorOf(target) === them) pawnTo(to);
        else if (to === p.enPassant) add(from, to, "p", { enPassant: true, captured: "p" });
      }
      continue;
    }
    if (type === "n" || type === "k") {
      for (const [df, dr] of type === "n" ? KNIGHT : KING) {
        const to = step(from, df, dr);
        if (to === null) continue;
        const target = p.board[to];
        if (!target || colorOf(target) === them) add(from, to, type);
      }
      if (type === "k") castles(p, from, add);
      continue;
    }
    const dirs = type === "b" ? DIAGONALS : type === "r" ? LINES : [...DIAGONALS, ...LINES];
    for (const [df, dr] of dirs) {
      let to = step(from, df, dr);
      while (to !== null) {
        const target = p.board[to];
        if (target) {
          if (colorOf(target) === them) add(from, to, type);
          break;
        }
        add(from, to, type);
        to = step(to, df, dr);
      }
    }
  }
  return moves;
}

/** Castling: the king and rook unmoved (the rights), the squares between them empty, and no square the king crosses attacked. */
function castles(p: Position, from: number, add: (from: number, to: number, piece: PieceType, extra?: Partial<Move>) => void) {
  const me = p.turn;
  const them = opponent(me);
  const home = me === "w" ? 4 : 60;
  if (from !== home || isAttacked(p.board, home, them)) return;
  const rook = pieceOf(me, "r");
  const kingSide = me === "w" ? p.castling.K : p.castling.k;
  const queenSide = me === "w" ? p.castling.Q : p.castling.q;
  if (kingSide && p.board[home + 3] === rook && !p.board[home + 1] && !p.board[home + 2]) {
    if (!isAttacked(p.board, home + 1, them) && !isAttacked(p.board, home + 2, them)) add(home, home + 2, "k", { castle: "K" });
  }
  if (queenSide && p.board[home - 4] === rook && !p.board[home - 1] && !p.board[home - 2] && !p.board[home - 3]) {
    if (!isAttacked(p.board, home - 1, them) && !isAttacked(p.board, home - 2, them)) add(home, home - 2, "k", { castle: "Q" });
  }
}

/** The position after a move. Doesn't check legality: pass moves from legalMoves. */
export function applyMove(p: Position, m: Move): Position {
  const board = p.board.slice();
  const me = m.color;
  board[m.from] = null;
  board[m.to] = pieceOf(me, m.promotion ?? m.piece);
  if (m.enPassant) board[m.to + (me === "w" ? -8 : 8)] = null;
  if (m.castle) {
    const home = me === "w" ? 4 : 60;
    const [rookFrom, rookTo] = m.castle === "K" ? [home + 3, home + 1] : [home - 4, home - 1];
    board[rookTo] = board[rookFrom];
    board[rookFrom] = null;
  }
  const castling = { ...p.castling };
  if (m.piece === "k") {
    if (me === "w") castling.K = castling.Q = false;
    else castling.k = castling.q = false;
  }
  // A rook leaving or captured on its corner ends that side's castling.
  for (const sq of [m.from, m.to]) {
    if (sq === 0) castling.Q = false;
    if (sq === 7) castling.K = false;
    if (sq === 56) castling.q = false;
    if (sq === 63) castling.k = false;
  }
  const double = m.piece === "p" && Math.abs(m.to - m.from) === 16;
  return {
    board,
    turn: opponent(me),
    castling,
    enPassant: double ? (m.from + m.to) / 2 : null,
    halfmove: m.piece === "p" || m.captured ? 0 : p.halfmove + 1,
    fullmove: me === "b" ? p.fullmove + 1 : p.fullmove,
  };
}

/** Every legal move for the side to move. */
export function legalMoves(p: Position): Move[] {
  return pseudoMoves(p).filter((m) => !inCheck(applyMove(p, m), m.color));
}

/** Leaf count at `depth`, the standard check on a move generator. */
export function perft(p: Position, depth: number): number {
  if (depth === 0) return 1;
  const moves = legalMoves(p);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft(applyMove(p, m), depth - 1);
  return n;
}

export type GameStatus = "playing" | "check" | "checkmate" | "stalemate";

export function gameStatus(p: Position): GameStatus {
  const moves = legalMoves(p);
  const check = inCheck(p);
  if (!moves.length) return check ? "checkmate" : "stalemate";
  return check ? "check" : "playing";
}

/** Standard algebraic notation for a legal move in position `p`: "e4", "Nbd2", "exd5", "O-O", "e8=Q+". */
export function toSan(p: Position, m: Move): string {
  let san: string;
  if (m.castle) san = m.castle === "K" ? "O-O" : "O-O-O";
  else if (m.piece === "p") {
    san = m.captured ? `${FILES[m.from & 7]}x${squareName(m.to)}` : squareName(m.to);
    if (m.promotion) san += `=${m.promotion.toUpperCase()}`;
  } else {
    const rivals = legalMoves(p).filter((o) => o.piece === m.piece && o.to === m.to && o.from !== m.from);
    let which = "";
    if (rivals.length) {
      const sameFile = rivals.some((o) => (o.from & 7) === (m.from & 7));
      const sameRank = rivals.some((o) => o.from >> 3 === m.from >> 3);
      which = !sameFile ? FILES[m.from & 7] : !sameRank ? String((m.from >> 3) + 1) : squareName(m.from);
    }
    san = `${m.piece.toUpperCase()}${which}${m.captured ? "x" : ""}${squareName(m.to)}`;
  }
  const after = applyMove(p, m);
  const status = gameStatus(after);
  return san + (status === "checkmate" ? "#" : status === "check" ? "+" : "");
}

/** "e2-e4", "g1-f3", with "=Q" for a promotion: the two clicks the recipe posts. */
export function coordinateLabel(m: Move): string {
  return `${squareName(m.from)}-${squareName(m.to)}${m.promotion ? `=${m.promotion.toUpperCase()}` : ""}`;
}

/** "white knight", for labels and screen readers. */
export function pieceLabel(piece: Piece): string {
  return `${colorOf(piece) === "w" ? "white" : "black"} ${PIECE_NAMES[typeOf(piece)]}`;
}
