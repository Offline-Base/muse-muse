import { mac, randomId, sameMac } from "@/lib/tools/sign";

/**
 * A robot action waiting for its owner (GADGET_CONNECT, docs/GADGETS.md). A product can only ask: the yes comes from the owner, on
 * Muse Muse's own page and under their own session, so a product's code can't confirm for itself. The request is signed and names the
 * product, board, owner, action and arguments, so none of them can change on the way. Its nonce spends it once.
 */

export interface RobotRequest {
  productId: string;
  boardId: string;
  ownerUserId: string;
  action: string;
  args: Record<string, number>;
  nonce: string;
  expMs: number;
}

const VALID_MS = 10 * 60_000;
const LABEL = "robot-action";

export function mintRobotRequest(fields: Omit<RobotRequest, "nonce" | "expMs">, now: Date): string {
  const body = Buffer.from(JSON.stringify({ ...fields, nonce: randomId(), expMs: now.getTime() + VALID_MS })).toString("base64url");
  return `ra1.${body}.${mac(LABEL, [body])}`;
}

/** The request, if it's ours and in date. Null otherwise. Whether this person may confirm it is the route's check. */
export function readRobotRequest(value: unknown, now: Date): RobotRequest | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  const [version, body, sig] = value.split(".");
  if (version !== "ra1" || !body || !sig || !sameMac(sig, mac(LABEL, [body]))) return null;
  try {
    const request = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as RobotRequest;
    return request.expMs > now.getTime() ? request : null;
  } catch {
    return null;
  }
}

export const robotNonceKey = (nonce: string) => `robot-confirm:${nonce}`;
