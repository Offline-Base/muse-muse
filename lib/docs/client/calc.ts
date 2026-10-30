/**
 * A small arithmetic evaluator for the tool-calling demo's calculator tool. The expression comes from the model, so
 * it is parsed by hand (a recursive descent over numbers, operators, parentheses and a short list of functions) and
 * never handed to eval or Function. Anything else is a CalcError with a message the model can read and fix.
 *
 *   expr   := term (("+" | "-") term)*
 *   term   := unary (("*" | "/" | "%") unary)*
 *   unary  := ("+" | "-") unary | power
 *   power  := postfix (("^" | "**") unary)?      right-associative, and binds tighter than a leading minus
 *   postfix:= primary "%"?                        a trailing % means "percent": 15% is 0.15
 *   primary:= number | constant | name "(" expr ("," expr)* ")" | "(" expr ")"
 */

export class CalcError extends Error {}

const MAX_LENGTH = 300;
const MAX_DEPTH = 60;

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

const FUNCTIONS: Record<string, { min: number; max: number; fn: (...a: number[]) => number }> = {
  sqrt: { min: 1, max: 1, fn: Math.sqrt },
  cbrt: { min: 1, max: 1, fn: Math.cbrt },
  abs: { min: 1, max: 1, fn: Math.abs },
  round: { min: 1, max: 2, fn: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d },
  floor: { min: 1, max: 1, fn: Math.floor },
  ceil: { min: 1, max: 1, fn: Math.ceil },
  min: { min: 1, max: 50, fn: Math.min },
  max: { min: 1, max: 50, fn: Math.max },
  pow: { min: 2, max: 2, fn: Math.pow },
  log: { min: 1, max: 1, fn: Math.log10 },
  log10: { min: 1, max: 1, fn: Math.log10 },
  log2: { min: 1, max: 1, fn: Math.log2 },
  ln: { min: 1, max: 1, fn: Math.log },
  exp: { min: 1, max: 1, fn: Math.exp },
  sin: { min: 1, max: 1, fn: Math.sin },
  cos: { min: 1, max: 1, fn: Math.cos },
  tan: { min: 1, max: 1, fn: Math.tan },
};

type Token = { kind: "num"; value: number; at: number } | { kind: "name"; value: string; at: number } | { kind: "op"; value: string; at: number };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (number) {
      tokens.push({ kind: "num", value: Number(number[0]), at: i });
      i += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (name) {
      tokens.push({ kind: "name", value: name[0].toLowerCase(), at: i });
      i += name[0].length;
      continue;
    }
    if (src.startsWith("**", i)) {
      tokens.push({ kind: "op", value: "^", at: i });
      i += 2;
      continue;
    }
    // The multiplication and division signs people (and models) type, besides * and /.
    const op = ch === "×" || ch === "·" ? "*" : ch === "÷" ? "/" : ch === "−" ? "-" : ch;
    if ("+-*/%^(),".includes(op)) {
      tokens.push({ kind: "op", value: op, at: i });
      i++;
      continue;
    }
    throw new CalcError(`Unexpected "${ch}" at position ${i + 1}. Use numbers, + - * / % ^, parentheses and functions like sqrt().`);
  }
  return tokens;
}

/** Evaluates an arithmetic expression such as "(3 + 4) * 2 ^ 3" or "sqrt(2) * 15%". */
export function evaluate(expression: string): number {
  const src = String(expression ?? "").trim();
  if (!src) throw new CalcError("The expression is empty.");
  if (src.length > MAX_LENGTH) throw new CalcError(`The expression is longer than ${MAX_LENGTH} characters.`);
  const tokens = tokenize(src);
  let pos = 0;
  let depth = 0;

  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.kind === "op" && peek()!.value === v;
  const expectOp = (v: string) => {
    if (!isOp(v)) {
      const t = peek();
      throw new CalcError(t ? `Expected "${v}" at position ${t.at + 1}.` : `Expected "${v}" at the end.`);
    }
    pos++;
  };
  const nest = <T>(f: () => T): T => {
    if (++depth > MAX_DEPTH) throw new CalcError("The expression is nested too deeply.");
    try {
      return f();
    } finally {
      depth--;
    }
  };

  const expr = (): number =>
    nest(() => {
      let v = term();
      while (isOp("+") || isOp("-")) {
        const op = tokens[pos++].value;
        const r = term();
        v = op === "+" ? v + r : v - r;
      }
      return v;
    });

  const term = (): number => {
    let v = unary();
    while (isOp("*") || isOp("/") || (isOp("%") && startsOperand(pos + 1))) {
      const op = tokens[pos++].value;
      const r = unary();
      if ((op === "/" || op === "%") && r === 0) throw new CalcError("Division by zero.");
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };

  /**
   * Whether the token at `i` starts an operand, which tells "10 % 3" (modulo) from "15%" and "15% + 2" (percent).
   * A sign doesn't count: "15% - 2" is far more often meant than "15 modulo -2".
   */
  const startsOperand = (i: number): boolean => {
    const t = tokens[i];
    if (!t) return false;
    return t.kind !== "op" || t.value === "(";
  };

  const unary = (): number =>
    nest(() => {
      if (isOp("-")) {
        pos++;
        return -unary();
      }
      if (isOp("+")) {
        pos++;
        return unary();
      }
      return power();
    });

  const power = (): number => {
    const base = postfix();
    if (isOp("^")) {
      pos++;
      return base ** unary();
    }
    return base;
  };

  const postfix = (): number => {
    const v = primary();
    if (isOp("%") && !startsOperand(pos + 1)) {
      pos++;
      return v / 100;
    }
    return v;
  };

  const primary = (): number => {
    const t = peek();
    if (!t) throw new CalcError("The expression ends too early.");
    if (t.kind === "num") {
      pos++;
      return t.value;
    }
    if (t.kind === "name") {
      pos++;
      const fn = FUNCTIONS[t.value];
      if (fn && isOp("(")) {
        pos++;
        const args = [expr()];
        while (isOp(",")) {
          pos++;
          args.push(expr());
        }
        expectOp(")");
        if (args.length < fn.min || args.length > fn.max) {
          throw new CalcError(`${t.value}() takes ${fn.min === fn.max ? fn.min : `${fn.min} to ${fn.max}`} argument${fn.max === 1 ? "" : "s"}.`);
        }
        return fn.fn(...args);
      }
      if (t.value in CONSTANTS) return CONSTANTS[t.value];
      throw new CalcError(`Unknown name "${t.value}". Known: ${[...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS)].join(", ")}.`);
    }
    if (t.value === "(") {
      pos++;
      const v = expr();
      expectOp(")");
      return v;
    }
    throw new CalcError(`Unexpected "${t.value}" at position ${t.at + 1}.`);
  };

  const value = expr();
  if (pos < tokens.length) throw new CalcError(`Unexpected "${tokens[pos].value}" at position ${tokens[pos].at + 1}.`);
  if (!Number.isFinite(value)) throw new CalcError("The result isn't a finite number.");
  return value;
}

/** The result rounded to 12 significant digits, so 0.1 + 0.2 reads 0.3. */
export function tidy(value: number): number {
  return Number(value.toPrecision(12));
}
