import { Icon } from "@/components/icons";

export interface SetupFacts {
  buildModel: string;
  maxFixRounds: number;
  publish: boolean;
}

/**
 * The Make page's right panel, laid out like the playground's settings. The platform sets these for every build, so
 * the selects and switches are shown disabled: they report the setup rather than change it.
 */
export function SetupPanel({ facts }: { facts: SetupFacts }) {
  const selects: Array<[string, string]> = [
    ["Model", facts.buildModel],
    ["Builder", "Muse Code"],
    ["Fix rounds", `Up to ${facts.maxFixRounds}`],
  ];
  const switches: Array<[string, boolean, string]> = [
    ["Screenshot judge", true, "Muse Spark 1.3 checks the screenshots against the brief"],
    ["Demo video", true, "Each product's smoke test is recorded as an MP4"],
    [
      "Publish",
      facts.publish,
      facts.publish ? "Ships to its own link" : "Off on this machine: VERCEL_TOKEN isn't set",
    ],
    ["Muse app connector", facts.publish, "Serves the product's actions over MCP"],
  ];
  return (
    <aside className="panel panel-static" aria-label="Build setup">
      <div className="panel-body">
        {selects.map(([label, value]) => (
          <div key={label} className="pfield">
            <span className="panel-label">{label}</span>
            <div className="pbox pbox-off" aria-disabled="true">
              <span>{value}</span>
              <Icon name="chevronDown" size={18} />
            </div>
          </div>
        ))}
        {switches.map(([label, on, hint]) => (
          <div key={label} className="pfield-row" title={hint}>
            <span className="panel-label">{label}</span>
            <button type="button" role="switch" className="switch" aria-checked={on} aria-label={label} disabled />
          </div>
        ))}
        <p className="panel-note">Set by the platform for every build.</p>
      </div>
    </aside>
  );
}
