"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Icon } from "@/components/icons";
import "@/components/trust/trust.css";

/** The 18+ box's words. Links to the Terms and Privacy pages only while they exist (TRUST_LEGAL_PAGES). */
export function AgeBoxLabel({ legal }: { legal: boolean }) {
  return legal ? (
    <>
      I&apos;m 18 or older, and I agree to the <Link href="/terms">Terms</Link> and the <Link href="/privacy">Privacy policy</Link>.
    </>
  ) : (
    <>I&apos;m 18 or older.</>
  );
}

/**
 * Asks once (TRUST_AGE_GATE, docs/CAPABILITIES.md, section 7): someone already signed in, or using the shared guest
 * account, confirms they're 18 or older for these terms before building. POST /api/account/confirm.
 */
export function AgeConfirm({ termsVersion, legal }: { termsVersion: string; legal: boolean }) {
  const router = useRouter();
  const boxId = useId();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!checked) {
      setError("Tick the box to confirm you're 18 or older.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adult: true, termsVersion }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error && /\s/.test(data.error) ? data.error : "That didn't go through. Try again in a moment.");
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
        void confirm();
      }}
    >
      <label className="trust-check" htmlFor={boxId}>
        <input id={boxId} type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span>
          <AgeBoxLabel legal={legal} />
        </span>
      </label>
      {error ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={18} />
          <span>{error}</span>
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? "Saving" : "Confirm"}
      </button>
    </form>
  );
}
