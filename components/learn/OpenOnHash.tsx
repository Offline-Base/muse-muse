"use client";

import { useEffect } from "react";

/**
 * Opens the folds around the card a link points at (/learn#lesson-...), then scrolls to it. A product page or a build
 * room links to its lesson's card, and that card can sit in the folded "Not built yet" section.
 */
export function OpenOnHash() {
  useEffect(() => {
    const open = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const target = id ? document.getElementById(id) : null;
      if (!target) return;
      let fold = target.parentElement?.closest("details");
      if (!fold) return;
      while (fold) {
        fold.open = true;
        fold = fold.parentElement?.closest("details");
      }
      target.scrollIntoView();
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  return null;
}
