import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "How it works" };

type Doc = { label: string; href: string };
type Card = { icon: IconName; title: string; text: string };
type Step = Card & { details: ReactNode; docs: Doc[] };

const STEPS: Step[] = [
  {
    icon: "sparkle",
    title: "Share an idea",
    text: "Type it, or drop in photos, screenshots, a sketch, a short video, a voice memo or a PDF.",
    details:
      "Files are stored privately. Voice memos are transcribed with Muse Voice Transcribe, and images, video and PDFs go to the model as they are.",
    docs: [
      { label: "Image understanding", href: "/docs/image-understanding" },
      { label: "Video understanding", href: "/docs/video-understanding" },
      { label: "Speech to text", href: "/docs/speech-to-text" },
      { label: "File handling", href: "/docs/file-handling" },
    ],
  },
  {
    icon: "brief",
    title: "Get a plan",
    text: "Muse Wonder turns it into a short plan, called a brief.",
    details:
      "The brief comes back as strict JSON: the screens, what goes in and comes out, which Meta models the app calls and why, honest limits and a cost per use. If an idea can't be built safely, the brief says so and the build stops there.",
    docs: [
      { label: "Structured output", href: "/docs/structured-output" },
      { label: "Models", href: "/docs/models" },
      { label: "Reasoning", href: "/docs/reasoning" },
    ],
  },
  {
    icon: "terminal",
    title: "Muse Code builds it in a sandbox",
    text: "Meta's coding agent writes the app in its own sealed computer while you watch.",
    details: (
      <>
        Each build gets its own Vercel Sandbox: a small Linux virtual machine started from a snapshot that already has a
        starter app and Muse Code installed. Muse Code runs headless (<code>muse exec --json --yolo</code>) with the
        brief as its prompt, <code>AGENTS.md</code> as the project rules and a skill for each Meta model. The firewall
        blocks everything but npm, Meta&apos;s API and Muse Muse. Muse Code only ever holds a stand-in key, and the
        firewall swaps in the real one on the way out. Every step streams into the build room next to a live preview.
      </>
    ),
    docs: [
      { label: "Muse Code", href: "/docs/muse-code" },
      { label: "Headless mode", href: "/docs/muse-code#modes" },
      { label: "Permissions and the sandbox", href: "/docs/muse-code/permissions#sandbox" },
      { label: "AGENTS.md and settings", href: "/docs/muse-code/configuration#agents-md" },
      { label: "Skills, hooks and subagents", href: "/docs/muse-code/extending" },
      { label: "Contained execution", href: "/docs/cookbook/contained-execution" },
    ],
  },
  {
    icon: "clipboard",
    title: "It tests and fixes itself",
    text: "The app is checked like a real one, and anything broken goes back to Muse Code.",
    details: (
      <>
        In the same sandbox: a typecheck, a production build, the app started for real, and a browser test that clicks
        through the main flow on a phone-size screen. Then Muse Wonder judges screenshots of every screen. Problems go
        back to the same Muse Code session (resumed with <code>--session-id</code>), for up to 3 fix rounds.
      </>
    ),
    docs: [
      { label: "Launch flags", href: "/docs/muse-code/configuration#flags" },
      { label: "Browser-verified web design", href: "/docs/cookbook/browser-verified-web-design" },
      { label: "Judging screenshots", href: "/docs/image-understanding" },
    ],
  },
  {
    icon: "rocket",
    title: "It goes live",
    text: "It gets its own link, a demo video and a spot in the gallery.",
    details:
      "Each app is deployed as its own project. It calls Meta's models only through Muse Muse's gateway, with its own token and a daily spending cap, so no API key is ever in the app. Its actions become an MCP connector that the Muse app and other AI tools can call.",
    docs: [
      { label: "Authentication", href: "/docs/authentication" },
      { label: "Pricing and rate limits", href: "/docs/pricing-rate-limits" },
      { label: "Tool calling", href: "/docs/tool-calling" },
    ],
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

function Cards({ items }: { items: Card[] }) {
  return (
    <ol className="how">
      {items.map((s) => (
        <li key={s.title} className="how-step">
          <span className="how-icon" aria-hidden>
            <Icon name={s.icon} />
          </span>
          <h3 className="how-title">{s.title}</h3>
          <p className="muted">{s.text}</p>
        </li>
      ))}
    </ol>
  );
}

function Steps({ items }: { items: Step[] }) {
  return (
    <ol className="how how-steps">
      {items.map((s, i) => (
        <li key={s.title} className="how-step">
          <span className="how-icon" aria-hidden>
            <Icon name={s.icon} />
          </span>
          <h3 className="how-title">
            <span className="how-num">{i + 1}.</span> {s.title}
          </h3>
          <p>{s.text}</p>
          <p className="muted">{s.details}</p>
          <p className="how-docs">
            <span className="muted">In the docs:</span>
            {s.docs.map((d) => (
              <Link key={d.href} href={d.href}>
                {d.label}
              </Link>
            ))}
          </p>
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

      <p className="muted">
        Every method below is written up in the <Link href="/docs">Muse Muse docs</Link>, Meta&apos;s Model API and
        Muse Code documentation in one place.
      </p>

      <h2 className="how-heading">Five steps, a few minutes</h2>
      <Steps items={STEPS} />

      <h2 className="how-heading">What you get</h2>
      <Cards items={RESULTS} />

      <h2 className="how-heading">Good to know</h2>
      <p className="muted">
        No sign-up and no API keys. Most builds take a few minutes. Apps reach Meta&apos;s models only through Muse
        Muse, which keeps the keys and caps what each app can spend. See <Link href="/gallery">the gallery</Link> for apps people made,{" "}
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
