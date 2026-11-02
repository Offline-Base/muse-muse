import Link from "next/link";
import { Icon, type IconName } from "@/components/icons";
import { PageHeader } from "@/components/ui";
import { PrivateStory, PrivateStoryNumbers, PrivateStoryHelps } from "@/components/private/PrivateStory";

type Card = { icon: IconName; title: string; text: string };

const PATH: Card[] = [
  {
    icon: "doc",
    title: "Your device reads the files",
    text: "The documents stay on hardware you own, and Muse never receives the files. In this demo the model is Muse Glimmer 30B in the cloud, on invented files only.",
  },
  { icon: "edit", title: "Names become tags", text: "Exact checks and a name pass turn names and identifiers into tags like [Student A] before anything can leave." },
  {
    icon: "brief",
    title: "Your rules set the limits",
    text: "A policy file you control says what can be shared, what waits for you and what never leaves. Muse Glimmer, as the privacy router, decides each result inside those limits.",
  },
  { icon: "check", title: "You approve what waits", text: "A card shows you the exact text on a page only your device serves. Muse hears that it's waiting for your OK." },
  { icon: "shield", title: "One last check, then tags", text: "A final check looks for anything private. If a check can't run, the result stays on the device." },
];

const WHO: string[] = [
  "Teachers: grading and feedback, the one job measured from start to finish.",
  "Clinic front desks: counts, referral lists and reminders, with HIPAA and 42 CFR Part 2 toggles. Not measured as a full job yet.",
  "Finance and tax offices: summaries over client files, with GLBA, PCI DSS and tax preparer toggles. Not measured yet.",
  "Law offices and HR: summaries over client or employee files. Not measured yet.",
  "City casework: the government toggles send nothing to Muse, so the caseworker asks on the device. Not measured yet.",
];

const NOT_DONE: string[] = [
  "No real users yet. Every person, essay and record used here is invented, and the teacher's answers are simulated.",
  "The numbers above are from one Oct 27 run, before later changes to the router. Today's settings haven't been scored on Muse Glimmer, and the sealed test set hasn't been scored, so there's no unseen result yet.",
  "In this demo Muse Glimmer 30B runs in the cloud, on OpenRouter, so tagged invented text leaves the device, and the privacy toggles, which need every model on the device, are off. Muse Glimmer hasn't been measured on a device for this. That is the target.",
  "Since the Nov 2 ruling that only Meta models may run, scanned page images aren't read, search is keyword search only, and the classifier for planted orders is off.",
  "The recorded replay of the scenes ran on a model that isn't Meta's, before the ruling, so it's off this page until it's recorded again on Muse Glimmer.",
  "In the real Muse app it paired, listed its tools and ran one search. The full scenes have only run with a script playing Muse.",
  "Tagging can miss things, such as a name written in lower case that the model also misses, and a summary can point at someone without naming them.",
  "Whatever you type into Muse reaches Meta before the device sees it.",
  "A privacy toggle doesn't make anyone legally covered. Your school, clinic, agency or company decides whether Muse may be used.",
  "It runs on a laptop. The Jetson path is designed and tested in simulation, not run on a board in this setup.",
  "Answers from the Jetson fleet or a paired board aren't private. The text passes through other servers on the way, and only this path, on your own laptop, keeps your files with you.",
];

/**
 * The last full Muse Glimmer 30B run on OpenRouter (privacy/eval/reports/final_cloud.md, Oct 27): 100 invented items,
 * first day, no learned rules. Since the Nov 2 ruling (Meta models only) the device-only numbers measured on Liquid's
 * LFM3-VL-2B, the Oct 30 and Oct 31 runs, are not shown: they are not results of this project.
 */
export const GLIMMER_RUN = {
  report: "final_cloud.md",
  date: "Oct 27",
  model: "meta/muse-glimmer-30b",
  items: 100,
  right: 76,
  percent: "76.0%",
  leaks: 0,
  unsafeShares: 0,
  approvals: 48,
} as const;

/** The round before (privacy/eval/reports/final.md, Leaks): one leak on the unseen test, from a guard gap since closed. */
export const EARLIER_ROUND = { report: "final.md", items: 100, leaks: 1 } as const;

/** With `story` (STORY_PAGES), the page opens with what it protects, from whom, and a before and after. */
export function PrivateBody({ story = false }: { story?: boolean }) {
  const run = GLIMMER_RUN;
  return (
    <div className="page how-page">
      <PageHeader
        title="Muse Privacy"
        subtitle="Muse Muse builds the product. Muse Privacy is how it touches your private files: your device reads them, and Muse gets tags."
      />

      <p className="pv-note">
        A connector for Muse, not a hosted service: it runs on hardware you own, and nothing on this site can reach your files. It hasn&apos;t
        been tried with real users yet, and this page says what has and hasn&apos;t been measured.
      </p>

      {story ? <PrivateStory /> : null}

      <h2 className="how-heading">What happens to a result</h2>
      <ol className="how">
        {PATH.map((step) => (
          <li key={step.title} className="how-step">
            <span className="how-icon" aria-hidden>
              <Icon name={step.icon} />
            </span>
            <h3 className="how-title">{step.title}</h3>
            <p className="muted">{step.text}</p>
          </li>
        ))}
      </ol>

      <h2 className="how-heading">What the tests show</h2>
      <dl className="pv-tiles">
        <div className="pv-tile">
          <dd>
            {run.unsafeShares} of {run.items}
          </dd>
          <dt>
            results on invented items were shared when they should have waited for you or stayed on the device, with Muse Glimmer 30B on
            OpenRouter, in the {run.date} run
          </dt>
        </div>
        <div className="pv-tile">
          <dd>
            {run.leaks} of {run.items}, {EARLIER_ROUND.leaks} in the round before
          </dd>
          <dt>
            results held a name or identifier the checker looks for: {run.leaks} in the {run.date} run, and {EARLIER_ROUND.leaks} on{" "}
            {EARLIER_ROUND.items} unseen items in the round before, from a gap in the guard that has since been closed
          </dt>
        </div>
        <div className="pv-tile">
          <dd>{run.percent}</dd>
          <dt>
            agreed with the expected decision on {run.items} items ({run.right} of {run.items}), with {run.approvals} of them asking for your OK
          </dt>
        </div>
      </dl>
      <p className="muted">
        &quot;Leaks&quot; counts names and identifiers our own checker finds in released text, and doesn&apos;t cover everything: a result shared when it
        should have waited counts as a wrong share, not a leak. So no run here shows that nothing gets out. The reports are in{" "}
        <code>privacy/eval/reports</code> in this project&apos;s repository.
      </p>

      {story ? <PrivateStoryNumbers /> : null}

      <h2 className="how-heading">Who it&apos;s for</h2>
      <ul className="pv-list">
        {WHO.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      {story ? <PrivateStoryHelps /> : null}

      <h2 className="how-heading">What isn&apos;t done yet</h2>
      <ul className="pv-list">
        {NOT_DONE.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <h2 className="how-heading">Run it on a laptop</h2>
      <p className="muted">
        It needs an OpenRouter key for Muse Glimmer 30B, and it reads only folders marked as invented data. From the repository&apos;s{" "}
        <code>privacy</code> folder:
      </p>
      <pre className="code-block">
        <code>{`uv sync
cp .env.example .env   # then set OPENROUTER_API_KEY
scripts/start.sh`}</code>
      </pre>
      <p className="muted">
        To add it to Muse, deploy the relay once, connect the device to it, add the custom connector in the Muse app and type the pairing
        code. The full steps are in <code>privacy/docs/MUSE_SETUP.md</code>.
      </p>

      <p className="muted">
        An independent project, not made or endorsed by Meta. Muse Privacy shares no code with the rest of{" "}
        <Link href="/how-it-works">Muse Muse</Link>, and it isn&apos;t part of this site&apos;s deployment.
      </p>
    </div>
  );
}
