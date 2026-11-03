"use client";

import type { CrewAgent } from "@/components/build/steps";
import { AgentMuse } from "@/components/mascot/AgentMuse";
import { plural } from "@/lib/format";
import { subRole } from "@/lib/mascot";

const SAID = { running: "Working", done: "Done", failed: "Didn't finish" } as const;

/**
 * Muse mode in the build room (docs/BRAND.md, "Muse mode"): the build's agents as a crew of Muses. The orchestrator
 * (Muse Code, the lead) stands large with what it's doing; each sub-agent it sent off stands beside it as its own Muse,
 * waving while it works and standing still once it's done. Newest 12 (museCrew).
 */
export function MuseCrew({ lead, agents }: { lead: string; agents: readonly CrewAgent[] }) {
  const working = agents.filter((a) => a.state === "running").length;
  const done = agents.length - working;
  const tally = agents.length
    ? [working ? `${working} working` : null, done ? `${done} done` : null].filter(Boolean).join(", ")
    : "No helpers yet";
  return (
    <section className="muse-crew" aria-label="The agents at work">
      <div className="muse-crew-lead">
        <AgentMuse role="orchestrator" height={120} className="muse-crew-lead-muse" />
        <div className="muse-crew-lead-text">
          <p className="muse-crew-name">Muse Code, the lead</p>
          <p className="muse-crew-task">{lead}</p>
          <p className="muse-crew-tally">
            {agents.length ? `${plural(agents.length, "helper")}: ${tally}` : tally}
          </p>
        </div>
      </div>
      {agents.length ? (
        <ul className="muse-crew-team">
          {agents.map((a, i) => (
            <li key={a.id} className={`muse-crew-agent is-${a.state}`}>
              <AgentMuse role={subRole(i)} height={72} playing={a.state === "running"} />
              <p className="muse-crew-task" title={a.title}>
                {a.title}
              </p>
              <p className="muse-crew-state">{SAID[a.state]}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muse-crew-empty">Each helper Muse Code sends off joins the crew here.</p>
      )}
    </section>
  );
}
