import { Icon } from "@/components/icons";
import { DRILL_GROUP_TITLE, type DrillRow } from "@/lib/edge/drills";
import { duration, truncate } from "@/lib/format";

/**
 * The simulated outage drills' results (lib/edge/drills.ts) as their own labeled group, in the build room's checks and
 * on the product page: each drill's name, pass or fail, the time it took, and what it simulated. A failed drill shows
 * as a failure, and any failure makes the group's own pill read Failed. Renders nothing for a build with no drill.
 */
export function DrillGroup({ drills, note }: { drills: readonly DrillRow[]; note?: string }) {
  if (!drills.length) return null;
  const passed = drills.every((d) => d.ok);
  const okCount = drills.filter((d) => d.ok).length;
  return (
    <div className="drills" data-drills={passed ? "passed" : "failed"}>
      <p className="lead">
        <strong>{DRILL_GROUP_TITLE}</strong>
        <span className={`pill pill-${passed ? "live" : "failed"}`}>
          <span className="pill-dot" aria-hidden />
          {passed ? "Passed" : "Failed"}
        </span>
        <span className="muted">
          {okCount} of {drills.length} passed
        </span>
      </p>
      {note ? <p className="muted">{note}</p> : null}
      <ul className="vsteps">
        {drills.map((d) => (
          <li key={d.id} className={d.ok ? "ok" : "bad"}>
            <Icon name={d.ok ? "check" : "close"} size={16} title={d.ok ? "Passed" : "Failed"} />
            <span className="vstep-name">
              Drill {d.id}: {d.name}
            </span>
            <span className="muted">{d.ok ? "Passed" : "Failed"}</span>
            {typeof d.ms === "number" ? <span className="muted">{duration(d.ms)}</span> : null}
            {d.simulated ? <span className="vstep-detail muted">{d.simulated}</span> : null}
            {!d.ok && d.detail ? <span className="vstep-detail">{truncate(d.detail, 160)}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
