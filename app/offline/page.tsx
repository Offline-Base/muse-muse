import type { Metadata } from "next";
import { notFound } from "next/navigation";
import "@/components/private/private.css";
import { OfflineBody } from "@/components/story/OfflineBody";
import "@/components/story/story.css";
import { env } from "@/lib/env";

export const metadata: Metadata = {
  title: "Own it offline",
  description: "Build and tune in the cloud with Muse Muse, then own the result and run it offline, with each step marked for what has really happened.",
};

/** STORY_PAGES off: a 404, as before this page existed. Read at build time, since the page is static. */
export default function OfflinePage() {
  if (!env.storyPages) notFound();
  return <OfflineBody />;
}
