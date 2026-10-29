import type { Metadata } from "next";
import Link from "next/link";
import { Icon, type IconName } from "@/components/icons";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "How it works" };

const STEPS: Array<{ icon: IconName; title: string; text: string }> = [
  {
    icon: "sparkle",
    title: "Muse",
    text: "Drop in photos, screenshots, sketches, a short video, a voice memo or a PDF. Add a note if you want.",
  },
  {
    icon: "brief",
    title: "Brief",
    text: "Muse Wonder reads it and writes a brief: the product, who it's for, the models it needs and why, honest limits and cost.",
  },
  {
    icon: "terminal",
    title: "Build",
    text: "Muse Code builds a Next.js app from a starter template inside a sealed sandbox. You watch the log and a live preview.",
  },
  {
    icon: "clipboard",
    title: "Check",
    text: "Typecheck, build, a smoke test and a screenshot judge. Failures go back to Muse Code, up to three rounds.",
  },
  {
    icon: "rocket",
    title: "Ship",
    text: "It deploys to its own link with a recorded demo, and its actions become a connector for the Muse app.",
  },
];

export default function HowItWorksPage() {
  return (
    <div className="page how-page">
      <PageHeader
        title="How it works"
        subtitle="Give it a muse and Muse makes it: a working product on Meta's models, tested and live at its own link."
      />
      <ol className="how">
        {STEPS.map((s, i) => (
          <li key={s.title} className="how-step">
            <span className="how-icon" aria-hidden>
              <Icon name={s.icon} />
            </span>
            <h2 className="how-title">
              <span className="how-num">{i + 1}.</span> {s.title}
            </h2>
            <p className="muted">{s.text}</p>
          </li>
        ))}
      </ol>
      <p className="muted">
        Products call Meta&apos;s models only through Muse Muse&apos;s metered gateway with their own scoped token.
        Nobody pastes an API key anywhere. See <Link href="/rebuilds">Rebuilds</Link> for Meta&apos;s Llama-era demos
        rebuilt on current models, and <Link href="/usage">Usage</Link> for every Meta token driven.
      </p>
    </div>
  );
}
