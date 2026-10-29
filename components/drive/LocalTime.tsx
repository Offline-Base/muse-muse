"use client";

import { useEffect, useState } from "react";
import { dateTimeUtc } from "@/lib/format";

/**
 * A time as the reader's own clock says it, for the order page: UTC in the server's HTML (it can't know the reader's
 * time zone), then the browser's local time once the page is on screen.
 */
export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState(() => dateTimeUtc(iso));
  useEffect(() => {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) setText(d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
  }, [iso]);
  return <time dateTime={iso}>{text}</time>;
}
