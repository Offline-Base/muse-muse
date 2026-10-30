/**
 * Model answers as light Markdown, so a demo can show "**2026 United States Grand Prix**", "* item" lists and
 * "$\sqrt{2} = \frac{p}{q}$" the way the reader would see them in a chat app instead of as raw marks. Pure: it turns
 * text into a small tree (lib/docs/markdown's parser is the server's, for Meta's pages); AnswerText.tsx renders the
 * tree as React text, so nothing in an answer is ever injected as HTML.
 *
 * What it reads: paragraphs (a single newline is a line break, as chat apps show it), ATX headings, bullet and
 * numbered lists with nesting, block quotes, fenced code, horizontal rules, GitHub tables, and inline code, bold,
 * italic, strikethrough, links (http, https and mailto only), bare URLs and TeX math between $...$, $$...$$, \(...\)
 * or \[...\], turned into plain Unicode where it can be ("√2 = p/q"). Anything it doesn't read stays as text.
 *
 * Private-use characters pass through untouched, so search grounding can mark citations inside the text before it is
 * parsed (CITE_OPEN, CITE_CLOSE and markerChar below) and draw them where they land.
 */

export type MdInline =
  | { t: "text"; v: string }
  | { t: "strong" | "em" | "del"; c: MdInline[] }
  | { t: "code"; v: string }
  | { t: "math"; v: string }
  | { t: "link"; href: string; c: MdInline[] }
  | { t: "br" };

export type MdBlock =
  | { t: "p"; c: MdInline[] }
  | { t: "h"; level: number; c: MdInline[] }
  | { t: "list"; ordered: boolean; start: number; items: MdBlock[][] }
  | { t: "code"; v: string }
  | { t: "math"; v: string }
  | { t: "quote"; c: MdBlock[] }
  | { t: "hr" }
  | { t: "table"; head: MdInline[][]; rows: MdInline[][][] };

/** Start and end of a cited stretch, and a citation marker's number, as characters the parser leaves alone. */
export const CITE_OPEN = "";
export const CITE_CLOSE = "";
export const MARKER_BASE = 0xe100;
export const MARKER_END = 0xf100;

export function markerChar(n: number): string {
  return String.fromCharCode(MARKER_BASE + Math.max(0, Math.min(MARKER_END - MARKER_BASE - 1, n)));
}

/** A private-use character this module's callers use as a mark. */
export function isMark(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return ch === CITE_OPEN || ch === CITE_CLOSE || (code >= MARKER_BASE && code < MARKER_END);
}

// ---------- Blocks ----------

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/;

function isBlank(line: string): boolean {
  return !line.replace(/[-]/g, "").trim();
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/** Removes up to `n` columns of leading whitespace. */
function dedent(line: string, n: number): string {
  let i = 0;
  let cols = 0;
  while (i < line.length && cols < n && (line[i] === " " || line[i] === "\t")) {
    cols += line[i] === "\t" ? 4 : 1;
    i++;
  }
  return line.slice(i);
}

/**
 * Marks that open a line ("- item") would hide its syntax, so they are lifted off for the block checks and put
 * back at the start of the block's content.
 */
function liftLead(line: string): { lead: string; line: string } {
  let lead = "";
  let rest = "";
  let i = 0;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (isMark(ch)) lead += ch;
    else if (ch === " " || ch === "\t") rest += ch;
    else break;
  }
  return lead ? { lead, line: rest + line.slice(i) } : { lead: "", line };
}

function startsBlock(line: string): boolean {
  const l = liftLead(line).line;
  return FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || ITEM.test(l) || /^ {0,3}(\$\$|\\\[)/.test(l);
}

function cells(row: string): string[] {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < r.length; i++) {
    const ch = r[i];
    if (ch === "\\" && r[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      code = !code;
      cur += ch;
    } else if (ch === "|" && !code) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Parses Markdown text into blocks. */
export function parseMarkdown(text: string): MdBlock[] {
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (isBlank(raw)) {
      // A blank line can still carry a mark (a citation closing there): keep it with the text after.
      const marks = [...raw].filter(isMark).join("");
      if (marks && i + 1 < lines.length) lines[i + 1] = marks + lines[i + 1];
      else if (marks) blocks.push({ t: "p", c: [{ t: "text", v: marks }] });
      i++;
      continue;
    }
    const { lead, line } = liftLead(raw);

    const fence = FENCE.exec(line);
    if (fence) {
      const close = fence[1][0].repeat(fence[1].length);
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(close)) body.push(lines[i++]);
      i++;
      blocks.push({ t: "code", v: lead + body.join("\n") });
      continue;
    }

    const math = /^ {0,3}(\$\$|\\\[)(.*)$/.exec(line);
    if (math) {
      const closer = math[1] === "$$" ? "$$" : "\\]";
      const first = math[2];
      const end = first.indexOf(closer);
      if (end >= 0) {
        blocks.push({ t: "math", v: lead + texToText(first.slice(0, end)).trim() });
        const after = first.slice(end + closer.length).trim();
        if (after) lines[i] = after;
        else i++;
        continue;
      }
      const body = [first];
      i++;
      while (i < lines.length && !lines[i].includes(closer)) body.push(lines[i++]);
      if (i < lines.length) body.push(lines[i].slice(0, lines[i].indexOf(closer)));
      i++;
      blocks.push({ t: "math", v: lead + texToText(body.join(" ")).trim() });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: "h", level: heading[1].length, c: parseInlines(lead + heading[2]) });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ t: "hr" });
      if (lead) blocks.push({ t: "p", c: [{ t: "text", v: lead }] });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i]) && (QUOTE.test(liftLead(lines[i]).line) || body.length)) {
        const l = liftLead(lines[i]);
        if (!QUOTE.test(l.line) && startsBlock(lines[i])) break;
        body.push(l.lead + l.line.replace(QUOTE, ""));
        i++;
      }
      body[0] = lead + body[0];
      blocks.push({ t: "quote", c: parseBlocks(body) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(lead + line).map(parseInlines);
      const rows: MdInline[][][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) rows.push(cells(lines[i++]).map(parseInlines));
      blocks.push({ t: "table", head, rows });
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      const parsed = parseList(lines, i, lead);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    // A paragraph: lines up to a blank one or the start of another block.
    const body = [lead + line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i]) && !(lines[i].includes("|") && TABLE_RULE.test(lines[i + 1] ?? ""))) {
      body.push(lines[i++].trim());
    }
    blocks.push({ t: "p", c: parseInlines(body.join("\n")) });
  }
  return blocks;
}

function parseList(lines: string[], from: number, firstLead: string): { block: MdBlock; next: number } {
  const first = ITEM.exec(liftLead(lines[from]).line)!;
  const base = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const start = ordered ? Number.parseInt(first[2], 10) : 1;
  const items: MdBlock[][] = [];
  let i = from;
  let lead = firstLead;
  while (i < lines.length) {
    const lifted = liftLead(lines[i]);
    const m = ITEM.exec(lifted.line);
    if (!m || indentOf(m[1]) !== base || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = base + m[2].length + 1;
    const content = [(i === from ? lead : lifted.lead) + m[3]];
    lead = "";
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (isBlank(l)) {
        // A blank line inside an item continues it only when an indented line follows.
        if (j + 1 < lines.length && !isBlank(lines[j + 1]) && indentOf(liftLead(lines[j + 1]).line) > base) {
          content.push("");
          j++;
          continue;
        }
        break;
      }
      const ll = liftLead(l);
      const sub = ITEM.exec(ll.line);
      if (sub && indentOf(sub[1]) <= base) break;
      if (indentOf(ll.line) > base) {
        content.push(ll.lead + dedent(ll.line, contentIndent));
        j++;
        continue;
      }
      if (startsBlock(l)) break;
      content.push(l.trim());
      j++;
    }
    items.push(parseBlocks(content));
    i = j;
    // Blank lines between items keep the list going.
    let k = i;
    while (k < lines.length && isBlank(lines[k])) k++;
    const next = k < lines.length ? ITEM.exec(liftLead(lines[k]).line) : null;
    if (next && indentOf(next[1]) === base && /\d/.test(next[2]) === ordered) {
      i = k;
      continue;
    }
    break;
  }
  return { block: { t: "list", ordered, start, items }, next: i };
}

// ---------- Inlines ----------

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
const PUNCT = /[!-/:-@[-`{-~]/;

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

const TICKS = /`+/y;
const LINK = /\[((?:[^\]\\]|\\.)+)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/y;
const BARE_URL = /https?:\/\/[^\s<>"'`]+/iy;

/** A sticky match at `i` (the regexes above carry the y flag), without slicing the text. */
function matchAt(re: RegExp, text: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(text);
}

/** Where the delimiter that closes an emphasis opened at `from` is, or -1. Code spans are skipped. */
function findCloser(text: string, from: number, delim: string): number {
  for (let j = from; j < text.length; j++) {
    const ch = text[j];
    if (ch === "`") {
      const run = matchAt(TICKS, text, j)![0];
      const end = text.indexOf(run, j + run.length);
      if (end > 0) j = end + run.length - 1;
      continue;
    }
    if (ch === "\\") {
      j++;
      continue;
    }
    if (!text.startsWith(delim, j)) continue;
    // A single * or _ must not be half of a ** or __ (that one closes a strong, not this).
    if (delim.length === 1 && (text[j + 1] === delim || text[j - 1] === delim)) {
      if (text[j + 1] === delim) j++;
      continue;
    }
    if (isSpace(text[j - 1])) continue;
    if (delim[0] === "_" && isAlnum(text[j + delim.length])) continue;
    return j;
  }
  return -1;
}


function stripMarks(text: string): string {
  return [...text].filter((c) => !isMark(c)).join("");
}

export function parseInlines(text: string): MdInline[] {
  const out: MdInline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }

    // \( ... \) and \[ ... \] before backslash escapes.
    if (ch === "\\" && (text[i + 1] === "(" || text[i + 1] === "[")) {
      const closer = text[i + 1] === "(" ? "\\)" : "\\]";
      const end = text.indexOf(closer, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "math", v: texToText(text.slice(i + 2, end)).replace(/\s*\n\s*/g, " ").trim() });
        i = end + 2;
        continue;
      }
    }

    if (ch === "\\" && i + 1 < text.length && PUNCT.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      const run = matchAt(TICKS, text, i)![0];
      const end = text.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        const code = text.slice(i + run.length, end);
        out.push({ t: "code", v: code.length > 2 && code.startsWith(" ") && code.endsWith(" ") ? code.slice(1, -1) : code });
        i = end + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }

    // Pandoc's rule for $...$: the opening $ has a non-space after it, the closing one a non-space before it and no
    // digit after it, so prices ("$25 and $30", "$5-$10") stay text.
    if (ch === "$") {
      const display = text[i + 1] === "$";
      const open = display ? 2 : 1;
      const closer = display ? "$$" : "$";
      if (!isSpace(text[i + open])) {
        let end = text.indexOf(closer, i + open);
        while (!display && end > 0 && (isSpace(text[end - 1]) || /\d/.test(text[end + 1] ?? ""))) end = text.indexOf("$", end + 1);
        const tex = end > 0 ? text.slice(i + open, end) : "";
        if (end > 0 && tex.trim() && !tex.includes("\n\n")) {
          flush();
          out.push({ t: "math", v: texToText(tex).replace(/\s*\n\s*/g, " ").trim() });
          i = end + closer.length;
          continue;
        }
      }
      buf += ch;
      i++;
      continue;
    }

    const strong = text.startsWith("**", i) ? "**" : text.startsWith("__", i) ? "__" : text.startsWith("~~", i) ? "~~" : null;
    if (strong && !isSpace(text[i + 2]) && !(strong === "__" && isAlnum(text[i - 1]))) {
      const end = findCloser(text, i + 2, strong);
      if (end > i + 2) {
        flush();
        out.push({ t: strong === "~~" ? "del" : "strong", c: parseInlines(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    if ((ch === "*" || ch === "_") && text[i + 1] !== ch && !isSpace(text[i + 1]) && !(ch === "_" && isAlnum(text[i - 1]))) {
      const end = findCloser(text, i + 1, ch);
      if (end > i + 1) {
        flush();
        out.push({ t: "em", c: parseInlines(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    if (ch === "[") {
      const link = matchAt(LINK, text, i);
      if (link) {
        flush();
        const marks = [...link[2]].filter(isMark).join("");
        const href = stripMarks(link[2]);
        const label = parseInlines(link[1]);
        if (SAFE_HREF.test(href)) out.push({ t: "link", href, c: label });
        else out.push(...label);
        if (marks) out.push({ t: "text", v: marks });
        i += link[0].length;
        continue;
      }
    }

    if ((ch === "h" || ch === "H") && !isAlnum(text[i - 1])) {
      const url = matchAt(BARE_URL, text, i);
      if (url) {
        // Trailing marks and punctuation, and an unmatched closing parenthesis, belong to the sentence.
        let u = url[0].replace(/[-]+$/, "");
        while (/[.,;:!?'")\]]$/.test(u) && !(u.endsWith(")") && (u.match(/\(/g) ?? []).length >= (u.match(/\)/g) ?? []).length)) u = u.slice(0, -1);
        if (u.length > 8) {
          flush();
          out.push({ t: "link", href: stripMarks(u), c: [{ t: "text", v: u }] });
          i += u.length;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

// ---------- TeX to text ----------

const SYMBOLS: Readonly<Record<string, string>> = {
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆", circ: "∘", bullet: "•",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝",
  ll: "≪", gg: "≫", lt: "<", gt: ">",
  infty: "∞", partial: "∂", nabla: "∇", sum: "∑", prod: "∏", int: "∫", oint: "∮",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
  phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇", cup: "∪", cap: "∩", setminus: "∖",
  emptyset: "∅", varnothing: "∅", forall: "∀", exists: "∃", nexists: "∄", neg: "¬", lnot: "¬", land: "∧", wedge: "∧", lor: "∨", vee: "∨",
  to: "→", rightarrow: "→", leftarrow: "←", gets: "←", Rightarrow: "⇒", Leftarrow: "⇐", implies: "⟹", impliedby: "⟸",
  iff: "⟺", Leftrightarrow: "⇔", leftrightarrow: "↔", mapsto: "↦", uparrow: "↑", downarrow: "↓",
  ldots: "…", cdots: "⋯", dots: "…", vdots: "⋮", therefore: "∴", because: "∵", angle: "∠", perp: "⊥", parallel: "∥",
  mid: "|", nmid: "∤", vert: "|", Vert: "‖", lvert: "|", rvert: "|", langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉",
  quad: " ", qquad: "  ", prime: "′", degree: "°", hbar: "ℏ", ell: "ℓ", Re: "ℜ", Im: "ℑ", aleph: "ℵ",
};

const NAMED = new Set(["gcd", "lcm", "log", "ln", "exp", "sin", "cos", "tan", "sec", "csc", "cot", "max", "min", "lim", "sup", "inf", "det", "dim", "deg", "arg", "ker", "mod", "bmod", "Pr"]);
const BLACKBOARD: Readonly<Record<string, string>> = { N: "ℕ", Z: "ℤ", Q: "ℚ", R: "ℝ", C: "ℂ", P: "ℙ" };
const SUPER: Readonly<Record<string, string>> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", k: "ᵏ", x: "ˣ", T: "ᵀ", "′": "′" };
const SUB: Readonly<Record<string, string>> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", o: "ₒ", x: "ₓ", h: "ₕ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", p: "ₚ", s: "ₛ", t: "ₜ", i: "ᵢ", j: "ⱼ" };

/** Reads one argument at `i`: a {group}, or one character (or command). Returns its TeX and where it ends. */
function readArg(tex: string, i: number): { arg: string; end: number } {
  while (tex[i] === " ") i++;
  if (tex[i] === "{") {
    let depth = 0;
    for (let j = i; j < tex.length; j++) {
      if (tex[j] === "\\") {
        j++;
        continue;
      }
      if (tex[j] === "{") depth++;
      else if (tex[j] === "}" && --depth === 0) return { arg: tex.slice(i + 1, j), end: j + 1 };
    }
    return { arg: tex.slice(i + 1), end: tex.length };
  }
  if (tex[i] === "\\") {
    const cmd = /^\\([A-Za-z]+|.)/.exec(tex.slice(i));
    if (cmd) return { arg: cmd[0], end: i + cmd[0].length };
  }
  return { arg: tex[i] ?? "", end: Math.min(tex.length, i + 1) };
}

/** Wraps a part in parentheses when it is more than one simple token, so "a+b over 2" reads (a+b)/2. */
function grouped(text: string): string {
  return /^[\p{L}\p{N}.′²³]+$/u.test(text) || /^\(.*\)$/.test(text) ? text : `(${text})`;
}

function script(text: string, map: Readonly<Record<string, string>>, mark: string): string {
  const chars = [...text];
  if (chars.length && chars.every((c) => map[c])) return chars.map((c) => map[c]).join("");
  return chars.length === 1 ? `${mark}${text}` : `${mark}(${text})`;
}

/**
 * TeX as plain text: commands to their Unicode symbols, \frac{a}{b} to a/b, \sqrt{x} to √x, x^2 to x², \mathbb{Z}
 * to ℤ, \text{...} to its words. What it doesn't know loses its backslash and braces, so it still reads.
 */
export function texToText(tex: string): string {
  let out = "";
  let i = 0;
  while (i < tex.length) {
    const ch = tex[i];
    if (ch === "\\") {
      const m = /^\\([A-Za-z]+|.)/.exec(tex.slice(i));
      if (!m) {
        i++;
        continue;
      }
      const name = m[1];
      i += m[0].length;
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        const a = readArg(tex, i);
        const b = readArg(tex, a.end);
        out += `${grouped(texToText(a.arg).trim())}/${grouped(texToText(b.arg).trim())}`;
        i = b.end;
      } else if (name === "sqrt") {
        let root = "";
        if (tex[i] === "[") {
          const close = tex.indexOf("]", i);
          if (close > i) {
            root = script(texToText(tex.slice(i + 1, close)), SUPER, "");
            i = close + 1;
          }
        }
        const a = readArg(tex, i);
        out += `${root}√${grouped(texToText(a.arg).trim())}`;
        i = a.end;
      } else if (["text", "textrm", "textbf", "textit", "mathrm", "mathbf", "mathit", "mathsf", "mathtt", "operatorname", "boxed", "mbox", "emph", "bm", "overline", "underline", "hat", "bar", "vec", "tilde"].includes(name)) {
        const a = readArg(tex, i);
        out += name.startsWith("text") || name === "mbox" || name === "operatorname" ? a.arg : texToText(a.arg);
        i = a.end;
      } else if (name === "mathbb" || name === "Bbb") {
        const a = readArg(tex, i);
        out += [...a.arg].map((c) => BLACKBOARD[c] ?? c).join("");
        i = a.end;
      } else if (name === "left" || name === "right" || name === "big" || name === "Big" || name === "bigg" || name === "Bigg" || name === "displaystyle") {
        // Sizing only: the delimiter after it is kept, except the invisible one ("\\left.").
        if (tex[i] === ".") i++;
      } else if (name === "tag") {
        const a = readArg(tex, i);
        out += `  (${texToText(a.arg).trim()})`;
        i = a.end;
      } else if (name === "label" || name === "begin" || name === "end") {
        i = readArg(tex, i).end;
      } else if (name === "notag" || name === "nonumber") {
        // Numbering marks: nothing to show.
      } else if (name === "pmod") {
        const a = readArg(tex, i);
        out += ` (mod ${texToText(a.arg)})`;
        i = a.end;
      } else if (NAMED.has(name)) {
        out += name === "bmod" ? "mod" : name;
      } else if (SYMBOLS[name] !== undefined) {
        out += SYMBOLS[name];
      } else if (name === "," || name === ";" || name === ":" || name === " " || name === "!") {
        out += name === "!" ? "" : " ";
      } else if (name === "\\") {
        out += "\n";
      } else if (/^[{}$%&#_]$/.test(name)) {
        out += name;
      } else {
        out += name;
      }
      continue;
    }
    if (ch === "^" || ch === "_") {
      const a = readArg(tex, i + 1);
      out += script(texToText(a.arg).trim(), ch === "^" ? SUPER : SUB, ch);
      i = a.end;
      continue;
    }
    if (ch === "{" || ch === "}") {
      i++;
      continue;
    }
    if (ch === "~") {
      out += " ";
      i++;
      continue;
    }
    if (ch === "&") {
      // An alignment point in an aligned block.
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/[ \t]{2,}/g, " ").replace(/ *\n */g, "\n");
}
