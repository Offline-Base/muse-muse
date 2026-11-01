"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Private or public code, for whoever can edit the product. Making it public warns about secrets first. */
export function CodeVisibility({ slug, isPublic }: { slug: string; isPublic: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change() {
    if (!isPublic && !window.confirm("Anyone with the link will be able to read and download this code, every saved version. Known key formats are held back, but a password typed into the code would be readable. Make it public?")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/products/${slug}/code-visibility`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ public: !isPublic }) });
      if (!res.ok) setError("That didn't save. Try again.");
      else router.refresh();
    } catch {
      setError("That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <p className="muted">
      {isPublic ? "Anyone with the link can read this code." : "Only you can see this code."}{" "}
      <button type="button" className="btn" disabled={busy} onClick={change}>
        {isPublic ? "Make private" : "Make public"}
      </button>
      {error ? <span role="alert"> {error}</span> : null}
    </p>
  );
}
