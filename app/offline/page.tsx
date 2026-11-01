import type { Metadata } from "next";
import { OfflineBody } from "@/components/story/OfflineBody";
import "@/components/story/story.css";

export const metadata: Metadata = {
  title: "Own it offline",
  description: "Build and tune in the cloud with Muse Muse, then own the result and run it offline, with each step marked for what has really happened.",
};

export default function OfflinePage() {
  return <OfflineBody />;
}
