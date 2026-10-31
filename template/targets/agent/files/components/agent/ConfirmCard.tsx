import { useId } from "react";
import { Icon } from "@/components/Icon";
import type { AgentConfirm } from "@/lib/agent/events";

/** Asks before the agent does something the person would want to check first, like sending an email. */
export function ConfirmCard({ confirm, busy = false, onDecide }: { confirm: AgentConfirm; busy?: boolean; onDecide: (approve: boolean) => void }) {
  const id = useId();
  return (
    <section className="card" aria-labelledby={id} data-confirm>
      <div className="card-head">
        <h2 id={id}>{confirm.title}</h2>
      </div>
      {confirm.lines.length ? (
        <div className="note" data-user-text>
          {confirm.lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      ) : null}
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => onDecide(true)}>
          <Icon name="check" /> Yes, go ahead
        </button>
        <button type="button" className="text" disabled={busy} onClick={() => onDecide(false)}>
          No, don't
        </button>
      </div>
    </section>
  );
}
