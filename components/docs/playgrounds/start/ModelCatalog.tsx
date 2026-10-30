"use client";

import { useState } from "react";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { latencyLabel, statusText } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { MODEL_CARDS, type ModelCard } from "@/components/docs/playgrounds/start/facts";
import { allUndated, catalogRows, createdLabel, inDocumentedOrder, modelOf, type CatalogRow } from "@/components/docs/playgrounds/start/reference";
import styles from "@/components/docs/playgrounds/start/start.module.css";

const FALLBACK: CatalogRow[] = MODEL_CARDS.map((card) => ({
  model: { id: card.id, object: "model", created: null, owned_by: "" },
  card,
}));

/**
 * The models page's catalog, live: GET /v1/models lists what the team can call, in the order the API sends (the page
 * says newest first, but live replies have had created 0 on every model, so the hint says when the order means
 * nothing), and each id is joined with its card from the page (line, mode, input and output, context window, effort
 * levels, price). Retrieve fetches one model with GET /v1/models/{model}. Both calls are free.
 */
export function ModelCatalog() {
  const list = useDocsRun();
  const one = useDocsRun();
  const [selected, setSelected] = useState<string>(MODEL_CARDS[2].id);
  const live = list.result?.ok ? catalogRows(list.result.json) : null;
  const rows = live?.length ? live : FALLBACK;
  const liveModels = live?.map((r) => r.model) ?? [];
  const orderHint =
    liveModels.length > 1 && !inDocumentedOrder(liveModels)
      ? allUndated(liveModels)
        ? " The page says newest first, but every model reports created 0, so the order carries no meaning."
        : " The page says newest first, but this reply isn't in that order: sort by created yourself."
      : "";
  const current = rows.find((r) => r.model.id === selected) ?? rows[0];
  const retrieved = one.result?.ok ? modelOf(one.result.json) : null;
  const retrievedFor = retrieved?.id ?? null;

  const retrieve = (id: string) => {
    setSelected(id);
    void one.run(`models/${encodeURIComponent(id)}`, { method: "GET" });
  };

  return (
    <div className="pg">
      <div className="pg-actions">
        <RunButton running={list.state === "running"} onRun={() => void list.run("models", { method: "GET" })} onStop={list.abort} label="List models" />
        <span className="pg-hint" role="status">
          {live
            ? `${live.length} models from GET /v1/models in ${latencyLabel(list.result!.elapsedMs)}, in the API's order, each with its card from the models page.${orderHint}`
            : list.result && !list.result.ok
              ? `GET /v1/models: ${statusText(list.result)}.`
              : "Showing the models page's catalog. List models loads the live list (free)."}
        </span>
      </div>
      <ErrorBox error={list.error} />
      <div className={`docs-table ${styles.table}`} role="group" aria-label="Models" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th scope="col">Model id</th>
              <th scope="col">Line</th>
              <th scope="col">Mode</th>
              <th scope="col">Input to output</th>
              <th scope="col">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ model, card }) => (
              <tr key={model.id} className={model.id === current?.model.id ? styles.rowActive : undefined}>
                <td className={styles.cell}>
                  <code className="docs-code-inline">{model.id}</code>
                </td>
                <td>{card?.line ?? "Not in the models page"}</td>
                <td>{card ? (card.mode === "contributor" ? "Contributor" : "Standard") : ""}</td>
                <td className={styles.cell}>{card ? `${card.input} to ${card.output.toLowerCase()}` : ""}</td>
                <td className={styles.num}>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    aria-pressed={model.id === current?.model.id}
                    aria-label={`Retrieve ${model.id}`}
                    onClick={() => retrieve(model.id)}
                    disabled={one.state === "running"}
                  >
                    Retrieve
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {current ? <ModelDetails row={current} /> : null}
      <ErrorBox error={one.error} />
      {one.state === "running" ? <p className="pg-wait">Retrieving {selected}...</p> : null}
      {retrieved && retrievedFor === current?.model.id ? (
        <div className={styles.card} aria-live="polite">
          <p className={styles.cardTitle}>
            GET /v1/models/{retrieved.id} <span className="pg-meta">{latencyLabel(one.result!.elapsedMs)}</span>
          </p>
          <dl className={styles.kv}>
            <dt>object</dt>
            <dd>{retrieved.object}</dd>
            <dt>created</dt>
            <dd>{createdLabel(retrieved.created)}</dd>
            <dt>owned_by</dt>
            <dd>{retrieved.owned_by}</dd>
          </dl>
          <JsonTree value={one.result!.json} openDepth={1} />
        </div>
      ) : null}
    </div>
  );
}

function ModelDetails({ row }: { row: CatalogRow }) {
  const card: ModelCard | null = row.card;
  if (!card) {
    return <p className="pg-hint">The models page doesn&apos;t describe {row.model.id} yet. Retrieve shows what the API says about it.</p>;
  }
  return (
    <div className={styles.card}>
      <p className={styles.cardTitle}>
        {card.label} <span className="pg-meta">{card.mode === "contributor" ? "Contributor mode" : "Standard mode"}</span>
      </p>
      <dl className={styles.kv}>
        <dt>Input</dt>
        <dd>{card.input}</dd>
        <dt>Output</dt>
        <dd>{card.output}</dd>
        {card.contextWindow ? (
          <>
            <dt>Context window</dt>
            <dd>{card.contextWindow.toLocaleString("en-US")} tokens</dd>
          </>
        ) : null}
        {card.effort ? (
          <>
            <dt>Reasoning effort</dt>
            <dd>{card.effort}</dd>
          </>
        ) : null}
        <dt>Endpoints</dt>
        <dd>
          {card.endpoints.map((e, i) => (
            <span key={e}>
              {i ? ", " : ""}
              <code className="docs-code-inline">{e}</code>
            </span>
          ))}
        </dd>
        <dt>Price</dt>
        <dd>
          {card.price}.{" "}
          <a className={styles.link} href={`/docs/pricing-rate-limits#${card.priceAnchor}`}>
            Pricing
          </a>
        </dd>
      </dl>
      <ul className="pg-list pg-small">
        {card.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}
