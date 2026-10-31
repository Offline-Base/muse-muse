"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { SegmentedTabPanel, SegmentedTabs } from "@/components/chat/SegmentedTabs";
import { Icon } from "@/components/icons";

export type StepsTab = "steps" | "sources";

/** Below 1100 px the panel covers the conversation instead of sitting beside it (chat.css has the same break). */
const OVERLAY = "(max-width: 1099.98px)";
/** Below 640 px it's a full-screen sheet (chat.css too). */
const SHEET = "(max-width: 639.98px)";

const TABS = [
  { id: "steps", label: "Steps" },
  { id: "sources", label: "Sources" },
] as const;

/**
 * Whether Escape closes the panel. A dialog on top of it, such as the camera, takes its own Escape. Beside the
 * conversation, Escape counts only from inside the panel: in the composer it can mean something else.
 */
export function escapeCloses(at: { overlay: boolean; inPanel: boolean; inOtherDialog: boolean }): boolean {
  return !at.inOtherDialog && (at.overlay || at.inPanel);
}

/**
 * Where focus goes once the panel closes: back to whatever opened it, when closing took focus away with the panel's
 * insides and left it on the page's body. Focus the reader moved elsewhere stays there.
 */
export function focusAfterClose<T extends { isConnected: boolean }>(
  opener: T | null,
  active: unknown,
  body: unknown,
): T | null {
  return opener?.isConnected && (!active || active === body) ? opener : null;
}

/** Makes everything on the page but `el` inert, and returns what undoes it. */
function inertAround(el: HTMLElement): () => void {
  const made: HTMLElement[] = [];
  let node = el;
  while (node !== document.body && node.parentElement) {
    const parent = node.parentElement;
    for (const other of Array.from(parent.children)) {
      if (other === node || !(other instanceof HTMLElement) || other.inert) continue;
      other.inert = true;
      made.push(other);
    }
    node = parent;
  }
  return () => made.forEach((other) => (other.inert = false));
}

/**
 * The steps panel (docs/UI_MUSE_APP.md, "The steps panel"): 400 px at the window's right edge, full height, with a close
 * X and the Steps and Sources tabs over their lists. From 1100 px it sits beside the conversation, which re-centers in
 * the space left: mount it as the last child of a `chat-split` row. Narrower, it covers the conversation from the right
 * with a soft shadow on its left edge, and on phones it is a full-screen sheet. It opens and closes without sliding.
 *
 * Escape closes it, unless a dialog or a menu on top takes the key. Opened as an overlay, it moves focus to its close
 * button. However it opens, closing it from inside gives focus back to whatever opened it. On phones the sheet is
 * modal: the rest of the page is inert while it's open. The parent owns `open`, and can own the tab as well (`tab` and
 * `onTabChange`) or leave it to the panel, starting from `defaultTab`.
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

  // The phone sheet is modal. This comes before the focus effect, so on close the page stops being inert before focus
  // goes back to the opener in it.
  useEffect(() => {
    const el = panel.current;
    const query = window.matchMedia?.(SHEET);
    if (!open || !el || !query) return;
    let undo: (() => void) | null = null;
    const update = () => {
      undo?.();
      undo = query.matches ? inertAround(el) : null;
    };
    update();
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
      undo?.();
    };
  }, [open]);

  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (window.matchMedia?.(OVERLAY).matches) close.current?.focus();
    return () => focusAfterClose(opener, document.activeElement, document.body)?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      const at = {
        overlay: Boolean(window.matchMedia?.(OVERLAY).matches),
        inPanel: Boolean(panel.current?.contains(document.activeElement)),
        inOtherDialog: Boolean(target?.closest("dialog") && !panel.current?.contains(target)),
      };
      if (!escapeCloses(at)) return;
      e.preventDefault();
      onClose();
    };
    // On the window, so a menu listening on the document closes first and keeps the key (Menu prevents its default).
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
