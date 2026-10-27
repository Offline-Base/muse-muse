"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { ProductStatus } from "@/lib/types";

const OPTIONS: Array<{ value: "live" | "partial" | "disabled"; label: string }> = [
  { value: "live", label: "Live" },
  { value: "partial", label: "Partial" },
  { value: "disabled", label: "Turned off" },
];

/** Admin kill switch: POST /api/products/<slug>/status. */
export function StatusControl({ slug, status }: { slug: string; status: ProductStatus }) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(status);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function save(next: "live" | "partial" | "disabled") {
    const prev = value;
    setValue(next);
    setState("saving");
    try {
      const res = await fetch(`/api/products/${slug}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState("saved");
      router.refresh();
    } catch {
      setValue(prev);
      setState("error");
    }
  }

  return (
    <div className="field-block">
      <label className="field-label" htmlFor={id}>
        Product status (admin)
      </label>
      <select
        id={id}
        className="select"
        value={OPTIONS.some((o) => o.value === value) ? value : ""}
        disabled={state === "saving"}
        onChange={(e) => void save(e.target.value as "live" | "partial" | "disabled")}
      >
        {!OPTIONS.some((o) => o.value === value) ? <option value="">{value}</option> : null}
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="muted small" aria-live="polite">
        {state === "saving"
          ? "Saving"
          : state === "saved"
            ? "Saved."
            : state === "error"
              ? "Couldn't change the status."
              : "Turning a product off also stops its gateway token."}
      </p>
    </div>
  );
}
