/**
 * JSON Pointer (RFC 6901) get and set, for file slots that drop a picked file into a request body at a path such as
 * "/input/0/content/1/image_url". Setting copies along the path and leaves the original untouched, so it is safe on
 * React state.
 */

export class PointerError extends Error {}

/** The reference tokens of a pointer: "" is the whole document, "/a~1b/0" is ["a/b", "0"]. */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new PointerError(`A JSON Pointer starts with "/": ${JSON.stringify(pointer)}`);
  return pointer
    .slice(1)
    .split("/")
    .map((t) => {
      if (/~[^01]|~$/.test(t)) throw new PointerError(`Bad escape in JSON Pointer token ${JSON.stringify(t)}`);
      return t.replace(/~1/g, "/").replace(/~0/g, "~");
    });
}

export function formatPointer(tokens: ReadonlyArray<string | number>): string {
  return tokens.map((t) => `/${String(t).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

function isIndex(token: string): boolean {
  return /^(0|[1-9]\d*)$/.test(token);
}

/** The value at `pointer`, or undefined when any step is missing. */
export function jsonGet(doc: unknown, pointer: string): unknown {
  let cur: unknown = doc;
  for (const token of parsePointer(pointer)) {
    if (Array.isArray(cur)) {
      if (!isIndex(token)) return undefined;
      cur = cur[Number(token)];
    } else if (cur && typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, token)) return undefined;
      cur = (cur as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function jsonHas(doc: unknown, pointer: string): boolean {
  return jsonGet(doc, pointer) !== undefined;
}

/**
 * A copy of `doc` with `value` at `pointer`. Missing steps are created: an array when the next token is an index or
 * "-" (append), an object otherwise. Throws when a step runs into a string, number or boolean.
 */
export function jsonSet<T>(doc: T, pointer: string, value: unknown): T {
  const tokens = parsePointer(pointer);
  if (!tokens.length) return value as T;
  const setAt = (node: unknown, i: number): unknown => {
    const token = tokens[i];
    const last = i === tokens.length - 1;
    const nextIsArray = !last && (isIndex(tokens[i + 1]) || tokens[i + 1] === "-");
    if (node === undefined || node === null) node = isIndex(token) || token === "-" ? [] : {};
    if (Array.isArray(node)) {
      const copy = [...node];
      const index = token === "-" ? copy.length : isIndex(token) ? Number(token) : NaN;
      if (Number.isNaN(index)) throw new PointerError(`"${token}" isn't an array index in ${pointer}`);
      if (index > copy.length) throw new PointerError(`Index ${index} is past the end of the array in ${pointer}`);
      copy[index] = last ? value : setAt(copy[index] ?? (nextIsArray ? [] : undefined), i + 1);
      return copy;
    }
    if (typeof node === "object") {
      const copy = { ...(node as Record<string, unknown>) };
      copy[token] = last ? value : setAt(copy[token] ?? (nextIsArray ? [] : undefined), i + 1);
      return copy;
    }
    throw new PointerError(`Can't step into a ${typeof node} at "${token}" in ${pointer}`);
  };
  return setAt(doc, 0) as T;
}
