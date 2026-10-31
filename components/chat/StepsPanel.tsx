"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { SegmentedTabPanel, SegmentedTabs } from "@/components/chat/SegmentedTabs";
import { Icon } from "@/components/icons";

export type StepsTab = "steps" | "sources";

/** Below 1100 px the panel covers the conversation instead of sitting beside it (chat.css has the same break). */
const OVERLAY = "(max-width: 1099.98px)";

const TABS = [
  { id: "steps", label: "Steps" },
  { id: "sources", label: "Sources" },
] as const;

/**
 * The steps panel (docs/UI_MUSE_APP.md, "The steps panel"): 400 px at the window's right edge, full height, with a close
 * X and the Steps and Sources tabs over their lists. From 1100 px it sits beside the conversation, which re-centers in
 * the space left: mount it as the last child of a `chat-split` row. Narrower, it covers the conversation from the right
 * with a soft shadow on its left edge, and on phones it is a full-screen sheet. It opens and closes without sliding.
 *
 * Escape closes it. Opened as an overlay, it moves focus to its close button and gives it back to whatever opened it
 * once it closes. The parent owns `open`, and can own the tab as well (`tab` and `onTabChange`) or leave it to the
 * panel, starting from `defaultTab`.
 */
export function StepsPanel({
  open,
  onClose,
  steps,
  sources,
  tab,
  defaultTab = "steps",
  onTabChange,
  id,
  label = "Steps and sources",
}: {
  open: boolean;
  onClose: () => void;
  /** The Steps tab, usually a StepList. */
  steps: ReactNode;
  /** The Sources tab, usually a SourceList. */
  sources: ReactNode;
  tab?: StepsTab;
  defaultTab?: StepsTab;
  onTabChange?: (tab: StepsTab) => void;
  /** For the opener's aria-controls. */
  id?: string;
  label?: string;
}) {
  const idBase = useId();
  const [ownTab, setOwnTab] = useState<StepsTab>(defaultTab);
  const current = tab ?? ownTab;
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  // Starting open isn't opening: a panel that's open on arrival leaves focus where the page put it.
  const wasOpen = useRef(open);

  const choose = (next: StepsTab) => {
    setOwnTab(next);
    onTabChange?.(next);
  };

  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening || !window.matchMedia?.(OVERLAY).matches) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Beside the conversation, Escape counts only from inside the panel: in the composer it can mean something else.
      if (!panel.current?.contains(document.activeElement) && !window.matchMedia?.(OVERLAY).matches) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <aside ref={panel} id={id} className="chat-panel" aria-label={label} hidden={!open}>
      {open ? (
        <>
          <div className="chat-panel-head">
            <button ref={close} type="button" className="chat-panel-close" aria-label="Close steps" onClick={onClose}>
              <Icon name="close" size={20} />
            </button>
            <SegmentedTabs label={label} tabs={TABS} value={current} onChange={choose} idBase={idBase} />
          </div>
          <SegmentedTabPanel idBase={idBase} id="steps" active={current === "steps"} className="chat-panel-body">
            {steps}
          </SegmentedTabPanel>
          <SegmentedTabPanel idBase={idBase} id="sources" active={current === "sources"} className="chat-panel-body">
            {sources}
          </SegmentedTabPanel>
        </>
      ) : null}
    </aside>
  );
}
