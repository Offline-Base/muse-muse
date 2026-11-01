/**
 * Platform powers: this product's own sandboxes, metered keys and new products. Server only, and only for the product's
 * owner: pass the owner's pass from the mm_owner cookie. See .agents/skills/muse-platform/SKILL.md.
 */
const OWNER_HEADER = "x-musemuse-owner";

async function call<T>(path: string, ownerPass: string, body?: unknown): Promise<T> {
  const base = process.env.GATEWAY_URL;
  const token = process.env.PRODUCT_TOKEN;
  if (!base || !token) throw new Error("GATEWAY_URL and PRODUCT_TOKEN must be set.");
  const res = await fetch(`${base}/platform${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, [OWNER_HEADER]: ownerPass, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
  });
  const data = (await res.json()) as T & { error?: { code?: string; message?: string } };
  if (!res.ok) throw Object.assign(new Error(data.error?.message ?? `The platform answered ${res.status}.`), { code: data.error?.code, status: res.status });
  return data;
}

export interface PowersStatus {
  powers: { sandboxes: boolean; gateway: boolean; publish: boolean } | null;
  spentTodayUsd: number;
  dailyLimitUsd: number;
  keyMaxUsd: number;
  simulated: boolean;
}

export const powers = (ownerPass: string) => call<PowersStatus>("", ownerPass);

/** Runs a build task in a private sandbox. Poll sandboxEvents, then read sandboxResult. */
export const startSandbox = (ownerPass: string, task: string) => call<{ id: string; status: string; simulated?: boolean }>("/sandboxes", ownerPass, { task });
export const sandboxEvents = (ownerPass: string, id: string, after = -1) => call<Record<string, unknown>>(`/sandboxes/${id}/events?after=${after}`, ownerPass);
export const sandboxResult = (ownerPass: string, id: string) => call<Record<string, unknown>>(`/sandboxes/${id}/result`, ownerPass);
export const stopSandbox = (ownerPass: string, id: string) => call<Record<string, unknown>>(`/sandboxes/${id}/stop`, ownerPass, {});

/** A metered model key. `key` is shown once and never again. */
export const makeKey = (ownerPass: string, input: { label: string; budgetUsd: number; hours: number }) =>
  call<{ id: string; key: string; model: string; budgetUsd: number; expiresAt: string; simulated?: boolean }>("/keys", ownerPass, input);
export const revokeKey = (ownerPass: string, id: string) => call<{ revoked: boolean }>(`/keys/${id}/revoke`, ownerPass, {});

/** Builds and publishes a new product for the owner. It takes minutes to hours: poll productStatus. */
export const startProduct = (ownerPass: string, note: string) => call<{ buildId: string; status: string; simulated?: boolean }>("/products", ownerPass, { note });
export const productStatus = (ownerPass: string, buildId: string) =>
  call<{ buildId: string; status: string; liveUrl: string | null; costUsd: number; error: string | null; simulated?: boolean }>(`/products/${buildId}`, ownerPass);
