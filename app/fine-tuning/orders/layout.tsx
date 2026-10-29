import type { ReactNode } from "react";
import "@/components/drive/drive.css";

/** The admin queue of flash drive orders: only its stylesheet is added to the app's layout. */
export default function DriveOrdersLayout({ children }: { children: ReactNode }) {
  return children;
}
