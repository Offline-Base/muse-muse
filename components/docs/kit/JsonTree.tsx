import type { ReactNode } from "react";

/**
 * Pretty JSON for replies: colored like the docs' code blocks, with objects and arrays below `openDepth` folded
 * (details and summary, so it works without JavaScript and with the keyboard). A folded object shows its id or name,
 * so a list such as GET /v1/models reads at a glance. Base64 payloads and very long strings show their start and size
 * instead of megabytes of text, and long arrays show their first items.
 */

const MAX_ITEMS = 100;
const LONG_STRING = 400;
const PREVIEW = 120;
/** Fields a folded object is named by, in order: the first one it has, when short, shows in its summary. */
const NAME_FIELDS = ["id", "name", "type"] as const;

function sizeOf(chars: number): string {
  const bytes = (chars * 3) / 4;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StringValue({ value }: { value: string }) {
  if (value.length <= LONG_STRING) return <span className="pg-json-str">{JSON.stringify(value)}</span>;
  const base64 = /^data:[^,]+;base64,/.test(value) || /^[A-Za-z0-9+/=\r\n]+$/.test(value);
  const note = base64 ? `${sizeOf(value.length)} of base64` : `${value.length.toLocaleString("en-US")} characters`;
  return (
    <span className="pg-json-str" title={note}>
      {JSON.stringify(value.slice(0, PREVIEW)).slice(0, -1)}...&quot;
      <span className="pg-json-note"> ({note})</span>
    </span>
  );
}

function Scalar({ value }: { value: unknown }) {
  if (typeof value === "string") return <StringValue value={value} />;
  if (typeof value === "number") return <span className="pg-json-num">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="pg-json-bool">{String(value)}</span>;
  if (value === null) return <span className="pg-json-null">null</span>;
  return <span className="pg-json-null">{String(value)}</span>;
}

function Key({ name }: { name: string | number | null }) {
  if (name === null || typeof name === "number") return null;
  return (
    <>
      <span className="pg-json-key">{JSON.stringify(name)}</span>
      <span className="pg-json-punct">: </span>
    </>
  );
}

function Node({ name, value, depth, openDepth, comma }: { name: string | number | null; value: unknown; depth: number; openDepth: number; comma: boolean }) {
  const tail: ReactNode = comma ? <span className="pg-json-punct">,</span> : null;
  if (value === null || typeof value !== "object") {
    return (
      <div className="pg-json-row">
        <Key name={name} />
        <Scalar value={value} />
        {tail}
      </div>
    );
  }
  const isArray = Array.isArray(value);
  const entries: Array<[string | number, unknown]> = isArray
    ? (value as unknown[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const [open, close] = isArray ? ["[", "]"] : ["{", "}"];
  if (!entries.length) {
    return (
      <div className="pg-json-row">
        <Key name={name} />
        <span className="pg-json-punct">
          {open}
          {close}
        </span>
        {tail}
      </div>
    );
  }
  const shown = entries.slice(0, MAX_ITEMS);
  const count = isArray ? `${entries.length} item${entries.length === 1 ? "" : "s"}` : `${entries.length} key${entries.length === 1 ? "" : "s"}`;
  const named = isArray ? null : nameOf(value as Record<string, unknown>);
  return (
    <details className="pg-json-node" open={depth < openDepth}>
      <summary>
        <Key name={name} />
        <span className="pg-json-punct">{open}</span>
        <span className="pg-json-fold">
          {" "}
          {named ? (
            <>
              <span className="pg-json-key">{named[0]}</span>
              <span className="pg-json-punct">: </span>
              <Scalar value={named[1]} />
              <span className="pg-json-punct">, </span>
            </>
          ) : null}
          {count} {close}
          {comma ? "," : ""}
        </span>
      </summary>
      <div className="pg-json-children">
        {shown.map(([k, v], i) => (
          <Node key={String(k)} name={k} value={v} depth={depth + 1} openDepth={openDepth} comma={i < shown.length - 1 || entries.length > MAX_ITEMS} />
        ))}
        {entries.length > MAX_ITEMS ? <div className="pg-json-row pg-json-note">... {entries.length - MAX_ITEMS} more</div> : null}
      </div>
      <div className="pg-json-row pg-json-close">
        <span className="pg-json-punct">{close}</span>
        {tail}
      </div>
    </details>
  );
}

/** The field a folded object is named by: its id, name or type, when that is a short string or a number. */
export function nameOf(value: Record<string, unknown>): [string, string | number] | null {
  for (const field of NAME_FIELDS) {
    const v = value[field];
    if ((typeof v === "string" && v && v.length <= 60) || (typeof v === "number" && Number.isFinite(v))) return [field, v];
  }
  return null;
}

export function JsonTree({ value, openDepth = 3, label = "JSON" }: { value: unknown; openDepth?: number; label?: string }) {
  return (
    <div className="pg-json" aria-label={label}>
      <Node name={null} value={value} depth={0} openDepth={openDepth} comma={false} />
    </div>
  );
}
