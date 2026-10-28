/** Product copy never has em dashes. Run any model text you show through it: plain(res.output_text). */
export function plain(text: string): string {
  return text
    .replace(/[ \t]*\u2014[ \t]*/g, ", ")
    .replace(/^, /gm, "")
    .replace(/, $/gm, "");
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
