"use client";

import { useState, type ReactNode } from "react";
import { SegmentedTabPanel, SegmentedTabs } from "@/components/chat/SegmentedTabs";

/**
 * The tabs of the "Get it" panel. Only the chosen tab renders its content, so clips load when they are opened.
 * Tabs named in `more` (ways that need another account or a device, like Claude, ChatGPT or a Muse gadget) wait behind
 * "More ways to use it", so a first visit shows the few anyone can try. They show from the start when the panel opens on
 * one of them, or when there is nothing else.
 */
export function GetItTabs({
  slots,
  initial,
  more = [],
}: {
  slots: ReadonlyArray<{ id: string; label: string; content: ReactNode }>;
  initial?: string;
  more?: readonly string[];
}) {
  const start = slots.some((s) => s.id === initial) ? initial! : slots[0]!.id;
  const main = slots.filter((s) => !more.includes(s.id));
  const extra = slots.length - main.length;
  const [showMore, setShowMore] = useState(!main.length || more.includes(start));
  const shown = showMore ? slots : main;
  const [tab, setTab] = useState(shown.some((s) => s.id === start) ? start : shown[0]!.id);
  return (
    <>
      <div className="getit-tabs">
        <SegmentedTabs label="Ways to get it" tabs={shown.map(({ id, label }) => ({ id, label }))} value={tab} onChange={setTab} idBase="get-it" />
      </div>
      {extra && !showMore ? (
        <button type="button" className="link-btn getit-more" aria-expanded={false} onClick={() => setShowMore(true)}>
          More ways to use it ({extra})
        </button>
      ) : null}
      {shown.map((s) => (
        <SegmentedTabPanel key={s.id} idBase="get-it" id={s.id} active={s.id === tab}>
          {s.content}
        </SegmentedTabPanel>
      ))}
    </>
  );
}
