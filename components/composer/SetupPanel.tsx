import { Icon } from "@/components/icons";

export interface SetupFacts {
  buildModel: string;
  maxFixRounds: number;
  /** Why products aren't published here (env.publishOffReason), or null when they are. */
  publishOff: string | null;
}

/**
 * The Make page's build setup, folded under the examples. The platform sets these for every build, so they read as
 * plain facts, with nothing that looks like it could be changed (docs/BRAND.md, "Pitfalls").
 */
export function SetupPanel({ facts }: { facts: SetupFacts }) {
  const publish = !facts.publishOff;
  const rows: Array<[string, string, string?]> = [
    ["Model", facts.buildModel],
    ["Builder", "Muse Code"],
    ["Fix rounds", `Up to ${facts.maxFixRounds}`],
    ["Screenshot judge", "On", "Muse Wonder checks the screenshots against the brief"],
    ["Demo video", "On", "Each product's smoke test is recorded as an MP4"],
    ["Publish", publish ? "On" : "Off", facts.publishOff ? `Off here: ${facts.publishOff}` : "Ships to its own link"],
    ["Muse app connector", publish ? "On" : "Off", "Serves the product's actions over MCP"],
  ];
  return (
    <details className="setup">
      <summary className="setup-toggle">
        <span>Build setup</span>
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
      <p className="panel-note">Set by the platform for every build.</p>
    </details>
  );
}
