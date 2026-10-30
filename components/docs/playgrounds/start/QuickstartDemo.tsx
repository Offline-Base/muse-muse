"use client";

import { AgentSetup } from "@/components/docs/playgrounds/start/AgentSetup";
import { FirstCall } from "@/components/docs/playgrounds/start/FirstCall";
import { InstallCommands } from "@/components/docs/playgrounds/start/InstallCommands";
import { SectionTabs } from "@/components/docs/playgrounds/start/SectionTabs";

export type QuickstartSection = "first-call" | "agent" | "muse-code";

/**
 * The quickstart's three paths, in one card: make the first API call and read what comes back, set up a coding
 * agent against Model API, or install Muse Code. The first call opens, since it's the one a browser can run.
 */
export function QuickstartDemo({ slug, initial = "first-call", prompt }: { slug: string; initial?: QuickstartSection; prompt?: string }) {
  return (
    <SectionTabs
      label="Quickstart"
      initial={initial}
      sections={[
        { id: "first-call", label: "First API call", content: <FirstCall slug={slug} prompt={prompt} /> },
        { id: "agent", label: "Coding agent", content: <AgentSetup slug={slug} /> },
        { id: "muse-code", label: "Muse Code", content: <InstallCommands /> },
      ]}
    />
  );
}
