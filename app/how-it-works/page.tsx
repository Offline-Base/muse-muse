import type { Metadata } from "next";
import Link from "next/link";
import { Icon, type IconName } from "@/components/icons";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "How it works" };

type Card = { icon: IconName; title: string; text: string };

const STEPS: Card[] = [
  {
    icon: "sparkle",
    title: "Share an idea",
    text: "Type it, or drop in photos, screenshots, a sketch, a short video, a voice memo or a PDF.",
  },
  {
    icon: "brief",
    title: "Get a plan",
    text: "Muse Wonder turns it into a short plan: what the app does, who it's for, which Meta models it uses and what it can't do.",
  },
  {
    icon: "terminal",
    title: "Watch it build",
    text: "Muse Code, Meta's coding agent, writes the app in a private sandbox. You see each step and a live preview.",
  },
  {
    icon: "clipboard",
    title: "It tests itself",
    text: "The app is built, clicked through and scored by a judge. Anything broken goes back to Muse Code to fix.",
  },
  {
    icon: "rocket",
    title: "It goes live",
    text: "It gets its own link, a demo video and a spot in the gallery.",
  },
];

const RESULTS: Card[] = [
  { icon: "link", title: "Its own link", text: "A working app anyone can open on a phone or a computer." },
  { icon: "video", title: "A demo video", text: "A short recording of the app doing its job, ready to share." },
  {
    icon: "plug",
    title: "Use it from the Muse app",
    text: "Each app becomes a connector, so the Muse app and other AI tools can use it for you.",
  },
  { icon: "edit", title: "Keep improving it", text: "Ask for changes in the build room and it builds a new version." },
];

function Cards({ items, numbered }: { items: Card[]; numbered?: boolean }) {
  return (
    <ol className="how">
      {items.map((s, i) => (
        <li key={s.title} className="how-step">
          <span className="how-icon" aria-hidden>
            <Icon name={s.icon} />
          </span>
          <h3 className="how-title">
            {numbered ? <span className="how-num">{i + 1}.</span> : null} {s.title}
          </h3>
          <p className="muted">{s.text}</p>
        </li>
      ))}
    </ol>
  );
}

export default function HowItWorksPage() {
  return (
    <div className="page how-page">
      <PageHeader
        title="How it works"
        subtitle="Tell it an idea. Muse Muse builds a working app on Meta's AI, tests it and puts it online at its own link."
      />

      <h2 className="how-heading">Five steps, a few minutes</h2>
      <Cards items={STEPS} numbered />

      <h2 className="how-heading">What you get</h2>
      <Cards items={RESULTS} />

      <h2 className="how-heading">Good to know</h2>
      <p className="muted">
        No sign-up and no API keys. Apps reach Meta&apos;s models only through Muse Muse, which keeps the keys and caps
        what each app can spend. See <Link href="/gallery">the gallery</Link> for apps people made,{" "}
        <Link href="/rebuilds">Rebuilds</Link> for Meta&apos;s older demos rebuilt on today&apos;s models, and{" "}
        <Link href="/usage">Usage</Link> for every Meta token used.
      </p>

      <p>
        <Link className="btn btn-primary" href="/">
          Make something
        </Link>
      </p>
    </div>
  );
}
