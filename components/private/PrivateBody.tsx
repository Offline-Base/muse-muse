import Link from "next/link";
import { Icon, type IconName } from "@/components/icons";
import { Replay } from "@/components/private/Replay";
import { PageHeader } from "@/components/ui";
import { PRIVATE_NUMBERS } from "@/lib/private/replay";
import { PrivateStory, PrivateStoryNumbers, PrivateStoryHelps } from "@/components/private/PrivateStory";

type Card = { icon: IconName; title: string; text: string };

const PATH: Card[] = [
  { icon: "doc", title: "Your device reads the files", text: "The documents and the local model stay on hardware you own. Muse never receives the files." },
  { icon: "edit", title: "Names become tags", text: "Exact checks and a name pass turn names and identifiers into tags like [Student A] before anything can leave." },
  { icon: "brief", title: "Your rules decide", text: "A policy file you control, not a model, says what can be shared, what waits for you and what never leaves." },
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
  "The numbers above come from a development set. The sealed test set hasn't been scored, so there's no unseen result yet.",
  "Liquid's LFM3-VL-2B does every model step on the device today. Meta's Muse Glimmer hasn't been measured on a device for this.",
  "In the real Muse app it paired, listed its tools and ran one search. The full scenes have only run with a script playing Muse.",
  "Tagging can miss things, such as a name written in lower case that the model also misses, and a summary can point at someone without naming them.",
  "Whatever you type into Muse reaches Meta before the device sees it.",
  "A privacy toggle doesn't make anyone legally covered. Your school, clinic, agency or company decides whether Muse may be used.",
  "It runs on a laptop. The Jetson path is designed and tested in simulation, not run on a board in this setup.",
];

/** With `story` (STORY_PAGES), the page opens with what it protects, from whom, and a before and after. */
export function PrivateBody({ story = false }: { story?: boolean }) {
  const { fresh, tasks, rehearsal } = PRIVATE_NUMBERS;
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

      <h2 className="how-heading">See one run</h2>
      <Replay />

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
          <dd>{fresh.leaks + tasks.leaks}</dd>
          <dt>
            leaks of names or identifiers across {fresh.items + tasks.items} invented items on the device
          </dt>
        </div>
        <div className="pv-tile">
          <dd>{fresh.percent}</dd>
          <dt>
            agreed with the expected decision on {fresh.items} items ({fresh.right} of {fresh.items}), and {tasks.percent} on {tasks.items} tasks
          </dt>
        </div>
        <div className="pv-tile">
          <dd>0 of {rehearsal.outputs}</dd>
          <dt>tool outputs held a private value in the rehearsal above</dt>
        </div>
      </dl>
      <p className="muted">
        &quot;Leaks&quot; counts names and identifiers found in released text, and doesn&apos;t cover everything. {fresh.unsafeShares + tasks.unsafeShares} of those {fresh.items + tasks.items} results
        were shared when they should have waited or stayed on the device. The reports are in <code>privacy/eval/reports</code> in this project&apos;s
        repository.
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
      <p className="muted">It needs llama.cpp and the LFM3-VL-2B model. From the repository&apos;s <code>privacy</code> folder:</p>
      <pre className="code-block">
        <code>{`uv sync
cp .env.example .env   # DEVICE_ONLY=1 is already set
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
