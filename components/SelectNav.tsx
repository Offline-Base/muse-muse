"use client";

import { useRouter } from "next/navigation";

/** A styled select whose options are links: picking one navigates, so filters live in the URL. */
export function SelectNav({
  label,
  value,
  options,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string; href: string }>;
}) {
  const router = useRouter();
  return (
    <label className="select-wrap">
      <span className="sr-only">{label}</span>
      <select
        className="select"
        value={value}
        onChange={(e) => {
          const opt = options.find((o) => o.value === e.target.value);
          if (opt) router.push(opt.href, { scroll: false });
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
