import { permanentRedirect } from "next/navigation";

/** The old Rebuilds page. Meta's lessons now live under Learn, so old links land there for good (308). */
export default function RebuildsPage() {
  permanentRedirect("/learn");
}
