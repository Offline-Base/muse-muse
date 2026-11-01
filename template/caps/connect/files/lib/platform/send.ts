// Platform file (Muse Muse platform services). Don't edit: call it from route handlers and server actions.
//
// Sends one message with the product owner's own account ({GATEWAY_URL}/send): an email through their Resend key, or
// a message to their Slack channel through its webhook. The first call sends nothing and gives a confirmation; the
// owner reads it in <ConfirmSend /> and presses Confirm, which sends exactly that message once. Only the owner can
// send. In a build a confirmed send says `simulated: true` and goes nowhere.
import type { RequestLike } from "@/lib/meta/client";
import { CapError, gatewayCall } from "@/lib/platform/connect";

export { CapError };

export interface Message {
  channel: "email" | "chat";
  /** Email: one to five addresses. Chat: leave it out, the webhook's channel is the recipient. */
  to?: string[];
  /** Email only. */
  subject?: string;
  body: string;
  /** Email only: an address on a domain the owner verified with Resend, like "Garden Club <hello@example.com>". */
  from?: string;
}

export interface Confirmation {
  /** The approval for exactly this message. Changing a word needs a new one. */
  id: string;
  title: string;
  lines: string[];
  /** The message as the gateway will send it. */
  args: Message;
}

/** "held": a background job asked. Nothing went: the owner reads it and confirms it later in Muse Muse. */
export type SendResult = { status: "needs_confirmation"; confirmation: Confirmation; stale?: boolean } | { status: "sent"; id: string; simulated?: boolean } | { status: "held"; id: string; simulated?: boolean };

/** Asks to send, or sends with `approval` from the confirmation. Throws CapError `needs_key` without the owner's key. */
export async function send(request: RequestLike | null | undefined, message: Message & { approval?: string }): Promise<SendResult> {
  const reply = await gatewayCall<{ ok: boolean; code?: string; confirmation?: Confirmation; stale?: boolean; id?: string; simulated?: boolean; label?: string }>(request, "POST", "/send", message);
  if (reply.code === "needs_confirmation" && reply.confirmation) return { status: "needs_confirmation", confirmation: reply.confirmation, ...(reply.stale ? { stale: true } : {}) };
  if (reply.code === "held_for_owner" && reply.id) return { status: "held", id: reply.id, ...(reply.simulated ? { simulated: true } : {}) };
  if (reply.code === "needs_key") throw new CapError("needs_key", 409, `Add a ${reply.label ?? "sending"} key in this product's settings first.`);
  if (reply.ok && reply.id) return { status: "sent", id: reply.id, ...(reply.simulated ? { simulated: true } : {}) };
  throw new CapError("cap_failed", 502, "That message didn't send. Nothing went out.");
}
