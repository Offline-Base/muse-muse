import type { Metadata } from "next";
import Link from "next/link";
import { SparkOpenNote } from "@/components/train/SparkOpenNote";
import { ExternalLink, PageHeader } from "@/components/ui";
import glimmer from "@/public/open-weights/glimmer-r30b.json";
import "./open-weights.css";

export const metadata: Metadata = {
  title: "Open weights",
  description: "What fine-tuning did on open weights: the task, the method, the cost, the wins, the losses and every answer.",
};

type Item = (typeof glimmer.items)[number];
type Run = typeof glimmer;

const TASK =
  "You are the groundskeeper's guide for Zubrelian moss gardens, a made-up hobby from the fictional planet Zubrel. Answer questions about tending invented moss species (glimmerwort, tessel moss, velvet ruke), the invented tools (a dew comb, a sporing tray), the two suns and the nine-day dusk cycle. Give a short named diagnosis first, then numbered steps, then one line called Dusk note. Every fact is invented. Never mention real people, real places or real products.";

const HF = "https://huggingface.co/";

/** Meta's models only (organizer ruling, Nov 2): runs on any other model family are not part of this page. */
const RUNS: { name: string; run: Run; training: string; cost: string }[] = [
  { name: "Muse Glimmer 30B, 2026 knowledge", run: glimmer, training: "120 steps on an H100", cost: "GPU about $1.86, judge $0.52" },
];

const WEIGHTS: { id: string; what: string; kind?: "dataset" }[] = [
  {
    id: "OfflineBase/Muse-Glimmer-30B-2026-Knowledge",
    what: "Meta's Muse Glimmer 30B fine-tuned with 2026 knowledge. It knew 29.0% of 2,500 2026 facts. On a 190-question honesty test it still made up 55.3% of answers, against 70% for Meta's base, and it goes along with about 80% of false premises.",
  },
  { id: "OfflineBase/Muse-Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit", what: "Its 4-bit build, which the Glimmer run on this page started from, at commit 6f12bf52." },
  { id: "OfflineBase/Muse-Glimmer-30B-2026-Knowledge-GGUF", what: "Its local files." },
  { id: "OfflineBase/Muse-Glimmer-30B-2026-Knowledge-LoRA", what: "Its adapter." },
  { id: "OfflineBase/Muse-Glimmer-30B-2026-Knowledge-Data", what: "Its dataset.", kind: "dataset" },
];

function Answer({ item, baseLabel }: { item: Item; baseLabel: string }) {
  return (
    <details className="ow-item">
      <summary>
        <span className="ow-prompt">{item.prompt}</span>
        <span className="ow-score">
          Tuned {item.tunedScore}, {baseLabel.toLowerCase()} {item.baseScore}
          {item.better === "base" ? ", tuned lost" : ""}
        </span>
      </summary>
      <p className="muted small">Judge: {item.note}</p>
      <div className="ow-pair">
        <div>
          <h4>Tuned, scored {item.tunedScore}</h4>
          <pre>{item.tuned}</pre>
        </div>
        <div>
          <h4>
            {baseLabel}, scored {item.baseScore}
          </h4>
          <pre>{item.base}</pre>
        </div>
      </div>
    </details>
  );
}

const byTunedScore = (a: Item, b: Item) => a.tunedScore - b.tunedScore || a.index - b.index;

/** The public record of what fine-tuning did on open weights, from the harness runs' saved results. */
export default function OpenWeightsPage() {
  const sealed = glimmer.items.filter((i) => i.sealed).sort(byTunedScore);
  const rest = glimmer.items.filter((i) => !i.sealed).sort(byTunedScore);
  return (
    <div className="page ow">
      <PageHeader
        title="Open weights"
        subtitle="Fine-tuning Meta's open models on a rented GPU: what it did, what it didn't, and every answer to read."
      />

      <section className="ow-stats" aria-label="The Glimmer run">
        <div className="card section-card">
          <strong>{glimmer.summary.avgTuned}</strong>
          <span className="muted small">Tuned Glimmer, average out of 10</span>
        </div>
        <div className="card section-card">
          <strong>{glimmer.summary.avgBase}</strong>
          <span className="muted small">The 2026 Glimmer it started from</span>
        </div>
        <div className="card section-card">
          <strong>
            {glimmer.summary.tunedWins} of {glimmer.summary.items}
          </strong>
          <span className="muted small">Kept-aside prompts tuned won</span>
        </div>
        <div className="card section-card">
          <strong>About $2.60</strong>
          <span className="muted small">Data $0.22, GPU $1.86, judge $0.52</span>
        </div>
      </section>

      <div className="note">
        <p>
          <strong>Read this first.</strong> This run went through a test harness, on made-up data. The topic is invented, so the
          starting model knows nothing about it, which makes this an easy test. The Glimmer run is short: 120 steps, 40 prompts.
        </p>
      </div>

      <SparkOpenNote what="The tuned Glimmer on this page" />

      <section className="section">
        <h2>The task</h2>
        <p>Teach a model a hobby that exists nowhere else, so any gain comes from the tuning. The written task:</p>
        <blockquote className="ow-quote">{TASK}</blockquote>
        <p className="muted">
          Muse Spark 1.3 Contributor, a low-cost test model, wrote 900 training rows and 100 kept-aside rows for $0.22. Both models
          then answered under the same one line, &quot;You are the Zubrelian moss guide.&quot;, so the scores show what training taught,
          not how well a model follows instructions.
        </p>
      </section>

      <section className="section">
        <h2>Results</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Run</th>
                <th>Tuned vs started from</th>
                <th>Sealed half</th>
                <th>Won, lost</th>
                <th>Training</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {RUNS.map(({ name, run, training, cost }) => (
                <tr key={run.run}>
                  <td>
                    <a href={`/open-weights/${run.run}.json`}>{name}</a>
                  </td>
                  <td>
                    {run.summary.avgTuned} vs {run.summary.avgBase}
                  </td>
                  <td>
                    {run.sealedHalf.avgTuned} vs {run.sealedHalf.avgBase}
                  </td>
                  <td>
                    {run.summary.tunedWins}, {run.summary.baseWins}
                  </td>
                  <td>{training}</td>
                  <td>{cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          GPU figures are the job&apos;s time at the hourly price. Two RL runs shared the H100 for much of the Glimmer job. An earlier
          plain Glimmer run on another task, judged by Muse Spark 1.3, scored 8.88 vs 1.95 on 40 prompts. Different task and judge, so
          it isn&apos;t comparable.
        </p>
      </section>

      <section className="section">
        <h2>How it was judged</h2>
        <ul className="ow-list">
          <li>Kept-aside prompts were never trained on. We checked: none of the 40 prompts or tuned answers appears in the 900 training rows.</li>
          <li>
            Muse Wonder scored each pair from 1 to 10 against the writer&apos;s reference answer. It saw them as A and B, the starting
            model first on even items and second on odd ones.
          </li>
          <li>
            The sealed half is prompts 2, 3, 6, 7 and so on. A tuning loop&apos;s writer is never shown them, so a round can&apos;t aim at
            them. The Glimmer run wasn&apos;t a loop, and the split is shown so a later loop&apos;s numbers line up.
          </li>
          <li>
            Harness means the real training and scoring code ran on a rented GPU, and the results were replayed through the real judge in a
            copy of the database. Launch, callbacks over https, the workflow and the sweep were stood in for.
          </li>
        </ul>
      </section>

      <section className="section">
        <h2>What this doesn&apos;t show</h2>
        <ul className="ow-list">
          <li>
            That the facts were learned. All 40 of the judge&apos;s Glimmer notes credit the trained format or the invented words, and tuned
            details still often differ from the reference. What it clearly learned is the shape and the vocabulary.
          </li>
          <li>
            That it helps outside its topic. On five general questions, the tuned one-bit file was clearly right on 2, the same as the
            starting model.
          </li>
          <li>That a tuning loop climbs. This page shows no loop run.</li>
          <li>That this adapter ran on someone&apos;s own device. It hasn&apos;t been uploaded or shown here on one.</li>
        </ul>
      </section>

      <section className="section">
        <h2>Read the answers</h2>
        <p className="muted">
          Real model output, not edited, weakest tuned score first. Reference answers aren&apos;t shown: the dataset stays private, and only
          the judge saw them. Everything is also in <a href={`/open-weights/${glimmer.run}.json`}>{glimmer.run}.json</a>.
        </p>
        <h3>Glimmer, sealed half ({sealed.length})</h3>
        {sealed.map((i) => (
          <Answer key={i.index} item={i} baseLabel="Started from" />
        ))}
        <h3>Glimmer, the other kept-aside prompts ({rest.length})</h3>
        {rest.map((i) => (
          <Answer key={i.index} item={i} baseLabel="Started from" />
        ))}
        <p className="muted">Tuned Glimmer lost none of its 40. That is a small set on an invented topic, so it isn&apos;t a sign it never loses.</p>
      </section>

      <section className="section">
        <h2>The weights</h2>
        <ul className="ow-list">
          {WEIGHTS.map((w) => (
            <li key={w.id}>
              <ExternalLink href={`${HF}${w.kind === "dataset" ? "datasets/" : ""}${w.id}`}>{w.id}</ExternalLink>. {w.what}
            </li>
          ))}
          <li>
            <ExternalLink href={`${HF}meta-models/Muse-Glimmer-30B`}>meta-models/Muse-Glimmer-30B</ExternalLink>. Meta&apos;s original.
          </li>
        </ul>
        <p className="muted">The tuned adapter from the Glimmer run on this page isn&apos;t on Hugging Face yet. Its card is drafted.</p>
      </section>

      <section className="section">
        <h2>Which model runs where</h2>
        <p>
          The results above are on Meta&apos;s open weights. For the submission, Muse Privacy is built to run Muse Glimmer 30B in the
          cloud, through OpenRouter, on invented data only. A Glimmer file on your own device is the target there, not a result.
        </p>
        <p className="muted">
          <Link href="/models">All models</Link>
        </p>
      </section>
    </div>
  );
}
