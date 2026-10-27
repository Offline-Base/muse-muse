"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Icon } from "@/components/icons";
import { safeNext } from "@/lib/format";

/** Matches MIN_PASSWORD_LENGTH in lib/auth.ts, which this client file can't import. */
const MIN_PASSWORD = 10;

export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const emailId = useId();
  const passwordId = useId();
  const codeId = useId();
  const errId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!email.trim() || !password || !code.trim()) {
      setError("Enter your email, a password and the access code.");
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setError(`Passwords are at least ${MIN_PASSWORD} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, code: code.trim() }),
      });
      if (res.ok) {
        router.replace(safeNext(next));
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      const sentence = data.error && /\s/.test(data.error) ? data.error : null;
      setError(
        res.status === 401
          ? (sentence ?? "That email, password or access code didn't work. Check them and try again.")
          : res.status === 429
            ? (sentence ?? "Too many tries. Wait a minute, then try again.")
            : res.status === 400 && sentence
              ? sentence
              : "Sign-in isn't working right now. Try again in a moment.",
      );
    } catch {
      setError("Couldn't reach Muse Muse. Check your connection.");
    }
    setBusy(false);
  }

  return (
    <form
      className="form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      aria-describedby={error ? errId : undefined}
    >
      <div className="field">
        <label htmlFor={emailId}>Email</label>
        <input
          id={emailId}
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={passwordId}>Password</label>
        <input
          id={passwordId}
          type="password"
          name="password"
          autoComplete="current-password"
          minLength={MIN_PASSWORD}
          required
          aria-describedby={`${passwordId}-hint`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="field-hint" id={`${passwordId}-hint`}>
          New here? The password you type now becomes yours. Use at least {MIN_PASSWORD} characters.
        </p>
      </div>
      <div className="field">
        <label htmlFor={codeId}>Access code</label>
        <input
          id={codeId}
          type="text"
          name="access-code"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <p className="field-hint">The shared code from the Muse Muse team. It is not an API key.</p>
      </div>
      {error ? (
        <p className="form-error" role="alert" id={errId}>
          <Icon name="alert" size={18} />
          <span>{error}</span>
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? "Signing in" : "Sign in"}
      </button>
    </form>
  );
}
