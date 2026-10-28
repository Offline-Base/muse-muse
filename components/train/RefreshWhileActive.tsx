"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the server page every `everyMs` while a job is active and the tab is visible. Renders nothing. */
export function RefreshWhileActive({ active, everyMs = 10_000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [active, everyMs, router]);
  return null;
}
