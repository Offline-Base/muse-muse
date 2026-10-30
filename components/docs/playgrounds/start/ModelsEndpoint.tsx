"use client";

import { useId, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Segmented, TextInput, Toggle } from "@/components/docs/kit/Field";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { MODEL_CARDS } from "@/components/docs/playgrounds/start/facts";
import {
  checkSchema,
  createdLabel,
  isMetaModelNotFound,
  listOrderNote,
  modelOf,
  modelsOf,
  type FieldResult,
} from "@/components/docs/playgrounds/start/reference";
import styles from "@/components/docs/playgrounds/start/start.module.css";

export type ModelsEndpointKind = "list" | "retrieve";

const OTHER = "__other__";

/**
 * The Models endpoints as the reference documents them: GET /v1/models (with the optional `client` query parameter)
 * and GET /v1/models/{model} with a model picker. Each reply is drawn as the page's objects and checked against its
 * schema (ListModelsResponse, Model), and an id that doesn't exist shows Meta's own 404. Free: no tokens.
 */
export function ModelsEndpoint({
  endpoints = ["list", "retrieve"],
  model: initialModel = DEFAULT_TEXT_MODEL,
}: {
  slug: string;
  endpoints?: ModelsEndpointKind[];
  model?: string;
}) {
  const id = useId();
  const runner = useDocsRun();
  const [kind, setKind] = useState<ModelsEndpointKind>(endpoints[0] ?? "list");
  const [client, setClient] = useState("");
  const [choice, setChoice] = useState(initialModel);
  const [other, setOther] = useState("bogus-model");
  const [ids, setIds] = useState<string[]>(MODEL_CARDS.map((m) => m.id));
  const [showCode, setShowCode] = useState(false);
  // What the last run sent, so the reply is drawn for that request rather than for the form as it is now.
  const [ranKind, setRanKind] = useState<ModelsEndpointKind | null>(null);
  const [ranModel, setRanModel] = useState("");
  const running = runner.state === "running";
  const model = choice === OTHER ? other.trim() : choice;
  const path = kind === "list" ? `models${client.trim() ? `?client=${encodeURIComponent(client.trim())}` : ""}` : `models/${encodeURIComponent(model)}`;

  const run = async () => {
    if (running || (kind === "retrieve" && !model)) return;
    setRanKind(kind);
    setRanModel(model);
    const res = await runner.run(path, { method: "GET" });
    if (kind === "list" && res.ok) {
      const listed = modelsOf(res.json).map((m) => m.id);
      if (listed.length) setIds(listed);
    }
  };

  const json = runner.result?.ok ? runner.result.json : null;
  const result = runner.result;
  // The made-up id is there to show Meta's real 404, so it gets a plain line instead of the kit's "pick another model".
  const notFound = ranKind === "retrieve" && !!result && !isAborted(result) && isMetaModelNotFound(result.status, result.headers, result.json);
  const checks: FieldResult[] = json ? checkSchema(ranKind === "list" ? "list-models-response" : "model", json) : [];

  return (
    <div className="pg">
      {endpoints.length > 1 ? (
        <div className="pg-bar">
          <Segmented<ModelsEndpointKind>
            label="Endpoint"
            options={[
              { value: "list", label: "List models" },
              { value: "retrieve", label: "Retrieve a model" },
            ]}
            value={kind}
            onChange={setKind}
            disabled={running}
          />
        </div>
      ) : null}
      <div className="pg-console-line">
        <span className="pg-method pg-method-get">GET</span>
        <code className="docs-code-inline">/v1/{path}</code>
        <RunButton running={running} onRun={() => void run()} onStop={runner.abort} label="Send" disabled={kind === "retrieve" && !model} />
      </div>
      {kind === "list" ? (
        <div className="pg-bar pg-advanced">
          <span className="pg-inline-field">
            <label className="pg-label" htmlFor={`${id}-client`}>
              client
            </label>
            <TextInput id={`${id}-client`} value={client} placeholder="optional" spellCheck={false} onChange={(e) => setClient(e.target.value)} />
          </span>
          <span className="pg-hint">Optional client-specific catalog view. A recognized client adds each model&apos;s metadata.</span>
        </div>
      ) : (
        <div className="pg-bar">
          <span className="pg-inline-field">
            <label className="pg-label" htmlFor={`${id}-model`}>
              model
            </label>
            <span className="select-wrap">
              <select id={`${id}-model`} className="select pg-select" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={running}>
                {ids.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value={OTHER}>Another id...</option>
              </select>
            </span>
          </span>
          {choice === OTHER ? (
            <span className="pg-inline-field">
              <label className="sr-only" htmlFor={`${id}-other`}>
                Model id
              </label>
              <TextInput id={`${id}-other`} value={other} spellCheck={false} onChange={(e) => setOther(e.target.value)} />
            </span>
          ) : null}
          <span className="pg-hint pg-advanced">Retrieving a model costs nothing, Contributor or not: no prompt is sent.</span>
        </div>
      )}
      {notFound ? (
        <div className="pg-hint" role="status">
          Meta&apos;s own 404: no model has the id <code>{ranModel}</code>. It&apos;s the reply the reference documents, with code{" "}
          <code>model_not_found</code>, so your code can stop with a message that names the id.
        </div>
      ) : (
        <ErrorBox error={runner.error} />
      )}
      <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs}>
        {json && ranKind === "list" ? <ModelTable reply={json} /> : json && ranKind === "retrieve" ? <ModelObjectView reply={json} /> : undefined}
      </ResponseView>
      {checks.length ? <SchemaChecks checks={checks} schema={ranKind === "list" ? "ListModelsResponse" : "Model"} /> : null}
      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="GET" path={path} /> : null}
    </div>
  );
}

function ModelTable({ reply }: { reply: unknown }) {
  const models = modelsOf(reply);
  const order = listOrderNote(models);
  return (
    <div className={styles.stack}>
      <p className="pg-hint">
        {models.length} {models.length === 1 ? "model" : "models"}, in the order the API sent them.{order ? ` ${order}` : ""}
      </p>
      <div className={`docs-table ${styles.table}`} role="group" aria-label="Models" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th scope="col">id</th>
              <th scope="col">object</th>
              <th scope="col">created</th>
              <th scope="col">owned_by</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td className={styles.cell}>
                  <code className="docs-code-inline">{m.id}</code>
                </td>
                <td>{m.object}</td>
                <td>{createdLabel(m.created)}</td>
                <td>{m.owned_by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {models.some((m) => m.metadata !== undefined) ? <p className="pg-hint">Some models carry metadata for the client you named.</p> : null}
    </div>
  );
}

function ModelObjectView({ reply }: { reply: unknown }) {
  const m = modelOf(reply);
  if (!m) return null;
  return (
    <dl className={styles.kv}>
      <dt>id</dt>
      <dd>
        <code>{m.id}</code>
      </dd>
      <dt>object</dt>
      <dd>{m.object}</dd>
      <dt>created</dt>
      <dd>{createdLabel(m.created)}</dd>
      <dt>owned_by</dt>
      <dd>{m.owned_by}</dd>
      <dt>metadata</dt>
      <dd>{m.metadata === undefined ? <span className="pg-muted">not sent (only with a recognized client)</span> : JSON.stringify(m.metadata)}</dd>
    </dl>
  );
}

/** The live object against the page's schema, field by field. */
export function SchemaChecks({ checks, schema }: { checks: FieldResult[]; schema: string }) {
  const bad = checks.filter((c) => !c.ok);
  return (
    <details className="pg-raw" open={bad.length > 0}>
      <summary>
        {bad.length ? `${bad.length} of ${checks.length} field checks fail against ${schema}` : `Matches ${schema}: all ${checks.length} field checks pass`}
      </summary>
      <ul className={styles.checks}>
        {checks.map((c, i) => (
          <li key={`${c.path}-${i}`} className={c.ok ? styles.checkOk : styles.checkBad}>
            <span className={styles.mark} aria-hidden>
              {c.ok ? "✓" : "✗"}
            </span>
            {c.path}: {c.note}
            <span className="sr-only">{c.ok ? " passes" : " fails"}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
