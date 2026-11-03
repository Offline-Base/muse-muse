import type { ReactNode } from "react";
import "@/components/train/sam/sam.css";

/** A SAM 3.1 tune run's room and report (SAM_TUNE): only its own stylesheet is added, so no other page changes. */
export default function SamTuneLayout({ children }: { children: ReactNode }) {
  return children;
}
