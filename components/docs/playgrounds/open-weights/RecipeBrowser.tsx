"use client";

import { useState } from "react";
import { collectionFor, filterCards, type RecipeCard } from "@/components/docs/playgrounds/open-weights/recipes";
import { Badge, CodeCard, SegmentField, Status } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * A cookbook section's recipes as filterable cards (cookbook/run-locally, cookbook/post-training): the section's own
 * recipes, then the related step-by-step guides on the model pages, by the machine or the method you have, each with
 * what it needs, how long the page says it takes, and its first command.
 */

export interface RecipeBrowserProps {
  slug: string;
  collection: "run-locally" | "post-training";
}

export function RecipeBrowser({ collection }: RecipeBrowserProps) {
  const c = collectionFor(collection);
  const [filter, setFilter] = useState("all");
  const [model, setModel] = useState<"all" | RecipeCard["model"]>("all");
  const cards = filterCards(c, filter, model);
  const inSection = cards.filter((x) => x.inSection);
  const related = cards.filter((x) => !x.inSection);
  return (
    <div className="pg">
      <div className={styles.options}>
        <SegmentField<string> label={collection === "run-locally" ? "What you have" : "What you want"} value={filter} options={c.filters.map((f) => ({ value: f.id, label: f.label }))} onChange={setFilter} />
        <SegmentField<"all" | RecipeCard["model"]>
          label="Model"
          value={model}
          options={[
            { value: "all", label: "Both" },
            { value: "Muse Spark Open", label: "Muse Spark Open" },
            { value: "Muse Glimmer", label: "Muse Glimmer" },
          ]}
          onChange={setModel}
        />
      </div>
      <Status tone={cards.length ? "ok" : "warn"}>
        {cards.length
          ? `${cards.length} match${cards.length === 1 ? "" : "es"}: ${inSection.length} recipe${inSection.length === 1 ? "" : "s"} in this section${related.length ? ` and ${related.length} related guide${related.length === 1 ? "" : "s"} on the model pages` : ""}.`
          : "Nothing matches both filters. Try Everything or Both."}
      </Status>
      {inSection.length ? <CardGrid cards={inSection} /> : null}
      {related.length ? (
        <>
          <p className="pg-section-label" style={{ margin: "4px 0 0" }}>
            Related guides on the model pages
          </p>
          <CardGrid cards={related} />
        </>
      ) : null}
    </div>
  );
}

function CardGrid({ cards }: { cards: RecipeCard[] }) {
  return (
    <div className={styles.cards}>
      {cards.map((r) => (
        <article key={r.id} className={styles.card} aria-label={r.title}>
          <div className={styles.cardHead}>
            <h4 className={styles.cardTitle}>
              <a href={r.href}>{r.title}</a>
            </h4>
            <span className={styles.row} style={{ gap: 6 }}>
              {r.inSection ? <Badge tone="info">Cookbook</Badge> : null}
              <Badge tone="neutral">{r.model}</Badge>
            </span>
          </div>
          <p className={styles.cardText}>{r.what}</p>
          <p className={styles.cardMeta}>
            Needs: {r.needs}
            {r.time ? ` · ${r.time}` : ""}
          </p>
          <CodeCard code={r.command} lang="bash" label="First command" />
        </article>
      ))}
    </div>
  );
}
