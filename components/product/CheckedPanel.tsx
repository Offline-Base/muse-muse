import { buildCheckedPanel, type CheckedResult } from "@/lib/outputs/checked";
import type { BuildEvent, ProductStatus } from "@/lib/types";

const RESULT: Record<CheckedResult, { text: string; pill: string }> = {
  passed: { text: "Passed", pill: "pill-live" },
  failed: { text: "Failed", pill: "pill-failed" },
  running: { text: "Running", pill: "pill-building" },
  not_checked: { text: "Not checked", pill: "pill-neutral" },
  reported: { text: "Not re-checked", pill: "pill-neutral" },
};

/** What was checked on this version, by what, and what wasn't (lib/outputs/checked.ts). It has no controls. */
export function CheckedPanel(props: { events: readonly BuildEvent[]; status: ProductStatus; hasActions: boolean; isAgent: boolean; isOwner: boolean; now: number }) {
  const view = buildCheckedPanel(props);
  return (
    <section className="card section-card" aria-labelledby="checked-title">
      <h2 id="checked-title">What was checked</h2>
      {view.statusNote ? <p>{view.statusNote}</p> : null}
      {view.sections.map((section) => (
        <div key={section.id}>
          <h3>{section.title}</h3>
          <p className="muted small">{section.note}</p>
          <ul className="plain-list">
            {section.rows.map((row) => (
              <li key={row.id}>
                <span className={`pill ${RESULT[row.result].pill}`}>{RESULT[row.result].text}</span> {row.label}
                {row.date ? <span className="muted small"> · {row.date}</span> : null}
                {row.details?.length ? (
                  <ul className="muted small">
                    {row.details.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
