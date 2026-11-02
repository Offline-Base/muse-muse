import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons";
import { GLIMMER_MODALITIES, type Modality, type ModelCardView, type ModelLink, type TunedModelView } from "@/components/models/catalog";
import { SparkOpenChip } from "@/components/train/SparkOpenNote";
import { GLIMMER_NAME, R30B_NAME } from "@/components/train/results";
import { ExternalLink } from "@/components/ui";
import { BUILT_WITH_SPARK_OPEN, R30B_URL, USAGE_POINTS } from "@/lib/train/base";

/* The parts of /models: server components with no client code, so only the text they render reaches the browser. */

/** The card every model on /models uses. Key and value rows are pinned to the bottom, so cards in a row line up. */
function ModelCard({
  id,
  name,
  nameHref,
  isNew,
  subline,
  apiId,
  tags,
  modalities,
  links,
  rows,
  children,
}: {
  id: string;
  name: string;
  nameHref?: string;
  isNew?: boolean;
  subline: string;
  apiId?: string | null;
  tags?: ReactNode;
  modalities: Modality[];
  links: ModelLink[];
  rows: Array<{ label: string; value: ReactNode }>;
  children?: ReactNode;
}) {
  const titleId = `model-${id}`;
  return (
    <li className="model-card" data-mod={modalities.join(" ")}>
      <article aria-labelledby={titleId} className="model-card-body">
        <div className="model-card-head">
          <h3 id={titleId}>{nameHref ? <Link href={nameHref}>{name}</Link> : name}</h3>
          {isNew ? <span className="model-new">New</span> : null}
        </div>
        <p className="model-sub">{subline}</p>
        {apiId ? <code className="model-id">{apiId}</code> : null}
        {tags ? <div className="chips">{tags}</div> : null}
        <div className="model-desc">{children}</div>
        {links.length ? (
          <div className="model-actions">
            {links.map((l) =>
              l.external ? (
                <ExternalLink key={l.href} href={l.href} className="btn btn-outline btn-sm">
                  {l.label}
                </ExternalLink>
              ) : (
                <Link key={l.href} href={l.href} className="btn btn-outline btn-sm">
                  {l.label}
                </Link>
              ),
            )}
          </div>
        ) : null}
        <dl className="model-rows">
          {rows.map((r) => (
            <div key={r.label} className="model-row">
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      </article>
    </li>
  );
}

/** What Muse Glimmer's card says, with its 2026-knowledge base and the words the Muse Model License asks for. */
function GlimmerText() {
  return (
    <>
      <p>
        Meta&apos;s open model: 30B parameters, reads text and images. Its license is Apache 2.0, with Meta&apos;s usage
        policy. It isn&apos;t on Meta&apos;s Model API, so Muse Muse&apos;s lab runs it on rented GPUs to tune it and to
        run live demos. A product can pick it for local or offline use, through a server someone hosts.
      </p>
      <p>
        New fine-tunes start from Muse Muse&apos;s 2026-knowledge Glimmer,{" "}
        <ExternalLink href={R30B_URL}>OfflineBase/Glimmer-30B-2026-Knowledge</ExternalLink>, and so do the live demos.
        Muse Spark Open wrote part of its training data, so it and every model tuned from it are {BUILT_WITH_SPARK_OPEN},
        under the Muse Model License. {USAGE_POINTS.join(" ")}
      </p>
    </>
  );
}

/** The main grid: hosted and open-weight models together. */
export function ModelCards({ cards }: { cards: ModelCardView[] }) {
  return (
    <ul className="models-grid">
      {cards.map((c) => (
        <ModelCard
          key={c.id}
          id={c.id}
          name={c.name}
          isNew={c.isNew}
          subline={c.subline}
          apiId={c.apiId}
          tags={c.tags.length ? c.tags.map((t) => <span key={t} className="chip">{t}</span>) : null}
          modalities={c.modalities}
          links={c.links}
          rows={c.rows}
        >
          {c.id === "muse-glimmer" ? <GlimmerText /> : c.description.map((d) => <p key={d}>{d}</p>)}
        </ModelCard>
      ))}
    </ul>
  );
}

/** The lab's tuned Glimmer models: how each did against the base, and its public links. */
export function TunedModelCards({ models }: { models: TunedModelView[] }) {
  return (
    <ul className="models-grid">
      {models.map((m) => {
        const links: ModelLink[] = [
          { label: "Versions", href: `/models/${m.id}` },
          ...(m.hubUrl ? [{ label: "Hugging Face", href: m.hubUrl, external: true }] : []),
          ...(m.gguf
            ? [
                { label: "GGUF files", href: m.gguf.repoUrl, external: true },
                { label: "Run it on your computer", href: m.gguf.runHref },
              ]
            : []),
        ];
        return (
          <ModelCard
            key={m.id}
            id={m.id}
            name={m.title}
            nameHref={`/fine-tuning/${m.id}`}
            subline={`${m.sparkOpen ? R30B_NAME : GLIMMER_NAME}, tuned`}
            tags={m.sparkOpen ? <SparkOpenChip /> : null}
            modalities={GLIMMER_MODALITIES}
            links={links}
            rows={[
              {
                label: "Tuned vs base",
                value: (
                  <>
                    Tuned won <strong>{m.tunedWins}</strong> of {m.items}
                    {m.sparkOpen ? <span className="row-sub muted">against the 2026 Glimmer it started from</span> : null}
                  </>
                ),
              },
              { label: "Access", value: m.hubUrl || m.gguf ? "Public" : "Not public" },
            ]}
          />
        );
      })}
    </ul>
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
    <ol className="how models-places">
      {PLACES.map((p) => (
        <li key={p.title} className="how-step model-place">
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
