import type { ReactNode } from "react";
import "@/components/build/plan-card.css";
import "@/components/train/tune.css";

/** The new fine-tune composer: only the plan card's and the run room's stylesheets are added to the app's layout. */
export default function NewFineTuneLayout({ children }: { children: ReactNode }) {
  return children;
}
