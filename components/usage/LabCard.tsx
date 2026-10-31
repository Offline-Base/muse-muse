import { relativeTime, usd } from "@/lib/format";
import type { SpendView } from "@/lib/native/ledger";
import type { LabView } from "@/lib/native/lab-box";
import { NATIVE_BUDGET_LANES, type NativeBudgetLane } from "@/lib/native/types";

export interface LabCardData {
  spend: SpendView;
  labs: LabView[];
  now: number;
}

const BUDGET_NAMES: Record<NativeBudgetLane, string> = { mac: "The Mac host", windows: "The Windows box", device_farm: "Device Farm", total: "All device lab spend" };
const LANE_TITLES: Record<LabView["lane"], string> = { mac: "Mac", windows: "Windows" };
const STOP_REASONS: Record<string, string> = {
  idle: "the platform stopped it after 30 idle minutes",
  agent_silent: "the platform stopped it because its agent went quiet",
  over_budget: "the platform stopped it at its budget",
};

function labState(lab: LabView, now: number): string {
  if (!lab.known) return "Not set up";
  const box = lab.control.boxState;
  if (lab.online) return "Online";
  const heard = lab.lastSeenAt ? `Last heard ${relativeTime(lab.lastSeenAt.toISOString(), now)}` : "Never heard from";
  return box ? `${heard}. EC2 says ${box}.` : `${heard}.`;
}

/** The admin's view of the device lab, on the usage page: what it has cost against its caps, and how each box is doing. */
export function LabCard({ data }: { data: LabCardData }) {
  const { spend, labs, now } = data;
  const total = spend.lanes.total;
  return (
    <section className="section" aria-labelledby="lab-title">
      <div className="section-head">
        <h2 id="lab-title">Device lab</h2>
      </div>
      <div className="card stat-card">
        <p className="stat-num">{usd(total.usedUsd)}</p>
        <p className="stat-sub">
          of the {usd(total.capUsd)} limit, counting {usd(total.reservedUsd)} held.
          {spend.alerting ? ` Past the ${usd(spend.alertUsd)} alert line.` : ""}
        </p>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Budget</th>
              <th scope="col" className="num">
                Spent
              </th>
              <th scope="col" className="num">
                Held
              </th>
              <th scope="col" className="num">
                Limit
              </th>
            </tr>
          </thead>
          <tbody>
            {NATIVE_BUDGET_LANES.map((lane) => (
              <tr key={lane}>
                <td>{BUDGET_NAMES[lane]}</td>
                <td className="num">{usd(spend.lanes[lane].committedUsd)}</td>
                <td className="num">{usd(spend.lanes[lane].reservedUsd)}</td>
                <td className="num">{spend.lanes[lane].capUsd === null ? "None" : usd(spend.lanes[lane].capUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Box</th>
              <th scope="col">State</th>
              <th scope="col">Agent</th>
              <th scope="col" className="num">
                Running
              </th>
              <th scope="col" className="num">
                Queued
              </th>
            </tr>
          </thead>
          <tbody>
            {labs.map((lab) => (
              <tr key={lab.lane}>
                <td>{LANE_TITLES[lab.lane]}</td>
                <td>
                  {labState(lab, now)}
                  {lab.control.stopReason ? <span className="muted"> Last stop: {STOP_REASONS[lab.control.stopReason] ?? lab.control.stopReason}.</span> : null}
                </td>
                <td>{lab.version ?? "None yet"}</td>
                <td className="num">{lab.claimed}</td>
                <td className="num">{lab.queued}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
