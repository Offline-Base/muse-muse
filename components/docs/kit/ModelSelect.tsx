"use client";

import { useId } from "react";
import { ContributorNotice } from "@/components/docs/kit/ContributorNotice";
import { docsModelLabel, isContributor, modelsFor, runsAs, type DocsModel, type ModelKind } from "@/lib/docs/client/models";

/**
 * The model menu for one kind of endpoint (text, vision, image, sam, voice), grouped by Contributor and Standard
 * mode, with the Contributor notice under it while a Contributor model is picked. A kind with a single model shows it
 * as plain text instead of a one-item menu. muse-spark-1.3 shows as the Contributor model it runs as.
 */
export function ModelSelect({
  kind,
  value,
  onChange,
  allow,
  id,
  label = "Model",
  notice = true,
  disabled,
}: {
  kind: ModelKind;
  value: string;
  onChange(model: string): void;
  /** Limit the menu to these ids (in menu order). */
  allow?: string[];
  id?: string;
  label?: string;
  /** Show the Contributor notice under the menu. Default true. */
  notice?: boolean;
  disabled?: boolean;
}) {
  const autoId = useId();
  const selectId = id ?? `${autoId}-model`;
  const current = runsAs(value);
  const listed = modelsFor(kind, allow);
  const options: DocsModel[] = listed.some((m) => m.id === current)
    ? listed
    : [...listed, { id: current, label: docsModelLabel(current), mode: isContributor(current) ? "contributor" : "standard", hint: "" }];
  const contributor = options.filter((m) => m.mode === "contributor");
  const standard = options.filter((m) => m.mode === "standard");
  const noticeEl = notice ? <ContributorNotice model={current} menu={options.map((m) => m.id)} /> : null;

  if (options.length === 1) {
    return (
      <div className="pg-model">
        <span className="pg-inline-field">
          <span className="pg-label">{label}</span>
          <span className="pg-model-fixed">{options[0].label}</span>
        </span>
        {noticeEl}
      </div>
    );
  }

  const option = (m: DocsModel) => (
    <option key={m.id} value={m.id}>
      {m.label}
    </option>
  );
  return (
    <div className="pg-model">
      <span className="pg-inline-field">
        <label className="pg-label" htmlFor={selectId}>
          {label}
        </label>
        <span className="select-wrap">
          <select id={selectId} className="select pg-select" value={current} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
            {contributor.length && standard.length ? (
              <>
                <optgroup label="Contributor mode">{contributor.map(option)}</optgroup>
                <optgroup label="Standard mode">{standard.map(option)}</optgroup>
              </>
            ) : (
              options.map(option)
            )}
          </select>
        </span>
      </span>
      {noticeEl}
    </div>
  );
}
