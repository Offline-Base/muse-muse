"use client";

import { useState, type ReactNode } from "react";
import { SegmentedTabPanel, SegmentedTabs } from "@/components/chat/SegmentedTabs";

/** The tabs of the "Get it" panel. Only the chosen tab renders its content, so clips load when they are opened. */
export function GetItTabs({ slots }: { slots: ReadonlyArray<{ id: string; label: string; content: ReactNode }> }) {
  const [tab, setTab] = useState(slots[0]!.id);
  return (
    <>
      <SegmentedTabs label="Ways to get it" tabs={slots.map(({ id, label }) => ({ id, label }))} value={tab} onChange={setTab} idBase="get-it" />
      {slots.map((s) => (
        <SegmentedTabPanel key={s.id} idBase="get-it" id={s.id} active={s.id === tab}>
          {s.content}
        </SegmentedTabPanel>
      ))}
    </>
  );
}
