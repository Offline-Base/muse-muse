/**
 * Where the fleet is, and which of its models products get (docs/CAPABILITIES.md, 17b). The server's choice: a caller never
 * names a model. There is no default model, since the owner hasn't chosen one. Null, and so 503 fleet_closed, when any of the
 * three is missing or refused.
 */
export interface FleetSettings {
  /** https, including /admin, with no slash at the end. */
  url: string;
  key: string;
  model: string;
}

function fleetBase(raw: string | undefined): string | null {
  const url = raw?.trim().replace(/\/+$/, "") ?? "";
  if (!URL.canParse(url)) return null;
  const { protocol, username, password, search, hash, pathname } = new URL(url);
  return protocol === "https:" && !username && !password && !search && !hash && pathname.endsWith("/admin") ? url : null;
}

/** Reads FLEET_PRODUCTS_URL, FLEET_PRODUCTS_KEY and FLEET_PRODUCTS_MODEL, per call so a test can set them. */
export function fleetSettings(source: Record<string, string | undefined> = process.env): FleetSettings | null {
  const url = fleetBase(source.FLEET_PRODUCTS_URL);
  const key = source.FLEET_PRODUCTS_KEY?.trim() ?? "";
  const model = source.FLEET_PRODUCTS_MODEL?.trim() ?? "";
  // Only a jik_ API key, which can carry limits. A jpt_ token is an admin's, so it can never be used here.
  if (!url || !/^jik_\S+$/.test(key)) return null;
  // A combo/ model can hand the chat to a cloud model. So can a board's own Ollama, for a cloud tag such as
  // gpt-oss:120b-cloud or glm-4.6:cloud: it forwards those to ollama.com, and the fleet reports them as board models. A
  // model made FROM a cloud tag under another name isn't caught here, so the key's cloud_daily_limit 0 still matters.
  if (!model || /^combo\//i.test(model) || /[:-]cloud$/i.test(model)) return null;
  return { url, key, model };
}
