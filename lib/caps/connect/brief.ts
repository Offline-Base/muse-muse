import { z } from "zod";
import { CALL_SERVICE_IDS, PUBLIC_API_IDS, PUBLIC_APIS, SEND_CHANNELS, SEND_CHANNELS_LIVE, SERVICES } from "@/lib/caps/connect/allowlist";

/**
 * The connect cap's brief block (docs/CAPABILITIES.md, section 11): the keyless public APIs a product reads, the
 * outside services it calls with its owner's own key, and the messages it sends with one, each confirmed once. The
 * stored block takes every channel the contract names; the writer is offered only what is switched on and has a
 * service that works today (email and chat), and the vault and sends only with their flags.
 */
export const MAX_PUBLIC_APIS = 4;
export const MAX_KEYS = 3;
export const MAX_SENDS = 2;

const why = z.string().min(1).max(200);

export const ConnectBriefBlock = z.object({
  publicApis: z.array(z.string().min(1).max(40)).max(MAX_PUBLIC_APIS),
  keys: z.array(z.object({ service: z.string().min(1).max(40), why })).max(MAX_KEYS),
  sends: z.array(z.object({ channel: z.enum(SEND_CHANNELS), why })).max(MAX_SENDS),
});

export type ConnectBrief = z.infer<typeof ConnectBriefBlock>;

/** What the writer may pick right now: CONNECT_VAULT gives keys, CONNECT_SENDS gives sends. */
export interface ConnectOptions {
  vault: boolean;
  sends: boolean;
}

/** The writer's block: only allowlisted ids, and empty lists for what is switched off. */
export function connectWriterBlock(opts: ConnectOptions) {
  return z.object({
    publicApis: z.array(z.enum(PUBLIC_API_IDS)).max(MAX_PUBLIC_APIS),
    keys: z.array(z.object({ service: z.enum(CALL_SERVICE_IDS), why })).max(opts.vault ? MAX_KEYS : 0),
    sends: z.array(z.object({ channel: z.enum(SEND_CHANNELS_LIVE as [string, ...string[]]), why })).max(opts.sends ? MAX_SENDS : 0),
  });
}

/** The connect block of a brief, or null, also for one that isn't in the block's shape. */
export function connectBlock(brief: object | null | undefined): ConnectBrief | null {
  const block = (brief as { connect?: unknown } | null | undefined)?.connect;
  if (!block || typeof block !== "object") return null;
  const b = block as Partial<ConnectBrief>;
  return Array.isArray(b.publicApis) && Array.isArray(b.keys) && Array.isArray(b.sends) ? (block as ConnectBrief) : null;
}

const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "").trim() || s.slice(0, max));

/**
 * The writer's raw connect block, cleaned before zod (normalizeRawBrief): ids only from the allowlists, each once,
 * within the limits; keys emptied with the vault off and sends with sends off; text clipped. A block that asks for
 * nothing becomes null.
 */
export function normalizeConnectBlock(raw: unknown, opts: ConnectOptions): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const b = { ...(raw as Record<string, unknown>) };
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  b.publicApis = [...new Set(list(b.publicApis).filter((id): id is string => typeof id === "string" && Object.hasOwn(PUBLIC_APIS, id)))].slice(0, MAX_PUBLIC_APIS);
  const seenKeys = new Set<string>();
  b.keys = opts.vault
    ? list(b.keys)
        .filter((k): k is { service: string; why: unknown } => Boolean(k) && typeof (k as { service?: unknown }).service === "string")
        .filter((k) => (CALL_SERVICE_IDS as readonly string[]).includes(k.service) && !seenKeys.has(k.service) && Boolean(seenKeys.add(k.service)))
        .map((k) => ({ service: k.service, why: typeof k.why === "string" ? clip(k.why.trim(), 200) : k.why }))
        .slice(0, MAX_KEYS)
    : [];
  const seenSends = new Set<string>();
  b.sends = opts.sends
    ? list(b.sends)
        .filter((s): s is { channel: string; why: unknown } => Boolean(s) && typeof (s as { channel?: unknown }).channel === "string")
        .filter((s) => (SEND_CHANNELS_LIVE as readonly string[]).includes(s.channel) && !seenSends.has(s.channel) && Boolean(seenSends.add(s.channel)))
        .map((s) => ({ channel: s.channel, why: typeof s.why === "string" ? clip(s.why.trim(), 200) : s.why }))
        .slice(0, MAX_SENDS)
    : [];
  if (!(b.publicApis as unknown[]).length && !(b.keys as unknown[]).length && !(b.sends as unknown[]).length) return null;
  return b;
}

function apiLines(): string[] {
  return Object.values(PUBLIC_APIS).map((a) => `${a.id} (${a.label})`);
}

/** The writer's rules (lib/caps/brief-fields.ts, CAP_WRITER_RULES), following the vault and sends switches. */
export function connectWriterRules(opts: ConnectOptions): readonly string[] {
  const callable = CALL_SERVICE_IDS.map((id) => `${id} (${SERVICES[id]!.label})`);
  return [
    "connect: fill it only when the muse needs live outside facts or services: weather, an encyclopedia summary, book records, earthquakes" +
      (opts.vault ? ", a service the product's owner has an account with" : "") +
      (opts.sends ? ", or a message the owner sends" : "") +
      ". Otherwise null.",
    `connect.publicApis: up to ${MAX_PUBLIC_APIS} of these keyless public APIs, by id: ${apiLines().join("; ")}. Only these, and only the ones the muse needs. Others aren't reachable.`,
    opts.vault
      ? `connect.keys: up to ${MAX_KEYS} services the product calls with its owner's own key, which the owner types into the product's key settings and the platform keeps: ${callable.join("; ")}. Each with why, in one plain sentence. Never a key in the product's code. Empty when none.`
      : "connect.keys: []. Products can't use their own keys for outside services yet.",
    opts.sends
      ? `connect.sends: up to ${MAX_SENDS} kinds of message the product's owner sends with their own account, each confirmed by the owner once before it goes: ${SEND_CHANNELS_LIVE.join(", ")}. Each with why. SMS, social posts and payments aren't available. Empty when the product sends nothing.`
      : "connect.sends: []. Products can't send messages, posts or payments yet: a product drafts the text and the person sends it themselves.",
  ];
}
