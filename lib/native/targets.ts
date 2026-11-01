/**
 * Which targets a brief has and how the writer is told about them (docs/NATIVE.md). Pure, and with no flag on nothing
 * here changes a brief. Only the flags in lib/env.ts say which targets are on; every function takes that as an argument.
 */
import { MAX_AGENT_STEPS, TARGETS, type Brief, type TargetId } from "@/lib/brief/schema";
import { isToolId, PERSONAL_TOOL_IDS, toolLabel } from "@/lib/tools/ids";

/**
 * What every product comes with, made from musemuse.json. These are not targets: a person who asks for a Claude or
 * ChatGPT plugin gets a normal product with these.
 */
export const PRODUCT_OUTPUTS = ["mcp", "cli", "skill", "claude_plugin", "chatgpt"] as const;
export type ProductOutput = (typeof PRODUCT_OUTPUTS)[number];

/**
 * Wave 3, unit 10 (docs/CAPABILITIES.md, section 16): what a live product also comes with under RUNTIME_OUTPUTS, made by
 * the platform as source and never published. The self-host kit is offered to the product's owner only. They aren't
 * PRODUCT_OUTPUTS, so the Prove it stage doesn't run them.
 */
export const RUNTIME_OUTPUTS = ["vscode", "github_action", "self_host"] as const;
export type RuntimeOutput = (typeof RUNTIME_OUTPUTS)[number];

/**
 * Wave 3, unit 14 (docs/CAPABILITIES.md, section 20): what a live product whose brief has a cap block also offers. Its
 * browser extension's zip, under NATIVE_EXTENSION, installed with Load unpacked.
 */
export const CAP_OUTPUTS = ["extension"] as const;
export type CapOutput = (typeof CAP_OUTPUTS)[number];

/** What the brief writer is told about each target. Used only once the target's flag is on. */
export const TARGET_GUIDE: Record<TargetId, string> = {
  web: "the web product, with its own link. Every product has it, whatever else it adds.",
  phone:
    "an Android app people install and an iPhone home screen icon, both opening the live product. Pick it for use on the go, the camera or one hand, or when the person says phone, iPhone or Android.",
  desktop:
    "a Mac app and a Windows app that open the live product. Pick it for a tool kept open at a desk, or when the person says Mac, Windows or desktop.",
  vr: "a VR app for Meta Quest. It opens from its link in Quest Browser, with nothing to install. On a computer it runs in a simulated headset with mouse and keyboard controls, and on a phone it shows a 3D preview. Pick it only when the muse asks for VR, a headset, Quest, or a space to step into, play or practice in. Scenes are built in code from simple shapes, panels and generated textures, and people point, press, grab and move with controllers or their hands. Text, photos and files are given on the page before entering VR; inside VR there are buttons, hands and at most one short spoken request. Models still do the job: Muse Image for a backdrop or textures, Muse Wonder to plan a layout or write a quiz, Muse Voice Transcribe for a spoken request. No multiplayer, nothing saved beyond the headset's browser, no large 3D model files.",
  glasses:
    "works with the wearer's Meta AI glasses (Ray-Ban Meta, Oakley Meta) through the Muse Muse iPhone app: the glasses take a photo of what the wearer is looking at, their microphone hears a short question, and the answer is spoken in the glasses. They have no screen, so answers are one to three short sentences, and the phone shows the photo and the answer. In a browser without the app it uses the phone's camera or a sample view. Pick it only when the muse asks for smart glasses, hands-free use, or 'what am I looking at'. The app must be open on the phone, since the glasses can't start it, and their microphone is phone-call quality.",
  agent:
    "an agent that works in several steps: it looks things up with Meta's web search and the listed tools, then answers with its sources. Pick it only when the product must look things up or work in several steps, and pick the fewest tools.",
};

/** Added to the agent's guide only with COMPOSIO_PERSONAL_ENABLED on, since the writer is offered no personal tool without it. */
export const PERSONAL_TOOLS_GUIDE =
  "Pick it too when the product must act in other apps. Public tools work for everyone. Personal tools work only for the product's owner for now.";

/** The targets NATIVE_TARGETS may name. vr, glasses and agent have switches of their own. */
const NATIVE_LANE: readonly TargetId[] = ["phone", "desktop"];

/** NATIVE_TARGETS as targets, in TARGETS order. Anything else in the list is ignored, and web is never in it. */
export function parseNativeTargets(raw: string | undefined): TargetId[] {
  const named = new Set((raw ?? "").split(",").map((t) => t.trim().toLowerCase()));
  return NATIVE_LANE.filter((t) => named.has(t));
}

function isTarget(id: unknown): id is TargetId {
  return (TARGETS as readonly unknown[]).includes(id);
}

/**
 * Where a brief's product runs: web first, each target once, in the brief's order. Ids this version doesn't know are
 * ignored, since a stored brief may come from a newer branch. A brief with no targets, or no brief, is web only.
 */
export function briefTargets(brief: { targets?: ReadonlyArray<{ id: unknown }> | null } | null | undefined): TargetId[] {
  const out: TargetId[] = ["web"];
  for (const t of brief?.targets ?? []) {
    if (isTarget(t?.id) && !out.includes(t.id)) out.push(t.id);
  }
  return out;
}

/** True when a brief asks for more than the web product. */
export function hasNativeWork(brief: Parameters<typeof briefTargets>[0]): boolean {
  return briefTargets(brief).some((t) => t === "phone" || t === "desktop");
}

export type TargetsCheck = { ok: true; value: TargetId[] } | { ok: false; error: string };

/**
 * The targets a person or a script asked for, checked against the ones allowed here. Nothing asked for is an empty list,
 * which means "let the writer choose". Web is always allowed. The answer is in TARGETS order, each target once.
 */
export function validateTargets(value: unknown, enabled: readonly TargetId[]): TargetsCheck {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: "Targets must be a list." };
  const allowed = new Set<unknown>(["web", ...enabled]);
  const bad = value.find((t) => !allowed.has(t));
  if (bad !== undefined) return { ok: false, error: `${String(bad).slice(0, 40)} isn't a place a product can run here.` };
  return { ok: true, value: TARGETS.filter((t) => value.includes(t)) };
}

/**
 * validateTargets for a route: with every target flag off, `targets` in a request is ignored, as any stray field is, so
 * nothing about a request changes until a flag is on. With one on, a target whose flag is off is refused.
 */
export function requestedTargetsFrom(value: unknown, enabled: readonly TargetId[]): TargetsCheck {
  return enabled.length ? validateTargets(value, enabled) : { ok: true, value: [] };
}

/** The why for a target the writer gave none for, because the person picked it. */
const PICKED_WHY = "You asked for it.";
const WEB_WHY = "Every product runs on the web.";
const AGENT_WHY = "It works in several steps with tools.";

/**
 * Limits a target always brings. Each is added unless the writer already said the same thing, which `said` looks for,
 * since a product shows each limit once.
 */
export const TARGET_LIMITS: Partial<Record<TargetId, Array<{ text: string; said: RegExp }>>> = {
  vr: [{ text: "Made for Meta Quest in Quest Browser. On a computer it runs in a simulated headset.", said: /simulated headset/i }],
  glasses: [
    { text: "Needs the Muse Muse iPhone app and Meta glasses. Without them it uses your phone's camera.", said: /(without|no) (the app|them|glasses)\b.*camera/i },
    { text: "Start it on your phone. The glasses can't open it.", said: /glasses (can't|cannot|can not) (start|open)/i },
  ],
};

const OWNER_LIMIT = /only (this app's |the product's |the product |the )?owner/i;

function withLimit(limits: string[], text: string, said: RegExp): string[] {
  return limits.some((l) => said.test(l)) ? limits : [...limits, text];
}

const isPersonal = (id: string) => (PERSONAL_TOOL_IDS as readonly string[]).includes(id);

/** True when an agent works only on the owner's accounts. It has nothing on the web to link to, so no sources to show. */
export function isOwnerToolsOnly(agent: { tools: ReadonlyArray<{ id: string }> } | null | undefined): boolean {
  return !!agent?.tools.length && agent.tools.every((t) => isPersonal(t.id));
}

/** The tool the writer's agent falls back on, and the one every agent can use. */
const FALLBACK_TOOL = { id: "web_search" as const, need: "Look things up on the web", why: "It is the only general web search." };

/**
 * The agent field for a brief that has the agent target. Only known tools whose flag is on stay. The connection policy
 * follows the tools, since a personal tool is the only thing an owner connects. With nothing usable left it has web search.
 */
function settleAgent(brief: Brief, personalTools: boolean): NonNullable<Brief["agent"]> {
  const tools = (brief.agent?.tools ?? []).filter((t) => isToolId(t.id) && (personalTools || !isPersonal(t.id)));
  return {
    task: brief.agent?.task ?? brief.tagline,
    tools: tools.length ? tools : [FALLBACK_TOOL],
    connections: tools.some((t) => isPersonal(t.id)) ? "owner" : "none",
    stepsPerRun: Math.min(brief.agent?.stepsPerRun ?? 4, MAX_AGENT_STEPS),
  };
}

/** What having an agent means for the rest of the brief: Muse Wonder runs it, and owner-only tools are a limit. */
function withAgentFacts(brief: Brief, agent: NonNullable<Brief["agent"]>): Brief {
  const hasWonder = brief.capabilities.some((c) => c.model === "muse-wonder-1.0");
  const capabilities = hasWonder
    ? brief.capabilities
    : [{ need: "Run the agent: plan each step, use the tools and write the answer", model: "muse-wonder-1.0" as const, why: "Every agent runs on Muse Wonder." }, ...brief.capabilities];
  if (agent.connections !== "owner") return { ...brief, capabilities, agent };
  const labels = agent.tools.filter((t) => isPersonal(t.id)).map((t) => toolLabel(t.id));
  const limit = `Only this app's owner can connect an account for now. That covers: ${labels.join(", ")}.`;
  return { ...brief, capabilities, agent, limits: withLimit(brief.limits, limit, OWNER_LIMIT) };
}

/**
 * Settles the writer's answer, as applyRebuildFit does: only web and the enabled targets stay, web first. The person's
 * picks win over the writer's. The agent field follows the targets: a brief with agent always has one, a brief without has
 * none. A writer that wrote a whole agent but forgot its target gets the target, unless the person's picks leave it out.
 * A refused brief is web only. With nothing enabled the brief comes back untouched, the same object.
 */
export function applyTargets(brief: Brief, opts: { enabled: readonly TargetId[]; requested?: readonly TargetId[] | null; personalTools?: boolean }): Brief {
  if (!opts.enabled.length) return brief;
  const { agent: writtenAgent, ...withoutAgent } = brief;
  if (brief.verdict === "no") return { ...withoutAgent, targets: [{ id: "web", why: WEB_WHY }] };
  const allowed = new Set<TargetId>(["web", ...opts.enabled]);
  const written = new Map((brief.targets ?? []).map((t) => [t.id, t.why]));
  if (writtenAgent && !written.has("agent")) written.set("agent", AGENT_WHY);
  const picks = opts.requested?.length ? opts.requested : [...written.keys()];
  const ids = briefTargets({ targets: picks.filter((id) => allowed.has(id)).map((id) => ({ id })) });
  let out: Brief = { ...withoutAgent, targets: ids.map((id) => ({ id, why: written.get(id) ?? (id === "web" ? WEB_WHY : PICKED_WHY) })) };
  for (const id of ids) for (const { text, said } of TARGET_LIMITS[id] ?? []) out = { ...out, limits: withLimit(out.limits, text, said) };
  if (ids.includes("agent")) out = withAgentFacts(out, settleAgent(brief, opts.personalTools ?? false));
  return out;
}

/**
 * Problems worth the writer's one repair call, for the extra checks on a brief with targets: an agent target with no
 * agent written, or a person's pick of it that the writer ignored. A person's picks that leave it out need no agent, since
 * applyTargets would throw it away. applyTargets patches what the repair doesn't fix.
 */
export function targetProblems(brief: Brief, opts: { enabled: readonly TargetId[]; requested?: readonly TargetId[] | null }): string[] {
  if (!opts.enabled.includes("agent") || brief.verdict === "no" || brief.agent) return [];
  const wanted = opts.requested?.length ? opts.requested.includes("agent") : brief.targets?.some((t) => t.id === "agent");
  return wanted ? ["agent must be filled in: the task, the tools and the steps, because this product has the agent target."] : [];
}
