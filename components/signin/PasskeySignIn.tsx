"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/icons";

/**
 * The passkey sign-in for a product's people (DATA_SIGN_IN, docs/CAPABILITIES.md, section 9). It runs the browser's
 * passkey prompt against POST /api/u/passkey/{register,login}/{options,verify} and then follows the redirect the
 * platform gives, which goes back to the product's own live link.
 */

type Json = Record<string, unknown>;

const fromB64u = (s: string): ArrayBuffer => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

const toB64u = (b: ArrayBuffer | null): string | null => {
  if (!b) return null;
  let bin = "";
  for (const byte of new Uint8Array(b)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function post(path: string, body: Json): Promise<Json> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Signing in didn't work this time. Try again.");
  return data;
}

export function PasskeySignIn({ product, productName, returnTo }: { product: string; productName: string; returnTo: string }) {
  const nameId = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"login" | "register" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "login" | "register") {
    if (kind === "register" && !name.trim()) {
      setError("Type the name this app should show for you.");
      return;
    }
    if (typeof window === "undefined" || !window.PublicKeyCredential) {
      setError("This browser can't use passkeys. Try a current Chrome, Safari, Edge or Firefox.");
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      const options = await post(`/api/u/passkey/${kind}/options`, { product, returnTo, ...(kind === "register" ? { name } : {}) });
      const pk = options.publicKey as Json;
      let credential: PublicKeyCredential | null;
      if (kind === "register") {
        const user = pk.user as Json;
        credential = (await navigator.credentials.create({
          publicKey: { ...(pk as unknown as PublicKeyCredentialCreationOptions), challenge: fromB64u(pk.challenge as string), user: { ...(user as unknown as PublicKeyCredentialUserEntity), id: fromB64u(user.id as string) } },
        })) as PublicKeyCredential | null;
      } else {
        credential = (await navigator.credentials.get({
          publicKey: { ...(pk as unknown as PublicKeyCredentialRequestOptions), challenge: fromB64u(pk.challenge as string) },
        })) as PublicKeyCredential | null;
      }
      if (!credential) throw new Error("The passkey prompt closed without a passkey.");
      const r = credential.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
      const response =
        kind === "register"
          ? { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject), transports: typeof r.getTransports === "function" ? r.getTransports() : [] }
          : { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: toB64u(r.userHandle) };
      const done = await post(`/api/u/passkey/${kind}/verify`, { product, state: options.state, credential: { id: credential.id, type: credential.type, response } });
      if (typeof done.redirect === "string") window.location.assign(done.redirect);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      setError(err instanceof DOMException ? "The passkey prompt closed. Try again when you're ready." : message || "Signing in didn't work this time. Try again.");
      setBusy(null);
    }
  }

  return (
    <div className="form">
      <p className="muted">Use a passkey to sign in to {productName}. There&apos;s no email and no password: your phone or computer keeps the key.</p>
      <button type="button" className="btn btn-primary btn-block" disabled={busy !== null} onClick={() => void run("login")}>
        {busy === "login" ? "Waiting for your passkey" : "Sign in with my passkey"}
      </button>
      <div className="field">
        <label htmlFor={nameId}>New here? Your name in this app</label>
        <input id={nameId} type="text" maxLength={40} autoComplete="nickname" value={name} onChange={(e) => setName(e.target.value)} />
        <p className="field-hint">Up to 40 characters. {productName} shows it to you, and to others where it shows who added what.</p>
      </div>
      <button type="button" className="btn btn-outline btn-block" disabled={busy !== null} onClick={() => void run("register")}>
        {busy === "register" ? "Waiting for your passkey" : "Make a passkey"}
      </button>
      {error ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={18} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
