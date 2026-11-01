/**
 * Simulated screens for the computer-use demos (computer-use, cookbook/computer-use, cookbook/computer-use-macos).
 * Each is a 1280 x 800 screen with state that actions change, so the observe-act loop is real: the model sees a
 * screenshot, returns actions, the simulator applies them, and the next screenshot shows the result. Nothing is
 * executed on the reader's machine. Three scenes:
 *
 * - signup: the Sprout sign-up form from our sample screenshot (public/docs-samples/signup-screen.png), whose
 *   fields, checkbox and buttons react to clicks, typing and keys;
 * - tictactoe: a macOS-style tic-tac-toe window (the macOS recipe's demo), the model plays X;
 * - mines: a Linux desktop with a Mines launcher and an 8 x 8 board with 10 mines (the Cua recipe's task).
 *
 * The logic is pure; render() draws a state on any 2D canvas context.
 */

export const SCREEN_W = 1280;
export const SCREEN_H = 800;

export type SceneId = "signup" | "tictactoe" | "mines";

/** One action in the native computer tool's vocabulary; the other protocols are mapped onto it. */
export type Action =
  | { type: "click"; button?: string; x: number; y: number }
  | { type: "double_click"; x: number; y: number }
  | { type: "drag"; path: Array<{ x: number; y: number }> }
  | { type: "keypress"; keys: string[] }
  | { type: "move"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; scroll_x?: number; scroll_y?: number }
  | { type: "type"; text: string }
  | { type: "screenshot" }
  | { type: "wait" };

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

// ---------------------------------------------------------------------------------------------------------------
// Sign-up form

type Field = "name" | "email" | "password";

export interface SignupState {
  kind: "signup";
  focus: Field | null;
  values: Record<Field, string>;
  agreed: boolean;
  screen: "form" | "created" | "cancelled" | "signin";
  error: string | null;
  selectAll: boolean;
}

export const SIGNUP_RECTS: Record<Field | "checkbox" | "agreeLabel" | "create" | "cancel" | "signin" | "continue", Rect> = {
  name: { x: 726, y: 253, w: 348, h: 44 },
  email: { x: 726, y: 334, w: 348, h: 44 },
  password: { x: 726, y: 415, w: 348, h: 44 },
  // A label-sized hit area around the 18 px box, as a wrapped <label> gives in a real form.
  checkbox: { x: 714, y: 472, w: 34, h: 28 },
  agreeLabel: { x: 750, y: 476, w: 250, h: 20 },
  create: { x: 726, y: 517, w: 348, h: 46 },
  cancel: { x: 726, y: 575, w: 348, h: 46 },
  signin: { x: 956, y: 638, w: 54, h: 20 },
  continue: { x: 726, y: 520, w: 348, h: 46 },
};

const FIELDS: Field[] = ["name", "email", "password"];
const FIELD_LABEL: Record<Field, string> = { name: "Full name", email: "Email", password: "Password" };

function signupInitial(): SignupState {
  return { kind: "signup", focus: null, values: { name: "", email: "", password: "" }, agreed: false, screen: "form", error: null, selectAll: false };
}

function signupProblems(s: SignupState): string | null {
  if (!s.values.name.trim()) return "Please enter your full name.";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.values.email.trim())) return "Please enter a valid email address.";
  if (s.values.password.length < 8) return "Your password needs at least 8 characters.";
  if (!s.agreed) return "Please agree to the Terms and Privacy Policy to continue.";
  return null;
}

function signupSubmit(s: SignupState): [SignupState, string] {
  const problem = signupProblems(s);
  if (problem) return [{ ...s, error: problem }, `Create account: the form says "${problem}"`];
  return [{ ...s, screen: "created", error: null, focus: null }, `Create account: account created for ${s.values.email}`];
}

function signupApply(s: SignupState, a: Action): [SignupState, string] {
  if (a.type === "click" || a.type === "double_click") {
    const { x, y } = a;
    if (s.screen === "created") return inside(SIGNUP_RECTS.continue, x, y) ? [s, "Continue: the next step isn't part of this demo"] : [s, "Clicked an empty spot"];
    if (s.screen !== "form") {
      return [signupInitial(), "Clicked: back to the sign-up form"];
    }
    for (const f of FIELDS) {
      if (inside(SIGNUP_RECTS[f], x, y)) return [{ ...s, focus: f, selectAll: a.type === "double_click" && !!s.values[f] }, `Focused ${FIELD_LABEL[f]}`];
    }
    if (inside(SIGNUP_RECTS.checkbox, x, y) || inside(SIGNUP_RECTS.agreeLabel, x, y)) {
      return [{ ...s, agreed: !s.agreed, focus: null, error: s.error && !s.agreed ? null : s.error }, s.agreed ? "Unchecked the Terms box" : "Checked the Terms box"];
    }
    if (inside(SIGNUP_RECTS.create, x, y)) return signupSubmit({ ...s, focus: null });
    if (inside(SIGNUP_RECTS.cancel, x, y)) return [{ ...s, screen: "cancelled", focus: null }, "Cancel: left the sign-up form"];
    if (inside(SIGNUP_RECTS.signin, x, y)) return [{ ...s, screen: "signin", focus: null }, "Sign in: opened the sign-in page"];
    return [{ ...s, focus: null }, `Clicked (${x}, ${y}): nothing there`];
  }
  if (a.type === "type") {
    if (s.screen !== "form") return [s, "Typed, but no field is on screen"];
    if (!s.focus) return [s, `Typed "${a.text}", but no field had focus`];
    const prev = s.selectAll ? "" : s.values[s.focus];
    const text = a.text.replace(/\n$/, "");
    const next = { ...s, values: { ...s.values, [s.focus]: (prev + text).slice(0, 60) }, selectAll: false };
    const [after, note] = a.text.endsWith("\n") ? signupSubmit(next) : [next, ""];
    return [after, `Typed ${s.focus === "password" ? `${text.length} characters` : `"${text}"`} into ${FIELD_LABEL[s.focus]}${note ? `; ${note}` : ""}`];
  }
  if (a.type === "keypress") {
    const keys = a.keys.map((k) => k.toLowerCase());
    const combo = keys.join("+");
    if (/(ctrl|cmd|meta|super)\+a$/.test(combo)) return [{ ...s, selectAll: !!s.focus }, "Selected all the text in the field"];
    const key = keys[keys.length - 1];
    if (key === "tab") {
      const order: Array<Field | null> = [...FIELDS, null];
      const i = s.focus ? FIELDS.indexOf(s.focus) : -1;
      return [{ ...s, focus: order[(i + 1) % order.length] ?? null }, `Tab: focus moved to ${order[(i + 1) % order.length] ? FIELD_LABEL[order[(i + 1) % order.length]!] : "the checkbox"}`];
    }
    if (key === "enter" || key === "return") return s.screen === "form" ? signupSubmit(s) : [s, "Enter"];
    if ((key === "backspace" || key === "delete") && s.focus) {
      const v = s.selectAll ? "" : s.values[s.focus].slice(0, -1);
      return [{ ...s, values: { ...s.values, [s.focus]: v }, selectAll: false }, `Deleted in ${FIELD_LABEL[s.focus]}`];
    }
    if ((key === "space" || key === " ") && !s.focus) return [{ ...s, agreed: !s.agreed }, "Space: toggled the Terms box"];
    return [s, `Pressed ${a.keys.join("+")}`];
  }
  return [s, describe(a)];
}

// ---------------------------------------------------------------------------------------------------------------
// Tic-tac-toe

export interface TttState {
  kind: "tictactoe";
  cells: Array<"" | "X" | "O">;
  status: "playing" | "x-won" | "o-won" | "draw";
  seed: number;
  line: number[] | null;
}

export const TTT = { win: { x: 390, y: 120, w: 500, h: 580 }, board: { x: 460, y: 222, size: 360 }, newGame: { x: 565, y: 618, w: 150, h: 40 } };
const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function winner(cells: TttState["cells"]): { who: "X" | "O"; line: number[] } | null {
  for (const l of LINES) if (cells[l[0]] && cells[l[0]] === cells[l[1]] && cells[l[1]] === cells[l[2]]) return { who: cells[l[0]] as "X" | "O", line: l };
  return null;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** O's move: take a win if there is one, otherwise a random free cell (so a careful X can win). */
export function oMove(cells: TttState["cells"], seed: number): number {
  const free = cells.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
  for (const i of free) {
    const next = [...cells];
    next[i] = "O";
    if (winner(next)?.who === "O") return i;
  }
  return free[Math.floor(rng(seed + free.length)() * free.length)] ?? -1;
}

function tttApply(s: TttState, a: Action): [TttState, string] {
  if (a.type !== "click" && a.type !== "double_click") return [s, describe(a)];
  const { x, y } = a;
  if (inside(TTT.newGame, x, y)) return [{ ...s, cells: Array(9).fill(""), status: "playing", line: null, seed: s.seed + 7 }, "New game"];
  const b = TTT.board;
  const col = Math.floor((x - b.x) / (b.size / 3));
  const row = Math.floor((y - b.y) / (b.size / 3));
  if (col < 0 || col > 2 || row < 0 || row > 2) return [s, `Clicked (${x}, ${y}): outside the board`];
  const i = row * 3 + col;
  if (s.status !== "playing") return [s, "The game is over; click New game"];
  if (s.cells[i]) return [s, `That square is taken by ${s.cells[i]}`];
  const cells = [...s.cells];
  cells[i] = "X";
  let w = winner(cells);
  if (w) return [{ ...s, cells, status: "x-won", line: w.line }, `X in row ${row + 1}, column ${col + 1}: X wins`];
  if (cells.every(Boolean)) return [{ ...s, cells, status: "draw" }, `X in row ${row + 1}, column ${col + 1}: draw`];
  const o = oMove(cells, s.seed);
  cells[o] = "O";
  w = winner(cells);
  const where = `X in row ${row + 1}, column ${col + 1}; O answered in row ${Math.floor(o / 3) + 1}, column ${(o % 3) + 1}`;
  if (w) return [{ ...s, cells, status: "o-won", line: w.line }, `${where}: O wins`];
  if (cells.every(Boolean)) return [{ ...s, cells, status: "draw" }, `${where}: draw`];
  return [{ ...s, cells }, where];
}

// ---------------------------------------------------------------------------------------------------------------
// Mines on a desktop

export const MINES = {
  rows: 8,
  cols: 8,
  count: 10,
  cell: 48,
  win: { x: 420, y: 96, w: 440, h: 560 },
  board: { x: 448, y: 214 },
  newGame: { x: 740, y: 152, w: 92, h: 32 },
  icons: [
    { id: "terminal", label: "Terminal", x: 40, y: 40 },
    { id: "files", label: "Files", x: 40, y: 150 },
    { id: "mines", label: "Mines", x: 40, y: 260 },
    { id: "editor", label: "Text Editor", x: 40, y: 370 },
  ],
  close: { x: 828, y: 102, w: 24, h: 22 },
};

export interface MinesState {
  kind: "mines";
  open: boolean;
  selected: string | null;
  mines: boolean[];
  revealed: boolean[];
  flagged: boolean[];
  placed: boolean;
  status: "ready" | "playing" | "won" | "lost";
  exploded: number | null;
  seed: number;
  clicks: number;
}

const N = MINES.rows * MINES.cols;

function minesInitial(seed: number): MinesState {
  return { kind: "mines", open: false, selected: null, mines: Array(N).fill(false), revealed: Array(N).fill(false), flagged: Array(N).fill(false), placed: false, status: "ready", exploded: null, seed, clicks: 0 };
}

export function neighbors(i: number): number[] {
  const r = Math.floor(i / MINES.cols);
  const c = i % MINES.cols;
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr;
      const cc = c + dc;
      if (rr >= 0 && rr < MINES.rows && cc >= 0 && cc < MINES.cols) out.push(rr * MINES.cols + cc);
    }
  }
  return out;
}

export function adjacent(s: MinesState, i: number): number {
  return neighbors(i).filter((n) => s.mines[n]).length;
}

/** Mines go down on the first reveal, never on that square or its neighbors, so the first click opens a region. */
export function placeMines(seed: number, safe: number): boolean[] {
  const banned = new Set([safe, ...neighbors(safe)]);
  const mines = Array(N).fill(false);
  const r = rng(seed);
  let placed = 0;
  while (placed < MINES.count) {
    const i = Math.floor(r() * N);
    if (mines[i] || banned.has(i)) continue;
    mines[i] = true;
    placed++;
  }
  return mines;
}

function flood(s: MinesState, start: number): boolean[] {
  const revealed = [...s.revealed];
  const stack = [start];
  while (stack.length) {
    const i = stack.pop()!;
    if (revealed[i] || s.flagged[i]) continue;
    revealed[i] = true;
    if (adjacent(s, i) === 0) for (const n of neighbors(i)) if (!revealed[n] && !s.mines[n]) stack.push(n);
  }
  return revealed;
}

export function cellAt(x: number, y: number): number | null {
  const c = Math.floor((x - MINES.board.x) / MINES.cell);
  const r = Math.floor((y - MINES.board.y) / MINES.cell);
  if (c < 0 || c >= MINES.cols || r < 0 || r >= MINES.rows) return null;
  return r * MINES.cols + c;
}

function minesApply(s: MinesState, a: Action): [MinesState, string] {
  if (a.type !== "click" && a.type !== "double_click") return [s, describe(a)];
  const { x, y } = a;
  const right = a.type === "click" && a.button === "right";
  if (!s.open) {
    const icon = MINES.icons.find((ic) => x >= ic.x && x <= ic.x + 80 && y >= ic.y && y <= ic.y + 96);
    const launcher = y >= SCREEN_H - 36 ? LAUNCHERS.find((l) => x >= l.x && x <= l.x + l.w) : null;
    if (launcher) return launcher.id === "mines" ? [{ ...s, open: true }, "Opened Mines from the panel"] : [s, `${launcher.label} opened and closed (not part of this demo)`];
    if (!icon) return [{ ...s, selected: null }, `Clicked the desktop at (${x}, ${y})`];
    if (a.type === "double_click" || s.selected === icon.id) {
      return icon.id === "mines" ? [{ ...s, open: true, selected: null }, "Opened Mines"] : [{ ...s, selected: icon.id }, `${icon.label} isn't part of this demo`];
    }
    return [{ ...s, selected: icon.id }, `Selected the ${icon.label} icon (open it with a double click, or click it again)`];
  }
  if (inside(MINES.close, x, y)) return [{ ...s, open: false }, "Closed Mines"];
  if (inside(MINES.newGame, x, y) || (s.status === "won" || s.status === "lost") && inside(DIALOG_BUTTON, x, y)) {
    return [{ ...minesInitial(s.seed + 1), open: true }, "New game"];
  }
  if (s.status === "won" || s.status === "lost") return [s, "The game is over; click New game"];
  const i = cellAt(x, y);
  if (i === null) return [s, `Clicked (${x}, ${y}) in the window, off the board`];
  const rc = `row ${Math.floor(i / MINES.cols) + 1}, column ${(i % MINES.cols) + 1}`;
  if (right) {
    if (s.revealed[i]) return [s, `Right-clicked ${rc}: already open`];
    const flagged = [...s.flagged];
    flagged[i] = !flagged[i];
    return [{ ...s, flagged, clicks: s.clicks + 1 }, `${flagged[i] ? "Flagged" : "Unflagged"} ${rc}`];
  }
  if (s.flagged[i]) return [s, `${rc} is flagged; right-click to remove the flag first`];
  if (s.revealed[i]) return [s, `${rc} is already open`];
  let st: MinesState = s.placed ? s : { ...s, mines: placeMines(s.seed, i), placed: true, status: "playing" };
  if (st.mines[i]) return [{ ...st, status: "lost", exploded: i, clicks: st.clicks + 1 }, `Revealed ${rc}: a mine. Game over`];
  st = { ...st, revealed: flood(st, i), clicks: st.clicks + 1 };
  const opened = st.revealed.filter(Boolean).length;
  if (opened === N - MINES.count) return [{ ...st, status: "won" }, `Revealed ${rc}: every safe square is open. You won`];
  return [st, `Revealed ${rc}${adjacent(st, i) ? ` (${adjacent(st, i)})` : ", opening a region"}`];
}

const DIALOG_BUTTON = { x: 570, y: 430, w: 140, h: 40 };
const LAUNCHERS = [
  { id: "menu", label: "Applications", x: 8, w: 120 },
  { id: "terminal", label: "Terminal", x: 140, w: 100 },
  { id: "files", label: "Files", x: 248, w: 80 },
  { id: "mines", label: "Mines", x: 336, w: 80 },
];

/** The shell behind cua_run_command lives in lib/mines-shell.ts (it splits compound command lines). */

// ---------------------------------------------------------------------------------------------------------------
// Shared

export type SimState = SignupState | TttState | MinesState;

export function initialState(scene: SceneId, seed = 1): SimState {
  if (scene === "signup") return signupInitial();
  if (scene === "tictactoe") return { kind: "tictactoe", cells: Array(9).fill(""), status: "playing", seed, line: null };
  return minesInitial(seed);
}

/** A short description of an action, for logs. */
export function describe(a: Action): string {
  switch (a.type) {
    case "click":
      return `${a.button && a.button !== "left" ? `${a.button}-click` : "click"} at (${a.x}, ${a.y})`;
    case "double_click":
      return `double-click at (${a.x}, ${a.y})`;
    case "drag":
      return `drag through ${a.path.length} points`;
    case "keypress":
      return `press ${a.keys.join("+")}`;
    case "move":
      return `move to (${a.x}, ${a.y})`;
    case "scroll":
      return `scroll ${a.scroll_y ?? 0} at (${a.x}, ${a.y})`;
    case "type":
      return `type "${a.text}"`;
    case "screenshot":
      return "screenshot";
    case "wait":
      return "wait";
  }
}

/** Applies one action and says what happened on screen. */
export function applyAction(s: SimState, a: Action): [SimState, string] {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  const fixed: Action =
    a.type === "click" || a.type === "double_click" || a.type === "move" || a.type === "scroll"
      ? ({ ...a, x: clamp(a.x, SCREEN_W - 1), y: clamp(a.y, SCREEN_H - 1) } as Action)
      : a;
  if (fixed.type === "screenshot" || fixed.type === "wait" || fixed.type === "move" || fixed.type === "scroll" || fixed.type === "drag") {
    return [s, fixed.type === "scroll" ? `${describe(fixed)}: nothing scrolls on this screen` : describe(fixed)];
  }
  if (s.kind === "signup") return signupApply(s, fixed);
  if (s.kind === "tictactoe") return tttApply(s, fixed);
  return minesApply(s, fixed);
}

/** Whether the scene's goal is visibly done, for the run summary. */
export function sceneDone(s: SimState): string | null {
  if (s.kind === "signup") return s.screen === "created" ? "The account was created." : null;
  if (s.kind === "tictactoe") return s.status === "playing" ? null : s.status === "x-won" ? "X (the model) won." : s.status === "o-won" ? "O won." : "The game is a draw.";
  return s.status === "won" ? "The board is cleared: the model won." : s.status === "lost" ? "The model hit a mine." : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Drawing

type Ctx = CanvasRenderingContext2D;
const FONT = "Helvetica, Arial, sans-serif";

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function text(ctx: Ctx, t: string, x: number, y: number, size: number, color: string, weight = 400, align: CanvasTextAlign = "left") {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(t, x, y);
}

function drawSignup(ctx: Ctx, s: SignupState, bg: CanvasImageSource | null) {
  if (bg) ctx.drawImage(bg, 0, 0, SCREEN_W, SCREEN_H);
  else {
    ctx.fillStyle = "#f3f5f8";
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  }
  if (s.screen === "cancelled" || s.screen === "signin") {
    ctx.fillStyle = "#f3f5f8";
    ctx.fillRect(520, 0, SCREEN_W - 520, SCREEN_H);
    roundRect(ctx, 690, 250, 420, 220, 16);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    text(ctx, s.screen === "signin" ? "Sign in to Sprout" : "Sign-up cancelled", 900, 330, 26, "#16181d", 700, "center");
    text(ctx, s.screen === "signin" ? "This demo stops here. Click to go back." : "Click anywhere to start again.", 900, 372, 16, "#5b6170", 400, "center");
    return;
  }
  if (s.screen === "created") {
    roundRect(ctx, 690, 114, 420, 572, 16);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(900, 250, 44, 0, Math.PI * 2);
    ctx.fillStyle = "#1c6b4e";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(880, 252);
    ctx.lineTo(895, 267);
    ctx.lineTo(922, 236);
    ctx.stroke();
    text(ctx, "Account created", 900, 350, 30, "#16181d", 700, "center");
    text(ctx, `Welcome to Sprout, ${s.values.name.trim() || "friend"}.`, 900, 392, 18, "#3d4350", 400, "center");
    text(ctx, `We sent a confirmation link to ${s.values.email.trim()}.`, 900, 422, 15, "#5b6170", 400, "center");
    roundRect(ctx, 726, 520, 348, 46, 23);
    ctx.fillStyle = "#1c6b4e";
    ctx.fill();
    text(ctx, "Continue", 900, 549, 17, "#ffffff", 700, "center");
    // The left panel's own green (sampled from the screenshot), so the step counter repaints seamlessly.
    ctx.fillStyle = "rgb(29, 79, 60)";
    ctx.fillRect(56, 712, 220, 26);
    text(ctx, "Step 2 of 3", 56, 733, 16, "#cfe3d8");
    return;
  }
  for (const f of FIELDS) {
    const r = SIGNUP_RECTS[f];
    if (s.values[f] || s.focus === f) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6);
      const shown = f === "password" ? "•".repeat(s.values[f].length) : s.values[f];
      if (s.selectAll && s.focus === f && shown) {
        ctx.font = `400 16px ${FONT}`;
        ctx.fillStyle = "#b9d4ff";
        ctx.fillRect(r.x + 14, r.y + 11, ctx.measureText(shown).width, 22);
      }
      text(ctx, shown, r.x + 15, r.y + 28, 16, "#16181d");
      if (s.focus === f) {
        ctx.font = `400 16px ${FONT}`;
        const w = ctx.measureText(shown).width;
        ctx.fillStyle = "#16181d";
        ctx.fillRect(r.x + 16 + w, r.y + 12, 1.5, 20);
      }
    }
    if (s.focus === f) {
      roundRect(ctx, r.x, r.y, r.w, r.h, 10);
      ctx.strokeStyle = "#1c6b4e";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  if (s.agreed) {
    roundRect(ctx, 726, 477, 18, 18, 4);
    ctx.fillStyle = "#1c6b4e";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(730, 486);
    ctx.lineTo(734, 490);
    ctx.lineTo(741, 481);
    ctx.stroke();
  }
  if (s.error) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(724, 184, 380, 26);
    text(ctx, s.error, 726, 202, 14, "#b42318", 600);
  }
}

function drawTtt(ctx: Ctx, s: TttState) {
  const g = ctx.createLinearGradient(0, 0, SCREEN_W, SCREEN_H);
  g.addColorStop(0, "#3b4f8a");
  g.addColorStop(1, "#8a5a9e");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  ctx.fillStyle = "rgba(245,245,247,0.92)";
  ctx.fillRect(0, 0, SCREEN_W, 28);
  text(ctx, "●  Tic Tac Toe     File     Edit     Window     Help", 18, 19, 14, "#1d1d1f", 600);
  text(ctx, "Fri Oct 30  10:24", SCREEN_W - 18, 19, 14, "#1d1d1f", 500, "right");
  const w = TTT.win;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 30;
  roundRect(ctx, w.x, w.y, w.w, w.h, 12);
  ctx.fillStyle = "#f6f6f8";
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#e7e7ea";
  ctx.fillRect(w.x, w.y + 10, w.w, 26);
  roundRect(ctx, w.x, w.y, w.w, 36, 12);
  ctx.fill();
  ["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(w.x + 20 + i * 20, w.y + 18, 6, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
  });
  text(ctx, "Tic Tac Toe", w.x + w.w / 2, w.y + 23, 14, "#4a4a4f", 600, "center");
  const status = s.status === "playing" ? "Your turn: you are X" : s.status === "x-won" ? "X wins!" : s.status === "o-won" ? "O wins" : "Draw";
  text(ctx, status, w.x + w.w / 2, 192, 22, s.status === "x-won" ? "#1c7a3f" : "#1d1d1f", 700, "center");
  const b = TTT.board;
  const cs = b.size / 3;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(b.x, b.y, b.size, b.size);
  ctx.strokeStyle = "#2b2b30";
  ctx.lineWidth = 4;
  for (let k = 1; k < 3; k++) {
    ctx.beginPath();
    ctx.moveTo(b.x + k * cs, b.y + 10);
    ctx.lineTo(b.x + k * cs, b.y + b.size - 10);
    ctx.moveTo(b.x + 10, b.y + k * cs);
    ctx.lineTo(b.x + b.size - 10, b.y + k * cs);
    ctx.stroke();
  }
  s.cells.forEach((c, i) => {
    const cx = b.x + (i % 3) * cs + cs / 2;
    const cy = b.y + Math.floor(i / 3) * cs + cs / 2;
    if (c === "X") {
      ctx.strokeStyle = "#2f6fe4";
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(cx - 32, cy - 32);
      ctx.lineTo(cx + 32, cy + 32);
      ctx.moveTo(cx + 32, cy - 32);
      ctx.lineTo(cx - 32, cy + 32);
      ctx.stroke();
    } else if (c === "O") {
      ctx.strokeStyle = "#e4572e";
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(cx, cy, 34, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
  if (s.line) {
    const p = (i: number) => [b.x + (i % 3) * cs + cs / 2, b.y + Math.floor(i / 3) * cs + cs / 2];
    const [x1, y1] = p(s.line[0]);
    const [x2, y2] = p(s.line[2]);
    ctx.strokeStyle = "rgba(28,122,63,0.85)";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  const n = TTT.newGame;
  roundRect(ctx, n.x, n.y, n.w, n.h, 8);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#c7c7cc";
  ctx.lineWidth = 1;
  ctx.stroke();
  text(ctx, "New game", n.x + n.w / 2, n.y + 26, 15, "#1d1d1f", 600, "center");
}

const NUM_COLORS = ["", "#1565c0", "#2e7d32", "#c62828", "#6a1b9a", "#ef6c00", "#00838f", "#424242", "#757575"];

function drawMines(ctx: Ctx, s: MinesState) {
  const g = ctx.createLinearGradient(0, 0, 0, SCREEN_H);
  g.addColorStop(0, "#2d5a88");
  g.addColorStop(1, "#1c3a5c");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  for (const ic of MINES.icons) {
    if (s.selected === ic.id) {
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.fillRect(ic.x - 8, ic.y - 6, 96, 104);
    }
    roundRect(ctx, ic.x + 8, ic.y, 64, 64, 12);
    ctx.fillStyle = ic.id === "terminal" ? "#2b2b2b" : ic.id === "files" ? "#e8b84a" : ic.id === "mines" ? "#d9d9d9" : "#f4f4f4";
    ctx.fill();
    if (ic.id === "terminal") text(ctx, ">_", ic.x + 40, ic.y + 42, 24, "#7CFC7C", 700, "center");
    if (ic.id === "mines") {
      ctx.beginPath();
      ctx.arc(ic.x + 40, ic.y + 32, 16, 0, Math.PI * 2);
      ctx.fillStyle = "#1a1a1a";
      ctx.fill();
      ctx.fillStyle = "#c62828";
      ctx.fillRect(ic.x + 48, ic.y + 10, 3, 18);
    }
    if (ic.id === "editor") text(ctx, "Aa", ic.x + 40, ic.y + 42, 22, "#555", 700, "center");
    text(ctx, ic.label, ic.x + 40, ic.y + 84, 14, "#ffffff", 600, "center");
  }
  ctx.fillStyle = "#1b1b1f";
  ctx.fillRect(0, SCREEN_H - 36, SCREEN_W, 36);
  for (const l of LAUNCHERS) {
    roundRect(ctx, l.x, SCREEN_H - 31, l.w, 26, 6);
    ctx.fillStyle = l.id === "mines" && s.open ? "#3d5a80" : "#2c2c33";
    ctx.fill();
    text(ctx, l.label, l.x + l.w / 2, SCREEN_H - 13, 13, "#e8e8ee", 600, "center");
  }
  text(ctx, "10:24", SCREEN_W - 14, SCREEN_H - 13, 13, "#e8e8ee", 600, "right");
  if (!s.open) return;
  const w = MINES.win;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 24;
  ctx.fillStyle = "#efefef";
  ctx.fillRect(w.x, w.y, w.w, w.h);
  ctx.restore();
  ctx.fillStyle = "#3c3c44";
  ctx.fillRect(w.x, w.y, w.w, 32);
  text(ctx, "Mines", w.x + w.w / 2, w.y + 21, 14, "#ffffff", 700, "center");
  text(ctx, "✕", MINES.close.x + 12, MINES.close.y + 17, 15, "#ffffff", 700, "center");
  const flags = s.flagged.filter(Boolean).length;
  text(ctx, `Flags ${flags}/${MINES.count}`, MINES.board.x, 176, 18, "#2b2b30", 700);
  const n = MINES.newGame;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(n.x, n.y, n.w, n.h);
  ctx.strokeStyle = "#a0a0a8";
  ctx.lineWidth = 1;
  ctx.strokeRect(n.x + 0.5, n.y + 0.5, n.w - 1, n.h - 1);
  text(ctx, "New game", n.x + n.w / 2, n.y + 21, 14, "#2b2b30", 600, "center");
  const size = MINES.cell;
  for (let i = 0; i < N; i++) {
    const x = MINES.board.x + (i % MINES.cols) * size;
    const y = MINES.board.y + Math.floor(i / MINES.cols) * size;
    const showMine = s.status === "lost" && s.mines[i];
    if (s.revealed[i] || showMine) {
      ctx.fillStyle = s.exploded === i ? "#ef5350" : "#e3e3e3";
      ctx.fillRect(x, y, size, size);
      ctx.strokeStyle = "#bdbdbd";
      ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
      if (showMine) {
        ctx.beginPath();
        ctx.arc(x + size / 2, y + size / 2, 12, 0, Math.PI * 2);
        ctx.fillStyle = "#111";
        ctx.fill();
      } else {
        const k = adjacent(s, i);
        if (k) text(ctx, String(k), x + size / 2, y + 33, 26, NUM_COLORS[k], 800, "center");
      }
    } else {
      ctx.fillStyle = "#b8bcc6";
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = "#d6d9e0";
      ctx.fillRect(x + 2, y + 2, size - 6, size - 6);
      ctx.strokeStyle = "#8e929c";
      ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
      if (s.flagged[i]) {
        ctx.fillStyle = "#333";
        ctx.fillRect(x + 22, y + 12, 3, 26);
        ctx.fillStyle = "#d32f2f";
        ctx.beginPath();
        ctx.moveTo(x + 25, y + 12);
        ctx.lineTo(x + 37, y + 18);
        ctx.lineTo(x + 25, y + 24);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
  if (s.status === "won" || s.status === "lost") {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(w.x, w.y + 32, w.w, w.h - 32);
    roundRect(ctx, 500, 330, 280, 160, 12);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    text(ctx, s.status === "won" ? "Congratulations!" : "You lost", 640, 380, 24, s.status === "won" ? "#1c7a3f" : "#b42318", 800, "center");
    text(ctx, s.status === "won" ? "You cleared the board." : "You stepped on a mine.", 640, 410, 15, "#3d4350", 400, "center");
    roundRect(ctx, DIALOG_BUTTON.x, DIALOG_BUTTON.y, DIALOG_BUTTON.w, DIALOG_BUTTON.h, 8);
    ctx.fillStyle = "#3d5a80";
    ctx.fill();
    text(ctx, "Play again", DIALOG_BUTTON.x + DIALOG_BUTTON.w / 2, DIALOG_BUTTON.y + 26, 15, "#ffffff", 700, "center");
  }
}

/** Draws the state at 1280 x 800. The sign-up scene draws over the sample screenshot when it's given. */
export function render(ctx: Ctx, s: SimState, signupBackground: CanvasImageSource | null): void {
  ctx.save();
  ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
  if (s.kind === "signup") drawSignup(ctx, s, signupBackground);
  else if (s.kind === "tictactoe") drawTtt(ctx, s);
  else drawMines(ctx, s);
  ctx.restore();
}
