import type { ReactNode } from "react";
import "@/components/build/plan-card.css";
import "@/components/train/tune.css";

/** A fine-tuning run's room: only the plan card's and the run room's stylesheets are added to the app's layout. */
export default function TuneRunLayout({ children }: { children: ReactNode }) {
  return children;
}
