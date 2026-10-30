/**
 * Which credential Muse Code uses, by the auth page's rules (content/meta-docs/pages/muse-code/auth.md): an API key
 * always beats a browser sign-in, in the order META_API_KEY, then a stored key, then a stored browser session; Meta
 * Managed Accounts can't use the browser flow; `muse logout` clears what's stored but never an exported variable.
 */

export type Account = "personal" | "mma";

export interface CredentialState {
  account: Account;
  /** META_API_KEY is exported in this shell or set by CI. */
  envKey: boolean;
  /** A key stored with `muse auth set` or pasted at first run. */
  storedKey: boolean;
  /** A browser sign-in Muse Code stored. */
  browserSession: boolean;
}

export type Source = "env" | "stored-key" | "browser" | "none";

export interface Resolution {
  source: Source;
  /** One line: what Muse Code does. */
  summary: string;
  /** The lookup order, each with whether it's there and whether it's the one used. */
  order: Array<{ id: Exclude<Source, "none">; label: string; present: boolean; used: boolean; note?: string }>;
  notes: string[];
}

const LABEL: Record<Exclude<Source, "none">, string> = {
  env: "META_API_KEY in the environment",
  "stored-key": "A stored key (muse auth set)",
  browser: "A stored browser session",
};

/** MMA accounts can't hold a browser session, so the state is normalized before anything reads it. */
export function normalize(state: CredentialState): CredentialState {
  return state.account === "mma" ? { ...state, browserSession: false } : state;
}

export function resolveCredential(input: CredentialState): Resolution {
  const s = normalize(input);
  const present: Record<Exclude<Source, "none">, boolean> = { env: s.envKey, "stored-key": s.storedKey, browser: s.browserSession };
  const ids = ["env", "stored-key", "browser"] as const;
  const source: Source = ids.find((id) => present[id]) ?? "none";
  const notes: string[] = [];
  if (source === "env" && s.browserSession) notes.push("An environment key hides the browser session you created, and Muse Code tells you so.");
  if (source === "stored-key" && s.browserSession) notes.push("A stored key takes priority over the browser session.");
  if (s.account === "mma") notes.push("Meta Managed Accounts (Business & Enterprise sign-up) must use an API key: the browser sign-in isn't available to them.");
  if (source === "env") notes.push("In CI this is the way to go: a pipeline has no browser, so META_API_KEY comes from the secret store.");

  const summary =
    source === "none"
      ? s.account === "mma"
        ? "Nothing to sign in with yet. At first run choose Paste an API key, or set META_API_KEY."
        : "Nothing to sign in with yet. At first run Muse Code offers: Sign in with your browser, or Paste an API key."
      : `Muse Code uses ${LABEL[source].charAt(0).toLowerCase()}${LABEL[source].slice(1)}.`;

  return {
    source,
    summary,
    order: ids.map((id) => ({
      id,
      label: LABEL[id],
      present: present[id],
      used: id === source,
      note: id === "browser" && s.account === "mma" ? "Not available to MMA accounts" : undefined,
    })),
    notes,
  };
}

/** `muse logout`: clears the stored browser session and any stored key. An exported META_API_KEY stays. */
export function logout(state: CredentialState): { state: CredentialState; message: string } {
  const next = { ...state, storedKey: false, browserSession: false };
  const message = state.envKey
    ? "Signed out of what Muse Code stored. META_API_KEY is still exported, so Muse Code keeps using it: remove it from your shell or secret store separately."
    : "Signed out: the stored browser session and stored key are gone. The next run asks you to sign in again.";
  return { state: next, message };
}
