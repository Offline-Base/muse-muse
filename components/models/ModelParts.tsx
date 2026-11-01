import Link from "next/link";
import { Icon, type IconName } from "@/components/icons";
import { CALL_DAYS, type HostedModelView, type TunedModelView } from "@/components/models/catalog";
import { GLIMMER_NAME } from "@/components/train/results";
import { ExternalLink } from "@/components/ui";
import { groupThousands } from "@/lib/format";

/* The parts of /models: server components with no client code, so only the text they render reaches the browser. */

/** Meta's hosted models: name and id, what Muse Muse uses each for, its price, and its calls when they could be read. */
export function HostedModelsTable({ models }: { models: HostedModelView[] }) {
  const withCalls = models.some((m) => m.calls !== null);
  return (
    <div className="table-wrap">
      <table className="data data-list">
        <caption className="sr-only">Meta&apos;s hosted models that Muse Muse calls</caption>
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">What Muse Muse uses it for</th>
            <th scope="col">Price (est.)</th>
            {withCalls ? (
              <th scope="col" className="num">
                Calls, {CALL_DAYS} days
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.id}>
              <td className="models-name">
                <span className="row-title">{m.name}</span>
                <span className="row-sub muted">
                  <code>{m.id}</code>
                </span>
                {m.testOnly || m.preview ? (
                  <ul className="chips" aria-label={`About ${m.name}`}>
                    {m.testOnly ? <li className="chip">Tests and examples only</li> : null}
                    {m.preview ? <li className="chip">Preview</li> : null}
                  </ul>
                ) : null}
              </td>
              <td>
                {m.use}
                {m.note ? <span className="row-sub muted">{m.note}</span> : null}
              </td>
              <td>{m.price}</td>
              {withCalls ? <td className="num">{m.calls === null ? "" : groupThousands(m.calls)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Muse Glimmer: the open-weights model the lab tunes. */
export function GlimmerCard() {
  return (
    <article className="card section-card" aria-labelledby="glimmer-title">
      <div>
        <h3 id="glimmer-title">{GLIMMER_NAME}</h3>
        <ul className="chips" aria-label="About its weights">
          <li className="chip">Open weights</li>
          <li className="chip">Apache 2.0</li>
        </ul>
      </div>
      <p className="muted">
        Meta&apos;s open model: 30B parameters, reads text and images. Its license is Apache 2.0, with Meta&apos;s usage
        policy. It isn&apos;t on Meta&apos;s Model API, so Muse Muse&apos;s lab runs it on rented GPUs to tune it and to
        run live demos. A product can pick it for local or offline use, through a server someone hosts.
      </p>
      <div className="row-actions">
        <Link className="btn btn-outline btn-sm" href="/docs/muse-glimmer">
          Glimmer docs
        </Link>
        <Link className="btn btn-outline btn-sm" href="/fine-tuning">
          Lab results
        </Link>
      </div>
    </article>
  );
}

/** The lab's tuned Glimmer models: how each did against the base, and its public links. */
export function TunedModelsTable({ models }: { models: TunedModelView[] }) {
  return (
    <div className="table-wrap">
      <table className="data data-list">
        <caption className="sr-only">Tuned {GLIMMER_NAME} models, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Tuned vs base</th>
            <th scope="col">Get it</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.id}>
              <td>
                <Link href={`/fine-tuning/${m.id}`} className="row-title">
                  {m.title}
                </Link>
                <span className="row-sub muted">{GLIMMER_NAME}, tuned</span>
              </td>
              <td className="train-nowrap">
                Tuned won <strong>{m.tunedWins}</strong> of {m.items}
              </td>
              <td>
                {m.hubUrl || m.gguf ? (
                  <ul className="link-list">
                    {m.hubUrl ? (
                      <li>
                        <ExternalLink href={m.hubUrl}>Hugging Face</ExternalLink>
                      </li>
                    ) : null}
                    {m.gguf ? (
                      <>
                        <li>
                          <ExternalLink href={m.gguf.repoUrl}>GGUF files</ExternalLink>
                        </li>
                        <li>
                          <Link href={m.gguf.runHref}>Run it on your computer</Link>
                        </li>
                      </>
                    ) : null}
                  </ul>
                ) : (
                  <span className="muted">Not public</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PLACES: Array<{ icon: IconName; title: string; text: string }> = [
  { icon: "link", title: "Meta's Model API", text: "The hosted models run on Meta's servers. Muse Muse calls them over the API." },
  { icon: "tune", title: "A rented GPU", text: "The lab tunes Glimmer and runs its live demos on Lambda GPUs, shut down after each job." },
  { icon: "monitor", title: "On a device", text: "A tuned model with public GGUF files runs on your own computer, offline." },
];

/** Where each kind of model runs, one short line each. */
export function WhereTheyRun() {
  return (
    <ol className="how">
      {PLACES.map((p) => (
        <li key={p.title} className="how-step">
          <span className="how-icon" aria-hidden>
            <Icon name={p.icon} />
          </span>
          <h3 className="how-title">{p.title}</h3>
          <p className="muted">{p.text}</p>
        </li>
      ))}
    </ol>
  );
}
