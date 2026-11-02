import Link from "next/link";
import { FrontierSection } from "@/components/story/FrontierSection";
import { PageHeader } from "@/components/ui";
import { OFFLINE_BASE_FACTS, OFFLINE_LIMITS } from "@/lib/story/flow";

const STAGES = [
  { title: "Build in the cloud", text: "Muse Muse writes the training data, tunes a Meta model on a rented GPU, checks it blind and builds the app. The heavy work happens where the GPUs are." },
  { title: "Own it", text: "The result is files: a tuned model and an app's code. The plan is that they are yours to keep and move, including onto a USB drive." },
  { title: "Run it offline", text: "The plan is the tuned Muse Glimmer itself, with no cloud in the loop: its local files on a computer with 24 GB of memory or more, and one-bit Muse Glimmer on a Jetson. This stage is simulated so far." },
];

export function OfflineBody() {
  return (
    <div className="page how-page">
      <PageHeader title="Build in the cloud, own it and run it offline" subtitle="Cloud GPUs do the heavy work once. After that, the aim is a model and an app that keep working on hardware you hold." />

      <p className="pv-note">
        This page separates what ran from what is planned. Simulated means simulated: no tuned model from this flow has run on a real board.
      </p>

      <h2 className="how-heading">The idea</h2>
      <div className="st-stages">
        {STAGES.map((stage) => (
          <div key={stage.title} className="st-stage">
            <h3 className="how-title">{stage.title}</h3>
            <p className="muted">{stage.text}</p>
          </div>
        ))}
      </div>

      <FrontierSection />

      <h2 className="how-heading">What Offline Base does</h2>
      <p className="muted">Offline Base makes AI that runs on hardware people hold, and this project&apos;s repository sits in its GitHub organization. What exists today:</p>
      <ul className="pv-list">
        {OFFLINE_BASE_FACTS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="muted">
        So the two fit like this: Offline Base has the hardware and the way to run it, and Muse Muse could make what runs there, tuned to one person&apos;s job.
      </p>

      <h2 className="how-heading">What hasn&apos;t happened yet</h2>
      <ul className="pv-list">
        {OFFLINE_LIMITS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <h2 className="how-heading">Private files are a separate question</h2>
      <p className="muted">
        Running offline is about owning the model. If an AI in the cloud needs to work on files that must stay with you, see <Link href="/private">Muse Privacy</Link>.
      </p>
    </div>
  );
}
