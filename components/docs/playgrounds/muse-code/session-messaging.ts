import { utf8Bytes } from "@/components/docs/playgrounds/muse-code/shell";

/**
 * Session messaging as a small world of named sessions (content/meta-docs/pages/muse-code/session-messaging.md):
 * names normalized and checked by the page's rules in one user-wide, case-insensitive namespace with tombstoned old
 * names; messages addressed by exact canonical name or full session UUID, at most 8,192 bytes, never to yourself,
 * deduplicated by message id; peer admission with the four approval choices, a 30-minute expiry and then a 30-minute
 * retry cooldown; and the three delivery behaviors and wake policies. Pure: the simulator dispatches actions into it.
 */

export const MAX_MESSAGE_BYTES = 8192;
export const APPROVAL_EXPIRES_MIN = 30;
export const RETRY_COOLDOWN_MIN = 30;
export const RESERVED = ["all", "self", "current"];

export type Platform = "macos" | "linux" | "windows";
export type Launch = "interactive" | "no-session-log" | "headless";
export type Delivery = "steer" | "queue" | "notify";
export type Wake = "when-idle" | "stay-idle" | "safe-point";

/** ASCII uppercase becomes lowercase before validation ("/name API-Review-482731" is stored as api-review-482731). */
export function normalizeName(input: string): string {
  return input.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Problems with a normalized name, by the page's rules. Empty when it's valid. */
export function nameRuleProblems(name: string): string[] {
  const out: string[] = [];
  if (/[^\x00-\x7f]/.test(name)) out.push("Names are ASCII only.");
  if (name.length < 3 || name.length > 32) out.push(`A name has 3-32 characters; this one has ${name.length}.`);
  if (!/^[a-z]/.test(name)) out.push("It must start with a lowercase letter.");
  if (/[^a-z0-9-]/.test(name.replace(/[^\x00-\x7f]/g, ""))) out.push("Use lowercase letters, digits and single hyphens only.");
  if (/--/.test(name)) out.push("No consecutive hyphens.");
  if (/-$/.test(name)) out.push("No trailing hyphen.");
  if (RESERVED.includes(name)) out.push(`"${name}" is reserved (all, self and current are).`);
  return out;
}

export interface Entry {
  at: number;
  text: string;
  tone: "ok" | "warn" | "bad" | "plain";
}

export interface Session {
  id: string;
  name: string | null;
  /** Earlier names, reserved to this session (tombstones). */
  formerNames: string[];
  platform: Platform;
  launch: Launch;
  running: boolean;
  /** Same permission profile as its peers: exact-profile peers can be admitted automatically. */
  exactProfile: boolean;
  /** Peer ids allowed or blocked "for this session" (until either session restarts). */
  allowed: string[];
  blocked: string[];
  feed: Entry[];
  /** Messages that reached this session's model context, for the live tab. */
  inbox: Array<{ from: string; fromId: string; body: string; delivery: Delivery }>;
}

export interface Pending {
  key: string;
  from: string;
  to: string;
  body: string;
  delivery: Delivery;
  wake: Wake;
  messageId: string;
  at: number;
}

export interface World {
  /** Minutes since the start, for expiry and cooldown. */
  clock: number;
  sessions: Session[];
  pending: Pending[];
  cooldowns: Array<{ from: string; to: string; until: number }>;
  seen: string[];
  /** The result of the last action, for the screen reader. */
  status: { text: string; tone: Entry["tone"] };
  nextId: number;
}

export type Action =
  | { type: "rename"; session: string; name: string }
  | { type: "send"; from: string; to: string; body: string; delivery: Delivery; wake: Wake; messageId: string }
  | { type: "decide"; key: string; choice: "allow-once" | "reject-once" | "allow-session" | "block-session" }
  | { type: "advance"; minutes: number }
  | { type: "restart"; session: string }
  | { type: "set"; session: string; patch: Partial<Pick<Session, "platform" | "launch" | "running" | "exactProfile">> }
  | { type: "add"; platform: Platform; launch: Launch };

const UUIDS = [
  "6f1c2b7a-41d2-4e8b-9a3c-0d5e7f9a1b24",
  "a83d9e10-5c47-4b2f-8e61-3f9b2c7d4a58",
  "c2e47f95-0b13-4d6a-a7e8-91c5d3b6f072",
  "e9b06a3c-72d8-4f15-b4c9-5a8e1d27f3b6",
  "1d4f8b2e-9c60-4a37-8b15-e6c2a9f4d083",
];

function makeSession(i: number, name: string | null, platform: Platform, launch: Launch, running: boolean): Session {
  return { id: UUIDS[i % UUIDS.length], name, formerNames: [], platform, launch, running, exactProfile: false, allowed: [], blocked: [], feed: [], inbox: [] };
}

export function initialWorld(): World {
  return {
    clock: 0,
    sessions: [makeSession(0, "implementation-482731", "macos", "interactive", true), makeSession(1, "api-review-482731", "macos", "interactive", false)],
    pending: [],
    cooldowns: [],
    seen: [],
    status: { text: "Two live sessions in the same project. Send a message from one to the other.", tone: "plain" },
    nextId: 2,
  };
}

export function label(s: Session): string {
  return s.name ?? `(unnamed ${s.id.slice(0, 8)})`;
}

/** Why a session can't take part in messaging, or null. */
export function ineligible(s: Session): string | null {
  if (s.platform === "windows") return "Session messaging is unavailable on Windows.";
  if (s.launch === "no-session-log") return "A session started with muse --no-session-log has no retained name and can't take part in peer messaging.";
  if (s.launch === "headless") return "Headless sessions don't appear in the peer list.";
  return null;
}

/** The session a target names: its exact canonical name or its full UUID. */
export function resolveTarget(world: World, target: string): { session: Session | null; problem: string | null } {
  const t = normalizeName(target);
  if (!t) return { session: null, problem: "Name the session to send to." };
  const byId = world.sessions.find((s) => s.id === t);
  if (byId) return { session: byId, problem: null };
  const byName = world.sessions.find((s) => s.name === t);
  if (byName) return { session: byName, problem: null };
  const former = world.sessions.find((s) => s.formerNames.includes(t));
  if (former) return { session: null, problem: `"${t}" is an earlier name of ${label(former)}, not its canonical name. List your peer sessions first to avoid stale names.` };
  if (/^[0-9a-f]{8}$/.test(t) && world.sessions.some((s) => s.id.startsWith(t))) return { session: null, problem: "Use the full session UUID, not a short prefix." };
  return { session: null, problem: `No live session is named "${t}". List your peer sessions first, so you don't send to a mistyped or stale target.` };
}

const DELIVERY_TEXT: Record<Delivery, string> = {
  steer: "steers the active turn at its next safe model step",
  queue: "is queued for the next turn",
  notify: "is shown and recorded, but not added to the model's context",
};

const WAKE_TEXT: Record<Wake, string> = {
  "when-idle": "wakes the session when it's idle",
  "stay-idle": "leaves the session idle",
  "safe-point": "wakes the session at a safe point",
};

function log(world: World, ids: string[], text: string, tone: Entry["tone"]): World {
  return {
    ...world,
    sessions: world.sessions.map((s) => (ids.includes(s.id) ? { ...s, feed: [...s.feed, { at: world.clock, text, tone }].slice(-30) } : s)),
  };
}

function status(world: World, text: string, tone: Entry["tone"]): World {
  return { ...world, status: { text, tone } };
}

function deliver(world: World, p: Pending, how: string): World {
  const to = world.sessions.find((s) => s.id === p.to)!;
  const from = world.sessions.find((s) => s.id === p.from)!;
  let effect: string;
  if (p.delivery === "notify") effect = DELIVERY_TEXT.notify;
  else if (to.running) effect = p.delivery === "steer" ? DELIVERY_TEXT.steer : DELIVERY_TEXT.queue;
  else effect = `${p.delivery === "steer" ? "arrives while idle and" : "is queued, and"} ${WAKE_TEXT[p.wake]}`;
  let next = world;
  if (p.delivery !== "notify") {
    next = { ...next, sessions: next.sessions.map((s) => (s.id === to.id ? { ...s, inbox: [...s.inbox, { from: label(from), fromId: from.id, body: p.body, delivery: p.delivery }] } : s)) };
  }
  next = log(next, [to.id], `From ${label(from)}: "${preview(p.body)}" ${effect}. (${how})`, "ok");
  next = log(next, [from.id], `Delivered to ${label(to)} (${how}).`, "ok");
  return status(next, `Delivered to ${label(to)}: the message ${effect}.`, "ok");
}

export function preview(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

export function reducer(world: World, action: Action): World {
  switch (action.type) {
    case "rename": {
      const s = world.sessions.find((x) => x.id === action.session);
      if (!s) return world;
      if (s.launch === "no-session-log") return status(world, "A --no-session-log session has no retained name.", "bad");
      const name = normalizeName(action.name);
      const problems = nameRuleProblems(name);
      if (problems.length) return status(world, `Can't use "${name}": ${problems.join(" ")}`, "bad");
      if (name === s.name) return status(world, `${name} is already this session's name.`, "plain");
      const owner = world.sessions.find((x) => x.id !== s.id && (x.name === name || x.formerNames.includes(name)));
      if (owner) {
        return status(world, owner.name === name ? `"${name}" is taken by another session: names are unique across all your sessions, not just this workspace.` : `"${name}" is a tombstoned earlier name of ${label(owner)}: only that session can reclaim it.`, "bad");
      }
      const formerNames = [...s.formerNames.filter((n) => n !== name), ...(s.name ? [s.name] : [])];
      const next = { ...world, sessions: world.sessions.map((x) => (x.id === s.id ? { ...x, name, formerNames } : x)) };
      const reclaimed = s.formerNames.includes(name);
      return status(log(next, [s.id], `/name ${action.name.trim()} saved as ${name}${reclaimed ? " (reclaimed an earlier name)" : ""}.`, "plain"), `Renamed to ${name}.${s.name ? ` ${s.name} stays reserved to this session.` : ""}`, "ok");
    }
    case "send": {
      const from = world.sessions.find((s) => s.id === action.from);
      if (!from) return world;
      const whyFrom = ineligible(from);
      if (whyFrom) return status(world, `${label(from)} can't send: ${whyFrom}`, "bad");
      const { session: to, problem } = resolveTarget(world, action.to);
      if (!to) return status(world, problem ?? "No such session.", "bad");
      if (to.id === from.id) return status(world, "Self-messaging is rejected.", "bad");
      const whyTo = ineligible(to);
      if (whyTo) return status(world, `${label(to)} isn't in the peer list: ${whyTo}`, "bad");
      const bytes = utf8Bytes(action.body);
      if (!action.body.trim()) return status(world, "Write a message first.", "bad");
      if (bytes > MAX_MESSAGE_BYTES) return status(world, `The message is ${bytes.toLocaleString("en-US")} bytes; messages can use up to 8,192.`, "bad");
      if (world.seen.includes(action.messageId)) return status(log(world, [to.id], `A duplicate of message ${action.messageId} was dropped.`, "plain"), `Message id ${action.messageId} was already delivered, so the duplicate is deduplicated.`, "warn");
      const cooldown = world.cooldowns.find((c) => c.from === from.id && c.to === to.id && c.until > world.clock);
      if (cooldown) return status(world, `retry later: an earlier approval request to ${label(to)} expired, so this admission is cooling down for ${cooldown.until - world.clock} more minutes.`, "warn");
      const p: Pending = { key: `${action.messageId}`, from: from.id, to: to.id, body: action.body, delivery: action.delivery, wake: action.wake, messageId: action.messageId, at: world.clock };
      let next: World = { ...world, seen: [...world.seen, action.messageId] };
      if (to.blocked.includes(from.id)) {
        next = log(next, [from.id], `${label(to)} blocked messages from this session until either session restarts.`, "bad");
        return status(next, `Rejected: ${label(to)} blocked this peer for the session.`, "bad");
      }
      if (to.allowed.includes(from.id)) return deliver(next, p, "allowed for this session");
      if (to.exactProfile && from.exactProfile) return deliver(next, p, "exact-profile peer, admitted automatically");
      const effect = action.delivery !== "steer" || action.wake !== "when-idle" ? ` Delivery effect shown: it ${DELIVERY_TEXT[action.delivery]}, and ${WAKE_TEXT[action.wake]}.` : "";
      next = { ...next, pending: [...next.pending, p] };
      next = log(next, [to.id], `Approval prompt: ${label(from)} (${from.id}) in /path/to/your/project wants to send "${preview(action.body)}".${effect}`, "warn");
      next = log(next, [from.id], `Waiting for ${label(to)} to approve this sender.`, "plain");
      return status(next, `${label(to)} asks its user to approve the sender. Pending requests expire after 30 minutes.`, "warn");
    }
    case "decide": {
      const p = world.pending.find((x) => x.key === action.key);
      if (!p) return world;
      let next: World = { ...world, pending: world.pending.filter((x) => x.key !== action.key) };
      const to = next.sessions.find((s) => s.id === p.to)!;
      const from = next.sessions.find((s) => s.id === p.from)!;
      if (action.choice === "reject-once" || action.choice === "block-session") {
        if (action.choice === "block-session") next = { ...next, sessions: next.sessions.map((s) => (s.id === to.id ? { ...s, blocked: [...s.blocked, from.id] } : s)) };
        next = log(next, [to.id], action.choice === "block-session" ? `Blocked ${label(from)} for this session.` : `Rejected this message from ${label(from)}.`, "bad");
        next = log(next, [from.id], `${label(to)} rejected the message.`, "bad");
        return status(next, action.choice === "block-session" ? `Blocked: later messages from ${label(from)} are rejected until either session restarts.` : "Rejected once: later messages ask again.", "bad");
      }
      if (action.choice === "allow-session") next = { ...next, sessions: next.sessions.map((s) => (s.id === to.id ? { ...s, allowed: [...s.allowed, from.id] } : s)) };
      return deliver(next, p, action.choice === "allow-session" ? "allowed for this session" : "allowed once");
    }
    case "advance": {
      const clock = world.clock + action.minutes;
      const expired = world.pending.filter((p) => clock - p.at >= APPROVAL_EXPIRES_MIN);
      let next: World = { ...world, clock, pending: world.pending.filter((p) => !expired.includes(p)) };
      for (const p of expired) {
        next = { ...next, cooldowns: [...next.cooldowns, { from: p.from, to: p.to, until: p.at + APPROVAL_EXPIRES_MIN + RETRY_COOLDOWN_MIN }] };
        next = log(next, [p.to, p.from], `The approval request for "${preview(p.body)}" expired after 30 minutes. Retrying this admission returns retry later for 30 minutes.`, "warn");
      }
      return status(next, expired.length ? `${action.minutes} minutes later: ${expired.length} pending ${expired.length === 1 ? "request" : "requests"} expired. Check the receiving session when delivery stays unconfirmed.` : `${action.minutes} minutes passed.`, expired.length ? "warn" : "plain");
    }
    case "restart": {
      const s = world.sessions.find((x) => x.id === action.session);
      if (!s) return world;
      const next = {
        ...world,
        sessions: world.sessions.map((x) =>
          x.id === s.id ? { ...x, allowed: [], blocked: [], running: false } : { ...x, allowed: x.allowed.filter((id) => id !== s.id), blocked: x.blocked.filter((id) => id !== s.id) },
        ),
      };
      return status(log(next, [s.id], "Restarted: every allow or block for this session is gone.", "plain"), `${label(s)} restarted, so "for this session" decisions involving it no longer apply.`, "plain");
    }
    case "set":
      return { ...world, sessions: world.sessions.map((s) => (s.id === action.session ? { ...s, ...action.patch } : s)) };
    case "add": {
      if (world.sessions.length >= 4) return status(world, "Four sessions is plenty for this simulator.", "plain");
      const i = world.nextId;
      const session = makeSession(i, action.launch === "no-session-log" ? null : `release-check-482731`, action.platform, action.launch, false);
      const taken = world.sessions.some((s) => s.name === session.name || s.formerNames.includes(session.name ?? ""));
      const named = taken ? { ...session, name: action.launch === "no-session-log" ? null : `session-${i}-482731` } : session;
      return status({ ...world, sessions: [...world.sessions, named], nextId: i + 1 }, `Started a ${action.launch === "interactive" ? "" : `${action.launch} `}session${named.name ? ` named ${named.name}` : ""}.`, "plain");
    }
  }
}
