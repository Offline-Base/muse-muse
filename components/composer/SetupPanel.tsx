import { Icon } from "@/components/icons";

export interface SetupFacts {
  buildModel: string;
  /** The model that judges the screenshots (env.judgeModel). Without it the row names no model. */
  judgeModel?: string;
  maxFixRounds: number;
  /** Why products aren't published here (env.publishOffReason), or null when they are. */
  publishOff: string | null;
}

/** One fact: its label, its value, and an optional muted line under the value. */
export type SetupRow = [label: string, value: string, hint?: string];

function buildRows(facts: SetupFacts): SetupRow[] {
  const publish = !facts.publishOff;
  return [
    ["Model", facts.buildModel],
    ["Builder", "Muse Code"],
    ["Fix rounds", `Up to ${facts.maxFixRounds}`],
    ["Screenshot judge", "On", !facts.judgeModel ? "Checks the screenshots against the brief" : facts.judgeModel === facts.buildModel ? "Checks the screenshots against the brief, on the model above" : `${facts.judgeModel} checks the screenshots against the brief`],
    ["Demo video", "On", "Each product's smoke test is recorded as an MP4"],
    ["Publish", publish ? "On" : "Off", facts.publishOff ? `Off here: ${facts.publishOff}` : "Ships to its own link"],
    ["Muse app connector", publish ? "On" : "Off", "Serves the product's actions over MCP"],
  ];
}

/**
 * The Make page's build setup, folded under the examples. The platform sets these for every build, so they read as
 * plain facts, with nothing that looks like it could be changed (docs/BRAND.md, "Pitfalls"). Another page can fold its
 * own facts the same way with `rows`, a `title` and a `note` (the new fine-tune composer's "Training setup").
 */
export function SetupPanel({
  facts,
  rows: given,
  title = "Build setup",
  note = "Set by the platform for every build.",
}: {
  facts?: SetupFacts;
  rows?: SetupRow[];
  title?: string;
  note?: string;
}) {
  const rows = given ?? (facts ? buildRows(facts) : []);
  return (
    <details className="setup">
      <summary className="setup-toggle">
        <span>{title}</span>
        <Icon name="chevronDown" size={16} className="setup-chevron" />
      </summary>
      <dl className="setup-list">
        {rows.map(([label, value, hint]) => (
          <div key={label} className="setup-row">
            <dt>{label}</dt>
            <dd>
              <span>{value}</span>
              {hint ? <span className="setup-hint">{hint}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      <p className="panel-note">{note}</p>
    </details>
  );
}
