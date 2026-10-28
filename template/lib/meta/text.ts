const DASH = /[ \t]*\u2014[ \t]*/;
/** Words that carry the same sentence on after a dash, so a comma is enough: "I ran 5 km, and it felt easy." */
const CARRIES_ON = /^(?:and|but|or|so|yet|nor|for|which|who|whose|where|when|while|including|like|especially|even|not|just|plus)\b/i;

/**
 * Product copy never has em dashes. Run any model text you show through it: plain(res.output_text). respondJson asks
 * the model not to write them and runs this on its reply, so it is a fallback that keeps each sentence readable:
 * - a pair around an aside becomes a pair of commas: "The plan, three runs a week, starts Monday."
 * - one dash after a label, or before a figure, becomes a colon: "Week 3: 38 km", "Wins: You shipped 20 orders."
 * - one dash before a new clause ends the sentence: "Keep going. Small wins add up."
 * - one dash before a short tail or a joining word becomes a comma: "We met, finally."
 * - a dash between two numbers with no spaces is a range: "9 to 5"
 * - a run of dashes counts as one, and a dash right before punctuation goes: "You did it!"
 */
export function plain(text: string): string {
  return text.replace(/[^\r\n]+/g, plainLine);
}

function plainLine(line: string): string {
  let rest = line
    .replace(/\u2014(?:[ \t]*\u2014)+/g, "\u2014")
    .replace(/(\d)\u2014(?=\d)/g, "$1 to ")
    .replace(/^([ \t]*)\u2014[ \t]*/, "$1")
    .replace(/[ \t]*\u2014[ \t]*$/, "");
  let out = "";
  for (let m = DASH.exec(rest); m; m = DASH.exec(rest)) {
    const before = rest.slice(0, m.index);
    const after = rest.slice(m.index + m[0].length);
    const end = after.search(/[.!?](?=\s|$)/);
    const next = DASH.exec(after);
    if (next && (end < 0 || next.index < end) && isAside(after.slice(0, next.index), after.slice(next.index + next[0].length))) {
      // A pair around an aside. No comma when punctuation follows the second dash.
      const tail = after.slice(next.index + next[0].length);
      out += `${before}, ${after.slice(0, next.index)}`;
      rest = /^[.,;:!?)]/.test(tail) ? tail : `, ${tail}`;
      continue;
    }
    if (/^[.,;:!?)]/.test(after)) {
      out += before;
      rest = after;
      continue;
    }
    const sentence = before.slice(Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? ")) + 1);
    const upper = /^\p{Lu}/u.test(after);
    if (CARRIES_ON.test(after)) {
      out += `${before}, `;
    } else if (!sentence.includes(":") && (end < 0 || upper || !/^\p{L}/u.test(after))) {
      out += `${before}: `;
    } else if (!upper && after.slice(0, end < 0 ? after.length : end).trim().split(/\s+/).length <= 2) {
      out += `${before}, `;
    } else {
      out += `${before}. `;
      rest = after.replace(/^([^\p{L}\p{N}\s]*)(\p{Ll})/u, (_, lead: string, letter: string) => lead + letter.toUpperCase());
      continue;
    }
    rest = after;
  }
  return out + rest;
}

/**
 * Whether two dashes hold an aside, from the text between them and after the second. A comma between them means a
 * list of labels instead, which comes out as "Mon: rest, Tue: 5 km", unless the sentence goes on in lower case after
 * the second dash with no dash of its own, as it does after an aside: "The plan, three runs, two rests, starts Monday."
 */
function isAside(between: string, tail: string): boolean {
  if (!between.includes(",")) return true;
  const end = tail.search(/[.!?](?=\s|$)/);
  return /^\p{Ll}/u.test(tail) && !DASH.test(end < 0 ? tail : tail.slice(0, end));
}

/** plain() on every string inside a value. respondJson applies it to what it returns. */
export function plainDeep<T>(value: T): T {
  if (typeof value === "string") return plain(value) as T;
  if (Array.isArray(value)) return value.map(plainDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainDeep(v)])) as T;
  }
  return value;
}
